// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/serializers/plivo.py

/** Plivo WebSocket frame serializer for audio streaming. */

import { abortable, currentSignal, rethrowIfCancelled } from "@pipedog/asyncio";
import { KeypadEntry } from "@pipedog/core/audio/dtmf/types";
import type { BaseAudioResampler } from "@pipedog/core/audio/resamplers/base_audio_resampler";
import { createStreamResampler, pcmToUlaw, ulawToPcm } from "@pipedog/core/audio/utils";
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
import { base64ToBytes, bytesToBase64 } from "@pipedog/core/utils/base64";
import { logger } from "@pipedog/core/utils/logger";
import { pyJsonDumps as jsonDumps, pyJsonLoads, pyNumberRepr } from "@pipedog/core/utils/py_json";

export interface PlivoFrameSerializerInputParamsOptions extends FrameSerializerInputParamsOptions {
  /** Sample rate used by Plivo, defaults to 8000 Hz. */
  plivoSampleRate?: number;
  /** Optional override for pipeline input sample rate. */
  sampleRate?: number | null;
  /** Whether to automatically terminate call on EndFrame. */
  autoHangUp?: boolean;
}

/**
 * Configuration parameters for PlivoFrameSerializer.
 *
 * - `plivoSampleRate`: Sample rate used by Plivo, defaults to 8000 Hz.
 * - `sampleRate`: Optional override for pipeline input sample rate.
 * - `autoHangUp`: Whether to automatically terminate call on EndFrame.
 * - `ignoreRtviMessages`: Inherited from base FrameSerializer, defaults to true.
 */
export class PlivoFrameSerializerInputParams extends FrameSerializerInputParams {
  plivoSampleRate: number;
  sampleRate: number | null;
  autoHangUp: boolean;

  constructor(options: PlivoFrameSerializerInputParamsOptions = {}) {
    super(options);
    this.plivoSampleRate = options.plivoSampleRate ?? 8000;
    this.sampleRate = options.sampleRate ?? null;
    this.autoHangUp = options.autoHangUp ?? true;
  }
}

export interface PlivoFrameSerializerOptions extends FrameSerializerOptions {
  /** The Plivo Stream ID. */
  streamId: string;
  /** The associated Plivo Call ID (optional, but required for auto hang-up). */
  callId?: string | null;
  /** Plivo auth ID (required for auto hang-up). */
  authId?: string | null;
  /** Plivo auth token (required for auto hang-up). */
  authToken?: string | null;
  /** Configuration parameters. */
  params?: PlivoFrameSerializerInputParams | null;
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
function dictGet(obj: unknown, key: string, defaultValue: unknown = null): unknown {
  if (!isRecord(obj)) {
    throw new TypeError(`'${pyTypeName(obj)}' object has no attribute 'get'`);
  }
  return key in obj ? obj[key] : defaultValue;
}

/** `aiohttp.BasicAuth(login, password).encode()`. */
function basicAuth(login: string, password: string): string {
  return `Basic ${bytesToBase64(new TextEncoder().encode(`${login}:${password}`))}`;
}

const KEYPAD_VALUES: readonly string[] = Object.values(KeypadEntry);

/**
 * Serializer for Plivo Audio Streaming WebSocket protocol.
 *
 * This serializer handles converting between Pipecat frames and Plivo's
 * WebSocket audio streaming protocol. It supports audio conversion, DTMF
 * events, and automatic call termination.
 *
 * When `autoHangUp` is enabled (default), the serializer will automatically
 * terminate the Plivo call when an EndFrame or CancelFrame is processed, but
 * requires Plivo credentials to be provided.
 */
export class PlivoFrameSerializer extends FrameSerializer {
  /** Upstream's nested `PlivoFrameSerializer.InputParams`. */
  static override InputParams = PlivoFrameSerializerInputParams;

  declare protected _params: PlivoFrameSerializerInputParams;

  protected _streamId: string;
  protected _callId: string | null;
  protected _authId: string | null;
  protected _authToken: string | null;
  protected _plivoSampleRate: number;
  protected _sampleRate: number;
  protected _inputResampler: BaseAudioResampler;
  protected _outputResampler: BaseAudioResampler;
  protected _hangupAttempted: boolean;

  /**
   * Initialize the PlivoFrameSerializer.
   *
   * @param options.streamId The Plivo Stream ID.
   * @param options.callId The associated Plivo Call ID (optional, but required for auto hang-up).
   * @param options.authId Plivo auth ID (required for auto hang-up).
   * @param options.authToken Plivo auth token (required for auto hang-up).
   * @param options.params Configuration parameters.
   * @throws Error If auto hang-up is on and credentials are missing.
   */
  constructor(options: PlivoFrameSerializerOptions) {
    const params = options.params || new PlivoFrameSerializerInputParams();
    super({ ...options, params });
    this._params = params;

    // Validate hangup-related parameters if auto_hang_up is enabled
    if (this._params.autoHangUp) {
      const missingCredentials: string[] = [];
      if (!options.callId) {
        missingCredentials.push("call_id");
      }
      if (!options.authId) {
        missingCredentials.push("auth_id");
      }
      if (!options.authToken) {
        missingCredentials.push("auth_token");
      }

      if (missingCredentials.length > 0) {
        throw new Error(
          `auto_hang_up is enabled but missing required parameters: ${missingCredentials.join(", ")}`,
        );
      }
    }

    this._streamId = options.streamId;
    this._callId = options.callId ?? null;
    this._authId = options.authId ?? null;
    this._authToken = options.authToken ?? null;

    this._plivoSampleRate = this._params.plivoSampleRate;
    this._sampleRate = 0; // Pipeline input rate

    this._inputResampler = createStreamResampler({
      clearAfterSecs: this._params.resamplerClearAfterSecs,
    });
    this._outputResampler = createStreamResampler({
      clearAfterSecs: this._params.resamplerClearAfterSecs,
    });
    this._hangupAttempted = false;
  }

  /**
   * Sets up the serializer with pipeline configuration.
   *
   * @param setup Configuration object containing setup parameters.
   */
  override async setup(setup: FrameProcessorSetup | unknown): Promise<void> {
    // `||` on purpose: upstream uses Python `or`, so a 0 sample rate falls through.
    this._sampleRate = this._params.sampleRate || (setup as FrameProcessorSetup).audioInSampleRate;
  }

  /**
   * Serializes a Pipecat frame to Plivo WebSocket format.
   *
   * Handles conversion of various frame types to Plivo WebSocket messages.
   * For EndFrames, initiates call termination if `autoHangUp` is enabled.
   *
   * @param frame The Pipecat frame to serialize.
   * @returns Serialized data as string or bytes, or null if the frame isn't handled.
   */
  async serialize(frame: Frame): Promise<SerializedData | null> {
    if (
      this._params.autoHangUp &&
      !this._hangupAttempted &&
      (frame instanceof EndFrame || frame instanceof CancelFrame)
    ) {
      this._hangupAttempted = true;
      await this._hangUpCall();
      return null;
    } else if (frame instanceof InterruptionFrame) {
      const answer = { event: "clearAudio", streamId: this._streamId };
      return jsonDumps(answer);
    } else if (frame instanceof AudioRawFrame) {
      const data = frame.audio;

      // Output: Convert PCM at frame's rate to 8kHz μ-law for Plivo
      const serializedData = await pcmToUlaw(
        data,
        frame.sampleRate,
        this._plivoSampleRate,
        this._outputResampler,
      );
      if (serializedData == null || serializedData.length === 0) {
        // Ignoring in case we don't have audio
        return null;
      }

      const payload = bytesToBase64(serializedData);
      const answer = {
        event: "playAudio",
        media: {
          contentType: "audio/x-mulaw",
          sampleRate: this._plivoSampleRate,
          payload,
        },
        streamId: this._streamId,
      };

      return jsonDumps(answer);
    } else if (
      frame instanceof OutputTransportMessageFrame ||
      frame instanceof OutputTransportMessageUrgentFrame
    ) {
      if (this.shouldIgnoreFrame(frame)) {
        return null;
      }
      return jsonDumps(frame.message);
    }

    // Return None for unhandled frames
    return null;
  }

  /** Hang up the Plivo call using Plivo's REST API. */
  protected async _hangUpCall(): Promise<void> {
    try {
      // The constructor guarantees these are non-null whenever autoHangUp is
      // true, which is the only path that reaches this method.
      const authId = this._authId as string;
      const authToken = this._authToken as string;
      const callId = this._callId as string;

      // Plivo API endpoint for hanging up calls
      const endpoint = `https://api.plivo.com/v1/Account/${authId}/Call/${callId}/`;

      // Basic auth from auth_id and auth_token
      const headers = { Authorization: basicAuth(authId, authToken) };

      // Make the DELETE request to hang up the call
      const response = await abortable(
        fetch(endpoint, { method: "DELETE", headers, signal: currentSignal() }),
      );
      if (response.status === 204) {
        // Plivo returns 204 for successful hangup
        logger.debug(`Successfully terminated Plivo call ${callId}`);
      } else if (response.status === 404) {
        // Call already ended
        logger.debug(`Plivo call ${callId} already terminated`);
        await abortable(response.body?.cancel() ?? Promise.resolve());
      } else {
        // Get the error details for better debugging
        const errorText = await abortable(response.text());
        logger.error(
          `Failed to terminate Plivo call ${callId}: ` +
            `Status ${response.status}, Response: ${errorText}`,
        );
      }
    } catch (e) {
      rethrowIfCancelled(e);
      logger.error(`Failed to hang up Plivo call: ${e instanceof Error ? e.message : e}`);
    }
  }

  /**
   * Deserializes Plivo WebSocket data to Pipecat frames.
   *
   * Handles conversion of Plivo media events to appropriate Pipecat frames.
   *
   * @param data The raw WebSocket data from Plivo.
   * @returns A Pipecat frame corresponding to the Plivo event, or null if unhandled.
   */
  async deserialize(data: SerializedData): Promise<Frame | null> {
    let message: unknown;
    try {
      const text = typeof data === "string" ? data : new TextDecoder().decode(data);
      message = pyJsonLoads(text);
    } catch (e) {
      rethrowIfCancelled(e);
      logger.warning(`Failed to parse JSON message: ${String(data)}`);
      return null;
    }

    // `dictGet` raises on a non-dict, as upstream's `.get()` does.
    const event = dictGet(message, "event");

    if (event === "media") {
      const media = dictGet(message, "media", {});
      const payloadBase64 = dictGet(media, "payload") as string | null;

      if (!payloadBase64) {
        return null;
      }

      const payload = base64ToBytes(payloadBase64);

      // Input: Convert Plivo's 8kHz μ-law to PCM at pipeline input rate
      const deserializedData = await ulawToPcm(
        payload,
        this._plivoSampleRate,
        this._sampleRate,
        this._inputResampler,
      );
      if (deserializedData == null || deserializedData.length === 0) {
        // Ignoring in case we don't have audio
        return null;
      }

      const audioFrame = new InputAudioRawFrame({
        audio: deserializedData,
        numChannels: 1,
        sampleRate: this._sampleRate,
      });
      return audioFrame;
    } else if (event === "dtmf") {
      const dtmfData = dictGet(message, "dtmf", {});
      const digit = dictGet(dtmfData, "digit");
      if (digit) {
        if (typeof digit !== "string" || !KEYPAD_VALUES.includes(digit)) {
          // Handle case where string doesn't match any enum value
          logger.warning(`Invalid DTMF digit received: ${pyStr(digit)}`);
          return null;
        }
        return new InputDTMFFrame({ button: digit as KeypadEntry });
      }
      return null;
    } else {
      return null;
    }
  }
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
