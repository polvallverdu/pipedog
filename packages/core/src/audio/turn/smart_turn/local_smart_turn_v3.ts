// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/audio/turn/smart_turn/local_smart_turn_v3.py

/**
 * Local turn analyzer for on-device ML inference using the smart-turn-v3 model.
 *
 * Provides a smart turn analyzer that uses an ONNX model for local
 * end-of-turn detection without requiring network connectivity.
 *
 * PORTING NOTES:
 * - There is no ONNX runtime in core. The analyzer takes an injected
 *   `createSession` (backed by `onnxruntime-node` on Bun/Node or
 *   `onnxruntime-web` on Workers); the default one is a stub that throws
 *   "not ported yet".
 * - The model is not bundled; `smartTurnModelPath` defaults to the upstream
 *   file name and is handed to `createSession` as is.
 * - Resampling to 16 kHz uses the resampler engine (`audio/resamplers/engine`)
 *   instead of soxr. `_predictEndpoint` makes sure it is loaded before the
 *   (synchronous) `_resampleToModelRate` runs.
 * - `PIPECAT_SMART_TURN_LOG_DATA` WAV dumps need a filesystem, which core
 *   doesn't use; the dump is a stub that logs a warning.
 */

import { envTruthy } from "../../../utils/env.ts";
import { logger } from "../../../utils/logger.ts";
import { getResamplerEngine } from "../../resamplers/engine.ts";
import { soxrResample } from "../../resamplers/soxr_resampler.ts";
import {
  computeWhisperLogMelFeatures,
  WHISPER_NUM_FRAMES,
  WHISPER_NUM_MELS,
} from "./_whisper_features.ts";
import {
  BaseSmartTurn,
  type BaseSmartTurnOptions,
  type SmartTurnPrediction,
} from "./base_smart_turn.ts";

/**
 * The Whisper-based ONNX model expects 16 kHz audio input.
 *
 * @internal
 */
export const MODEL_SAMPLE_RATE = 16000;

/** Session options matching upstream's `onnxruntime.SessionOptions`. */
export interface SmartTurnSessionOptions {
  executionMode: "sequential";
  interOpNumThreads: number;
  intraOpNumThreads: number;
  graphOptimizationLevel: "all";
}

/** A tensor fed to the model: row-major data plus its dimensions. */
export interface SmartTurnTensor {
  data: Float32Array;
  dims: number[];
}

/** The part of an ONNX inference session the analyzer uses. */
export interface SmartTurnInferenceSession {
  /**
   * Run the model and return its first output as a flat array (the sigmoid
   * probability of turn completion is element 0).
   */
  run(feeds: { input_features: SmartTurnTensor }): Promise<ArrayLike<number>>;
}

/** Creates an inference session for a model file/URL. */
export type SmartTurnSessionFactory = (
  modelPath: string,
  options: SmartTurnSessionOptions,
) => Promise<SmartTurnInferenceSession>;

const notPortedSessionFactory: SmartTurnSessionFactory = async () => {
  throw new Error("LocalSmartTurnAnalyzerV3: ONNX runtime is not ported yet; pass `createSession`");
};

export interface LocalSmartTurnAnalyzerV3Options extends BaseSmartTurnOptions {
  /**
   * Path/URL to the ONNX model file. If not set, the upstream bundled model
   * name (smart-turn-v3.2-cpu.onnx) is used.
   */
  smartTurnModelPath?: string | null;
  /** The number of CPUs to use for inference. Defaults to 1. */
  cpuCount?: number;
  /** Creates the ONNX inference session (injected runtime). */
  createSession?: SmartTurnSessionFactory;
}

function truncateAudioToLastNSeconds(
  audioArray: Float32Array,
  nSeconds = 8,
  sampleRate = MODEL_SAMPLE_RATE,
): Float32Array {
  // Truncate audio to last n seconds or pad with zeros to meet n seconds.
  const maxSamples = nSeconds * sampleRate;
  if (audioArray.length > maxSamples) {
    return audioArray.slice(audioArray.length - maxSamples);
  }
  if (audioArray.length < maxSamples) {
    // Pad with zeros at the beginning
    const padded = new Float32Array(maxSamples);
    padded.set(audioArray, maxSamples - audioArray.length);
    return padded;
  }
  return audioArray;
}

/**
 * Local turn analyzer using the smart-turn-v3 ONNX model.
 *
 * Provides end-of-turn detection using a locally-stored ONNX model, enabling
 * offline operation without network dependencies.
 */
export class LocalSmartTurnAnalyzerV3 extends BaseSmartTurn {
  protected _logData: boolean;
  protected _smartTurnModelPath: string;
  protected _sessionOptions: SmartTurnSessionOptions;
  protected _createSession: SmartTurnSessionFactory;
  protected _session: Promise<SmartTurnInferenceSession>;

  constructor(options: LocalSmartTurnAnalyzerV3Options = {}) {
    super(options);

    this._logData = envTruthy("PIPECAT_SMART_TURN_LOG_DATA", false);

    // Upstream loads the model bundled with the package by default.
    this._smartTurnModelPath = options.smartTurnModelPath || "smart-turn-v3.2-cpu.onnx";

    logger.debug(`Loading Local Smart Turn v3.x model from ${this._smartTurnModelPath}...`);

    this._sessionOptions = {
      executionMode: "sequential",
      interOpNumThreads: 1,
      intraOpNumThreads: options.cpuCount ?? 1,
      graphOptimizationLevel: "all",
    };
    this._createSession = options.createSession ?? notPortedSessionFactory;

    // Session creation is async in JS; it starts now and is awaited on first
    // prediction.
    this._session = this._createSession(this._smartTurnModelPath, this._sessionOptions).then(
      (session) => {
        logger.debug("Loaded Local Smart Turn v3.x");
        return session;
      },
    );
    // Errors surface on first use; don't report an unhandled rejection now.
    this._session.catch(() => {});
  }

  /**
   * Write audio data to a WAV file.
   *
   * STUB: core has no filesystem access; logs a warning instead.
   *
   * @param audioArray The audio data (float32, normalized to [-1, 1]).
   * @param sampleRate The sample rate of the audio data.
   * @param suffix Optional suffix to append to the filename.
   */
  protected _writeAudioToWav(
    _audioArray: Float32Array,
    _sampleRate: number = MODEL_SAMPLE_RATE,
    suffix = "",
  ): void {
    logger.warning(
      `Smart turn audio logging (${suffix}) is not ported yet: no filesystem access in core`,
    );
  }

  /**
   * Resample audio to the model's expected sample rate (16 kHz).
   *
   * @param audioArray Audio data as a float32 array.
   * @returns Resampled audio array at 16 kHz.
   */
  protected _resampleToModelRate(audioArray: Float32Array): Float32Array {
    const actualRate = this._sampleRate || MODEL_SAMPLE_RATE;
    if (actualRate === MODEL_SAMPLE_RATE) {
      return audioArray;
    }

    return soxrResample(audioArray, actualRate, MODEL_SAMPLE_RATE, "HQ");
  }

  /** Predict end-of-turn using local ONNX model. */
  protected async _predictEndpoint(audioArray: Float32Array): Promise<SmartTurnPrediction> {
    const audioForLogging = audioArray;
    const actualRate = this._sampleRate || MODEL_SAMPLE_RATE;

    // Resample to 16 kHz if the pipeline uses a different sample rate
    if (actualRate !== MODEL_SAMPLE_RATE) {
      // soxr is synchronous; our engine may still need loading.
      await getResamplerEngine();
    }
    audioArray = this._resampleToModelRate(audioArray);

    // Truncate to 8 seconds (keeping the end) or pad to 8 seconds
    audioArray = truncateAudioToLastNSeconds(audioArray, 8);

    // Compute Whisper-style log-mel features (vendored implementation).
    const logMel = computeWhisperLogMelFeatures(audioArray, { doNormalize: true });
    // Add batch dimension
    const inputFeatures: SmartTurnTensor = {
      data: logMel,
      dims: [1, WHISPER_NUM_MELS, WHISPER_NUM_FRAMES],
    };

    // Run ONNX inference
    const session = await this._session;
    const output = await session.run({ input_features: inputFeatures });

    // Extract probability (ONNX model returns sigmoid probabilities)
    const probability = Number(output[0]);

    // Make prediction (1 for Complete, 0 for Incomplete)
    const prediction = probability > 0.5 ? 1 : 0;

    if (this._logData) {
      const suffix = prediction === 1 ? "_complete" : "_incomplete";
      this._writeAudioToWav(audioForLogging, actualRate, suffix);
    }

    return {
      prediction,
      probability,
    };
  }
}
