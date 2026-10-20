// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/services/stt_service.py

/** Base classes for Speech-to-Text services with continuous and segmented processing. */

import { monotonic, Queue, rethrowIfCancelled, sleep, type Task, time } from "@pipedog/asyncio";
import { pcmToWav } from "../audio/utils.ts";
import {
  type CancelFrame,
  type EndFrame,
  type ErrorFrame,
  type Frame,
  InputAudioRawFrame,
  InterruptionFrame,
  LLMContextAssistantTurnFrame,
  STTMetadataFrame,
  STTMuteFrame,
  STTUpdateSettingsFrame,
  type StartFrame,
  TranscriptionFrame,
  UserAudioRawFrame,
  UserStoppedSpeakingFrame,
  VADUserStartedSpeakingFrame,
  VADUserStoppedSpeakingFrame,
} from "../frames/frames.ts";
import { STTUsage } from "../metrics/metrics.ts";
import { FrameDirection, type FrameProcessorSetup } from "../processors/frame_processor.ts";
import { isLanguage, type Language } from "../transcriptions/language.ts";
import { logger } from "../utils/logger.ts";
import { isGiven } from "../utils/types.ts";
import { AIService, type AIServiceOptions } from "./ai_service.ts";
import { STTSettings } from "./settings.ts";
import { DEFAULT_TTFS_P99 } from "./stt_latency.ts";
import { State, WebsocketService, type WebsocketServiceOptions } from "./websocket_service.ts";

// Duration in seconds of silent audio sent for WebSocket keepalive (100ms).
const KEEPALIVE_SILENCE_DURATION = 0.1;

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export interface STTServiceOptions extends AIServiceOptions {
  /** Whether to pass audio frames downstream after processing. Defaults to true. */
  audioPassthrough?: boolean;
  /**
   * The sample rate for audio input. If null, will be determined from the
   * start frame.
   */
  sampleRate?: number | null;
  /**
   * Time in seconds to wait after VAD stop before reporting TTFB. This delay
   * allows the final transcription to arrive. Defaults to 2.0.
   */
  sttTtfbTimeout?: number;
  /**
   * P99 latency from speech end to final transcript in seconds. Broadcast via
   * STTMetadataFrame at pipeline start.
   */
  ttfsP99Latency?: number | null;
  /**
   * Seconds of no audio before sending silence to keep the connection alive.
   * null disables keepalive.
   */
  keepaliveTimeout?: number | null;
  /** Seconds between idle checks when keepalive is enabled. */
  keepaliveInterval?: number;
  /** The runtime-updatable settings for the STT service. */
  settings?: STTSettings | null;
}

/**
 * Base class for speech-to-text services.
 *
 * Provides common functionality for STT services including audio
 * passthrough, muting, settings management, and audio processing. Subclasses
 * must implement the `runStt` method to provide actual speech recognition.
 *
 * Includes an optional keepalive mechanism that sends silent audio when no
 * real audio has been sent for a configurable timeout, preventing servers from
 * closing idle connections (e.g. when behind a ServiceSwitcher). Subclasses
 * that enable keepalive must override `_sendKeepalive()` to deliver the
 * silence in the appropriate service-specific protocol.
 *
 * A streaming STT reports latency through TTFB — speech end to final
 * transcript — and not through processing metrics. Audio arrives
 * continuously, so there is no discrete request whose duration a
 * `FrameProcessor.startProcessingMetrics()` window could measure; anchoring
 * one to a speech or turn boundary measures how long the user talked.
 * SegmentedSTTService does issue a discrete request per utterance, so its
 * subclasses time that call and report both.
 *
 * Event handlers:
 *
 * - on_connected: called when connected to the STT service.
 * - on_disconnected: called when disconnected from the STT service.
 * - on_connection_error: called when a connection to the STT service error
 *   occurs.
 *
 * @example
 * stt.addEventHandler("on_connected", async (stt: STTService) => {
 *   logger.debug("STT connected");
 * });
 *
 * stt.addEventHandler("on_disconnected", async (stt: STTService) => {
 *   logger.debug("STT disconnected");
 * });
 *
 * stt.addEventHandler("on_connection_error", async (stt: STTService, error: string) => {
 *   logger.error(`STT connection error: ${error}`);
 * });
 */
export abstract class STTService extends AIService {
  declare protected _settings: STTSettings;

  protected _audioPassthrough: boolean;
  protected _initSampleRate: number | null;
  protected _sampleRate = 0;

  protected _muted = false;
  protected _userId = "";
  protected _ttfsP99Latency: number | null;

  // STT TTFB tracking state
  protected _sttTtfbTimeout: number;
  protected _ttfbTimeoutTask: Task<unknown> | null = null;
  protected _userSpeaking = false;
  protected _finalizePending = false;
  protected _finalizeRequested = false;
  protected _lastTranscriptTime = 0;

  // Keepalive state
  protected _keepaliveTimeout: number | null;
  protected _keepaliveInterval: number;
  protected _keepaliveTask: Task<unknown> | null = null;
  protected _lastAudioTime = 0;

  // Client-measured audio seconds submitted to the service since the last
  // usage report (see emitSttUsageMetrics).
  protected _sttUsagePendingSeconds = 0.0;

  // VAD-aware reconnect state
  // Whether it is safe to reconnect right now (false while the user is speaking).
  protected _canReconnect = true;
  // Whether a reconnect has been requested but deferred until speaking ends.
  protected _needReconnect = false;
  // Whether a reconnect cycle is currently in progress.
  protected _reconnecting = false;
  // Audio frames received while _reconnecting is true, replayed after reconnect.
  protected _reconnectAudioBuffer: [InputAudioRawFrame, FrameDirection][] = [];

  /**
   * Initialize the STT service.
   *
   * @param options.audioPassthrough Whether to pass audio frames downstream
   *   after processing. Defaults to true.
   * @param options.sampleRate The sample rate for audio input. If null, will
   *   be determined from the start frame.
   * @param options.sttTtfbTimeout Time in seconds to wait after VAD stop
   *   before reporting TTFB. This delay allows the final transcription to
   *   arrive. Defaults to 2.0. Note: STT "TTFB" differs from traditional TTFB
   *   (which measures from a discrete request to first response byte). Since
   *   STT receives continuous audio, we measure from when the user stops
   *   speaking to when the final transcript arrives—capturing the latency that
   *   matters for voice AI applications.
   * @param options.ttfsP99Latency P99 latency from speech end to final
   *   transcript in seconds. This is broadcast via STTMetadataFrame at
   *   pipeline start for downstream processors (e.g., turn strategies) to
   *   optimize timing. Subclasses provide measured defaults; pass a value here
   *   to override for your deployment. Turn-based services where the server
   *   defines turn boundaries should override `supportsTtfs` to return false
   *   instead of supplying a value.
   * @param options.keepaliveTimeout Seconds of no audio before sending
   *   silence to keep the connection alive. null disables keepalive. Useful
   *   for services that close idle connections (e.g. behind a
   *   ServiceSwitcher).
   * @param options.keepaliveInterval Seconds between idle checks when
   *   keepalive is enabled.
   * @param options.settings The runtime-updatable settings for the STT
   *   service. Other options are passed to the parent AIService.
   */
  constructor(options: STTServiceOptions = {}) {
    super({
      ...options,
      settings:
        options.settings ||
        // Here in case subclass doesn't implement more specific settings
        // (which hopefully should be rare)
        new STTSettings(),
    });

    // Convert Language enum to service-specific format at init time.
    // Runtime updates are handled by _updateSettings(), but init-time
    // settings bypass that path and need explicit conversion.
    // Raw strings (e.g. "de-DE") are first checked against the Language
    // codes so they go through the same resolution logic.
    const language = this._settings.language;
    if (typeof language === "string" && !isLanguage(language)) {
      logger.debug(
        `Language string '${language}' is not a recognized ` +
          "Language code. It will be passed to the service as-is.",
      );
    }
    if (typeof language === "string" && isLanguage(language)) {
      const converted = this.languageToServiceLanguage(language);
      if (converted !== null) {
        this._settings.language = converted;
      }
    }

    this._audioPassthrough = options.audioPassthrough ?? true;
    this._initSampleRate = options.sampleRate ?? null;
    this._ttfsP99Latency = options.ttfsP99Latency ?? null;
    this._sttTtfbTimeout = options.sttTtfbTimeout ?? 2.0;
    this._keepaliveTimeout = options.keepaliveTimeout ?? null;
    this._keepaliveInterval = options.keepaliveInterval ?? 5.0;

    this._registerEventHandler("on_connected");
    this._registerEventHandler("on_disconnected");
    this._registerEventHandler("on_connection_error");
  }

  /** The service's current settings, for reading. */
  override get settings(): STTSettings {
    return this._settings;
  }

  /** Whether the STT service is currently muted and will not process audio. */
  get isMuted(): boolean {
    return this._muted;
  }

  /**
   * Mark that a finalize request has been sent, awaiting server confirmation.
   *
   * For providers that have explicit server confirmation of finalization
   * (e.g., Deepgram's from_finalize field), call this when sending the
   * finalize request. Then call `confirmFinalize()` when the server confirms.
   *
   * For providers without server confirmation, don't call this method - just
   * send the finalize/flush/commit command and rely on the TTFB timeout.
   */
  requestFinalize(): void {
    this._finalizeRequested = true;
  }

  /**
   * Confirm that the server has acknowledged the finalize request.
   *
   * Call this when the server response confirms finalization (e.g.,
   * Deepgram's from_finalize=True). The next TranscriptionFrame pushed will be
   * marked as finalized.
   *
   * Only has effect if `requestFinalize()` was previously called.
   */
  confirmFinalize(): void {
    if (this._finalizeRequested) {
      this._finalizePending = true;
      this._finalizeRequested = false;
    }
  }

  /** The current sample rate for audio processing, in Hz. */
  get sampleRate(): number {
    return this._sampleRate;
  }

  /**
   * Accumulate client-measured audio seconds for usage metrics.
   *
   * @param audio Raw 16-bit mono PCM audio bytes submitted to the service.
   */
  protected _recordSttAudioUsage(audio: Uint8Array): void {
    if (this.sampleRate > 0) {
      this._sttUsagePendingSeconds += audio.length / (this.sampleRate * 2);
    }
  }

  /**
   * Emit an incremental STT usage metrics event.
   *
   * Reports the audio seconds accumulated since the last report as an
   * `STTUsageMetricsData` in a `MetricsFrame`. Services call this once per
   * billing event (e.g. on each final transcript); the base class calls it a
   * final time on stop/cancel to flush trailing audio. Does nothing if there
   * is no usage to report.
   */
  async emitSttUsageMetrics(): Promise<void> {
    const audioSeconds = this._sttUsagePendingSeconds;
    this._sttUsagePendingSeconds = 0.0;
    if (audioSeconds === 0.0) {
      return;
    }
    await this.startSttUsageMetrics(new STTUsage({ audioSeconds }));
  }

  /** Flush any trailing audio usage not yet reported by a billing event. */
  protected async _flushSttUsageMetrics(): Promise<void> {
    await this.emitSttUsageMetrics();
  }

  /**
   * Convert a language to the service-specific language format.
   *
   * @param language The language to convert.
   * @returns The service-specific language identifier. Return `null` to
   *   indicate an unsupported language. This optional return is an extension
   *   hook for future or third-party subclasses; as of 2026-04-28,
   *   first-party services return a string.
   */
  languageToServiceLanguage(language: Language): string | null {
    return language;
  }

  /**
   * Called when the assistant's turn completes with the aggregated reply text.
   *
   * Override in subclasses to react to each completed bot reply — for
   * example, to feed the text to a provider-side context carryover API. The
   * default implementation is a no-op.
   *
   * @param text The assistant's aggregated spoken text for this turn.
   */
  protected async _processAssistantTurn(_text: string): Promise<void> {}

  /**
   * Run speech-to-text on the provided audio data.
   *
   * This method must be implemented by subclasses to provide actual speech
   * recognition functionality.
   *
   * @param audio Raw audio bytes to transcribe.
   * @returns An async generator yielding frames containing transcription
   *   results (typically TextFrame).
   */
  abstract runStt(audio: Uint8Array): AsyncGenerator<Frame | null, void, unknown>;

  /**
   * Set up the service.
   *
   * @param setup Configuration object containing setup parameters.
   */
  override async setup(setup: FrameProcessorSetup): Promise<void> {
    await super.setup(setup);
    this._sampleRate = this._initSampleRate || setup.audioInSampleRate;
  }

  /** Clean up STT service resources. */
  override async cleanup(): Promise<void> {
    await super.cleanup();
    await this._cancelTtfbTimeout();
    await this._cancelKeepaliveTask();
    this._reconnectAudioBuffer.length = 0;
  }

  /**
   * Stop the STT service on a graceful end.
   *
   * @param frame The end frame.
   */
  override async stop(frame: EndFrame): Promise<void> {
    await super.stop(frame);
    await this._flushSttUsageMetrics();
  }

  /**
   * Cancel the STT service immediately.
   *
   * @param frame The cancel frame.
   */
  override async cancel(frame: CancelFrame): Promise<void> {
    await super.cancel(frame);
    await this._flushSttUsageMetrics();
  }

  /**
   * Apply an STT settings delta.
   *
   * Handles `model` (via parent). Translates `Language` values before
   * applying so the stored value is a service-specific string. Concrete
   * services should override this method and handle language changes
   * (including any reconnect logic) based on the returned changed-field
   * record.
   *
   * @param delta An STT settings delta.
   * @returns Record mapping changed field names to their previous values.
   */
  protected override async _updateSettings(delta: STTSettings): Promise<Record<string, unknown>> {
    // Translate language *before* applying so the stored value is canonical.
    // Raw strings are first checked against the Language codes for proper resolution.
    const language = delta.language;
    if (isGiven(language) && typeof language === "string" && !isLanguage(language)) {
      logger.debug(
        `Language string '${language}' is not a recognized ` +
          "Language code. It will be passed to the service as-is.",
      );
    }
    if (isGiven(language) && typeof language === "string" && isLanguage(language)) {
      const converted = this.languageToServiceLanguage(language);
      if (converted !== null) {
        delta.language = converted;
      }
    }

    const changed = await super._updateSettings(delta);
    return changed;
  }

  /**
   * Process an audio frame for speech recognition.
   *
   * If a reconnect is in progress, the frame is buffered and replayed once
   * the connection is restored. If the service is muted, the frame is
   * dropped. Otherwise the frame is sent to the STT service and, if a userId
   * is present, it is stored for use in transcription results.
   *
   * @param frame The audio frame to process.
   * @param direction The direction of frame processing.
   */
  async processAudioFrame(frame: InputAudioRawFrame, direction: FrameDirection): Promise<void> {
    if (this._reconnecting) {
      this._reconnectAudioBuffer.push([frame, direction]);
      return;
    }

    if (this._muted) {
      return;
    }

    // A service that can no longer work can't transcribe anything, and
    // services that connect on demand would attempt a handshake per chunk.
    if (!this.isUsable) {
      return;
    }

    this._lastAudioTime = monotonic();

    // UserAudioRawFrame contains a userId (e.g. Daily, Livekit)
    if (frame instanceof UserAudioRawFrame) {
      this._userId = frame.userId;
    }
    // InputAudioRawFrame does not have a userId (e.g. SmallWebRTCTransport, websockets)
    else {
      this._userId = "";
    }

    if (!frame.audio || frame.audio.length === 0) {
      // Ignoring in case we don't have audio to transcribe.
      logger.warning(`Empty audio frame received for STT service: ${this.name} ${frame.numFrames}`);
      return;
    }

    this._recordSttAudioUsage(frame.audio);

    await this.processGenerator(this.runStt(frame.audio));
  }

  /**
   * Process frames, handling VAD events and audio segmentation.
   *
   * @param frame The frame to process.
   * @param direction The direction of frame processing.
   */
  override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
    await super.processFrame(frame, direction);

    if (frame instanceof InputAudioRawFrame) {
      // In this service we accumulate audio internally and at the end we
      // push a TextFrame. We also push audio downstream in case someone
      // else needs it.
      await this.processAudioFrame(frame, direction);
      if (this._audioPassthrough) {
        await this.pushFrame(frame, direction);
      }
    } else if (frame instanceof VADUserStartedSpeakingFrame) {
      await this._handleVadUserStartedSpeaking(frame);
      await this.pushFrame(frame, direction);
    } else if (frame instanceof VADUserStoppedSpeakingFrame) {
      await this._handleVadUserStoppedSpeaking(frame);
      await this.pushFrame(frame, direction);
    } else if (frame instanceof UserStoppedSpeakingFrame) {
      await this._maybeReconnectOnUserStoppedSpeaking();
      await this.pushFrame(frame, direction);
    } else if (frame instanceof STTUpdateSettingsFrame) {
      if (frame.service !== null && frame.service !== this) {
        await this.pushFrame(frame, direction);
      } else if (frame.delta !== null) {
        await this._updateSettings(frame.delta);
      }
    } else if (frame instanceof STTMuteFrame) {
      this._muted = frame.mute;
      logger.debug(`STT service ${frame.mute ? "muted" : "unmuted"}`);
    } else if (frame instanceof InterruptionFrame) {
      await this._resetSttTtfbState();
      await this.pushFrame(frame, direction);
    } else if (frame instanceof LLMContextAssistantTurnFrame) {
      await this._processAssistantTurn(frame.text);
      await this.pushFrame(frame, direction);
    } else {
      await this.pushFrame(frame, direction);
    }
  }

  /**
   * Push a frame downstream, tracking TranscriptionFrame timestamps for TTFB.
   *
   * Stores the timestamp of each TranscriptionFrame for TTFB calculation. If
   * the frame is marked as finalized (via requestFinalize/confirmFinalize),
   * reports TTFB immediately and cancels any pending timeout. Otherwise, TTFB
   * is reported after a timeout.
   *
   * @param frame The frame to push.
   * @param direction The direction to push the frame.
   */
  override async pushFrame(
    frame: Frame,
    direction: FrameDirection = FrameDirection.DOWNSTREAM,
  ): Promise<void> {
    if (frame instanceof TranscriptionFrame) {
      // Store the transcript time for TTFB calculation
      this._lastTranscriptTime = time();

      // Set finalized from pending state and auto-reset
      if (this._finalizePending) {
        frame.finalized = true;
        this._finalizePending = false;
      }

      // If this is a finalized transcription, report TTFB immediately
      if (frame.finalized) {
        await this.stopTtfbMetrics();
        // Cancel the timeout since we've already reported
        await this._cancelTtfbTimeout();
      }
    }

    await super.pushFrame(frame, direction);
  }

  /**
   * Whether this STT service has a meaningful TTFS-to-final-transcript metric.
   *
   * Returns false for turn-based STTs where the server defines the turn
   * boundary, so there is no separate "speech end → final transcript"
   * interval to measure. Downstream turn-stop strategies that consume
   * STTMetadataFrame treat a 0 latency as "no extra wait."
   */
  get supportsTtfs(): boolean {
    return true;
  }

  /**
   * Build the STT metadata frame broadcast at start.
   *
   * Overrides `AIService.serviceMetadataFrame()` to return an
   * STTMetadataFrame carrying the service's TTFS P99 latency. A service that
   * does its own server-side end-of-turn detection overrides this (calling
   * `super`) to set `userTurnStrategies` on the returned frame.
   */
  override serviceMetadataFrame(): STTMetadataFrame {
    let ttfs: number;
    if (!this.supportsTtfs) {
      ttfs = 0.0;
    } else {
      const latency = this._ttfsP99Latency;
      if (latency === null) {
        ttfs = DEFAULT_TTFS_P99;
        logger.warning(`${this.name}: ttfs_p99_latency not set, using default ${ttfs}s`);
      } else {
        ttfs = latency;
      }
    }
    return new STTMetadataFrame({ serviceName: this.name, ttfsP99Latency: ttfs });
  }

  /** Cancel any pending TTFB timeout task. */
  protected async _cancelTtfbTimeout(): Promise<void> {
    if (this._ttfbTimeoutTask) {
      await this.cancelTask(this._ttfbTimeoutTask);
      this._ttfbTimeoutTask = null;
    }
  }

  /**
   * Reset STT TTFB measurement state.
   *
   * Called when starting a new utterance or on interruption to ensure we
   * don't use stale state for TTFB calculations. This specifically guards
   * against the case where a TranscriptionFrame is received without
   * corresponding VADUserStartedSpeakingFrame and VADUserStoppedSpeakingFrame
   * frames.
   *
   * Note: does not reset `_userSpeaking` since InterruptionFrame can arrive
   * while user is still speaking.
   */
  protected async _resetSttTtfbState(): Promise<void> {
    await this._cancelTtfbTimeout();
    await this.cancelTtfbMetrics();
  }

  /**
   * Handle VAD user started speaking frame to start tracking transcriptions.
   *
   * Cancels any pending TTFB timeout, resets TTFB tracking state, and marks
   * user as speaking. Also resets finalization state to prevent stale
   * finalization from a previous utterance.
   *
   * @param frame The VAD user started speaking frame.
   */
  protected async _handleVadUserStartedSpeaking(
    _frame: VADUserStartedSpeakingFrame,
  ): Promise<void> {
    await this._resetSttTtfbState();
    this._userSpeaking = true;
    this._canReconnect = false;
    this._finalizeRequested = false;
    this._finalizePending = false;
    this._lastTranscriptTime = 0;
  }

  /**
   * Check if reconnection is needed after the user stops speaking.
   *
   * Called when the user's full turn has ended and the transcription has been
   * received. Re-enables reconnection and triggers any deferred reconnect
   * that was requested while the user was speaking.
   */
  protected async _maybeReconnectOnUserStoppedSpeaking(): Promise<void> {
    this._canReconnect = true;
    if (this._needReconnect) {
      await this._reconnect();
    }
  }

  /**
   * Handle VAD user stopped speaking frame.
   *
   * Calculates the actual speech end time and starts a timeout task to wait
   * for the final transcription before reporting TTFB.
   *
   * @param frame The VAD user stopped speaking frame.
   */
  protected async _handleVadUserStoppedSpeaking(frame: VADUserStoppedSpeakingFrame): Promise<void> {
    this._userSpeaking = false;

    // Skip TTFB measurement if stopSecs is not set
    if (frame.stopSecs === 0.0) {
      return;
    }

    // Calculate the actual speech end time (current time minus VAD stop delay).
    // This approximates when the last user audio was sent to the STT service,
    // which we use to measure against the eventual transcription response.
    const speechEndTime = frame.timestamp - frame.stopSecs;
    await this.startTtfbMetrics({ startTime: speechEndTime });

    // Start timeout task (any previous timeout was cancelled by VADUserStartedSpeakingFrame
    // or InterruptionFrame)
    this._ttfbTimeoutTask = this.createTask(() => this._ttfbTimeoutHandler(), "stt_ttfb_timeout");
  }

  /**
   * Wait for timeout then report TTFB using the last transcript timestamp.
   *
   * This timeout allows the final transcription to arrive before we
   * calculate and report TTFB. Uses `_lastTranscriptTime` as the end time so
   * we measure to when the transcript actually arrived, not when the timeout
   * fired.
   *
   * A transcript that predates the end of speech belongs to an earlier
   * segment the service finalized on its own endpointing; the metrics
   * collector refuses it rather than report the negative interval it would
   * produce.
   */
  protected async _ttfbTimeoutHandler(): Promise<void> {
    try {
      await sleep(this._sttTtfbTimeout);
      if (this._lastTranscriptTime > 0) {
        await this.stopTtfbMetrics({ endTime: this._lastTranscriptTime });
      } else {
        // No transcript at all, so there is no end time to measure to.
        // Close the measurement rather than leave it open for the next
        // transcript to be measured against.
        await this.cancelTtfbMetrics();
      }
    } finally {
      // A cancellation here (new utterance or interruption) is expected
      // behavior; it propagates so the task ends as cancelled.
      this._ttfbTimeoutTask = null;
    }
  }

  /** Start the keepalive task if keepalive is enabled. */
  protected _createKeepaliveTask(): void {
    if (this._keepaliveTimeout !== null) {
      this._lastAudioTime = monotonic();
      this._keepaliveTask = this.createTask(() => this._keepaliveTaskHandler(), "keepalive");
    }
  }

  /** Stop the keepalive task if running. */
  protected async _cancelKeepaliveTask(): Promise<void> {
    if (this._keepaliveTask) {
      await this.cancelTask(this._keepaliveTask);
      this._keepaliveTask = null;
    }
  }

  /**
   * Perform a full reconnect cycle with audio buffering.
   *
   * Sets `_reconnecting` so incoming audio frames are buffered rather than
   * sent to a dead connection. Delegates the actual connection reset to
   * `_doReconnect()`. After the new connection is established all buffered
   * frames are replayed. On failure the error is reported via `pushError`
   * and the `on_connection_error` event handler.
   */
  protected async _reconnect(): Promise<void> {
    logger.info(`${this} reconnecting...`);
    this._reconnectAudioBuffer.length = 0;
    this._reconnecting = true;
    this._needReconnect = false;
    try {
      await this._doReconnect();
    } catch (e) {
      rethrowIfCancelled(e);
      logger.error(`${this} reconnect failed: ${errorMessage(e)}`);
      await this._callEventHandler("on_connection_error", errorMessage(e));
      await this.pushError(`${this} reconnect failed: ${errorMessage(e)}`, { exception: e });
      return;
    } finally {
      this._reconnecting = false;
    }

    // Replay audio frames that arrived while the connection was down.
    for (const [bufferedFrame, bufferedDirection] of this._reconnectAudioBuffer) {
      await this.processAudioFrame(bufferedFrame, bufferedDirection);
    }
    this._reconnectAudioBuffer.length = 0;
  }

  /**
   * Perform the service-specific connection reset.
   *
   * Called by `_reconnect()` inside the reconnecting guard. The default
   * implementation is a no-op. Subclasses that support explicit reconnection
   * (e.g. WebsocketSTTService) should override this to tear down and
   * re-establish their connection.
   */
  protected async _doReconnect(): Promise<void> {}

  /**
   * Reconnect immediately if safe, or defer until after the current user turn.
   *
   * Reconnection is unsafe while the user is speaking because the service is
   * actively receiving audio. Calling this method while the user is speaking
   * schedules a reconnect that fires as soon as `UserStoppedSpeakingFrame` is
   * received.
   */
  protected async _requestReconnect(): Promise<void> {
    logger.debug(`${this} requesting to reconnect!`);
    if (this._canReconnect) {
      await this._reconnect();
    } else {
      this._needReconnect = true;
    }
  }

  /**
   * Send periodic silent audio to prevent the server from closing the
   * connection.
   *
   * When keepalive is enabled, this task checks periodically if the
   * connection has been idle (no audio sent) for longer than
   * keepaliveTimeout seconds. If so, it generates silent 16-bit mono PCM
   * audio and passes it to `_sendKeepalive()` for service-specific formatting
   * and sending. A failed send is logged and the loop keeps going.
   */
  protected async _keepaliveTaskHandler(): Promise<void> {
    // This task is only started when a keepalive timeout is configured.
    const keepaliveTimeout = this._keepaliveTimeout;
    if (keepaliveTimeout === null) {
      throw new Error("keepalive task started without a keepalive timeout");
    }

    while (true) {
      await sleep(this._keepaliveInterval);
      try {
        if (!this._isKeepaliveReady()) {
          continue;
        }
        const elapsed = monotonic() - this._lastAudioTime;
        if (elapsed < keepaliveTimeout) {
          continue;
        }
        const numSamples = Math.trunc(this.sampleRate * KEEPALIVE_SILENCE_DURATION);
        const silence = new Uint8Array(numSamples * 2);
        await this._sendKeepalive(silence);
        this._lastAudioTime = monotonic();
        logger.trace(`${this} sent keepalive silence`);
      } catch (e) {
        rethrowIfCancelled(e);
        logger.warning(`${this} keepalive error: ${errorMessage(e)}`);
      }
    }
  }

  /**
   * Check if the service is ready to send keepalive.
   *
   * Subclasses should override this to check their connection state.
   *
   * @returns True if keepalive can be sent.
   */
  protected _isKeepaliveReady(): boolean {
    return true;
  }

  /**
   * Send silent audio to keep the connection alive.
   *
   * Subclasses that enable keepalive must override this to deliver silence in
   * their service-specific protocol.
   *
   * @param silence Silent 16-bit mono PCM audio bytes.
   */
  protected async _sendKeepalive(_silence: Uint8Array): Promise<void> {
    throw new Error("Subclasses must override _sendKeepalive");
  }
}

export interface SegmentedSTTServiceOptions extends STTServiceOptions {
  /**
   * Seconds of silence appended to each segment before it is transcribed, so
   * the model hears the end of speech and can finish the last word. Set to 0
   * to disable. Defaults to 0.5.
   */
  trailingSilenceSecs?: number;
}

/**
 * STT service that processes speech in segments using VAD events.
 *
 * Uses Voice Activity Detection (VAD) events to detect speech segments and
 * runs speech-to-text only on those segments, rather than continuously.
 *
 * Requires VAD to be enabled in the pipeline to function properly. Maintains
 * a small audio buffer to account for the delay between actual speech start
 * and VAD detection.
 *
 * The buffered segment is passed to `runStt` as a WAV container by default,
 * which is what cloud providers want for their upload APIs. Local models that
 * consume raw 16-bit PCM directly override `wantsWavSegments` to return false
 * so they receive the unwrapped buffer instead. This is a subclass-level
 * contract, not a user-configurable option: the format is dictated by what
 * the model expects.
 *
 * A segment ends right where the VAD stopped, and models tend to drop or
 * garble the final word when the audio ends that abruptly, so each segment is
 * padded with `trailingSilenceSecs` of silence before transcription.
 *
 * Transcription runs off the audio path. When the VAD stops, the segment is
 * queued and one background task transcribes queued segments in order,
 * pushing each transcript as it completes; meanwhile audio and other frames
 * keep flowing through the service, as they do through a streaming STT whose
 * transcripts arrive asynchronously. A graceful stop transcribes what is
 * queued before the service stops; a cancel drops it.
 */
export abstract class SegmentedSTTService extends STTService {
  protected _trailingSilenceSecs: number;
  protected _content: unknown = null;
  protected _wave: unknown = null;
  protected _audioBuffer: Uint8Array = new Uint8Array(0);
  protected _audioBufferSize1s = 0;
  // Segments awaiting transcription, drained in order by _segmentTask;
  // null tells the task to finish.
  protected _segmentQueue = new Queue<Uint8Array | null>();
  protected _segmentTask: Task<unknown> | null = null;

  /**
   * Initialize the segmented STT service.
   *
   * @param options.sampleRate The sample rate for audio input. If null, will
   *   be determined from the start frame.
   * @param options.trailingSilenceSecs Seconds of silence appended to each
   *   segment before it is transcribed, so the model hears the end of speech
   *   and can finish the last word. Set to 0 to disable. Other options are
   *   passed to the parent STTService.
   */
  constructor(options: SegmentedSTTServiceOptions = {}) {
    super(options);
    this._trailingSilenceSecs = options.trailingSilenceSecs ?? 0.5;
    this._userSpeaking = false;
  }

  /**
   * Set up the service.
   *
   * @param setup Configuration object containing setup parameters.
   */
  override async setup(setup: FrameProcessorSetup): Promise<void> {
    await super.setup(setup);
    this._audioBufferSize1s = this.sampleRate * 2;
  }

  /**
   * Start the service and its transcription task.
   *
   * @param frame The start frame.
   */
  override async start(frame: StartFrame): Promise<void> {
    await super.start(frame);
    this._segmentTask = this.createTask(() => this._segmentTaskHandler());
  }

  /**
   * Transcribe the queued segments, then stop the service.
   *
   * @param frame The end frame.
   */
  override async stop(frame: EndFrame): Promise<void> {
    if (this._segmentTask !== null) {
      await this._segmentQueue.put(null);
      await this._segmentTask;
      this._segmentTask = null;
    }
    await super.stop(frame);
  }

  /**
   * Stop the service at once, dropping any queued segments.
   *
   * @param frame The cancel frame.
   */
  override async cancel(frame: CancelFrame): Promise<void> {
    await this._cancelSegmentTask();
    await super.cancel(frame);
  }

  /**
   * Whether segments are passed to `runStt` as a WAV container.
   *
   * Returns true (the default) for cloud providers whose upload APIs expect a
   * WAV file. Local models that read the buffer as raw 16-bit PCM override
   * this to return false; otherwise they would misinterpret the 44-byte WAV
   * header as audio samples.
   */
  get wantsWavSegments(): boolean {
    return true;
  }

  /**
   * Push a frame, marking TranscriptionFrames as finalized.
   *
   * Segmented STT services process complete speech segments and return a
   * single TranscriptionFrame per segment, so every transcription is
   * inherently finalized.
   *
   * @param frame The frame to push.
   * @param direction The direction of frame flow in the pipeline.
   */
  override async pushFrame(
    frame: Frame,
    direction: FrameDirection = FrameDirection.DOWNSTREAM,
  ): Promise<void> {
    if (frame instanceof TranscriptionFrame) {
      frame.finalized = true;
    }
    await super.pushFrame(frame, direction);
  }

  /** Process frames, handling VAD events and audio segmentation. */
  override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
    await super.processFrame(frame, direction);

    if (frame instanceof VADUserStartedSpeakingFrame) {
      await this._handleUserStartedSpeaking(frame);
    } else if (frame instanceof VADUserStoppedSpeakingFrame) {
      await this._handleUserStoppedSpeaking(frame);
    }
  }

  protected async _handleUserStartedSpeaking(_frame: VADUserStartedSpeakingFrame): Promise<void> {
    this._userSpeaking = true;
  }

  protected async _handleUserStoppedSpeaking(_frame: VADUserStoppedSpeakingFrame): Promise<void> {
    this._userSpeaking = false;

    // A service that can no longer work can't transcribe this segment.
    if (!this.isUsable) {
      this._audioBuffer = new Uint8Array(0);
      return;
    }

    const trailing = this._trailingSilence();
    const pcm = new Uint8Array(this._audioBuffer.length + trailing.length);
    pcm.set(this._audioBuffer, 0);
    pcm.set(trailing, this._audioBuffer.length);
    this._audioBuffer = new Uint8Array(0);

    // The padded segment is what the provider receives, so it is what
    // usage measures. Usage is reported before transcription so tracing
    // can attach it to the STT span the resulting TranscriptionFrame closes.
    this._recordSttAudioUsage(pcm);
    await this.emitSttUsageMetrics();

    let audio: Uint8Array;
    if (this.wantsWavSegments) {
      audio = pcmToWav(pcm, this.sampleRate);
    } else {
      // Local models read the buffer as raw 16-bit PCM; wrapping it in a
      // WAV container would make them misread the 44-byte header as audio.
      audio = pcm;
    }

    await this._segmentQueue.put(audio);
  }

  /** Transcribe queued segments one at a time, in order, until told to finish. */
  protected async _segmentTaskHandler(): Promise<void> {
    let running = true;
    while (running) {
      const audio = await this._segmentQueue.get();
      running = audio !== null;
      if (audio && audio.length > 0) {
        try {
          await this.processGenerator(this.runStt(audio));
        } catch (e) {
          rethrowIfCancelled(e);
          await this.pushError(`${this}: transcription failed: ${errorMessage(e)}`, {
            exception: e,
          });
        }
      }
    }
  }

  protected async _cancelSegmentTask(): Promise<void> {
    if (this._segmentTask !== null) {
      await this.cancelTask(this._segmentTask);
      this._segmentTask = null;
    }
  }

  /** Silence appended to a segment, as 16-bit mono PCM at the service sample rate. */
  protected _trailingSilence(): Uint8Array {
    const numSamples = Math.max(0, Math.trunc(this.sampleRate * this._trailingSilenceSecs));
    return new Uint8Array(numSamples * 2);
  }

  /**
   * Process audio frames by buffering them for segmented transcription.
   *
   * Continuously buffers audio, growing the buffer while user is speaking and
   * maintaining a small buffer when not speaking to account for VAD delay.
   *
   * If the frame has a userId, it is stored for later use in transcription.
   *
   * @param frame The audio frame to process.
   * @param direction The direction of frame processing.
   */
  override async processAudioFrame(
    frame: InputAudioRawFrame,
    _direction: FrameDirection,
  ): Promise<void> {
    // UserAudioRawFrame contains a userId (e.g. Daily, Livekit)
    if (frame instanceof UserAudioRawFrame) {
      this._userId = frame.userId;
    }
    // InputAudioRawFrame does not have a userId (e.g. SmallWebRTCTransport, websockets)
    else {
      this._userId = "";
    }

    // If the user is speaking the audio buffer will keep growing.
    const grown = new Uint8Array(this._audioBuffer.length + frame.audio.length);
    grown.set(this._audioBuffer, 0);
    grown.set(frame.audio, this._audioBuffer.length);
    this._audioBuffer = grown;

    // If the user is not speaking we keep just a little bit of audio.
    if (!this._userSpeaking && this._audioBuffer.length > this._audioBufferSize1s) {
      const discarded = this._audioBuffer.length - this._audioBufferSize1s;
      this._audioBuffer = this._audioBuffer.slice(discarded);
    }
  }
}

export interface WebsocketSTTServiceOptions extends STTServiceOptions, WebsocketServiceOptions {
  /** Whether to automatically reconnect on websocket errors. Defaults to true. */
  reconnectOnError?: boolean;
}

/**
 * Base class for websocket-based STT services.
 *
 * Combines STT functionality with websocket connectivity, providing
 * automatic error handling, reconnection capabilities, and optional
 * silence-based keepalive.
 *
 * The keepalive feature (inherited from STTService) sends silent audio when
 * no real audio has been sent for a configurable timeout, preventing servers
 * from closing idle connections (e.g. when behind a ServiceSwitcher).
 * Subclasses can override `_sendKeepalive()` to wrap the silence in a
 * service-specific protocol.
 */
export abstract class WebsocketSTTService extends WebsocketService(STTService) {
  /**
   * Initialize the Websocket STT service.
   *
   * @param options.reconnectOnError Whether to automatically reconnect on
   *   websocket errors. Other options are passed to the parent classes
   *   (including keepaliveTimeout and keepaliveInterval for STTService).
   */
  constructor(options: WebsocketSTTServiceOptions = {}) {
    const merged: WebsocketSTTServiceOptions = {
      ...options,
      reconnectOnError: options.reconnectOnError ?? true,
    };
    super(merged);
  }

  /**
   * Stop the websocket STT service on a graceful end.
   *
   * @param frame The end frame.
   */
  override async stop(frame: EndFrame): Promise<void> {
    await super.stop(frame);
    await this._disconnect();
  }

  /**
   * Cancel the websocket STT service immediately.
   *
   * Disconnecting here is the prompt teardown: the websocket receive loop
   * runs independently and keeps reading transcripts from the provider until
   * the socket is closed.
   *
   * @param frame The cancel frame.
   */
  override async cancel(frame: CancelFrame): Promise<void> {
    await super.cancel(frame);
    await this._disconnect();
  }

  /** Release websocket STT resources at teardown. */
  override async cleanup(): Promise<void> {
    await super.cleanup();
    await this._disconnect();
  }

  /** Connect and start keepalive task if enabled. */
  override async _connect(): Promise<void> {
    await super._connect();
    this._createKeepaliveTask();
  }

  /** Disconnect and cancel keepalive task. */
  override async _disconnect(): Promise<void> {
    await super._disconnect();
    await this._cancelKeepaliveTask();
  }

  /**
   * Disconnect and reconnect the websocket.
   *
   * Called by `STTService._reconnect()` inside the reconnecting guard. Tears
   * down the current websocket connection and re-establishes it. Keepalive
   * management is handled by `_connect` / `_disconnect`.
   */
  protected override async _doReconnect(): Promise<void> {
    await this._disconnect();
    await this._connect();
  }

  /** Check if the websocket is open and ready for keepalive. */
  protected override _isKeepaliveReady(): boolean {
    return this._websocket !== null && this._websocket.state === State.OPEN;
  }

  /**
   * Send silent audio over the websocket to keep the connection alive.
   *
   * The default implementation sends raw PCM bytes directly. Subclasses can
   * override this to wrap the silence in a service-specific protocol.
   *
   * @param silence Silent 16-bit mono PCM audio bytes.
   */
  protected override async _sendKeepalive(silence: Uint8Array): Promise<void> {
    if (this._websocket === null) {
      // should never happen — caller should gate on _isKeepaliveReady()
      return;
    }
    await this._websocket.send(silence);
    // Keepalive silence is real audio submitted to the service, so it
    // counts toward usage.
    this._recordSttAudioUsage(silence);
  }

  protected async _reportError(
    error: ErrorFrame,
    options: { forceTreatAsPermanent?: boolean } = {},
  ): Promise<void> {
    await this._callEventHandler("on_connection_error", error.error);
    await this.pushErrorFrame(error, {
      forceTreatAsPermanent: options.forceTreatAsPermanent ?? false,
    });
  }
}
