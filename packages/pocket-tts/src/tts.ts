// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/services/pocket_tts/tts.py

/**
 * Pocket TTS service implementation using kyutai-labs' pocket-tts.
 *
 * Porting notes:
 * - pocket-tts (PyTorch) is replaced by `./pocket_tts.ts`, which runs the
 *   same model on ONNX Runtime and exposes the same `TTSModel` surface
 *   (`loadModel`, `sampleRate`, `getStateForAudioPrompt`,
 *   `generateAudioStream`). Chunks are `Float32Array`s instead of torch tensors.
 * - Loading is asynchronous in JS, so the model and the voice state are
 *   loaded in `start()` (or on first use), not in the constructor; the
 *   constructor still validates the language and voice synchronously.
 * - `asyncio.to_thread` (blocking torch calls) becomes awaiting the engine,
 *   whose ONNX runs are asynchronous.
 */

import { rethrowIfCancelled } from "@pipedog/asyncio";
import { ErrorFrame, type Frame, type StartFrame } from "@pipedog/core/frames/frames";
import { TTSSettings, type TTSSettingsOptions } from "@pipedog/core/services/settings";
import { TTSService, type TTSServiceOptions } from "@pipedog/core/services/tts_service";
import { Language, resolveLanguage } from "@pipedog/core/transcriptions/language";
import { logger } from "@pipedog/core/utils/logger";
import { installTracedTts } from "@pipedog/core/utils/tracing/service_decorators";
import { requireGiven } from "@pipedog/core/utils/types";
import { type LoadModelOptions, type ModelState, TTSModel } from "./pocket_tts.ts";

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Convert a Language enum to a pocket-tts model language name.
 *
 * @param language The Language enum value to convert.
 * @returns The corresponding pocket-tts model language name.
 */
export function languageToPocketTtsLanguage(language: Language): string {
  // pocket-tts ships a distilled 6-layer model per language plus an
  // undistilled 24-layer variant that is higher quality but too slow to
  // synthesize in real time on a typical CPU. French has no distilled model,
  // so its 24-layer release is the only one available.
  const LANGUAGE_MAP: Partial<Record<Language, string>> = {
    [Language.DE]: "german",
    [Language.EN]: "english",
    [Language.ES]: "spanish",
    [Language.FR]: "french_24l",
    [Language.IT]: "italian",
    [Language.PT]: "portuguese",
  };

  let result = resolveLanguage(language, LANGUAGE_MAP, true);
  if (!Object.values(LANGUAGE_MAP).includes(result)) {
    // The fallback for unmapped regional variants is a bare base code
    // (e.g. "fr" for FR_CA), which is not a valid model name; map it back
    // onto a model name when one exists for the base language.
    const baseMap: Record<string, string> = {};
    for (const [k, v] of Object.entries(LANGUAGE_MAP)) baseMap[String(k)] = v!;
    result = baseMap[result] ?? result;
  }
  return result;
}

/** Settings for PocketTTSService. */
export class PocketTTSSettings extends TTSSettings {
  constructor(options: TTSSettingsOptions = {}) {
    super(options);
    this._assignOptions(options);
  }
}

/** The part of `TTSModel` the service uses (so tests and users can plug another engine). */
export interface PocketTTSModel {
  readonly sampleRate: number;
  getStateForAudioPrompt(voice: string): Promise<ModelState>;
  generateAudioStream(
    state: ModelState,
    text: string,
    options?: { copyState?: boolean },
  ): AsyncIterable<Float32Array>;
}

export interface PocketTTSServiceOptions extends TTSServiceOptions {
  /** Sampling temperature for audio generation. Defaults to the pocket-tts model default. */
  temp?: number | null;
  /**
   * Quantize model weights for faster CPU inference (upstream: requires the
   * `torchao` package; here: the int8 ONNX graph of the flow LM transformer).
   */
  quantize?: boolean;
  /** Runtime-updatable settings. Defaults to the `"alba"` voice and English. */
  settings?: PocketTTSSettings | null;
  /**
   * Engine options passed to `TTSModel.loadModel()`: ONNX backend, model
   * directory, cache directory, `fetch`, voice-cloning encoder, ...
   *
   * DIVERGENCE: pipedog-specific; pocket-tts downloads to its own cache.
   */
  modelOptions?: Omit<LoadModelOptions, "language" | "quantize" | "temp"> | null;
}

/**
 * Pocket TTS service implementation.
 *
 * Provides local, CPU-only text-to-speech synthesis using kyutai-labs'
 * pocket-tts streaming model. Model weights and voice prompts are downloaded
 * from Hugging Face on first use, which may take a while.
 *
 * The voice may be a predefined voice name (e.g. `"alba"`), a local `.wav`
 * file to clone, an exported `.safetensors` voice state, or an `hf://` path.
 * The voice can be changed at runtime; the language cannot, since model
 * weights are loaded per language.
 */
export class PocketTTSService extends TTSService {
  static Settings: typeof PocketTTSSettings = PocketTTSSettings;
  declare protected _settings: PocketTTSSettings;

  static {
    installTracedTts(PocketTTSService.prototype, "runTts");
  }

  protected _loadOptions: LoadModelOptions;
  protected _model: PocketTTSModel | null = null;
  #modelLoading: Promise<PocketTTSModel> | null = null;
  /**
   * Voice state derived from the voice prompt, cached across utterances.
   * generateAudioStream() is called with copyState=true so this cache is
   * never mutated by generation; null forces re-derivation.
   */
  protected _voiceState: ModelState | null = null;

  /**
   * Initialize the Pocket TTS service.
   *
   * @param options.temp Sampling temperature for audio generation. Defaults to
   *   the pocket-tts model default.
   * @param options.quantize Quantize model weights for faster CPU inference.
   * @param options.settings Runtime-updatable settings. Defaults to the
   *   `"alba"` voice and English.
   * @param options.modelOptions Engine options (pipedog-specific).
   *   Other options are passed to the parent `TTSService`.
   */
  constructor(options: PocketTTSServiceOptions = {}) {
    // Initialize default_settings with hardcoded defaults
    const defaultSettings = new (new.target as typeof PocketTTSService).Settings({
      model: null,
      voice: "alba",
      language: Language.EN,
    });

    // Apply settings delta
    if (options.settings !== undefined && options.settings !== null) {
      defaultSettings.applyUpdate(options.settings);
    }

    super({
      ...options,
      pushStartFrame: true,
      pushStopFrames: true,
      settings: defaultSettings,
    });

    // The base constructor has already converted a Language enum to the
    // pocket-tts language name via languageToServiceLanguage().
    const language = requireGiven(this._settings.language, "Pocket TTS language");
    requireGiven(this._settings.voice, "Pocket TTS voice");

    const loadOptions: LoadModelOptions = {
      ...(options.modelOptions ?? {}),
      language: String(language),
      quantize: options.quantize ?? false,
    };
    if (options.temp !== undefined && options.temp !== null) {
      loadOptions.temp = options.temp;
    }
    this._loadOptions = loadOptions;
    // DIVERGENCE: upstream loads the model and the voice state here, blocking;
    // loading is asynchronous in JS, so it happens in start() (or on first use).
  }

  /** Indicate that this service supports TTFB and usage metrics. */
  override canGenerateMetrics(): boolean {
    return true;
  }

  /**
   * Convert a Language enum to a pocket-tts model language name.
   *
   * @param language The language to convert.
   * @returns The pocket-tts model language name.
   */
  override languageToServiceLanguage(language: Language): string | null {
    return languageToPocketTtsLanguage(language);
  }

  /**
   * Start the service and load the model and the voice state.
   *
   * @param frame The start frame.
   */
  override async start(frame: StartFrame): Promise<void> {
    await super.start(frame);
    try {
      await this._loadModel();
      await this._getVoiceState();
    } catch (e) {
      rethrowIfCancelled(e);
      // Retried on the next utterance (runTts then reports the error).
      logger.error(`${this}: failed to load Pocket TTS: ${errorMessage(e)}`);
      await this.pushError(`Failed to load Pocket TTS: ${errorMessage(e)}`, { exception: e });
    }
  }

  /** Load the model once (a single in-flight load; a failed load is retried). */
  protected _loadModel(): Promise<PocketTTSModel> {
    if (this._model) return Promise.resolve(this._model);
    if (!this.#modelLoading) {
      const language = this._loadOptions.language;
      logger.debug(`Loading Pocket TTS '${language}' model`);
      const loading = (async () => {
        const model: PocketTTSModel = await TTSModel.loadModel(this._loadOptions);
        logger.debug(`Loaded Pocket TTS '${language}' model`);
        this._model = model;
        return model;
      })();
      this.#modelLoading = loading;
      loading.catch(() => {
        if (this.#modelLoading === loading) this.#modelLoading = null;
      });
    }
    return this.#modelLoading;
  }

  /**
   * Apply a settings delta.
   *
   * Voice changes take effect on the next utterance (the voice state is
   * re-derived lazily). Language and model changes are stored but not
   * applied, since they would require reloading model weights.
   */
  protected override async _updateSettings(delta: TTSSettings): Promise<Record<string, unknown>> {
    const changed = await super._updateSettings(delta);
    if (Object.keys(changed).length === 0) {
      return changed;
    }
    if ("voice" in changed) {
      this._voiceState = null;
    }
    const unhandled = Object.fromEntries(Object.entries(changed).filter(([k]) => k !== "voice"));
    if (Object.keys(unhandled).length > 0) {
      this._warnUnhandledUpdatedSettings(unhandled);
    }
    return changed;
  }

  /** Return the cached voice state, deriving it if invalidated. */
  protected async _getVoiceState(): Promise<ModelState> {
    if (this._voiceState === null) {
      const model = await this._loadModel();
      const voice = requireGiven(this._settings.voice, "Pocket TTS voice");
      logger.debug(`${this}: deriving voice state for [${voice}]`);
      this._voiceState = await model.getStateForAudioPrompt(voice);
    }
    return this._voiceState;
  }

  /**
   * Generate speech from text using pocket-tts.
   *
   * @param text The text to convert to speech.
   * @param contextId Unique identifier for this TTS context.
   * @yields Audio frames containing the synthesized speech.
   */
  override async *runTts(text: string, contextId: string): AsyncGenerator<Frame | null, void> {
    async function* audioIterator(
      model: PocketTTSModel,
      voiceState: ModelState,
    ): AsyncGenerator<Uint8Array, void, undefined> {
      // copyState=true (passed explicitly, matching the library default)
      // keeps the cached voice state unmodified across generations.
      for await (const chunk of model.generateAudioStream(voiceState, text, { copyState: true })) {
        // chunk is a 1-D float32 array in [-1, 1] at model.sampleRate.
        const pcm = new Int16Array(chunk.length);
        for (let i = 0; i < chunk.length; i++) {
          // torch's clamp(-1, 1) * 32767 then .to(int16), which truncates.
          pcm[i] = Math.trunc(Math.min(1, Math.max(-1, chunk[i]!)) * 32767);
        }
        yield new Uint8Array(pcm.buffer);
      }
    }

    try {
      await this.startTtsUsageMetrics(text);

      const model = await this._loadModel();
      const voiceState = await this._getVoiceState();

      for await (const frame of this._streamAudioFramesFromIterator(
        audioIterator(model, voiceState),
        { inSampleRate: model.sampleRate, contextId },
      )) {
        await this.stopTtfbMetrics();
        yield frame;
      }
    } catch (e) {
      rethrowIfCancelled(e);
      logger.error(`${this} exception: ${errorMessage(e)}`);
      yield new ErrorFrame({ error: `Unknown error occurred: ${errorMessage(e)}` });
    } finally {
      logger.debug(`${this}: Finished TTS [${text}]`);
      await this.stopTtfbMetrics();
    }
  }
}
