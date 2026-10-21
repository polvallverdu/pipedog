// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/serializers/exotel.py

/** Exotel Media Streams serializer for Pipecat. */

import { rethrowIfCancelled } from "@pipedog/asyncio";
import { KeypadEntry } from "@pipedog/core/audio/dtmf/types";
import type { BaseAudioResampler } from "@pipedog/core/audio/resamplers/base_audio_resampler";
import { createStreamResampler } from "@pipedog/core/audio/utils";
import {
  AudioRawFrame,
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

export interface ExotelFrameSerializerInputParamsOptions extends FrameSerializerInputParamsOptions {
  /** Sample rate used by Exotel, defaults to 8000 Hz. */
  exotelSampleRate?: number;
  /** Optional override for pipeline input sample rate. */
  sampleRate?: number | null;
}

/**
 * Configuration parameters for ExotelFrameSerializer.
 *
 * - `exotelSampleRate`: Sample rate used by Exotel, defaults to 8000 Hz.
 * - `sampleRate`: Optional override for pipeline input sample rate.
 * - `ignoreRtviMessages`: Inherited from base FrameSerializer, defaults to true.
 */
export class ExotelFrameSerializerInputParams extends FrameSerializerInputParams {
  exotelSampleRate: number;
  sampleRate: number | null;

  constructor(options: ExotelFrameSerializerInputParamsOptions = {}) {
    super(options);
    this.exotelSampleRate = options.exotelSampleRate ?? 8000;
    this.sampleRate = options.sampleRate ?? null;
  }
}

export interface ExotelFrameSerializerOptions extends FrameSerializerOptions {
  /** The Exotel Media Stream SID. */
  streamSid: string;
  /** The associated Exotel Call SID (optional, not used in this implementation). */
  callSid?: string | null;
  /** Configuration parameters. */
  params?: ExotelFrameSerializerInputParams | null;
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

const KEYPAD_VALUES: readonly string[] = Object.values(KeypadEntry);

/**
 * Serializer for Exotel Media Streams WebSocket protocol.
 *
 * This serializer handles converting between Pipecat frames and Exotel's
 * WebSocket media streams protocol. It supports audio conversion, DTMF events,
 * and automatic call termination.
 *
 * Note: Ref docs for events:
 * https://support.exotel.com/support/solutions/articles/3000108630-working-with-the-stream-and-voicebot-applet
 */
export class ExotelFrameSerializer extends FrameSerializer {
  /** Upstream's nested `ExotelFrameSerializer.InputParams`. */
  static override InputParams = ExotelFrameSerializerInputParams;

  declare protected _params: ExotelFrameSerializerInputParams;

  protected _streamSid: string;
  protected _callSid: string | null;
  protected _exotelSampleRate: number;
  protected _sampleRate: number;
  protected _inputResampler: BaseAudioResampler;
  protected _outputResampler: BaseAudioResampler;

  /**
   * Initialize the ExotelFrameSerializer.
   *
   * @param options.streamSid The Exotel Media Stream SID.
   * @param options.callSid The associated Exotel Call SID (optional, not used in this implementation).
   * @param options.params Configuration parameters.
   */
  constructor(options: ExotelFrameSerializerOptions) {
    const params = options.params || new ExotelFrameSerializerInputParams();
    super({ ...options, params });
    this._params = params;

    this._streamSid = options.streamSid;
    this._callSid = options.callSid ?? null;

    this._exotelSampleRate = this._params.exotelSampleRate;
    this._sampleRate = 0; // Pipeline input rate

    this._inputResampler = createStreamResampler({
      clearAfterSecs: this._params.resamplerClearAfterSecs,
    });
    this._outputResampler = createStreamResampler({
      clearAfterSecs: this._params.resamplerClearAfterSecs,
    });
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
   * Serializes a Pipecat frame to Exotel WebSocket format.
   *
   * Handles conversion of various frame types to Exotel WebSocket messages.
   *
   * @param frame The Pipecat frame to serialize.
   * @returns Serialized data as string or bytes, or null if the frame isn't handled.
   */
  async serialize(frame: Frame): Promise<SerializedData | null> {
    if (frame instanceof InterruptionFrame) {
      const answer = { event: "clear", stream_sid: this._streamSid };
      return jsonDumps(answer);
    } else if (frame instanceof AudioRawFrame) {
      const data = frame.audio;

      // Output: Exotel outputs PCM audio, but we need to resample to match requested sample_rate
      const serializedData = await this._outputResampler.resample(
        data,
        frame.sampleRate,
        this._exotelSampleRate,
      );
      if (serializedData == null || serializedData.length === 0) {
        // Ignoring in case we don't have audio
        return null;
      }

      const payload = bytesToBase64(serializedData);

      const answer = {
        event: "media",
        stream_sid: this._streamSid,
        media: { payload },
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

    return null;
  }

  /**
   * Deserializes Exotel WebSocket data to Pipecat frames.
   *
   * Handles conversion of Exotel media events to appropriate Pipecat frames.
   *
   * @param data The raw WebSocket data from Exotel.
   * @returns A Pipecat frame corresponding to the Exotel event, or null if unhandled.
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
      const payloadBase64 = dictGet(dictGet(message, "media", {}), "payload") as string | null;
      if (!payloadBase64) {
        return null;
      }
      const payload = base64ToBytes(payloadBase64);

      const deserializedData = await this._inputResampler.resample(
        payload,
        this._exotelSampleRate,
        this._sampleRate,
      );
      if (deserializedData == null || deserializedData.length === 0) {
        // Ignoring in case we don't have audio
        return null;
      }

      // Input: Exotel takes PCM data, so just resample to match sample_rate
      const audioFrame = new InputAudioRawFrame({
        audio: deserializedData,
        numChannels: 1, // Assuming mono audio from Exotel
        sampleRate: this._sampleRate, // Use the configured pipeline input rate
      });
      return audioFrame;
    } else if (event === "dtmf") {
      const digit = dictGet(dictGet(message, "dtmf", {}), "digit");

      if (typeof digit !== "string" || !KEYPAD_VALUES.includes(digit)) {
        // Handle case where string doesn't match any enum value
        logger.info(`Invalid DTMF digit: ${pyStr(digit)}`);
        return null;
      }
      return new InputDTMFFrame({ button: digit as KeypadEntry });
    }

    return null;
  }
}
