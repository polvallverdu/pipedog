// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/services/moonshine/stt.py

/**
 * Moonshine speech-to-text service with locally-downloaded ONNX models.
 *
 * [Moonshine](https://github.com/moonshine-ai/moonshine) is a small, fast ASR
 * family that runs on the CPU via ONNX Runtime -- no GPU and no API key. This
 * module transcribes audio segments with a locally-downloaded Moonshine model
 * (downloaded once on first use and cached).
 *
 * Porting notes:
 * - Upstream wraps the `moonshine_voice` Python package (a C++ core on ONNX
 *   Runtime). Here the same surface (`Transcriber`, `getModelForLanguage`,
 *   `modelArchToString`, `stringToModelArch`, `supportedLanguages`,
 *   `supportedLanguagesFriendly`) comes from `./moonshine_voice.ts`, which
 *   runs the same `.ort` model files through `@pipedog/onnx`.
 * - Model files are resolved in the constructor but downloaded and loaded in
 *   `start()` (or on the first transcription); see the DIVERGENCE notes.
 */

import { abortable, rethrowIfCancelled } from "@pipedog/asyncio";
import { type Frame, type StartFrame, TranscriptionFrame } from "@pipedog/core/frames/frames";
import { STTSettings, type STTSettingsOptions } from "@pipedog/core/services/settings";
import {
  SegmentedSTTService,
  type SegmentedSTTServiceOptions,
} from "@pipedog/core/services/stt_service";
import { isLanguage, Language, resolveLanguage } from "@pipedog/core/transcriptions/language";
import { logger } from "@pipedog/core/utils/logger";
import { timeNowIso8601 } from "@pipedog/core/utils/time";
import { installTracedStt } from "@pipedog/core/utils/tracing/service_decorators";
import { assertGiven, type NotGiven, requireGiven } from "@pipedog/core/utils/types";
import {
  getModelForLanguage,
  type ModelArch,
  modelArchToString,
  stringToModelArch,
  supportedLanguages,
  supportedLanguagesFriendly,
  Transcriber,
  type TranscriberOptions,
  type Transcript,
} from "./moonshine_voice.ts";

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Moonshine expects 16 kHz mono PCM audio. */
export const MOONSHINE_SAMPLE_RATE = 16000;

/**
 * Convert a pipecat Language to a Moonshine language code.
 *
 * Moonshine publishes one model per language, keyed by base ISO code, so
 * regional variants (`Language.ES_MX`) resolve to their base code (`"es"`).
 *
 * @param language The Language value to convert.
 * @returns The Moonshine language code.
 */
export function languageToMoonshineLanguage(language: Language): string {
  const LANGUAGE_MAP: Partial<Record<Language, string>> = {
    [Language.AR]: "ar",
    [Language.DE]: "de",
    [Language.EN]: "en",
    [Language.ES]: "es",
    [Language.FIL]: "tl", // Filipino maps to Tagalog
    [Language.FIL_PH]: "tl",
    [Language.JA]: "ja",
    [Language.KO]: "ko",
    [Language.TL]: "tl",
    [Language.UK]: "uk",
    [Language.VI]: "vi",
    [Language.ZH]: "zh",
  };
  return resolveLanguage(language, LANGUAGE_MAP, true);
}

/** Map a Moonshine language code back to a pipecat `Language` when possible. */
export function moonshineLanguageToFrameLanguage(language: string | null): Language | null {
  if (language === null || language === undefined) return null;
  return isLanguage(language) ? language : null;
}

/**
 * Well-known Moonshine model architectures.
 *
 * Pass a member (or the equivalent string) as `MoonshineSTTService.Settings`'s
 * `model`. The larger models (`SMALL_STREAMING`, `MEDIUM_STREAMING`) ship
 * only in streaming form, but transcribe a whole segment in batch just the same.
 *
 * Which architectures exist depends on the language: English publishes the
 * widest range and is the only language with `MEDIUM_STREAMING`, while most
 * others ship one or two models. An architecture unavailable for the configured
 * language falls back to the best one published for it.
 *
 * - `TINY`: smallest and fastest, lowest accuracy.
 * - `BASE`: good size/accuracy balance.
 * - `TINY_STREAMING`: streaming-capable `tiny`.
 * - `BASE_STREAMING`: streaming-capable `base`.
 * - `SMALL_STREAMING`: larger and more accurate than `base` (the default).
 * - `MEDIUM_STREAMING`: largest, most accurate.
 */
export const Model = {
  TINY: "tiny",
  BASE: "base",
  TINY_STREAMING: "tiny-streaming",
  BASE_STREAMING: "base-streaming",
  SMALL_STREAMING: "small-streaming",
  MEDIUM_STREAMING: "medium-streaming",
} as const;
export type Model = (typeof Model)[keyof typeof Model];

export interface MoonshineSTTSettingsOptions extends STTSettingsOptions {
  /**
   * Moonshine model architecture, as a `Model` or the equivalent string (e.g.
   * `Model.SMALL_STREAMING` or `"small-streaming"`).
   */
  model?: Model | string | null | NotGiven;
}

/**
 * Settings for `MoonshineSTTService`.
 *
 * - `model`: Moonshine model architecture, as a `Model` or the equivalent
 *   string (e.g. `Model.SMALL_STREAMING` or `"small-streaming"`). Defaults to
 *   `Model.SMALL_STREAMING`.
 * - `language`: language for transcription. Moonshine publishes models for
 *   Arabic, Chinese, English, German, Japanese, Korean, Spanish, Tagalog,
 *   Ukrainian, and Vietnamese; regional variants resolve to their base code.
 */
export class MoonshineSTTSettings extends STTSettings {
  constructor(options: MoonshineSTTSettingsOptions = {}) {
    super(options);
    this._assignOptions(options);
  }
}

/** The part of `Transcriber` the service uses (so tests can pass a fake). */
export interface MoonshineTranscriber {
  transcribeWithoutStreaming(
    audioData: Float32Array,
    sampleRate: number,
  ): Transcript | Promise<Transcript>;
  load?(): Promise<void>;
}

/**
 * Options for `MoonshineSTTService`.
 *
 * - `settings`: runtime-updatable settings (`model`, `language`).
 * - `transcriberOptions` (pipedog only): `Transcriber` options, e.g. the ONNX
 *   `backend`, `fetch` for downloads, or the VAD and decoding options.
 * - `cacheRoot` (pipedog only): where models are downloaded (default
 *   `~/.cache/pipedog/moonshine`, see `ModelCacheOptions`).
 *
 * Other options are passed to `SegmentedSTTService`.
 */
export interface MoonshineSTTServiceOptions extends SegmentedSTTServiceOptions {
  /** Runtime-updatable settings (`model`, `language`). */
  settings?: MoonshineSTTSettings | null;
  /** `Transcriber` options (pipedog only). */
  transcriberOptions?: TranscriberOptions;
  /** Where models are downloaded (pipedog only). */
  cacheRoot?: string;
}

/**
 * Transcribe audio with a locally-downloaded Moonshine ONNX model.
 *
 * Runs on the CPU via ONNX Runtime, so it needs no GPU and no API key. The model
 * downloads once on first use and is cached. Each VAD-segmented utterance is
 * transcribed in a single batch call (`transcribeWithoutStreaming`); any
 * model works, including the streaming-capable ones. Audio is expected as 16-bit
 * mono PCM at 16 kHz.
 *
 * Models are language-specific, so a language change reloads the model. They are
 * MIT-licensed in every language and size, except the legacy non-streaming models
 * for languages other than English (`TINY` and `BASE`), which are under the
 * non-commercial Moonshine Community License (https://www.moonshine.ai/license);
 * Moonshine's `LICENSE` enumerates them.
 */
export class MoonshineSTTService extends SegmentedSTTService {
  static Settings: typeof MoonshineSTTSettings = MoonshineSTTSettings;
  declare protected _settings: MoonshineSTTSettings;

  protected _transcriberOptions: TranscriberOptions;
  protected _cacheRoot: string | undefined;
  protected _transcriber: MoonshineTranscriber;

  /** Receive segments as raw 16-bit PCM, which the model reads directly. */
  override get wantsWavSegments(): boolean {
    return false;
  }

  /**
   * Initialize the Moonshine STT service.
   *
   * @param options.settings Runtime-updatable settings (`model`, `language`).
   * @param options.transcriberOptions `Transcriber` options (pipedog only).
   * @param options.cacheRoot Where models are downloaded (pipedog only).
   *   Other options are passed to `SegmentedSTTService`.
   * @throws Error If no model or language is set, the model names no
   *   architecture, or Moonshine publishes no model for the language
   *   (upstream: ValueError).
   */
  constructor(options: MoonshineSTTServiceOptions = {}) {
    const Settings = (new.target as typeof MoonshineSTTService).Settings;
    const defaultSettings = new Settings({
      model: Model.SMALL_STREAMING,
      language: Language.EN,
    });
    if (options.settings !== undefined && options.settings !== null) {
      defaultSettings.applyUpdate(options.settings);
    }

    super({ ...options, sampleRate: MOONSHINE_SAMPLE_RATE, settings: defaultSettings });

    this._transcriberOptions = options.transcriberOptions ?? {};
    this._cacheRoot = options.cacheRoot;
    // DIVERGENCE: upstream downloads and loads the model here, synchronously.
    // `_load()` only resolves the model; its files are downloaded and loaded in
    // `start()` (or on the first transcription).
    this._transcriber = this._load();
  }

  /**
   * Start the service, loading the model (downloading it on first use).
   *
   * @param frame The start frame.
   */
  override async start(frame: StartFrame): Promise<void> {
    await super.start(frame);
    // DIVERGENCE: upstream loads the model in the constructor. A failure here
    // is logged and the load is retried by the first transcription.
    if (this._transcriber.load) {
      try {
        await abortable(this._transcriber.load());
        logger.debug("Loaded Moonshine model");
      } catch (e) {
        rethrowIfCancelled(e);
        logger.error(`${this} error loading Moonshine model: ${errorMessage(e)}`);
      }
    }
  }

  /**
   * Indicate whether this service can generate metrics.
   *
   * @returns True, as this service supports metric generation.
   */
  override canGenerateMetrics(): boolean {
    return true;
  }

  /** Convert a pipecat language into a Moonshine language code. */
  override languageToServiceLanguage(language: Language): string | null {
    return languageToMoonshineLanguage(language);
  }

  /**
   * Apply a settings delta, reloading the model when it changes.
   *
   * Moonshine models are per-language and per-architecture, so a new
   * `language` or `model` only takes effect once the model is reloaded.
   */
  protected override async _updateSettings(delta: STTSettings): Promise<Record<string, unknown>> {
    const changed = await super._updateSettings(delta);

    if ("language" in changed || "model" in changed) {
      try {
        const transcriber = this._load();
        // Upstream's `_load` downloads and loads the model before it is
        // swapped in; do the same, so a failed download keeps the old one.
        if (transcriber.load) await abortable(transcriber.load());
        this._transcriber = transcriber;
      } catch (e) {
        rethrowIfCancelled(e);
        // Keep transcribing with the model already loaded.
        logger.error(`${this} error loading Moonshine model: ${errorMessage(e)}`);
        await this.pushError(`Moonshine model load error: ${errorMessage(e)}`, { exception: e });
      }
    }

    return changed;
  }

  /**
   * Resolve the Moonshine model for the current settings.
   *
   * Note: the first run downloads the model from the Moonshine model hub; later
   * runs load it from the local cache.
   *
   * @throws Error If no language is set, or Moonshine publishes no model for it
   *   (upstream: ValueError).
   */
  protected _load(): MoonshineTranscriber {
    logger.debug("Loading Moonshine model...");
    const model = requireGiven(this._settings.model, "Moonshine model");
    const modelStr = String(model);

    const language = assertGiven(this._settings.language);
    if (language === null) {
      throw new Error("Moonshine requires a language; its models are language-specific");
    }
    const langCode = String(language);
    if (!supportedLanguages().includes(langCode)) {
      throw new Error(
        `Moonshine does not support language '${langCode}'. ` +
          `Supported languages: ${supportedLanguagesFriendly()}`,
      );
    }

    const wantedArch = stringToModelArch(modelStr);
    let modelPath: string;
    let modelArch: ModelArch;
    try {
      [modelPath, modelArch] = getModelForLanguage(langCode, wantedArch, {
        cacheRoot: this._cacheRoot,
      });
    } catch (e) {
      rethrowIfCancelled(e);
      // The architecture isn't published for this language; take its best model.
      [modelPath, modelArch] = getModelForLanguage(langCode, null, { cacheRoot: this._cacheRoot });
      const archStr = modelArchToString(modelArch);
      logger.warning(
        `Moonshine model '${modelStr}' is unavailable for '${langCode}'; using '${archStr}' instead`,
      );
      this._settings.model = archStr;
    }

    const transcriber = new Transcriber(modelPath, modelArch, this._transcriberOptions);
    logger.debug("Loaded Moonshine model");
    return transcriber;
  }

  /** Handle a transcription result with tracing. */
  protected async _handleTranscription(
    _transcript: string,
    _isFinal: boolean,
    _language: Language | null = null,
  ): Promise<void> {}

  static {
    installTracedStt(MoonshineSTTService.prototype, "_handleTranscription");
  }

  /**
   * Transcribe audio data using Moonshine.
   *
   * @param audio Raw 16-bit signed PCM mono audio at 16 kHz.
   * @yields A `TranscriptionFrame` with the transcribed text.
   */
  override async *runStt(audio: Uint8Array): AsyncGenerator<Frame, void, unknown> {
    await this.startProcessingMetrics();

    // Divide by 32768 because we have signed 16-bit data; Moonshine wants floats
    // in [-1, 1].
    const bytes = audio.byteOffset % 2 === 0 ? audio : audio.slice();
    const pcm = new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.length / 2));
    const audioFloat = new Float32Array(pcm.length);
    for (let i = 0; i < pcm.length; i++) audioFloat[i] = (pcm[i] as number) / 32768.0;

    // Upstream runs the blocking call in a thread (asyncio.to_thread); here
    // inference is asynchronous already.
    const transcriber = this._transcriber;
    const transcript = await abortable(
      Promise.resolve().then(() =>
        transcriber.transcribeWithoutStreaming(audioFloat, MOONSHINE_SAMPLE_RATE),
      ),
    );
    const text = transcript.lines
      .map((line) => line.text)
      .join(" ")
      .trim();

    await this.stopProcessingMetrics();

    const langCode = assertGiven(this._settings.language);
    const language = moonshineLanguageToFrameLanguage(langCode ? String(langCode) : null);
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
