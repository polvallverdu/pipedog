// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/audio/mixers/base_audio_mixer.py

/**
 * Base audio mixer for output transport integration.
 *
 * Provides the abstract base class for audio mixers that can be integrated
 * with output transports to mix incoming audio with generated audio from the
 * mixer.
 */

import type { MixerControlFrame } from "../../frames/frames.ts";

/**
 * Base class for output transport audio mixers.
 *
 * If an audio mixer is provided to the output transport it will be used to
 * mix the audio frames coming into to the transport with the audio generated
 * from the mixer. There are control frames to update mixer settings or to
 * enable or disable the mixer at runtime.
 */
export abstract class BaseAudioMixer {
  /**
   * Initialize the mixer when the output transport starts.
   *
   * This will be called from the output transport when the transport is
   * started. It can be used to initialize the mixer. The output transport
   * sample rate is provided so the mixer can adjust to that sample rate.
   *
   * @param sampleRate The sample rate of the output transport in Hz.
   */
  abstract start(sampleRate: number): Promise<void>;

  /**
   * Clean up the mixer when the output transport stops.
   *
   * This will be called from the output transport when the transport is
   * stopping.
   */
  abstract stop(): Promise<void>;

  /**
   * Process mixer control frames from the transport.
   *
   * This will be called when the output transport receives a
   * MixerControlFrame.
   *
   * @param frame The mixer control frame to process.
   */
  abstract processFrame(frame: MixerControlFrame): Promise<void>;

  /**
   * Mix transport audio with mixer-generated audio.
   *
   * This is called with the audio that is about to be sent from the output
   * transport and that should be mixed with the mixer audio if the mixer is
   * enabled.
   *
   * @param audio Raw audio bytes from the transport to mix.
   * @returns Mixed audio bytes combining transport and mixer audio.
   */
  abstract mix(audio: Uint8Array): Promise<Uint8Array>;
}
