// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/serializers/genesys.py

/**
 * Genesys AudioHook Serializer for Pipecat.
 *
 * This module provides a serializer for integrating Pipecat pipelines with
 * Genesys Cloud Contact Center via the AudioHook protocol.
 *
 * Features:
 * - Bidirectional audio streaming (PCMU μ-law at 8kHz)
 * - Automatic protocol handshake handling (open/opened, close/closed, ping/pong)
 * - Input/output variables for Architect flow integration
 * - DTMF event support
 * - Barge-in (interruption) events
 * - Pause/resume support for hold scenarios (optional)
 *
 * Protocol Reference:
 * - https://developer.genesys.cloud/devapps/audiohook
 *
 * Audio Format:
 * - PCMU (μ-law) at 8kHz sample rate (preferred)
 * - L16 (16-bit linear PCM) at 8kHz also supported
 * - Mono (external channel) or Stereo (external on left, internal on right)
 */

import { rethrowIfCancelled } from "@pipedog/asyncio";
import { KeypadEntry } from "@pipedog/core/audio/dtmf/types";
import { SOXRStreamAudioResampler } from "@pipedog/core/audio/resamplers/soxr_stream_resampler";
import { pcmToUlaw, ulawToPcm } from "@pipedog/core/audio/utils";
import {
  AudioRawFrame,
  CancelFrame,
  EndFrame,
  type Frame,
  InputAudioRawFrame,
  InputDTMFFrame,
  InterruptionFrame,
  OutputTransportMessageFrame,
  OutputTransportMessageUrgentFrame,
} from "@pipedog/core/frames/frames";
import type { FrameProcessorSetup } from "@pipedog/core/processors/frame_processor";
import {
  FrameSerializer,
  FrameSerializerInputParams,
  type FrameSerializerInputParamsOptions,
  type FrameSerializerOptions,
  type SerializedData,
} from "@pipedog/core/serializers/base_serializer";
import { logger } from "@pipedog/core/utils/logger";
import { pyJsonDumps as jsonDumps, pyJsonLoads, pyNumberRepr } from "@pipedog/core/utils/py_json";

/** AudioHook protocol message types. */
export const AudioHookMessageType = {
  OPEN: "open",
  OPENED: "opened",
  CLOSE: "close",
  CLOSED: "closed",
  PAUSE: "pause",
  RESUMED: "resumed",
  PING: "ping",
  PONG: "pong",
  UPDATE: "update",
  EVENT: "event",
  ERROR: "error",
  DISCONNECT: "disconnect",
} as const;
export type AudioHookMessageType = (typeof AudioHookMessageType)[keyof typeof AudioHookMessageType];

/** AudioHook audio channel configuration. */
export const AudioHookChannel = {
  /** Customer audio only (mono). */
  EXTERNAL: "external",
  /** Agent audio only (mono). */
  INTERNAL: "internal",
  /** Stereo: external=left, internal=right. */
  BOTH: "both",
} as const;
export type AudioHookChannel = (typeof AudioHookChannel)[keyof typeof AudioHookChannel];

/** Supported audio formats. */
export const AudioHookMediaFormat = {
  /** μ-law, 8kHz. */
  PCMU: "PCMU",
  /** 16-bit linear PCM, 8kHz. */
  L16: "L16",
} as const;
export type AudioHookMediaFormat = (typeof AudioHookMediaFormat)[keyof typeof AudioHookMediaFormat];

/** A JSON object, as Python's `dict[str, Any]`. */
export type JsonDict = Record<string, any>;

export interface GenesysAudioHookSerializerInputParamsOptions
  extends FrameSerializerInputParamsOptions {
  /** Sample rate used by Genesys (default: 8000 Hz). */
  genesysSampleRate?: number;
  /** Optional override for pipeline input sample rate. */
  sampleRate?: number | null;
  /** Which audio channels to process (external, internal, both). */
  channel?: AudioHookChannel;
  /** Audio format (PCMU or L16). */
  mediaFormat?: AudioHookMediaFormat;
  /** Whether to process external (customer) audio. */
  processExternal?: boolean;
  /** Whether to process internal (agent) audio. */
  processInternal?: boolean;
  /** List of language codes the bot supports (e.g., ["en-US", "es-ES"]). */
  supportedLanguages?: string[] | null;
  /** Default language code to use. */
  selectedLanguage?: string | null;
  /** Whether to start the session in paused state. */
  startPaused?: boolean;
}

/**
 * Configuration parameters for GenesysAudioHookSerializer.
 *
 * - `genesysSampleRate`: Sample rate used by Genesys (default: 8000 Hz).
 * - `sampleRate`: Optional override for pipeline input sample rate.
 * - `channel`: Which audio channels to process (external, internal, both).
 * - `mediaFormat`: Audio format (PCMU or L16).
 * - `processExternal`: Whether to process external (customer) audio.
 * - `processInternal`: Whether to process internal (agent) audio.
 * - `supportedLanguages`: List of language codes the bot supports (e.g., ["en-US", "es-ES"]).
 * - `selectedLanguage`: Default language code to use.
 * - `startPaused`: Whether to start the session in paused state.
 * - `ignoreRtviMessages`: Inherited from base FrameSerializer, defaults to true.
 */
export class GenesysAudioHookSerializerInputParams extends FrameSerializerInputParams {
  genesysSampleRate: number;
  sampleRate: number | null;
  channel: AudioHookChannel;
  mediaFormat: AudioHookMediaFormat;
  processExternal: boolean;
  processInternal: boolean;
  supportedLanguages: string[] | null;
  selectedLanguage: string | null;
  startPaused: boolean;

  constructor(options: GenesysAudioHookSerializerInputParamsOptions = {}) {
    super(options);
    this.genesysSampleRate = options.genesysSampleRate ?? 8000;
    this.sampleRate = options.sampleRate ?? null;
    this.channel = options.channel ?? AudioHookChannel.EXTERNAL;
    this.mediaFormat = options.mediaFormat ?? AudioHookMediaFormat.PCMU;
    this.processExternal = options.processExternal ?? true;
    this.processInternal = options.processInternal ?? false;
    this.supportedLanguages = options.supportedLanguages ?? null;
    this.selectedLanguage = options.selectedLanguage ?? null;
    this.startPaused = options.startPaused ?? false;
  }
}

export interface GenesysAudioHookSerializerOptions extends FrameSerializerOptions {
  /** Configuration parameters. */
  params?: GenesysAudioHookSerializerInputParams | null;
}

/** Options for `createOpenedResponse`. */
export interface CreateOpenedResponseOptions {
  /** Whether to start the session paused. */
  startPaused?: boolean;
  /** List of supported language codes. */
  supportedLanguages?: string[] | null;
  /** The selected language code. */
  selectedLanguage?: string | null;
}

/** Options for `createDisconnectMessage`. */
export interface CreateDisconnectMessageOptions {
  /** Disconnect reason (e.g., "completed", "error"). */
  reason?: string;
  /** Action to take ("transfer" to agent, "finished" if completed). */
  action?: string;
  /** Custom output variables to pass back to Genesys. */
  outputVariables?: JsonDict | null;
  /** Optional additional information. */
  info?: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pyTypeName(value: unknown): string {
  if (value === null || value === undefined) return "NoneType";
  if (Array.isArray(value)) return "list";
  if (typeof value === "string") return "str";
  if (typeof value === "number") return Number.isInteger(value) ? "int" : "float";
  if (typeof value === "boolean") return "bool";
  return typeof value;
}

/** Python `obj.get(key, default)`: raises when `obj` is not a dict. */
function dictGet(obj: unknown, key: string, defaultValue: unknown = null): any {
  if (!isRecord(obj)) {
    throw new TypeError(`'${pyTypeName(obj)}' object has no attribute 'get'`);
  }
  return key in obj ? obj[key] : defaultValue;
}

/** Python truthiness of a JSON value. */
function truthy(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (isRecord(value)) return Object.keys(value).length > 0;
  return Boolean(value);
}

/** Python `repr()` of a str. */
function pyStrRepr(s: string): string {
  const quote = s.includes("'") && !s.includes('"') ? '"' : "'";
  let out = quote;
  for (const ch of s) {
    const cp = ch.codePointAt(0) as number;
    if (ch === "\\") out += "\\\\";
    else if (ch === quote) out += `\\${quote}`;
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (cp < 0x20 || cp === 0x7f) out += `\\x${cp.toString(16).padStart(2, "0")}`;
    else out += ch;
  }
  return out + quote;
}

/** Python `repr()` of a JSON value (dicts, lists, str, numbers, bools, None). */
function pyRepr(value: unknown): string {
  if (typeof value === "string") return pyStrRepr(value);
  if (Array.isArray(value)) return `[${value.map(pyRepr).join(", ")}]`;
  if (isRecord(value)) {
    return `{${Object.entries(value)
      .map(([k, v]) => `${pyStrRepr(k)}: ${pyRepr(v)}`)
      .join(", ")}}`;
  }
  return pyStr(value);
}

/** Python `str()` of a JSON value, for log lines. */
function pyStr(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === true) return "True";
  if (value === false) return "False";
  if (value === null || value === undefined) return "None";
  if (typeof value === "number") return pyNumberRepr(value);
  return pyRepr(value);
}

/** Round half to even, as Python's `round()`. */
function roundHalfEven(x: number): number {
  const r = Math.round(x);
  return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

/** Python `float(s)` for the formats an ISO 8601 seconds field can hold; NaN when invalid. */
function pyFloat(text: string): number {
  const s = text.trim().replaceAll(/(?<=\d)_(?=\d)/g, "");
  if (/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(s)) return Number(s);
  if (/^[+-]?(inf|infinity)$/i.test(s)) return s.startsWith("-") ? -Infinity : Infinity;
  if (/^[+-]?nan$/i.test(s)) return Number.NaN;
  throw new RangeError(`could not convert string to float: '${text}'`);
}

const KEYPAD_VALUES: readonly string[] = Object.values(KeypadEntry);

/**
 * Serializer for Genesys AudioHook WebSocket protocol.
 *
 * This serializer handles converting between Pipecat frames and Genesys
 * AudioHook protocol messages. It supports:
 *
 * - Bidirectional audio streaming (PCMU at 8kHz)
 * - Automatic protocol handshake (open/opened, close/closed, ping/pong)
 * - Session lifecycle management with pause/resume support
 * - Custom input/output variables for Architect flow integration
 * - DTMF event handling
 * - Barge-in events for interruption support
 *
 * The AudioHook protocol uses:
 * - Text WebSocket frames for JSON control messages
 * - Binary WebSocket frames for audio data
 *
 * @example
 * const serializer = new GenesysAudioHookSerializer({
 *   params: new GenesysAudioHookSerializer.InputParams({
 *     channel: AudioHookChannel.EXTERNAL,
 *     supportedLanguages: ["en-US", "es-ES"],
 *     selectedLanguage: "en-US",
 *   }),
 * });
 *
 * // Use with the FastAPI WebSocket transport
 * const transport = new FastAPIWebsocketTransport(
 *   websocket,
 *   new FastAPIWebsocketParams({
 *     audioInEnabled: true,
 *     audioOutEnabled: true,
 *     serializer,
 *     fixedAudioPacketSize: 1600, // Important: prevents 429 rate limiting from Genesys
 *   }),
 * );
 *
 * // Access call information after connection
 * const participant = serializer.participant; // ani, dnis, etc.
 * const inputVars = serializer.inputVariables; // Custom vars from Architect
 *
 * // Set output variables to return to Architect
 * serializer.setOutputVariables({ intent: "billing", resolved: true });
 */
export class GenesysAudioHookSerializer extends FrameSerializer {
  /** The AudioHook protocol version (currently "2"). */
  static readonly PROTOCOL_VERSION = "2";

  /** Upstream's nested `GenesysAudioHookSerializer.InputParams`. */
  static override InputParams = GenesysAudioHookSerializerInputParams;

  declare protected _params: GenesysAudioHookSerializerInputParams;

  protected _genesysSampleRate: number;
  protected _sampleRate: number;
  protected _sessionId: string;
  protected _inputResampler: SOXRStreamAudioResampler;
  protected _outputResampler: SOXRStreamAudioResampler;

  // Protocol state
  protected _clientSeq: any;
  protected _serverSeq: number;
  protected _isOpen: boolean;
  protected _isPaused: boolean;
  /** The stream position, in microseconds (upstream's `timedelta`). */
  protected _position: number;

  // Session metadata
  protected _conversationId: string | null;
  protected _participant: JsonDict | null;
  protected _customConfig: JsonDict | null;
  protected _mediaInfo: JsonDict[] | null;
  /** Custom input from Genesys. */
  protected _inputVariables: JsonDict | null;
  /** Custom output to Genesys. */
  protected _outputVariables: JsonDict | null;

  /**
   * Initialize the GenesysAudioHookSerializer.
   *
   * @param options.params Configuration parameters. Other options (e.g. `name`)
   *   are passed to BaseObject.
   */
  constructor(options: GenesysAudioHookSerializerOptions = {}) {
    const params = options.params || new GenesysAudioHookSerializerInputParams();
    super({ ...options, params });
    this._params = params;

    this._genesysSampleRate = this._params.genesysSampleRate;
    this._sampleRate = 0; // Pipeline input rate, set in setup()
    this._sessionId = crypto.randomUUID();

    this._inputResampler = new SOXRStreamAudioResampler({
      clearAfterSecs: this._params.resamplerClearAfterSecs,
    });
    this._outputResampler = new SOXRStreamAudioResampler({
      clearAfterSecs: this._params.resamplerClearAfterSecs,
    });

    // Protocol state
    this._clientSeq = 0;
    this._serverSeq = 0;
    this._isOpen = false;
    this._isPaused = false;
    this._position = 0;

    // Session metadata
    this._conversationId = null;
    this._participant = null;
    this._customConfig = null;
    this._mediaInfo = null;
    this._inputVariables = null; // Custom input from Genesys
    this._outputVariables = null; // Custom output to Genesys

    // Event handlers
    this._registerEventHandler("on_open");
    this._registerEventHandler("on_close");
    this._registerEventHandler("on_ping");
    this._registerEventHandler("on_pause");
    this._registerEventHandler("on_update");
    this._registerEventHandler("on_error");
    this._registerEventHandler("on_dtmf");
  }

  /** Get the Genesys AudioHook session ID generated by the serializer. */
  get sessionId(): string {
    return this._sessionId;
  }

  /** Get the Genesys conversation ID. */
  get conversationId(): string | null {
    return this._conversationId;
  }

  /** Check if the AudioHook session is open. */
  get isOpen(): boolean {
    return this._isOpen;
  }

  /** Check if audio streaming is paused. */
  get isPaused(): boolean {
    return this._isPaused;
  }

  /** Get participant info (ani, dnis, etc.) from the open message. */
  get participant(): JsonDict | null {
    return this._participant;
  }

  /** Get custom input variables from the open message. */
  get inputVariables(): JsonDict | null {
    return this._inputVariables;
  }

  /** Get custom output variables to send back to Genesys. */
  get outputVariables(): JsonDict | null {
    return this._outputVariables;
  }

  /**
   * Set custom output variables to send back to Genesys on close.
   *
   * These variables will be included in the 'closed' response when Genesys
   * closes the connection, making them available in the Architect flow.
   *
   * @param variables Dictionary of custom variables to send to Genesys.
   *
   * @example
   * // During the conversation, collect data and set it
   * serializer.setOutputVariables({
   *   intent: "billing_inquiry",
   *   customer_verified: true,
   *   summary: "Customer asked about their bill",
   *   transfer_to: "billing_queue",
   * });
   */
  setOutputVariables(variables: JsonDict): void {
    this._outputVariables = variables;
    logger.debug(`Output variables set: ${pyStr(variables)}`);
  }

  /**
   * Sets up the serializer with pipeline configuration.
   *
   * @param setup Configuration object containing setup parameters.
   */
  override async setup(setup: FrameProcessorSetup | unknown): Promise<void> {
    // `||` on purpose: upstream uses Python `or`, so a 0 sample rate falls through.
    this._sampleRate = this._params.sampleRate || (setup as FrameProcessorSetup).audioInSampleRate;
    logger.debug(`GenesysAudioHookSerializer setup with sample_rate=${this._sampleRate}`);
  }

  /**
   * Format a position as ISO 8601 duration string.
   *
   * @param position The position, in microseconds.
   * @returns ISO 8601 duration string (e.g., "PT1.5S").
   */
  protected _formatPosition(position: number): string {
    const totalSeconds = position / 1_000_000;
    // `f"{x:.3f}"` rounds the exact binary value half to even; `toFixed`
    // rounds exact ties up. A tie is exact only when the microseconds are an
    // odd multiple of 500 and `x` is a binary fraction (an odd multiple of 62500).
    if (Number.isInteger(position) && position % 62500 === 0 && (position / 500) % 2 !== 0) {
      const millis = roundHalfEven(position / 1000);
      const sign = millis < 0 ? "-" : "";
      const abs = Math.abs(millis);
      return `PT${sign}${Math.floor(abs / 1000)}.${String(abs % 1000).padStart(3, "0")}S`;
    }
    return `PT${totalSeconds.toFixed(3)}S`;
  }

  /**
   * Parse an ISO 8601 duration string to a position.
   *
   * @param positionStr ISO 8601 duration string (e.g., "PT1.5S").
   * @returns The position, in microseconds.
   */
  protected _parsePosition(positionStr: string): number {
    if (typeof positionStr !== "string") {
      throw new TypeError(`'${pyTypeName(positionStr)}' object has no attribute 'startswith'`);
    }
    // Simple parser for PT#S or PT#.#S format
    if (positionStr.startsWith("PT") && positionStr.endsWith("S")) {
      let seconds: number | null = null;
      try {
        seconds = pyFloat(positionStr.slice(2, -1));
      } catch (e) {
        rethrowIfCancelled(e);
        // ValueError: fall through
      }
      if (seconds !== null) {
        // timedelta(seconds=nan) raises ValueError (caught upstream);
        // timedelta(seconds=inf) raises OverflowError (not caught).
        if (Number.isNaN(seconds)) return 0;
        if (!Number.isFinite(seconds)) {
          throw new RangeError("cannot convert float infinity to integer");
        }
        return roundHalfEven(seconds * 1_000_000);
      }
    }
    return 0;
  }

  /** Get the next server sequence number. */
  protected _nextServerSeq(): number {
    this._serverSeq += 1;
    return this._serverSeq;
  }

  /**
   * Create a protocol message with common fields.
   *
   * Based on the Genesys AudioHook protocol, responses include:
   * - seq: Server's sequence number (incremented per message)
   * - clientseq: Echo of the client's last sequence number
   *
   * @param msgType The message type.
   * @param parameters Optional parameters object.
   * @param includePosition Whether to include position field.
   * @returns The message dictionary.
   */
  protected _createMessage(
    msgType: AudioHookMessageType,
    parameters: JsonDict | null = null,
    includePosition = true,
  ): JsonDict {
    const seq = this._nextServerSeq();
    const msg: JsonDict = {
      version: GenesysAudioHookSerializer.PROTOCOL_VERSION,
      type: msgType,
      seq,
      clientseq: this._clientSeq,
      id: this._sessionId,
    };

    if (includePosition) {
      msg.position = this._formatPosition(this._position);
    }

    msg.parameters = parameters !== null ? parameters : {};

    return msg;
  }

  /**
   * Create an 'opened' response message for the client.
   *
   * This should be sent in response to an 'open' message from Genesys.
   *
   * @param options.startPaused Whether to start the session paused.
   * @param options.supportedLanguages List of supported language codes.
   * @param options.selectedLanguage The selected language code.
   * @returns Dictionary of the opened response message.
   */
  createOpenedResponse(options: CreateOpenedResponseOptions = {}): JsonDict {
    const startPaused = options.startPaused ?? false;
    const supportedLanguages = options.supportedLanguages ?? null;
    const selectedLanguage = options.selectedLanguage ?? null;

    // Build channels list based on configuration
    let channels: string[] = [];

    if (this._params.channel === AudioHookChannel.EXTERNAL) {
      channels = ["external"];
    } else if (this._params.channel === AudioHookChannel.INTERNAL) {
      channels = ["internal"];
    } else if (this._params.channel === AudioHookChannel.BOTH) {
      channels = ["external", "internal"];
    }

    const parameters: JsonDict = {
      startPaused,
      media: [
        {
          type: "audio",
          format: this._params.mediaFormat,
          channels,
          rate: this._genesysSampleRate,
        },
      ],
    };

    if (supportedLanguages && supportedLanguages.length > 0) {
      parameters.supportedLanguages = supportedLanguages;
    }
    if (selectedLanguage) {
      parameters.selectedLanguage = selectedLanguage;
    }

    const msg = this._createMessage(
      AudioHookMessageType.OPENED,
      parameters,
      false, // opened doesn't need position
    );

    this._isOpen = true;

    logger.debug(`AudioHook session opened: ${this._sessionId}`);

    return msg;
  }

  /**
   * Create a 'closed' response message.
   *
   * This should be sent in response to a 'close' message from Genesys.
   *
   * @param outputVariables Optional custom variables to pass back to Genesys.
   *   These will be available in the Architect flow after the AudioHook
   *   action completes.
   * @returns Dictionary of the closed response message.
   *
   * @example
   * // Pass custom data back to Genesys
   * serializer.createClosedResponse({
   *   intent: "billing_inquiry",
   *   customer_verified: true,
   *   summary: "Customer asked about their bill",
   * });
   */
  createClosedResponse(outputVariables: JsonDict | null = null): JsonDict {
    let parameters: JsonDict | null = null;

    if (truthy(outputVariables)) {
      parameters = { outputVariables };
    }

    const msg = this._createMessage(AudioHookMessageType.CLOSED, parameters);

    this._isOpen = false;
    logger.debug(`AudioHook session closed: ${this._sessionId}`);

    return msg;
  }

  /**
   * Create a 'pong' response message.
   *
   * This should be sent in response to a 'ping' message from Genesys.
   *
   * @returns Dictionary of the pong response message.
   */
  createPongResponse(): JsonDict {
    const msg = this._createMessage(AudioHookMessageType.PONG);
    return msg;
  }

  /**
   * Create a 'resumed' response message.
   *
   * This should be sent in response to a 'pause' message when ready to resume.
   *
   * @returns Dictionary of the resumed response message.
   */
  createResumedResponse(): JsonDict {
    const msg = this._createMessage(AudioHookMessageType.RESUMED);

    this._isPaused = false;
    logger.debug(`AudioHook session resumed: ${this._sessionId}`);

    return msg;
  }

  /**
   * Create a barge-in event message.
   *
   * This notifies Genesys Cloud that the user has interrupted the bot's audio
   * output. Genesys will stop any queued audio playback.
   *
   * @returns Dictionary of the barge-in event message.
   */
  createBargeInEvent(): JsonDict {
    const msg = this._createMessage(AudioHookMessageType.EVENT, {
      entities: [{ type: "barge_in", data: {} }],
    });

    logger.debug("🔇 Barge-in event sent to Genesys");

    return msg;
  }

  /**
   * Create a 'disconnect' message to initiate session termination.
   *
   * @param options.reason Disconnect reason (e.g., "completed", "error").
   * @param options.action Action to take ("transfer" to agent, "finished" if completed).
   * @param options.outputVariables Custom output variables to pass back to Genesys.
   * @param options.info Optional additional information.
   * @returns Dictionary of the disconnect message.
   */
  createDisconnectMessage(options: CreateDisconnectMessageOptions = {}): JsonDict {
    const reason = options.reason ?? "completed";
    const action = options.action ?? "transfer";
    const outputVariables = options.outputVariables ?? null;
    const info = options.info ?? null;

    const parameters: JsonDict = { reason };

    // Build outputVariables
    const outVars: JsonDict = { action };
    if (truthy(outputVariables)) {
      Object.assign(outVars, outputVariables);
    }
    parameters.outputVariables = outVars;

    if (info) {
      parameters.info = info;
    }

    const msg = this._createMessage(AudioHookMessageType.DISCONNECT, parameters);

    logger.debug(`AudioHook disconnect: reason=${reason}, action=${action}`);
    return msg;
  }

  /**
   * Create an 'error' message.
   *
   * @param code Error code.
   * @param message Error message.
   * @param retryable Whether the operation can be retried.
   * @returns Dictionary of the error message.
   */
  createErrorMessage(code: number, message: string, retryable = false): JsonDict {
    const parameters = {
      code,
      message,
      retryable,
    };

    const msg = this._createMessage(AudioHookMessageType.ERROR, parameters);

    logger.error(`AudioHook error: ${code} - ${message}`);
    return msg;
  }

  /**
   * Serializes a Pipecat frame to Genesys AudioHook format.
   *
   * Handles conversion of various frame types to AudioHook messages:
   * - AudioRawFrame -> Binary PCMU audio data (resampled to 8kHz)
   * - EndFrame/CancelFrame -> Disconnect message (JSON)
   * - InterruptionFrame -> Barge-in event (JSON)
   * - OutputTransportMessageFrame -> Pass-through JSON
   *
   * @param frame The Pipecat frame to serialize.
   * @returns Serialized data as string (JSON) or bytes (audio), or null if the
   *   frame type is not handled or session is not open.
   */
  async serialize(frame: Frame): Promise<SerializedData | null> {
    if (frame instanceof EndFrame || frame instanceof CancelFrame) {
      return jsonDumps(
        this.createDisconnectMessage({
          outputVariables: this.outputVariables,
          reason: "completed",
        }),
      );
    } else if (frame instanceof AudioRawFrame) {
      if (!this._isOpen || this._isPaused) {
        return null;
      }

      const data = frame.audio;

      // Convert PCM to μ-law at 8kHz for Genesys
      let serializedData: Uint8Array;
      if (this._params.mediaFormat === AudioHookMediaFormat.PCMU) {
        serializedData = await pcmToUlaw(
          data,
          frame.sampleRate,
          this._genesysSampleRate,
          this._outputResampler,
        );
      } else {
        // L16 format - just resample if needed
        logger.warning("L16 format not yet fully implemented");
        return null;
      }

      if (serializedData == null || serializedData.length === 0) {
        return null;
      }

      return serializedData;
    } else if (frame instanceof InterruptionFrame) {
      return jsonDumps(this.createBargeInEvent());
    } else if (
      frame instanceof OutputTransportMessageFrame ||
      frame instanceof OutputTransportMessageUrgentFrame
    ) {
      // Filter out RTVI messages using base class method
      if (this.shouldIgnoreFrame(frame)) {
        return null;
      }
      // Only pass through AudioHook protocol messages (those with "version" field)
      // Filter out RTVI and other non-AudioHook messages
      if (isRecord(frame.message) && "version" in frame.message) {
        return jsonDumps(frame.message);
      }
      // Not an AudioHook message, ignore
      return null;
    }

    // Ignore other frames - we don't need to process them here
    return null;
  }

  /**
   * Deserializes Genesys AudioHook data to Pipecat frames.
   *
   * Handles:
   * - Binary data -> InputAudioRawFrame (converted from PCMU to PCM)
   * - JSON 'open' -> OutputTransportMessageUrgentFrame with 'opened' response
   * - JSON 'close' -> OutputTransportMessageUrgentFrame with 'closed' response
   * - JSON 'ping' -> OutputTransportMessageUrgentFrame with 'pong' response
   * - JSON 'pause' -> Sets isPaused=true, returns null
   * - JSON 'dtmf' -> InputDTMFFrame
   * - JSON 'update' -> Updates participant info, returns null
   * - JSON 'error' -> Logs error, returns null
   *
   * Protocol responses (opened, closed, pong) are returned as urgent frames to
   * be sent immediately through the transport.
   *
   * @param data The raw WebSocket data from Genesys (binary audio or JSON text).
   * @returns A Pipecat frame to process, or null if handled internally.
   */
  async deserialize(data: SerializedData): Promise<Frame | null> {
    // Binary data = audio
    if (data instanceof Uint8Array) {
      return await this._deserializeAudio(data);
    }

    // Text data = JSON control message
    let message: unknown;
    try {
      message = pyJsonLoads(data);
    } catch (e) {
      rethrowIfCancelled(e);
      logger.error(`Failed to parse AudioHook message: ${e instanceof Error ? e.message : e}`);
      return null;
    }

    return await this._handleControlMessage(message as JsonDict);
  }

  /**
   * Deserialize binary audio data to an InputAudioRawFrame.
   *
   * @param data Raw audio bytes (PCMU or L16).
   * @returns InputAudioRawFrame with PCM audio at pipeline sample rate.
   */
  protected async _deserializeAudio(data: Uint8Array): Promise<Frame | null> {
    if (!this._isOpen || this._isPaused) {
      return null;
    }

    let audioData = data;
    const originalLen = data.length;

    // If Genesys sends stereo audio (BOTH channels), extract only the external channel (left)
    // Stereo audio comes interleaved: [L0, R0, L1, R1, ...]
    if (this._params.channel === AudioHookChannel.BOTH && data.length > 0) {
      // For PCMU, each sample is 1 byte
      // Extract only bytes at even positions (left channel = external)
      audioData = new Uint8Array(Math.ceil(data.length / 2));
      for (let i = 0; i < data.length; i += 2) audioData[i / 2] = data[i] as number;
      logger.debug(
        `🔊 Stereo audio: ${originalLen} bytes → ${audioData.length} bytes (external channel)`,
      );
    }

    let deserializedData: Uint8Array;
    if (this._params.mediaFormat === AudioHookMediaFormat.PCMU) {
      // Convert μ-law at 8kHz to PCM at pipeline rate
      deserializedData = await ulawToPcm(
        audioData,
        this._genesysSampleRate,
        this._sampleRate,
        this._inputResampler,
      );
    } else {
      // L16 format
      logger.warning("L16 format not yet fully implemented");
      return null;
    }

    if (deserializedData == null || deserializedData.length === 0) {
      return null;
    }

    // Always use mono for STT - ElevenLabs expects single channel
    const numChannels = 1;

    const audioFrame = new InputAudioRawFrame({
      audio: deserializedData,
      numChannels,
      sampleRate: this._sampleRate,
    });

    return audioFrame;
  }

  /**
   * Handle a JSON control message from Genesys.
   *
   * @param message Parsed JSON message.
   * @returns Frame if the message should be passed to the pipeline, null otherwise.
   */
  protected async _handleControlMessage(message: JsonDict): Promise<Frame | null> {
    const msgType = dictGet(message, "type", "");
    this._clientSeq = dictGet(message, "seq", 0);

    // Update position if provided
    if ("position" in message) {
      this._position = this._parsePosition(message.position);
    }

    if (msgType === AudioHookMessageType.OPEN) {
      return await this._handleOpen(message);
    } else if (msgType === AudioHookMessageType.CLOSE) {
      return await this._handleClose(message);
    } else if (msgType === AudioHookMessageType.PING) {
      return await this._handlePing(message);
    } else if (msgType === AudioHookMessageType.PAUSE) {
      return await this._handlePause(message);
    } else if (msgType === AudioHookMessageType.UPDATE) {
      return await this._handleUpdate(message);
    } else if (msgType === AudioHookMessageType.ERROR) {
      return await this._handleError(message);
    } else if (msgType === "dtmf") {
      return await this._handleDtmf(message);
    } else if (msgType === "playback_started") {
      logger.debug("Playback started (from Genesys)");
      return null;
    } else if (msgType === "playback_completed") {
      logger.debug("Playback completed (from Genesys)");
      return null;
    } else {
      logger.warning(`Unknown AudioHook message type: ${pyStr(msgType)}`);
      return null;
    }
  }

  /**
   * Handle an 'open' message from Genesys.
   *
   * This initializes the session with metadata from Genesys Cloud and
   * automatically responds with an 'opened' message using the configured
   * InputParams (supportedLanguages, selectedLanguage, startPaused).
   *
   * Extracts and stores:
   * - sessionId: The AudioHook session identifier
   * - conversationId: The Genesys conversation ID
   * - participant: Caller info (ani, dnis, etc.)
   * - inputVariables: Custom variables from Architect flow
   * - mediaInfo: Audio configuration from Genesys
   *
   * @param message The open message from Genesys.
   * @returns OutputTransportMessageUrgentFrame with the 'opened' response.
   */
  protected async _handleOpen(message: JsonDict): Promise<Frame | null> {
    this._sessionId = dictGet(message, "id", crypto.randomUUID());

    const params = dictGet(message, "parameters", {});
    this._conversationId = dictGet(params, "conversationId");
    this._participant = dictGet(params, "participant");
    this._customConfig = dictGet(params, "customConfig");
    this._mediaInfo = dictGet(params, "media"); // This is a list of media objects
    this._inputVariables = dictGet(params, "inputVariables"); // Custom vars from Genesys

    // Extract media configuration if present
    // media is a list like: [{"type": "audio", "format": "PCMU", "channels": ["external"], "rate": 8000}]
    const mediaList: unknown = this._mediaInfo;
    if (truthy(mediaList) && Array.isArray(mediaList) && mediaList.length > 0) {
      const audioMedia: JsonDict = mediaList[0]; // Get first media entry
      const channels = dictGet(audioMedia, "channels", []);
      logger.debug(
        `📡 Genesys audio config: format=${pyStr(dictGet(audioMedia, "format"))}, channels=${pyStr(channels)}, rate=${pyStr(dictGet(audioMedia, "rate"))}`,
      );
      // channels is a list like ["external"] or ["external", "internal"]
      if (Array.isArray(channels)) {
        if (channels.includes("external") && channels.includes("internal")) {
          this._params.channel = AudioHookChannel.BOTH;
          logger.debug("📡 Stereo mode: extracting external channel");
        } else if (channels.includes("external")) {
          this._params.channel = AudioHookChannel.EXTERNAL;
          logger.debug("📡 Mono mode: external channel");
        } else if (channels.includes("internal")) {
          this._params.channel = AudioHookChannel.INTERNAL;
          logger.debug("📡 Mono mode: internal channel");
        }
      }
    }

    // Log participant info for debugging
    const ani = truthy(this._participant)
      ? dictGet(this._participant, "ani", "unknown")
      : "unknown";
    logger.info(
      `AudioHook open request: session=${pyStr(this._sessionId)}, ` +
        `conversation=${pyStr(this._conversationId)}, ani=${pyStr(ani)}`,
    );

    await this._callEventHandler("on_open", message);

    return new OutputTransportMessageUrgentFrame({
      message: this.createOpenedResponse({
        startPaused: this._params.startPaused,
        supportedLanguages: this._params.supportedLanguages,
        selectedLanguage: this._params.selectedLanguage,
      }),
    });
  }

  /**
   * Handle a 'close' message from Genesys.
   *
   * Automatically responds with a 'closed' message. If output variables were
   * set via setOutputVariables(), they will be included in the response and
   * made available in the Architect flow.
   *
   * @param message The close message from Genesys.
   * @returns OutputTransportMessageUrgentFrame with the closed response
   *   (includes outputVariables if set).
   */
  protected async _handleClose(message: JsonDict): Promise<Frame | null> {
    const params = dictGet(message, "parameters", {});
    const reason = dictGet(params, "reason", "unknown");

    logger.info(`🔴 Genesys closed the connection: ${pyStr(reason)}`);

    this._isOpen = false;

    logger.info("Sending closed response to Genesys...");

    await this._callEventHandler("on_close", message);

    // Return as urgent frame to be sent through pipeline immediately
    // Include any output variables that were set during the session
    return new OutputTransportMessageUrgentFrame({
      message: this.createClosedResponse(this._outputVariables),
    });
  }

  /**
   * Handle a 'ping' message from Genesys.
   *
   * Automatically responds with a 'pong' message to maintain the connection.
   *
   * @param message The ping message from Genesys.
   * @returns OutputTransportMessageUrgentFrame with pong response.
   */
  protected async _handlePing(message: JsonDict): Promise<Frame | null> {
    logger.info("Sending pong response to Genesys...");

    await this._callEventHandler("on_ping", message);

    // Return as urgent frame to be sent through pipeline immediately
    return new OutputTransportMessageUrgentFrame({ message: this.createPongResponse() });
  }

  /**
   * Handle a 'pause' message from Genesys.
   *
   * This is used when audio streaming is temporarily suspended (e.g., during
   * hold).
   *
   * @param message The pause message.
   * @returns null (response should be sent via createResumedResponse()).
   */
  protected async _handlePause(message: JsonDict): Promise<Frame | null> {
    const params = dictGet(message, "parameters", {});
    const reason = dictGet(params, "reason", "unknown");

    logger.info(`AudioHook pause request: reason=${pyStr(reason)}`);

    this._isPaused = true;

    await this._callEventHandler("on_pause", message);

    // Note: Application should call createResumedResponse() when ready
    return null;
  }

  /**
   * Handle an 'update' message from Genesys.
   *
   * Updates may include changes to participants or configuration.
   *
   * @param message The update message.
   * @returns null.
   */
  protected async _handleUpdate(message: JsonDict): Promise<Frame | null> {
    const params = dictGet(message, "parameters", {});

    if ("participant" in params) {
      this._participant = params.participant;
    }

    logger.debug(`AudioHook update received: ${pyStr(params)}`);

    await this._callEventHandler("on_update", message);

    return null;
  }

  /**
   * Handle an 'error' message from Genesys.
   *
   * @param message The error message.
   * @returns null.
   */
  protected async _handleError(message: JsonDict): Promise<Frame | null> {
    const params = dictGet(message, "parameters", {});
    const code = dictGet(params, "code", 0);
    const errorMsg = dictGet(params, "message", "Unknown error");

    logger.error(`AudioHook error from Genesys: ${pyStr(code)} - ${pyStr(errorMsg)}`);

    await this._callEventHandler("on_error", message);

    return null;
  }

  /**
   * Handle a 'dtmf' message from Genesys.
   *
   * DTMF (Dual-Tone Multi-Frequency) events are sent when the user presses
   * keys on their phone keypad.
   *
   * @param message The DTMF message.
   * @returns InputDTMFFrame with the pressed digit.
   */
  protected async _handleDtmf(message: JsonDict): Promise<Frame | null> {
    const params = dictGet(message, "parameters", {});
    const digit = dictGet(params, "digit", "");

    if (!truthy(digit)) {
      logger.warning("DTMF message received without digit");
      return null;
    }

    logger.info(`DTMF received: ${pyStr(digit)}`);

    await this._callEventHandler("on_dtmf", message);

    if (typeof digit !== "string" || !KEYPAD_VALUES.includes(digit)) {
      // Invalid digit
      logger.warning(`Invalid DTMF digit: ${pyStr(digit)}`);
      return null;
    }
    return new InputDTMFFrame({ button: digit as KeypadEntry });
  }
}
