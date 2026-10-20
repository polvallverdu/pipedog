// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/utils/context/audio_context_manager.py

/** Audio contexts a TTS service plays one after another. */

import { Queue, waitFor } from "@pipedog/asyncio";
import { Frame, TTSAudioRawFrame, TTSStoppedFrame } from "../../frames/frames.ts";
import { FrameQueue } from "../frame_queue.ts";

export interface AudioContextFrameOptions {
  /** The audio context to play. */
  contextId: string;
}

/**
 * Marks where an audio context plays among the queued frames.
 *
 * - `contextId`: the audio context to play.
 */
export class AudioContextFrame extends Frame {
  contextId: string;

  constructor(options: AudioContextFrameOptions) {
    super(options);
    this.contextId = options.contextId;
  }
}

/** The bytes of a sample split across audio chunks, with their format. */
interface AudioRemainder {
  audio: Uint8Array;
  sampleRate: number;
  numChannels: number;
}

const KEEPALIVE: unique symbol = Symbol("AudioContextManager.KEEPALIVE");

/** An item queued on an audio context: audio, other frames, word timestamps... `null` ends it. */
export type AudioContextItem = unknown;

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/**
 * Audio contexts and frames, played in the order they are queued.
 *
 * Each audio context has its own queue of items (audio, other frames, word
 * timestamps), so a context's audio can arrive while an earlier one is still
 * playing. `nextForPlayback` returns the next context or frame to play, and
 * `get` returns a context's items until the context ends.
 *
 * `playingContextId` is the context `nextForPlayback` returned last. The
 * caller sets it back to `null` when that context stops playing.
 */
export class AudioContextManager {
  protected _contexts = new Map<string, Queue<AudioContextItem>>();
  // Trailing bytes of a sample split across audio chunks, per context.
  protected _remainders = new Map<string, AudioRemainder>();
  // Contexts and frames in play order. null ends playback.
  protected _queue = new FrameQueue<Frame | null>((item) => (item instanceof Frame ? item : null));
  playingContextId: string | null = null;

  /** The audio contexts that haven't finished playing. */
  get contextIds(): string[] {
    return [...this._contexts.keys()];
  }

  /**
   * Whether an audio context exists and hasn't finished playing.
   *
   * @param contextId The audio context to check.
   */
  available(contextId: string): boolean {
    return this._contexts.has(contextId);
  }

  /**
   * Create an audio context and queue it to play after what's already queued.
   *
   * @param contextId The audio context to create.
   * @param options.interruptible Whether `reset` drops the context while it
   *   waits to play. Defaults to true.
   */
  async create(contextId: string, options: { interruptible?: boolean } = {}): Promise<void> {
    this._contexts.set(contextId, new Queue());
    const frame = new AudioContextFrame({ contextId });
    frame.interruptible = options.interruptible ?? true;
    await this._queue.put(frame);
  }

  /**
   * Append an item to an audio context. `null` ends the context.
   *
   * Audio is trimmed to whole samples, and a split sample is carried to the
   * context's next audio frame. Providers may cut their PCM stream at any
   * byte, but consumers read audio frame by frame.
   *
   * @param contextId The audio context to append to. It must exist.
   * @param item The item to append, or `null` to end the context.
   */
  async append(contextId: string, item: AudioContextItem): Promise<void> {
    if (item instanceof TTSAudioRawFrame && !this._alignAudioFrame(contextId, item)) {
      return;
    }
    // The context's audio ends here, so a held-back partial sample is
    // queued before the stop frame (or the end marker) that follows it.
    if (item === null || item instanceof TTSStoppedFrame) {
      await this._flushAudioRemainder(contextId);
    }
    await this.#context(contextId).put(item);
  }

  /**
   * Restart the wait of `get` for an audio context, if it exists.
   *
   * @param contextId The audio context still in use.
   */
  keepalive(contextId: string): void {
    if (this.available(contextId)) {
      this.#context(contextId).putNowait(KEEPALIVE);
    }
  }

  /**
   * Queue a frame to play after what's already queued.
   *
   * @param frame The frame to queue.
   */
  async putFrame(frame: Frame): Promise<void> {
    await this._queue.put(frame);
  }

  /** End playback once everything already queued has played. */
  async endPlayback(): Promise<void> {
    await this._queue.put(null);
  }

  /**
   * Wait for the next audio context or frame to play.
   *
   * Contexts removed before they play are skipped.
   *
   * @returns An `AudioContextFrame`, whose context becomes the playing one,
   *   another queued frame, or `null` when playback ends.
   */
  async nextForPlayback(): Promise<Frame | null> {
    let item = await this._nextQueued();
    while (item instanceof AudioContextFrame && !this.available(item.contextId)) {
      item = await this._nextQueued();
    }
    if (item instanceof AudioContextFrame) {
      this.playingContextId = item.contextId;
    }
    return item;
  }

  /**
   * Return an audio context's next item, waiting up to `timeout` for it.
   *
   * A keepalive restarts the wait and is not returned.
   *
   * @param contextId The audio context to read.
   * @param timeout Seconds to wait for an item.
   * @returns The next item, or `null` when the context ends.
   * @throws TimeoutError If no item arrives in time.
   */
  async get(contextId: string, timeout: number): Promise<AudioContextItem> {
    const queue = this.#context(contextId);
    let item: AudioContextItem = KEEPALIVE;
    while (item === KEEPALIVE) {
      item = await waitFor(() => queue.get(), timeout);
    }
    return item;
  }

  /**
   * Remove an audio context and its queued items.
   *
   * @param contextId The audio context to remove.
   */
  remove(contextId: string): void {
    this._contexts.delete(contextId);
    this._remainders.delete(contextId);
  }

  /**
   * Drop the frames and contexts waiting to play, except uninterruptible ones.
   *
   * The dropped contexts stay available until they are removed.
   */
  reset(): void {
    this._queue.reset();
  }

  /** Take the next item in play order. */
  protected async _nextQueued(): Promise<Frame | null> {
    const item = await this._queue.get();
    this._queue.taskDone();
    return item;
  }

  /**
   * Trim an audio frame to whole samples, carrying a split sample forward.
   *
   * @returns False if the frame holds less than one whole sample and should
   *   be dropped, true otherwise.
   */
  protected _alignAudioFrame(contextId: string, frame: TTSAudioRawFrame): boolean {
    const blockSize = 2 * Math.max(frame.numChannels, 1);
    const remainder = this._remainders.get(contextId);
    this._remainders.delete(contextId);
    if (!remainder && frame.audio.length % blockSize === 0) {
      return true;
    }
    const audio = remainder ? concatBytes(remainder.audio, frame.audio) : frame.audio;
    const alignedLength = audio.length - (audio.length % blockSize);
    if (alignedLength < audio.length) {
      this._remainders.set(contextId, {
        audio: audio.slice(alignedLength),
        sampleRate: frame.sampleRate,
        numChannels: frame.numChannels,
      });
    }
    if (alignedLength) {
      frame.audio = audio.slice(0, alignedLength);
      frame.numFrames = Math.trunc(alignedLength / blockSize);
    }
    return alignedLength > 0;
  }

  /** Queue a context's held-back partial sample, zero-padded to a whole one. */
  protected async _flushAudioRemainder(contextId: string): Promise<void> {
    const remainder = this._remainders.get(contextId);
    this._remainders.delete(contextId);
    if (!remainder) {
      return;
    }
    const blockSize = 2 * Math.max(remainder.numChannels, 1);
    let audio = remainder.audio;
    if (audio.length < blockSize) {
      const padded = new Uint8Array(blockSize);
      padded.set(audio, 0);
      audio = padded;
    }
    const frame = new TTSAudioRawFrame({
      audio,
      sampleRate: remainder.sampleRate,
      numChannels: remainder.numChannels,
      contextId,
    });
    await this.#context(contextId).put(frame);
  }

  #context(contextId: string): Queue<AudioContextItem> {
    const queue = this._contexts.get(contextId);
    if (!queue) {
      // Upstream raises KeyError.
      throw new Error(`KeyError: '${contextId}'`);
    }
    return queue;
  }
}
