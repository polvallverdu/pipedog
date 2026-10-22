// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/services/funasr/stt.py

/**
 * FunASR speech-to-text service with locally-downloaded models.
 *
 * This module implements speech-to-text using locally-run FunASR models such as
 * SenseVoice. SenseVoice is a multilingual model (Chinese, Cantonese, English,
 * Japanese, Korean and more) with leading Chinese accuracy and non-autoregressive
 * (fast) inference, making it a strong fully-local STT option for voice agents.
 *
 * Porting notes:
 * - Upstream wraps the `funasr` Python package (PyTorch). Here the same
 *   surface (`AutoModel`, `generate`, `richTranscriptionPostprocess`) comes from
 *   `./funasr.ts`, which runs an ONNX export of the same SenseVoiceSmall weights
 *   through `@pipedog/onnx`.
 * - The engine's options are camelCase (`disableUpdate`, `useItn`), not the
 *   Python library's keyword names.
 */

import { abortable, rethrowIfCancelled } from "@pipedog/asyncio";
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
import { isLanguage, Language } from "@pipedog/core/transcriptions/language";
import { logger } from "@pipedog/core/utils/logger";
import { timeNowIso8601 } from "@pipedog/core/utils/time";
import { installTracedStt } from "@pipedog/core/utils/tracing/service_decorators";
import { assertGiven, NOT_GIVEN, type NotGiven } from "@pipedog/core/utils/types";
import { AutoModel, type AutoModelOptions, richTranscriptionPostprocess } from "./funasr.ts";

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// Language codes natively supported by SenseVoice; anything else falls back to
// automatic language detection.
const FUNASR_LANGUAGES: ReadonlySet<string> = new Set(["zh", "en", "ja", "ko", "yue", "nospeech"]);

/**
 * Map a language value to a SenseVoice language code.
 *
 * @param language A pipecat language, raw language code, or `null` for
 *   auto-detection.
 * @returns A SenseVoice language code (e.g. `"zh"`), or `"auto"`.
 */
export function languageToFunasrLanguage(language: Language | string | null | undefined): string {
  if (language === null || language === undefined) {
    return "auto";
  }
  const code = (String(language).split("-")[0] as string).toLowerCase();
  return FUNASR_LANGUAGES.has(code) ? code : "auto";
}

/** Map a FunASR language code back to a pipecat `Language` when possible. */
export function funasrLanguageToFrameLanguage(
  language: string | null | undefined,
): Language | null {
  if (language === null || language === undefined || language === "auto") {
    return null;
  }
  return isLanguage(language) ? language : null;
}

/**
 * Settings for `FunASRSTTService`.
 *
 * - `useItn`: apply inverse text normalization (e.g. "nine" -> "9").
 */
export interface FunASRSTTSettingsOptions extends STTSettingsOptions {
  /** Apply inverse text normalization (e.g. "nine" -> "9"). */
  useItn?: boolean | null | NotGiven;
}

/**
 * Settings for `FunASRSTTService`.
 *
 * `model` and `language` are inherited from `STTSettings`.
 *
 * - `useItn`: apply inverse text normalization (e.g. "nine" -> "9").
 */
export class FunASRSTTSettings extends STTSettings {
  useItn: boolean | null | NotGiven = NOT_GIVEN;

  constructor(options: FunASRSTTSettingsOptions = {}) {
    super(options);
    this._assignOptions(options);
  }
}

/** The part of `AutoModel` the service uses (so tests can pass a fake). */
export type FunASRModel = Pick<AutoModel, "generate"> & { load?: () => Promise<void> };

/**
 * Options for `FunASRSTTService`.
 *
 * - `device`: inference device, `"cpu"` or `"cuda"`.
 * - `settings`: runtime-updatable settings (`model`, `language`, `useItn`).
 * - `modelOptions`: extra `AutoModel` options (pipedog only): `cacheDir`,
 *   `quantized`, explicit `modelFile`/`tokens`, `backend`, `fetch`.
 *
 * Other options are passed to `SegmentedSTTService`.
 */
export interface FunASRSTTServiceOptions extends SegmentedSTTServiceOptions {
  /** Inference device, `"cpu"` or `"cuda"`. */
  device?: string;
  /** Runtime-updatable settings (`model`, `language`, `useItn`). */
  settings?: FunASRSTTSettings | null;
  /** Extra `AutoModel` options (pipedog only). */
  modelOptions?: Partial<Omit<AutoModelOptions, "model" | "device" | "disableUpdate">>;
}

/**
 * Speech-to-text using a locally-downloaded FunASR model (e.g. SenseVoice).
 *
 * Transcribes VAD-segmented speech with a local FunASR model. SenseVoice is
 * multilingual (Chinese, Cantonese, English, Japanese, Korean, ...) with strong
 * Chinese accuracy and fast non-autoregressive inference.
 *
 * Audio is expected as 16 kHz, 16-bit signed PCM (the pipecat STT default).
 */
export class FunASRSTTService extends SegmentedSTTService {
  static Settings: typeof FunASRSTTSettings = FunASRSTTSettings;
  declare protected _settings: FunASRSTTSettings;

  protected _device: string;
  protected _model: FunASRModel | null;

  /**
   * Initialize the FunASR STT service.
   *
   * @param options.device Inference device, `"cpu"` or `"cuda"`.
   * @param options.settings Runtime-updatable settings (`model`, `language`, `useItn`).
   * @param options.modelOptions Extra `AutoModel` options (pipedog only).
   *   Other options are passed to `SegmentedSTTService`.
   * @throws Error If the model setting is null (upstream: ValueError).
   */
  constructor(options: FunASRSTTServiceOptions = {}) {
    const Settings = (new.target as typeof FunASRSTTService).Settings;
    const defaultSettings = new Settings({
      model: "iic/SenseVoiceSmall",
      language: Language.EN,
      useItn: true,
    });
    if (options.settings !== undefined && options.settings !== null) {
      defaultSettings.applyUpdate(options.settings);
    }

    super({ ...options, settings: defaultSettings });
    const device = options.device ?? "cpu";
    this._device = device;

    const model = assertGiven(this._settings.model);
    if (model === null) {
      throw new Error("FunASR model must be specified");
    }

    // DIVERGENCE: upstream loads the model here, synchronously. `AutoModel`
    // only records its options; the files are downloaded and loaded in
    // `start()` (or on the first transcription).
    // DIVERGENCE: onnxruntime runs on the CPU; `device: "cuda"` is accepted
    // and passed through but does not select a GPU.
    logger.debug(`Loading FunASR model ${model}...`);
    this._model = new AutoModel({
      model,
      device,
      disableUpdate: true,
      ...options.modelOptions,
    });
  }

  /**
   * Start the service, loading the model (downloading it on first use).
   *
   * @param frame The start frame.
   */
  override async start(frame: StartFrame): Promise<void> {
    await super.start(frame);
    // DIVERGENCE: upstream loads the model in the constructor.
    if (this._model?.load) {
      try {
        await abortable(this._model.load());
        logger.debug("Loaded FunASR model");
      } catch (e) {
        rethrowIfCancelled(e);
        logger.error(`${this} error loading FunASR model: ${errorMessage(e)}`);
      }
    }
  }

  /** Convert a pipecat language into a FunASR language code. */
  override languageToServiceLanguage(language: Language): string | null {
    return languageToFunasrLanguage(language);
  }

  /** Indicate that this service can generate processing metrics. */
  override canGenerateMetrics(): boolean {
    return true;
  }

  /** Handle a transcription result with tracing. */
  protected async _handleTranscription(
    _transcript: string,
    _isFinal: boolean,
    _language: Language | null = null,
  ): Promise<void> {}

  static {
    installTracedStt(FunASRSTTService.prototype, "_handleTranscription");
  }

  /**
   * Transcribe an audio segment with FunASR.
   *
   * @param audio Raw audio bytes in 16-bit signed PCM format (16 kHz mono).
   * @yields A `TranscriptionFrame` with the recognized text, or an
   *   `ErrorFrame` if transcription fails.
   */
  override async *runStt(audio: Uint8Array): AsyncGenerator<Frame, void, unknown> {
    const model = this._model;
    if (!model) {
      yield new ErrorFrame({ error: "FunASR model not available" });
      return;
    }

    await this.startProcessingMetrics();

    // 16-bit signed PCM -> float32 in [-1, 1].
    const bytes = audio.byteOffset % 2 === 0 ? audio : audio.slice();
    const pcm = new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.length / 2));
    const audioFloat = new Float32Array(pcm.length);
    for (let i = 0; i < pcm.length; i++) audioFloat[i] = pcm[i]! / 32768.0;
    const language = languageToFunasrLanguage(assertGiven(this._settings.language));
    const frameLanguage = funasrLanguageToFrameLanguage(language);
    const useItn = assertGiven(this._settings.useItn);

    let text: string;
    try {
      // Upstream runs the blocking call in a thread (asyncio.to_thread); here
      // inference is asynchronous already.
      const result = await abortable(
        Promise.resolve().then(() =>
          model.generate({ input: audioFloat, cache: {}, language, useItn: useItn ?? false }),
        ),
      );
      text = richTranscriptionPostprocess((result[0] as { text: string }).text).trim();
    } catch (e) {
      rethrowIfCancelled(e);
      logger.error(`${this} error running FunASR: ${errorMessage(e)}`);
      await this.stopProcessingMetrics();
      yield new ErrorFrame({ error: `FunASR transcription error: ${errorMessage(e)}` });
      return;
    }

    await this.stopProcessingMetrics();

    if (text) {
      logger.debug(`Transcription: [${text}]`);
      await this._handleTranscription(text, true, frameLanguage);
      yield new TranscriptionFrame({
        text,
        userId: this._userId,
        timestamp: timeNowIso8601(),
        language: frameLanguage,
      });
    }
  }
}
