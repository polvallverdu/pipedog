// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/services/rime/tts_v1.py

/**
 * Rime WebSocket v1 text-to-speech service implementation.
 *
 * Porting notes:
 * - Upstream imports the protobuf messages from the `rime-api` Python package.
 *   This port uses Rime's own JavaScript package, `@rimelabs/api` (the same
 *   schema, generated for `@bufbuild/protobuf`), which is pure JavaScript and
 *   runs on Bun, Node, Deno and Workers. `proto3` JSON is read and written with
 *   `@bufbuild/protobuf`'s JSON codec (`ignoreUnknownFields` on reads, as
 *   upstream's `json_format.Parse(..., ignore_unknown_fields=True)`).
 * - Rime's protocol: https://docs.rime.ai/api-reference/coda/websocket-v1
 *   (subprotocols `rime.v1.binary` and `rime.v1.json`, a `ready` event before
 *   the first `start`, and the `start`, `text`, `end` and `cancel` requests).
 * - The negotiated subprotocol is read from the underlying `WebSocket.protocol`.
 */

import { create, fromBinary, fromJsonString, toBinary, toJsonString } from "@bufbuild/protobuf";
import { rethrowIfCancelled, type Task, waitFor } from "@pipedog/asyncio";
import {
  ErrorFrame,
  type Frame,
  TTSAudioRawFrame,
  TTSStoppedFrame,
} from "@pipedog/core/frames/frames";
import type { FrameProcessorSetup } from "@pipedog/core/processors/frame_processor";
import { TTSSettings, type TTSSettingsOptions } from "@pipedog/core/services/settings";
import {
  TextAggregationMode,
  WebsocketTTSService,
  type WebsocketTTSServiceOptions,
} from "@pipedog/core/services/tts_service";
import { State, type WebsocketClientConnection } from "@pipedog/core/services/websocket_service";
import { Language, resolveLanguage } from "@pipedog/core/transcriptions/language";
import { ErrorCategory } from "@pipedog/core/utils/errors";
import { logger } from "@pipedog/core/utils/logger";
import { SkipTagsAggregator } from "@pipedog/core/utils/text/skip_tags_aggregator";
import { installTracedTts } from "@pipedog/core/utils/tracing/service_decorators";
import { assertGiven, NOT_GIVEN, type NotGiven } from "@pipedog/core/utils/types";
import {
  AudioParametersSchema,
  CodaParametersSchema,
  MistParametersSchema,
  SplitStrategy,
  SynthesisRequestSchema,
  type WebSocketError,
  type WebSocketRequest as WebSocketRequestMessage,
  WebSocketRequestSchema,
  type WebSocketResponse as WebSocketResponseMessage,
  WebSocketResponseSchema,
} from "@rimelabs/api";

function errorMessageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export type WebSocketProtocol = "binary" | "json";

const _MODEL_WEBSOCKET_URLS: Record<string, string> = {
  coda: "wss://coda.api.rime.ai/ws",
  mistv3: "wss://mist.api.rime.ai/ws",
};
const _PROTOCOL_VERSION = 1;
const _READY_TIMEOUT_S = 10.0;
const _SUBPROTOCOLS: Record<WebSocketProtocol, string> = {
  binary: "rime.v1.binary",
  json: "rime.v1.json",
};
const _ERROR_CATEGORIES: Record<string, ErrorCategory> = {
  invalid_input: ErrorCategory.INVALID_REQUEST,
  unauthenticated: ErrorCategory.AUTHENTICATION,
  permission_denied: ErrorCategory.AUTHORIZATION,
  not_found: ErrorCategory.INVALID_REQUEST,
  resource_exhausted: ErrorCategory.RATE_LIMIT,
  timeout: ErrorCategory.CONNECTIVITY,
  unavailable: ErrorCategory.CONNECTIVITY,
  unimplemented: ErrorCategory.SERVER,
  internal: ErrorCategory.SERVER,
};

const LANGUAGE_MAP: Partial<Record<Language, string>> = {
  [Language.AR]: "ar",
  [Language.DE]: "de",
  [Language.EN]: "en",
  [Language.ES]: "es",
  [Language.FR]: "fr",
  [Language.HI]: "hi",
  [Language.IT]: "it",
  [Language.JA]: "ja",
  [Language.PT]: "pt",
};

/**
 * Convert a Language to the BCP-47 tag Rime WebSocket v1 expects.
 *
 * @param language The Language value.
 * @returns The base BCP-47 tag (e.g., 'en' for English). A region-qualified
 *   language falls back to its base tag.
 */
export function languageToRimeV1Language(language: Language): string {
  return resolveLanguage(language, LANGUAGE_MAP);
}

function _errorMessage(error: WebSocketError): string {
  let message = `Rime error (${error.kind}): ${error.message}`;
  if (error.requestId !== undefined) {
    message += ` (request ID: ${error.requestId})`;
  }
  return message;
}

/** Connection-level error reported by Rime. */
export class _RimeV1Error extends Error {
  readonly kind: string;

  constructor(error: WebSocketError) {
    super(_errorMessage(error));
    this.kind = error.kind;
  }
}

export interface RimeV1TTSSettingsOptions extends TTSSettingsOptions {
  /**
   * Audio playback speed factor. Values above 1.0 slow down the audio; values
   * below 1.0 speed it up. Not supported by mistv2.
   */
  timeScaleFactor?: number | null | NotGiven;
  /** Number of input tokens to collect before audio starts (Coda only). */
  textLookaheadTokens?: number | null | NotGiven;
  /** Whether to add pauses between bracketed content (Mist only). */
  pauseBetweenBrackets?: boolean | null | NotGiven;
  /** Whether to phonemize bracketed content (Mist only). */
  phonemizeBetweenBrackets?: boolean | null | NotGiven;
  /** Whether to save out-of-vocabulary words (Mist only). */
  saveOovs?: boolean | null | NotGiven;
}

/**
 * Settings for RimeV1TTSService.
 *
 * Each context uses the settings in effect when it starts.
 *
 * - `model`: required at construction. `"coda"` and `"mistv3"` select their
 *   public endpoints unless `websocketUrl` is provided.
 * - `timeScaleFactor`: audio playback speed factor. Values above 1.0 slow down
 *   the audio; values below 1.0 speed it up. Not supported by mistv2.
 * - `textLookaheadTokens`: number of input tokens to collect before audio
 *   starts (Coda only).
 * - `pauseBetweenBrackets`: whether to add pauses between bracketed content
 *   (Mist only).
 * - `phonemizeBetweenBrackets`: whether to phonemize bracketed content (Mist
 *   only).
 * - `saveOovs`: whether to save out-of-vocabulary words (Mist only).
 */
export class RimeV1TTSSettings extends TTSSettings {
  timeScaleFactor: number | null | NotGiven = NOT_GIVEN;
  textLookaheadTokens: number | null | NotGiven = NOT_GIVEN;
  pauseBetweenBrackets: boolean | null | NotGiven = NOT_GIVEN;
  phonemizeBetweenBrackets: boolean | null | NotGiven = NOT_GIVEN;
  saveOovs: boolean | null | NotGiven = NOT_GIVEN;

  static override _aliases: Record<string, string> = { speaker: "voice" };

  constructor(options: RimeV1TTSSettingsOptions = {}) {
    super(options);
    this._assignOptions(options);
  }
}

export interface RimeV1TTSServiceOptions extends WebsocketTTSServiceOptions {
  /** Rime API key for authentication. */
  apiKey: string;
  /**
   * Rime WebSocket v1 endpoint override. Defaults to the public endpoint for
   * `settings.model`. Custom URLs can use any path. Models without a public
   * default require an explicit URL.
   */
  websocketUrl?: string | null;
  /** Envelope encoding, "binary" or "json". */
  websocketProtocol?: WebSocketProtocol;
  /**
   * Settings with an explicit `model`. Other fields can be updated at runtime;
   * changing `model` does not switch endpoints.
   */
  settings?: RimeV1TTSSettings | null;
}

/** Hostname of an absolute `ws` or `wss` URL, or null (Python's `urlsplit`). */
function _wsHostname(url: string): string | null {
  const m = /^(wss?):\/\/([^/?#]*)/i.exec(url);
  if (!m) return null;
  let host = m[2]!;
  const at = host.lastIndexOf("@");
  if (at >= 0) host = host.slice(at + 1);
  host = host.replace(/^\[(.*)\](:\d*)?$/, "$1").replace(/:\d*$/, "");
  return host === "" ? null : host;
}

/**
 * Text-to-Speech service using Rime's WebSocket v1 API.
 *
 * Sends protobuf envelopes, in binary or proto3 JSON encoding, over one
 * connection that carries a synthesis context per Pipecat turn. Interruptions
 * cancel the turn's context without reconnecting. Text is sent as whole
 * sentences by default; with `TextAggregationMode.TOKEN`, LLM tokens are sent
 * as they arrive and Rime accumulates them into sentences. `settings.model` is
 * required and selects the public endpoint at construction: `"coda"` uses
 * `wss://coda.api.rime.ai/ws` and `"mistv3"` uses `wss://mist.api.rime.ai/ws`.
 * Pass `websocketUrl` to use a custom deployment. The model is not inferred
 * from the URL hostname or path. A context leaves out, with a warning, any
 * setting its model does not accept. WebSocket v1 does not report word
 * timestamps.
 */
export class RimeV1TTSService extends WebsocketTTSService {
  static Settings: typeof RimeV1TTSSettings = RimeV1TTSSettings;
  declare protected _settings: RimeV1TTSSettings;

  static {
    installTracedTts(RimeV1TTSService.prototype, "runTts");
  }

  protected _apiKey: string;
  protected _websocketUrl: string;
  protected _websocketProtocol: WebSocketProtocol;
  protected _endpointModel: string;
  protected _receiveTask: Task<unknown> | null;
  // Contexts open on the current connection, from their start until done,
  // error or cancel. Audio for any other context is stale and dropped.
  protected _contexts: Set<string>;
  // Contexts Rime closed with an error; the rest of their turn is skipped.
  protected _failedContexts: Set<string>;

  /**
   * Initialize the Rime WebSocket v1 TTS service.
   *
   * @param options.apiKey Rime API key for authentication.
   * @param options.websocketUrl Rime WebSocket v1 endpoint override.
   * @param options.websocketProtocol Envelope encoding, "binary" or "json".
   * @param options.sampleRate Audio sample rate in Hz.
   * @param options.textAggregationMode How to aggregate text before synthesis.
   *   Defaults to `TextAggregationMode.SENTENCE`. `TextAggregationMode.TOKEN`
   *   streams LLM tokens and has Rime accumulate them into sentences.
   * @param options.settings Settings with an explicit `model`. Other options
   *   are passed to the parent class.
   */
  constructor(options: RimeV1TTSServiceOptions) {
    const websocketProtocol = options.websocketProtocol ?? "binary";
    if (!(websocketProtocol in _SUBPROTOCOLS)) {
      throw new Error('websocketProtocol must be "binary" or "json"');
    }

    const defaultSettings = new (new.target as typeof RimeV1TTSService).Settings({
      model: null,
      voice: null,
      language: null,
      timeScaleFactor: null,
      textLookaheadTokens: null,
      pauseBetweenBrackets: null,
      phonemizeBetweenBrackets: null,
      saveOovs: null,
    });
    if (options.settings !== undefined && options.settings !== null) {
      defaultSettings.applyUpdate(options.settings);
    }

    const model = assertGiven(defaultSettings.model);
    if (!model) {
      throw new Error("Rime WebSocket v1 requires settings.model");
    }
    let websocketUrl = options.websocketUrl ?? null;
    if (websocketUrl === null) {
      websocketUrl = _MODEL_WEBSOCKET_URLS[model] ?? null;
      if (websocketUrl === null) {
        throw new Error("websocketUrl is required for models other than coda and mistv3");
      }
    }
    if (_wsHostname(websocketUrl) === null) {
      throw new Error("Rime WebSocket v1 websocketUrl must be an absolute ws or wss URL");
    }

    super({
      ...options,
      pushTextFrames: false,
      pushStartFrame: true,
      pauseFrameProcessing: true,
      appendTrailingSpace: true,
      sampleRate: options.sampleRate ?? null,
      settings: defaultSettings,
    });

    // Keep spelled-out text in one aggregate so a split never breaks a tag.
    this._textAggregator = new SkipTagsAggregator({
      tags: [["spell(", ")"]],
      aggregationType: this._textAggregationMode,
    });

    this._apiKey = options.apiKey;
    this._websocketUrl = websocketUrl;
    this._websocketProtocol = websocketProtocol;
    this._endpointModel = model;

    this._receiveTask = null;
    this._contexts = new Set();
    this._failedContexts = new Set();
  }

  /**
   * Check if this service can generate processing metrics.
   *
   * @returns True, as Rime service supports metrics generation.
   */
  override canGenerateMetrics(): boolean {
    return true;
  }

  /**
   * Convert a Language value to the BCP-47 tag Rime WebSocket v1 expects.
   *
   * @param language The language to convert.
   * @returns The BCP-47 language tag.
   */
  override languageToServiceLanguage(language: Language): string | null {
    return languageToRimeV1Language(language);
  }

  // A set of Rime-specific helpers for text transformations

  /** Wrap text in Rime spell function. */
  static SPELL(text: string): string {
    return `spell(${text})`;
  }

  /**
   * Convenience method to create a pause tag.
   *
   * DIVERGENCE: JS cannot tell `1.0` from `1`, so a whole number of
   * milliseconds is written `500` where Python writes `500.0`.
   */
  static PAUSE_TAG(seconds: number): string {
    return `<${seconds * 1000}>`;
  }

  protected _warnIgnored(name: string, model: string): void {
    logger.warning(`${this}: ${name} is not applied, ${model} does not accept it`);
  }

  /**
   * Build the start envelope that fixes a context's settings.
   *
   * Settings the endpoint's model does not accept are left out with a warning.
   */
  protected _buildStartRequest(contextId: string): WebSocketRequestMessage {
    const s = this._settings;
    const model = this._endpointModel;
    if (assertGiven(s.model) !== model) {
      logger.warning(`${this}: model ${s.model} is not applied, the endpoint serves ${model}`);
    }

    const audioParameters = create(AudioParametersSchema, {
      audioFormat: "audio/pcm",
      samplingRate: this.sampleRate,
    });
    const timeScaleFactor = assertGiven(s.timeScaleFactor);
    if (timeScaleFactor !== null) {
      if (model === "mistv2") {
        this._warnIgnored("timeScaleFactor", model);
      } else {
        audioParameters.timeScaleFactor = timeScaleFactor;
      }
    }

    const start = create(SynthesisRequestSchema, { text: "", audioParameters });
    if (this._isStreamingTokens) {
      start.splitStrategy = SplitStrategy.ACCUMULATE_SENTENCE;
    }
    const voice = assertGiven(s.voice);
    if (voice !== null) {
      start.speaker = voice;
    }
    // The stored language is always a BCP-47 tag; the field type also allows Language.
    const language = assertGiven(s.language);
    if (typeof language === "string") {
      start.language = language;
    }

    const textLookaheadTokens = assertGiven(s.textLookaheadTokens);
    if (textLookaheadTokens !== null) {
      if (model === "coda") {
        start.codaParameters = create(CodaParametersSchema, { textLookaheadTokens });
      } else {
        this._warnIgnored("textLookaheadTokens", model);
      }
    }

    const mistSettings: [string, boolean | null][] = [
      ["pauseBetweenBrackets", assertGiven(s.pauseBetweenBrackets)],
      ["phonemizeBetweenBrackets", assertGiven(s.phonemizeBetweenBrackets)],
      ["saveOovs", assertGiven(s.saveOovs)],
    ];
    for (const [name, value] of mistSettings) {
      if (value === null) {
        continue;
      }
      if (model.startsWith("mist")) {
        start.mistParameters ??= create(MistParametersSchema);
        (start.mistParameters as unknown as Record<string, unknown>)[name] = value;
      } else {
        this._warnIgnored(name, model);
      }
    }
    return create(WebSocketRequestSchema, {
      contextId,
      payload: { case: "start", value: start },
    });
  }

  protected _encode(request: WebSocketRequestMessage): string | Uint8Array {
    if (this._websocketProtocol === "binary") {
      return toBinary(WebSocketRequestSchema, request);
    }
    return toJsonString(WebSocketRequestSchema, request);
  }

  protected _decode(message: string | Uint8Array): WebSocketResponseMessage {
    if (this._websocketProtocol === "binary") {
      if (typeof message === "string") {
        throw new Error("Rime v1 sent a text frame on the binary protocol");
      }
      return fromBinary(WebSocketResponseSchema, message);
    }
    const text = typeof message === "string" ? message : new TextDecoder().decode(message);
    return fromJsonString(WebSocketResponseSchema, text, { ignoreUnknownFields: true });
  }

  protected async _send(request: WebSocketRequestMessage): Promise<void> {
    await this._getWebsocket().send(this._encode(request));
  }

  /**
   * Set up the service and connect.
   *
   * @param setup Configuration object containing setup parameters.
   */
  override async setup(setup: FrameProcessorSetup): Promise<void> {
    await super.setup(setup);
    await this._connect();
  }

  override async _connect(): Promise<void> {
    await super._connect();

    await this._connectWebsocket();

    if (this._websocket && !this._receiveTask) {
      this._receiveTask = this.createTask(() =>
        this._receiveTaskHandler((error, options) => this._reportError(error, options)),
      );
    }
  }

  override async _disconnect(): Promise<void> {
    await super._disconnect();

    if (this._receiveTask) {
      await this.cancelTask(this._receiveTask);
      this._receiveTask = null;
    }

    await this._disconnectWebsocket();
  }

  override async _connectWebsocket(): Promise<void> {
    let websocket: WebsocketClientConnection | null = null;
    try {
      if (this._websocket && this._websocket.state === State.OPEN) {
        return;
      }
      logger.debug("Connecting to Rime WebSocket v1");
      const subprotocol = _SUBPROTOCOLS[this._websocketProtocol];
      websocket = await this._websocketConnect(this._websocketUrl, {
        additionalHeaders: { Authorization: `Bearer ${this._apiKey}` },
        subprotocols: [subprotocol],
      });
      if (websocket.webSocket.protocol !== subprotocol) {
        throw new Error(`Rime v1 did not accept the ${subprotocol} subprotocol`);
      }

      // Rime sends `ready` once its engine can accept contexts.
      this._websocket = websocket;
      const connection = websocket;
      const ready = this._decode(await waitFor(() => connection.recv(), _READY_TIMEOUT_S));
      if (ready.payload.case === "error") {
        throw new _RimeV1Error(ready.payload.value);
      }
      if (ready.payload.case !== "ready" || ready.payload.value.protocol !== _PROTOCOL_VERSION) {
        throw new Error("Rime v1 did not send a supported ready event");
      }

      this._contexts.clear();
      this._failedContexts.clear();
      await this._callEventHandler("on_connected");
    } catch (e) {
      rethrowIfCancelled(e);
      const category = e instanceof _RimeV1Error ? (_ERROR_CATEGORIES[e.kind] ?? null) : null;
      await this.pushError(`Error connecting: ${errorMessageOf(e)}`, {
        exception: e,
        category,
      });
      if (websocket) {
        await websocket.close();
      }
      this._websocket = null;
      await this._callEventHandler("on_connection_error", errorMessageOf(e));
    }
  }

  override async _disconnectWebsocket(): Promise<void> {
    try {
      await this.stopAllMetrics();

      if (this._websocket) {
        logger.debug(`${this}: Disconnecting from Rime WebSocket v1`);
        await this._websocket.close();
      }
    } catch (e) {
      rethrowIfCancelled(e);
      await this.pushError(`Error disconnecting: ${errorMessageOf(e)}`, { exception: e });
    } finally {
      this._websocket = null;
      this._contexts.clear();
      this._failedContexts.clear();
      await this._callEventHandler("on_disconnected");
    }
  }

  protected _getWebsocket(): WebsocketClientConnection {
    if (this._websocket) {
      return this._websocket;
    }
    throw new Error("Websocket not connected");
  }

  /** Cancel the Rime context when the bot is interrupted. */
  override async onAudioContextInterrupted(contextId: string): Promise<void> {
    await this.stopAllMetrics();
    this._failedContexts.delete(contextId);
    if (this._contexts.has(contextId)) {
      this._contexts.delete(contextId);
      await this._send(
        create(WebSocketRequestSchema, { contextId, payload: { case: "cancel", value: {} } }),
      );
    }
    await super.onAudioContextInterrupted(contextId);
  }

  /** Close a failed context's audio once its turn has no more text. */
  override async onTurnContextCompleted(): Promise<void> {
    const contextId = this._turnContextId;
    await super.onTurnContextCompleted();
    if (contextId !== null && this._failedContexts.has(contextId)) {
      await this._closeFailedContext(contextId);
    }
  }

  protected async _closeFailedContext(contextId: string): Promise<void> {
    this._failedContexts.delete(contextId);
    if (this.audioContextAvailable(contextId)) {
      await this.appendToAudioContext(contextId, new TTSStoppedFrame({ contextId }));
      await this.removeAudioContext(contextId);
    }
  }

  /**
   * End the context's input so Rime synthesizes the rest of its text.
   *
   * @param contextId The specific context to flush. If null, falls back to the
   *   currently active context.
   */
  override async flushAudio(contextId: string | null = null): Promise<void> {
    const flushId = contextId || this.getActiveAudioContextId();
    if (!flushId || !this._websocket || !this._contexts.has(flushId)) {
      return;
    }
    logger.trace(`${this}: flushing audio`);
    await this._send(
      create(WebSocketRequestSchema, { contextId: flushId, payload: { case: "end", value: {} } }),
    );
  }

  override async _receiveMessages(): Promise<void> {
    for await (const message of this._getWebsocket()) {
      const response = this._decode(message);
      const payload = response.payload;
      const ctxId = response.contextId;

      if (payload.case === "error" && !ctxId) {
        await this.pushError(_errorMessage(payload.value), {
          category: _ERROR_CATEGORIES[payload.value.kind] ?? null,
        });
        continue;
      }
      if (!this._contexts.has(ctxId) || !this.audioContextAvailable(ctxId)) {
        continue;
      }

      if (payload.case === "audio") {
        if (payload.value.length > 0) {
          const frame = new TTSAudioRawFrame({
            audio: payload.value,
            sampleRate: this.sampleRate,
            numChannels: 1,
            contextId: ctxId,
          });
          await this.appendToAudioContext(ctxId, frame);
        }
      } else if (payload.case === "done") {
        this._contexts.delete(ctxId);
        await this.stopTtfbMetrics();
        await this.appendToAudioContext(ctxId, new TTSStoppedFrame({ contextId: ctxId }));
        await this.removeAudioContext(ctxId);
      } else if (payload.case === "error") {
        this._contexts.delete(ctxId);
        this._failedContexts.add(ctxId);
        await this.stopAllMetrics();
        // One failed context leaves the service usable for the next turn.
        const category = _ERROR_CATEGORIES[payload.value.kind] ?? ErrorCategory.UNKNOWN;
        await this.pushError(_errorMessage(payload.value), {
          category: category.isPermanent ? ErrorCategory.UNKNOWN : category,
        });
        // While the turn is still sending text, its later sentences reuse this
        // audio context; closing it now would make the base reopen an empty
        // one for them. onTurnContextCompleted closes it instead.
        if (ctxId !== this._turnContextId) {
          await this._closeFailedContext(ctxId);
        }
      }
    }
  }

  /**
   * Split prepared text into the text messages Rime v1 expects.
   *
   * Rime accumulates streamed tokens itself, so each token is one message.
   * Otherwise each message is one sentence.
   */
  protected async _textMessages(text: string): Promise<string[]> {
    if (this._isStreamingTokens) {
      return [text];
    }
    const aggregator = new SkipTagsAggregator({
      tags: [["spell(", ")"]],
      aggregationType: TextAggregationMode.SENTENCE,
    });
    const sentences: string[] = [];
    for await (const aggregate of aggregator.aggregate(text)) {
      sentences.push(this._prepareTextForTts(aggregate.text));
    }
    const remaining = await aggregator.flush();
    if (remaining?.text) {
      sentences.push(this._prepareTextForTts(remaining.text));
    }
    return sentences;
  }

  /**
   * Generate speech from text using Rime's WebSocket v1 API.
   *
   * @param text The text to synthesize into speech.
   * @param contextId The context ID for tracking audio frames.
   * @yields Audio frames containing the synthesized speech.
   */
  override async *runTts(text: string, contextId: string): AsyncGenerator<Frame | null, void> {
    if (this._failedContexts.has(contextId)) {
      return;
    }
    try {
      if (!this._websocket || this._websocket.state === State.CLOSED) {
        await this._connect();
      }

      try {
        if (!this._contexts.has(contextId)) {
          await this._send(this._buildStartRequest(contextId));
          this._contexts.add(contextId);
        }
        for (const sentence of await this._textMessages(text)) {
          await this._send(
            create(WebSocketRequestSchema, {
              contextId,
              payload: { case: "text", value: sentence },
            }),
          );
        }
        await this.startTtsUsageMetrics(text);
      } catch (e) {
        rethrowIfCancelled(e);
        yield new ErrorFrame({ error: `Unknown error occurred: ${errorMessageOf(e)}` });
        yield new TTSStoppedFrame({ contextId });
        await this._disconnect();
        await this._connect();
        return;
      }
      yield null;
    } catch (e) {
      rethrowIfCancelled(e);
      yield new ErrorFrame({ error: `Unknown error occurred: ${errorMessageOf(e)}` });
    }
  }
}
