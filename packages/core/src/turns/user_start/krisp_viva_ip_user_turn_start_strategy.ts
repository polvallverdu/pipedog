// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/turns/user_start/krisp_viva_ip_user_turn_start_strategy.py

/**
 * User turn start strategy using Krisp Interruption Prediction (IP).
 *
 * This strategy uses Krisp's IP model to distinguish genuine user interruptions
 * from backchannels (e.g. "uh-huh", "yeah"). Instead of triggering a user turn
 * on every VAD speech event, it collects audio after VAD detects speech and runs
 * the IP model to predict whether the speech is a real interruption.
 *
 * Only when the IP model's probability exceeds the configured threshold is
 * `reportUserTurnStarted()` called. This prevents the bot from being
 * interrupted by brief acknowledgements or filler words.
 *
 * PARTIAL PORT: the Krisp SDK (`krisp_audio`) is a native Python module with no
 * runtime-agnostic JS equivalent. The strategy logic is ported; creating the IP
 * session (`_createIpSession`) is a stub that throws "not ported yet".
 * Subclasses (or tests) can override it to supply a `KrispIpSession`.
 */

import { rethrowIfCancelled } from "@pipedog/asyncio";
import {
  intToKrispFrameDuration,
  intToKrispSampleRate,
  KrispVivaSDKManager,
} from "../../audio/krisp_instance.ts";
import {
  BotStoppedSpeakingFrame,
  type Frame,
  InputAudioRawFrame,
  VADUserStartedSpeakingFrame,
  VADUserStoppedSpeakingFrame,
} from "../../frames/frames.ts";
import { getEnv } from "../../utils/env.ts";
import { logger } from "../../utils/logger.ts";
import {
  BaseUserTurnStartStrategy,
  type BaseUserTurnStartStrategyOptions,
} from "./base_user_turn_start_strategy.ts";

/** A Krisp IP session (`krisp_audio.IpFloat`): one probability per audio frame. */
export interface KrispIpSession {
  /**
   * Feed one frame of float32 samples in [-1, 1).
   *
   * @param frame Exactly `samplesPerFrame` samples.
   * @param speechActive The per-frame VAD input.
   * @returns The probability that the speech is a genuine interruption.
   */
  process(frame: Float32Array, speechActive: boolean): number;
}

export interface KrispVivaIPUserTurnStartStrategyOptions extends BaseUserTurnStartStrategyOptions {
  /**
   * Path to the Krisp VIVA IP model file (.kef). If null, uses the
   * KRISP_VIVA_IP_MODEL_PATH environment variable.
   */
  modelPath?: string | null;
  /**
   * IP probability threshold (0.0 to 1.0). When the model's output exceeds
   * this value, the speech is classified as a genuine interruption.
   */
  threshold?: number;
  /**
   * Frame duration in milliseconds for IP processing.
   * Supported values: 10, 15, 20, 30, 32.
   */
  frameDurationMs?: number;
  /**
   * Krisp SDK API key. If empty, falls back to the KRISP_VIVA_API_KEY
   * environment variable.
   */
  apiKey?: string;
}

/**
 * User turn start strategy using Krisp VIVA Interruption Prediction.
 *
 * When VAD detects user speech, this strategy feeds audio frames into
 * the Krisp VIVA IP model. The model outputs a probability indicating
 * whether the speech is a genuine interruption (as opposed to a
 * backchannel). A user turn is triggered only when this probability
 * exceeds the configured threshold.
 *
 * This strategy is designed to work alongside other start strategies
 * (e.g. `TranscriptionUserTurnStartStrategy` as a fallback) via the
 * strategy list in `UserTurnStrategies`.
 *
 * @example
 * const strategies = new UserTurnStrategies({
 *   start: [
 *     new KrispVivaIPUserTurnStartStrategy({
 *       modelPath: "/path/to/ip_model.kef",
 *       threshold: 0.5,
 *     }),
 *     new TranscriptionUserTurnStartStrategy(),
 *   ],
 * });
 */
export class KrispVivaIPUserTurnStartStrategy extends BaseUserTurnStartStrategy {
  protected _threshold: number;
  protected _frameDurationMs: number;
  protected _apiKey: string;
  protected _modelPath: string;

  protected _sdkAcquired = false;
  protected _ipSession: KrispIpSession | null = null;
  protected _samplesPerFrame: number | null = null;
  protected _sampleRate: number | null = null;

  // State tracking
  protected _speechActive = false;
  protected _audioBuffer: Uint8Array = new Uint8Array(0);
  protected _decisionMade = false;

  constructor(options: KrispVivaIPUserTurnStartStrategyOptions = {}) {
    super(options);

    this._threshold = options.threshold ?? 0.5;
    this._frameDurationMs = options.frameDurationMs ?? 20;
    this._apiKey = options.apiKey ?? "";

    const modelPath = options.modelPath || getEnv("KRISP_VIVA_IP_MODEL_PATH");
    if (!modelPath) {
      throw new Error(
        "IP model path must be provided via model_path or " +
          "KRISP_VIVA_IP_MODEL_PATH environment variable.",
      );
    }
    if (!modelPath.endsWith(".kef")) {
      throw new Error("Model is expected with .kef extension");
    }
    // Upstream also checks that the file exists; core has no filesystem
    // access, so that check is left to the Krisp runtime that loads it.
    this._modelPath = modelPath;

    // Acquire SDK
    try {
      KrispVivaSDKManager.acquire(this._apiKey);
      this._sdkAcquired = true;
    } catch (e) {
      rethrowIfCancelled(e);
      throw new Error(
        `Failed to initialize Krisp SDK: ${e instanceof Error ? e.message : String(e)}`,
        { cause: e },
      );
    }
  }

  /** Release Krisp SDK resources. */
  override async cleanup(): Promise<void> {
    if (this._sdkAcquired) {
      try {
        this._ipSession = null;
        KrispVivaSDKManager.release();
        this._sdkAcquired = false;
      } catch (e) {
        rethrowIfCancelled(e);
        logger.error(
          `Error cleaning up Krisp VIVA IP strategy: ${e instanceof Error ? e.message : String(e)}`,
          e,
        );
      }
    }
  }

  /**
   * Create a Krisp IP session for the given sample rate.
   *
   * STUB: needs the Krisp SDK (`krisp_audio.IpFloat.create`), which has no JS
   * equivalent yet. Override to supply a session.
   */
  protected _createIpSession(sampleRate: number): KrispIpSession {
    // Validate the configuration as the SDK config would.
    intToKrispSampleRate(sampleRate);
    intToKrispFrameDuration(this._frameDurationMs);
    throw new Error(
      `not ported yet: Krisp VIVA IP session (model ${this._modelPath}) requires the Krisp SDK`,
    );
  }

  /**
   * Create or re-create the IP session when sample rate changes.
   *
   * @param sampleRate Audio sample rate in Hz.
   */
  protected _ensureSession(sampleRate: number): void {
    if (this._sampleRate === sampleRate && this._ipSession !== null) {
      return;
    }

    this._sampleRate = sampleRate;
    this._samplesPerFrame = Math.trunc((sampleRate * this._frameDurationMs) / 1000);

    this._ipSession = this._createIpSession(sampleRate);
    logger.debug(`Krisp VIVA IP session created (sample_rate=${sampleRate})`);
  }

  /** Reset speech tracking state for the next candidate interruption. */
  protected _resetState(): void {
    this._speechActive = false;
    this._audioBuffer = new Uint8Array(0);
    this._decisionMade = false;
  }

  /** Ready the strategy for a new user turn. */
  override async handleUserTurnStarted(): Promise<void> {
    this._resetState();
  }

  /**
   * Process a frame to detect genuine user interruptions.
   *
   * On `VADUserStartedSpeakingFrame`, begins collecting audio.
   * On `InputAudioRawFrame`, feeds audio through the IP model and
   * triggers a user turn if the interruption probability exceeds the
   * threshold.
   * On `VADUserStoppedSpeakingFrame` or `BotStoppedSpeakingFrame`,
   * resets the candidate state.
   *
   * @param frame The incoming frame.
   */
  override async processFrame(frame: Frame): Promise<void> {
    if (frame instanceof VADUserStartedSpeakingFrame) {
      await this._handleVadStarted(frame);
    } else if (frame instanceof InputAudioRawFrame) {
      await this._handleAudio(frame);
    } else if (
      frame instanceof VADUserStoppedSpeakingFrame ||
      frame instanceof BotStoppedSpeakingFrame
    ) {
      await this._handleReset(frame);
    }
  }

  /**
   * Begin collecting audio for interruption classification.
   *
   * The decision waits until enough audio is processed.
   */
  protected async _handleVadStarted(_frame: VADUserStartedSpeakingFrame): Promise<void> {
    logger.trace("Krisp VIVA IP: VAD speech started, collecting audio for classification");
    this._speechActive = true;
    this._decisionMade = false;
  }

  /**
   * Feed audio to the IP model and check for genuine interruption.
   *
   * Every frame is passed to the IP model regardless of speech state so
   * that the model maintains continuous internal state (matching the
   * standalone Krisp SDK behaviour). `_speechActive` is forwarded as
   * the per-frame VAD input to the model and also gates the threshold
   * evaluation.
   *
   * @param frame Raw audio input frame.
   */
  protected async _handleAudio(frame: InputAudioRawFrame): Promise<void> {
    this._ensureSession(frame.sampleRate);

    if (this._ipSession === null || this._samplesPerFrame === null) {
      logger.warning("IP session not ready, skipping frame");
      return;
    }

    const buffer = new Uint8Array(this._audioBuffer.length + frame.audio.length);
    buffer.set(this._audioBuffer, 0);
    buffer.set(frame.audio, this._audioBuffer.length);
    this._audioBuffer = buffer;

    const totalSamples = Math.floor(this._audioBuffer.length / 2); // 2 bytes per int16 sample
    const numCompleteFrames = Math.floor(totalSamples / this._samplesPerFrame);

    if (numCompleteFrames === 0) {
      return;
    }

    const completeSamplesCount = numCompleteFrames * this._samplesPerFrame;
    const bytesToProcess = completeSamplesCount * 2;

    // Copy so the Int16Array view is aligned regardless of the buffer offset.
    const audioToProcess = this._audioBuffer.slice(0, bytesToProcess);
    this._audioBuffer = this._audioBuffer.slice(bytesToProcess);

    const audioInt16 = new Int16Array(audioToProcess.buffer, 0, completeSamplesCount);
    const audioFloat32 = new Float32Array(completeSamplesCount);
    for (let i = 0; i < completeSamplesCount; i++) {
      audioFloat32[i] = (audioInt16[i] as number) / 32768.0;
    }

    for (let f = 0; f < numCompleteFrames; f++) {
      const ipFrame = audioFloat32.subarray(
        f * this._samplesPerFrame,
        (f + 1) * this._samplesPerFrame,
      );
      const ipProb = this._ipSession.process(ipFrame, this._speechActive);

      if (this._speechActive && !this._decisionMade && ipProb >= this._threshold) {
        logger.debug(
          `Krisp VIVA IP: genuine interruption detected (prob=${ipProb.toFixed(3)}, ` +
            `threshold=${this._threshold})`,
        );
        this._decisionMade = true;
        await this.reportUserTurnStarted();
        return;
      }
    }
  }

  /** Reset state when the candidate interruption window ends. */
  protected async _handleReset(
    _frame: VADUserStoppedSpeakingFrame | BotStoppedSpeakingFrame,
  ): Promise<void> {
    if (this._speechActive) {
      logger.trace("Krisp VIVA IP: speech segment ended, resetting state");
      this._resetState();
    }
  }
}
