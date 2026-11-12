// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/evals/services.py

/**
 * Service constructors for the eval harness: a Pipecat service from a scenario's config mapping.
 *
 * The dispatchers pick a provider by its `service:` name, or call a
 * `factory`; the per-provider builders do the rest. The built-in names are
 * the local, keyless services: Ollama for the judge and the persona, Kokoro
 * for the user's voice, Moonshine and Whisper for the bot's audio. Any other
 * provider is a `factory`: a module and one of its exports, joined by a dot,
 * naming a function that takes the config mapping and returns the service,
 * so a scenario stays a description of the test while the provider, its
 * settings, and its key live in code:
 *
 * @example
 * // my_evals.ts
 * export function judge(config) {
 *   return new OpenAILLMService({ settings: new OpenAILLMService.Settings({ model: config.model }) });
 * }
 * export function voice(config) {
 *   return new CartesiaHttpTTSService({
 *     apiKey: process.env.CARTESIA_API_KEY!,
 *     settings: new CartesiaHttpTTSService.Settings({ voice: config.voice }),
 *   });
 * }
 *
 * // in the scenario
 * // judge:
 * //   eval: {factory: ./my_evals.ts.judge, model: gpt-4o-mini}
 * // user:
 * //   speech: {factory: ./my_evals.ts.voice, voice: 71a7ad14-091c-4e8e-a314-022ece01c121}
 *
 * What a factory must return: the judge's and the persona's LLM must be
 * OpenAI-compatible, a `BaseOpenAILLMService` subclass; the user's TTS must
 * be a local or HTTP service, since the cache around it drives `runTts`
 * directly and a WebSocket-streaming one yields nothing there; the bot's STT
 * can be any pipeline STT. Provider imports stay inside the functions, so
 * importing this module is cheap.
 *
 * DIVERGENCE: a `factory` is resolved with a dynamic `import()`, so every
 * builder here is async. The part before the last dot is a module specifier
 * (a package name, a `file:` URL, or a path, a relative one resolved against
 * the working directory, as Python's `sys.path` does), not a dotted Python
 * module name; the part after it is the export. A function may also be given
 * as `factory` directly, from code.
 *
 * Deprecated upstream and not ported: `service: cartesia` for the user's
 * voice, `service: openai` for an LLM, and the `cartesia_service` and
 * `openai_service` builders. Use a `factory` for these.
 */

import { BaseClassifier } from "@pipedog/core/classifiers/base_classifier";
import { LLMClassifier } from "@pipedog/core/classifiers/llm/classifier";
import { LLMService } from "@pipedog/core/services/llm_service";
import type { STTService } from "@pipedog/core/services/stt_service";
import type { TTSService } from "@pipedog/core/services/tts_service";
import { isLanguage, type Language } from "@pipedog/core/transcriptions/language";
import { NOT_GIVEN, type NotGiven } from "@pipedog/core/utils/types";

import { pyRepr, pyStr } from "./_pyutil.ts";
import type { CachingTTSService, VoiceConfig } from "./tts.ts";

/** A service config mapping, as a scenario file gives it. */
export type ServiceConfig = Record<string, unknown>;

/** A factory: takes the config mapping and returns what the block names. */
export type ServiceFactory = (config: ServiceConfig) => unknown;

/** Python's `str.rpartition(".")`: the text before the last dot, and after it. */
function _rpartition(value: string): [string, string] {
  const i = value.lastIndexOf(".");
  return i === -1 ? ["", value] : [value.slice(0, i), value.slice(i + 1)];
}

/**
 * The module a factory names, imported (Python's `importlib.import_module`).
 *
 * A relative path resolves against the working directory, and an absolute
 * one is imported as a file.
 */
async function _importModule(specifier: string): Promise<Record<string, unknown>> {
  const isWindowsPath = /^[A-Za-z]:[\\/]/.test(specifier);
  if (specifier.startsWith(".") || specifier.startsWith("/") || isWindowsPath) {
    const path = await import("node:path");
    const url = await import("node:url");
    const absolute = path.resolve(process.cwd(), specifier);
    return (await import(url.pathToFileURL(absolute).href)) as Record<string, unknown>;
  }
  return (await import(specifier)) as Record<string, unknown>;
}

/**
 * The function a `factory` names.
 *
 * @param custom The `factory` value: `"<module>.<export>"`, or a function.
 * @param where The config block's name, for the error.
 */
async function _factory(custom: unknown, where: string): Promise<ServiceFactory> {
  if (typeof custom === "function") {
    return custom as ServiceFactory;
  }
  const path = pyStr(custom);
  const [moduleName, attr] = _rpartition(path);
  if (!moduleName) {
    throw new Error(`${where}.factory must be a dotted path: ${pyRepr(custom)}`);
  }
  const module = await _importModule(moduleName);
  const factory = module[attr];
  if (typeof factory !== "function") {
    // Python's getattr() raising AttributeError, or calling a non-callable.
    throw new Error(`module ${pyRepr(moduleName)} has no function ${pyRepr(attr)}`);
  }
  return factory as ServiceFactory;
}

/**
 * A config's optional `language` as a `Language`; a code string is accepted too.
 *
 * @param cfg A `user.speech` or `judge.transcription` config mapping.
 * @returns The resolved `Language`, or `NOT_GIVEN` when `language` is absent,
 *   which leaves the service's own default in place.
 * @throws Error If `language` is set to a value that is not a recognized
 *   language code.
 */
export function _cfgLanguage(cfg: ServiceConfig): Language | NotGiven {
  let value = cfg.language;
  if (value === undefined || value === null) {
    return NOT_GIVEN;
  }
  if (typeof value === "string") {
    value = value.trim();
    if (!value) {
      return NOT_GIVEN;
    }
  }
  if (typeof value === "string" && isLanguage(value)) {
    return value;
  }
  throw new Error(
    `Unknown language ${pyRepr(value)} in eval speech/transcription config; ` +
      "expected a language code like 'zh' or a Language value.",
  );
}

/**
 * Build the STT that transcribes the bot's audio, from a `judge.transcription:` mapping.
 *
 * A `factory` builds it; otherwise the `service` name picks one, `moonshine`
 * by default. Any pipeline STT works; the pipeline sets its sample rate.
 *
 * @param config The `transcription` mapping, or `null` for the Moonshine default.
 * @returns A constructed `STTService` (model loaded), ready to add to the pipeline.
 */
export async function sttServiceFromConfig(config: ServiceConfig | null): Promise<STTService> {
  const cfg = config ?? {};

  const custom = cfg.factory;
  if (custom) {
    const factory = await _factory(custom, "transcription");
    return factory(cfg) as STTService;
  }

  const name = pyStr(cfg.service ?? "moonshine").toLowerCase();
  if (name === "whisper") {
    return await whisperService(cfg);
  }
  if (name === "moonshine") {
    return await moonshineService(cfg);
  }

  throw new Error(
    `Unknown STT service: ${pyRepr(name)}. Known: moonshine, whisper. ` +
      "For any other, set transcription.factory to a 'module.func' returning an STTService.",
  );
}

/** Options for `ttsServiceFromConfig`. */
export interface TTSServiceFromConfigOptions {
  /** Where to store cached audio (see `CachingTTSService`). */
  cacheDir?: string | null;
  /** When false, force fresh synthesis. */
  useCache?: boolean;
}

/**
 * Build the user-audio TTS, wrapped in a cache, from a `user_audio` mapping.
 *
 * A `factory` builds the inner service; otherwise the `service` name picks
 * one, `kokoro`. The wrapper synthesizes each user utterance once and reuses
 * it across runs. The pipeline sets the sample rate.
 *
 * @param voiceCfg `user_audio` mapping: `service` or `factory`, and `voice`,
 *   at minimum.
 * @returns A configured `CachingTTSService` (not yet started).
 */
export async function ttsServiceFromConfig(
  voiceCfg: VoiceConfig,
  options: TTSServiceFromConfigOptions = {},
): Promise<CachingTTSService> {
  // Lazy import to keep this module cheap and avoid importing the TTS stack
  // unless a scenario actually needs synthesized user audio.
  const { CachingTTSService, ttsCacheKey } = await import("./tts.ts");

  let inner: TTSService;
  const custom = voiceCfg.factory;
  if (custom) {
    const factory = await _factory(custom, "user_audio");
    inner = factory(voiceCfg) as TTSService;
  } else {
    const name = pyStr(voiceCfg.service ?? "").toLowerCase();
    const voice = pyStr(voiceCfg.voice ?? "");
    if (!name || !voice) {
      throw new Error("user_audio config requires at least 'service' and 'voice'");
    }
    if (name === "kokoro") {
      inner = await kokoroService(voiceCfg);
    } else {
      throw new Error(
        `Unknown TTS service: ${pyRepr(name)}. Known: kokoro. ` +
          "For any other, set user_audio.factory to a 'module.func' returning a TTSService.",
      );
    }
  }

  return new CachingTTSService(inner, {
    cacheKey: ttsCacheKey(voiceCfg),
    cacheDir: options.cacheDir ?? null,
    useCache: options.useCache ?? true,
  });
}

/**
 * Build a local Kokoro TTS service from the `user_audio` config.
 *
 * No API key and no per-run cost; the model is downloaded once and cached
 * under `~/.cache/pipedog/kokoro` (see `@pipedog/kokoro`).
 *
 * DIVERGENCE: async, since `@pipedog/kokoro` (an optional peer dependency) is
 * imported on demand.
 *
 * @param voiceCfg The `user.speech` config mapping:
 *   - `voice`: Kokoro voice id (e.g. `af_heart`).
 *   - `language`: Optional language code (e.g. `zh`) or `Language`. When
 *     omitted, Kokoro keeps its own default (English). Voices are
 *     language-specific, so a non-English language needs a matching voice;
 *     `af_heart` speaks US English whatever the language is set to.
 *   - `speed`: Optional speech rate multiplier (Kokoro accepts 0.5 to 2.0;
 *     1.0 is its default). Pauses scale with it too, so a faster rate also
 *     shortens the silences at commas.
 */
export async function kokoroService(voiceCfg: VoiceConfig): Promise<TTSService> {
  const { KokoroTTSService } = await import("@pipedog/kokoro/tts");

  const settings = new KokoroTTSService.Settings({
    voice: pyStr(voiceCfg.voice ?? ""),
    language: _cfgLanguage(voiceCfg),
  });
  if (voiceCfg.speed !== undefined && voiceCfg.speed !== null) {
    settings.speed = Number(voiceCfg.speed);
  }
  return new KokoroTTSService({ settings });
}

/**
 * Build a local Whisper STT service from the `bot_audio` config.
 *
 * It runs on the CPU by default, leaving the GPU to the judge and the audio
 * models; transcription is off the hot path, so the latency is fine.
 *
 * Whisper's non-speech filter is disabled: it only ever hears the bot's own
 * speech, and the default threshold drops correct transcriptions of TTS
 * speech run to run.
 *
 * DIVERGENCE: async, since `@pipedog/whisper/stt` is imported on demand. The
 * engine is pipedog's ONNX port of faster-whisper, so `device` only selects
 * the CPU and `compute_type` picks the ONNX weights (`int8` by default on CPU,
 * as upstream).
 *
 * @param config The `judge.transcription` config mapping:
 *   - `device`: `cpu` (default) or `cuda`.
 *   - `compute_type`: Whisper compute type (`int8` on CPU).
 *   - `model`: Optional Whisper model (left unset to use Whisper's own).
 *     Whisper's default is English-only, as is every `.en` model, so a
 *     non-English `language` needs a multilingual model here (e.g.
 *     `large-v3-turbo`).
 *   - `language`: Optional language code (e.g. `es`) or `Language`. When
 *     omitted, Whisper keeps its own default (English); it does not
 *     auto-detect, so a non-English bot needs this set.
 * @throws Error If `language` names a language the chosen model can't
 *   transcribe (raised by `WhisperSTTService`).
 */
export async function whisperService(config: ServiceConfig): Promise<STTService> {
  const { WhisperSTTService } = await import("@pipedog/whisper/stt");

  const device = pyStr(config.device ?? "cpu");
  // int8 keeps CPU transcription reasonably fast with negligible accuracy loss;
  // the default ("default") would pick float32 on CPU, which is much slower.
  const computeType = pyStr(config.compute_type ?? (device === "cpu" ? "int8" : "default"));
  // NOT_GIVEN (not null) leaves the model unset so Whisper uses its own default.
  return new WhisperSTTService({
    device,
    computeType,
    settings: new WhisperSTTService.Settings({
      noSpeechProb: 1.0,
      model: config.model === undefined ? NOT_GIVEN : (config.model as string),
      language: _cfgLanguage(config),
    }),
  });
}

/**
 * Build a local Moonshine STT service from the `bot_audio` config.
 *
 * Small and fast on the CPU, and steadier than Whisper on the short
 * bot-answer segments the harness transcribes.
 *
 * Prefer `whisperService` for a non-English bot: Moonshine's non-English
 * models transcribe synthesized speech unreliably, returning an empty
 * transcript or dropping the tail of an utterance, and an empty transcript is
 * indistinguishable from a bot that said nothing.
 *
 * DIVERGENCE: async, since `@pipedog/moonshine` is imported on demand.
 *
 * @param config The `judge.transcription` config mapping:
 *   - `model`: Optional architecture, as a `Model` value or the equivalent
 *     string (default `Model.SMALL_STREAMING`).
 *   - `language`: Optional language code (e.g. `es`) or `Language`. When
 *     omitted, Moonshine keeps its own default (English).
 */
export async function moonshineService(config: ServiceConfig): Promise<STTService> {
  const { Model, MoonshineSTTService } = await import("@pipedog/moonshine/stt");

  return new MoonshineSTTService({
    settings: new MoonshineSTTService.Settings({
      model: (config.model as string | undefined) || Model.SMALL_STREAMING,
      language: _cfgLanguage(config),
    }),
  });
}

export const DEFAULT_OLLAMA_JUDGE_MODEL = "gemma4:12b";

// The default judge is thinking-capable, and only its JSON verdict is ever read,
// so reasoning buys nothing while costing latency and eating into the token
// budget the verdict needs.
export const DEFAULT_OLLAMA_JUDGE_EXTRA: Readonly<Record<string, unknown>> = {
  reasoning_effort: "none",
};

/** Options for `classifierFromConfig` and `llmServiceFromConfig`. */
export interface FromConfigOptions {
  /** The config block's name in the file, for error messages. */
  where: string;
}

/**
 * Build the classifier a `judge.eval:` block names.
 *
 * A `factory` builds it, and may return a `BaseClassifier` or an LLM service,
 * which an `LLMClassifier` then asks. Otherwise the block names an LLM, as
 * `llmServiceFromConfig` reads it, and an `LLMClassifier` asks that.
 *
 * @param config Mapping with a `factory`, or the keys `llmServiceFromConfig`
 *   reads. `null` uses all defaults.
 * @param options.where The config block's name in the file, for error messages.
 * @returns The configured classifier.
 * @throws Error If `service` is unknown, `factory` is not a dotted path, or
 *   the factory returned neither a classifier nor an LLM service.
 */
export async function classifierFromConfig(
  config: ServiceConfig | null,
  options: FromConfigOptions,
): Promise<BaseClassifier> {
  const { where } = options;
  const cfg = config ?? {};
  const custom = cfg.factory;
  if (custom) {
    const built = (await _factory(custom, where))(cfg);
    if (built instanceof BaseClassifier) {
      return built;
    }
    if (built instanceof LLMService) {
      return new LLMClassifier({ llm: built });
    }
    const typeName =
      built === null || built === undefined
        ? "NoneType"
        : ((built as object).constructor?.name ?? typeof built);
    throw new Error(
      `${where}.factory ${pyRepr(pyStr(custom))} returned ${typeName}, ` +
        "not a BaseClassifier or an LLM service",
    );
  }
  return new LLMClassifier({ llm: await llmServiceFromConfig(cfg, { where }) });
}

/**
 * Build an LLM service from a `service:` block, the judge's or a persona's.
 *
 * A `factory` builds it; otherwise the `service` name picks a provider,
 * `ollama`, the default.
 *
 * @param config Mapping with keys `service` (default `"ollama"`), `model`,
 *   optional `endpoint`, and an optional `extra` mapping forwarded to the
 *   model as top-level request parameters. `null` uses all defaults.
 * @param options.where The config block's name in the file, for error
 *   messages (`"judge.eval"`, `"simulator"`).
 * @returns The configured LLM service.
 * @throws Error If `service` is unknown or `factory` is not a dotted path.
 */
export async function llmServiceFromConfig(
  config: ServiceConfig | null,
  options: FromConfigOptions,
): Promise<LLMService> {
  const { where } = options;
  const cfg = config ?? {};
  const custom = cfg.factory;
  if (custom) {
    const factory = await _factory(custom, where);
    return factory(cfg) as LLMService;
  }
  const serviceName = pyStr(cfg.service ?? "ollama").toLowerCase();
  if (serviceName === "ollama") {
    return await ollamaService(cfg);
  }
  throw new Error(
    `Unknown ${where} service: ${pyRepr(serviceName)}. Known: ollama. ` +
      `For any other, set ${where}.factory to a 'module.func' returning an LLM service.`,
  );
}

/**
 * Build a local Ollama LLM service from the `judge:` config.
 *
 * An `extra:` mapping goes to the model as request parameters, which is how
 * `reasoning_effort: none` reaches a thinking model. The default model comes
 * with the extras it needs; a named model gets only the extras asked for.
 */
export async function ollamaService(config: ServiceConfig): Promise<LLMService> {
  const { OLLamaLLMService } = await import("@pipedog/ollama/llm");

  const model = config.model;
  let extra = config.extra as Record<string, unknown> | null | undefined;
  if (extra === undefined || extra === null) {
    extra = model === undefined || model === null ? { ...DEFAULT_OLLAMA_JUDGE_EXTRA } : {};
  }

  const baseUrl = (config.endpoint as string | undefined) || "http://localhost:11434/v1";
  return new OLLamaLLMService({
    baseUrl,
    settings: new OLLamaLLMService.Settings({
      model: (model as string | undefined) || DEFAULT_OLLAMA_JUDGE_MODEL,
      extra,
    }),
  });
}
