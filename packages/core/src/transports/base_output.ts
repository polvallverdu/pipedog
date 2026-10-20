// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/transports/base_output.py

/**
 * Base output transport implementation for Pipecat.
 *
 * This module provides the BaseOutputTransport class which handles audio and
 * video output processing, including frame buffering, mixing, timing, and
 * media streaming.
 */

import {
  abortable,
  pythonCompare,
  Queue,
  QueueEmpty,
  rethrowIfCancelled,
  sleep,
  type Task,
  TimeoutError,
  time,
  waitFor,
} from "@pipedog/asyncio";
import { loadDtmfAudio } from "../audio/dtmf/utils.ts";
import type { BaseAudioFilter } from "../audio/filters/base_audio_filter.ts";
import type { BaseAudioMixer } from "../audio/mixers/base_audio_mixer.ts";
import type { BaseAudioResampler } from "../audio/resamplers/base_audio_resampler.ts";
import { createStreamResampler, isSilence, scaleAudio } from "../audio/utils.ts";
import {
  AssistantImageRawFrame,
  BotSpeakingFrame,
  BotStartedSpeakingFrame,
  BotStoppedSpeakingFrame,
  CancelFrame,
  EndFrame,
  FilterControlFrame,
  type Frame,
  InterruptionFrame,
  MixerControlFrame,
  OutputAudioRawFrame,
  OutputDTMFFrame,
  OutputDTMFUrgentFrame,
  OutputImageRawFrame,
  OutputTransportMessageFrame,
  OutputTransportMessageUrgentFrame,
  OutputTransportReadyFrame,
  SpeechOutputAudioRawFrame,
  SpriteFrame,
  StartFrame,
  SystemFrame,
  TTSAudioRawFrame,
  TTSStoppedFrame,
  VolumeFrame,
  VolumeGainFrame,
} from "../frames/frames.ts";
import { BotCapabilities } from "../pipeline/capabilities.ts";
import {
  FrameDirection,
  FrameProcessor,
  type FrameProcessorOptions,
  type FrameProcessorSetup,
} from "../processors/frame_processor.ts";
import { FramePriorityQueue, FrameQueue } from "../utils/frame_queue.ts";
import { logger } from "../utils/logger.ts";
import { nanosecondsToSeconds } from "../utils/time.ts";
import type { TransportParams } from "./base_transport.ts";

export const BOT_VAD_STOP_SECS = 0.35;
/** Only used as a fallback. */
export const BOT_VAD_STOP_FALLBACK_SECS = 3;

/** An OutputAudioRawFrame subclass, so chunks keep the type of the audio they came from. */
type OutputAudioFrameClass = new (options: {
  audio: Uint8Array;
  sampleRate: number;
  numChannels: number;
}) => OutputAudioRawFrame;

/** A clock queue item: (presentation timestamp, insertion counter, frame). */
type ClockItem = [number, number, Frame];

/** A run of buffered audio from frames with the same `interruptible` flag. */
type AudioRun = [Uint8Array, boolean];

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/** itertools.cycle() */
function* cycle<T>(items: T[]): Generator<T, void, undefined> {
  if (items.length === 0) return;
  for (;;) {
    for (const item of items) yield item;
  }
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export interface MediaSenderOptions {
  /** The destination identifier for this sender. */
  destination: string | null;
  /** The audio sample rate in Hz. */
  sampleRate: number;
  /** The size of audio chunks in bytes. */
  audioChunkSize: number;
  /** Transport configuration parameters. */
  params: TransportParams;
}

/**
 * Handles media streaming for a specific destination.
 *
 * Manages audio and video output processing including buffering, timing,
 * mixing, and frame delivery for a single output destination.
 *
 * Upstream this is the nested class `BaseOutputTransport.MediaSender`, which
 * is also reachable here as `BaseOutputTransport.MediaSender`.
 */
export class MediaSender {
  protected _transport: BaseOutputTransport;
  protected _destination: string | null;
  protected _sampleRate: number;
  protected _audioChunkSize: number;
  protected _params: TransportParams;

  // Incoming audio waiting to be cut into chunks, as runs of audio that came
  // from frames with the same `interruptible` flag, so a chunk keeps the flag
  // of the audio it holds, along with the type of the frames it was built
  // from (so a flushed partial chunk can be reconstructed as the same frame
  // type).
  protected _audioRuns: AudioRun[] = [];
  protected _audioBufferCls: OutputAudioFrameClass = OutputAudioRawFrame;

  // This will be used to resample incoming audio to the output sample rate.
  // Speech boundaries are signalled explicitly (see
  // `_enqueueFlushedAudioBuffer` and `_botStoppedSpeaking`), so the resampler
  // must not discard its filter tail on its own: it runs ahead of playback and
  // would otherwise treat the pause between two TTS chunks as the end of the
  // stream.
  protected _resampler: BaseAudioResampler = createStreamResampler({ clearAfterSecs: null });

  // The user can provide a single mixer, to be used by the default
  // destination, or a destination/mixer mapping.
  protected _mixer: BaseAudioMixer | null = null;

  // The output filter belongs to the default destination, like a single mixer.
  protected _filter: BaseAudioFilter | null;

  // The output volume (VolumeFrame) and the gain on it (VolumeGainFrame),
  // updated in order with the audio.
  protected _volume: number;
  protected _volumeGain = 1.0;

  // These are the images that we should send at our desired framerate.
  protected _videoImages: Iterator<OutputImageRawFrame> | null = null;

  // Indicates if the bot is currently speaking.
  protected _botSpeaking = false;
  // Indicates if TTS audio has been received since the last stop.
  protected _ttsAudioReceived = false;
  // Last time a BotSpeakingFrame was pushed.
  protected _botSpeakingFrameTime = 0;
  // How often a BotSpeakingFrame should be pushed (value should be greater
  // than the audio chunks to have any effect).
  protected _botSpeakingFramePeriod = 0.2;
  // Last time the bot actually spoke.
  protected _botSpeechLastTime = 0;

  protected _audioTask: Task<unknown> | null = null;
  protected _videoTask: Task<unknown> | null = null;
  protected _clockTask: Task<unknown> | null = null;

  // Created with their tasks (see `_createAudioTask` / `_createVideoTask`).
  protected _audioQueue: FrameQueue<Frame> = new FrameQueue<Frame>();
  protected _videoQueue: Queue<OutputImageRawFrame> = new Queue<OutputImageRawFrame>();

  // Timed frames as (timestamp, counter, frame), ordered by presentation
  // time. It outlives the clock task so an interruption can keep its
  // uninterruptible frames.
  protected _clockQueue = new FramePriorityQueue<ClockItem>(
    (item) => item[2],
    (a, b) => pythonCompare([a[0], a[1]], [b[0], b[1]]),
  );
  // The frame the clock task is waiting to push.
  protected _clockFrame: Frame | null = null;

  // If timestamps are equal, use this count to preserve the insertion order.
  protected _clockQueueCounter = 0;

  // Live video timing state, initialized by the video task.
  protected _videoStartTime: number | null = null;
  protected _videoFrameIndex = 0;
  protected _videoFrameDuration = 0;
  protected _videoFrameReset = 0;

  /**
   * Initialize the media sender.
   *
   * @param transport The parent transport instance.
   * @param options.destination The destination identifier for this sender.
   * @param options.sampleRate The audio sample rate in Hz.
   * @param options.audioChunkSize The size of audio chunks in bytes.
   * @param options.params Transport configuration parameters.
   */
  constructor(transport: BaseOutputTransport, options: MediaSenderOptions) {
    this._transport = transport;
    this._destination = options.destination;
    this._sampleRate = options.sampleRate;
    this._audioChunkSize = options.audioChunkSize;
    this._params = options.params;

    // Upstream resizes images in a single-worker thread pool; there are no
    // threads here, so resizing runs inline (see `_resizeImage`).

    this._filter = options.destination ? null : options.params.audioOutFilter;
    this._volume = options.params.audioOutVolume;
  }

  /** The audio sample rate in Hz. */
  get sampleRate(): number {
    return this._sampleRate;
  }

  /** The size of audio chunks in bytes. */
  get audioChunkSize(): number {
    return this._audioChunkSize;
  }

  /**
   * Start the media sender and initialize components.
   *
   * @param frame The start frame containing initialization parameters.
   */
  async start(_frame: StartFrame): Promise<void> {
    this._clearAudioBuffer();

    // Create all tasks.
    this._createVideoTask();
    this._createClockTask();
    this._createAudioTask();

    // Check if we have an audio mixer for our destination.
    const mixer = this._params.audioOutMixer;
    if (mixer) {
      if (mixer instanceof Map) {
        this._mixer = mixer.get(this._destination) ?? null;
      } else if (!this._destination) {
        // Only use the default mixer if we are the default destination.
        this._mixer = mixer;
      }
    }

    // Start audio mixer.
    if (this._mixer) {
      await this._mixer.start(this._sampleRate);
    }
  }

  /**
   * Stop the media sender and cleanup resources.
   *
   * @param frame The end frame signaling sender shutdown.
   */
  async stop(frame: EndFrame): Promise<void> {
    // Let the sink tasks process the queue until they reach this EndFrame.
    await this._clockQueue.put([Number.POSITIVE_INFINITY, this._clockQueueCounter++, frame]);
    await this._audioQueue.put(frame);

    // At this point we have enqueued an EndFrame and we need to wait for that
    // EndFrame to be processed by the audio and clock tasks. We also need to
    // wait for these tasks before cancelling the video task because it might
    // be still rendering.
    if (this._audioTask) {
      await this._audioTask;
    }
    if (this._clockTask) {
      await this._clockTask;
    }

    // Stop audio mixer.
    if (this._mixer) {
      await this._mixer.stop();
    }

    // We can now cancel the video task.
    await this._cancelVideoTask();
  }

  /**
   * Cancel the media sender and stop all processing.
   *
   * @param frame The cancel frame signaling immediate cancellation.
   */
  async cancel(_frame: CancelFrame): Promise<void> {
    await this.cleanup();
  }

  /** Release media sender resources at teardown. */
  async cleanup(): Promise<void> {
    // Since we are cancelling everything it doesn't matter what task we cancel first.
    await this._cancelAudioTask();
    await this._cancelClockTask();
    await this._cancelVideoTask();

    // Stop audio mixer so it doesn't keep generating frames after cancellation.
    if (this._mixer) {
      await this._mixer.stop();
    }
  }

  /**
   * Handle interruption events by restarting tasks and clearing buffers.
   *
   * @param _ The start interruption frame (unused).
   */
  async handleInterruptions(_: InterruptionFrame): Promise<void> {
    // Keep the audio task running but drain all interruptible frames, so the
    // frame being written and the pending uninterruptible ones are still
    // delivered. With a mixer, cancelling the task would also stop mixer-only
    // output during the restart, causing an audible gap in the background
    // audio (made worse by telephony serializers that clear the playout
    // buffer on interruptions).
    this._audioQueue.reset();
    // The same goes for the audio still waiting to fill a chunk.
    this._audioRuns = this._audioRuns.filter(([, flag]) => flag);

    // Likewise, keep the clock task running but drain its interruptible
    // frames, and cancel it if it's waiting to push one.
    this._clockQueue.reset();
    if (this._clockFrame?.interruptible) {
      await this._cancelClockTask();
    }

    await this._cancelVideoTask();

    // Create tasks.
    this._createVideoTask();
    this._createClockTask();

    // Let's send a bot stopped speaking if we have to. The bot keeps speaking
    // while there's uninterruptible audio still to play (after the reset,
    // everything left in the queue is uninterruptible).
    if (!(this._audioRuns.length > 0 || this._audioQueue.hasFrame(OutputAudioRawFrame))) {
      await this._botStoppedSpeaking();
    }
  }

  /**
   * Handle incoming audio frames by buffering and chunking.
   *
   * @param frame The output audio frame to handle.
   */
  async handleAudioFrame(frame: OutputAudioRawFrame): Promise<void> {
    if (!this._params.audioOutEnabled) return;

    // We might need to resample if incoming audio doesn't match the transport
    // sample rate.
    const resampled = await this._resampler.resample(
      frame.audio,
      frame.sampleRate,
      this._sampleRate,
    );

    const cls = frame.constructor as OutputAudioFrameClass;
    this._audioBufferCls = cls;
    this._bufferAudio(resampled, { uninterruptible: !frame.interruptible });
    while (this._bufferedAudioBytes >= this._audioChunkSize) {
      const [audio, uninterruptible] = this._takeAudioChunk();
      const chunk = new cls({
        audio,
        sampleRate: this._sampleRate,
        numChannels: frame.numChannels,
      });
      chunk.transportDestination = this._destination;
      chunk.interruptible = !uninterruptible;
      await this._audioQueue.put(chunk);
    }
  }

  /**
   * Handle incoming image frames for video output.
   *
   * @param frame The output image or sprite frame to handle.
   */
  async handleImageFrame(frame: OutputImageRawFrame | SpriteFrame): Promise<void> {
    if (!this._params.videoOutEnabled) return;

    if (frame instanceof OutputImageRawFrame && frame.syncWithAudio) {
      // Route through the audio queue so the image is only displayed after
      // all preceding audio has been sent.
      await this._audioQueue.put(frame);
    } else if (this._params.videoOutIsLive && frame instanceof OutputImageRawFrame) {
      await this._videoQueue.put(frame);
    } else if (frame instanceof OutputImageRawFrame) {
      await this._setVideoImage(frame);
    } else {
      await this._setVideoImages(frame.images);
    }
  }

  /**
   * Handle frames with presentation timestamps.
   *
   * @param frame The frame with timing information to handle.
   */
  async handleTimedFrame(frame: Frame): Promise<void> {
    await this._clockQueue.put([frame.pts as number, this._clockQueueCounter++, frame]);
  }

  /**
   * Handle frames that need synchronized processing.
   *
   * @param frame The frame to handle synchronously.
   */
  async handleSyncFrame(frame: Frame): Promise<void> {
    await this._audioQueue.put(frame);
  }

  /**
   * Queue a TTSStoppedFrame, flushing any trailing buffered audio first.
   *
   * `handleAudioFrame` only queues complete `audioChunkSize` chunks, so up to
   * one chunk's worth of trailing audio can still be sitting in `_audioRuns`.
   * Queue it now (padded to a full chunk with silence) so it plays before the
   * stop frame is handled, instead of being discarded when the buffer is
   * cleared in `_botStoppedSpeaking`.
   *
   * @param frame The TTS stopped frame to queue.
   */
  async handleTtsStopped(frame: TTSStoppedFrame): Promise<void> {
    await this._enqueueFlushedAudioBuffer();
    await this._audioQueue.put(frame);
  }

  /**
   * Handle audio mixer control frames.
   *
   * @param frame The mixer control frame to handle.
   */
  async handleMixerControlFrame(frame: MixerControlFrame): Promise<void> {
    if (this._mixer) {
      await this._mixer.processFrame(frame);
    }
  }

  //
  // Audio handling
  //

  /** Create the audio processing task. */
  protected _createAudioTask(): void {
    if (!this._audioTask) {
      this._audioQueue = new FrameQueue<Frame>();
      this._audioTask = this._transport.createTask(
        () => this._audioTaskHandler(),
        "_audio_task_handler",
      );
    }
  }

  /** Cancel and cleanup the audio processing task. */
  protected async _cancelAudioTask(): Promise<void> {
    if (this._audioTask) {
      await this._transport.cancelTask(this._audioTask);
      this._audioTask = null;
    }
  }

  /** Handle bot started speaking event. */
  protected async _botStartedSpeaking(): Promise<void> {
    if (this._botSpeaking) return;

    this._botSpeaking = true;

    logger.debug(`Bot${this._destination ? ` [${this._destination}]` : ""} started speaking`);

    const downstreamFrame = new BotStartedSpeakingFrame();
    downstreamFrame.transportDestination = this._destination;
    const upstreamFrame = new BotStartedSpeakingFrame();
    upstreamFrame.transportDestination = this._destination;

    // Setting the siblings id
    upstreamFrame.broadcastSiblingId = downstreamFrame.id;
    downstreamFrame.broadcastSiblingId = upstreamFrame.id;

    await this._transport.pushFrame(downstreamFrame);
    await this._transport.pushFrame(upstreamFrame, FrameDirection.UPSTREAM);
  }

  /**
   * Queue every bit of audio still held back at the end of a speech run.
   *
   * That means both what the resampler is holding in its filter and what is
   * left in `_audioRuns`, padded with silence to a full chunk. The audio goes
   * out as frames of the same type (e.g. TTSAudioRawFrame) as the audio it
   * was buffered from, on `_audioQueue`, so it takes the normal playback path
   * (write, error handling, bot speaking tracking) like any other chunk, in
   * order relative to whatever is queued after it (e.g. a TTSStoppedFrame).
   */
  protected async _enqueueFlushedAudioBuffer(): Promise<void> {
    // The resampler holds the tail of the audio it was fed, which belongs at
    // the end of this speech run, with the last run's flag.
    const tail = await this._resampler.flush();
    const lastRun = this._audioRuns[this._audioRuns.length - 1];
    const lastUninterruptible = lastRun ? lastRun[1] : false;
    this._bufferAudio(tail, { uninterruptible: lastUninterruptible });

    if (this._audioRuns.length === 0) return;

    // The flushed tail can be longer than a chunk, so send whole chunks first
    // and pad only what's left over.
    while (this._bufferedAudioBytes >= this._audioChunkSize) {
      const [audio, uninterruptible] = this._takeAudioChunk();
      await this._enqueueAudioChunk(audio, uninterruptible);
    }

    if (this._audioRuns.length > 0) {
      const [audio, uninterruptible] = this._takeAudioChunk();
      const padded = new Uint8Array(this._audioChunkSize);
      padded.set(audio, 0);
      await this._enqueueAudioChunk(padded, uninterruptible);
    }
  }

  protected get _bufferedAudioBytes(): number {
    let total = 0;
    for (const [audio] of this._audioRuns) total += audio.length;
    return total;
  }

  /** Add output-rate audio to the buffer, noting whether it came from uninterruptible frames. */
  protected _bufferAudio(audio: Uint8Array, options: { uninterruptible: boolean }): void {
    if (audio.length === 0) return;
    const last = this._audioRuns[this._audioRuns.length - 1];
    if (last && last[1] === options.uninterruptible) {
      last[0] = concatBytes(last[0], audio);
    } else {
      this._audioRuns.push([audio.slice(), options.uninterruptible]);
    }
  }

  /** Cut up to a chunk from the front of the buffer, and whether any of it is uninterruptible. */
  protected _takeAudioChunk(): [Uint8Array, boolean] {
    const chunk = new Uint8Array(this._audioChunkSize);
    let length = 0;
    let uninterruptible = false;
    while (length < this._audioChunkSize && this._audioRuns.length > 0) {
      const run = this._audioRuns[0] as AudioRun;
      const [audio, runUninterruptible] = run;
      uninterruptible = uninterruptible || runUninterruptible;
      const needed = this._audioChunkSize - length;
      if (audio.length <= needed) {
        chunk.set(audio, length);
        length += audio.length;
        this._audioRuns.shift();
      } else {
        chunk.set(audio.subarray(0, needed), length);
        length += needed;
        run[0] = audio.slice(needed);
      }
    }
    return [chunk.slice(0, length), uninterruptible];
  }

  protected _clearAudioBuffer(): void {
    this._audioRuns = [];
  }

  /** Queue one full chunk of output-rate audio for playback. */
  protected async _enqueueAudioChunk(audio: Uint8Array, uninterruptible: boolean): Promise<void> {
    const frame = new this._audioBufferCls({
      audio,
      sampleRate: this._sampleRate,
      numChannels: this._params.audioOutChannels,
    });
    frame.transportDestination = this._destination;
    frame.interruptible = !uninterruptible;
    await this._audioQueue.put(frame);
  }

  /** Handle bot stopped speaking event. */
  protected async _botStoppedSpeaking(): Promise<void> {
    if (!this._botSpeaking) return;

    this._botSpeaking = false;
    this._ttsAudioReceived = false;

    // Any remaining leftover here (e.g. from an interruption) is discarded
    // rather than flushed, since it's no longer wanted. The same goes for the
    // audio still inside the resampler, which would otherwise be prepended to
    // whatever the bot says next.
    this._clearAudioBuffer();
    await this._resampler.reset();

    logger.debug(`Bot${this._destination ? ` [${this._destination}]` : ""} stopped speaking`);

    const downstreamFrame = new BotStoppedSpeakingFrame();
    downstreamFrame.transportDestination = this._destination;
    const upstreamFrame = new BotStoppedSpeakingFrame();
    upstreamFrame.transportDestination = this._destination;

    // Setting the siblings id
    upstreamFrame.broadcastSiblingId = downstreamFrame.id;
    downstreamFrame.broadcastSiblingId = upstreamFrame.id;

    await this._transport.pushFrame(downstreamFrame);
    await this._transport.pushFrame(upstreamFrame, FrameDirection.UPSTREAM);
  }

  /** Handle bot speaking event. */
  protected async _botCurrentlySpeaking(): Promise<void> {
    await this._botStartedSpeaking();

    const diffTime = time() - this._botSpeakingFrameTime;
    if (diffTime >= this._botSpeakingFramePeriod) {
      await this._transport.broadcastFrame(BotSpeakingFrame);
      this._botSpeakingFrameTime = time();
    }

    this._botSpeechLastTime = time();
  }

  protected async _maybeBotCurrentlySpeaking(frame: SpeechOutputAudioRawFrame): Promise<void> {
    if (!isSilence(frame.audio)) {
      await this._botCurrentlySpeaking();
    } else {
      const silenceDuration = time() - this._botSpeechLastTime;
      if (silenceDuration > BOT_VAD_STOP_SECS) {
        await this._botStoppedSpeaking();
      }
    }
  }

  protected async _handleBotSpeech(frame: Frame): Promise<void> {
    // TTS case.
    if (frame instanceof TTSAudioRawFrame) {
      // We will only trigger bot stopped speaking based on the
      // TTSStoppedFrame, if we have received audio from TTS
      this._ttsAudioReceived = true;
      await this._botCurrentlySpeaking();
    }
    // Speech stream case.
    else if (frame instanceof SpeechOutputAudioRawFrame) {
      await this._maybeBotCurrentlySpeaking(frame);
    }
  }

  /**
   * Handle various frame types with appropriate processing.
   *
   * @param frame The frame to handle.
   */
  protected async _handleFrame(frame: Frame): Promise<void> {
    if (frame instanceof OutputAudioRawFrame) {
      await this._handleBotSpeech(frame);
    } else if (frame instanceof OutputImageRawFrame) {
      await this._setVideoImage(frame);
    } else if (frame instanceof SpriteFrame) {
      await this._setVideoImages(frame.images);
    } else if (frame instanceof OutputTransportMessageFrame) {
      await this._transport.sendMessage(frame);
    } else if (frame instanceof OutputDTMFFrame) {
      await this._transport.writeDtmf(frame);
    } else if (frame instanceof TTSStoppedFrame) {
      // We will only trigger bot stopped speaking based on the
      // TTSStoppedFrame, if we have received audio from TTS
      if (this._ttsAudioReceived) {
        logger.debug("Bot stopped speaking based on TTSStoppedFrame");
        await this._botStoppedSpeaking();
      }
    } else if (frame instanceof FilterControlFrame && this._filter) {
      await this._filter.processFrame(frame);
    } else if (frame instanceof VolumeFrame) {
      this._volume = frame.volume;
    } else if (frame instanceof VolumeGainFrame) {
      this._volumeGain = frame.gain;
    } else {
      await this._transport.writeTransportFrame(frame);
    }
  }

  /**
   * Run the output filter over a frame taken from the audio queue.
   *
   * @param frame The queued frame. Only audio frames are filtered.
   */
  protected async _filterAudio(frame: Frame): Promise<void> {
    if (this._filter && frame instanceof OutputAudioRawFrame) {
      frame.audio = await this._filter.filter(frame.audio);
    }
  }

  /** Scale an audio frame taken from the audio queue by the volume and its gain. */
  protected _applyVolume(frame: Frame): void {
    const volume = this._volume * this._volumeGain;
    if (volume !== 1.0 && frame instanceof OutputAudioRawFrame) {
      frame.audio = scaleAudio(frame.audio, volume);
    }
  }

  /**
   * Generate the next frame for audio processing.
   *
   * @returns An async generator yielding frames for processing.
   */
  protected _nextFrame(): AsyncGenerator<Frame, void, undefined> {
    const withoutMixer = async function* (
      this: MediaSender,
      vadStopSecs: number,
    ): AsyncGenerator<Frame, void, undefined> {
      for (;;) {
        let frame: Frame;
        try {
          frame = await waitFor(() => this._audioQueue.get(), vadStopSecs);
        } catch (e) {
          if (!(e instanceof TimeoutError)) throw e;
          // Fallback: notify the bot stopped speaking upstream if necessary
          // based on timeout.
          await this._botStoppedSpeaking();
          continue;
        }
        await this._filterAudio(frame);
        this._applyVolume(frame);
        yield frame;
        this._audioQueue.taskDone();
      }
    };

    const withMixer = async function* (
      this: MediaSender,
      vadStopSecs: number,
    ): AsyncGenerator<Frame, void, undefined> {
      // Caller below only invokes this when `this._mixer` is set.
      const mixer = this._mixer as BaseAudioMixer;
      let lastFrameTime = 0;
      const silence = new Uint8Array(this._audioChunkSize);
      for (;;) {
        let frame: Frame;
        try {
          frame = this._audioQueue.getNowait();
        } catch (e) {
          if (!(e instanceof QueueEmpty)) throw e;
          // Fallback: notify the bot stopped speaking upstream if necessary
          // based on timeout.
          const diffTime = time() - lastFrameTime;
          if (diffTime > vadStopSecs) {
            await this._botStoppedSpeaking();
          }
          // Generate an audio frame with only the mixer's part.
          const mixed = new OutputAudioRawFrame({
            audio: await mixer.mix(silence),
            sampleRate: this._sampleRate,
            numChannels: this._params.audioOutChannels,
          });
          yield mixed;
          // Allow other tasks to execute by adding a small sleep. Without
          // this sleep, in task cancellation scenarios, this loop would
          // continuously return without any delay, leading to 100% CPU
          // utilization and preventing cancel/stop signals from being
          // processed properly.
          await sleep(0);
          continue;
        }
        await this._filterAudio(frame);
        this._applyVolume(frame);
        if (frame instanceof OutputAudioRawFrame) {
          frame.audio = await mixer.mix(frame.audio);
          lastFrameTime = time();
        }
        yield frame;
        this._audioQueue.taskDone();
      }
    };

    if (this._mixer) {
      return withMixer.call(this, BOT_VAD_STOP_FALLBACK_SECS);
    }
    return withoutMixer.call(this, BOT_VAD_STOP_FALLBACK_SECS);
  }

  protected async _sendSilence(secs: number): Promise<void> {
    if (secs <= 0) return;

    const sampleWidth = 2;
    const silence = new Uint8Array(this.sampleRate * sampleWidth * secs);
    const silenceFrame = new OutputAudioRawFrame({
      audio: silence,
      sampleRate: this.sampleRate,
      numChannels: 1,
    });
    await this._internalWriteAudioFrame(silenceFrame);
  }

  /** Main audio processing task handler. */
  protected async _audioTaskHandler(): Promise<void> {
    for await (const frame of this._nextFrame()) {
      // No need to push EndFrame, it's pushed from processFrame().
      if (frame instanceof EndFrame) {
        // Send some final silence so words don't cut out.
        await this._sendSilence(this._params.audioOutEndSilenceSecs);
        break;
      }

      // Skip frames with no audio data (e.g. filter is buffering).
      if (frame instanceof OutputAudioRawFrame && frame.audio.length === 0) {
        continue;
      }

      // Handle frame.
      await this._handleFrame(frame);

      // If we are not able to write to the transport we shouldn't push
      // downstream.
      let pushDownstream = true;

      // Try to send audio to the transport.
      try {
        if (frame instanceof OutputAudioRawFrame) {
          pushDownstream = await this._internalWriteAudioFrame(frame);
        }
      } catch (e) {
        rethrowIfCancelled(e);
        logger.error(`${this} Error writing ${frame} to transport: ${errorMessage(e)}`);
        pushDownstream = false;
      }

      // If we were able to send to the transport, push the frame downstream
      // in case anyone else needs it.
      if (pushDownstream) {
        await this._transport.pushFrame(frame);
      }
    }
  }

  /**
   * Write a frame to the transport, giving up if the write never returns.
   *
   * A client that stops reading is the common way to get there: the
   * connection stays up and nothing fails, so the transport has neither an
   * error to report nor state to check. That leaves how long the write takes
   * as the only signal available.
   *
   * @returns Whether the transport took the frame.
   */
  protected async _internalWriteAudioFrame(frame: OutputAudioRawFrame): Promise<boolean> {
    // Reporting the timeout below costs the transport its usability, so a
    // peer is only written off once however much audio is still queued.
    if (!this._transport.isUsable) return false;

    const timeout = this._params.audioOutWriteTimeoutSecs;
    try {
      // The write usually ends in a foreign await (a WebSocket, an SDK), which
      // is not a cancellation point. `abortable` makes it one, so the timeout
      // can actually stop waiting on a write that never returns.
      return await waitFor(() => abortable(this._transport.writeAudioFrame(frame)), timeout);
    } catch (e) {
      if (!(e instanceof TimeoutError)) throw e;
      await this._transport.pushError(
        `${this._transport} timed out after ${timeout}s writing audio to the ` +
          "transport; the peer has stopped reading",
        { exception: e, forceTreatAsPermanent: true },
      );
      return false;
    }
  }

  //
  // Video handling
  //

  /** Create the video processing task if video output is enabled. */
  protected _createVideoTask(): void {
    if (!this._videoTask && this._params.videoOutEnabled) {
      this._videoQueue = new Queue<OutputImageRawFrame>();
      this._videoTask = this._transport.createTask(
        () => this._videoTaskHandler(),
        "_video_task_handler",
      );
    }
  }

  /** Cancel and cleanup the video processing task. */
  protected async _cancelVideoTask(): Promise<void> {
    // Stop video output task.
    if (this._videoTask) {
      await this._transport.cancelTask(this._videoTask);
      this._videoTask = null;
    }
  }

  /**
   * Set a single video image for cycling output.
   *
   * @param image The image frame to cycle for video output.
   */
  protected async _setVideoImage(image: OutputImageRawFrame): Promise<void> {
    this._videoImages = cycle([image]);
  }

  /**
   * Set multiple video images for cycling output.
   *
   * @param images The list of image frames to cycle for video output.
   */
  protected async _setVideoImages(images: OutputImageRawFrame[]): Promise<void> {
    this._videoImages = cycle([...images]);
  }

  /** Main video processing task handler. */
  protected async _videoTaskHandler(): Promise<void> {
    this._videoStartTime = null;
    this._videoFrameIndex = 0;
    this._videoFrameDuration = 1 / this._params.videoOutFramerate;
    this._videoFrameReset = this._videoFrameDuration * 5;
    for (;;) {
      if (this._params.videoOutIsLive) {
        await this._videoIsLiveHandler();
      } else if (this._videoImages) {
        const next = this._videoImages.next();
        if (!next.done) {
          await this._drawImage(next.value);
        }
        await sleep(this._videoFrameDuration);
      } else {
        await sleep(this._videoFrameDuration);
      }
    }
  }

  /** Handle live video streaming with frame timing. */
  protected async _videoIsLiveHandler(): Promise<void> {
    const image = await this._videoQueue.get();

    // We get the start time as soon as we get the first image.
    if (!this._videoStartTime) {
      this._videoStartTime = time();
      this._videoFrameIndex = 0;
    }

    // Calculate how much time we need to wait before rendering next image.
    const realElapsedTime = time() - this._videoStartTime;
    const realRenderTime = this._videoFrameIndex * this._videoFrameDuration;
    const delayTime = this._videoFrameDuration + realRenderTime - realElapsedTime;

    if (Math.abs(delayTime) > this._videoFrameReset) {
      this._videoStartTime = time();
      this._videoFrameIndex = 0;
    } else if (delayTime > 0) {
      await sleep(delayTime);
      this._videoFrameIndex += 1;
    }

    // Render image
    await this._drawImage(image);

    this._videoQueue.taskDone();
  }

  /**
   * Draw/render an image frame with resizing if needed.
   *
   * @param frame The image frame to draw.
   */
  protected async _drawImage(frame: OutputImageRawFrame): Promise<void> {
    const resizeFrame = (frame: OutputImageRawFrame): OutputImageRawFrame => {
      // Without a format we can't decode the bytes, so leave the frame as-is
      // and let the transport pass it through unchanged.
      if (frame.format === null) return frame;

      const desiredSize: [number, number] = [
        this._params.videoOutWidth,
        this._params.videoOutHeight,
      ];

      // TODO: we should refactor in the future to support dynamic resolutions
      // which is kind of what happens in P2P connections. We need to add
      // support for that inside the DailyTransport
      if (frame.size[0] !== desiredSize[0] || frame.size[1] !== desiredSize[1]) {
        return this._resizeImage(frame, desiredSize);
      }

      return frame;
    };

    await this._transport.writeVideoFrame(resizeFrame(frame));
  }

  /**
   * Resize an image frame to the transport's output size.
   *
   * Upstream decodes the raw bytes with PIL (`Image.frombytes`), resizes them
   * and re-encodes them in the image's mode. There is no edge-compatible PIL
   * equivalent yet; override this (or provide a resizer) to support images
   * whose size differs from `videoOutWidth` x `videoOutHeight`.
   *
   * @param frame The image frame to resize (its `format` is set).
   * @param desiredSize The output size as [width, height].
   * @returns A new OutputImageRawFrame with the resized image.
   */
  protected _resizeImage(
    _frame: OutputImageRawFrame,
    _desiredSize: [number, number],
  ): OutputImageRawFrame {
    // PORT-STUB: PIL Image.resize has no edge-compatible equivalent yet.
    throw new Error("not ported yet: image resizing (PIL Image.resize) in MediaSender._drawImage");
  }

  //
  // Clock handling
  //

  /** Create the clock/timing processing task. */
  protected _createClockTask(): void {
    if (!this._clockTask) {
      this._clockTask = this._transport.createTask(
        () => this._clockTaskHandler(),
        "_clock_task_handler",
      );
    }
  }

  /** Cancel and cleanup the clock processing task. */
  protected async _cancelClockTask(): Promise<void> {
    if (this._clockTask) {
      await this._transport.cancelTask(this._clockTask);
      this._clockTask = null;
      this._clockFrame = null;
    }
  }

  /** Main clock/timing task handler for timed frame delivery. */
  protected async _clockTaskHandler(): Promise<void> {
    let running = true;
    while (running) {
      const [timestamp, , frame] = await this._clockQueue.get();

      // If we hit an EndFrame, we can finish right away.
      running = !(frame instanceof EndFrame);

      // If we have a frame we check it's presentation timestamp. If it has
      // already passed we process it, otherwise we wait until it's time to
      // process it.
      if (running) {
        this._clockFrame = frame;

        const currentTime = this._transport.getClock().getTime();
        if (timestamp > currentTime) {
          const waitTime = nanosecondsToSeconds(timestamp - currentTime);
          await sleep(waitTime);
        }

        // Push frame downstream.
        await this._transport.pushFrame(frame);

        this._clockFrame = null;
      }

      this._clockQueue.taskDone();
    }
  }

  toString(): string {
    return `${this.constructor.name}(${this._transport}, ${this._destination})`;
  }
}

/**
 * Base class for output transport implementations.
 *
 * Handles audio and video output processing including frame buffering, audio
 * mixing, timing coordination, and media streaming. Supports multiple output
 * destinations and provides interruption handling for real-time
 * communication.
 *
 * The deprecated `TransportParams.video_out_bitrate` (and its deprecation
 * warning) is not ported.
 */
export class BaseOutputTransport extends FrameProcessor {
  /** Upstream's nested class `BaseOutputTransport.MediaSender`. */
  static readonly MediaSender = MediaSender;

  protected _params: TransportParams;

  // Output sample rate. It will be initialized during setup.
  protected _sampleRate = 0;

  // We write 10ms*CHUNKS of audio at a time (where CHUNKS is the
  // `audioOut10msChunks` parameter). If we receive long audio frames we will
  // chunk them. This helps with interruption handling. It will be initialized
  // during setup.
  protected _audioChunkSize = 0;

  // We will have one media sender per output frame destination. This allow us
  // to send multiple streams at the same time if the transport allows it.
  protected _mediaSenders = new Map<string | null, MediaSender>();

  /**
   * Initialize the base output transport.
   *
   * @param params Transport configuration parameters.
   * @param options Additional options passed to the parent class.
   */
  constructor(params: TransportParams, options: FrameProcessorOptions = {}) {
    super(options);
    this._params = params;
  }

  /** The current audio sample rate in Hz. */
  get sampleRate(): number {
    return this._sampleRate;
  }

  /** The size of audio chunks for output processing, in bytes. */
  get audioChunkSize(): number {
    return this._audioChunkSize;
  }

  /** The media this transport sends to the user: the `audio_out` and `video_out` capabilities. */
  get capabilities(): BotCapabilities {
    return new BotCapabilities({
      audioOut: this._params.audioOutEnabled,
      videoOut: this._params.videoOutEnabled,
    });
  }

  /**
   * Set up the transport.
   *
   * @param setup Configuration object containing setup parameters.
   */
  override async setup(setup: FrameProcessorSetup): Promise<void> {
    await super.setup(setup);
    this._sampleRate = this._params.audioOutSampleRate || setup.audioOutSampleRate;

    // We will write 10ms*CHUNKS of audio at a time (where CHUNKS is the
    // `audioOut10msChunks` parameter). If we receive long audio frames we will
    // chunk them. This will help with interruption handling.
    const audioBytes10ms = Math.trunc(this._sampleRate / 100) * this._params.audioOutChannels * 2;
    this._audioChunkSize = audioBytes10ms * this._params.audioOut10msChunks;

    // Start audio filter. Paired with the stop in cleanup(), which is the only
    // other call guaranteed to happen exactly once.
    if (this._params.audioOutFilter) {
      await this._params.audioOutFilter.start(this._sampleRate);
    }
  }

  /** Release output transport resources at teardown. */
  override async cleanup(): Promise<void> {
    await super.cleanup();
    for (const sender of this._mediaSenders.values()) {
      await sender.cleanup();
    }
    if (this._params.audioOutFilter) {
      await this._params.audioOutFilter.stop();
    }
  }

  /**
   * Start the output transport.
   *
   * Base hook for subclasses, which reach it through `super`. The transport's
   * own audio configuration is resolved in `setup`.
   *
   * @param frame The start frame containing initialization parameters.
   */
  async start(_frame: StartFrame): Promise<void> {}

  /**
   * Stop the output transport and cleanup resources.
   *
   * @param frame The end frame signaling transport shutdown.
   */
  async stop(frame: EndFrame): Promise<void> {
    for (const sender of this._mediaSenders.values()) {
      await sender.stop(frame);
    }
  }

  /**
   * Cancel the output transport and stop all processing.
   *
   * @param frame The cancel frame signaling immediate cancellation.
   */
  async cancel(frame: CancelFrame): Promise<void> {
    for (const sender of this._mediaSenders.values()) {
      await sender.cancel(frame);
    }
  }

  /**
   * Called when the transport is ready to stream.
   *
   * @param frame The start frame containing initialization parameters.
   */
  async setTransportReady(frame: StartFrame): Promise<void> {
    // Register destinations.
    for (const destination of this._params.audioOutDestinations) {
      await this.registerAudioDestination(destination);
    }

    for (const destination of this._params.videoOutDestinations) {
      await this.registerVideoDestination(destination);
    }

    // Start default media sender.
    const defaultSender = new BaseOutputTransport.MediaSender(this, {
      destination: null,
      sampleRate: this.sampleRate,
      audioChunkSize: this.audioChunkSize,
      params: this._params,
    });
    this._mediaSenders.set(null, defaultSender);
    await defaultSender.start(frame);

    // Media senders already send both audio and video, so make sure we only
    // have one media server per shared name.
    const destinations = [
      ...new Set([...this._params.audioOutDestinations, ...this._params.videoOutDestinations]),
    ];

    // Start media senders.
    for (const destination of destinations) {
      const sender = new BaseOutputTransport.MediaSender(this, {
        destination,
        sampleRate: this.sampleRate,
        audioChunkSize: this.audioChunkSize,
        params: this._params,
      });
      this._mediaSenders.set(destination, sender);
      await sender.start(frame);
    }

    // Sending a frame indicating that the output transport is ready and able
    // to receive frames.
    await this.pushFrame(new OutputTransportReadyFrame(), FrameDirection.UPSTREAM);
  }

  /**
   * Send a transport message.
   *
   * @param frame The transport message frame to send.
   */
  async sendMessage(
    _frame: OutputTransportMessageFrame | OutputTransportMessageUrgentFrame,
  ): Promise<void> {}

  /**
   * Register a video output destination.
   *
   * @param destination The destination identifier to register.
   */
  async registerVideoDestination(_destination: string): Promise<void> {}

  /**
   * Register an audio output destination.
   *
   * @param destination The destination identifier to register.
   */
  async registerAudioDestination(_destination: string): Promise<void> {}

  /**
   * Write a video frame to the transport.
   *
   * @param frame The output video frame to write.
   * @returns True if the video frame was written successfully, false otherwise.
   */
  async writeVideoFrame(_frame: OutputImageRawFrame): Promise<boolean> {
    return false;
  }

  /**
   * Write an audio frame to the transport.
   *
   * @param frame The output audio frame to write.
   * @returns Whether the transport took the frame. A serializer that emits no
   *   payload has still taken it; see `FrameSerializer.serialize`.
   */
  async writeAudioFrame(_frame: OutputAudioRawFrame): Promise<boolean> {
    return false;
  }

  /**
   * Write a DTMF tone using the transport's preferred method.
   *
   * @param frame The DTMF frame to write.
   */
  async writeDtmf(frame: OutputDTMFFrame | OutputDTMFUrgentFrame): Promise<void> {
    if (this._supportsNativeDtmf()) {
      await this._writeDtmfNative(frame);
    } else {
      await this._writeDtmfAudio(frame);
    }
  }

  /**
   * Handle a queued frame after preceding audio has been sent.
   *
   * Override in transport subclasses to handle custom frame types that flow
   * through the audio queue. Called by the media sender after the frame has
   * waited for any preceding audio to finish.
   *
   * @param frame The frame to handle.
   */
  async writeTransportFrame(_frame: Frame): Promise<void> {}

  /**
   * Override in transport implementations that support native DTMF.
   *
   * @returns True if the transport supports native DTMF, false otherwise.
   */
  protected _supportsNativeDtmf(): boolean {
    return false;
  }

  /**
   * Override in transport implementations for native DTMF.
   *
   * @param frame The DTMF frame to write.
   */
  protected async _writeDtmfNative(_frame: OutputDTMFFrame | OutputDTMFUrgentFrame): Promise<void> {
    throw new Error("Transport claims native DTMF support but doesn't implement it");
  }

  /**
   * Generate and send audio tones for DTMF.
   *
   * @param frame The DTMF frame to write.
   */
  protected async _writeDtmfAudio(frame: OutputDTMFFrame | OutputDTMFUrgentFrame): Promise<void> {
    if (!frame.buttons || frame.buttons.length === 0) return;
    for (const button of frame.buttons) {
      const dtmfAudio = await loadDtmfAudio(button, { sampleRate: this._sampleRate });
      const dtmfAudioFrame = new OutputAudioRawFrame({
        audio: dtmfAudio,
        sampleRate: this._sampleRate,
        numChannels: 1,
      });
      await this.writeAudioFrame(dtmfAudioFrame);
    }
  }

  /**
   * Send an audio frame downstream.
   *
   * @param frame The audio frame to send.
   */
  async sendAudio(frame: OutputAudioRawFrame): Promise<void> {
    await this.queueFrame(frame, FrameDirection.DOWNSTREAM);
  }

  /**
   * Send an image frame downstream.
   *
   * @param frame The image frame to send.
   */
  async sendImage(frame: OutputImageRawFrame | SpriteFrame): Promise<void> {
    await this.queueFrame(frame, FrameDirection.DOWNSTREAM);
  }

  //
  // Frame processor
  //

  /**
   * Process incoming frames and handle transport-specific logic.
   *
   * @param frame The frame to process.
   * @param direction The direction of frame flow in the pipeline.
   */
  override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
    await super.processFrame(frame, direction);

    if (frame instanceof StartFrame) {
      // Push StartFrame before start(), because we want StartFrame to be
      // processed by every processor before any other frame is processed.
      await this.pushFrame(frame, direction);
      await this.start(frame);
    } else if (frame instanceof EndFrame) {
      await this.stop(frame);
      // Keep pushing EndFrame down so all the pipeline stops nicely.
      await this.pushFrame(frame, direction);
    } else if (frame instanceof CancelFrame) {
      await this.cancel(frame);
      await this.pushFrame(frame, direction);
    } else if (frame instanceof InterruptionFrame) {
      await this.pushFrame(frame, direction);
      await this._handleFrame(frame);
    } else if (frame instanceof OutputTransportMessageUrgentFrame) {
      await this.sendMessage(frame);
    } else if (frame instanceof OutputDTMFUrgentFrame) {
      await this.writeDtmf(frame);
    } else if (frame instanceof SystemFrame) {
      await this.pushFrame(frame, direction);
    } else if (direction === FrameDirection.UPSTREAM) {
      await this.pushFrame(frame, direction);
    } else {
      await this._handleFrame(frame);
    }
  }

  /** Handle frames by routing them to appropriate media senders. */
  protected async _handleFrame(frame: Frame): Promise<void> {
    const sender = this._mediaSenders.get(frame.transportDestination);
    if (!sender) {
      logger.warning(
        `${this} destination [${frame.transportDestination}] not registered for frame ${frame}`,
      );
      return;
    }

    if (frame instanceof InterruptionFrame) {
      await sender.handleInterruptions(frame);
    } else if (frame instanceof OutputAudioRawFrame) {
      await sender.handleAudioFrame(frame);
    } else if (frame instanceof OutputImageRawFrame || frame instanceof SpriteFrame) {
      await sender.handleImageFrame(frame);
      if (frame instanceof AssistantImageRawFrame) {
        // This will push it further, to be handled by the assistant
        // aggregator, say
        await sender.handleSyncFrame(frame);
      }
    } else if (frame instanceof MixerControlFrame) {
      await sender.handleMixerControlFrame(frame);
    } else if (frame instanceof TTSStoppedFrame) {
      await sender.handleTtsStopped(frame);
    } else if (frame.pts) {
      await sender.handleTimedFrame(frame);
    } else {
      await sender.handleSyncFrame(frame);
    }
  }
}
