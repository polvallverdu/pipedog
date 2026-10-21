// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/audio/vad/silero.py

/**
 * Silero Voice Activity Detection (VAD) implementation for Pipecat.
 *
 * This module provides a VAD analyzer based on the Silero VAD ONNX model,
 * which can detect voice activity in audio streams with high accuracy.
 * Supports 8kHz and 16kHz sample rates.
 *
 * PORTING NOTES:
 * - Inference goes through an `@pipedog/onnx` backend (onnxruntime-node or
 *   onnxruntime-web), passed as `backend` or created with `createOnnxBackend()`.
 *   JS ONNX runtimes are asynchronous, so the model call and `voiceConfidence`
 *   return promises; session creation starts in the constructor and is awaited
 *   on first use (a model that fails to load rejects `analyzeAudio`, where
 *   upstream fails in the constructor).
 * - The model is the upstream `silero_vad.onnx`, shipped in this package's
 *   `data/` and loaded from there by default on Bun, Node and Deno. `model`
 *   takes bytes, a path or a URL instead; on Cloudflare Workers it is required.
 * - Audio chunks are a `Float32Array` (one chunk) or `{ data, dims }` (a
 *   row-major batch), standing in for 1-D/2-D numpy arrays.
 * - `cleanup()` also releases the ONNX session.
 */

import { rethrowIfCancelled } from "@pipedog/asyncio";
import {
  VADAnalyzer,
  type VADAnalyzerOptions,
  VADState,
} from "@pipedog/core/audio/vad/vad_analyzer";
import { logger } from "@pipedog/core/utils/logger";
import {
  createOnnxBackend,
  float32Tensor,
  int64Tensor,
  type OnnxBackend,
  type OnnxModelSource,
  type OnnxSession,
  sharedSession,
} from "@pipedog/onnx";

// Model state resets.
//
// The model carries a recurrent state from one window to the next. Non-speech
// shifts that state so the model under-reports the speech that follows: music
// strongly at either sample rate, and long silence or noise strongly at 8kHz
// and slightly at 16kHz. A reset clears it.
//
// Seconds of audio between resets. After non-speech that suppresses detection,
// speech is detected again within about one interval. A shorter interval
// recovers sooner but puts more resets just ahead of speech, where the model
// occasionally confirms speech a few hundred milliseconds late.
const _MODEL_RESET_INTERVAL_SECS = 2.0;
// A due reset waits for clear non-speech: the VAD must be quiet and this many
// consecutive windows (about 160 ms) must score below this confidence. One low
// window can be a dip inside a word or the soft start of one; a run of them
// can't. The threshold sits far below the VAD's speech threshold, so borderline
// windows never count.
const _MODEL_RESET_MAX_CONFIDENCE = 0.1;
const _MODEL_RESET_LOW_CONFIDENCE_WINDOWS = 5;

/** The upstream model file name. */
export const SILERO_MODEL_NAME = "silero_vad.onnx";

/**
 * The model shipped with this package (`data/silero_vad.onnx`), as a URL.
 *
 * Readable on Bun, Node and Deno. On Cloudflare Workers there is no
 * filesystem: pass the model's bytes instead.
 */
export function defaultSileroModelUrl(): URL {
  return new URL(`../data/${SILERO_MODEL_NAME}`, import.meta.url);
}

/** An audio chunk: one chunk of samples, or a row-major batch `{ data, dims: [batch, samples] }`. */
export type SileroAudioInput = Float32Array | { data: Float32Array; dims: readonly number[] };

/** A 2-D chunk batch. */
interface SileroBatch {
  data: Float32Array;
  dims: [number, number];
}

export interface SileroOnnxModelOptions {
  /** Whether to force CPU execution provider. */
  forceOnnxCpu?: boolean;
  /** The ONNX backend (default: `createOnnxBackend()`). */
  backend?: OnnxBackend | Promise<OnnxBackend>;
  /**
   * Share one inference session with every other model for the same backend,
   * model and options (default `true`). The model's state lives in this
   * object, not the session, so sharing is safe; it loads the model once
   * instead of once per call.
   */
  shareSession?: boolean;
}

/**
 * ONNX runtime wrapper for the Silero VAD model.
 *
 * Provides voice activity detection using the pre-trained Silero VAD model
 * with ONNX runtime for efficient inference. Handles model state management
 * and input validation for audio processing.
 */
export class SileroOnnxModel {
  /** The inference session, resolved once the model has loaded. */
  session: Promise<OnnxSession>;
  sampleRates: number[];

  protected _state!: Float32Array;
  protected _stateBatchSize = 1;
  protected _context!: Float32Array;
  protected _contextSize = 0;
  protected _lastSr = 0;
  protected _lastBatchSize = 0;
  /** Whether this model owns its session (`shareSession: false`), so dispose releases it. */
  protected _ownsSession: boolean;

  /**
   * Initialize the Silero ONNX model.
   *
   * @param path Path to the ONNX model file (or its bytes, or a URL).
   * @param options `forceOnnxCpu`: whether to force CPU execution provider;
   *   `backend`: the ONNX backend to load it with.
   */
  constructor(path: OnnxModelSource, options: SileroOnnxModelOptions = {}) {
    const forceOnnxCpu = options.forceOnnxCpu ?? true;
    const backend = options.backend ?? createOnnxBackend();
    const sessionOptions = {
      forceCpu: forceOnnxCpu,
      interOpNumThreads: 1,
      intraOpNumThreads: 1,
    };
    // DIVERGENCE: upstream loads a session per model; sessions are shared here
    // by default, since a bot builds one VAD per call.
    this._ownsSession = options.shareSession === false;
    this.session = Promise.resolve(backend).then((b) =>
      this._ownsSession
        ? b.createSession(path, sessionOptions)
        : sharedSession(b, path, sessionOptions),
    );
    // Errors surface on first use; don't report an unhandled rejection now.
    this.session.catch(() => {});

    this.resetStates();
    this.sampleRates = [8000, 16000];
  }

  /** Validate and preprocess input audio data. */
  protected _validateInput(x: SileroAudioInput, sr: number): [SileroBatch, number] {
    let batch: SileroBatch;
    if (x instanceof Float32Array) {
      batch = { data: x, dims: [1, x.length] };
    } else if (x.dims.length === 1) {
      batch = { data: x.data, dims: [1, x.dims[0] as number] };
    } else if (x.dims.length > 2) {
      throw new Error(`Too many dimensions for input audio chunk ${x.dims.length}`);
    } else {
      batch = { data: x.data, dims: [x.dims[0] as number, x.dims[1] as number] };
    }

    if (!this.sampleRates.includes(sr)) {
      throw new Error(
        `Supported sampling rates: ${JSON.stringify(this.sampleRates)} (or multiple of 16000)`,
      );
    }
    if (sr / batch.dims[1] > 31.25) {
      throw new Error("Input audio chunk is too short");
    }

    return [batch, sr];
  }

  /**
   * Reset the internal model states.
   *
   * @param batchSize Batch size for state initialization. Defaults to 1.
   */
  resetStates(batchSize = 1): void {
    this._state = new Float32Array(2 * batchSize * 128);
    this._stateBatchSize = batchSize;
    this._context = new Float32Array(0);
    this._contextSize = 0;
    this._lastSr = 0;
    this._lastBatchSize = 0;
  }

  /**
   * Process audio input through the VAD model.
   *
   * Upstream's `__call__`.
   *
   * @returns The speech probability of each chunk in the batch (`[batch, 1]`, row-major).
   */
  async call(input: SileroAudioInput, srIn: number): Promise<Float32Array> {
    const [x, sr] = this._validateInput(input, srIn);
    const numSamples = sr === 16000 ? 512 : 256;

    if (x.dims[1] !== numSamples) {
      throw new Error(
        `Provided number of samples is ${x.dims[1]} (Supported values: 256 for 8000 sample rate, 512 for 16000)`,
      );
    }

    const batchSize = x.dims[0];
    const contextSize = sr === 16000 ? 64 : 32;

    if (!this._lastBatchSize) {
      this.resetStates(batchSize);
    }
    if (this._lastSr && this._lastSr !== sr) {
      this.resetStates(batchSize);
    }
    if (this._lastBatchSize && this._lastBatchSize !== batchSize) {
      this.resetStates(batchSize);
    }

    if (!this._contextSize) {
      this._context = new Float32Array(batchSize * contextSize);
      this._contextSize = contextSize;
    }

    // np.concatenate((self._context, x), axis=1)
    const width = this._contextSize + numSamples;
    const joined = new Float32Array(batchSize * width);
    for (let b = 0; b < batchSize; b++) {
      joined.set(
        this._context.subarray(b * this._contextSize, (b + 1) * this._contextSize),
        b * width,
      );
      joined.set(
        x.data.subarray(b * numSamples, (b + 1) * numSamples),
        b * width + this._contextSize,
      );
    }

    let out: Float32Array;
    if (sr === 8000 || sr === 16000) {
      const session = await this.session;
      const ortOuts = await session.run({
        input: float32Tensor(joined, [batchSize, width]),
        state: float32Tensor(this._state, [2, this._stateBatchSize, 128]),
        sr: int64Tensor(BigInt64Array.of(BigInt(sr)), []),
      });
      out = ortOuts[session.outputNames[0] as string]!.data as Float32Array;
      this._state = ortOuts[session.outputNames[1] as string]!.data as Float32Array;
    } else {
      throw new Error();
    }

    // self._context = x[..., -context_size:]
    const context = new Float32Array(batchSize * contextSize);
    for (let b = 0; b < batchSize; b++) {
      context.set(joined.subarray((b + 1) * width - contextSize, (b + 1) * width), b * contextSize);
    }
    this._context = context;
    this._contextSize = contextSize;
    this._lastSr = sr;
    this._lastBatchSize = batchSize;

    return out;
  }

  /** Release the ONNX session, if this model owns it (a shared one stays loaded). */
  async dispose(): Promise<void> {
    const session = await this.session.catch(() => null);
    if (this._ownsSession) await session?.dispose();
  }
}

/** The part of the model wrapper the analyzer uses. */
export interface SileroModel {
  call(x: SileroAudioInput, sr: number): Promise<Float32Array>;
  resetStates(batchSize?: number): void;
}

export interface SileroVADAnalyzerOptions extends VADAnalyzerOptions {
  /**
   * The Silero model: bytes, a path or a URL. Defaults to the upstream model
   * shipped with this package (Bun, Node, Deno). Required on Cloudflare Workers.
   */
  model?: OnnxModelSource;
  /** The ONNX backend (default: `createOnnxBackend()`). */
  backend?: OnnxBackend | Promise<OnnxBackend>;
  /** Share the inference session across analyzers (default `true`); see `SileroOnnxModelOptions`. */
  shareSession?: boolean;
}

/**
 * Voice Activity Detection analyzer using the Silero VAD model.
 *
 * Implements VAD analysis using the pre-trained Silero ONNX model for
 * accurate voice activity detection. Supports 8kHz and 16kHz sample rates.
 *
 * The model's recurrent state is reset about every two seconds of audio, but
 * only during clear non-speech. Non-speech such as music, or long silence at
 * 8kHz, leaves the state unable to detect the speech that follows until it is
 * reset. A reset during speech makes the model briefly lose confidence, which
 * can end the user's speech early, so a due reset waits until the user is
 * quiet.
 *
 * @example
 * ```ts
 * const vad = new SileroVADAnalyzer({ sampleRate: 16000 });
 * // Cloudflare Workers: pass the model's bytes, e.g. from R2
 * const vad = new SileroVADAnalyzer({ model: await (await env.MODELS.get("silero_vad.onnx")).bytes() });
 * ```
 */
export class SileroVADAnalyzer extends VADAnalyzer {
  protected _model: SileroModel;
  protected _modelLoaded: Promise<unknown>;
  protected _windowsSinceReset: number;
  protected _lowConfidenceWindows: number;

  /**
   * Initialize the Silero VAD analyzer.
   *
   * @param options `sampleRate`: audio sample rate (8000 or 16000 Hz), if null
   *   it will be set later; `params`: VAD parameters for detection thresholds
   *   and timing; `model` / `backend`: where the model and runtime come from.
   */
  constructor(options: SileroVADAnalyzerOptions = {}) {
    super(options);

    logger.debug("Loading Silero VAD model...");

    const modelFilePath = options.model ?? defaultSileroModelUrl();

    const model = new SileroOnnxModel(modelFilePath, {
      forceOnnxCpu: true,
      backend: options.backend,
      shareSession: options.shareSession,
    });
    this._model = model;
    this._modelLoaded = model.session.then(() => logger.debug("Loaded Silero VAD"));
    this._modelLoaded.catch((e) => logger.error("Error loading Silero VAD model", e));

    // Windows scored since the model was last reset, and how many of the
    // most recent windows in a row scored below _MODEL_RESET_MAX_CONFIDENCE.
    this._windowsSinceReset = 0;
    this._lowConfidenceWindows = 0;
  }

  /** Resolves once the model has loaded (rejects if it cannot be). */
  ready(): Promise<void> {
    return this._modelLoaded.then(() => {});
  }

  //
  // VADAnalyzer
  //

  /**
   * Set the sample rate for audio processing.
   *
   * @param sampleRate Audio sample rate (must be 8000 or 16000 Hz).
   * @throws Error If sample rate is not 8000 or 16000 Hz.
   */
  override setSampleRate(sampleRate: number): void {
    if (sampleRate !== 16000 && sampleRate !== 8000) {
      throw new Error(
        `Silero VAD sample rate needs to be 16000 or 8000 (sample rate: ${sampleRate})`,
      );
    }

    super.setSampleRate(sampleRate);
  }

  /**
   * Get the number of audio frames required for VAD analysis.
   *
   * @returns Number of frames required (512 for 16kHz, 256 for 8kHz).
   */
  numFramesRequired(): number {
    return this.sampleRate === 16000 ? 512 : 256;
  }

  /**
   * Calculate voice activity confidence for the given audio buffer.
   *
   * @param buffer Audio buffer to analyze.
   * @returns Voice confidence score between 0.0 and 1.0.
   */
  async voiceConfidence(buffer: Uint8Array): Promise<number> {
    // A model that cannot load is an error for the caller, not a quiet window.
    await this._modelLoaded;
    try {
      const bytes = buffer.byteOffset % 2 === 0 ? buffer : buffer.slice();
      const audioInt16 = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.length >> 1);
      // Divide by 32768 because we have signed 16-bit data.
      const audioFloat32 = new Float32Array(audioInt16.length);
      for (let i = 0; i < audioInt16.length; i++) {
        audioFloat32[i] = (audioInt16[i] as number) / 32768.0;
      }
      const confidence = (await this._model.call(audioFloat32, this.sampleRate))[0] as number;
      this._maybeResetModel(confidence);
      return confidence;
    } catch (e) {
      rethrowIfCancelled(e);
      // This comes from an empty audio array
      logger.error(`Error analyzing audio with Silero VAD: ${e instanceof Error ? e.message : e}`);
      return 0;
    }
  }

  /**
   * Reset the model's state once a reset is due and the user is quiet.
   *
   * Called after each window is scored, so a reset takes effect from the
   * next window. A reset clears the model's recurrent state and the audio
   * context it prepends to each window; the VAD's own state is untouched.
   *
   * A reset becomes due after `_MODEL_RESET_INTERVAL_SECS` of audio, and
   * happens on the first window after that where the user is quiet and the
   * recent windows are clearly non-speech. `_vadState` is still the
   * state from before this window, since the caller updates it from the
   * confidence returned here. In practice a reset follows soon after the
   * user stops speaking, and recurs every interval during non-speech.
   *
   * Time is counted in windows of audio rather than by the wall clock, so
   * where resets land depends only on the audio.
   *
   * @param confidence The model's speech confidence for the window just scored.
   */
  protected _maybeResetModel(confidence: number): void {
    this._windowsSinceReset += 1;
    if (confidence < _MODEL_RESET_MAX_CONFIDENCE) {
      this._lowConfidenceWindows += 1;
    } else {
      this._lowConfidenceWindows = 0;
    }

    if (
      this._windowsSinceReset * this.numFramesRequired() >=
        _MODEL_RESET_INTERVAL_SECS * this.sampleRate &&
      this._vadState === VADState.QUIET &&
      this._lowConfidenceWindows >= _MODEL_RESET_LOW_CONFIDENCE_WINDOWS
    ) {
      this._model.resetStates();
      this._windowsSinceReset = 0;
    }
  }

  /** Release the analyzer's resources, including the ONNX session. */
  override async cleanup(): Promise<void> {
    await super.cleanup();
    if (this._model instanceof SileroOnnxModel) await this._model.dispose();
  }
}
