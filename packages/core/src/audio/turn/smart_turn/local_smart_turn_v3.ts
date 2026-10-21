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
 *   `createSession`; `createLocalSmartTurnAnalyzerV3()` in
 *   `@pipedog/audio-smart-turn` wires it to `@pipedog/onnx` (onnxruntime-node
 *   or onnxruntime-web) and the model. Without one, the default factory throws.
 * - The model is not in core; `smartTurnModelPath` defaults to the upstream
 *   file name and is handed to `createSession` as is (`@pipedog/audio-smart-turn`
 *   ships the file).
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

/** The model file upstream bundles, and the default `smartTurnModelPath`. */
const DEFAULT_MODEL_NAME = "smart-turn-v3.2-cpu.onnx";

// Core has no ONNX runtime, and can't depend on @pipedog/audio-smart-turn (which
// depends on core), so it loads that package when it's installed. The specifier is
// held in a variable so bundlers leave the import alone.
const SMART_TURN_PACKAGE = "@pipedog/audio-smart-turn";

/**
 * The session factory used when none is passed: @pipedog/audio-smart-turn's,
 * with its shipped model for the default model name.
 */
const packageSessionFactory: SmartTurnSessionFactory = async (modelPath, options) => {
  const smartTurn = await import(SMART_TURN_PACKAGE);
  const model = modelPath === DEFAULT_MODEL_NAME ? smartTurn.defaultSmartTurnModelUrl() : modelPath;
  return smartTurn.onnxSmartTurnSessionFactory({ model })(modelPath, options);
};

let warnedFallback = false;

export interface LocalSmartTurnAnalyzerV3Options extends BaseSmartTurnOptions {
  /**
   * Path/URL to the ONNX model file. If not set, the upstream bundled model
   * name (smart-turn-v3.2-cpu.onnx) is used.
   */
  smartTurnModelPath?: string | null;
  /** The number of CPUs to use for inference. Defaults to 1. */
  cpuCount?: number;
  /**
   * Creates the ONNX inference session (injected runtime). Defaults to
   * @pipedog/audio-smart-turn's, when that package is installed; without it,
   * every turn is predicted complete, so turns end when the VAD hears silence.
   */
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
  #session: Promise<SmartTurnInferenceSession | null> | null = null;
  #explicitFactory: boolean;

  constructor(options: LocalSmartTurnAnalyzerV3Options = {}) {
    super(options);

    this._logData = envTruthy("PIPECAT_SMART_TURN_LOG_DATA", false);

    // Upstream loads the model bundled with the package by default.
    this._smartTurnModelPath = options.smartTurnModelPath || DEFAULT_MODEL_NAME;

    logger.debug(`Loading Local Smart Turn v3.x model from ${this._smartTurnModelPath}...`);

    this._sessionOptions = {
      executionMode: "sequential",
      interOpNumThreads: 1,
      intraOpNumThreads: options.cpuCount ?? 1,
      graphOptimizationLevel: "all",
    };
    this._createSession = options.createSession ?? packageSessionFactory;
    this.#explicitFactory = options.createSession !== undefined;
  }

  /**
   * The inference session, loaded on first use: `null` when no runtime is
   * available and turns fall back to the VAD.
   *
   * DIVERGENCE: upstream loads its model when the analyzer is created. Here it
   * loads on the first prediction, so an analyzer that never runs (the default
   * strategies replaced by a service's own turn detection) loads nothing. The
   * runtime is a separate package; without it (or where it can't load, e.g. a
   * bundle that leaves it out) turns end on the VAD's silence instead of
   * failing. A factory passed in explicitly still fails loudly.
   */
  protected get _session(): Promise<SmartTurnInferenceSession | null> {
    if (!this.#session) {
      const loading = this._createSession(this._smartTurnModelPath, this._sessionOptions).then(
        (session) => {
          logger.debug("Loaded Local Smart Turn v3.x");
          return session;
        },
      );
      this.#session = this.#explicitFactory
        ? loading
        : loading.catch((e) => {
            if (!warnedFallback) {
              warnedFallback = true;
              logger.warning(
                "Smart Turn is unavailable, so user turns end when the VAD hears silence. Install " +
                  `@pipedog/audio-smart-turn to detect the end of a turn from speech. (${e})`,
              );
            }
            return null;
          });
    }
    return this.#session;
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
    const session = await this._session;
    if (session === null) {
      // No runtime: the VAD's silence ends the turn.
      return { prediction: 1, probability: 1 };
    }
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
