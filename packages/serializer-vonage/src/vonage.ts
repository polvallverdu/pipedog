// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/serializers/vonage.py

/** Vonage Audio Connector WebSocket serializer for Pipecat. */

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
import { logger } from "@pipedog/core/utils/logger";
import { pyJsonDumps as jsonDumps, pyJsonLoads, pyNumberRepr } from "@pipedog/core/utils/py_json";

export interface VonageFrameSerializerInputParamsOptions extends FrameSerializerInputParamsOptions {
  /**
   * Sample rate used by Vonage, defaults to 16000 Hz. Common values: 8000,
   * 16000, 24000 Hz.
   */
  vonageSampleRate?: number;
  /** Optional override for pipeline input sample rate. */
  sampleRate?: number | null;
}

/**
 * Configuration parameters for VonageFrameSerializer.
 *
 * - `vonageSampleRate`: Sample rate used by Vonage, defaults to 16000 Hz.
 *   Common values: 8000, 16000, 24000 Hz.
 * - `sampleRate`: Optional override for pipeline input sample rate.
 * - `ignoreRtviMessages`: Inherited from base FrameSerializer, defaults to true.
 */
export class VonageFrameSerializerInputParams extends FrameSerializerInputParams {
  vonageSampleRate: number;
  sampleRate: number | null;

  constructor(options: VonageFrameSerializerInputParamsOptions = {}) {
    super(options);
    this.vonageSampleRate = options.vonageSampleRate ?? 16000;
    this.sampleRate = options.sampleRate ?? null;
  }
}

export interface VonageFrameSerializerOptions extends FrameSerializerOptions {
  /** Configuration parameters. */
  params?: VonageFrameSerializerInputParams | null;
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

const KEYPAD_VALUES: readonly string[] = Object.values(KeypadEntry);

/**
 * Serializer for Vonage Video API Audio Connector WebSocket protocol.
 *
 * This serializer converts between Pipecat frames and the Vonage Audio
 * Connector WebSocket streaming protocol.
 *
 * Note: Ref docs: https://developer.vonage.com/en/video/guides/audio-connector
 */
export class VonageFrameSerializer extends FrameSerializer {
  /** Upstream's nested `VonageFrameSerializer.InputParams`. */
  static override InputParams = VonageFrameSerializerInputParams;

  declare protected _params: VonageFrameSerializerInputParams;

  protected _vonageSampleRate: number;
  protected _sampleRate: number;
  protected _inputResampler: BaseAudioResampler;
  protected _outputResampler: BaseAudioResampler;

  /**
   * Initialize the VonageFrameSerializer.
   *
   * @param options.params Configuration parameters.
   */
  constructor(options: VonageFrameSerializerOptions = {}) {
    const params = options.params || new VonageFrameSerializerInputParams();
    super({ ...options, params });
    this._params = params;

    this._vonageSampleRate = this._params.vonageSampleRate;
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
   * Serializes a Pipecat frame to Vonage WebSocket format.
   *
   * Handles conversion of various frame types to Vonage WebSocket messages.
   *
   * @param frame The Pipecat frame to serialize.
   * @returns Serialized data as string (JSON commands) or bytes (audio), or
   *   null if the frame isn't handled.
   */
  async serialize(frame: Frame): Promise<SerializedData | null> {
    if (frame instanceof InterruptionFrame) {
      // Clear the audio buffer to stop playback immediately
      const answer = { action: "clear" };
      return jsonDumps(answer);
    } else if (frame instanceof AudioRawFrame) {
      const data = frame.audio;

      // Output: Convert PCM at frame's rate to Vonage's sample rate (16-bit linear PCM)
      const serializedData = await this._outputResampler.resample(
        data,
        frame.sampleRate,
        this._vonageSampleRate,
      );
      if (serializedData == null || serializedData.length === 0) {
        // Ignoring in case we don't have audio
        return null;
      }

      // Vonage expects raw binary PCM data (not base64 encoded)
      return serializedData;
    } else if (
      frame instanceof OutputTransportMessageFrame ||
      frame instanceof OutputTransportMessageUrgentFrame
    ) {
      if (this.shouldIgnoreFrame(frame)) {
        return null;
      }
      // Allow sending custom JSON commands (e.g., notify)
      return jsonDumps(frame.message);
    }

    return null;
  }

  /**
   * Deserializes Vonage WebSocket data to Pipecat frames.
   *
   * Handles conversion of Vonage events to appropriate Pipecat frames.
   * - Binary messages contain audio data (16-bit linear PCM)
   * - Text messages contain JSON events (websocket:connected, websocket:cleared, dtmf, etc.)
   *
   * @param data The raw WebSocket data from Vonage.
   * @returns A Pipecat frame corresponding to the Vonage event, or null if unhandled.
   */
  async deserialize(data: SerializedData): Promise<Frame | null> {
    // Check if this is binary audio data
    if (data instanceof Uint8Array) {
      // Binary message = audio data (16-bit linear PCM)
      const payload = data;

      // Input: Convert Vonage's PCM audio to pipeline sample rate
      const deserializedData = await this._inputResampler.resample(
        payload,
        this._vonageSampleRate,
        this._sampleRate,
      );
      if (deserializedData == null || deserializedData.length === 0) {
        // Ignoring in case we don't have audio
        return null;
      }

      const audioFrame = new InputAudioRawFrame({
        audio: deserializedData,
        numChannels: 1, // Vonage uses mono audio
        sampleRate: this._sampleRate, // Use the configured pipeline input rate
      });
      return audioFrame;
    }

    // Text message = JSON event
    let message: unknown;
    try {
      message = pyJsonLoads(data);
    } catch (e) {
      rethrowIfCancelled(e);
      logger.warning(`Failed to parse JSON message from Vonage: ${data}`);
      return null;
    }
    // `dictGet` raises on a non-dict, as upstream's `.get()` does.
    const event = dictGet(message, "event");

    // Handle different event types
    if (event === "websocket:connected") {
      logger.debug(
        `Vonage WebSocket connected: content-type=${pyStr(dictGet(message, "content-type"))}`,
      );
      return null;
    } else if (event === "websocket:cleared") {
      logger.debug("Vonage audio buffer cleared");
      return null;
    } else if (event === "websocket:notify") {
      logger.debug(`Vonage notify event: ${pyStr(dictGet(message, "payload"))}`);
      return null;
    } else if (event === "websocket:dtmf") {
      // Handle DTMF input
      // Vonage may send digit in different formats, try both
      let digit = dictGet(message, "digit");
      if (!truthy(digit)) digit = dictGet(dictGet(message, "dtmf", {}), "digit");
      if (digit === null) {
        logger.warning(`DTMF event received but no digit found: ${pyRepr(message)}`);
        return null;
      }

      const digitStr = pyStr(digit);
      logger.debug(`Received DTMF digit: ${digitStr}`);
      if (!KEYPAD_VALUES.includes(digitStr)) {
        logger.warning(`Invalid DTMF digit received: ${digitStr}`);
        return null;
      }
      return new InputDTMFFrame({ button: digitStr as KeypadEntry });
    } else {
      logger.debug(`Vonage event: ${pyStr(event)}`);
      return null;
    }
  }
}
