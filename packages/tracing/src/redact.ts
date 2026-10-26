// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Content redaction for pipedog's spans.
 *
 * Pipecat's spans carry what people said and what the model answered (`transcript`, `text`,
 * `input`, `output`, `gen_ai.system_instructions`, tool definitions and arguments...). That is
 * handy while developing and a liability with sensitive data. In redacted mode a span keeps its
 * name, timings, parent, numbers and booleans, but a string attribute is only kept if its key is
 * allowed (by default, the non-content keys pipedog itself writes: model, provider, voice,
 * language, conversation and turn ids). Event attributes are dropped except `exception.type`, an
 * exception keeps its type but not its message or stack, and a status keeps its code but not its
 * message.
 *
 * The redaction happens as the span is written, on the SDK's own span object, so it works with
 * any tracer provider and exporter: nothing redacted ever reaches a span processor.
 */

import type * as api from "@opentelemetry/api";

/**
 * String attribute keys pipedog's spans write that carry no content: what model, provider, voice
 * and language were used, and the conversation and turn they belong to.
 */
export const DEFAULT_REDACTION_ALLOWED_ATTRIBUTES: ReadonlySet<string> = new Set([
  "gen_ai.operation.name",
  "gen_ai.provider.name",
  "gen_ai.system",
  "gen_ai.request.model",
  "gen_ai.response.model",
  "gen_ai.output.type",
  "gen_ai.conversation.id",
  "conversation.id",
  "conversation.type",
  "turn.type",
  "service.operation",
  "language",
  "voice_id",
  "modalities",
  "tools.names",
  "function_calls.first_name",
  "settings.model",
  "settings.voice",
  "settings.voice_id",
  "settings.language",
]);

export interface RedactContentOptions {
  /**
   * String attribute keys to keep, replacing `DEFAULT_REDACTION_ALLOWED_ATTRIBUTES`. Numbers and
   * booleans are kept on any key.
   */
  allowedAttributes?: Iterable<string>;
  /** String attribute keys to keep in addition to the allowed ones (e.g. your own span attributes). */
  extraAllowedAttributes?: Iterable<string>;
  /**
   * Decide yourself which attributes are kept. Replaces both lists and the number/boolean rule;
   * `undefined` values are never kept.
   */
  isAllowed?: (key: string, value: api.AttributeValue) => boolean;
}

/** Return the predicate the options describe. */
export function redactionPredicate(
  options: RedactContentOptions = {},
): (key: string, value: api.AttributeValue | undefined) => boolean {
  const custom = options.isAllowed;
  if (custom) return (key, value) => value !== undefined && custom(key, value);
  const allowed = new Set(options.allowedAttributes ?? DEFAULT_REDACTION_ALLOWED_ATTRIBUTES);
  for (const key of options.extraAllowedAttributes ?? []) allowed.add(key);
  return (key, value) => {
    if (value === undefined || value === null) return false;
    if (typeof value === "number" || typeof value === "boolean") return true;
    if (Array.isArray(value)) {
      const nonContent = value.every(
        (item) => item === null || item === undefined || typeof item !== "string",
      );
      if (nonContent) return true;
    }
    return allowed.has(key);
  };
}

type Predicate = ReturnType<typeof redactionPredicate>;

function keep(attributes: api.Attributes | undefined, isAllowed: Predicate): api.Attributes {
  const out: api.Attributes = {};
  for (const [key, value] of Object.entries(attributes ?? {})) {
    if (isAllowed(key, value)) out[key] = value;
  }
  return out;
}

const REDACTED = Symbol.for("pipedog.tracing.redacted");

function exceptionType(exception: api.Exception): string {
  if (typeof exception === "string") return "Error";
  const e = exception as { name?: unknown; constructor?: { name?: unknown } };
  if (typeof e.name === "string" && e.name) return e.name;
  if (typeof e.constructor?.name === "string" && e.constructor.name !== "Object") {
    return e.constructor.name;
  }
  return "Error";
}

/**
 * Make `span` drop content as it is written, in place (the span stays the SDK's own object, so
 * contexts and processors see a real span), and return it.
 */
export function redactSpan<S extends api.Span>(span: S, options: RedactContentOptions = {}): S {
  return redactSpanWith(span, redactionPredicate(options));
}

function redactSpanWith<S extends api.Span>(span: S, isAllowed: Predicate): S {
  const marked = span as S & { [REDACTED]?: true };
  if (marked[REDACTED]) return span;
  marked[REDACTED] = true;

  const setAttribute = span.setAttribute.bind(span);
  const setAttributes = span.setAttributes.bind(span);
  const addEvent = span.addEvent.bind(span);
  const setStatus = span.setStatus.bind(span);
  const addLink = span.addLink?.bind(span);
  const addLinks = span.addLinks?.bind(span);

  span.setAttribute = (key, value) => (isAllowed(key, value) ? setAttribute(key, value) : span);
  span.setAttributes = (attributes) => setAttributes(keep(attributes, isAllowed));
  span.addEvent = (name, attributesOrTime, time) => {
    const attributes =
      attributesOrTime &&
      typeof attributesOrTime === "object" &&
      !Array.isArray(attributesOrTime) &&
      !(attributesOrTime instanceof Date)
        ? (attributesOrTime as api.Attributes)
        : undefined;
    const startTime = attributes === undefined ? (attributesOrTime as api.TimeInput) : time;
    const type = attributes?.["exception.type"];
    return addEvent(name, type === undefined ? undefined : { "exception.type": type }, startTime);
  };
  span.recordException = (exception, time) => {
    addEvent("exception", { "exception.type": exceptionType(exception) }, time);
  };
  span.setStatus = (status) => setStatus({ code: status.code });
  if (addLink) span.addLink = (link) => addLink({ context: link.context });
  if (addLinks) span.addLinks = (links) => addLinks(links.map((l) => ({ context: l.context })));
  return span;
}

function redactSpanOptions(
  options: api.SpanOptions | undefined,
  isAllowed: Predicate,
): api.SpanOptions | undefined {
  if (!options) return options;
  return {
    ...options,
    attributes: options.attributes && keep(options.attributes, isAllowed),
    links: options.links?.map((link) => ({ context: link.context })),
  };
}

/** Wrap `tracer` so every span it starts is redacted (see `redactSpan`). */
export function redactTracer(tracer: api.Tracer, options: RedactContentOptions = {}): api.Tracer {
  return redactTracerWith(tracer, redactionPredicate(options));
}

function redactTracerWith(tracer: api.Tracer, isAllowed: Predicate): api.Tracer {
  const startActiveSpan = (name: string, ...args: unknown[]): unknown => {
    const fn = args.pop() as (span: api.Span) => unknown;
    const [options, context] = args as [api.SpanOptions | undefined, api.Context | undefined];
    const wrapped = (span: api.Span) => fn(redactSpanWith(span, isAllowed));
    const redactedOptions = redactSpanOptions(options, isAllowed) ?? {};
    return context === undefined
      ? tracer.startActiveSpan(name, redactedOptions, wrapped)
      : tracer.startActiveSpan(name, redactedOptions, context, wrapped);
  };
  return {
    startSpan: (name, options, context) =>
      redactSpanWith(
        tracer.startSpan(name, redactSpanOptions(options, isAllowed), context),
        isAllowed,
      ),
    startActiveSpan: startActiveSpan as api.Tracer["startActiveSpan"],
  };
}

/** Wrap a tracer provider so every tracer it hands out redacts its spans. */
export function redactTracerProvider(
  provider: api.TracerProvider,
  options: RedactContentOptions = {},
): api.TracerProvider {
  const isAllowed = redactionPredicate(options);
  return {
    getTracer: (name, version, tracerOptions) =>
      redactTracerWith(provider.getTracer(name, version, tracerOptions), isAllowed),
  };
}

/**
 * The OpenTelemetry API module with `trace.getTracer` returning redacting tracers; everything
 * else is the original API (the global provider, context, propagation). Hand it to
 * `registerOpenTelemetry({ api: redactedApi(api) })` so pipedog's spans are redacted, whatever
 * provider the app registered.
 */
export function redactedApi(otel: typeof api, options: RedactContentOptions = {}): typeof api {
  const isAllowed = redactionPredicate(options);
  const trace = new Proxy(otel.trace, {
    get(target, prop) {
      if (prop === "getTracer") {
        return (name: string, version?: string) =>
          redactTracerWith(target.getTracer(name, version), isAllowed);
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { ...otel, trace };
}
