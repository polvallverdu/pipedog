// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipecat-ts contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/transports/base_transport.py

/**
 * Base transport classes for Pipecat.
 *
 * This module provides the foundation for transport implementations including
 * parameter configuration and abstract base classes for input/output
 * transport functionality.
 */

import type { BaseAudioFilter } from "../audio/filters/base_audio_filter.ts";
import type { BaseAudioMixer } from "../audio/mixers/base_audio_mixer.ts";
import type { FrameProcessor } from "../processors/frame_processor.ts";
import { BaseObject } from "../utils/base_object.ts";
import { logger } from "../utils/logger.ts";

export interface VideoInSourceParamsOptions {
  /** Frames per second to pass on from this source (>= 1). */
  framerate?: number;
  /**
   * Pass on frames only to answer a `UserImageRequestFrame`, rather than
   * continuously at `framerate`.
   */
  onRequestOnly?: boolean;
}

/**
 * How a transport captures one video source from the user.
 *
 * - `framerate`: Frames per second to pass on from this source.
 * - `onRequestOnly`: Pass on frames only to answer a `UserImageRequestFrame`,
 *   rather than continuously at `framerate`.
 */
export class VideoInSourceParams {
  framerate: number;
  onRequestOnly: boolean;

  constructor(options: VideoInSourceParamsOptions = {}) {
    const framerate = options.framerate;
    if (framerate === 0) {
      throw new Error(
        "a framerate of 0 isn't a rate; use on_request_only=True to pass on " +
          "frames only to answer image requests",
      );
    }
    if (framerate !== undefined && framerate < 1) {
      throw new Error("framerate must be greater than or equal to 1");
    }
    this.framerate = framerate ?? 30;
    this.onRequestOnly = options.onRequestOnly ?? false;
    // Upstream checks whether `framerate` was explicitly set (pydantic's
    // `model_fields_set`).
    if (this.onRequestOnly && framerate !== undefined) {
      throw new Error("framerate doesn't apply when on_request_only=True");
    }
  }
}

/** A single mixer (for the default destination), or a destination/mixer mapping. */
export type AudioOutMixer = BaseAudioMixer | Map<string | null, BaseAudioMixer>;

export interface TransportParamsOptions {
  /** Enable audio output streaming. */
  audioOutEnabled?: boolean;
  /** Output audio sample rate in Hz. */
  audioOutSampleRate?: number | null;
  /** Number of output audio channels. */
  audioOutChannels?: number;
  /** Output audio bitrate in bits per second. */
  audioOutBitrate?: number;
  /** Number of 10ms chunks to buffer for output. */
  audioOut10msChunks?: number;
  /**
   * Audio filter to apply to output audio of the default destination, before
   * the mixer. Audio the transport generates itself (mixer audio, end
   * silence, DTMF tones) is not filtered.
   */
  audioOutFilter?: BaseAudioFilter | null;
  /**
   * Volume of the output audio, as a multiplier on its samples, applied after
   * the filter and before the mixer. A `VolumeFrame` changes it while the
   * transport runs, and a `VolumeGainFrame` adjusts it for some audio.
   */
  audioOutVolume?: number;
  /** Audio mixer instance or destination mapping. */
  audioOutMixer?: AudioOutMixer | null;
  /** List of audio output destination identifiers. */
  audioOutDestinations?: string[];
  /** How much silence (seconds) to send after an EndFrame (0 for no silence). */
  audioOutEndSilenceSecs?: number;
  /**
   * Insert silence frames when the audio output queue is empty. When false,
   * the transport will wait for audio data instead of inserting silence.
   */
  audioOutAutoSilence?: boolean;
  /**
   * How long (seconds) a single write to the transport may take before the
   * peer is considered gone. A client that stops reading leaves the write
   * waiting with nothing to fail, so it would otherwise never return.
   */
  audioOutWriteTimeoutSecs?: number;
  /** Enable audio input streaming. */
  audioInEnabled?: boolean;
  /** Input audio sample rate in Hz. */
  audioInSampleRate?: number | null;
  /** Number of input audio channels. */
  audioInChannels?: number;
  /** Audio filter to apply to input audio. */
  audioInFilter?: BaseAudioFilter | null;
  /** Start audio streaming immediately on transport start. */
  audioInStreamOnStart?: boolean;
  /** Pass through input audio frames downstream. */
  audioInPassthrough?: boolean;
  /** Enable video input streaming. */
  videoInEnabled?: boolean;
  /**
   * Video sources to capture from each user as they connect, keyed by source
   * (`"camera"`, `"screenVideo"`, or a transport-specific custom source).
   * Sources not listed here are captured only when the application asks for
   * them, e.g. with the transport's `captureParticipantVideo()`. Requires
   * `videoInEnabled`. Transports that don't support it log a warning and
   * ignore it, so check the logs if video doesn't arrive as configured.
   */
  videoInSources?: Record<string, VideoInSourceParams | VideoInSourceParamsOptions>;
  /** Enable video output streaming. */
  videoOutEnabled?: boolean;
  /** Enable real-time video output streaming. */
  videoOutIsLive?: boolean;
  /** Video output width in pixels. */
  videoOutWidth?: number;
  /** Video output height in pixels. */
  videoOutHeight?: number;
  /** Video output frame rate in FPS. */
  videoOutFramerate?: number;
  /** Video output color format string. */
  videoOutColorFormat?: string;
  /** Preferred video codec for output (e.g., 'VP8', 'H264', 'H265'). */
  videoOutCodec?: string | null;
  /** List of video output destination identifiers. */
  videoOutDestinations?: string[];
}

/**
 * Configuration parameters for transport implementations.
 *
 * See TransportParamsOptions for the meaning of each field.
 *
 * The deprecated `video_out_bitrate` parameter is not ported (use
 * provider-specific settings instead).
 */
export class TransportParams {
  audioOutEnabled: boolean;
  audioOutSampleRate: number | null;
  audioOutChannels: number;
  audioOutBitrate: number;
  audioOut10msChunks: number;
  audioOutFilter: BaseAudioFilter | null;
  audioOutVolume: number;
  audioOutMixer: AudioOutMixer | null;
  audioOutDestinations: string[];
  audioOutEndSilenceSecs: number;
  audioOutAutoSilence: boolean;
  audioOutWriteTimeoutSecs: number;
  audioInEnabled: boolean;
  audioInSampleRate: number | null;
  audioInChannels: number;
  audioInFilter: BaseAudioFilter | null;
  audioInStreamOnStart: boolean;
  audioInPassthrough: boolean;
  videoInEnabled: boolean;
  videoInSources: Record<string, VideoInSourceParams>;
  videoOutEnabled: boolean;
  videoOutIsLive: boolean;
  videoOutWidth: number;
  videoOutHeight: number;
  videoOutFramerate: number;
  videoOutColorFormat: string;
  videoOutCodec: string | null;
  videoOutDestinations: string[];

  constructor(options: TransportParamsOptions = {}) {
    this.audioOutEnabled = options.audioOutEnabled ?? false;
    this.audioOutSampleRate = options.audioOutSampleRate ?? null;
    this.audioOutChannels = options.audioOutChannels ?? 1;
    this.audioOutBitrate = options.audioOutBitrate ?? 96000;
    this.audioOut10msChunks = options.audioOut10msChunks ?? 4;
    this.audioOutFilter = options.audioOutFilter ?? null;
    this.audioOutVolume = options.audioOutVolume ?? 1.0;
    this.audioOutMixer = options.audioOutMixer ?? null;
    this.audioOutDestinations = options.audioOutDestinations ?? [];
    this.audioOutEndSilenceSecs = options.audioOutEndSilenceSecs ?? 2;
    this.audioOutAutoSilence = options.audioOutAutoSilence ?? true;
    this.audioOutWriteTimeoutSecs = options.audioOutWriteTimeoutSecs ?? 10.0;
    this.audioInEnabled = options.audioInEnabled ?? false;
    this.audioInSampleRate = options.audioInSampleRate ?? null;
    this.audioInChannels = options.audioInChannels ?? 1;
    this.audioInFilter = options.audioInFilter ?? null;
    this.audioInStreamOnStart = options.audioInStreamOnStart ?? true;
    this.audioInPassthrough = options.audioInPassthrough ?? true;
    this.videoInEnabled = options.videoInEnabled ?? false;
    // Like pydantic, plain option objects are validated into VideoInSourceParams.
    this.videoInSources = Object.fromEntries(
      Object.entries(options.videoInSources ?? {}).map(([source, params]) => [
        source,
        params instanceof VideoInSourceParams ? params : new VideoInSourceParams(params),
      ]),
    );
    this.videoOutEnabled = options.videoOutEnabled ?? false;
    this.videoOutIsLive = options.videoOutIsLive ?? false;
    this.videoOutWidth = options.videoOutWidth ?? 1024;
    this.videoOutHeight = options.videoOutHeight ?? 768;
    this.videoOutFramerate = options.videoOutFramerate ?? 30;
    this.videoOutColorFormat = options.videoOutColorFormat ?? "RGB";
    this.videoOutCodec = options.videoOutCodec ?? null;
    this.videoOutDestinations = options.videoOutDestinations ?? [];

    if (Object.keys(this.videoInSources).length > 0 && !this.videoInEnabled) {
      throw new Error("video_in_sources requires video_in_enabled=True");
    }
  }
}

export interface BaseTransportOptions {
  /** Optional name for the transport instance. */
  name?: string | null;
  /** Optional name for the input processor. */
  inputName?: string | null;
  /** Optional name for the output processor. */
  outputName?: string | null;
}

/**
 * Base class for transport implementations.
 *
 * Provides the foundation for transport classes that handle media streaming,
 * including input and output frame processors for audio and video data.
 */
export abstract class BaseTransport extends BaseObject {
  protected _inputName: string | null;
  protected _outputName: string | null;

  /**
   * Initialize the base transport.
   *
   * @param options.name Optional name for the transport instance.
   * @param options.inputName Optional name for the input processor.
   * @param options.outputName Optional name for the output processor.
   */
  constructor(options: BaseTransportOptions = {}) {
    super({ name: options.name ?? null });
    this._inputName = options.inputName ?? null;
    this._outputName = options.outputName ?? null;
  }

  /**
   * Get the input frame processor for this transport.
   *
   * @returns The frame processor that handles incoming frames.
   */
  abstract input(): FrameProcessor;

  /**
   * Get the output frame processor for this transport.
   *
   * @returns The frame processor that handles outgoing frames.
   */
  abstract output(): FrameProcessor;

  /**
   * Capture a participant's video source at a framerate.
   *
   * This captures a source on demand, where `TransportParams.videoInSources`
   * captures the listed sources as each user connects, and takes precedence
   * over it for the source. Transports that receive user video implement
   * this; the others log a warning.
   *
   * The deprecated use of a `framerate` of `0` (instead of `onRequestOnly`)
   * is not ported.
   *
   * @param participantId The participant to capture, as from `getClientId`.
   * @param framerate Frames per second to pass on, or `null` for every frame.
   *   It doesn't apply with `onRequestOnly`.
   * @param videoSource The video source, e.g. `"camera"` or `"screenVideo"`.
   * @param options.onRequestOnly Pass on only the frames that answer image requests.
   */
  async captureParticipantVideo(
    _participantId: string,
    _framerate: number | null = 30,
    _videoSource = "camera",
    _options: { onRequestOnly?: boolean } = {},
  ): Promise<void> {
    logger.warning(`${this}: capturing participant video isn't supported.`);
  }

  /**
   * The id of a client, as passed to `on_client_connected`.
   *
   * This is the `participantId` that `captureParticipantVideo` and image
   * requests take. Transports with client events implement this; the others
   * log a warning and return an empty string.
   *
   * @param client The client, as passed to the transport's client events.
   * @returns The client's id.
   */
  getClientId(_client: unknown): string {
    logger.warning(`${this}: getting a client id isn't supported.`);
    return "";
  }
}
