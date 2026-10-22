// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/services/whisper/stt.py

/**
 * Whisper speech-to-text services with locally-downloaded models.
 *
 * This module implements Whisper transcription using locally-downloaded models.
 *
 * Porting notes:
 * - Upstream runs Whisper with faster-whisper (CTranslate2) and, on Apple
 *   Silicon, mlx_whisper. Neither exists in JavaScript, so both services run on
 *   `./faster_whisper.ts`: faster-whisper's `WhisperModel` API and decoding
 *   algorithm re-implemented on `@pipedog/onnx`, with the Hugging Face ONNX
 *   exports of the same Whisper checkpoints. Upstream's model names map to
 *   those exports (see `ONNX_WHISPER_MODELS` / `CT2_REPO_ALIASES`).
 * - `WhisperSTTServiceMLX` is NOT MLX: it keeps upstream's class, settings,
 *   model names and filtering, but its engine is the same ONNX Whisper, with
 *   mlx_whisper's decoding options (greedy, the configured temperature only).
 * - The deprecated constructor arguments `model`, `no_speech_prob`,
 *   `language` and `temperature` are not ported. Use `settings`.
 * - Upstream loads the model in the constructor (blocking, downloading it on
 *   first use). Loading is async here: the constructor resolves and validates
 *   the model name, and the files load in `start()` (or on the first segment).
 */

import { rethrowIfCancelled } from "@pipedog/asyncio";
import {
  ErrorFrame,
  type Frame,
  type StartFrame,
  TranscriptionFrame,
} from "@pipedog/core/frames/frames";
import { STTSettings, type STTSettingsOptions } from "@pipedog/core/services/settings";
import {
  SegmentedSTTService,
  type SegmentedSTTServiceOptions,
} from "@pipedog/core/services/stt_service";
import { Language, resolveLanguage } from "@pipedog/core/transcriptions/language";
import { logger } from "@pipedog/core/utils/logger";
import { timeNowIso8601 } from "@pipedog/core/utils/time";
import { installTracedStt } from "@pipedog/core/utils/tracing/service_decorators";
import {
  assertGiven,
  isGiven,
  NOT_GIVEN,
  type NotGiven,
  requireGiven,
} from "@pipedog/core/utils/types";
import { type WhisperDtype, WhisperModel, type WhisperModelOptions } from "./faster_whisper.ts";

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Python's `repr()` of a sorted list of strings, for error messages. */
function pyListRepr(values: readonly string[]): string {
  return `[${[...values]
    .sort()
    .map((v) => `'${v}'`)
    .join(", ")}]`;
}

/** 16-bit signed PCM to float32 in [-1, 1). */
function pcm16ToFloat32(audio: Uint8Array): Float32Array {
  const bytes = audio.byteOffset % 2 === 0 ? audio : audio.slice();
  const samples = new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.length / 2));
  const out = new Float32Array(samples.length);
  // Divide by 32768 because we have signed 16-bit data.
  for (let i = 0; i < samples.length; i++) out[i] = (samples[i] as number) / 32768.0;
  return out;
}

/**
 * Whisper model selection options for Faster Whisper.
 *
 * Provides various model sizes and specializations for speech recognition,
 * balancing quality and performance based on use case requirements. Each
 * value resolves to the ONNX export of the same checkpoint (see
 * `ONNX_WHISPER_MODELS` and `CT2_REPO_ALIASES` in `./faster_whisper.ts`).
 *
 * - `TINY`: smallest multilingual model, fastest inference.
 * - `BASE`: basic multilingual model, good speed/quality balance.
 * - `SMALL`: small multilingual model, better speed/quality balance than BASE.
 * - `MEDIUM`: medium-sized multilingual model, better quality.
 * - `LARGE`: best quality multilingual model, slower inference.
 * - `LARGE_V3_TURBO`: fast multilingual model, slightly lower quality than LARGE.
 * - `DISTIL_LARGE_V2`: fast English-only distilled model.
 * - `DISTIL_MEDIUM_EN`: fast English-only distilled model.
 */
export const Model = {
  // Multilingual models
  TINY: "tiny",
  BASE: "base",
  SMALL: "small",
  MEDIUM: "medium",
  LARGE: "large-v3",
  LARGE_V3_TURBO: "deepdml/faster-whisper-large-v3-turbo-ct2",

  // English-only models. The distilled models keep the multilingual tokenizer
  // of their teacher, so the loaded model reports itself as multilingual and
  // the language check can't reject a non-English language for them.
  DISTIL_LARGE_V2: "Systran/faster-distil-whisper-large-v2",
  DISTIL_MEDIUM_EN: "Systran/faster-distil-whisper-medium.en",
} as const;
export type Model = (typeof Model)[keyof typeof Model];

/**
 * MLX Whisper model selection options (upstream: for Apple Silicon).
 *
 * Here they select the ONNX export of the same checkpoint (see
 * `MLX_MODEL_TO_ONNX`); `LARGE_V3_TURBO_Q4` selects its 4-bit (`q4`) weights.
 *
 * - `TINY`: smallest multilingual model.
 * - `MEDIUM`: medium-sized multilingual model.
 * - `LARGE_V3`: best quality multilingual model.
 * - `LARGE_V3_TURBO`: finetuned, pruned Whisper large-v3, much faster with
 *   slightly lower quality.
 * - `LARGE_V3_TURBO_Q4`: LARGE_V3_TURBO quantized to Q4 for reduced memory usage.
 * - `DISTIL_LARGE_V3`: fast English-only distilled model.
 */
export const MLXModel = {
  // Multilingual models
  TINY: "mlx-community/whisper-tiny",
  MEDIUM: "mlx-community/whisper-medium-mlx",
  LARGE_V3: "mlx-community/whisper-large-v3-mlx",
  LARGE_V3_TURBO: "mlx-community/whisper-large-v3-turbo",
  LARGE_V3_TURBO_Q4: "mlx-community/whisper-large-v3-turbo-q4",

  // English-only models
  DISTIL_LARGE_V3: "mlx-community/distil-whisper-large-v3",
} as const;
export type MLXModel = (typeof MLXModel)[keyof typeof MLXModel];

/**
 * The faster-whisper model name (and weight variant) the ONNX engine loads
 * for each `MLXModel` value. Other names are passed to `WhisperModel` as is.
 */
export const MLX_MODEL_TO_ONNX: Readonly<Record<string, { model: string; dtype?: WhisperDtype }>> =
  {
    [MLXModel.TINY]: { model: "tiny" },
    [MLXModel.MEDIUM]: { model: "medium" },
    [MLXModel.LARGE_V3]: { model: "large-v3" },
    [MLXModel.LARGE_V3_TURBO]: { model: "large-v3-turbo" },
    [MLXModel.LARGE_V3_TURBO_Q4]: { model: "large-v3-turbo", dtype: "q4" },
    [MLXModel.DISTIL_LARGE_V3]: { model: "distil-large-v3" },
  };

/**
 * Maps pipecat Language enum to Whisper language codes.
 *
 * Only includes languages officially supported by Whisper.
 *
 * Note: `@pipedog/whisper/base_stt` exports a different function of the same
 * name (the Whisper API's language list); the package root re-exports that one.
 *
 * @param language A Language value representing the input language.
 * @returns The corresponding service language code. If `language` is not in
 *   the verified mapping, falls back to the base language code (e.g. `en` from
 *   `en-US`) and logs a warning (via `resolveLanguage(..., useBaseCode=true)`).
 */
export function languageToWhisperLanguage(language: Language): string {
  const LANGUAGE_MAP: Partial<Record<Language, string>> = {
    // Arabic
    [Language.AR]: "ar",
    // Bengali
    [Language.BN]: "bn",
    // Czech
    [Language.CS]: "cs",
    // Danish
    [Language.DA]: "da",
    // German
    [Language.DE]: "de",
    // Greek
    [Language.EL]: "el",
    // English
    [Language.EN]: "en",
    // Spanish
    [Language.ES]: "es",
    // Persian
    [Language.FA]: "fa",
    // Finnish
    [Language.FI]: "fi",
    // French
    [Language.FR]: "fr",
    // Hindi
    [Language.HI]: "hi",
    // Hungarian
    [Language.HU]: "hu",
    // Indonesian
    [Language.ID]: "id",
    // Italian
    [Language.IT]: "it",
    // Japanese
    [Language.JA]: "ja",
    // Korean
    [Language.KO]: "ko",
    // Dutch
    [Language.NL]: "nl",
    // Polish
    [Language.PL]: "pl",
    // Portuguese
    [Language.PT]: "pt",
    // Romanian
    [Language.RO]: "ro",
    // Russian
    [Language.RU]: "ru",
    // Slovak
    [Language.SK]: "sk",
    // Swedish
    [Language.SV]: "sv",
    // Thai
    [Language.TH]: "th",
    // Turkish
    [Language.TR]: "tr",
    // Ukrainian
    [Language.UK]: "uk",
    // Urdu
    [Language.UR]: "ur",
    // Vietnamese
    [Language.VI]: "vi",
    // Chinese
    [Language.ZH]: "zh",
  };

  return resolveLanguage(language, LANGUAGE_MAP, true);
}

export interface WhisperSTTSettingsOptions extends STTSettingsOptions {
  /** Probability threshold for filtering non-speech segments. */
  noSpeechProb?: number | NotGiven;
  /**
   * Words or phrases to bias the transcription towards, as a single
   * space-separated string (e.g. product names or jargon).
   */
  hotwords?: string | null | NotGiven;
  /**
   * Text prepended to the decoder prompt as preceding context, steering style,
   * punctuation and spelling (e.g. a sample sentence in the wording the
   * transcript should use).
   */
  initialPrompt?: string | null | NotGiven;
}

/**
 * Settings for WhisperSTTService.
 *
 * - `noSpeechProb`: probability threshold for filtering non-speech segments.
 * - `hotwords`: words or phrases to bias the transcription towards, as a
 *   single space-separated string (e.g. product names or jargon).
 * - `initialPrompt`: text prepended to the decoder prompt as preceding
 *   context, steering style, punctuation and spelling.
 */
export class WhisperSTTSettings extends STTSettings {
  noSpeechProb: number | NotGiven = NOT_GIVEN;
  hotwords: string | null | NotGiven = NOT_GIVEN;
  initialPrompt: string | null | NotGiven = NOT_GIVEN;

  constructor(options: WhisperSTTSettingsOptions = {}) {
    super(options);
    this._assignOptions(options);
  }
}

export interface WhisperMLXSTTSettingsOptions extends STTSettingsOptions {
  /** Probability threshold for filtering non-speech segments. */
  noSpeechProb?: number | NotGiven;
  /** Sampling temperature (0.0-1.0). */
  temperature?: number | NotGiven;
  /** Whisper engine identifier. */
  engine?: string | NotGiven;
}

/**
 * Settings for WhisperSTTServiceMLX.
 *
 * - `noSpeechProb`: probability threshold for filtering non-speech segments.
 * - `temperature`: sampling temperature (0.0-1.0).
 * - `engine`: Whisper engine identifier.
 */
export class WhisperMLXSTTSettings extends STTSettings {
  noSpeechProb: number | NotGiven = NOT_GIVEN;
  temperature: number | NotGiven = NOT_GIVEN;
  engine: string | NotGiven = NOT_GIVEN;

  constructor(options: WhisperMLXSTTSettingsOptions = {}) {
    super(options);
    this._assignOptions(options);
  }
}

/** One segment as the service reads it (faster-whisper's `Segment`). */
export interface WhisperSegmentLike {
  text: string;
  noSpeechProb: number;
  compressionRatio?: number;
}

/**
 * The part of `WhisperModel` the service uses, so a stand-in can be injected
 * (upstream tests patch `faster_whisper.WhisperModel` the same way).
 */
export interface WhisperModelLike {
  readonly supportedLanguages?: readonly string[] | null;
  load?(): Promise<void>;
  transcribe(
    audio: Float32Array,
    options: Record<string, unknown>,
  ):
    | Promise<readonly [AsyncIterable<WhisperSegmentLike> | Iterable<WhisperSegmentLike>, unknown]>
    | readonly [AsyncIterable<WhisperSegmentLike> | Iterable<WhisperSegmentLike>, unknown];
}

/**
 * Options for WhisperSTTService.
 *
 * - `device`: the device to run inference on ('cpu', 'cuda', or 'auto').
 *   Defaults to "auto".
 * - `computeType`: the compute type for inference ('default', 'int8',
 *   'float32', etc., or an ONNX dtype such as 'q4'). Defaults to "default".
 * - `settings`: runtime-updatable settings.
 * - `modelOptions`: options for the ONNX engine (backend, download root,
 *   explicit files, dtype, ...). Not in upstream.
 *
 * Other options are passed to SegmentedSTTService.
 */
export interface WhisperSTTServiceOptions extends SegmentedSTTServiceOptions {
  /** The device to run inference on ('cpu', 'cuda', or 'auto'). Defaults to "auto". */
  device?: string;
  /**
   * The compute type for inference ('default', 'int8', 'int8_float16', 'float32',
   * ... or an ONNX dtype: 'fp32', 'q8', 'int8', 'uint8', 'q4', 'bnb4'). Defaults
   * to "default" (fp32 encoder, int8 decoder).
   */
  computeType?: string;
  /** Runtime-updatable settings. When provided, its values take precedence. */
  settings?: WhisperSTTSettings | null;
  /** Options for the ONNX engine (`WhisperModel`). Not in upstream. */
  modelOptions?: Omit<WhisperModelOptions, "device" | "computeType">;
}

/**
 * Class to transcribe audio with a locally-downloaded Whisper model.
 *
 * This service runs faster-whisper's algorithm (here on ONNX Runtime, see
 * `./faster_whisper.ts`) to perform speech-to-text transcription on audio
 * segments. It supports multiple languages and various model sizes.
 *
 * The audio must be 16 kHz (the pipeline's input sample rate), as upstream
 * assumes: segments are not resampled.
 */
export class WhisperSTTService extends SegmentedSTTService {
  static Settings: typeof WhisperSTTSettings = WhisperSTTSettings;
  declare protected _settings: WhisperSTTSettings;

  protected _device: string;
  protected _computeType: string;
  protected _modelOptions: Omit<WhisperModelOptions, "device" | "computeType">;
  protected _model: WhisperModelLike | null = null;

  /** Receive segments as raw 16-bit PCM, which the model reads directly. */
  override get wantsWavSegments(): boolean {
    return false;
  }

  /** The default settings; `WhisperSTTServiceMLX` overrides them. */
  protected static _defaultSettings(): STTSettings {
    return new WhisperSTTSettings({
      model: Model.DISTIL_MEDIUM_EN,
      language: Language.EN,
      noSpeechProb: 0.4,
      hotwords: null,
      initialPrompt: null,
    });
  }

  /**
   * Initialize the Whisper STT service.
   *
   * @param options.device The device to run inference on ('cpu', 'cuda', or
   *   'auto'). Defaults to "auto".
   * @param options.computeType The compute type for inference ('default',
   *   'int8', 'int8_float16', etc.). Defaults to "default".
   * @param options.settings Runtime-updatable settings. When provided, its
   *   values take precedence over the defaults.
   * @param options.modelOptions Options for the ONNX engine. Not in upstream.
   *   Other options are passed to SegmentedSTTService.
   * @throws Error If the model is not specified, or can't transcribe the
   *   configured language (upstream: ValueError).
   */
  constructor(options: WhisperSTTServiceOptions = {}) {
    // --- 1. Hardcoded defaults ---
    const defaultSettings = (new.target as typeof WhisperSTTService)._defaultSettings();

    // --- 2. (deprecated direct-arg overrides are not ported) ---

    // --- 3. (no params object for this service) ---

    // --- 4. Settings delta (canonical API, always wins) ---
    if (options.settings !== undefined && options.settings !== null) {
      defaultSettings.applyUpdate(options.settings);
    }

    super({ ...options, settings: defaultSettings });

    // Init-only inference config
    this._device = options.device ?? "auto";
    this._computeType = options.computeType ?? "default";
    this._modelOptions = options.modelOptions ?? {};

    this._model = null;

    this._load();
  }

  /**
   * Indicates whether this service can generate metrics.
   *
   * @returns True, as this service supports metric generation.
   */
  override canGenerateMetrics(): boolean {
    return true;
  }

  /**
   * Convert from pipecat Language to Whisper language code.
   *
   * @param language The Language value to convert.
   * @returns The corresponding Whisper language code, or null if not supported.
   */
  override languageToServiceLanguage(language: Language): string | null {
    return languageToWhisperLanguage(language);
  }

  /**
   * Creates the Whisper model.
   *
   * DIVERGENCE: upstream loads the model here, synchronously (downloading it
   * from the Hugging Face hub on first use). Here the model is created without
   * reading any file; its files load in `start()` or on the first segment.
   * The language check runs now when the model name tells whether it is
   * English-only (every faster-whisper name does), else after loading.
   *
   * @throws Error If the model can't transcribe the configured language.
   */
  protected _load(): void {
    logger.debug("Loading Whisper model...");
    const modelName = requireGiven(this._settings.model, "Whisper model");
    this._model = new WhisperModel(modelName, {
      ...this._modelOptions,
      device: this._device,
      computeType: this._computeType,
    });
    logger.debug("Created Whisper model");
    const unsupported = this._unsupportedLanguage();
    if (unsupported) {
      throw new Error(unsupported);
    }
  }

  /**
   * Describe why the loaded model can't transcribe the current language.
   *
   * The English-only models (every `.en` one, including the default) accept
   * any language and transcribe as English regardless, so a mismatch would
   * otherwise surface as fluent-looking output in the wrong language rather
   * than as an error. A language of null asks Whisper to detect the language
   * itself, which every model supports.
   *
   * @returns An explanatory message, or null when the pairing is usable.
   */
  protected _unsupportedLanguage(): string | null {
    const supported = this._model?.supportedLanguages ?? null;
    const language = this._settings.language;
    if (!supported || supported.length === 0 || !isGiven(language) || language === null) {
      return null;
    }
    if (supported.includes(language)) {
      return null;
    }
    return (
      `Whisper model '${assertGiven(this._settings.model)}' cannot transcribe ` +
      `'${language}' — it supports only ${pyListRepr(supported)}. Use a multilingual ` +
      "model (e.g. 'large-v3-turbo')."
    );
  }

  /**
   * Apply a settings delta, reporting a language the model can't handle.
   *
   * A mid-call switch to an unsupported language is reported rather than
   * raised, so a settings change can't tear down a live pipeline; the model
   * stays loaded and keeps transcribing as English.
   *
   * @param delta An STT settings delta.
   * @returns Record mapping changed field names to their previous values.
   */
  protected override async _updateSettings(delta: STTSettings): Promise<Record<string, unknown>> {
    const changed = await super._updateSettings(delta);
    if ("language" in changed) {
      const unsupported = this._unsupportedLanguage();
      if (unsupported) {
        await this.pushError(unsupported);
      }
    }
    return changed;
  }

  /**
   * Start the service and load the model's files.
   *
   * DIVERGENCE: upstream has loaded the model by now (in the constructor).
   * A failed load is reported with `pushError`, and retried on the next segment.
   *
   * @param frame The start frame.
   */
  override async start(frame: StartFrame): Promise<void> {
    await super.start(frame);
    await this._ensureModelLoaded();
  }

  /** Load the model's files if needed, reporting failures and unusable languages. */
  protected async _ensureModelLoaded(): Promise<void> {
    const model = this._model;
    if (!model?.load) return;
    try {
      await model.load();
      logger.debug("Loaded Whisper model");
    } catch (e) {
      rethrowIfCancelled(e);
      await this.pushError(`Failed to load Whisper model: ${errorMessage(e)}`, { exception: e });
      return;
    }
    // A custom model's languages are only known once it is loaded.
    const unsupported = this._unsupportedLanguage();
    if (unsupported) {
      await this.pushError(unsupported);
    }
  }

  /** Handle a transcription result with tracing. */
  protected async _handleTranscription(
    _transcript: string,
    _isFinal: boolean,
    _language: Language | string | null = null,
  ): Promise<void> {}

  static {
    installTracedStt(WhisperSTTService.prototype, "_handleTranscription");
  }

  /**
   * Transcribe audio data using Whisper.
   *
   * The audio is expected to be 16-bit signed PCM data. The service will
   * normalize it to float32 in the range [-1, 1].
   *
   * @param audio Raw audio bytes in 16-bit PCM format.
   * @yields Either a TranscriptionFrame containing the transcribed text or an
   *   ErrorFrame if transcription fails.
   */
  override async *runStt(audio: Uint8Array): AsyncGenerator<Frame, void, unknown> {
    if (!this._model) {
      yield new ErrorFrame({ error: "Whisper model not available" });
      return;
    }

    // DIVERGENCE: the model's files may not be loaded yet (see `_load`).
    await this._model.load?.();

    await this.startProcessingMetrics();

    const audioFloat = pcm16ToFloat32(audio);

    // The stored language is a Whisper code rather than a Language, but a
    // Language is a string too, so downstream handles either.
    const language = assertGiven(this._settings.language) as Language | null;
    const model = this._model;
    const hotwords = assertGiven(this._settings.hotwords);
    const initialPrompt = assertGiven(this._settings.initialPrompt);

    // DIVERGENCE: upstream consumes faster-whisper's lazy generator in a
    // worker thread (`asyncio.to_thread`). There are no threads here: the
    // segments are consumed on the event loop, and each decoder step awaits
    // the ONNX runtime (onnxruntime-node runs inference on its own threads).
    const [segments] = await model.transcribe(audioFloat, {
      language,
      hotwords,
      initialPrompt,
    });
    let text = "";
    const noSpeechProbThreshold = assertGiven(this._settings.noSpeechProb);
    for await (const segment of segments) {
      if (
        noSpeechProbThreshold !== null &&
        noSpeechProbThreshold !== undefined &&
        segment.noSpeechProb < noSpeechProbThreshold
      ) {
        text += `${segment.text} `;
      }
    }

    await this.stopProcessingMetrics();

    if (text) {
      await this._handleTranscription(text, true, language);
      logger.debug(`Transcription: [${text}]`);
      yield new TranscriptionFrame({
        text,
        userId: this._userId,
        timestamp: timeNowIso8601(),
        language,
      });
    }
  }
}

/**
 * Options for WhisperSTTServiceMLX.
 *
 * - `settings`: runtime-updatable settings.
 * - `modelOptions`: options for the ONNX engine. Not in upstream.
 *
 * Other options are passed to SegmentedSTTService.
 */
export interface WhisperSTTServiceMLXOptions
  extends Omit<WhisperSTTServiceOptions, "settings" | "device" | "computeType"> {
  /** Runtime-updatable settings. When provided, its values take precedence. */
  settings?: WhisperMLXSTTSettings | null;
}

/**
 * Subclass of `WhisperSTTService` with MLX Whisper model support.
 *
 * Upstream uses MLX Whisper, which only runs on Apple Silicon. There is no MLX
 * runtime in JavaScript, so this port keeps the class, its settings, its model
 * names and its segment filtering, but runs the same ONNX Whisper engine as
 * `WhisperSTTService` (the `MLXModel` names select the ONNX export of the same
 * checkpoint), on any platform ONNX Runtime supports. Like mlx_whisper, it
 * decodes greedily at the configured temperature and loads the model on demand.
 */
export class WhisperSTTServiceMLX extends WhisperSTTService {
  // Upstream's MLX settings are not a WhisperSTTSettings subclass (Python
  // allows that), so `Settings` and `_settings` differ from the parent's.
  static override Settings: typeof WhisperMLXSTTSettings = WhisperMLXSTTSettings;
  // @ts-expect-error -- a different settings class than the parent's (see above).
  declare protected _settings: WhisperMLXSTTSettings;

  #engine: { name: string; model: WhisperModel } | null = null;

  protected static override _defaultSettings(): STTSettings {
    return new WhisperMLXSTTSettings({
      model: MLXModel.TINY,
      language: Language.EN,
      noSpeechProb: 0.6,
      temperature: 0.0,
      engine: "mlx",
    });
  }

  /**
   * Initialize the MLX Whisper STT service.
   *
   * @param options.settings Runtime-updatable settings. When provided, its
   *   values take precedence over the defaults.
   * @param options.modelOptions Options for the ONNX engine. Not in upstream.
   *   Other options are passed to SegmentedSTTService.
   * @throws Error If the model is not specified (upstream: ValueError).
   */
  constructor(options: WhisperSTTServiceMLXOptions = {}) {
    // Upstream skips WhisperSTTService.__init__; here the parent constructor
    // runs with this class's defaults and a no-op `_load`.
    super(options as WhisperSTTServiceOptions);

    // MLX Whisper loads the model on demand, so only the name is checked here.
    requireGiven(this._settings.model, "Whisper model");
    // No model is held, so there are no supported languages to check
    // against when the language changes.
    this._model = null;
  }

  /** MLX Whisper loads models on demand, so this is a no-op. */
  protected override _load(): void {}

  /** The model loads on demand (in `runStt`), as MLX Whisper does. */
  protected override async _ensureModelLoaded(): Promise<void> {}

  /** Handle a transcription result with tracing. */
  protected override async _handleTranscription(
    _transcript: string,
    _isFinal: boolean,
    _language: Language | string | null = null,
  ): Promise<void> {}

  static {
    installTracedStt(WhisperSTTServiceMLX.prototype, "_handleTranscription");
  }

  /** The engine for `modelPath`, created on first use and kept while the name is unchanged. */
  protected _engineFor(modelPath: string): WhisperModel {
    if (this.#engine?.name !== modelPath) {
      const mapped = MLX_MODEL_TO_ONNX[modelPath];
      const name = mapped?.model ?? modelPath;
      this.#engine = {
        name: modelPath,
        model: new WhisperModel(name, {
          ...this._modelOptions,
          ...(mapped?.dtype ? { dtype: mapped.dtype } : {}),
        }),
      };
    }
    return this.#engine.model;
  }

  /**
   * Transcribe audio data using MLX Whisper (here: the ONNX engine).
   *
   * The audio is expected to be 16-bit signed PCM data.
   *
   * @param audio Raw audio bytes in 16-bit PCM format.
   * @yields Either a TranscriptionFrame containing the transcribed text or an
   *   ErrorFrame if transcription fails.
   */
  override async *runStt(audio: Uint8Array): AsyncGenerator<Frame, void, unknown> {
    try {
      await this.startProcessingMetrics();

      const audioFloat = pcm16ToFloat32(audio);

      const modelPath = requireGiven(this._settings.model, "Whisper model");
      const temperature = assertGiven(this._settings.temperature);
      const language = assertGiven(this._settings.language) as Language | null;
      const model = this._engineFor(modelPath);
      // mlx_whisper.transcribe's defaults: greedy decoding (no beam search),
      // only the given temperature (no fallback list).
      const [segments] = await model.transcribe(audioFloat, {
        temperature,
        language,
        beamSize: 1,
        bestOf: 1,
      });
      let text: string | null = "";
      const noSpeechProbThreshold = assertGiven(this._settings.noSpeechProb);
      for await (const segment of segments) {
        // Drop likely hallucinations
        if (segment.compressionRatio === 0.5555555555555556) {
          continue;
        }

        if (
          noSpeechProbThreshold !== null &&
          noSpeechProbThreshold !== undefined &&
          (segment.noSpeechProb ?? 0.0) < noSpeechProbThreshold
        ) {
          text += `${segment.text ?? ""} `;
        }
      }

      if (text.trim().length === 0) {
        text = null;
      }

      await this.stopProcessingMetrics();

      if (text) {
        await this._handleTranscription(text, true, language);
        logger.debug(`Transcription: [${text}]`);
        yield new TranscriptionFrame({
          text,
          userId: this._userId,
          timestamp: timeNowIso8601(),
          language,
        });
      }
    } catch (e) {
      rethrowIfCancelled(e);
      yield new ErrorFrame({ error: `Unknown error occurred: ${errorMessage(e)}` });
    }
  }
}
