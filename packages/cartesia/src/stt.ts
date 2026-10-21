// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/services/cartesia/stt.py

/**
 * Cartesia Speech-to-Text service implementation.
 *
 * This module provides a WebSocket-based STT service that integrates with
 * the Cartesia Live transcription API for real-time speech recognition.
 *
 * Porting notes:
 * - The socket is the global `WebSocket`, opened through
 *   `WebsocketService._websocketConnect()`. The `X-API-Key` header is sent on
 *   the opening handshake, which the Bun, Node and Deno `WebSocket` support.
 * - The standard `WebSocket` does not expose the handshake response, so the
 *   `X-Request-ID` response header upstream logs on connect is always
 *   reported as `None`.
 * - Deprecated APIs are not ported: `CartesiaLiveOptions` and the
 *   `live_options` constructor parameter.
 */

import { rethrowIfCancelled, type Task } from "@pipedog/asyncio";
import {
  type CancelFrame,
  type EndFrame,
  type Frame,
  InterimTranscriptionFrame,
  TranscriptionFrame,
  VADUserStoppedSpeakingFrame,
} from "@pipedog/core/frames/frames";
import type { FrameDirection, FrameProcessorSetup } from "@pipedog/core/processors/frame_processor";
import { STTSettings, type STTSettingsOptions } from "@pipedog/core/services/settings";
import { CARTESIA_TTFS_P99 } from "@pipedog/core/services/stt_latency";
import {
  WebsocketSTTService,
  type WebsocketSTTServiceOptions,
} from "@pipedog/core/services/stt_service";
import { State, type WebsocketClientConnection } from "@pipedog/core/services/websocket_service";
import { isLanguage, Language } from "@pipedog/core/transcriptions/language";
import { logger } from "@pipedog/core/utils/logger";
import { pyJsonLoads } from "@pipedog/core/utils/py_json";
import { timeNowIso8601 } from "@pipedog/core/utils/time";
import { installTracedStt } from "@pipedog/core/utils/tracing/service_decorators";
import { isGiven, NOT_GIVEN, type NotGiven } from "@pipedog/core/utils/types";

// Upstream `dict[str, Any]`: Cartesia JSON payloads are genuinely dynamic.
type Dict = Record<string, any>;

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Python's `repr()` of an optional string, as `f"{x!r}"` / `f"{x=}"` print it. */
function pyReprStr(value: unknown): string {
  if (value === null || value === undefined) return "None";
  return `'${String(value)}'`;
}

/**
 * `urllib.parse.quote(s, safe="")`: percent-encode everything except the
 * unreserved characters (letters, digits, `_.-~`). Unlike
 * `encodeURIComponent`, also encodes `!'()*`.
 */
export function _quote(s: string): string {
  return encodeURIComponent(s).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/**
 * `urllib.parse.urlencode(params, quote_via=urllib.parse.quote)`. Spaces are
 * written as `%20`, which is what Cartesia expects inside a keyterm.
 */
export function _urlencode(params: readonly (readonly [string, string])[]): string {
  return params.map(([key, value]) => `${_quote(key)}=${_quote(value)}`).join("&");
}

// Cartesia caps a connection at 100 keyterms totaling 1200 characters.
const _MAX_KEYTERMS = 100;
const _MAX_KEYTERM_CHARS = 1200;

// Keyterms are only honored by the ink-2 and ink-preview model families.
const _KEYTERM_MODEL_PREFIXES = ["ink-2", "ink-preview"] as const;

/**
 * Normalize keyterms to the limits Cartesia accepts on a connection.
 *
 * Drops blank entries and truncates to `_MAX_KEYTERMS` terms totaling
 * `_MAX_KEYTERM_CHARS` characters, warning about whatever is dropped.
 * Truncating keeps an oversized list from failing the connection mid-call.
 *
 * @param keyterms Keyterms from settings, which may be unset or `null`.
 * @returns The keyterms to send, in the order given.
 */
export function _prepareKeyterms(keyterms: string[] | null | NotGiven): string[] {
  if (!isGiven(keyterms) || !keyterms || keyterms.length === 0) {
    return [];
  }

  const terms = keyterms.map((term) => term.trim()).filter((stripped) => stripped);

  const prepared: string[] = [];
  let totalChars = 0;
  for (const term of terms) {
    if (prepared.length >= _MAX_KEYTERMS || totalChars + term.length > _MAX_KEYTERM_CHARS) {
      break;
    }
    prepared.push(term);
    totalChars += term.length;
  }

  if (prepared.length < terms.length) {
    logger.warning(
      `Cartesia accepts at most ${_MAX_KEYTERMS} keyterms totaling ` +
        `${_MAX_KEYTERM_CHARS} characters; dropping ${terms.length - prepared.length} keyterm(s)`,
    );
  }

  return prepared;
}

export interface CartesiaSTTSettingsOptions extends STTSettingsOptions {
  /**
   * Key terms or phrases to bias transcription towards, sent as repeated
   * `keyterm` query parameters on the connection URL. Only honored by ink-2
   * and ink-preview models; keyterms set for any other model are ignored with
   * a warning. Cartesia binds keyterms to a connection, so updating this
   * setting at runtime triggers a reconnect. See
   * https://docs.cartesia.ai/use-the-api/stt/keyterms.
   */
  keyterm?: string[] | null | NotGiven;
}

/**
 * Settings for CartesiaSTTService.
 *
 * - `keyterm`: key terms or phrases to bias transcription towards, sent as
 *   repeated `keyterm` query parameters on the connection URL. Only honored
 *   by ink-2 and ink-preview models; keyterms set for any other model are
 *   ignored with a warning. Cartesia binds keyterms to a connection, so
 *   updating this setting at runtime triggers a reconnect. See
 *   https://docs.cartesia.ai/use-the-api/stt/keyterms.
 */
export class CartesiaSTTSettings extends STTSettings {
  keyterm: string[] | null | NotGiven = NOT_GIVEN;

  constructor(options: CartesiaSTTSettingsOptions = {}) {
    super(options);
    this._assignOptions(options);
  }
}

export interface CartesiaSTTServiceOptions extends WebsocketSTTServiceOptions {
  /** Authentication key for Cartesia API. */
  apiKey: string;
  /**
   * Custom API endpoint, either a bare host ("api.cartesia.ai") or a URL with
   * a scheme ("ws://localhost:8000"). If empty, uses default.
   */
  baseUrl?: string;
  /** Audio encoding format. Defaults to "pcm_s16le". */
  encoding?: string;
  /**
   * Additional headers to send on the websocket handshake. Merged after the
   * default headers, so it can override them.
   */
  extraHeaders?: Record<string, string> | null;
  /** Runtime-updatable settings. */
  settings?: CartesiaSTTSettings | null;
}

/**
 * Split a base URL the way `urllib.parse.urlsplit` does, returning its scheme
 * and network location ("" when absent).
 */
function splitBaseUrl(url: string): { scheme: string; netloc: string } {
  const match = /^(?:([A-Za-z][A-Za-z0-9+.-]*):)?\/\/([^/?#]*)/.exec(url);
  if (!match) return { scheme: "", netloc: "" };
  return { scheme: (match[1] ?? "").toLowerCase(), netloc: match[2] ?? "" };
}

/**
 * Speech-to-text service using Cartesia Live API.
 *
 * Provides real-time speech transcription through WebSocket connection to
 * Cartesia's Live transcription service. Supports both interim and final
 * transcriptions with configurable models and languages.
 *
 * Cartesia disconnects WebSocket connections after 3 minutes of inactivity.
 * The timeout resets with each message (audio data or text command) sent to
 * the server. Silence-based keepalive is enabled by default to prevent this.
 * See: https://docs.cartesia.ai/api-reference/stt/stt
 */
export class CartesiaSTTService extends WebsocketSTTService {
  static Settings: typeof CartesiaSTTSettings = CartesiaSTTSettings;
  declare protected _settings: CartesiaSTTSettings;

  static {
    installTracedStt(CartesiaSTTService.prototype, "_handleTranscription");
  }

  protected _apiKey: string;
  protected _baseUrl: string;
  protected _scheme: string;
  protected _extraHeaders: Record<string, string>;
  protected _receiveTask: Task<unknown> | null = null;
  // Init-only audio config (not runtime-updatable).
  protected _encoding: string;

  /**
   * Initialize CartesiaSTTService with API key and options.
   *
   * @param options.apiKey Authentication key for Cartesia API.
   * @param options.baseUrl Custom API endpoint, either a bare host
   *   ("api.cartesia.ai") or a URL with a scheme ("ws://localhost:8000"). If
   *   empty, uses default.
   * @param options.encoding Audio encoding format. Defaults to "pcm_s16le".
   * @param options.sampleRate Audio sample rate in Hz. If null, uses the
   *   pipeline sample rate.
   * @param options.extraHeaders Additional headers to send on the websocket
   *   handshake. Merged after the default headers, so it can override them.
   * @param options.settings Runtime-updatable settings.
   * @param options.ttfsP99Latency P99 latency from speech end to final
   *   transcript in seconds. Override for your deployment. See
   *   https://github.com/pipecat-ai/stt-benchmark
   *   Other options are passed to the parent STTService.
   */
  constructor(options: CartesiaSTTServiceOptions) {
    // 1. Initialize defaultSettings with hardcoded defaults
    const defaultSettings = new (new.target as typeof CartesiaSTTService).Settings({
      model: "ink-whisper",
      language: Language.EN,
      keyterm: null,
    });

    // 2. Apply settings delta (canonical API, always wins)
    if (options.settings !== undefined && options.settings !== null) {
      defaultSettings.applyUpdate(options.settings);
    }

    super({
      ...options,
      sampleRate: options.sampleRate ?? null,
      ttfsP99Latency:
        options.ttfsP99Latency === undefined ? CARTESIA_TTFS_P99 : options.ttfsP99Latency,
      keepaliveTimeout: 120,
      keepaliveInterval: 30,
      settings: defaultSettings,
    });

    this._apiKey = options.apiKey;
    // Accept either a bare host ("api.cartesia.ai") or a full URL carrying a
    // scheme ("ws://localhost:8000"); urlsplit only finds a netloc after "//".
    const baseUrl = options.baseUrl ?? "";
    const urlParts = splitBaseUrl(baseUrl.includes("//") ? baseUrl : `//${baseUrl}`);
    this._baseUrl = urlParts.netloc || "api.cartesia.ai";
    this._scheme = urlParts.scheme || "wss";
    this._extraHeaders = options.extraHeaders ? { ...options.extraHeaders } : {};
    this._receiveTask = null;

    // Init-only audio config (not runtime-updatable).
    this._encoding = options.encoding ?? "pcm_s16le";
  }

  /**
   * Check if the service can generate processing metrics.
   *
   * @returns True, indicating metrics are supported.
   */
  override canGenerateMetrics(): boolean {
    return true;
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
   * Stop the STT service and close connection.
   *
   * @param frame Frame indicating service should stop.
   */
  override async stop(frame: EndFrame): Promise<void> {
    await super.stop(frame);
    await this._disconnect();
  }

  /**
   * Cancel the STT service and close connection.
   *
   * @param frame Frame indicating service should be cancelled.
   */
  override async cancel(frame: CancelFrame): Promise<void> {
    await super.cancel(frame);
    await this._disconnect();
  }

  /**
   * Process incoming frames and handle speech events.
   *
   * @param frame The frame to process.
   * @param direction Direction of frame flow in the pipeline.
   */
  override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
    await super.processFrame(frame, direction);

    if (frame instanceof VADUserStoppedSpeakingFrame) {
      // Send finalize command to flush the transcription session
      if (this._websocket && this._websocket.state === State.OPEN) {
        await this._websocket.send("finalize");
      }
    }
  }

  /**
   * Process audio data for speech-to-text transcription.
   *
   * @param audio Raw audio bytes to transcribe.
   * @returns null - transcription results are handled via WebSocket responses.
   */
  override async *runStt(audio: Uint8Array): AsyncGenerator<Frame | null, void, unknown> {
    // The receive loop reconnects a dropped socket; audio arriving
    // meanwhile is dropped.
    if (!this._websocket || this._websocket.state !== State.OPEN) {
      yield null;
      return;
    }

    try {
      await this._websocket.send(audio);
    } catch (e) {
      rethrowIfCancelled(e);
      logger.warning(`${this}: send failed: ${errorMessage(e)}`);
    }
    yield null;
  }

  override async _connect(): Promise<void> {
    await this._connectWebsocket();

    await super._connect();

    // Started even when the connection failed: with no socket the receive
    // loop goes straight to its reconnect path, which retries the connect.
    if (!this._receiveTask) {
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

  /**
   * Apply a settings delta.
   *
   * @param delta An STTSettings (or `CartesiaSTTService.Settings`) delta.
   * @returns Record mapping changed field names to their previous values.
   */
  protected override async _updateSettings(delta: STTSettings): Promise<Record<string, unknown>> {
    const changed = await super._updateSettings(delta);

    if (Object.keys(changed).length === 0) {
      return changed;
    }

    await this._requestReconnect();

    return changed;
  }

  override async _connectWebsocket(): Promise<void> {
    try {
      if (this._websocket && this._websocket.state === State.OPEN) {
        return;
      }
      logger.debug("Connecting to Cartesia STT");

      const params: [string, string][] = [
        ["model", String(this._settings.model)],
        ["language", String(this._settings.language)],
        ["encoding", this._encoding],
        ["sample_rate", String(this.sampleRate)],
      ];
      const keyterms = _prepareKeyterms(this._settings.keyterm);
      if (keyterms.length > 0) {
        const model = String(this._settings.model);
        if (_KEYTERM_MODEL_PREFIXES.some((prefix) => model.startsWith(prefix))) {
          params.push(...keyterms.map((term): [string, string] => ["keyterm", term]));
        } else {
          const supported = _KEYTERM_MODEL_PREFIXES.join(" or ");
          logger.warning(
            `keyterms are only supported on ${supported} models; ` +
              `ignoring keyterms for model ${pyReprStr(this._settings.model)}`,
          );
        }
      }
      // Cartesia expects spaces inside a keyterm as %20, which urlencode
      // only emits with quote_via=quote.
      const query = _urlencode(params);
      const wsUrl = `${this._scheme}://${this._baseUrl}/stt/websocket?${query}`;
      const headers: Record<string, string> = {
        "Cartesia-Version": "2026-03-01",
        "X-API-Key": this._apiKey,
        ...this._extraHeaders,
      };

      this._websocket = await this._websocketConnect(wsUrl, { additionalHeaders: headers });
      // The standard WebSocket API doesn't expose the handshake response, so
      // the X-Request-ID response header is unavailable.
      const requestId: string | null = null;
      logger.info(`${this}: Connected to Cartesia STT (request_id=${pyReprStr(requestId)})`);
      await this._callEventHandler("on_connected");
    } catch (e) {
      rethrowIfCancelled(e);
      this._websocket = null;
      await this.pushError(`Unable to connect to Cartesia: ${errorMessage(e)}`, { exception: e });
    }
  }

  override async _disconnectWebsocket(): Promise<void> {
    const ws = this._websocket;
    try {
      if (ws && ws.state === State.OPEN) {
        logger.debug(`${this}: Disconnecting from Cartesia STT`);
        await ws.send("done");
        await ws.close();
      }
    } catch (e) {
      rethrowIfCancelled(e);
      await this.pushError(`Error closing websocket: ${errorMessage(e)}`, { exception: e });
    } finally {
      // Only clear if no concurrent _connect has already replaced it.
      if (this._websocket === ws) {
        this._websocket = null;
      }
      await this._callEventHandler("on_disconnected");
    }
  }

  protected _getWebsocket(): WebsocketClientConnection {
    if (this._websocket) {
      return this._websocket;
    }
    throw new Error("Websocket not connected");
  }

  /** Process incoming WebSocket messages. */
  override async _receiveMessages(): Promise<void> {
    for await (const message of this._getWebsocket()) {
      const text = typeof message === "string" ? message : new TextDecoder().decode(message);
      let data: unknown;
      try {
        data = pyJsonLoads(text);
      } catch (e) {
        rethrowIfCancelled(e);
        if (e instanceof SyntaxError) {
          logger.warning(`Received non-JSON message: ${text}`);
        } else {
          logger.error(`Error processing message: ${errorMessage(e)}`);
        }
        continue;
      }
      try {
        await this._processResponse(data);
      } catch (e) {
        rethrowIfCancelled(e);
        logger.error(`Error processing message: ${errorMessage(e)}`);
      }
    }
  }

  protected async _processResponse(data: unknown): Promise<void> {
    if (data !== null && typeof data === "object" && "type" in data) {
      const msg = data as Dict;
      if (msg.type === "transcript") {
        await this._onTranscript(msg);
      } else if (msg.type === "error") {
        const errorMsg = msg.message ?? "Unknown error";
        await this.pushError(errorMsg);
      }
    }
  }

  /** Handle a transcription result with tracing. */
  protected async _handleTranscription(
    _transcript: string,
    _isFinal: boolean,
    _language: Language | null = null,
  ): Promise<void> {}

  protected async _onTranscript(data: Dict): Promise<void> {
    if (!("text" in data)) {
      return;
    }

    const transcript: string = data.text ?? "";
    const isFinal: boolean = data.is_final ?? false;
    let language: Language | null = null;

    if ("language" in data) {
      const value = data.language;
      if (typeof value === "string" && isLanguage(value)) {
        language = value;
      }
    }

    if (transcript.length > 0) {
      if (isFinal) {
        // Report usage before the transcription frame so tracing can
        // attach it to the STT span the frame closes.
        await this.emitSttUsageMetrics();
        await this.pushFrame(
          new TranscriptionFrame({
            text: transcript,
            userId: this._userId,
            timestamp: timeNowIso8601(),
            language,
            result: data,
          }),
        );
        await this._handleTranscription(transcript, isFinal, language);
      } else {
        // For interim transcriptions, just push the frame without tracing
        await this.pushFrame(
          new InterimTranscriptionFrame({
            text: transcript,
            userId: this._userId,
            timestamp: timeNowIso8601(),
            language,
            result: data,
          }),
        );
      }
    }
  }
}
