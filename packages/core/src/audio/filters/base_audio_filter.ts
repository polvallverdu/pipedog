// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/audio/filters/base_audio_filter.py

/**
 * Base audio filter interface for transport audio processing.
 *
 * Provides the abstract base class for implementing audio filters that
 * process audio data before VAD and downstream processing in input
 * transports, or before the mixer and the write in output transports.
 */

import type { FilterControlFrame } from "../../frames/frames.ts";

/**
 * Base class for transport audio filters.
 *
 * If an audio filter is provided to the input transport it will be used to
 * process audio before VAD and before pushing it downstream. If an audio
 * filter is provided to the output transport it will be used to process the
 * audio it receives before mixing and writing it. There are control frames to
 * update filter settings or to enable or disable the filter at runtime.
 */
export abstract class BaseAudioFilter {
  /**
   * Initialize the filter when the transport is set up.
   *
   * Called once, from the transport's setup, and paired with `stop()`. The
   * transport sample rate is provided so the filter can adjust to that
   * sample rate.
   *
   * @param sampleRate The sample rate of the transport in Hz.
   */
  abstract start(sampleRate: number): Promise<void>;

  /**
   * Clean up the filter when the transport is cleaned up.
   *
   * Called once, from the transport's cleanup, and paired with `start()`.
   */
  abstract stop(): Promise<void>;

  /**
   * Process control frames for runtime filter configuration.
   *
   * This will be called when the transport receives a FilterControlFrame.
   *
   * @param frame The control frame containing filter commands or settings.
   */
  abstract processFrame(frame: FilterControlFrame): Promise<void>;

  /**
   * Apply the audio filter to the provided audio data.
   *
   * @param audio Raw audio data to be filtered.
   * @returns Filtered audio data.
   */
  abstract filter(audio: Uint8Array): Promise<Uint8Array>;
}
