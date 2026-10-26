// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Ducking: the bot's voice drops while the user talks over it, so it sounds
 * as if the bot heard them instead of talking on, until the overlap ends or
 * turns into an interruption.
 *
 * The output transport queues the bot's audio well before it plays, so the
 * volume can't be changed where the audio is produced. `AudioDuckingFilter` is
 * an output audio filter (`audioOutFilter`): the transport runs it on each
 * chunk as the chunk leaves, whatever the transport or serializer.
 * `AudioDuckingObserver` (its `observer`) watches the pipeline for the user's
 * voice activity and tells the filter when to duck.
 */

import { BaseAudioFilter } from "@pipedog/core/audio/filters/base_audio_filter";
import {
  BotStoppedSpeakingFrame,
  type FilterControlFrame,
  FilterEnableFrame,
  FilterUpdateSettingsFrame,
  InterruptionFrame,
  VADUserStartedSpeakingFrame,
  VADUserStoppedSpeakingFrame,
} from "@pipedog/core/frames/frames";
import { BaseObserver, type FramePushed } from "@pipedog/core/observers/base_observer";
import { logger } from "@pipedog/core/utils/logger";

/** The default gain while ducked: 35% of the normal volume. */
export const DEFAULT_DUCKED_GAIN = 0.35;

export interface AudioDuckingFilterOptions {
  /** Gain applied while ducked, 0.0 to 1.0. Defaults to 0.35. */
  duckedGain?: number;
  /** Whether ducking is initially enabled. Defaults to true. */
  enabled?: boolean;
}

/**
 * Output audio filter that lowers the bot's audio while ducked.
 *
 * Set it as `audioOutFilter` in the output transport's params, and add its
 * `observer` to the pipeline worker's observers, which ducks while the user
 * speaks (from `VADUserStartedSpeakingFrame`) and restores the volume when
 * they stop, when an interruption flushes the bot's speech, or when the bot
 * stops speaking. `duck()` and `restore()` can also be called directly.
 *
 * The gain changes over the first chunk after a change (a linear ramp), so
 * there is no click. Audio is 16-bit PCM; channels are scaled alike.
 *
 * Runtime settings: `FilterUpdateSettingsFrame({ settings: { duckedGain } })`,
 * and `FilterEnableFrame` turns ducking on and off.
 *
 * @example
 * const ducking = new AudioDuckingFilter({ duckedGain: 0.3 });
 * // Any transport: its params take the filter as audioOutFilter.
 * const params = new TransportParams({ audioOutEnabled: true, audioOutFilter: ducking });
 * const worker = new PipelineWorker(pipeline, { observers: [ducking.observer] });
 */
export class AudioDuckingFilter extends BaseAudioFilter {
  protected _duckedGain: number;
  protected _enabled: boolean;
  protected _ducked = false;
  // The gain the last chunk ended at.
  protected _gain = 1;

  /** The observer that ducks this filter from the pipeline's frames. */
  readonly observer: AudioDuckingObserver;

  constructor(options: AudioDuckingFilterOptions = {}) {
    super();
    this._duckedGain = checkGain(options.duckedGain ?? DEFAULT_DUCKED_GAIN);
    this._enabled = options.enabled ?? true;
    this.observer = new AudioDuckingObserver(this);
  }

  /** The gain applied while ducked. */
  get duckedGain(): number {
    return this._duckedGain;
  }

  /** Whether the audio is currently ducked. */
  get ducked(): boolean {
    return this._ducked;
  }

  /** Lower the volume, from the next chunk. */
  duck(): void {
    this._ducked = true;
  }

  /** Back to full volume, from the next chunk. */
  restore(): void {
    this._ducked = false;
  }

  async start(_sampleRate: number): Promise<void> {}

  async stop(): Promise<void> {}

  async processFrame(frame: FilterControlFrame): Promise<void> {
    if (frame instanceof FilterEnableFrame) {
      this._enabled = frame.enable;
    } else if (frame instanceof FilterUpdateSettingsFrame) {
      for (const [key, value] of Object.entries(frame.settings)) {
        if (key === "duckedGain" || key === "ducked_gain") {
          this._duckedGain = checkGain(Number(value));
        } else {
          logger.warning(`${this.constructor.name}: unknown setting ${key}`);
        }
      }
    }
  }

  async filter(audio: Uint8Array): Promise<Uint8Array> {
    const from = this._gain;
    const to = this._enabled && this._ducked ? this._duckedGain : 1;
    this._gain = to;
    if (from === 1 && to === 1) return audio;
    return scale(audio, from, to);
  }
}

/** Ducks an `AudioDuckingFilter` while voice activity says the user is talking. */
export class AudioDuckingObserver extends BaseObserver {
  readonly filter: AudioDuckingFilter;

  constructor(filter: AudioDuckingFilter) {
    // A frame's first push is enough: ducking only follows what happened.
    super({ observeEveryPush: false });
    this.filter = filter;
  }

  override acceptsPush(data: FramePushed): boolean {
    const frame = data.frame;
    return (
      frame instanceof VADUserStartedSpeakingFrame ||
      frame instanceof VADUserStoppedSpeakingFrame ||
      frame instanceof InterruptionFrame ||
      frame instanceof BotStoppedSpeakingFrame
    );
  }

  override async onPushFrame(data: FramePushed): Promise<void> {
    const frame = data.frame;
    if (frame instanceof VADUserStartedSpeakingFrame) {
      this.filter.duck();
    } else if (
      // The user stopped (an overlap that didn't interrupt), an interruption
      // flushed the bot's speech, or the bot stopped: what it says next plays
      // at full volume.
      frame instanceof VADUserStoppedSpeakingFrame ||
      frame instanceof InterruptionFrame ||
      frame instanceof BotStoppedSpeakingFrame
    ) {
      this.filter.restore();
    }
  }
}

function checkGain(gain: number): number {
  if (!Number.isFinite(gain) || gain < 0 || gain > 1) {
    throw new RangeError(`duckedGain must be between 0 and 1, got ${gain}`);
  }
  return gain;
}

/** Scale 16-bit little-endian PCM by a gain that moves linearly from `from` to `to`. */
function scale(audio: Uint8Array, from: number, to: number): Uint8Array {
  const samples = audio.byteLength >> 1;
  const input = new DataView(audio.buffer, audio.byteOffset, audio.byteLength);
  const out = new Uint8Array(audio.byteLength);
  const output = new DataView(out.buffer);
  for (let i = 0; i < samples; i++) {
    const gain = from + ((to - from) * (i + 1)) / samples;
    const sample = Math.round(input.getInt16(i * 2, true) * gain);
    output.setInt16(i * 2, sample < -32768 ? -32768 : sample > 32767 ? 32767 : sample, true);
  }
  // An odd trailing byte (half a sample) passes through.
  if (audio.byteLength & 1) out[audio.byteLength - 1] = audio[audio.byteLength - 1] as number;
  return out;
}
