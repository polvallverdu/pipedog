// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipecat-ts contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/utils/tracing/service_decorators.py

/**
 * Service-specific OpenTelemetry tracing decorators for Pipecat.
 *
 * This module provides specialized decorators that automatically capture
 * rich information about service execution including configuration,
 * parameters, and performance metrics.
 *
 * Porting notes:
 * - Upstream decides at import time whether tracing is available and returns
 *   a no-op decorator otherwise. Here OpenTelemetry is registered at runtime
 *   (`registerOpenTelemetry()`), possibly after service classes are defined,
 *   so the wrappers check `isTracingAvailable()` when they run instead. With
 *   tracing unavailable they call straight through, as upstream's no-op does.
 * - Every decorator works three ways:
 *   - as a standard (TC39) method decorator: `@tracedTts async runTts(...)`;
 *     class-level patches are installed per instance via `addInitializer`;
 *   - as a legacy (`experimentalDecorators`) method decorator;
 *   - imperatively, for runtimes that strip types and do not run decorator
 *     syntax (Node): `static { installTracedTts(this.prototype, "runTts"); }`.
 *     This is the equivalent of upstream's `__set_name__` hook.
 * - `start_as_current_span` → the span is started with the parent context and
 *   made current with `context.with()` when the registered API provides it.
 * - Gemini Live messages are read with the camelCase field names of the
 *   Gemini Live JSON protocol (`toolCall.functionCalls`, `usageMetadata.promptTokenCount`);
 *   OpenAI Realtime events keep their snake_case wire names.
 * - JSON serialization (`jsonDumps`) matches Python's `json.dumps` defaults:
 *   `", "`/`": "` separators and ASCII-escaped output.
 */

import { CancelledError, rethrowIfCancelled } from "@pipecat-ts/asyncio";
import {
  type Frame,
  MetricsFrame,
  TranscriptionFrame,
  TTSStoppedFrame,
  UserStoppedSpeakingFrame,
  VADUserStartedSpeakingFrame,
} from "../../frames/frames.ts";
import { LLMTokenUsage, TTFBMetricsData } from "../../metrics/metrics.ts";
import { NOT_GIVEN } from "../../processors/aggregators/llm_context.ts";
import { FrameDirection } from "../../processors/frame_processor.ts";
import { logger } from "../logger.ts";
import { isGiven } from "../types.ts";
import {
  addGeminiLiveSpanAttributes,
  addLlmSpanAttributes,
  addOpenaiRealtimeSpanAttributes,
  addSttSpanAttributes,
  addTtsSpanAttributes,
  type LlmSpanAttributesOptions,
} from "./service_attributes.ts";
import {
  getOpenTelemetry,
  isTracingAvailable,
  type OtelContext,
  type OtelSpan,
  type OtelTracer,
} from "./setup.ts";

type Service = any;
type AnyFn = (...args: any[]) => any;
type Dict = Record<string, unknown>;

/** The extra span methods used here (`Span` from `@opentelemetry/api`). */
interface TracedSpan extends OtelSpan {
  recordException?(exception: unknown): void;
  setStatus?(status: { code: number; message?: string }): unknown;
}

/** `SpanStatusCode.ERROR` from `@opentelemetry/api`. */
const SPAN_STATUS_ERROR = 2;

/** Seconds since the epoch → OpenTelemetry `HrTime` (`[seconds, nanoseconds]`). */
function toHrTime(seconds: number): [number, number] {
  const whole = Math.floor(seconds);
  return [whole, Math.round((seconds - whole) * 1e9)];
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function isDict(value: unknown): value is Dict {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}

function isObject(value: unknown): value is Dict {
  return typeof value === "object" && value !== null;
}

/**
 * Python `json.dumps(value)` with default arguments: `JSON.stringify` output with
 * `", "` and `": "` separators and non-ASCII characters escaped (`ensure_ascii`).
 */
function jsonDumps(value: unknown): string {
  return jsonDumpsRaw(value).replace(
    /[\u0080-\uffff]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

function jsonDumpsRaw(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  const withToJson = value as { toJSON?: () => unknown };
  if (typeof withToJson.toJSON === "function") {
    return jsonDumpsRaw(withToJson.toJSON());
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => jsonDumpsRaw(v)).join(", ")}]`;
  }
  const entries = Object.entries(value as Dict)
    .filter(([, v]) => v !== undefined && typeof v !== "function")
    .map(([k, v]) => `${JSON.stringify(k)}: ${jsonDumpsRaw(v)}`);
  return `{${entries.join(", ")}}`;
}

/** Python truthiness for values that may be `NOT_GIVEN` (falsy upstream). */
function truthy(value: unknown): boolean {
  return Boolean(value) && isGiven(value);
}

function getTracer(): OtelTracer {
  const otel = getOpenTelemetry();
  if (!otel) {
    throw new Error("OpenTelemetry is not registered");
  }
  return otel.api.trace.getTracer("pipecat");
}

/**
 * Start a span as child of `parent`, make it current while `fn` runs, and end
 * it afterwards. Exceptions are recorded on the span with an ERROR status, as
 * `start_as_current_span` does upstream.
 */
async function withCurrentSpan<T>(
  name: string,
  parent: OtelContext | null,
  fn: (span: TracedSpan) => Promise<T>,
): Promise<T> {
  const otel = getOpenTelemetry();
  if (!otel) {
    throw new Error("OpenTelemetry is not registered");
  }
  const api = otel.api;
  const span = api.trace
    .getTracer("pipecat")
    .startSpan(name, {}, parent ?? undefined) as TracedSpan;
  const contextApi = api.context as typeof api.context & {
    with?<R>(context: OtelContext, fn: () => R): R;
  };
  try {
    if (typeof contextApi.with === "function") {
      const ctx = api.trace.setSpan(parent ?? api.context.active(), span);
      return await contextApi.with(ctx, () => fn(span));
    }
    return await fn(span);
  } catch (e) {
    span.recordException?.(e);
    span.setStatus?.({
      code: SPAN_STATUS_ERROR,
      message: `${e instanceof Error ? e.constructor.name : typeof e}: ${errorMessage(e)}`,
    });
    throw e;
  } finally {
    span.end();
  }
}

/**
 * Wrap `target[name]` with `makeWrapper(original)`, once: a method already
 * wrapped (marked with `marker`, e.g. by a parent class) is left alone.
 */
function wrapMethod(
  target: Service,
  name: string,
  marker: string,
  makeWrapper: (original: AnyFn) => AnyFn,
): void {
  const original = target[name] as AnyFn | undefined;
  if (typeof original !== "function" || (original as Service)[marker]) {
    return;
  }
  const wrapped = makeWrapper(original);
  (wrapped as Service)[marker] = true;
  target[name] = wrapped;
}

/**
 * Build a method decorator usable as a TC39 decorator, a legacy
 * (`experimentalDecorators`) decorator, or a plain function.
 *
 * @param wrap Builds the replacement method.
 * @param install Class-level patches (upstream's `__set_name__` work), run on
 *   the prototype (legacy) or on each instance (TC39).
 */
function makeMethodDecorator(
  wrap: (fn: AnyFn) => AnyFn,
  install: ((target: object) => void) | null,
) {
  return function decorator(value: any, context?: any, descriptor?: PropertyDescriptor): any {
    if (typeof context === "string" || typeof context === "symbol") {
      // Legacy decorator: (prototype, key, descriptor).
      install?.(value);
      const desc = descriptor ?? Object.getOwnPropertyDescriptor(value, context);
      if (desc && typeof desc.value === "function") {
        desc.value = wrap(desc.value);
      }
      return desc;
    }
    if (isObject(context) && typeof context.addInitializer === "function") {
      // TC39 decorator: (method, context).
      if (install) {
        (context.addInitializer as (fn: (this: object) => void) => void)(function (this: object) {
          install(this);
        });
      }
    }
    return wrap(value as AnyFn);
  };
}

/** A decorator returned by the `traced*` functions. */
export type TracedMethodDecorator = (
  value: any,
  context?: any,
  descriptor?: PropertyDescriptor,
) => any;

/**
 * Get the model name from a service instance.
 *
 * This is a bit of a mess — there were multiple places a model name could live.
 * Soon, `this._settings` should be the only source of truth about model name.
 * In fact...it might already be the case, but juuuuust to be safe, we'll
 * check all the places we used to store it.
 */
export function _getModelName(service: Service): string {
  // `NOT_GIVEN` is falsy upstream, so `or` skips it.
  const candidates = [
    // Some services store an API-response-provided detailed "full" name,
    // which is distinct from the user-provided model name
    service?._fullModelName,
    service?._settings?.model,
    service?.modelName,
    service?._modelName,
  ];
  return candidates.find(truthy) ?? "unknown";
}

/**
 * Get the current turn's tracing context if available.
 *
 * @param service The service instance.
 * @returns The turn context, or null if unavailable.
 */
export function _getTurnContext(service: Service): OtelContext | null {
  const tracingCtx = service?._tracingContext;
  return tracingCtx ? tracingCtx.getTurnContext() : null;
}

/**
 * Get the parent service span context (internal use only).
 *
 * This looks for the service span that was created when the service was initialized,
 * or falls back to the conversation context if available.
 *
 * @param service The service instance.
 * @returns The parent service context, or null if unavailable.
 */
export function _getParentServiceContext(service: Service): OtelContext | null {
  const otel = getOpenTelemetry();
  if (!otel) {
    return null;
  }

  // Use the conversation context set by TurnTraceObserver via TracingContext.
  const tracingCtx = service?._tracingContext;
  const conversationContext = tracingCtx ? tracingCtx.getConversationContext() : null;
  if (conversationContext) {
    return conversationContext;
  }

  // Last resort: use current context (may create orphan spans)
  return otel.api.context.active();
}

/**
 * Resolve the effective system instruction for tracing (internal use only).
 *
 * System instructions can live on the LLM service (`settings.systemInstruction`,
 * the norm — and the composed source of truth, see
 * `LLMService._composeSystemInstruction`) or be supplied as an initial
 * system message in the context. The service setting takes priority,
 * matching service behavior.
 *
 * @param service The LLM service instance.
 * @param context The universal `LLMContext`, or null.
 * @returns The system instruction text, or null if none is present.
 */
export function _getSystemInstruction(service: Service, context: Service): string | null {
  const systemInstruction = service?.settings?.systemInstruction;
  if (truthy(systemInstruction)) {
    return systemInstruction;
  }

  if (!context) {
    return null;
  }

  // Fall back to extracting from context messages
  const ctxMessages = context.getMessages();
  if (ctxMessages && ctxMessages.length > 0) {
    const first = ctxMessages[0];
    if (isObject(first) && first.role === "system") {
      const content = first.content;
      if (typeof content === "string") {
        return content;
      } else if (Array.isArray(content)) {
        return content
          .filter((part) => isObject(part) && part.type === "text")
          .map((part) => ((part as Dict).text as string | undefined) ?? "")
          .join(" ");
      }
    }
  }
  return null;
}

const TOKEN_USAGE_ATTRIBUTES: readonly [string, string, string][] = [
  // [dict key, LLMTokenUsage field, attribute]
  ["cache_read_input_tokens", "cacheReadInputTokens", "gen_ai.usage.cache_read.input_tokens"],
  [
    "cache_creation_input_tokens",
    "cacheCreationInputTokens",
    "gen_ai.usage.cache_creation.input_tokens",
  ],
  ["reasoning_tokens", "reasoningTokens", "gen_ai.usage.reasoning.output_tokens"],
  ["input_audio_tokens", "inputAudioTokens", "gen_ai.usage.audio.input_tokens"],
  ["output_audio_tokens", "outputAudioTokens", "gen_ai.usage.audio.output_tokens"],
  [
    "cache_read_input_audio_tokens",
    "cacheReadInputAudioTokens",
    "gen_ai.usage.audio.cache_read.input_tokens",
  ],
];

/**
 * Add token usage metrics to a span (internal use only).
 *
 * @param span The span to add token metrics to.
 * @param tokenUsage A dict (snake_case keys) or `LLMTokenUsage` object
 *   containing token usage information.
 */
export function _addTokenUsageToSpan(span: OtelSpan, tokenUsage: unknown): void {
  if (!isTracingAvailable() || !tokenUsage) {
    return;
  }

  if (isDict(tokenUsage) && !(tokenUsage instanceof LLMTokenUsage)) {
    if ("prompt_tokens" in tokenUsage) {
      span.setAttribute("gen_ai.usage.input_tokens", tokenUsage.prompt_tokens as number);
    }
    if ("completion_tokens" in tokenUsage) {
      span.setAttribute("gen_ai.usage.output_tokens", tokenUsage.completion_tokens as number);
    }
    // Add cached token metrics for dictionary
    for (const [key, , attribute] of TOKEN_USAGE_ATTRIBUTES) {
      const value = tokenUsage[key];
      if (key in tokenUsage && value !== null && value !== undefined) {
        span.setAttribute(attribute, value as number);
      }
    }
  } else {
    // Handle LLMTokenUsage object
    const usage = tokenUsage as Dict;
    span.setAttribute("gen_ai.usage.input_tokens", (usage.promptTokens as number) ?? 0);
    span.setAttribute("gen_ai.usage.output_tokens", (usage.completionTokens as number) ?? 0);

    // Add cached token metrics for LLMTokenUsage object
    for (const [, field, attribute] of TOKEN_USAGE_ATTRIBUTES) {
      const value = usage[field];
      if (value !== null && value !== undefined) {
        span.setAttribute(attribute, value as number);
      }
    }
  }
}

/**
 * Add STT usage metrics to a span (internal use only).
 *
 * @param span The span to add usage metrics to.
 * @param usage `STTUsage` object with audio seconds.
 */
export function _addSttUsageToSpan(span: OtelSpan, usage: Service): void {
  if (!isTracingAvailable() || usage === null || usage === undefined) {
    return;
  }

  span.setAttribute("metrics.audio_seconds", usage.audioSeconds);
}

export interface TracedOptions {
  /** Custom span name. */
  name?: string | null;
}

/** Normalize the `(func | options, context)` overloads of the `traced*` decorators. */
function resolveDecorator(
  decorator: TracedMethodDecorator,
  funcOrOptions: unknown,
  context: unknown,
  descriptor: PropertyDescriptor | undefined,
): unknown {
  if (typeof funcOrOptions === "function" || typeof context === "string") {
    return decorator(funcOrOptions, context, descriptor);
  }
  return decorator;
}

//
// TTS
//

interface TtsSpanEntry {
  span: OtelSpan;
  ttfbRecorded: boolean;
}

/** End the TTS span for `contextId` if still open. Idempotent. */
function endTtsSpan(
  service: Service,
  contextId: string,
  options: { interrupted?: boolean } = {},
): void {
  (service._ttsTexts as Map<string, string[]> | undefined)?.delete(contextId);
  const spans = service._ttsSpans as Map<string, TtsSpanEntry> | undefined;
  const entry = spans?.get(contextId);
  spans?.delete(contextId);
  if (!entry) {
    return;
  }
  try {
    const span = entry.span;
    if (options.interrupted) {
      span.setAttribute("tts.interrupted", true);
    }
    span.end();
  } catch (e) {
    rethrowIfCancelled(e);
    logger.warning(`Error closing TTS span: ${errorMessage(e)}`);
  }
}

/**
 * Set the accumulated text attributes on a TTS span.
 *
 * One audio context (and thus one span) typically receives
 * several `runTts` calls — one per aggregated sentence — so
 * the attributes always reflect the full accumulated text, not
 * just the latest call.
 */
function applyTextAttributes(span: OtelSpan, texts: readonly string[]): void {
  span.setAttribute("text", texts.join(" "));
  span.setAttribute(
    "metrics.character_count",
    texts.reduce((sum, t) => sum + [...t].length, 0),
  );
}

/**
 * Install per-instance wrappers on the audio-context methods.
 *
 * The wrappers own the lifetime of the TTS span:
 *
 * - `createAudioContext`: opens the span and records baseline attributes.
 * - `appendToAudioContext`: ends the span on `TTSStoppedFrame`.
 * - `pushFrame`: records `metrics.ttfb` from the canonical `TTFBMetricsData`
 *   payload of any `MetricsFrame` pushed by `stopTtfbMetrics`. Reading the
 *   value from the metrics event (instead of polling `_metrics.ttfb` when the
 *   first audio is queued) avoids the `ttfb` property's in-progress fallback,
 *   which would otherwise report an under-estimate whenever a context's audio
 *   waits behind earlier queued audio before `_handleAudioContext` actually
 *   stops the TTFB measurement.
 * - `removeAudioContext`: ends any still-open span as a safety net for error
 *   and cancellation paths.
 * - `onAudioContextCompleted`: ends the span on natural completion. Needed
 *   because services that rely on the base class to auto-push
 *   `TTSStoppedFrame` (via `pushFrame` in `_handleAudioContext`) bypass the
 *   `appendToAudioContext` hook entirely.
 * - `resetActiveAudioContext`: ends the currently playing context's span if
 *   still open. Always called from `_handleInterruption`, so this is the
 *   interruption hook.
 *
 * The patches check `_tracingEnabled` at invocation time, so they are safe to
 * install regardless of whether tracing is enabled.
 */
function installAudioContextPatches(service: Service): void {
  if (service.__ttsTracingPatchesInstalled__) {
    return;
  }
  service.__ttsTracingPatchesInstalled__ = true;
  service._ttsSpans = new Map<string, TtsSpanEntry>();
  service._ttsTexts = new Map<string, string[]>();
  const spans = service._ttsSpans as Map<string, TtsSpanEntry>;
  const texts = service._ttsTexts as Map<string, string[]>;

  const origCreate = service.createAudioContext.bind(service);
  const origAppend = service.appendToAudioContext.bind(service);
  const origRemove = service.removeAudioContext.bind(service);
  const origCompleted = service.onAudioContextCompleted.bind(service);
  const origResetActive = service.resetActiveAudioContext.bind(service);
  const origPushFrame = service.pushFrame.bind(service);

  const tracingOn = () => Boolean(service._tracingEnabled) && isTracingAvailable();

  service.createAudioContext = async (contextId: string) => {
    if (tracingOn()) {
      try {
        const parent = _getTurnContext(service) || _getParentServiceContext(service);
        const span = getTracer().startSpan("tts", {}, parent ?? undefined);
        spans.set(contextId, { span, ttfbRecorded: false });

        const settings = service._settings ?? null;
        addTtsSpanAttributes(span, {
          serviceName: service.constructor.name,
          model: _getModelName(service),
          voiceId: settings?.voice ?? "unknown",
          settings,
          operationName: "tts",
        });

        // Apply any text buffered by runTts before the span existed — some
        // services (e.g. the ElevenLabs websocket path) create the audio
        // context inside runTts, after the text-attach hook has run.
        const buffered = texts.get(contextId);
        if (buffered && buffered.length > 0) {
          applyTextAttributes(span, buffered);
        }
      } catch (e) {
        rethrowIfCancelled(e);
        logger.warning(`Error opening TTS span: ${errorMessage(e)}`);
      }
    }
    return await origCreate(contextId);
  };

  service.appendToAudioContext = async (contextId: string, frame: Frame | null) => {
    const entry = spans.get(contextId);
    if (entry && frame !== null && frame !== undefined) {
      try {
        if (frame instanceof TTSStoppedFrame) {
          entry.span.end();
          spans.delete(contextId);
          texts.delete(contextId);
        }
      } catch (e) {
        rethrowIfCancelled(e);
        logger.warning(`Error updating TTS span: ${errorMessage(e)}`);
      }
    }
    return await origAppend(contextId, frame);
  };

  service.pushFrame = async (
    frame: Frame,
    direction: FrameDirection = FrameDirection.DOWNSTREAM,
  ) => {
    await origPushFrame(frame, direction);
    if (!tracingOn()) {
      return;
    }
    if (!(frame instanceof MetricsFrame)) {
      return;
    }
    try {
      const playingId = service._audioContextManager.playingContextId;
      if (playingId === null || playingId === undefined) {
        return;
      }
      const entry = spans.get(playingId);
      if (!entry || entry.ttfbRecorded) {
        return;
      }
      for (const data of frame.data) {
        if (data instanceof TTFBMetricsData) {
          entry.span.setAttribute("metrics.ttfb", data.value);
          entry.ttfbRecorded = true;
          break;
        }
      }
    } catch (e) {
      rethrowIfCancelled(e);
      logger.warning(`Error recording TTS ttfb from MetricsFrame: ${errorMessage(e)}`);
    }
  };

  service.removeAudioContext = async (contextId: string | null) => {
    if (contextId !== null) {
      texts.delete(contextId);
      const entry = spans.get(contextId);
      spans.delete(contextId);
      if (entry) {
        try {
          entry.span.end();
        } catch (e) {
          rethrowIfCancelled(e);
          logger.warning(`Error closing TTS span: ${errorMessage(e)}`);
        }
      }
    }
    return await origRemove(contextId);
  };

  service.onAudioContextCompleted = async (contextId: string) => {
    endTtsSpan(service, contextId);
    return await origCompleted(contextId);
  };

  service.resetActiveAudioContext = () => {
    const playingId = service._audioContextManager.playingContextId;
    if (playingId !== null && playingId !== undefined) {
      endTtsSpan(service, playingId, { interrupted: true });
    }
    return origResetActive();
  };
}

/**
 * Wrap `owner.setup` so audio-context patches install per-instance.
 *
 * Idempotent: if a parent class has already been wrapped, skip. The patches
 * check `_tracingEnabled` at invocation time, so wrapping is always safe.
 */
function patchTtsSetup(owner: object): void {
  wrapMethod(owner, "setup", "__ttsTracingSetupWrapped__", (originalSetup) => {
    return async function patchedSetup(this: Service, setup: unknown) {
      await originalSetup.call(this, setup);
      installAudioContextPatches(this);
    };
  });
}

/**
 * Attach text-specific attributes to the in-flight TTS span.
 *
 * Texts accumulate per audio context: with sentence aggregation, one span
 * covers several `runTts` calls. The text may also arrive before the span
 * exists — some services create the audio context inside `runTts` — in which
 * case it is buffered here and applied by `createAudioContext` once the span
 * opens.
 */
function attachRunTtsAttributes(service: Service, text: string, args: unknown[]): void {
  if (!service._tracingEnabled || !isTracingAvailable()) {
    return;
  }
  try {
    if (!text) {
      return;
    }
    const buffers = service._ttsTexts as Map<unknown, string[]> | undefined;
    if (buffers === undefined || buffers === null) {
      return;
    }
    const contextId = args.length > 0 ? args[0] : undefined;
    let texts = buffers.get(contextId);
    if (!texts) {
      texts = [];
      buffers.set(contextId, texts);
    }
    texts.push(text);
    const entry = (service._ttsSpans as Map<unknown, TtsSpanEntry> | undefined)?.get(contextId);
    if (entry) {
      applyTextAttributes(entry.span, texts);
    }
  } catch (e) {
    rethrowIfCancelled(e);
    logger.warning(`Error attaching TTS text to span: ${errorMessage(e)}`);
  }
}

function isAsyncGeneratorFunction(fn: AnyFn): boolean {
  return Object.prototype.toString.call(fn) === "[object AsyncGeneratorFunction]";
}

/**
 * Build the wrapper around `runTts` that adds per-call attributes.
 *
 * Span lifetime is owned by the audio-context patches. This wrapper only
 * records the call's text against the audio context, accumulating across
 * calls; the attributes land on the span opened by `createAudioContext`
 * whether that happened before this call or happens inside it.
 */
function makeRunTtsWrapper(f: AnyFn): AnyFn {
  if (isAsyncGeneratorFunction(f)) {
    return async function* genWrapper(this: Service, text: string, ...args: unknown[]) {
      attachRunTtsAttributes(this, text, args);
      yield* f.call(this, text, ...args);
    };
  }

  return async function coroWrapper(this: Service, text: string, ...args: unknown[]) {
    attachRunTtsAttributes(this, text, args);
    return await f.call(this, text, ...args);
  };
}

/**
 * Trace TTS service methods with TTS-specific attributes.
 *
 * Automatically captures and records:
 *
 * - Service name and model information
 * - Voice ID and settings
 * - Character count and text content
 * - Performance metrics like TTFB
 *
 * The span is scoped to the full synthesis operation, from
 * `createAudioContext` until `TTSStoppedFrame` (or `removeAudioContext` as a
 * safety net), so TTFB and any other runtime-computed metrics land on the
 * correct span even when audio chunks are delivered after `runTts` returns
 * (e.g. WebSocket streaming TTS services).
 *
 * Works with both async functions and generators.
 *
 * @example
 * class MyTTSService extends TTSService {
 *   @tracedTts
 *   async *runTts(text: string, contextId: string) { ... }
 * }
 *
 * @param func The TTS method to trace (when used as `@tracedTts`).
 * @param options.name Custom span name. Defaults to service type and class name.
 * @returns Wrapped method with TTS-specific tracing, or a decorator when
 *   called with options.
 */
export function tracedTts(options?: TracedOptions): TracedMethodDecorator;
export function tracedTts(func: any, context?: any, descriptor?: PropertyDescriptor): any;
export function tracedTts(
  funcOrOptions?: unknown,
  context?: unknown,
  descriptor?: PropertyDescriptor,
): unknown {
  const decorator = makeMethodDecorator(makeRunTtsWrapper, patchTtsSetup);
  return resolveDecorator(decorator, funcOrOptions, context, descriptor);
}

/**
 * Apply `tracedTts` to `owner[attrName]` without decorator syntax.
 *
 * Equivalent to upstream's class-definition-time `__set_name__` hook: wraps
 * `owner.setup` so the audio-context patches install on every instance, and
 * replaces the method with its traced wrapper.
 *
 * @example
 * class MyTTSService extends TTSService {
 *   async *runTts(text: string, contextId: string) { ... }
 *   static {
 *     installTracedTts(this.prototype, "runTts");
 *   }
 * }
 */
export function installTracedTts(owner: object, attrName: string, _options?: TracedOptions): void {
  patchTtsSetup(owner);
  const target = owner as Service;
  target[attrName] = makeRunTtsWrapper(target[attrName]);
}

//
// STT
//

interface SttSpanState {
  span: OtelSpan | null;
  segmentStartTime: number | null;
  segments: string[];
  pendingUsage: Service | null;
}

function getSttSpanState(service: Service): SttSpanState {
  let state = service._sttSpanState as SttSpanState | undefined;
  if (state === undefined || state === null) {
    state = { span: null, segmentStartTime: null, segments: [], pendingUsage: null };
    service._sttSpanState = state;
  }
  return state;
}

/**
 * Attach accumulated usage to the open span and clear it.
 *
 * Called at every span-close site so usage can't bleed into a later span.
 * Usage is accumulated (rather than attached as it arrives) because services
 * emit it just before pushing the finalized transcript — at which point the
 * span may not be open yet — and a single span may cover several usage events.
 */
function attachPendingUsage(state: SttSpanState): void {
  const usage = state.pendingUsage;
  if (usage !== null && usage !== undefined) {
    if (state.span) {
      _addSttUsageToSpan(state.span, usage);
    }
    state.pendingUsage = null;
  }
}

/**
 * Append or extend the current segment in `state.segments`.
 *
 * If `newText` starts with the last recorded segment, treat it as a
 * continuation (interim accumulation) and replace the last segment. Otherwise
 * treat it as a new segment and append. Some STT services (Deepgram with
 * utterance_end_ms enabled, for example) emit several `TranscriptionFrame`s
 * per turn where each carries a different segment rather than a cumulative
 * update — without this logic the span's transcript would only show the last
 * segment and the beginning would be lost.
 */
function updateTranscript(state: SttSpanState, newText: string): void {
  if (!newText) {
    return;
  }
  const segments = state.segments;
  const last = segments[segments.length - 1];
  if (last === undefined) {
    segments.push(newText);
  } else if (newText.startsWith(last)) {
    segments[segments.length - 1] = newText;
  } else {
    segments.push(newText);
  }
}

/** Open the STT span, anchored at `segmentStartTime` if set. */
function openSttSpan(service: Service, state: SttSpanState): void {
  const parent = _getTurnContext(service) || _getParentServiceContext(service);
  const spanOptions: Dict = {};
  if (state.segmentStartTime !== null) {
    spanOptions.startTime = toHrTime(state.segmentStartTime);
  }
  const span = getTracer().startSpan("stt", spanOptions, parent ?? undefined);
  try {
    const settings = service._settings ?? null;
    addSttSpanAttributes(span, {
      serviceName: service.constructor.name,
      model: _getModelName(service),
      settings,
      vadEnabled: service.vadEnabled ?? false,
    });
  } catch (e) {
    rethrowIfCancelled(e);
    logger.warning(`Error setting STT span baseline attributes: ${errorMessage(e)}`);
  }
  state.span = span;
}

/**
 * Record speech-start anchor; lazy-open span on first transcript.
 *
 * Lazy-opening on `TranscriptionFrame` (rather than on
 * `VADUserStartedSpeakingFrame` or `UserStartedSpeakingFrame`) avoids racing
 * with `TurnTraceObserver._handleTurnStarted`, which runs in a background
 * task fired by `_callEventHandler` and may not have set the new turn's
 * context yet — that produces STT spans parented to the previous turn. By the
 * time STT actually emits a transcript, the turn observer has run.
 *
 * Opening happens in pre-push (rather than post-push) so that the recursive
 * `pushFrame` that `STTService.pushFrame` triggers for the `MetricsFrame` (via
 * `stopTtfbMetrics`) sees the span already open and can attribute
 * `metrics.ttfb` to it.
 */
function handleSttPrePush(service: Service, frame: Frame, state: SttSpanState): void {
  if (frame instanceof VADUserStartedSpeakingFrame) {
    // Anchor the next span at the moment speech began.
    // Skip if we already have an anchor (intra-turn VAD
    // re-trigger) or a span open.
    if (state.span === null && state.segmentStartTime === null) {
      state.segmentStartTime = frame.timestamp - frame.startSecs;
    }
  } else if (frame instanceof TranscriptionFrame && state.span === null) {
    openSttSpan(service, state);
  }
}

/**
 * Attach per-frame attrs; close on finalized; record TTFB from MetricsFrame.
 *
 * `metrics.ttfb` is read off the `TTFBMetricsData` payload of any
 * `MetricsFrame` pushed by `stopTtfbMetrics` — the canonical value the rest
 * of the system uses — rather than from `_metrics.ttfb`, which has an
 * in-progress fallback branch that would return an under-estimate if read at
 * the wrong time.
 *
 * One STT span per finalized transcript: the span opens lazily on the first
 * `TranscriptionFrame` (pre-push, anchored at speech start via
 * `segmentStartTime`) and closes on `finalized=true`. Multiple finalized
 * transcripts in a single turn produce multiple spans.
 *
 * For services that never set `frame.finalized=true` (e.g. Deepgram, which
 * only marks it via `confirmFinalize()`), the span closes on
 * `UserStoppedSpeakingFrame`. To capture `metrics.ttfb` for those spans we
 * force-stop any pending TTFB measurement before closing — that pushes a
 * `MetricsFrame`, our post-push attributes the value, and the patched
 * `stopTtfbMetrics` closes the span. The `stt.incomplete=true` flag is only
 * set if neither a finalized transcript nor a TTFB measurement ever finalized
 * for the span.
 */
async function handleSttPostPush(service: Service, frame: Frame, state: SttSpanState) {
  if (frame instanceof UserStoppedSpeakingFrame) {
    const prevSpan = state.span;
    if (prevSpan === null) {
      return;
    }
    const metrics = service._metrics;
    if (metrics !== null && metrics !== undefined && (metrics._startTtfbTime ?? 0) > 0) {
      const lastTranscriptTime = service._lastTranscriptTime || null;
      try {
        await service.stopTtfbMetrics({ endTime: lastTranscriptTime });
      } catch (e) {
        rethrowIfCancelled(e);
        logger.warning(`Error force-stopping STT TTFB on user turn end: ${errorMessage(e)}`);
      }
    }
    // The patched stopTtfbMetrics may have closed the span
    // via the timeout path; re-check.
    if (state.span === null) {
      state.segments = [];
      return;
    }
    state.span.setAttribute("stt.incomplete", true);
    attachPendingUsage(state);
    state.span.end();
    state.span = null;
    state.segmentStartTime = null;
    state.segments = [];
  } else if (frame instanceof MetricsFrame) {
    const span = state.span;
    if (span === null) {
      return;
    }
    for (const data of frame.data) {
      if (data instanceof TTFBMetricsData) {
        span.setAttribute("metrics.ttfb", data.value);
        break;
      }
    }
  } else if (frame instanceof TranscriptionFrame) {
    const span = state.span;
    if (span === null) {
      return;
    }
    if (frame.text) {
      updateTranscript(state, frame.text);
      span.setAttribute("transcript", state.segments.join(" ").trim());
    }
    span.setAttribute("is_final", Boolean(frame.finalized));
    if (frame.language) {
      span.setAttribute("language", String(frame.language));
    }
    if (frame.userId) {
      span.setAttribute("user_id", frame.userId);
    }
    if (frame.finalized) {
      attachPendingUsage(state);
      span.end();
      state.span = null;
      state.segmentStartTime = null;
      state.segments = [];
    }
  }
}

/**
 * Wrap `owner.pushFrame` to drive the STT span lifecycle.
 *
 * Idempotent: if a parent class has already been wrapped, skip. The wrapper
 * checks `_tracingEnabled` at invocation time, so it is safe to install
 * regardless of whether tracing is enabled.
 */
function patchSttPushFrame(owner: object): void {
  wrapMethod(owner, "pushFrame", "__sttTracingPushFrameWrapped__", (originalPushFrame) => {
    return async function patchedPushFrame(
      this: Service,
      frame: Frame,
      direction: FrameDirection = FrameDirection.DOWNSTREAM,
    ) {
      const state = getSttSpanState(this);
      const tracingOn = Boolean(this._tracingEnabled) && isTracingAvailable();

      if (tracingOn) {
        try {
          handleSttPrePush(this, frame, state);
        } catch (e) {
          rethrowIfCancelled(e);
          logger.warning(`Error in STT pre-push tracing: ${errorMessage(e)}`);
        }
      }

      await originalPushFrame.call(this, frame, direction);

      if (this._tracingEnabled && isTracingAvailable()) {
        try {
          await handleSttPostPush(this, frame, state);
        } catch (e) {
          rethrowIfCancelled(e);
          logger.warning(`Error in STT post-push tracing: ${errorMessage(e)}`);
        }
      }
    };
  });
}

/**
 * Wrap `owner.stopTtfbMetrics` to close the span on the timeout path.
 *
 * When `stopTtfbMetrics` is invoked with `endTime` set, that signals the
 * TTFB-timeout handler firing, or our own force-stop from the
 * `UserStoppedSpeakingFrame` handler. In either case we anchor the span's end
 * at `endTime` (= `_lastTranscriptTime`) rather than at whenever the
 * coroutine resumed.
 *
 * `metrics.ttfb` attribution is not done here — the `MetricsFrame` that
 * `stopTtfbMetrics` pushes flows through `pushFrame` and gets recorded by the
 * post-push handler, which reads the canonical `TTFBMetricsData.value` rather
 * than the in-progress `_metrics.ttfb` property.
 */
function patchSttStopTtfbMetrics(owner: object): void {
  wrapMethod(owner, "stopTtfbMetrics", "__sttTracingStopTtfbWrapped__", (originalStop) => {
    return async function patchedStop(this: Service, options: { endTime?: number | null } = {}) {
      const endTime = options.endTime ?? null;
      await originalStop.call(this, { endTime });
      if (endTime === null) {
        return;
      }
      if (!this._tracingEnabled || !isTracingAvailable()) {
        return;
      }
      const state = this._sttSpanState as SttSpanState | undefined;
      if (!state || state.span === null) {
        return;
      }
      try {
        const span = state.span;
        attachPendingUsage(state);
        span.end(toHrTime(endTime));
        state.span = null;
        state.segmentStartTime = null;
        state.segments = [];
      } catch (e) {
        rethrowIfCancelled(e);
        logger.warning(`Error in STT stopTtfbMetrics tracing: ${errorMessage(e)}`);
      }
    };
  });
}

/**
 * Wrap `owner.startSttUsageMetrics` to accumulate usage for the span.
 *
 * Usage is merged into the span state's `pendingUsage` and attached when the
 * span closes (see `attachPendingUsage`). Values are summed across events.
 */
function patchSttStartUsageMetrics(owner: object): void {
  wrapMethod(owner, "startSttUsageMetrics", "__sttTracingUsageWrapped__", (originalStart) => {
    return async function patchedStart(this: Service, usage: Service) {
      await originalStart.call(this, usage);
      if (!this._tracingEnabled || !isTracingAvailable()) {
        return;
      }
      try {
        const state = getSttSpanState(this);
        const pending = state.pendingUsage;
        if (pending === null || pending === undefined) {
          state.pendingUsage = Object.assign(Object.create(Object.getPrototypeOf(usage)), usage);
        } else {
          pending.audioSeconds += usage.audioSeconds;
        }
      } catch (e) {
        rethrowIfCancelled(e);
        logger.warning(`Error in STT usage tracing: ${errorMessage(e)}`);
      }
    };
  });
}

function installSttPatches(owner: object): void {
  patchSttPushFrame(owner);
  patchSttStopTtfbMetrics(owner);
  patchSttStartUsageMetrics(owner);
}

/**
 * Trace STT service methods with transcription attributes.
 *
 * Automatically captures and records:
 *
 * - Service name and model information
 * - Transcription text and final status
 * - Language information
 * - Performance metrics like TTFB
 * - Usage metrics (audio seconds) when the service reports them via
 *   `startSttUsageMetrics`
 *
 * The span is scoped to one STT segment, from `VADUserStartedSpeakingFrame`
 * (or the first `TranscriptionFrame` when VAD did not fire, e.g. whispered
 * speech) until a finalized `TranscriptionFrame`. Multiple finalized
 * transcripts in a single user turn produce multiple sequential spans, each
 * anchored at the point speech for that segment began. `metrics.ttfb` is read
 * after the base `pushFrame` runs `stopTtfbMetrics` for the finalized frame,
 * so the value is correct for the closing span.
 *
 * @param func The STT method to trace (when used as `@tracedStt`).
 * @param options.name Custom span name. Defaults to function name.
 * @returns The original method unchanged. The decorator's class-level work is
 *   to install a `pushFrame` wrapper on the owning class (or, as a TC39
 *   decorator, on each instance) that owns the span lifetime.
 */
export function tracedStt(options?: TracedOptions): TracedMethodDecorator;
export function tracedStt(func: any, context?: any, descriptor?: PropertyDescriptor): any;
export function tracedStt(
  funcOrOptions?: unknown,
  context?: unknown,
  descriptor?: PropertyDescriptor,
): unknown {
  const decorator = makeMethodDecorator((f) => f, installSttPatches);
  return resolveDecorator(decorator, funcOrOptions, context, descriptor);
}

/**
 * Apply `tracedStt` to `owner` without decorator syntax.
 *
 * Equivalent to upstream's class-definition-time `__set_name__` hook: wraps
 * `pushFrame`, `stopTtfbMetrics` and `startSttUsageMetrics` so VAD,
 * transcription, and finalization events drive the span lifecycle. The
 * decorated method itself runs unchanged.
 *
 * @example
 * class MySTTService extends STTService {
 *   static {
 *     installTracedStt(this.prototype, "_handleTranscription");
 *   }
 * }
 */
export function installTracedStt(
  owner: object,
  _attrName?: string,
  _options?: TracedOptions,
): void {
  installSttPatches(owner);
}

//
// LLM
//

function makeLlmWrapper(f: AnyFn): AnyFn {
  return async function wrapper(this: Service, context: Service, ...args: unknown[]) {
    if (!this._tracingEnabled || !isTracingAvailable()) {
      return await f.call(this, context, ...args);
    }
    let fnCalled = false;
    try {
      const serviceClassName = this.constructor.name;
      const spanName = "llm";

      // Get the parent context - turn context if available, otherwise service context
      const parentContext = _getTurnContext(this) || _getParentServiceContext(this);

      // Create a new span as child of the turn span or service span
      return await withCurrentSpan(spanName, parentContext, async (currentSpan) => {
        // Store original method and output aggregator
        const hadOwnPushFrame = Object.hasOwn(this, "pushFrame");
        const ownPushFrame = this.pushFrame;
        const originalPushFrame = this.pushFrame.bind(this);
        let outputText = ""; // Simple string accumulation

        const tracedPushFrame = async (frame: Frame, direction?: FrameDirection) => {
          // Capture text from LLMTextFrame during streaming
          if (
            frame?.constructor?.name === "LLMTextFrame" &&
            typeof (frame as Service).text === "string"
          ) {
            outputText += (frame as Service).text;
          }

          // Call original
          if (direction !== undefined && direction !== null) {
            return await originalPushFrame(frame, direction);
          }
          return await originalPushFrame(frame);
        };

        // For token usage monitoring
        let hadOwnStartUsage = false;
        let ownStartUsage: AnyFn | undefined;
        let originalStartLlmUsageMetrics: AnyFn | null = null;
        if (typeof this.startLlmUsageMetrics === "function") {
          hadOwnStartUsage = Object.hasOwn(this, "startLlmUsageMetrics");
          ownStartUsage = this.startLlmUsageMetrics;
          const original = this.startLlmUsageMetrics.bind(this) as AnyFn;
          originalStartLlmUsageMetrics = original;

          // Override the method to capture token usage
          const wrappedStartLlmUsageMetrics = async (tokens: unknown) => {
            // Call the original method
            await original(tokens);

            // Add token usage to the current span
            _addTokenUsageToSpan(currentSpan, tokens);
          };

          // Replace the method temporarily
          this.startLlmUsageMetrics = wrappedStartLlmUsageMetrics;
        }

        try {
          try {
            // Replace pushFrame to capture output
            this.pushFrame = tracedPushFrame;

            // Get messages for logging
            // Use adapter's getMessagesForLogging() which returns
            // messages in provider's native format with sensitive data sanitized
            let messages: unknown = null;
            let serializedMessages: string | null = null;

            // Use adapter for provider-native format
            if (typeof this.getLlmAdapter === "function") {
              const adapter = this.getLlmAdapter();
              messages = adapter.getMessagesForLogging(context);
            }

            // Serialize messages if available
            if (Array.isArray(messages) ? messages.length > 0 : messages) {
              serializedMessages = jsonDumps(messages);
            }

            // Get tools
            // Use adapter's fromStandardTools() to convert ToolsSchema
            let tools: unknown = null;
            let serializedTools: string | null = null;
            let toolCount = 0;

            // Use adapter to convert ToolsSchema
            if (
              typeof this.getLlmAdapter === "function" &&
              isObject(context) &&
              "tools" in context
            ) {
              const adapter = this.getLlmAdapter();
              tools = adapter.fromStandardTools(context.tools);
            }

            // Serialize and count tools if available
            // Check if tools is not null and not NOT_GIVEN
            if (tools !== null && tools !== undefined && tools !== NOT_GIVEN) {
              serializedTools = jsonDumps(tools);
              toolCount = Array.isArray(tools) ? tools.length : 1;
            }

            // Handle system message for different services
            // settings.systemInstruction takes priority (matches service behavior)
            const systemMessage = _getSystemInstruction(this, context);

            // Use givenFields() defensively in case a service doesn't
            // initialize all settings.
            const params: Dict = {};
            if (this._settings) {
              for (const [key, value] of Object.entries(this._settings.givenFields() as Dict)) {
                // systemInstruction is already captured as the
                // "system_instructions" span attribute above.
                if (key === "systemInstruction") {
                  continue;
                }
                if (
                  typeof value === "number" ||
                  typeof value === "boolean" ||
                  typeof value === "string"
                ) {
                  params[key] = value;
                } else if (value === null || value === undefined) {
                  params[key] = "NOT_GIVEN";
                }
              }
            }

            // Add all available attributes to the span
            const attributeOptions: LlmSpanAttributesOptions = {
              serviceName: serviceClassName,
              model: _getModelName(this),
              stream: true, // Most LLM services use streaming
              parameters: params,
            };

            // Add optional attributes only if they exist
            if (serializedMessages) {
              attributeOptions.messages = serializedMessages;
            }
            if (serializedTools) {
              attributeOptions.tools = serializedTools;
              attributeOptions.toolCount = toolCount;
            }
            if (systemMessage) {
              attributeOptions.systemInstructions = systemMessage;
            }

            // Add all gathered attributes to the span
            addLlmSpanAttributes(currentSpan, attributeOptions);
          } catch (e) {
            rethrowIfCancelled(e);
            logger.warning(`Error setting up LLM tracing: ${errorMessage(e)}`);
            // Don't raise - let the function execute anyway
          }

          // Run function with modified pushFrame to capture the output
          fnCalled = true;
          return await f.call(this, context, ...args);
        } finally {
          // Always restore the original methods
          if (hadOwnPushFrame) {
            this.pushFrame = ownPushFrame;
          } else {
            delete this.pushFrame;
          }

          if (originalStartLlmUsageMetrics) {
            if (hadOwnStartUsage) {
              this.startLlmUsageMetrics = ownStartUsage;
            } else {
              delete this.startLlmUsageMetrics;
            }
          }

          // Attach whatever output text we accumulated so far. Doing this in
          // finally captures partial output when `f` is cancelled or raises
          // mid-stream (e.g. interruption during LLM generation), rather than
          // only on clean completion.
          if (outputText) {
            currentSpan.setAttribute("output", outputText);
          }

          // Update TTFB metric
          const ttfb: number | null | undefined = this._metrics?.ttfb;
          if (ttfb !== null && ttfb !== undefined) {
            currentSpan.setAttribute("metrics.ttfb", ttfb);
          }
        }
      });
    } catch (e) {
      if (fnCalled || e instanceof CancelledError) {
        throw e;
      }
      logger.error(`Error in LLM tracing (continuing without tracing): ${errorMessage(e)}`);
      return await f.call(this, context, ...args);
    }
  };
}

/**
 * Trace LLM service methods with LLM-specific attributes.
 *
 * Automatically captures and records:
 *
 * - Service name and model information
 * - Context content and messages
 * - Tool configurations
 * - Token usage metrics
 * - Performance metrics like TTFB
 * - Aggregated output text
 *
 * @param func The LLM method to trace (when used as `@tracedLlm`).
 * @param options.name Custom span name. Defaults to service type and class name.
 * @returns Wrapped method with LLM-specific tracing, or a decorator when
 *   called with options.
 */
export function tracedLlm(options?: TracedOptions): TracedMethodDecorator;
export function tracedLlm(func: any, context?: any, descriptor?: PropertyDescriptor): any;
export function tracedLlm(
  funcOrOptions?: unknown,
  context?: unknown,
  descriptor?: PropertyDescriptor,
): unknown {
  const decorator = makeMethodDecorator(makeLlmWrapper, null);
  return resolveDecorator(decorator, funcOrOptions, context, descriptor);
}

//
// Gemini Live
//

/**
 * Get the AUDIO token count from a Gemini modality breakdown, if reported.
 *
 * Duck-typed (`entry.modality` / `entry.tokenCount`) so this module doesn't
 * depend on Google types. Gemini omits modalities with no tokens (and omits
 * the list entirely when there is no breakdown), so absence means "not
 * reported" rather than zero.
 *
 * @param details A modality breakdown from usage metadata, e.g. `promptTokensDetails`.
 * @returns The AUDIO token count, or null if not reported.
 */
export function _geminiAudioModalityTokens(details: unknown): number | null {
  for (const entry of (details as Service[] | null | undefined) ?? []) {
    const modality = entry?.modality;
    const value = isObject(modality) && "value" in modality ? modality.value : modality;
    if (value === "AUDIO") {
      return entry.tokenCount;
    }
  }
  return null;
}

function toolField(tool: Service, field: string, fallback: unknown): unknown {
  return isObject(tool) && field in tool ? tool[field] : fallback;
}

function serializeToolList(tools: readonly Service[]): string {
  return jsonDumps(
    tools.map((tool) => ({
      name: toolField(tool, "name", "unknown"),
      description: toolField(tool, "description", ""),
      properties: toolField(tool, "properties", {}),
      required: toolField(tool, "required", []),
    })),
  );
}

/** Collect the operation-specific Gemini Live attributes. */
function geminiOperationAttributes(self: Service, operation: string, args: unknown[]): Dict {
  const operationAttrs: Dict = {};

  if (operation === "llm_setup") {
    // Capture detailed tool information
    const tools = self._tools;
    if (tools) {
      // Handle different tool formats
      let toolsList: Service[] = [];
      let toolsSerialized: string | null = null;

      try {
        if (isObject(tools) && "standardTools" in tools) {
          // ToolsSchema object
          toolsList = tools.standardTools as Service[];
          // Serialize the tools for detailed inspection
          toolsSerialized = serializeToolList(toolsList);
        } else if (Array.isArray(tools)) {
          // List of tool dictionaries or objects
          toolsList = tools;
          toolsSerialized = serializeToolList(toolsList);
        }

        if (toolsList.length > 0) {
          operationAttrs.tools = toolsList;
          operationAttrs.toolsSerialized = toolsSerialized;
        }
      } catch (e) {
        rethrowIfCancelled(e);
        logger.warning(`Error serializing tools for tracing: ${errorMessage(e)}`);
        // Fallback to basic tool count
        if (toolsList.length > 0) {
          operationAttrs.tools = toolsList;
        }
      }
    }

    // Capture the effective system instruction: settings.systemInstruction
    // takes priority, else an initial system message from the context.
    const systemInstruction = _getSystemInstruction(self, self._context ?? null);
    if (systemInstruction) {
      // Truncate if very long
      operationAttrs["gen_ai.system_instructions"] = systemInstruction.slice(0, 500);
    }
  } else if (operation === "llm_tool_call" && args.length > 0) {
    // Extract tool call information
    const msg = args[0] as Service;
    const functionCalls = msg?.toolCall?.functionCalls as Service[] | undefined;
    if (msg && functionCalls && functionCalls.length > 0) {
      // Add information about the first function call
      const call = functionCalls[0];
      operationAttrs["tool.function_name"] = call.name;
      operationAttrs["tool.call_id"] = call.id;
      operationAttrs["tool.calls_count"] = functionCalls.length;

      // Add all function names being called
      const allFunctionNames = functionCalls.map((c) => c.name);
      operationAttrs["tool.all_function_names"] = allFunctionNames.join(",");

      // Add arguments for the first call (truncated if too long)
      try {
        let argsStr = call.args ? jsonDumps(call.args) : "{}";
        if (argsStr.length > 1000) {
          argsStr = `${argsStr.slice(0, 1000)}...`;
        }
        operationAttrs["tool.arguments"] = argsStr;
      } catch (e) {
        rethrowIfCancelled(e);
        operationAttrs["tool.arguments"] = String(call.args).slice(0, 1000);
      }
    }
  } else if (operation === "llm_tool_result" && args.length >= 3) {
    // _toolResult(toolCallId, toolCallName, result); its positional args, in
    // order. `result` is expected to be Gemini's FunctionResponse.response
    // payload (a dict), but is validated at runtime rather than assumed.
    const [toolCallId, toolCallName, result] = args;
    try {
      if (toolCallId) {
        operationAttrs["tool.call_id"] = toolCallId;
      }
      if (toolCallName) {
        operationAttrs["tool.function_name"] = toolCallName;
      }
      if (isDict(result)) {
        let resultStr = jsonDumps(result);
        if (resultStr.length > 2000) {
          // larger limit for results
          resultStr = `${resultStr.slice(0, 2000)}...`;
        }
        operationAttrs["tool.result"] = resultStr;
        if ("error" in result) {
          operationAttrs["tool.result_status"] = "error";
        } else if ("success" in result) {
          operationAttrs["tool.result_status"] = "success";
        } else {
          operationAttrs["tool.result_status"] = "completed";
        }
      }
    } catch (e) {
      rethrowIfCancelled(e);
      logger.warning(`Error capturing tool result attributes for tracing: ${errorMessage(e)}`);
    }
  } else if (operation === "llm_response" && args.length > 0) {
    // Extract usage and response metadata from turn complete event
    const msg = args[0] as Service;

    if (msg?.usageMetadata) {
      const usage = msg.usageMetadata;
      operationAttrs["gen_ai.usage.input_tokens"] =
        (usage.promptTokenCount || 0) + (usage.toolUsePromptTokenCount || 0);
      operationAttrs["gen_ai.usage.output_tokens"] =
        (usage.responseTokenCount || 0) + (usage.thoughtsTokenCount || 0);
      if (usage.cachedContentTokenCount !== null && usage.cachedContentTokenCount !== undefined) {
        operationAttrs["gen_ai.usage.cache_read.input_tokens"] = usage.cachedContentTokenCount;
      }
      if (usage.thoughtsTokenCount !== null && usage.thoughtsTokenCount !== undefined) {
        operationAttrs["gen_ai.usage.reasoning.output_tokens"] = usage.thoughtsTokenCount;
      }
      const inputAudioTokens = _geminiAudioModalityTokens(usage.promptTokensDetails);
      if (inputAudioTokens !== null && inputAudioTokens !== undefined) {
        operationAttrs["gen_ai.usage.audio.input_tokens"] = inputAudioTokens;
      }
      const outputAudioTokens = _geminiAudioModalityTokens(usage.responseTokensDetails);
      if (outputAudioTokens !== null && outputAudioTokens !== undefined) {
        operationAttrs["gen_ai.usage.audio.output_tokens"] = outputAudioTokens;
      }
      const cachedAudioTokens = _geminiAudioModalityTokens(usage.cacheTokensDetails);
      if (cachedAudioTokens !== null && cachedAudioTokens !== undefined) {
        operationAttrs["gen_ai.usage.audio.cache_read.input_tokens"] = cachedAudioTokens;
      }
    }

    // Get output text and modality from service state
    const text = self._botTextBuffer ?? "";
    const audioText = self._llmOutputBuffer ?? "";

    if (text) {
      // TEXT modality
      operationAttrs.output = text;
      operationAttrs.output_modality = "TEXT";
    } else if (audioText) {
      // AUDIO modality
      operationAttrs.output = audioText;
      operationAttrs.output_modality = "AUDIO";
    }

    // Add turn completion status
    if (msg?.serverContent?.turnComplete) {
      operationAttrs.turn_complete = true;
    }
  }

  return operationAttrs;
}

function makeGeminiLiveWrapper(operation: string, func: AnyFn): AnyFn {
  return async function wrapper(this: Service, ...args: unknown[]) {
    if (!this._tracingEnabled || !isTracingAvailable()) {
      return await func.apply(this, args);
    }
    let fnCalled = false;
    try {
      const serviceClassName = this.constructor.name;
      const spanName = `${operation}`;

      // Get the parent context - turn context if available, otherwise service context
      const parentContext = _getTurnContext(this) || _getParentServiceContext(this);

      // Create a new span as child of the turn span or service span
      return await withCurrentSpan(spanName, parentContext, async (currentSpan) => {
        try {
          // Base service attributes
          const modelName = _getModelName(this);
          const voiceId = this._voiceId ?? null;
          const languageCode = this._languageCode ?? null;
          const settings = this._settings ?? null;

          // Get modalities if available
          let modalities: string | null = null;
          if (settings && isObject(settings) && "modalities" in settings) {
            const modalityObj = settings.modalities as unknown;
            if (isObject(modalityObj) && "value" in modalityObj) {
              modalities = modalityObj.value as string;
            } else {
              modalities = String(modalityObj);
            }
          }

          // Operation-specific attribute collection
          const operationAttrs = geminiOperationAttributes(this, operation, args);

          // Add all attributes to the span
          addGeminiLiveSpanAttributes(currentSpan, {
            ...operationAttrs,
            serviceName: serviceClassName,
            model: modelName,
            operationName: operation,
            voiceId,
            language: languageCode,
            modalities,
            settings,
          });

          // Capture TTFB metric if available
          const ttfb: number | null | undefined = this._metrics?.ttfb;
          if (ttfb !== null && ttfb !== undefined) {
            currentSpan.setAttribute("metrics.ttfb", ttfb);
          }

          // Run the original function
          fnCalled = true;
          return await func.apply(this, args);
        } catch (e) {
          // Upstream's `except Exception` does not see CancelledError.
          if (!(e instanceof CancelledError)) {
            currentSpan.recordException?.(e);
            currentSpan.setStatus?.({ code: SPAN_STATUS_ERROR, message: errorMessage(e) });
          }
          throw e;
        }
      });
    } catch (e) {
      if (fnCalled || e instanceof CancelledError) {
        throw e;
      }
      logger.error(`Error in Gemini Live tracing (continuing without tracing): ${errorMessage(e)}`);
      return await func.apply(this, args);
    }
  };
}

/**
 * Trace Gemini Live service methods with operation-specific attributes.
 *
 * This decorator automatically captures relevant information based on the operation type:
 *
 * - llm_setup: Configuration, tools definitions, and system instructions
 * - llm_tool_call: Function call information
 * - llm_tool_result: Function execution results
 * - llm_response: Complete LLM response with usage and output
 *
 * @param operation The operation name (matches the event type being handled).
 * @returns A decorator that wraps the method with Gemini Live specific tracing.
 */
export function tracedGeminiLive(operation: string): TracedMethodDecorator {
  return makeMethodDecorator((func) => makeGeminiLiveWrapper(operation, func), null);
}

//
// OpenAI Realtime
//

/** Collect the operation-specific OpenAI Realtime attributes. */
function openaiRealtimeOperationAttributes(
  self: Service,
  operation: string,
  args: unknown[],
): Dict {
  const operationAttrs: Dict = {};

  if (operation === "llm_setup") {
    // Capture session properties and tools
    const sessionProperties = self._sessionProperties;
    if (sessionProperties) {
      try {
        // Convert to dict for easier processing
        let propsDict: Dict;
        if (typeof sessionProperties.modelDump === "function") {
          propsDict = sessionProperties.modelDump();
        } else if (isObject(sessionProperties)) {
          propsDict = { ...sessionProperties };
        } else {
          propsDict = {};
        }

        operationAttrs.sessionProperties = propsDict;

        // Extract tools if available
        const tools = propsDict.tools;
        if (Array.isArray(tools) ? tools.length > 0 : tools) {
          operationAttrs.tools = tools;
          try {
            operationAttrs.toolsSerialized = jsonDumps(tools);
          } catch (e) {
            rethrowIfCancelled(e);
            logger.warning(`Error serializing OpenAI tools: ${errorMessage(e)}`);
          }
        }

        // Extract instructions
        const instructions = propsDict.instructions;
        if (typeof instructions === "string" && instructions) {
          operationAttrs.instructions = instructions.slice(0, 500);
        }
      } catch (e) {
        rethrowIfCancelled(e);
        logger.warning(`Error processing session properties: ${errorMessage(e)}`);
      }
    }

    // Also check context for tools
    if (self._context) {
      try {
        const contextTools = self._context.tools;
        if (truthy(contextTools) && !operationAttrs.tools) {
          let tools: unknown = null;
          if (typeof self.getLlmAdapter === "function") {
            const adapter = self.getLlmAdapter();
            tools = adapter.fromStandardTools(contextTools);
          }

          if (tools !== null && tools !== undefined && tools !== NOT_GIVEN) {
            operationAttrs.tools = tools;
            try {
              operationAttrs.toolsSerialized = jsonDumps(tools);
            } catch (e) {
              rethrowIfCancelled(e);
              logger.warning(`Error serializing OpenAI Realtime tools: ${errorMessage(e)}`);
            }
          }
        }
      } catch (e) {
        rethrowIfCancelled(e);
        logger.warning(`Error extracting context tools: ${errorMessage(e)}`);
      }
    }
  } else if (operation === "llm_request") {
    // Capture context messages being sent
    if (self._context) {
      try {
        const messages = self.getLlmAdapter().getMessagesForLogging(self._context);
        if (messages && messages.length > 0) {
          operationAttrs.contextMessages = jsonDumps(messages);
        }
      } catch (e) {
        rethrowIfCancelled(e);
        logger.warning(`Error getting context messages: ${errorMessage(e)}`);
      }
    }
  } else if (operation === "llm_response" && args.length > 0) {
    // Extract usage and response metadata
    const evt = args[0] as Service;
    if (isObject(evt) && "response" in evt) {
      const response = evt.response as Service;

      // Token usage, including the audio/cached breakdown needed for cost
      // attribution (realtime audio tokens are priced separately from text
      // and cached-audio tokens).
      if (isObject(response) && "usage" in response) {
        const usage = response.usage as Service;
        if (isObject(usage) && "input_tokens" in usage) {
          operationAttrs["gen_ai.usage.input_tokens"] = usage.input_tokens;
        }
        if (isObject(usage) && "output_tokens" in usage) {
          operationAttrs["gen_ai.usage.output_tokens"] = usage.output_tokens;
        }
        const inputDetails = usage?.input_token_details;
        if (inputDetails) {
          if (inputDetails.cached_tokens !== null && inputDetails.cached_tokens !== undefined) {
            operationAttrs["gen_ai.usage.cache_read.input_tokens"] = inputDetails.cached_tokens;
          }
          if (inputDetails.audio_tokens !== null && inputDetails.audio_tokens !== undefined) {
            operationAttrs["gen_ai.usage.audio.input_tokens"] = inputDetails.audio_tokens;
          }
          const cachedDetails = inputDetails.cached_tokens_details;
          if (
            cachedDetails &&
            cachedDetails.audio_tokens !== null &&
            cachedDetails.audio_tokens !== undefined
          ) {
            operationAttrs["gen_ai.usage.audio.cache_read.input_tokens"] =
              cachedDetails.audio_tokens;
          }
        }
        const outputDetails = usage?.output_token_details;
        if (
          outputDetails &&
          outputDetails.audio_tokens !== null &&
          outputDetails.audio_tokens !== undefined
        ) {
          operationAttrs["gen_ai.usage.audio.output_tokens"] = outputDetails.audio_tokens;
        }
      }

      // Response status and metadata
      if (isObject(response) && "status" in response) {
        operationAttrs["response.status"] = response.status;
      }

      if (isObject(response) && "id" in response) {
        operationAttrs["response.id"] = response.id;
      }

      // Output items and extract transcript for output field
      const output = response?.output as Service[] | undefined;
      if (output && output.length > 0) {
        operationAttrs["response.output_items"] = output.length;

        // Extract assistant transcript and function calls
        let assistantTranscript = "";
        const functionCalls: Dict[] = [];

        for (const item of output) {
          if (item?.content && item.content.length > 0 && item.role === "assistant") {
            for (const content of item.content) {
              if (content?.transcript) {
                assistantTranscript += `${content.transcript} `;
              }
            }
          } else if (item?.type === "function_call") {
            const functionCallInfo: Dict = {
              name: item.name ?? "unknown",
              call_id: item.call_id ?? "unknown",
            };
            if (isObject(item) && "arguments" in item) {
              let argsStr = String(item.arguments);
              if (argsStr.length > 500) {
                argsStr = `${argsStr.slice(0, 500)}...`;
              }
              functionCallInfo.arguments = argsStr;
            }
            functionCalls.push(functionCallInfo);
          }
        }

        if (assistantTranscript.trim()) {
          operationAttrs.output = assistantTranscript.trim();
        }

        if (functionCalls.length > 0) {
          operationAttrs.functionCalls = functionCalls;
          operationAttrs["function_calls.count"] = functionCalls.length;
          const allNames = functionCalls.map((call) => call.name);
          operationAttrs["function_calls.all_names"] = allNames.join(",");
        }
      }
    }
  }

  return operationAttrs;
}

function makeOpenaiRealtimeWrapper(operation: string, func: AnyFn): AnyFn {
  return async function wrapper(this: Service, ...args: unknown[]) {
    if (!this._tracingEnabled || !isTracingAvailable()) {
      return await func.apply(this, args);
    }
    let fnCalled = false;
    try {
      const serviceClassName = this.constructor.name;
      const spanName = `${operation}`;

      // Get the parent context - turn context if available, otherwise service context
      const parentContext = _getTurnContext(this) || _getParentServiceContext(this);

      // Create a new span as child of the turn span or service span
      return await withCurrentSpan(spanName, parentContext, async (currentSpan) => {
        try {
          // Base service attributes
          const modelName = _getModelName(this);

          // Operation-specific attribute collection
          const operationAttrs = openaiRealtimeOperationAttributes(this, operation, args);

          // Add all attributes to the span
          addOpenaiRealtimeSpanAttributes(currentSpan, {
            ...operationAttrs,
            serviceName: serviceClassName,
            model: modelName,
            operationName: operation,
          });

          // Capture TTFB metric if available
          if (operation === "llm_response") {
            const ttfb: number | null | undefined = this._metrics?.ttfb;
            if (ttfb !== null && ttfb !== undefined) {
              currentSpan.setAttribute("metrics.ttfb", ttfb);
            }
          }

          // Run the original function
          fnCalled = true;
          return await func.apply(this, args);
        } catch (e) {
          // Upstream's `except Exception` does not see CancelledError.
          if (!(e instanceof CancelledError)) {
            currentSpan.recordException?.(e);
            currentSpan.setStatus?.({ code: SPAN_STATUS_ERROR, message: errorMessage(e) });
          }
          throw e;
        }
      });
    } catch (e) {
      if (fnCalled || e instanceof CancelledError) {
        throw e;
      }
      logger.error(
        `Error in OpenAI Realtime tracing (continuing without tracing): ${errorMessage(e)}`,
      );
      return await func.apply(this, args);
    }
  };
}

/**
 * Trace OpenAI Realtime service methods with operation-specific attributes.
 *
 * This decorator automatically captures relevant information based on the operation type:
 *
 * - llm_setup: Session configuration and tools
 * - llm_request: Context and input messages
 * - llm_response: Usage metadata, output, and function calls
 *
 * @param operation The operation name (matches the event type being handled).
 * @returns A decorator that wraps the method with OpenAI Realtime specific tracing.
 */
export function tracedOpenaiRealtime(operation: string): TracedMethodDecorator {
  return makeMethodDecorator((func) => makeOpenaiRealtimeWrapper(operation, func), null);
}
