// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/services/deepgram/stt.py

/**
 * Deepgram speech-to-text service implementation.
 *
 * Porting notes:
 * - Upstream talks to Deepgram through the `deepgram` Python SDK
 *   (`AsyncDeepgramClient.listen.v1.connect()`). Here a minimal client,
 *   `DeepgramClient`, speaks the same `/v1/listen` WebSocket protocol over the
 *   global `WebSocket` (through `websocketConnect()` from core), with the same
 *   surface the service uses: `listen.v1.connect()`, and on the connection
 *   `on()`, `startListening()`, `sendMedia()`, `sendFinalize()`,
 *   `sendKeepAlive()` and `sendCloseStream()`. Messages are the parsed JSON
 *   objects, not SDK models.
 * - The API key is sent as the `Authorization: Token <key>` header on the
 *   opening handshake, as the SDK does. The Bun, Node and Deno `WebSocket`
 *   support that, and on Cloudflare Workers `websocketConnect` opens the socket
 *   through `fetch` so the header is sent there too.
 * - The SDK raises `ApiError` with the HTTP status of a refused handshake. A
 *   standard `WebSocket` does not expose that status, so `DeepgramApiError`
 *   is only raised when the runtime's error carries one; otherwise a refused
 *   handshake is retried until the quick-failure tracker gives up.
 * - Deprecated APIs are not ported: `LiveOptions` and the `liveOptions`
 *   constructor option.
 */

import { Event, monotonic, rethrowIfCancelled, sleep, type Task } from "@pipedog/asyncio";
import {
  type CancelFrame,
  type EndFrame,
  type Frame,
  InterimTranscriptionFrame,
  TranscriptionFrame,
  VADUserStoppedSpeakingFrame,
} from "@pipedog/core/frames/frames";
import { FrameDirection, type FrameProcessorSetup } from "@pipedog/core/processors/frame_processor";
import { STTSettings, type STTSettingsOptions } from "@pipedog/core/services/settings";
import { DEEPGRAM_TTFS_P99 } from "@pipedog/core/services/stt_latency";
import { STTService, type STTServiceOptions } from "@pipedog/core/services/stt_service";
import {
  ConnectionClosedOK,
  type WebsocketClientConnection,
  type WebsocketConnectOptions,
  websocketConnect,
} from "@pipedog/core/services/websocket_service";
import { isLanguage, Language } from "@pipedog/core/transcriptions/language";
import { extractHttpStatusCode } from "@pipedog/core/utils/errors";
import { logger } from "@pipedog/core/utils/logger";
import { exponentialBackoffTime, QuickFailureTracker } from "@pipedog/core/utils/network";
import { pyJsonDumps, pyJsonLoads } from "@pipedog/core/utils/py_json";
import { timeNowIso8601 } from "@pipedog/core/utils/time";
import { installTracedStt } from "@pipedog/core/utils/tracing/service_decorators";
import { isGiven, NOT_GIVEN, type NotGiven } from "@pipedog/core/utils/types";

type Dict = Record<string, any>;

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Convert a snake_case key to camelCase (`smart_format` → `smartFormat`). */
function snakeToCamel(key: string): string {
  return key.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

/** Convert a camelCase field name to its snake_case wire name. */
function camelToSnake(key: string): string {
  return key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

/** Python's `str(value)` for a query value (`True` → `"true"` is handled by callers). */
function queryValue(value: unknown): string {
  return String(value);
}

/** Python's `repr()` of a scalar or list. */
function pyRepr(value: unknown): string {
  if (typeof value === "string") {
    const quote = value.includes("'") && !value.includes('"') ? '"' : "'";
    const escaped = value.replace(/\\/g, "\\\\").replace(quote === "'" ? /'/g : /"/g, `\\${quote}`);
    return `${quote}${escaped}${quote}`;
  }
  return pyStr(value);
}

/** Python's `str()` of a scalar or list (a list is written as its repr, `['a', 'b']`). */
function pyStr(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(pyRepr).join(", ")}]`;
  if (typeof value === "boolean") return value ? "True" : "False";
  if (value === null || value === undefined) return "None";
  return String(value);
}

/**
 * Python's built-in `ConnectionError`. JS has no such class, so it carries a
 * connection error code, which the default error classification reads as a
 * connectivity failure.
 */
class ConnectionError extends Error {
  override name = "ConnectionError";
  code = "ECONNABORTED";
}

//
// Minimal Deepgram client (stand-in for the `deepgram` SDK's listen v1 socket).
//

/** Raised when Deepgram refuses a connection with an HTTP status (the SDK's `ApiError`). */
export class DeepgramApiError extends Error {
  override name = "DeepgramApiError";
  /** The HTTP status code of the refused request, if known. */
  readonly statusCode: number | null;

  constructor(message: string, statusCode: number | null) {
    super(message);
    this.statusCode = statusCode;
  }
}

/** Deepgram endpoints (the SDK's `DeepgramClientEnvironment`). */
export interface DeepgramClientEnvironment {
  /** Base URL for REST calls, e.g. `"https://api.deepgram.com"`. */
  base: string;
  /** Base URL for streaming, e.g. `"wss://api.deepgram.com"`. */
  production: string;
  /** Base URL for the agent API. */
  agent: string;
}

/** Default Deepgram endpoints. */
export const DEEPGRAM_DEFAULT_ENVIRONMENT: DeepgramClientEnvironment = {
  base: "https://api.deepgram.com",
  production: "wss://api.deepgram.com",
  agent: "wss://agent.deepgram.com",
};

/** Query parameters for `listen.v1.connect()`: a value, or a list for repeated keys. */
export type ListenV1ConnectParams = Record<string, string | readonly unknown[]>;

type ListenV1EventType = "open" | "message" | "error" | "close";
type ListenV1Handler = (payload: any) => unknown;

/**
 * Event types emitted by a listen v1 connection (the SDK's `EventType`).
 */
export const EventType = {
  OPEN: "open",
  MESSAGE: "message",
  ERROR: "error",
  CLOSE: "close",
} as const;
export type EventType = (typeof EventType)[keyof typeof EventType];

/**
 * A live transcription connection to Deepgram's `/v1/listen` endpoint.
 *
 * Mirrors the SDK's `AsyncV1SocketClient`: register handlers with `on()`,
 * then `startListening()` reads messages until the connection closes,
 * emitting each parsed message as `"message"` and connection or decoding
 * failures as `"error"`.
 */
export class ListenV1Connection {
  readonly #ws: WebsocketClientConnection;
  readonly #handlers = new Map<ListenV1EventType, ListenV1Handler[]>();

  constructor(ws: WebsocketClientConnection) {
    this.#ws = ws;
  }

  /** The underlying websocket connection. */
  get websocket(): WebsocketClientConnection {
    return this.#ws;
  }

  /**
   * Register a handler for an event.
   *
   * @param event The event type.
   * @param handler Called with the event payload; may be async.
   */
  on(event: EventType, handler: ListenV1Handler): void {
    const handlers = this.#handlers.get(event) ?? [];
    handlers.push(handler);
    this.#handlers.set(event, handlers);
  }

  async #emit(event: ListenV1EventType, payload: unknown): Promise<void> {
    for (const handler of this.#handlers.get(event) ?? []) {
      await handler(payload);
    }
  }

  /**
   * Read messages until the connection closes.
   *
   * Websocket failures, undecodable messages and errors raised by
   * `"message"` handlers are emitted as `"error"` and end the loop, as the
   * SDK's `start_listening()` does.
   */
  async startListening(): Promise<void> {
    await this.#emit("open", null);
    try {
      while (true) {
        const raw = await this.#nextMessage();
        if (raw === null) break;
        const parsed = typeof raw === "string" ? pyJsonLoads(raw) : raw;
        await this.#emit("message", parsed);
      }
    } catch (e) {
      rethrowIfCancelled(e);
      await this.#emit("error", e);
    } finally {
      await this.#emit("close", null);
    }
  }

  /** The next message, or null once the connection closed normally. */
  async #nextMessage(): Promise<string | Uint8Array | null> {
    try {
      return await this.#ws.recv();
    } catch (e) {
      if (e instanceof ConnectionClosedOK) return null;
      throw e;
    }
  }

  /** Send raw audio bytes. */
  async sendMedia(audio: Uint8Array): Promise<void> {
    await this.#ws.send(audio);
  }

  /** Ask Deepgram to finalize the transcript of the audio sent so far. */
  async sendFinalize(): Promise<void> {
    await this.#ws.send(pyJsonDumps({ type: "Finalize" }));
  }

  /** Keep an idle connection from being closed by the server. */
  async sendKeepAlive(): Promise<void> {
    await this.#ws.send(pyJsonDumps({ type: "KeepAlive" }));
  }

  /** Tell Deepgram no more audio will be sent. */
  async sendCloseStream(): Promise<void> {
    await this.#ws.send(pyJsonDumps({ type: "CloseStream" }));
  }

  /** Close the websocket. */
  async close(): Promise<void> {
    await this.#ws.close();
  }
}

/** Options for `DeepgramClient`. */
export interface DeepgramClientOptions {
  /** Deepgram API key, sent as `Authorization: Token <key>`. */
  apiKey: string;
  /** Endpoints to use. Defaults to `DEEPGRAM_DEFAULT_ENVIRONMENT`. */
  environment?: DeepgramClientEnvironment | null;
  /** Creates the underlying `WebSocket`, to open it some other way. Not in upstream. */
  webSocketFactory?: WebsocketConnectOptions["webSocketFactory"];
}

/**
 * Minimal Deepgram client exposing `listen.v1.connect()` (the SDK's
 * `AsyncDeepgramClient`).
 */
export class DeepgramClient {
  readonly apiKey: string;
  readonly environment: DeepgramClientEnvironment;
  readonly webSocketFactory: WebsocketConnectOptions["webSocketFactory"];
  readonly listen: {
    v1: { connect: (params: ListenV1ConnectParams) => Promise<ListenV1Connection> };
  };

  constructor(options: DeepgramClientOptions) {
    this.apiKey = options.apiKey;
    this.environment = options.environment ?? DEEPGRAM_DEFAULT_ENVIRONMENT;
    this.webSocketFactory = options.webSocketFactory ?? null;
    this.listen = { v1: { connect: (params) => this.#listenV1Connect(params) } };
  }

  async #listenV1Connect(params: ListenV1ConnectParams): Promise<ListenV1Connection> {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (Array.isArray(value)) {
        for (const item of value) query.append(key, queryValue(item));
      } else {
        query.append(key, value as string);
      }
    }
    const url = `${this.environment.production}/v1/listen?${query.toString()}`;
    try {
      const ws = await websocketConnect(url, {
        additionalHeaders: { Authorization: `Token ${this.apiKey}` },
        webSocketFactory: this.webSocketFactory,
      });
      return new ListenV1Connection(ws);
    } catch (e) {
      rethrowIfCancelled(e);
      const statusCode = extractHttpStatusCode(e);
      if (statusCode !== null) {
        throw new DeepgramApiError(errorMessage(e), statusCode);
      }
      throw e;
    }
  }
}

//
// Settings
//

export interface DeepgramSTTSettingsOptions extends STTSettingsOptions {
  /** Enable named entity detection. */
  detectEntities?: boolean | NotGiven;
  /** Enable speaker diarization. */
  diarize?: boolean | NotGiven;
  /** Enable dictation mode (converts commands to punctuation). */
  dictation?: boolean | NotGiven;
  /** Endpointing sensitivity in ms, or `false` to disable. */
  endpointing?: any;
  /** Whether to emit interim transcriptions. */
  interimResults?: boolean | NotGiven;
  /** Keyterms to boost (str or list of str). */
  keyterm?: any;
  /** Keywords to boost (str or list of str). */
  keywords?: any;
  /** Convert spoken numbers to numerals. */
  numerals?: boolean | NotGiven;
  /** Filter profanity from transcripts. */
  profanityFilter?: boolean | null | NotGiven;
  /** Add punctuation to transcripts. */
  punctuate?: boolean | NotGiven;
  /** Redact sensitive information (str or list of redaction types). */
  redact?: any;
  /** Word replacement rules (str or list). */
  replace?: any;
  /** Search terms to highlight (str or list of str). */
  search?: any;
  /** Apply smart formatting to transcripts. */
  smartFormat?: boolean | NotGiven;
  /** Silence duration in ms before an utterance-end event. */
  utteranceEndMs?: number | null | NotGiven;
  /** Model version to transcribe with. */
  version?: string | null | NotGiven;
}

/**
 * Settings for DeepgramSTTService.
 *
 * `model` and `language` are inherited from `STTSettings` /
 * `ServiceSettings`. Additional Deepgram connection params may be passed in
 * through `extra` (also inherited).
 *
 * - `detectEntities`: enable named entity detection.
 * - `diarize`: enable speaker diarization.
 * - `dictation`: enable dictation mode (converts commands to punctuation).
 * - `endpointing`: endpointing sensitivity in ms, or `false` to disable.
 * - `interimResults`: whether to emit interim transcriptions.
 * - `keyterm`: keyterms to boost (str or list of str).
 * - `keywords`: keywords to boost (str or list of str).
 * - `numerals`: convert spoken numbers to numerals.
 * - `profanityFilter`: filter profanity from transcripts.
 * - `punctuate`: add punctuation to transcripts.
 * - `redact`: redact sensitive information (str or list of redaction types).
 * - `replace`: word replacement rules (str or list).
 * - `search`: search terms to highlight (str or list of str).
 * - `smartFormat`: apply smart formatting to transcripts.
 * - `utteranceEndMs`: silence duration in ms before an utterance-end event.
 * - `version`: model version to transcribe with, e.g. a dated standard-model
 *   version such as `"2021-03-17.0"` or a custom model's version id. `null`
 *   omits the parameter, leaving Deepgram on `"latest"`.
 */
export class DeepgramSTTSettings extends STTSettings {
  detectEntities: boolean | NotGiven = NOT_GIVEN;
  diarize: boolean | NotGiven = NOT_GIVEN;
  dictation: boolean | NotGiven = NOT_GIVEN;
  endpointing: any = NOT_GIVEN;
  interimResults: boolean | NotGiven = NOT_GIVEN;
  keyterm: any = NOT_GIVEN;
  keywords: any = NOT_GIVEN;
  numerals: boolean | NotGiven = NOT_GIVEN;
  profanityFilter: boolean | null | NotGiven = NOT_GIVEN;
  punctuate: boolean | NotGiven = NOT_GIVEN;
  redact: any = NOT_GIVEN;
  replace: any = NOT_GIVEN;
  search: any = NOT_GIVEN;
  smartFormat: boolean | NotGiven = NOT_GIVEN;
  utteranceEndMs: number | null | NotGiven = NOT_GIVEN;
  version: string | null | NotGiven = NOT_GIVEN;

  constructor(options: DeepgramSTTSettingsOptions = {}) {
    super(options);
    this._assignOptions(options);
  }

  /**
   * Sync values from extra dict to declared fields.
   *
   * If a key in extra matches a field name and the field is NOT_GIVEN,
   * promote the extra value to the field. This ensures `this._settings`
   * always reflects the "final truth" of values that will be used.
   *
   * Keys in extra that match declared fields are always removed from extra
   * to avoid confusion, even if the field was already set.
   *
   * A key matches its field in either spelling: the wire name
   * (`smart_format`) or the field name (`smartFormat`).
   */
  _syncExtraToFields(): void {
    if (Object.keys(this.extra).length === 0) {
      return;
    }

    const fieldNames = new Set(
      this._fieldNames().filter(
        (name) => name !== "model" && name !== "language" && !name.startsWith("_"),
      ),
    );

    const self = this as unknown as Record<string, unknown>;
    for (const key of Object.keys(this.extra)) {
      const fieldName = fieldNames.has(key)
        ? key
        : fieldNames.has(snakeToCamel(key))
          ? snakeToCamel(key)
          : null;
      if (fieldName !== null) {
        const currentValue = self[fieldName];
        if (!isGiven(currentValue)) {
          // Promote extra value to the field
          self[fieldName] = this.extra[key];
        }
        // Always remove from extra to avoid ambiguity
        delete this.extra[key];
      }
    }
  }

  /** Names of the declared Deepgram-specific fields (not `model`, `language` or `extra`). */
  _deepgramFieldNames(): string[] {
    return this._fieldNames().filter(
      (name) => name !== "model" && name !== "language" && !name.startsWith("_"),
    );
  }
}

/**
 * Derive paired WebSocket and HTTP URLs from a single base URL.
 *
 * The Deepgram client requires both a WebSocket URL (for streaming) and an
 * HTTP URL (for REST calls). This helper lets developers provide a single
 * `baseUrl` and consistently derives both, preserving the security level they
 * chose. Useful for air-gapped or private deployments where insecure schemes
 * (ws:// / http://) are acceptable.
 *
 * Accepted inputs:
 * - `wss://` or `https://` — secure (paired as wss + https)
 * - `ws://` or `http://` — insecure (paired as ws + http)
 * - Bare hostname (no scheme) — defaults to secure
 * - Unrecognized scheme — logs a warning, defaults to secure
 *
 * @param baseUrl Host with optional scheme, port, and path.
 * @returns A [wsUrl, httpUrl] tuple with consistent schemes.
 */
export function _deriveDeepgramUrls(baseUrl: string): [string, string] {
  const knownSchemes = ["wss://", "https://", "ws://", "http://"];
  let scheme: string;
  let host: string;
  const idx = baseUrl.indexOf("://");
  if (idx !== -1) {
    scheme = `${baseUrl.slice(0, idx)}://`;
    host = baseUrl.slice(idx + 3);
    if (!knownSchemes.includes(scheme)) {
      logger.warning(
        `Unrecognized scheme in base_url '${baseUrl}', defaulting to wss:// / https://`,
      );
    }
  } else {
    scheme = "";
    host = baseUrl;
  }

  const insecure = scheme === "ws://" || scheme === "http://";
  const wsUrl = `${insecure ? "ws" : "wss"}://${host}`;
  const httpUrl = `${insecure ? "http" : "https"}://${host}`;
  return [wsUrl, httpUrl];
}

export interface DeepgramSTTServiceOptions extends STTServiceOptions {
  /** Deepgram API key for authentication. */
  apiKey: string;
  /** Custom Deepgram API base URL. */
  baseUrl?: string;
  /** Audio encoding format. Defaults to "linear16". */
  encoding?: string;
  /** Number of audio channels. Defaults to 1. */
  channels?: number;
  /** Transcribe each audio channel independently. Defaults to false. */
  multichannel?: boolean;
  /** Callback URL for async transcription delivery. */
  callback?: string | null;
  /** HTTP method for the callback ("GET" or "POST"). */
  callbackMethod?: string | null;
  /** Custom billing tag. */
  tag?: any;
  /** Opt out of Deepgram model improvement program. */
  mipOptOut?: boolean | null;
  /** Additional Deepgram features to enable. */
  addons?: Record<string, unknown> | null;
  /** Runtime-updatable settings. */
  settings?: DeepgramSTTSettings | null;
  /**
   * Creates the underlying `WebSocket`, to open it some other way (through a
   * proxy, say). Defaults to `websocketConnect`'s, which sends the header on
   * every runtime, Cloudflare Workers included. Not in upstream.
   */
  webSocketFactory?: WebsocketConnectOptions["webSocketFactory"];
}

/**
 * Deepgram speech-to-text service.
 *
 * Provides real-time speech recognition using Deepgram's WebSocket API.
 * Supports configurable models, languages, and various audio processing
 * options.
 */
export class DeepgramSTTService extends STTService {
  static Settings: typeof DeepgramSTTSettings = DeepgramSTTSettings;
  declare protected _settings: DeepgramSTTSettings;

  static {
    installTracedStt(DeepgramSTTService.prototype, "_handleTranscription");
  }

  protected _addons: Record<string, unknown> | null;
  protected _encoding: string;
  protected _channels: number;
  protected _multichannel: boolean;
  protected _callback: string | null;
  protected _callbackMethod: string | null;
  protected _tag: any;
  protected _mipOptOut: boolean | null;
  protected _client: DeepgramClient;
  protected _connection: ListenV1Connection | null = null;
  protected _connectionTask: Task<unknown> | null = null;
  /**
   * Set once connecting has resolved, whether it connected or gave up, so
   * that setting the service up doesn't outlast the attempt it started.
   */
  protected _connectionSettled = new Event();
  /**
   * Rapid failure detection: if the connection keeps failing to stay up for
   * `QuickFailureTracker.minStableDuration` (e.g. an invalid API key rejected
   * at the WebSocket handshake) enough times in a row, stop retrying instead
   * of looping forever. Shared with WebsocketService.
   */
  protected _quickFailureTracker = new QuickFailureTracker();

  /**
   * Initialize the Deepgram STT service.
   *
   * @param options.apiKey Deepgram API key for authentication.
   * @param options.baseUrl Custom Deepgram API base URL.
   * @param options.encoding Audio encoding format. Defaults to "linear16".
   * @param options.channels Number of audio channels. Defaults to 1.
   * @param options.multichannel Transcribe each audio channel independently.
   *   Defaults to false.
   * @param options.sampleRate Audio sample rate in Hz. If null, uses the
   *   pipeline sample rate.
   * @param options.callback Callback URL for async transcription delivery.
   * @param options.callbackMethod HTTP method for the callback ("GET" or
   *   "POST").
   * @param options.tag Custom billing tag.
   * @param options.mipOptOut Opt out of Deepgram model improvement program.
   * @param options.addons Additional Deepgram features to enable.
   * @param options.settings Runtime-updatable settings.
   * @param options.ttfsP99Latency P99 latency from speech end to final
   *   transcript in seconds. Override for your deployment. See
   *   https://github.com/pipecat-ai/stt-benchmark
   *   Other options are passed to the parent STTService.
   */
  constructor(options: DeepgramSTTServiceOptions) {
    // 1. Initialize default_settings with hardcoded defaults
    const defaultSettings = new (new.target as typeof DeepgramSTTService).Settings({
      model: "nova-3-general",
      language: Language.EN,
      detectEntities: false,
      diarize: false,
      dictation: false,
      endpointing: null,
      interimResults: true,
      keyterm: null,
      keywords: null,
      numerals: false,
      profanityFilter: null,
      punctuate: true,
      redact: null,
      replace: null,
      search: null,
      smartFormat: false,
      utteranceEndMs: null,
      version: null,
    });

    // 2. Apply settings delta (canonical API, always wins)
    if (options.settings !== undefined && options.settings !== null) {
      // Sync the delta first: on a delta, an unset field is NOT_GIVEN, so a
      // matching extra key can still be promoted. On the merged store every
      // field already holds a default and the value would be dropped.
      const settings = options.settings.copy();
      settings._syncExtraToFields();
      defaultSettings.applyUpdate(settings);
    }

    // Sync extra to top-level fields so this._settings is unambiguous
    defaultSettings._syncExtraToFields();

    super({
      ...options,
      sampleRate: options.sampleRate ?? null,
      ttfsP99Latency:
        options.ttfsP99Latency === undefined ? DEEPGRAM_TTFS_P99 : options.ttfsP99Latency,
      settings: defaultSettings,
    });

    this._addons = options.addons ?? null;
    this._encoding = options.encoding ?? "linear16";
    this._channels = options.channels ?? 1;
    this._multichannel = options.multichannel ?? false;
    this._callback = options.callback ?? null;
    this._callbackMethod = options.callbackMethod ?? null;
    this._tag = options.tag ?? null;
    this._mipOptOut = options.mipOptOut ?? null;

    // Build client - support optional custom base URL
    const baseUrl = options.baseUrl ?? "";
    if (baseUrl) {
      const [wsUrl, httpUrl] = _deriveDeepgramUrls(baseUrl);
      this._client = new DeepgramClient({
        apiKey: options.apiKey,
        environment: { base: httpUrl, production: wsUrl, agent: wsUrl },
        webSocketFactory: options.webSocketFactory,
      });
    } else {
      this._client = new DeepgramClient({
        apiKey: options.apiKey,
        webSocketFactory: options.webSocketFactory,
      });
    }
  }

  /**
   * Check if this service can generate processing metrics.
   *
   * @returns True, as Deepgram service supports metrics generation.
   */
  override canGenerateMetrics(): boolean {
    return true;
  }

  /**
   * Disconnect and reconnect to Deepgram.
   *
   * Called by `STTService._reconnect()` inside the reconnecting guard.
   * `_connect()` returns once connecting has resolved, so a connection that
   * is still missing by then is one that isn't coming back: say so rather
   * than let the caller replay buffered audio into nothing.
   *
   * @throws ConnectionError if the service could not reconnect.
   */
  protected override async _doReconnect(): Promise<void> {
    await this._disconnect();
    await this._connect();
    if (!this._connection) {
      throw new ConnectionError(`${this} could not reconnect to Deepgram`);
    }
  }

  /** Apply a settings delta and reconnect if anything changed. */
  protected override async _updateSettings(delta: STTSettings): Promise<Record<string, unknown>> {
    let settingsDelta = delta;
    if (delta instanceof DeepgramSTTSettings) {
      const copy = delta.copy();
      copy._syncExtraToFields();
      settingsDelta = copy;
    }

    const changed = await super._updateSettings(settingsDelta);

    if (Object.keys(changed).length === 0) {
      return changed;
    }

    // Sync extra to fields after the update so this._settings stays unambiguous
    if (this._settings instanceof DeepgramSTTSettings) {
      this._settings._syncExtraToFields();
    }

    await this._requestReconnect();

    return changed;
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

  /**
   * Stop the Deepgram STT service.
   *
   * @param frame The end frame.
   */
  override async stop(frame: EndFrame): Promise<void> {
    await super.stop(frame);
    await this._disconnect();
  }

  /**
   * Cancel the Deepgram STT service.
   *
   * @param frame The cancel frame.
   */
  override async cancel(frame: CancelFrame): Promise<void> {
    await super.cancel(frame);
    await this._disconnect();
  }

  /** Release Deepgram resources. */
  override async cleanup(): Promise<void> {
    await super.cleanup();
    await this._disconnect();
  }

  /**
   * Send audio data to Deepgram for transcription.
   *
   * @param audio Raw audio bytes to transcribe.
   * @returns null (transcription results come via WebSocket callbacks).
   */
  override async *runStt(audio: Uint8Array): AsyncGenerator<Frame | null, void, unknown> {
    if (this._connection) {
      try {
        await this._connection.sendMedia(audio);
      } catch (e) {
        rethrowIfCancelled(e);
        logger.warning(`${this}: send_media failed, connection will reconnect: ${errorMessage(e)}`);
        this._connection = null;
      }
    }
    yield null;
  }

  /** Build the query parameters for `client.listen.v1.connect()` from current settings. */
  protected _buildConnectKwargs(): ListenV1ConnectParams {
    const kwargs: ListenV1ConnectParams = {};
    const s = this._settings;
    const self = s as unknown as Record<string, unknown>;

    // Declared Deepgram-specific fields
    for (const name of s._deepgramFieldNames()) {
      const value = self[name];
      if (!isGiven(value) || value === null || value === undefined) {
        continue;
      }
      const key = camelToSnake(name);
      // Lists (e.g. keyterm, keywords, search, redact, replace) must be
      // passed through as-is so the query has repeated params
      // (keyterm=a&keyterm=b) instead of a stringified list.
      if (Array.isArray(value)) {
        kwargs[key] = value;
      } else if (typeof value === "boolean") {
        kwargs[key] = String(value);
      } else {
        kwargs[key] = queryValue(value);
      }
    }

    // model and language
    if (isGiven(s.model) && s.model !== null) {
      kwargs.model = String(s.model);
    }
    if (isGiven(s.language) && s.language !== null) {
      kwargs.language = String(s.language);
    }

    // Init-only connection config
    kwargs.encoding = this._encoding;
    kwargs.channels = String(this._channels);
    kwargs.multichannel = String(this._multichannel);
    kwargs.sample_rate = String(this.sampleRate);

    if (this._callback !== null) {
      kwargs.callback = this._callback;
    }
    if (this._callbackMethod !== null) {
      kwargs.callback_method = this._callbackMethod;
    }
    if (this._tag !== null) {
      kwargs.tag = pyStr(this._tag);
    }
    if (this._mipOptOut !== null) {
      kwargs.mip_opt_out = String(this._mipOptOut);
    }

    // Any remaining values in extra (that didn't map to declared fields)
    for (const [key, value] of Object.entries(s.extra)) {
      if (value !== null && value !== undefined) {
        if (Array.isArray(value)) {
          kwargs[key] = value;
        } else if (typeof value === "boolean") {
          kwargs[key] = String(value);
        } else {
          kwargs[key] = queryValue(value);
        }
      }
    }

    if (this._addons) {
      for (const [key, value] of Object.entries(this._addons)) {
        kwargs[key] = queryValue(value);
      }
    }

    return kwargs;
  }

  protected async _connect(): Promise<void> {
    logger.debug("Connecting to Deepgram");
    this._quickFailureTracker.reset();
    this._connectionSettled.clear();
    this._connectionTask = this.createTask(() => this._connectionHandler());
    await this._connectionSettled.wait();
  }

  protected async _disconnect(): Promise<void> {
    if (!this._connectionTask) {
      return;
    }

    logger.debug(`${this}: Disconnecting from Deepgram`);
    // Clear the connection first to prevent runStt from sending audio during
    // the close handshake.
    const connection = this._connection;
    this._connection = null;

    if (connection) {
      await connection.sendCloseStream();
    }

    await this.cancelTask(this._connectionTask);
    this._connectionTask = null;
  }

  /**
   * Manages the full WebSocket lifecycle inside a single connection scope.
   *
   * Reconnects automatically after an error, with exponential backoff between
   * attempts, and gives up once enough attempts in a row have failed to
   * produce a connection that stays up. A 4xx `DeepgramApiError` (e.g. an
   * invalid API key rejected at the handshake) gives up at once, since the
   * request itself is bad. Giving up leaves the service unusable either way,
   * so a `ServiceSwitcher` can move off it. Exits cleanly when the task is
   * cancelled (i.e. on stop/cancel).
   */
  protected async _connectionHandler(): Promise<void> {
    try {
      while (true) {
        const connectKwargs = this._buildConnectKwargs();
        let keepaliveTask: Task<unknown> | null = null;
        let connectedAt: number | null = null;
        try {
          const connection = await this._client.listen.v1.connect(connectKwargs);
          try {
            connectedAt = monotonic();
            this._connection = connection;
            this._connectionSettled.set();
            connection.on(EventType.MESSAGE, (message: unknown) => this._onMessage(message));
            connection.on(EventType.ERROR, (error: unknown) => this._onError(error));

            logger.debug(`${this}: Websocket connection initialized`);

            keepaliveTask = this.createTask(() => this._keepaliveHandler(), `${this}::keepalive`);
            await connection.startListening();
          } finally {
            await connection.close();
          }
        } catch (e) {
          rethrowIfCancelled(e);
          if (e instanceof DeepgramApiError) {
            if (e.statusCode !== null && e.statusCode >= 400 && e.statusCode < 500) {
              const msg = `Deepgram rejected the connection (status ${e.statusCode}): ${e.message}`;
              await this.pushError(msg, { exception: e, forceTreatAsPermanent: true });
              return;
            }
          }
          logger.warning(`${this}: Connection lost, will retry: ${errorMessage(e)}`);
          await this.pushError(`connection error: ${errorMessage(e)}`, { exception: e });
        } finally {
          this._connection = null;
          if (keepaliveTask) {
            await this.cancelTask(keepaliveTask);
          }
        }

        // How long the connection lasted, which is nothing at all when the
        // handshake never completed. Timing the attempt instead would read a
        // handshake that hangs before failing as a healthy connection and keep
        // retrying it forever.
        const uptime = connectedAt !== null ? monotonic() - connectedAt : 0.0;
        if (this._quickFailureTracker.record(uptime).shouldGiveUp) {
          const msg =
            "connection failed to stay up " +
            `${this._quickFailureTracker.maxConsecutiveFailures} times in a row`;
          await this.pushError(msg, { forceTreatAsPermanent: true });
          return;
        }
        await sleep(exponentialBackoffTime(this._quickFailureTracker.count));
      }
    } finally {
      // Nothing further will be attempted, so whoever is waiting for the
      // service to connect can stop waiting.
      this._connectionSettled.set();
    }
  }

  /**
   * Periodically send KeepAlive frames to prevent server-side timeout.
   *
   * Deepgram closes inactive connections after 10 seconds (NET-0001 error).
   * Sending every 5 seconds stays within the recommended 3-5 second interval.
   */
  protected async _keepaliveHandler(): Promise<void> {
    while (true) {
      await sleep(5);
      if (this._connection) {
        try {
          await this._connection.sendKeepAlive();
          logger.trace(`${this}: Sent keepalive`);
        } catch (e) {
          rethrowIfCancelled(e);
          logger.warning(`${this}: Keepalive failed: ${errorMessage(e)}`);
        }
      }
    }
  }

  protected async _onError(error: unknown): Promise<void> {
    logger.warning(`${this} connection error, will retry: ${errorMessage(error)}`);
    await this.pushError(`${errorMessage(error)}`);
    await this.stopAllMetrics();
    // Reconnection is handled automatically by the retry loop in
    // _connectionHandler once startListening() exits after the error.
  }

  /** Handle a transcription result with tracing. */
  protected async _handleTranscription(
    _transcript: string,
    _isFinal: boolean,
    _language: Language | null = null,
  ): Promise<void> {}

  protected async _onMessage(message: unknown): Promise<void> {
    if (!isResultsMessage(message)) {
      return;
    }
    const channel = message.channel;
    if (!channel || !Array.isArray(channel.alternatives) || channel.alternatives.length === 0) {
      return;
    }
    const isFinal = Boolean(message.is_final);
    const alternative = channel.alternatives[0] as Dict;
    const transcript: string = alternative.transcript ?? "";
    let language: Language | null = null;
    if (Array.isArray(alternative.languages) && alternative.languages.length > 0) {
      const code = String(alternative.languages[0]);
      if (!isLanguage(code)) {
        throw new Error(`'${code}' is not a valid Language`);
      }
      language = code;
    }
    if (isFinal) {
      // Check if this response is from a finalize() call. Only mark as
      // finalized when both we requested it AND Deepgram confirms it.
      const fromFinalize = Boolean(message.from_finalize ?? false);
      if (fromFinalize) {
        this.confirmFinalize();
      }
      if (transcript.length > 0) {
        // Report usage before the transcription frame so tracing can attach
        // it to the STT span the frame closes.
        await this.emitSttUsageMetrics();
        await this.pushFrame(
          new TranscriptionFrame({
            text: transcript,
            userId: this._userId,
            timestamp: timeNowIso8601(),
            language,
            result: message,
          }),
        );
        await this._handleTranscription(transcript, isFinal, language);
      } else if (fromFinalize) {
        // Deepgram already sent the transcript via a regular is_final before
        // the finalize response arrived (empty). Report STT TTFB immediately
        // instead of falling to the timeout.
        await this.stopTtfbMetrics();
        await this._cancelTtfbTimeout();
      }
    } else if (transcript.length > 0) {
      // For interim transcriptions, just push the frame without tracing
      await this.pushFrame(
        new InterimTranscriptionFrame({
          text: transcript,
          userId: this._userId,
          timestamp: timeNowIso8601(),
          language,
          result: message,
        }),
      );
    }
  }

  /**
   * Process frames with Deepgram-specific handling.
   *
   * @param frame The frame to process.
   * @param direction The direction of frame processing.
   */
  override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
    await super.processFrame(frame, direction);

    if (frame instanceof VADUserStoppedSpeakingFrame) {
      // https://developers.deepgram.com/docs/finalize
      // Mark that we're awaiting a from_finalize response
      if (this._connection) {
        this.requestFinalize();
        await this._connection.sendFinalize();
        const directionName = direction === FrameDirection.DOWNSTREAM ? "DOWNSTREAM" : "UPSTREAM";
        logger.trace(
          `Triggered finalize event on: frame.name=${pyRepr(frame.name)}, ` +
            `direction=<FrameDirection.${directionName}: ${direction}>`,
        );
      }
    }
  }
}

/** Whether `message` is a `Results` message (the SDK's `ListenV1Results`). */
function isResultsMessage(message: unknown): message is Dict {
  return (
    typeof message === "object" &&
    message !== null &&
    !(message instanceof Uint8Array) &&
    (message as Dict).type === "Results"
  );
}
