// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/transports/base_input.py

/**
 * Base input transport implementation for Pipecat.
 *
 * This module provides the BaseInputTransport class which handles audio and
 * video input processing.
 */

import { Queue, type Task, TimeoutError, waitFor } from "@pipedog/asyncio";
import {
  CancelFrame,
  EndFrame,
  FilterControlFrame,
  type Frame,
  InputAudioRawFrame,
  type InputImageRawFrame,
  InputTransportStartAudioStreamingFrame,
  StartFrame,
  StopFrame,
  SystemFrame,
  type UserImageRequestFrame,
} from "../frames/frames.ts";
import { BotCapabilities } from "../pipeline/capabilities.ts";
import {
  type FrameDirection,
  FrameProcessor,
  type FrameProcessorOptions,
  type FrameProcessorSetup,
} from "../processors/frame_processor.ts";
import { logger } from "../utils/logger.ts";
import type { TransportParams } from "./base_transport.ts";

export const AUDIO_INPUT_TIMEOUT_SECS = 0.5;

/**
 * Base class for input transport implementations.
 *
 * Handles audio and video input processing including Voice Activity
 * Detection, turn analysis, audio filtering, and user interaction management.
 * Supports interruption handling and provides hooks for transport-specific
 * implementations.
 *
 * The deprecated `start_audio_in_streaming()` is not ported: push an
 * InputTransportStartAudioStreamingFrame instead, and override
 * `_startAudioInStreaming()` in subclasses.
 */
export class BaseInputTransport extends FrameProcessor {
  protected _params: TransportParams;

  // Input sample rate. It will be initialized during setup.
  protected _sampleRate = 0;

  // Track bot speaking state for interruption logic
  protected _botSpeaking = false;

  // Track user speaking state for interruption logic
  protected _userSpeaking = false;
  // Last time a UserSpeakingFrame was pushed.
  protected _userSpeakingFrameTime = 0;
  // How often a UserSpeakingFrame should be pushed (value should be greater
  // than the audio chunks to have any effect).
  protected _userSpeakingFramePeriod = 0.2;

  // Task to process incoming audio (VAD) and push audio frames downstream if
  // passthrough is enabled.
  protected _audioTask: Task<unknown> | null = null;
  // Recreated with the audio task (see `_createAudioTask`).
  protected _audioInQueue = new Queue<InputAudioRawFrame>();

  // If the transport is stopped with `StopFrame` we might still be receiving
  // frames from the transport but we really don't want to push them
  // downstream until we get another `StartFrame`.
  protected _paused = false;

  /**
   * Initialize the base input transport.
   *
   * @param params Transport configuration parameters.
   * @param options Additional options passed to the parent class.
   */
  constructor(params: TransportParams, options: FrameProcessorOptions = {}) {
    super(options);

    this._params = params;

    const unsupported = Object.keys(params.videoInSources).filter(
      (s) => !this._supportsVideoInSource(s),
    );
    if (unsupported.length > 0) {
      logger.warning(
        `${this}: video_in_sources [${unsupported.map((s) => `'${s}'`).join(", ")}] aren't supported and will be ignored.`,
      );
    }
  }

  /**
   * Enable or disable audio streaming on transport start.
   *
   * @param enabled Whether to start audio streaming immediately on transport start.
   */
  enableAudioInStreamOnStart(enabled: boolean): void {
    logger.debug(`Enabling audio on start. ${enabled}`);
    this._params.audioInStreamOnStart = enabled;
  }

  /**
   * Start audio input streaming.
   *
   * Override in subclasses to implement transport-specific audio streaming.
   * Triggered by an `InputTransportStartAudioStreamingFrame`.
   */
  protected async _startAudioInStreaming(): Promise<void> {}

  /** The current audio sample rate in Hz. */
  get sampleRate(): number {
    return this._sampleRate;
  }

  /**
   * Complete image requests that no frame will answer, with an error.
   *
   * The function call that made each request would otherwise never finish.
   *
   * @param requests The image requests to complete.
   * @param error Why no frame will answer them.
   */
  protected async _answerImageRequests(
    requests: UserImageRequestFrame[],
    error: string,
  ): Promise<void> {
    if (requests.length === 0) return;
    logger.warning(`${this}: ${error}`);
    for (const request of requests) {
      if (request.resultCallback) {
        const resultCallback = request.resultCallback as (result: unknown) => unknown;
        await resultCallback({ error });
      }
    }
  }

  /**
   * Whether this transport captures a video source listed in `videoInSources`.
   *
   * Transports that support `videoInSources` override this. A listed source
   * this returns false for is ignored, with a warning.
   *
   * @param videoSource The video source, e.g. `"camera"` or `"screenVideo"`.
   * @returns Whether the source is captured as its user connects.
   */
  protected _supportsVideoInSource(_videoSource: string): boolean {
    return false;
  }

  /**
   * The media this transport receives from the user.
   *
   * The `audio_in`, `video_in` and `screen_in` capabilities. `screen_in` is
   * unknown when video input is enabled without `videoInSources`, since the
   * application then decides which sources to capture, and when the transport
   * doesn't capture screen shares through `videoInSources`.
   */
  get capabilities(): BotCapabilities {
    let screenIn: boolean | null;
    if (!this._params.videoInEnabled) {
      screenIn = false;
    } else if (
      this._supportsVideoInSource("screenVideo") &&
      Object.keys(this._params.videoInSources).length > 0
    ) {
      screenIn = "screenVideo" in this._params.videoInSources;
    } else {
      screenIn = null;
    }
    return new BotCapabilities({
      audioIn: this._params.audioInEnabled,
      videoIn: this._params.videoInEnabled,
      screenIn,
    });
  }

  /**
   * Set up the transport.
   *
   * @param setup Configuration object containing setup parameters.
   */
  override async setup(setup: FrameProcessorSetup): Promise<void> {
    await super.setup(setup);
    this._sampleRate = this._params.audioInSampleRate || setup.audioInSampleRate;

    // Start audio filter. Paired with the stop in cleanup(), which is the only
    // other call guaranteed to happen exactly once.
    if (this._params.audioInFilter) {
      await this._params.audioInFilter.start(this._sampleRate);
    }
  }

  /** Release input transport resources at teardown. */
  override async cleanup(): Promise<void> {
    await super.cleanup();
    await this._cancelAudioTask();
    if (this._params.audioInFilter) {
      await this._params.audioInFilter.stop();
    }
  }

  /**
   * Start the input transport and initialize components.
   *
   * @param frame The start frame containing initialization parameters.
   */
  async start(_frame: StartFrame): Promise<void> {
    this._paused = false;
    this._userSpeaking = false;
  }

  /**
   * Stop the input transport and cleanup resources.
   *
   * @param frame The end frame signaling transport shutdown.
   */
  async stop(_frame: EndFrame): Promise<void> {
    // Cancel and wait for the audio input task to finish.
    await this._cancelAudioTask();
  }

  /**
   * Pause the input transport temporarily.
   *
   * @param frame The stop frame signaling transport pause.
   */
  async pause(_frame: StopFrame): Promise<void> {
    this._paused = true;
    // Cancel task so we clear the queue
    await this._cancelAudioTask();
    // Retart the task
    this._createAudioTask();
  }

  /**
   * Cancel the input transport and stop all processing.
   *
   * @param frame The cancel frame signaling immediate cancellation.
   */
  async cancel(_frame: CancelFrame): Promise<void> {
    // Cancel and wait for the audio input task to finish.
    await this._cancelAudioTask();
  }

  /**
   * Called when the transport is ready to stream.
   *
   * @param frame The start frame containing initialization parameters.
   */
  async setTransportReady(_frame: StartFrame): Promise<void> {
    // Create audio input queue and task if needed.
    this._createAudioTask();
  }

  /**
   * Push a video frame downstream if video input is enabled.
   *
   * @param frame The input video frame to process.
   */
  async pushVideoFrame(frame: InputImageRawFrame): Promise<void> {
    if (this._params.videoInEnabled && !this._paused) {
      await this.pushFrame(frame);
    }
  }

  /**
   * Push an audio frame to the processing queue if audio input is enabled.
   *
   * @param frame The input audio frame to process.
   */
  async pushAudioFrame(frame: InputAudioRawFrame): Promise<void> {
    if (this._params.audioInEnabled && !this._paused) {
      await this._audioInQueue.put(frame);
    }
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

    // Specific system frames
    if (frame instanceof StartFrame) {
      // Push StartFrame before start(), because we want StartFrame to be
      // processed by every processor before any other frame is processed.
      await this.pushFrame(frame, direction);
      await this.start(frame);
    } else if (frame instanceof CancelFrame) {
      await this.cancel(frame);
      await this.pushFrame(frame, direction);
    }
    // Audio pushed in from upstream (e.g. by RTVIProcessor) is fed through the
    // same VAD/processing path as audio captured from the source, rather than
    // forwarded as a plain system frame.
    else if (frame instanceof InputAudioRawFrame) {
      await this.pushAudioFrame(frame);
    }
    // All other system frames
    else if (frame instanceof SystemFrame) {
      await this.pushFrame(frame, direction);
    }
    // Control frames
    else if (frame instanceof InputTransportStartAudioStreamingFrame) {
      await this._startAudioInStreaming();
    } else if (frame instanceof EndFrame) {
      // Push EndFrame before stop(), because stop() waits on the task to
      // finish and the task finishes when EndFrame is processed.
      await this.pushFrame(frame, direction);
      await this.stop(frame);
    } else if (frame instanceof StopFrame) {
      await this.pushFrame(frame, direction);
      await this.pause(frame);
    } else if (frame instanceof FilterControlFrame && this._params.audioInFilter) {
      await this._params.audioInFilter.processFrame(frame);
    }
    // Other frames
    else {
      await this.pushFrame(frame, direction);
    }
  }

  //
  // Audio input
  //

  /** Create the audio processing task if audio input is enabled. */
  protected _createAudioTask(): void {
    if (!this._audioTask && this._params.audioInEnabled) {
      this._audioInQueue = new Queue<InputAudioRawFrame>();
      this._audioTask = this.createTask(() => this._audioTaskHandler(), "_audio_task_handler");
    }
  }

  /** Cancel and cleanup the audio processing task. */
  protected async _cancelAudioTask(): Promise<void> {
    if (this._audioTask) {
      await this.cancelTask(this._audioTask);
      this._audioTask = null;
    }
  }

  /** Main audio processing task handler. */
  protected async _audioTaskHandler(): Promise<void> {
    // Skip timeout handling until the first audio frame arrives (e.g. client
    // not yet connected).
    let audioReceived = false;
    for (;;) {
      try {
        const frame = await waitFor(() => this._audioInQueue.get(), AUDIO_INPUT_TIMEOUT_SECS);

        // From now on, timeout should warn if there's no audio.
        audioReceived = true;

        // Filter audio, if an audio filter is available.
        if (this._params.audioInFilter) {
          frame.audio = await this._params.audioInFilter.filter(frame.audio);
        }

        // Skip frames with no audio data (e.g. filter is buffering).
        if (frame.audio.length === 0) {
          this._audioInQueue.taskDone();
          continue;
        }

        // Push audio downstream if passthrough is set.
        if (this._params.audioInPassthrough) {
          await this.pushFrame(frame);
        }

        this._audioInQueue.taskDone();
      } catch (e) {
        if (!(e instanceof TimeoutError)) throw e;
        if (!audioReceived) continue;
      }
    }
  }
}
