// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/serializers/telnyx.py

/** Telnyx WebSocket frame serializer for Pipecat. */

import { abortable, currentSignal, rethrowIfCancelled } from "@pipedog/asyncio";
import { KeypadEntry } from "@pipedog/core/audio/dtmf/types";
import type { BaseAudioResampler } from "@pipedog/core/audio/resamplers/base_audio_resampler";
import {
  alawToPcm,
  createStreamResampler,
  pcmToAlaw,
  pcmToUlaw,
  ulawToPcm,
} from "@pipedog/core/audio/utils";
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
import { pyJsonDumps as jsonDumps, pyJsonLoads } from "@pipedog/core/utils/py_json";

export interface TelnyxFrameSerializerInputParamsOptions extends FrameSerializerInputParamsOptions {
  /** Sample rate used by Telnyx, defaults to 8000 Hz. */
  telnyxSampleRate?: number;
  /** Optional override for pipeline input sample rate. */
  sampleRate?: number | null;
  /** Audio encoding for data sent to Telnyx (e.g., "PCMU"). */
  inboundEncoding?: string;
  /** Audio encoding for data received from Telnyx (e.g., "PCMU"). */
  outboundEncoding?: string;
  /** Whether to automatically terminate call on EndFrame. */
  autoHangUp?: boolean;
}

/**
 * Configuration parameters for TelnyxFrameSerializer.
 *
 * - `telnyxSampleRate`: Sample rate used by Telnyx, defaults to 8000 Hz.
 * - `sampleRate`: Optional override for pipeline input sample rate.
 * - `inboundEncoding`: Audio encoding for data sent to Telnyx (e.g., "PCMU").
 * - `outboundEncoding`: Audio encoding for data received from Telnyx (e.g., "PCMU").
 * - `autoHangUp`: Whether to automatically terminate call on EndFrame.
 */
export class TelnyxFrameSerializerInputParams extends FrameSerializerInputParams {
  telnyxSampleRate: number;
  sampleRate: number | null;
  inboundEncoding: string;
  outboundEncoding: string;
  autoHangUp: boolean;

  constructor(options: TelnyxFrameSerializerInputParamsOptions = {}) {
    super(options);
    this.telnyxSampleRate = options.telnyxSampleRate ?? 8000;
    this.sampleRate = options.sampleRate ?? null;
    this.inboundEncoding = options.inboundEncoding ?? "PCMU";
    this.outboundEncoding = options.outboundEncoding ?? "PCMU";
    this.autoHangUp = options.autoHangUp ?? true;
  }
}

export interface TelnyxFrameSerializerOptions extends FrameSerializerOptions {
  /** The Stream ID for Telnyx. */
  streamId: string;
  /** The encoding type for outbound audio (e.g., "PCMU"). */
  outboundEncoding: string;
  /** The encoding type for inbound audio (e.g., "PCMU"). */
  inboundEncoding: string;
  /** The Call Control ID for the Telnyx call (optional, but required for auto hang-up). */
  callControlId?: string | null;
  /** Your Telnyx API key (required for auto hang-up). */
  apiKey?: string | null;
  /** Configuration parameters. */
  params?: TelnyxFrameSerializerInputParams | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Python `obj.get(key, default)`: raises when `obj` is not a dict. */
function dictGet(obj: unknown, key: string, defaultValue: unknown = null): unknown {
  if (!isRecord(obj)) {
    throw new TypeError(
      `'${obj === null ? "NoneType" : typeof obj}' object has no attribute 'get'`,
    );
  }
  return key in obj ? obj[key] : defaultValue;
}

const KEYPAD_VALUES: readonly string[] = Object.values(KeypadEntry);

/**
 * Serializer for Telnyx WebSocket protocol.
 *
 * This serializer handles converting between Pipecat frames and Telnyx's
 * WebSocket media streams protocol. It supports audio conversion, DTMF
 * events, and automatic call termination.
 *
 * When `autoHangUp` is enabled (default), the serializer will automatically
 * terminate the Telnyx call when an EndFrame or CancelFrame is processed, but
 * requires Telnyx credentials to be provided.
 */
export class TelnyxFrameSerializer extends FrameSerializer {
  /** Upstream's nested `TelnyxFrameSerializer.InputParams`. */
  static override InputParams = TelnyxFrameSerializerInputParams;

  declare protected _params: TelnyxFrameSerializerInputParams;

  protected _streamId: string;
  protected _callControlId: string | null;
  protected _apiKey: string | null;
  protected _telnyxSampleRate: number;
  protected _sampleRate: number;
  protected _inputResampler: BaseAudioResampler;
  protected _outputResampler: BaseAudioResampler;
  protected _hangupAttempted: boolean;

  /**
   * Initialize the TelnyxFrameSerializer.
   *
   * @param options.streamId The Stream ID for Telnyx.
   * @param options.outboundEncoding The encoding type for outbound audio (e.g., "PCMU").
   * @param options.inboundEncoding The encoding type for inbound audio (e.g., "PCMU").
   * @param options.callControlId The Call Control ID for the Telnyx call (optional, but
   *   required for auto hang-up).
   * @param options.apiKey Your Telnyx API key (required for auto hang-up).
   * @param options.params Configuration parameters.
   */
  constructor(options: TelnyxFrameSerializerOptions) {
    const params = options.params || new TelnyxFrameSerializerInputParams();
    super({ ...options, params });
    this._params = params;

    // Validate hangup-related parameters if auto_hang_up is enabled
    if (this._params.autoHangUp) {
      const missingCredentials: string[] = [];
      if (!options.callControlId) {
        missingCredentials.push("call_control_id");
      }
      if (!options.apiKey) {
        missingCredentials.push("api_key");
      }

      if (missingCredentials.length > 0) {
        throw new Error(
          `auto_hang_up is enabled but missing required parameters: ${missingCredentials.join(", ")}`,
        );
      }
    }

    this._streamId = options.streamId;
    this._callControlId = options.callControlId ?? null;
    this._apiKey = options.apiKey ?? null;
    this._params.outboundEncoding = options.outboundEncoding;
    this._params.inboundEncoding = options.inboundEncoding;

    this._telnyxSampleRate = this._params.telnyxSampleRate;
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
   * Serializes a Pipecat frame to Telnyx WebSocket format.
   *
   * Handles conversion of various frame types to Telnyx WebSocket messages.
   * For EndFrames and CancelFrames, initiates call termination if
   * `autoHangUp` is enabled.
   *
   * @param frame The Pipecat frame to serialize.
   * @returns Serialized data as string or bytes, or null if the frame isn't handled.
   * @throws Error If an unsupported encoding is specified.
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
      const answer = { event: "clear" };
      return jsonDumps(answer);
    } else if (frame instanceof AudioRawFrame) {
      const data = frame.audio;

      // Output: Convert PCM at frame's rate to 8kHz encoded for Telnyx
      let serializedData: Uint8Array;
      if (this._params.inboundEncoding === "PCMU") {
        serializedData = await pcmToUlaw(
          data,
          frame.sampleRate,
          this._telnyxSampleRate,
          this._outputResampler,
        );
      } else if (this._params.inboundEncoding === "PCMA") {
        serializedData = await pcmToAlaw(
          data,
          frame.sampleRate,
          this._telnyxSampleRate,
          this._outputResampler,
        );
      } else {
        throw new Error(`Unsupported encoding: ${this._params.inboundEncoding}`);
      }

      if (serializedData == null || serializedData.length === 0) {
        // Ignoring in case we don't have audio
        return null;
      }

      const payload = bytesToBase64(serializedData);
      const answer = {
        event: "media",
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

    // Return None for unhandled frames
    return null;
  }

  /** Hang up the Telnyx call using Telnyx's REST API. */
  protected async _hangUpCall(): Promise<void> {
    try {
      // The constructor guarantees these are non-null whenever autoHangUp is
      // true, which is the only path that reaches this method.
      const callControlId = this._callControlId as string;
      const apiKey = this._apiKey as string;

      // Telnyx API endpoint for hanging up a call
      const endpoint = `https://api.telnyx.com/v2/calls/${callControlId}/actions/hangup`;

      // Set headers with API key
      const headers = { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` };

      // Make the POST request to hang up the call
      const response = await abortable(
        fetch(endpoint, { method: "POST", headers, signal: currentSignal() }),
      );
      if (response.status === 200) {
        logger.info(`Successfully terminated Telnyx call ${callControlId}`);
      } else if (response.status === 422) {
        // A fetch body can only be read once (aiohttp caches it), so read the
        // text first and parse the JSON from it.
        const errorText = await abortable(response.text());

        // Handle the case where the call has already ended
        // Error code 90018: "Call has already ended"
        // Source: https://developers.telnyx.com/api/errors/90018
        try {
          const errorData: unknown = pyJsonLoads(errorText);
          // `dictGet` raises like upstream's `.get()` on a non-dict, which
          // falls through below (and stops `any()` at that element).
          const errors = dictGet(errorData, "errors", []);
          if (Array.isArray(errors) && errors.some((error) => dictGet(error, "code") === "90018")) {
            logger.debug(`Telnyx call ${callControlId} was already terminated`);
            return;
          }
        } catch (e) {
          rethrowIfCancelled(e);
          // Fall through to log the raw error
        }

        // Log other 422 errors
        logger.error(
          `Failed to terminate Telnyx call ${callControlId}: ` +
            `Status ${response.status}, Response: ${errorText}`,
        );
      } else {
        // Log other errors
        const errorText = await abortable(response.text());
        logger.error(
          `Failed to terminate Telnyx call ${callControlId}: ` +
            `Status ${response.status}, Response: ${errorText}`,
        );
      }
    } catch (e) {
      rethrowIfCancelled(e);
      logger.error(`Failed to hang up Telnyx call: ${e instanceof Error ? e.message : e}`);
    }
  }

  /**
   * Deserializes Telnyx WebSocket data to Pipecat frames.
   *
   * Handles conversion of Telnyx media events to appropriate Pipecat frames,
   * including audio data and DTMF keypresses.
   *
   * @param data The raw WebSocket data from Telnyx.
   * @returns A Pipecat frame corresponding to the Telnyx event, or null if unhandled.
   * @throws Error If an unsupported encoding is specified.
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

      // Input: Convert Telnyx's 8kHz encoded audio to PCM at pipeline input rate
      let deserializedData: Uint8Array;
      if (this._params.outboundEncoding === "PCMU") {
        deserializedData = await ulawToPcm(
          payload,
          this._telnyxSampleRate,
          this._sampleRate,
          this._inputResampler,
        );
      } else if (this._params.outboundEncoding === "PCMA") {
        deserializedData = await alawToPcm(
          payload,
          this._telnyxSampleRate,
          this._sampleRate,
          this._inputResampler,
        );
      } else {
        throw new Error(`Unsupported encoding: ${this._params.outboundEncoding}`);
      }

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
      const digit = dictGet(dictGet(message, "dtmf", {}), "digit");

      if (typeof digit !== "string" || !KEYPAD_VALUES.includes(digit)) {
        // Handle case where string doesn't match any enum value
        return null;
      }
      return new InputDTMFFrame({ button: digit as KeypadEntry });
    } else {
      return null;
    }
  }
}
