// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/processors/audio/audio_buffer_processor.py

/**
 * Audio buffer processor for managing and synchronizing audio streams.
 *
 * This module provides an AudioBufferProcessor that handles buffering and
 * synchronization of audio from both user input and bot output sources, with
 * support for various audio configurations and event-driven processing.
 */

import { monotonic } from "@pipedog/asyncio";
import type { BaseAudioResampler } from "../../audio/resamplers/base_audio_resampler.ts";
import { createStreamResampler, interleaveStereoAudio, mixAudio } from "../../audio/utils.ts";
import {
  AudioBufferStartRecordingFrame,
  AudioBufferStopRecordingFrame,
  BotStartedSpeakingFrame,
  BotStoppedSpeakingFrame,
  CancelFrame,
  EndFrame,
  type Frame,
  InputAudioRawFrame,
  OutputAudioRawFrame,
  StartFrame,
  UserStartedSpeakingFrame,
  UserStoppedSpeakingFrame,
} from "../../frames/frames.ts";
import { logger } from "../../utils/logger.ts";
import {
  type FrameDirection,
  FrameProcessor,
  type FrameProcessorOptions,
  type FrameProcessorSetup,
} from "../frame_processor.ts";

/**
 * A growable byte buffer, standing in for Python's `bytearray`: appends are
 * amortized and the buffer is mutated in place.
 */
export class ByteBuffer {
  #data: Uint8Array = new Uint8Array(0);
  #length = 0;

  get length(): number {
    return this.#length;
  }

  #reserve(extra: number): void {
    const needed = this.#length + extra;
    if (needed <= this.#data.length) return;
    const grown = new Uint8Array(Math.max(needed, this.#data.length * 2, 1024));
    grown.set(this.#data.subarray(0, this.#length));
    this.#data = grown;
  }

  /** Append `bytes` to the buffer. */
  extend(bytes: Uint8Array): void {
    this.#reserve(bytes.length);
    this.#data.set(bytes, this.#length);
    this.#length += bytes.length;
  }

  /** Append `count` zero bytes (silence) to the buffer. */
  extendZeros(count: number): void {
    if (count <= 0) return;
    this.#reserve(count);
    this.#data.fill(0, this.#length, this.#length + count);
    this.#length += count;
  }

  /** Drop the first `count` bytes. */
  discardFront(count: number): void {
    if (count <= 0) return;
    this.#data = this.#data.slice(count, this.#length);
    this.#length = this.#data.length;
  }

  /** A copy of the buffer's contents (Python `bytes(buffer)`). */
  bytes(): Uint8Array {
    return this.#data.slice(0, this.#length);
  }
}

/** Options for TurnAudioData. */
export interface TurnAudioDataOptions {
  /** The turn this audio belongs to. */
  turnNumber: number;
  /**
   * Everything the speaker said during the turn, as raw PCM, with the pauses
   * between their runs of speech left out.
   */
  audio: Uint8Array;
  /** Sample rate of the audio in Hz. */
  sampleRate: number;
  /** Number of channels in the audio. */
  numChannels: number;
}

/**
 * One speaker's audio for one conversation turn.
 *
 * - `turnNumber`: the turn this audio belongs to.
 * - `audio`: everything the speaker said during the turn, as raw PCM, with
 *   the pauses between their runs of speech left out.
 * - `sampleRate`: sample rate of the audio in Hz.
 * - `numChannels`: number of channels in the audio.
 */
export class TurnAudioData {
  turnNumber: number;
  audio: Uint8Array;
  sampleRate: number;
  numChannels: number;

  constructor(options: TurnAudioDataOptions) {
    this.turnNumber = options.turnNumber;
    this.audio = options.audio;
    this.sampleRate = options.sampleRate;
    this.numChannels = options.numChannels;
  }
}

export interface AudioBufferProcessorOptions extends FrameProcessorOptions {
  /** Desired output sample rate. If null, uses source rate. */
  sampleRate?: number | null;
  /** Number of channels (1 for mono, 2 for stereo). Defaults to 1. */
  numChannels?: number;
  /** Size of buffer before triggering events. 0 for no buffering. */
  bufferSize?: number;
  /** Whether turn audio event handlers should be triggered. */
  enableTurnAudio?: boolean;
  /**
   * Whether to start recording automatically when the pipeline starts,
   * without requiring a call to `startRecording()` or an
   * `AudioBufferStartRecordingFrame`.
   */
  autoStartRecording?: boolean;
}

/**
 * Processes and buffers audio frames from both input (user) and output (bot)
 * sources.
 *
 * This processor manages audio buffering and synchronization, providing both
 * merged and track-specific audio access through event handlers. It supports
 * various audio configurations including sample rate conversion and
 * mono/stereo output.
 *
 * Events:
 *
 * - on_audio_data: triggered when bufferSize is reached, providing merged audio
 * - on_track_audio_data: triggered when bufferSize is reached, providing
 *   separate tracks
 * - on_user_turn_audio: triggered when a turn ends, providing a
 *   TurnAudioData with everything the user said during it
 * - on_bot_turn_audio: triggered when a turn ends, providing a TurnAudioData
 *   with everything the bot said during it
 * - on_recording_started: triggered when recording starts (state transitions
 *   to active)
 * - on_recording_stopped: triggered after recording stops and the final audio
 *   has been emitted
 *
 * Audio handling:
 *
 * - Mono output (numChannels=1): user and bot audio are mixed
 * - Stereo output (numChannels=2): user audio on left, bot audio on right
 * - Automatic resampling of incoming audio to match desired sampleRate
 * - Silence insertion for non-continuous audio streams
 * - Buffer synchronization between user and bot audio
 */
export class AudioBufferProcessor extends FrameProcessor {
  protected _initSampleRate: number | null;
  protected _sampleRate = 0;
  protected _audioBufferSize1s = 0;
  protected _numChannels: number;
  protected _bufferSize: number;
  protected _enableTurnAudio: boolean;
  protected _autoStartRecording: boolean;

  protected _userAudioBuffer = new ByteBuffer();
  protected _botAudioBuffer = new ByteBuffer();

  protected _userSpeaking = false;
  protected _botSpeaking = false;
  // Audio for the run of speech in progress, folded into the turn buffer
  // once the speaker stops.
  protected _userTurnAudioBuffer = new ByteBuffer();
  protected _botTurnAudioBuffer = new ByteBuffer();
  // Everything each speaker has said so far in the current turn.
  protected _userTurnAudio = new ByteBuffer();
  protected _botTurnAudio = new ByteBuffer();
  protected _turnTrackerAttached = false;

  protected _recording = false;

  protected _inputResampler: BaseAudioResampler;
  protected _outputResampler: BaseAudioResampler;
  protected _lastUserBufferUpdateTime: number | null = null;
  protected _lastBotBufferUpdateTime: number | null = null;

  /**
   * Initialize the audio buffer processor.
   *
   * @param options.sampleRate Desired output sample rate. If null, uses
   *   source rate.
   * @param options.numChannels Number of channels (1 for mono, 2 for stereo).
   *   Defaults to 1.
   * @param options.bufferSize Size of buffer before triggering events. 0 for
   *   no buffering.
   * @param options.enableTurnAudio Whether turn audio event handlers should
   *   be triggered.
   * @param options.autoStartRecording Whether to start recording
   *   automatically when the pipeline starts, without requiring a call to
   *   `startRecording()` or an `AudioBufferStartRecordingFrame`. Other options
   *   are passed to the parent class.
   */
  constructor(options: AudioBufferProcessorOptions = {}) {
    super(options);
    this._initSampleRate = options.sampleRate ?? null;
    this._numChannels = options.numChannels ?? 1;
    this._bufferSize = options.bufferSize ?? 0;
    this._enableTurnAudio = options.enableTurnAudio ?? false;
    this._autoStartRecording = options.autoStartRecording ?? false;

    this._inputResampler = createStreamResampler();
    this._outputResampler = createStreamResampler();

    this._registerEventHandler("on_audio_data");
    this._registerEventHandler("on_track_audio_data");
    this._registerEventHandler("on_user_turn_audio");
    this._registerEventHandler("on_bot_turn_audio");
    this._registerEventHandler("on_recording_started");
    this._registerEventHandler("on_recording_stopped");
  }

  /** Current sample rate of the audio processor, in Hz. */
  get sampleRate(): number {
    return this._sampleRate;
  }

  /** Number of channels in the audio output (1 for mono, 2 for stereo). */
  get numChannels(): number {
    return this._numChannels;
  }

  /**
   * Check if either user or bot audio buffers contain data.
   *
   * @returns True if either buffer contains audio data.
   */
  hasAudio(): boolean {
    return (
      this._bufferHasAudio(this._userAudioBuffer) || this._bufferHasAudio(this._botAudioBuffer)
    );
  }

  /**
   * Merge user and bot audio buffers into a single audio stream.
   *
   * For mono output, audio is mixed. For stereo output, user audio is placed
   * on the left channel and bot audio on the right channel.
   *
   * @returns Mixed audio data as bytes.
   */
  mergeAudioBuffers(): Uint8Array {
    if (this._numChannels === 1) {
      return mixAudio(this._userAudioBuffer.bytes(), this._botAudioBuffer.bytes());
    } else if (this._numChannels === 2) {
      return interleaveStereoAudio(this._userAudioBuffer.bytes(), this._botAudioBuffer.bytes());
    } else {
      return new Uint8Array(0);
    }
  }

  /**
   * Set up the processor.
   *
   * @param setup Configuration object containing setup parameters.
   */
  override async setup(setup: FrameProcessorSetup): Promise<void> {
    await super.setup(setup);
    this._sampleRate = this._initSampleRate || setup.audioOutSampleRate;
    this._audioBufferSize1s = this._sampleRate * 2;
  }

  /**
   * Start recording audio from both user and bot.
   *
   * Initializes recording state, resets audio buffers and triggers the
   * `on_recording_started` event. Does nothing when recording is already
   * active.
   */
  async startRecording(): Promise<void> {
    if (this._recording) {
      return;
    }
    this._recording = true;
    this._resetRecording();
    await this._callEventHandler("on_recording_started");
  }

  /**
   * Stop recording and trigger final audio data handlers.
   *
   * Calls audio handlers with any remaining buffered audio before stopping,
   * then triggers the `on_recording_stopped` event. Does nothing when
   * recording is not active.
   */
  async stopRecording(): Promise<void> {
    if (!this._recording) {
      return;
    }
    await this._callOnAudioDataHandler();
    this._resetRecording(false);
    this._recording = false;
    await this._callEventHandler("on_recording_stopped");
  }

  /**
   * Process incoming audio frames and manage audio buffers.
   *
   * @param frame The frame to process.
   * @param direction The direction of frame flow in the pipeline.
   */
  override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
    await super.processFrame(frame, direction);

    if (frame instanceof StartFrame) {
      if (this._enableTurnAudio) {
        this._attachTurnTracker();
      }
      if (this._autoStartRecording) {
        await this.startRecording();
      }
    }

    if (frame instanceof AudioBufferStartRecordingFrame) {
      await this.startRecording();
    } else if (frame instanceof AudioBufferStopRecordingFrame) {
      await this.stopRecording();
    }

    if (this._recording) {
      await this._processRecording(frame);
    }

    if (frame instanceof CancelFrame || frame instanceof EndFrame) {
      await this.stopRecording();
    }

    await this.pushFrame(frame, direction);
  }

  /** Process audio frames for recording. */
  protected async _processRecording(frame: Frame): Promise<void> {
    // Track speaking state here (not just in _processTurnRecording) so the
    // silence-injection guards below work regardless of enableTurnAudio.
    if (frame instanceof UserStartedSpeakingFrame) {
      this._userSpeaking = true;
    } else if (frame instanceof UserStoppedSpeakingFrame) {
      this._userSpeaking = false;
    } else if (frame instanceof BotStartedSpeakingFrame) {
      this._botSpeaking = true;
    } else if (frame instanceof BotStoppedSpeakingFrame) {
      this._botSpeaking = false;
    }

    let resampled: Uint8Array | null = null;
    if (frame instanceof InputAudioRawFrame) {
      resampled = await this._resampleInputAudio(frame);
      // Ignoring in case we don't have audio
      if (resampled.length > 0) {
        const now = monotonic();
        // Insert silence for any wall-clock gap since the user buffer was
        // last written (covers muted microphone and other silent periods).
        this._fillBufferSilenceGap(
          this._userAudioBuffer,
          this._lastUserBufferUpdateTime,
          now,
          resampled.length,
        );
        this._lastUserBufferUpdateTime = now;
        // Sync bot buffer to current user position before adding user audio.
        // We sync BEFORE extending to align both buffers at the same starting timestamp.
        // For example, user buffer is at 100 bytes, and you receive 20 bytes of new audio
        //  - Bot buffer sees User is at 100. Bot pads itself to 100.
        //  - User buffer adds 20. User is now at 120.
        //  - Outcome: At index 100-120, we have User Audio and (potentially) Bot Audio or silence. They are aligned
        // This gives the opportunity to the bot to send audio.
        //
        // If we synced AFTER, we'd pad the bot buffer with silence for the same
        // window we just gave to the user, effectively "overwriting" that time slot
        // with silence and causing the bot's audio to flicker or cut out.
        //
        // Skip silence injection if the bot is actively speaking to avoid
        // inserting silence in the middle of a bot utterance (causes crackling).
        if (!this._botSpeaking) {
          this._syncBufferToPosition(this._botAudioBuffer, this._userAudioBuffer.length);
          // Advance the bot timestamp so that when bot audio resumes we
          // only fill the gap *after* this user frame, not all the way
          // back to the last bot frame (which would double-count
          // silence already injected by the sync above).
          this._lastBotBufferUpdateTime = monotonic();
        }
        // Add user audio.
        this._userAudioBuffer.extend(resampled);
      }
    } else if (frame instanceof OutputAudioRawFrame) {
      resampled = await this._resampleOutputAudio(frame);
      // Ignoring in case we don't have audio
      if (resampled.length > 0) {
        const now = monotonic();
        // Insert silence for any wall-clock gap since the bot buffer was
        // last written (covers idle periods between bot utterances, e.g.
        // while a slow function call runs).
        this._fillBufferSilenceGap(
          this._botAudioBuffer,
          this._lastBotBufferUpdateTime,
          now,
          resampled.length,
        );
        this._lastBotBufferUpdateTime = now;
        // Sync user buffer to current bot position before adding bot audio.
        // Skip silence injection if the user is actively speaking to avoid
        // inserting silence in the middle of a user utterance (causes crackling).
        if (!this._userSpeaking) {
          this._syncBufferToPosition(this._userAudioBuffer, this._botAudioBuffer.length);
          // Advance the timestamp so that when user audio resumes we
          // only fill the gap *after* the last bot frame, not all the
          // way back to the last user frame (which would double-count
          // silence already injected by the sync above).
          this._lastUserBufferUpdateTime = monotonic();
        }
        // Add bot audio.
        this._botAudioBuffer.extend(resampled);
      }
    }

    if (
      this._bufferSize > 0 &&
      (this._userAudioBuffer.length >= this._bufferSize ||
        this._botAudioBuffer.length >= this._bufferSize)
    ) {
      await this._callOnAudioDataHandler();
      this._resetPrimaryAudioBuffers();
    }

    // Process turn recording with preprocessed data.
    if (this._enableTurnAudio) {
      await this._processTurnRecording(frame, resampled);
    }
  }

  /**
   * Pad buffer with silence if it's behind the target position.
   *
   * This ensures both buffers stay synchronized by padding the lagging
   * buffer before new audio is added to the other buffer.
   *
   * @param buffer The buffer to potentially pad.
   * @param targetPosition The position (in bytes) the buffer should reach.
   */
  protected _syncBufferToPosition(buffer: ByteBuffer, targetPosition: number): void {
    const currentLen = buffer.length;
    if (currentLen < targetPosition) {
      const silenceNeeded = targetPosition - currentLen;
      buffer.extendZeros(silenceNeeded);
    }
  }

  /**
   * Insert silence into a buffer when a wall-clock gap is detected.
   *
   * Called before adding new audio to a buffer. Compares the elapsed
   * wall-clock time since the buffer was last written against the duration
   * of the incoming frame. Any excess time (e.g., a muted mic or an idle
   * period between bot utterances) is filled with silence so the recorded
   * utterances remain temporally separated.
   *
   * @param buffer The audio buffer to pad (user or bot).
   * @param lastUpdateTime Monotonic time of the last write to this buffer, or
   *   null if the buffer has never been written.
   * @param now Current monotonic time.
   * @param frameBytes Byte length of the incoming (resampled) audio frame.
   */
  protected _fillBufferSilenceGap(
    buffer: ByteBuffer,
    lastUpdateTime: number | null,
    now: number,
    frameBytes: number,
  ): void {
    if (lastUpdateTime === null || this._sampleRate === 0) {
      return;
    }

    const elapsed = now - lastUpdateTime;
    const frameDuration = frameBytes / (this._sampleRate * 2);
    const gap = elapsed - frameDuration;

    if (gap > 0.2) {
      // 200 ms threshold — safely above normal jitter
      let silenceBytes = Math.trunc(gap * this._sampleRate * 2);
      silenceBytes -= silenceBytes % 2; // keep 16-bit alignment
      if (silenceBytes > 0) {
        buffer.extendZeros(silenceBytes);
      }
    }
  }

  /** Process frames for turn-based audio recording. */
  protected async _processTurnRecording(
    frame: Frame,
    resampledAudio: Uint8Array | null = null,
  ): Promise<void> {
    // Speaking state (_userSpeaking / _botSpeaking) is maintained by
    // _processRecording so it is always up-to-date here.
    if (frame instanceof UserStoppedSpeakingFrame) {
      this._endUserRun();
    } else if (frame instanceof BotStoppedSpeakingFrame) {
      this._endBotRun();
    }

    if (frame instanceof InputAudioRawFrame && resampledAudio && resampledAudio.length > 0) {
      this._userTurnAudioBuffer.extend(resampledAudio);
      // In the case of the user, we need to keep a short buffer of audio
      // since VAD notification of when the user starts speaking comes
      // later.
      if (!this._userSpeaking && this._userTurnAudioBuffer.length > this._audioBufferSize1s) {
        const discarded = this._userTurnAudioBuffer.length - this._audioBufferSize1s;
        this._userTurnAudioBuffer.discardFront(discarded);
      }
    } else if (
      this._botSpeaking &&
      frame instanceof OutputAudioRawFrame &&
      resampledAudio &&
      resampledAudio.length > 0
    ) {
      this._botTurnAudioBuffer.extend(resampledAudio);
    }
  }

  /** Emit turn audio when the pipeline's turn tracker ends a turn. */
  protected _attachTurnTracker(): void {
    if (this._turnTrackerAttached) {
      return;
    }

    const worker = this.pipelineWorker;
    const turnTracker = worker ? worker.turnTrackingObserver : null;
    if (turnTracker === null) {
      logger.warning(
        `${this}: enableTurnAudio is set but turn tracking is off, so no turn audio ` +
          "will be reported. Construct the pipeline worker with enableTurnTracking: true.",
      );
      return;
    }

    turnTracker.addEventHandler(
      "on_turn_ended",
      async (_tracker: unknown, turnNumber: number, _duration: number, _interrupted: boolean) => {
        await this._emitTurnAudio(turnNumber);
      },
    );

    this._turnTrackerAttached = true;
  }

  /** Fold the user's finished run of speech into the current turn. */
  protected _endUserRun(): void {
    this._userTurnAudio.extend(this._userTurnAudioBuffer.bytes());
    this._userTurnAudioBuffer = new ByteBuffer();
  }

  /** Fold the bot's finished run of speech into the current turn. */
  protected _endBotRun(): void {
    this._botTurnAudio.extend(this._botTurnAudioBuffer.bytes());
    this._botTurnAudioBuffer = new ByteBuffer();
  }

  /** Report each speaker's audio for a turn that just ended. */
  protected async _emitTurnAudio(turnNumber: number): Promise<void> {
    // A barge-in ends the turn before the bot stops, so the bot's last run is
    // closed here. Closing the user's would pull the start of their
    // interruption into the turn it interrupted.
    this._endBotRun();

    const userAudio = this._userTurnAudio;
    const botAudio = this._botTurnAudio;
    this._userTurnAudio = new ByteBuffer();
    this._botTurnAudio = new ByteBuffer();

    if (userAudio.length > 0) {
      await this._callEventHandler(
        "on_user_turn_audio",
        new TurnAudioData({
          turnNumber,
          audio: userAudio.bytes(),
          sampleRate: this.sampleRate,
          numChannels: 1,
        }),
      );
    }
    if (botAudio.length > 0) {
      await this._callEventHandler(
        "on_bot_turn_audio",
        new TurnAudioData({
          turnNumber,
          audio: botAudio.bytes(),
          sampleRate: this.sampleRate,
          numChannels: 1,
        }),
      );
    }
  }

  /** Call the audio data event handlers with buffered audio. */
  protected async _callOnAudioDataHandler(): Promise<void> {
    if (!this._recording) {
      return;
    }

    if (this._userAudioBuffer.length === 0 && this._botAudioBuffer.length === 0) {
      return;
    }

    // Final alignment before we send the audio
    this._alignTrackBuffers();

    // Call original handler with merged audio
    const mergedAudio = this.mergeAudioBuffers();
    await this._callEventHandler("on_audio_data", mergedAudio, this._sampleRate, this._numChannels);

    // Call new handler with separate tracks
    await this._callEventHandler(
      "on_track_audio_data",
      this._userAudioBuffer.bytes(),
      this._botAudioBuffer.bytes(),
      this._sampleRate,
      this._numChannels,
    );
  }

  /** Check if a buffer contains audio data. */
  protected _bufferHasAudio(buffer: ByteBuffer | null): boolean {
    return buffer !== null && buffer.length > 0;
  }

  /** Reset recording state and buffers. */
  protected _resetRecording(clearTurnAudio = true): void {
    this._resetAllAudioBuffers(clearTurnAudio);
    this._lastUserBufferUpdateTime = null;
    this._lastBotBufferUpdateTime = null;
  }

  /** Reset all audio buffers to empty state. */
  protected _resetAllAudioBuffers(clearTurnAudio = true): void {
    this._resetPrimaryAudioBuffers();
    if (clearTurnAudio) {
      this._resetTurnAudioBuffers();
    }
  }

  /** Clear user and bot buffers while preserving turn buffers and timestamps. */
  protected _resetPrimaryAudioBuffers(): void {
    this._userAudioBuffer = new ByteBuffer();
    this._botAudioBuffer = new ByteBuffer();
    const now = monotonic();
    this._lastUserBufferUpdateTime = now;
    this._lastBotBufferUpdateTime = now;
  }

  /** Clear user and bot turn buffers while preserving primary buffers and timestamps. */
  protected _resetTurnAudioBuffers(): void {
    this._userTurnAudioBuffer = new ByteBuffer();
    this._botTurnAudioBuffer = new ByteBuffer();
    this._userTurnAudio = new ByteBuffer();
    this._botTurnAudio = new ByteBuffer();
  }

  /** Pad the shorter track with silence so both tracks stay in sync. */
  protected _alignTrackBuffers(): void {
    const userLen = this._userAudioBuffer.length;
    const botLen = this._botAudioBuffer.length;
    if (userLen === botLen) {
      return;
    }

    const targetLen = Math.max(userLen, botLen);
    if (userLen < targetLen) {
      this._syncBufferToPosition(this._userAudioBuffer, targetLen);
    }
    if (botLen < targetLen) {
      this._syncBufferToPosition(this._botAudioBuffer, targetLen);
    }
  }

  /** Resample audio frame to the target sample rate. */
  protected async _resampleInputAudio(frame: InputAudioRawFrame): Promise<Uint8Array> {
    return await this._inputResampler.resample(frame.audio, frame.sampleRate, this._sampleRate);
  }

  /** Resample audio frame to the target sample rate. */
  protected async _resampleOutputAudio(frame: OutputAudioRawFrame): Promise<Uint8Array> {
    return await this._outputResampler.resample(frame.audio, frame.sampleRate, this._sampleRate);
  }
}
