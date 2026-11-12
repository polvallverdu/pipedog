// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/services/cartesia/tts.py

/**
 * Cartesia text-to-speech service implementations.
 *
 * Porting notes:
 * - `CartesiaTTSService` uses the global `WebSocket` through
 *   `WebsocketService._websocketConnect()`. The `X-API-Key` header is sent on
 *   the opening handshake, which the Bun, Node and Deno `WebSocket` support.
 * - `CartesiaHttpTTSService` posts with `fetch` (the global one by default,
 *   injectable with the `fetch` option) in place of an `aiohttp` session.
 * - Deprecated APIs are not ported: the `voice_id`, `model`, `params`
 *   (and the `InputParams` classes), `cartesia_version` and
 *   `aggregate_sentences` constructor parameters. The API version header is
 *   always the pinned `_CARTESIA_API_VERSION`.
 */

import { abortable, currentSignal, rethrowIfCancelled, type Task } from "@pipedog/asyncio";
import {
  ErrorFrame,
  type Frame,
  TTSAudioRawFrame,
  TTSStoppedFrame,
} from "@pipedog/core/frames/frames";
import type { FrameProcessorSetup } from "@pipedog/core/processors/frame_processor";
import { TTSSettings, type TTSSettingsOptions } from "@pipedog/core/services/settings";
import {
  type TextAggregationMode,
  TTSService,
  type TTSServiceOptions,
  WebsocketTTSService,
  type WebsocketTTSServiceOptions,
} from "@pipedog/core/services/tts_service";
import { State, type WebsocketClientConnection } from "@pipedog/core/services/websocket_service";
import { Language, resolveLanguage } from "@pipedog/core/transcriptions/language";
import { base64ToBytes } from "@pipedog/core/utils/base64";
import { logger } from "@pipedog/core/utils/logger";
import { pyJsonDumps, pyJsonLoads, pyNumberRepr } from "@pipedog/core/utils/py_json";
import { ipaPhones, normalizeIpa, stressBeforeVowels } from "@pipedog/core/utils/text/phonemes";
import { SkipTagsAggregator } from "@pipedog/core/utils/text/skip_tags_aggregator";
import { installTracedTts } from "@pipedog/core/utils/tracing/service_decorators";
import { assertGiven, NOT_GIVEN, type NotGiven } from "@pipedog/core/utils/types";
import { CartesiaEmotion, CartesiaExpressionAdapter } from "./cartesia_adapter.ts";

export { CartesiaEmotion };

// Upstream `dict[str, Any]`: Cartesia JSON payloads are genuinely dynamic.
type Dict = Record<string, any>;

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// The Cartesia API version these services are written against. The request
// payloads and message handling below are tied to it, so it is pinned here
// rather than configured.
const _CARTESIA_API_VERSION = "2026-03-01";

export interface GenerationConfigOptions {
  /** Volume multiplier for generated speech. Valid range: [0.5, 2.0]. Default is 1.0. */
  volume?: number | null;
  /** Speed multiplier for generated speech. Valid range: [0.6, 1.5]. Default is 1.0. */
  speed?: number | null;
  /**
   * Single emotion string to guide the emotional tone. Examples include
   * neutral, angry, excited, content, sad, scared. Over 60 emotions are
   * supported. For best results, use with recommended voices: Leo, Jace,
   * Kyle, Gavin, Maya, Tessa, Dana, and Marian.
   */
  emotion?: string | null;
}

/**
 * Configuration for Cartesia generation parameters.
 *
 * Cartesia interprets these parameters as guidance to ensure natural speech.
 * Test against your content for best results. Applicable to sonic-3 series
 * models.
 *
 * - `volume`: volume multiplier for generated speech. Valid range: [0.5,
 *   2.0]. Default is 1.0.
 * - `speed`: speed multiplier for generated speech. Valid range: [0.6, 1.5].
 *   Default is 1.0.
 * - `emotion`: single emotion string to guide the emotional tone. Examples
 *   include neutral, angry, excited, content, sad, scared. Over 60 emotions
 *   are supported. For best results, use with recommended voices: Leo, Jace,
 *   Kyle, Gavin, Maya, Tessa, Dana, and Marian.
 */
export class GenerationConfig {
  volume: number | null;
  speed: number | null;
  emotion: string | null;

  constructor(options: GenerationConfigOptions = {}) {
    this.volume = options.volume ?? null;
    this.speed = options.speed ?? null;
    this.emotion = options.emotion ?? null;
  }

  /**
   * The fields as a JSON-ready dict (pydantic's `model_dump`).
   *
   * @param options.excludeNone Leave out fields that are null.
   */
  modelDump(options: { excludeNone?: boolean } = {}): Dict {
    const dump: Dict = { volume: this.volume, speed: this.speed, emotion: this.emotion };
    if (options.excludeNone) {
      for (const key of Object.keys(dump)) {
        if (dump[key] === null) delete dump[key];
      }
    }
    return dump;
  }
}

/** A request's generation config: the settings', with what its expression asks for. */
export function _generationConfig(config: GenerationConfig | null, expression: Dict): Dict | null {
  const values = config ? config.modelDump({ excludeNone: true }) : {};
  const merged = { ...values, ...expression };
  return Object.keys(merged).length > 0 ? merged : null;
}

const LANGUAGE_MAP: Partial<Record<Language, string>> = {
  [Language.AR]: "ar",
  [Language.BG]: "bg",
  [Language.BG_BG]: "bg-BG",
  [Language.BN]: "bn",
  [Language.BN_IN]: "bn-IN",
  [Language.CS]: "cs",
  [Language.CS_CZ]: "cs-CZ",
  [Language.DA]: "da",
  [Language.DA_DK]: "da-DK",
  [Language.DE]: "de",
  [Language.DE_AT]: "de-AT",
  [Language.DE_DE]: "de-DE",
  [Language.EL]: "el",
  [Language.EL_GR]: "el-GR",
  [Language.EN]: "en",
  [Language.EN_AU]: "en-AU",
  [Language.EN_CA]: "en-CA",
  [Language.EN_GB]: "en-GB",
  [Language.EN_IE]: "en-IE",
  [Language.EN_IN]: "en-IN",
  [Language.EN_NZ]: "en-NZ",
  [Language.EN_SG]: "en-SG",
  [Language.EN_US]: "en-US",
  [Language.EN_ZA]: "en-ZA",
  [Language.ES]: "es",
  [Language.ES_AR]: "es-AR",
  [Language.ES_CL]: "es-CL",
  [Language.ES_CO]: "es-CO",
  [Language.ES_DO]: "es-DO",
  [Language.ES_ES]: "es-ES",
  [Language.ES_MX]: "es-MX",
  [Language.ES_PA]: "es-PA",
  [Language.ES_PE]: "es-PE",
  [Language.ES_PR]: "es-PR",
  [Language.ES_US]: "es-US",
  [Language.FI]: "fi",
  [Language.FI_FI]: "fi-FI",
  [Language.FR]: "fr",
  [Language.FR_BE]: "fr-BE",
  [Language.FR_CA]: "fr-CA",
  [Language.FR_FR]: "fr-FR",
  [Language.GU]: "gu",
  [Language.GU_IN]: "gu-IN",
  [Language.HE]: "he",
  [Language.HE_IL]: "he-IL",
  [Language.HI]: "hi",
  [Language.HI_IN]: "hi-IN",
  [Language.HR]: "hr",
  [Language.HR_HR]: "hr-HR",
  [Language.HU]: "hu",
  [Language.HU_HU]: "hu-HU",
  [Language.ID]: "id",
  [Language.ID_ID]: "id-ID",
  [Language.IT]: "it",
  [Language.IT_IT]: "it-IT",
  [Language.JA]: "ja",
  [Language.JA_JP]: "ja-JP",
  [Language.KA]: "ka",
  [Language.KA_GE]: "ka-GE",
  [Language.KN]: "kn",
  [Language.KN_IN]: "kn-IN",
  [Language.KO]: "ko",
  [Language.KO_KR]: "ko-KR",
  [Language.ML]: "ml",
  [Language.ML_IN]: "ml-IN",
  [Language.MR]: "mr",
  [Language.MR_IN]: "mr-IN",
  [Language.MS]: "ms",
  [Language.MS_MY]: "ms-MY",
  [Language.NL]: "nl",
  [Language.NL_BE]: "nl-BE",
  [Language.NL_NL]: "nl-NL",
  [Language.NB]: "no",
  [Language.NO]: "no",
  [Language.NB_NO]: "no-NO",
  [Language.OR]: "or",
  [Language.OR_IN]: "or-IN",
  [Language.PA]: "pa",
  [Language.PA_IN]: "pa-IN",
  [Language.PL]: "pl",
  [Language.PL_PL]: "pl-PL",
  [Language.PT]: "pt",
  [Language.PT_BR]: "pt-BR",
  [Language.PT_PT]: "pt-PT",
  [Language.RO]: "ro",
  [Language.RO_RO]: "ro-RO",
  [Language.RU]: "ru",
  [Language.RU_RU]: "ru-RU",
  [Language.SK]: "sk",
  [Language.SK_SK]: "sk-SK",
  [Language.SV]: "sv",
  [Language.SV_SE]: "sv-SE",
  [Language.TA]: "ta",
  [Language.TA_IN]: "ta-IN",
  [Language.TE]: "te",
  [Language.TE_IN]: "te-IN",
  [Language.TH]: "th",
  [Language.TH_TH]: "th-TH",
  [Language.FIL]: "tl",
  [Language.TL]: "tl",
  [Language.FIL_PH]: "tl-PH",
  [Language.TR]: "tr",
  [Language.TR_TR]: "tr-TR",
  [Language.UK]: "uk",
  [Language.UK_UA]: "uk-UA",
  [Language.UR]: "ur",
  [Language.UR_IN]: "ur-IN",
  [Language.VI]: "vi",
  [Language.VI_VN]: "vi-VN",
  [Language.ZH]: "zh",
  [Language.ZH_CN]: "zh-CN",
};

/**
 * Convert a Language value to Cartesia language code.
 *
 * @param language The Language value to convert.
 * @returns The corresponding service language code. Regional codes Cartesia
 *   supports (e.g., `es-MX`) are kept. Any other `language` falls back to the
 *   base language code (e.g., `de` from `de-CH`) and logs a warning (via
 *   `resolveLanguage(..., useBaseCode = true)`).
 */
export function languageToCartesiaLanguage(language: Language): string {
  return resolveLanguage(language, LANGUAGE_MAP, true);
}

/**
 * Render a pronunciation as Cartesia inline phonemes.
 *
 * Cartesia reads `<<…>>` blocks of `|`-separated IPA phones, with stress
 * marks directly before the vowel they stress. Each word of the IPA becomes
 * its own block.
 *
 * @param _word The word being pronounced (unused: the block replaces it).
 * @param ipa The pronunciation, in IPA.
 * @returns The inline phoneme blocks, e.g. `<<m|ɛ|t|f|ˈ|ɔ|ɹ|m|ɪ|n>>`, or null
 *   for an empty pronunciation.
 */
export function formatCartesiaPronunciation(_word: string, ipa: string): string | null {
  const blocks = normalizeIpa(ipa)
    .split(/\s+/)
    .filter((w) => w)
    .map((w) => `<<${stressBeforeVowels(ipaPhones(w)).join("|")}>>`);
  return blocks.join(" ") || null;
}

export interface CartesiaTTSSettingsOptions extends TTSSettingsOptions {
  /**
   * Accent a multilingual voice speaks the language with (e.g. `british`).
   * The value must be one the voice itself supports, as listed in the
   * `accents` field of Cartesia's Get Voice response. Unset lets Cartesia
   * pick the closest accent the voice supports for the requested language.
   */
  accent?: string | null | NotGiven;
  /**
   * Generation configuration for Cartesia models. Includes volume, speed
   * (numeric), and emotion (string) parameters.
   */
  generationConfig?: GenerationConfig | null | NotGiven;
  /** The ID of the pronunciation dictionary to use for custom pronunciations. */
  pronunciationDictId?: string | null | NotGiven;
}

/**
 * Settings for CartesiaTTSService and CartesiaHttpTTSService.
 *
 * - `accent`: accent a multilingual voice speaks the language with (e.g.
 *   `british`). The value must be one the voice itself supports, as listed in
 *   the `accents` field of Cartesia's Get Voice response. Unset lets Cartesia
 *   pick the closest accent the voice supports for the requested language.
 * - `generationConfig`: generation configuration for Cartesia models.
 *   Includes volume, speed (numeric), and emotion (string) parameters.
 * - `pronunciationDictId`: the ID of the pronunciation dictionary to use for
 *   custom pronunciations.
 */
export class CartesiaTTSSettings extends TTSSettings {
  accent: string | null | NotGiven = NOT_GIVEN;
  generationConfig: GenerationConfig | null | NotGiven = NOT_GIVEN;
  pronunciationDictId: string | null | NotGiven = NOT_GIVEN;

  constructor(options: CartesiaTTSSettingsOptions = {}) {
    super(options);
    this._assignOptions(options);
  }
}

/** Python's `str(x)` for a number (`1.5` → "1.5"). */
function pyStr(value: number | string): string {
  return String(value);
}

/** Python's `repr()` of a JSON value (`str(dict)` in an f-string), for error messages. */
function pyRepr(value: unknown): string {
  if (value === null || value === undefined) return "None";
  if (value === true) return "True";
  if (value === false) return "False";
  if (typeof value === "number") return pyNumberRepr(value);
  if (typeof value === "string") {
    const quote = value.includes("'") && !value.includes('"') ? '"' : "'";
    let out = "";
    for (const ch of value) {
      if (ch === "\\") out += "\\\\";
      else if (ch === quote) out += `\\${ch}`;
      else if (ch === "\n") out += "\\n";
      else if (ch === "\r") out += "\\r";
      else if (ch === "\t") out += "\\t";
      else out += ch;
    }
    return `${quote}${out}${quote}`;
  }
  if (Array.isArray(value)) return `[${value.map(pyRepr).join(", ")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Dict).map(([k, v]) => `${pyRepr(k)}: ${pyRepr(v)}`);
    return `{${entries.join(", ")}}`;
  }
  return String(value);
}

const CARTESIA_TAG_RE = /<\/?(?:spell|emotion|break|volume|speed)\b[^>]*>/gi;

/** Python's `str.isalnum()` for a single character. */
function isAlnum(ch: string): boolean {
  return ch !== "" && /^[\p{L}\p{N}]$/u.test(ch);
}

export interface CartesiaTTSServiceOptions extends WebsocketTTSServiceOptions {
  /** Cartesia API key for authentication. */
  apiKey: string;
  /** WebSocket URL for Cartesia TTS API. */
  url?: string;
  /** Audio encoding format. */
  encoding?: string;
  /** Audio container format. */
  container?: string;
  /**
   * Server-side buffering window before generation starts. `0` disables
   * server buffering (custom buffering); any value in (0, 5000] enables
   * managed buffering. If null, derived from `textAggregationMode`: `0` for
   * `SENTENCE` (avoids stacking client and server buffering), unset for
   * `TOKEN` (uses Cartesia's 3000ms default).
   */
  maxBufferDelayMs?: number | null;
  /** Optional additional HTTP headers to send with the WebSocket handshake. */
  extraHeaders?: Record<string, string> | null;
  /** Runtime-updatable settings. */
  settings?: CartesiaTTSSettings | null;
  /** How to aggregate incoming text before synthesis. */
  textAggregationMode?: TextAggregationMode | null;
}

/**
 * Cartesia TTS service with WebSocket streaming and word timestamps.
 *
 * Provides text-to-speech using Cartesia's streaming WebSocket API. Supports
 * word-level timestamps, audio context management, and various voice
 * customization options including generation configuration.
 */
export class CartesiaTTSService extends WebsocketTTSService {
  static Settings: typeof CartesiaTTSSettings = CartesiaTTSSettings;
  declare protected _settings: CartesiaTTSSettings;
  static override expressionAdapterClass = CartesiaExpressionAdapter;

  static {
    installTracedTts(CartesiaTTSService.prototype, "runTts");
  }

  protected _apiKey: string;
  protected _cartesiaVersion: string;
  protected _url: string;
  protected _extraHeaders: Record<string, string>;
  // Audio output format — init-only, not runtime-updatable
  protected _outputContainer: string;
  protected _outputEncoding: string;
  protected _outputSampleRate: number;
  protected _maxBufferDelayMs: number | null;
  protected _receiveTask: Task<unknown> | null = null;

  /**
   * Initialize the Cartesia TTS service.
   *
   * @param options.apiKey Cartesia API key for authentication.
   * @param options.url WebSocket URL for Cartesia TTS API.
   * @param options.sampleRate Audio sample rate. If null, uses default.
   * @param options.encoding Audio encoding format.
   * @param options.container Audio container format.
   * @param options.maxBufferDelayMs Server-side buffering window before
   *   generation starts. `0` disables server buffering (custom buffering);
   *   any value in (0, 5000] enables managed buffering. If null, derived from
   *   `textAggregationMode`: `0` for `SENTENCE` (avoids stacking client and
   *   server buffering), unset for `TOKEN` (uses Cartesia's 3000ms default).
   * @param options.extraHeaders Optional additional HTTP headers to send with
   *   the WebSocket handshake.
   * @param options.settings Runtime-updatable settings.
   * @param options.textAggregationMode How to aggregate incoming text before
   *   synthesis.
   *   Other options are passed to the parent service.
   */
  constructor(options: CartesiaTTSServiceOptions) {
    // By default, we aggregate sentences before sending to TTS. This adds
    // ~200-300ms of latency per sentence (waiting for the sentence-ending
    // punctuation token from the LLM). Setting
    // textAggregationMode=TextAggregationMode.TOKEN streams tokens
    // directly, which reduces latency. Streaming quality is good but less
    // tested than sentence aggregation.
    // TODO: Consider making TOKEN the default for Cartesia in 1.0.
    //
    // We also don't want to automatically push LLM response text frames,
    // because the context aggregators will add them to the LLM context even
    // if we're interrupted. Cartesia gives us word-by-word timestamps. We
    // can use those to generate text frames ourselves aligned with the
    // playout timing of the audio!

    // 1. Initialize defaultSettings with hardcoded defaults
    const defaultSettings = new (new.target as typeof CartesiaTTSService).Settings({
      model: "sonic-3.6",
      voice: null,
      language: Language.EN,
      accent: null,
      generationConfig: null,
      pronunciationDictId: null,
    });

    // 2. Apply settings delta (canonical API, always wins)
    if (options.settings !== undefined && options.settings !== null) {
      defaultSettings.applyUpdate(options.settings);
    }

    super({
      ...options,
      textAggregationMode: options.textAggregationMode ?? null,
      pushTextFrames: false,
      pauseFrameProcessing: false,
      sampleRate: options.sampleRate ?? null,
      pushStartFrame: true,
      settings: defaultSettings,
    });

    // Always skip tags added for spelled-out text
    // Note: This is primarily to support backwards compatibility.
    //    The preferred way of taking advantage of Cartesia SSML Tags is
    //    to use an LLMTextProcessor and/or a textTransformer to identify
    //    and insert these tags for the purpose of the TTS service alone.
    this._textAggregator = new SkipTagsAggregator({
      tags: [["<spell>", "</spell>"]],
      aggregationType: this._textAggregationMode,
    });

    this._apiKey = options.apiKey;
    this._cartesiaVersion = _CARTESIA_API_VERSION;
    this._url = options.url ?? "wss://api.cartesia.ai/tts/websocket";
    this._extraHeaders = options.extraHeaders ? { ...options.extraHeaders } : {};

    // Audio output format — init-only, not runtime-updatable
    this._outputContainer = options.container ?? "raw";
    this._outputEncoding = options.encoding ?? "pcm_s16le";
    this._outputSampleRate = 0; // Set in setup() from this.sampleRate

    // Cartesia warns against the "middle ground" of client-side sentence
    // aggregation plus the server's default 3000ms buffer. When the user
    // doesn't pick a value, send 0 in SENTENCE mode (custom buffering) and
    // leave it unset in TOKEN mode so the server default applies (managed
    // buffering).
    let maxBufferDelayMs = options.maxBufferDelayMs ?? null;
    if (maxBufferDelayMs === null && !this._isStreamingTokens) {
      maxBufferDelayMs = 0;
    }
    this._maxBufferDelayMs = maxBufferDelayMs;

    this._receiveTask = null;
  }

  /**
   * Render a pronunciation as Cartesia inline phonemes.
   *
   * See `formatCartesiaPronunciation`.
   *
   * @param word The word being pronounced.
   * @param ipa The pronunciation, in IPA.
   * @returns The inline phoneme blocks, or null when the pronunciation cannot
   *   be used.
   */
  static override formatPronunciation(word: string, ipa: string): string | null {
    return formatCartesiaPronunciation(word, ipa);
  }

  /**
   * Check if this service can generate processing metrics.
   *
   * @returns True, as Cartesia service supports metrics generation.
   */
  override canGenerateMetrics(): boolean {
    return true;
  }

  /**
   * Convert a Language value to Cartesia language format.
   *
   * @param language The language to convert.
   * @returns The Cartesia-specific language code, or null if not supported.
   */
  override languageToServiceLanguage(language: Language): string | null {
    return languageToCartesiaLanguage(language);
  }

  // A set of Cartesia-specific helpers for text transformations

  /** Wrap text in Cartesia spell tag. */
  static SPELL(text: string): string {
    return `<spell>${text}</spell>`;
  }

  /** Convenience method to create an emotion tag. */
  static EMOTION_TAG(emotion: CartesiaEmotion): string {
    return `<emotion value="${emotion}" />`;
  }

  /** Convenience method to create a pause tag. */
  static PAUSE_TAG(seconds: number): string {
    return `<break time="${pyStr(seconds)}s" />`;
  }

  /** Convenience method to create a volume tag. */
  static VOLUME_TAG(volume: number): string {
    return `<volume ratio="${pyStr(volume)}" />`;
  }

  /** Convenience method to create a speed tag. */
  static SPEED_TAG(speed: number): string {
    return `<speed ratio="${pyStr(speed)}" />`;
  }

  /**
   * Check if the given language is Chinese or Japanese.
   *
   * @param language The language code to check.
   * @returns True if the language is Chinese or Japanese.
   */
  protected _isChineseOrJapaneseLanguage(language: string): boolean {
    const baseLang = (language.split("-")[0] ?? "").toLowerCase();
    return baseLang === "zh" || baseLang === "ja";
  }

  static _CARTESIA_TAG_RE: RegExp = CARTESIA_TAG_RE;

  /**
   * Remove Cartesia SSML tags from a word-timestamp token.
   *
   * A tag standing between two alphanumeric characters is replaced by a
   * space, since it is the only thing separating two words
   * (`"to<spell>1234"`). Anywhere else it is removed outright: a space there
   * would not join anything, and it would split a word from its own
   * punctuation (`"<spell>1234</spell>."` must stay `"1234."`, not
   * `"1234 ."`, or the token no longer matches the text that was sent for
   * synthesis).
   */
  protected _stripCartesiaTags(text: string): string {
    const re = new RegExp(CartesiaTTSService._CARTESIA_TAG_RE.source, "gi");
    let result = text.replace(re, (match: string, offset: number) => {
      // Python's text[-1] wraps around; upstream guards with match.start().
      const before = offset ? (text[offset - 1] ?? "") : "";
      const end = offset + match.length;
      const after = end < text.length ? (text[end] ?? "") : "";
      return isAlnum(before) && isAlnum(after) ? " " : "";
    });
    result = result.replace(/\s+/g, " ");
    return result.trim();
  }

  /**
   * Normalize raw word timestamps from Cartesia before further processing.
   *
   * Strips Cartesia SSML tags (spell, emotion, break, volume, speed) from each
   * word and drops entries that become empty after stripping. Each entry
   * keeps its own start time, so one entry in is at most one token out,
   * whatever the language.
   *
   * @param words List of words/characters from Cartesia.
   * @param starts List of start timestamps for each word/character.
   * @returns List of [word, startTime] tuples.
   */
  protected _normalizeWordTimestamps(words: string[], starts: number[]): [string, number][] {
    const result: [string, number][] = [];
    const n = Math.min(words.length, starts.length);
    for (let i = 0; i < n; i++) {
      const cleaned = this._stripCartesiaTags(words[i] as string);
      if (cleaned) {
        result.push([cleaned, starts[i] as number]);
      }
    }
    return result;
  }

  /** Whether timestamp text should be treated as carrying its own spacing. */
  protected _wordTimestampsIncludeInterFrameSpaces(): boolean {
    const currentLanguage = assertGiven(this._settings.language);
    return Boolean(currentLanguage && this._isChineseOrJapaneseLanguage(String(currentLanguage)));
  }

  protected _buildMsg(
    options: {
      text?: string;
      continueTranscript?: boolean;
      addTimestamps?: boolean;
      contextId?: string;
    } = {},
  ): string {
    const voiceConfig: Dict = {};
    voiceConfig.mode = "id";
    voiceConfig.id = this._settings.voice;

    const msg: Dict = {
      transcript: options.text ?? "",
      continue: options.continueTranscript ?? true,
      context_id: options.contextId ?? "",
      model_id: this._settings.model,
      voice: voiceConfig,
      output_format: {
        container: this._outputContainer,
        encoding: this._outputEncoding,
        sample_rate: this._outputSampleRate,
      },
      add_timestamps: options.addTimestamps ?? true,
      use_normalized_timestamps: false,
    };

    if (this._maxBufferDelayMs !== null) {
      msg.max_buffer_delay_ms = this._maxBufferDelayMs;
    }

    if (this._settings.language) {
      msg.language = this._settings.language;
    }

    if (assertGiven(this._settings.accent)) {
      msg.accent = this._settings.accent;
    }

    const generationConfig = _generationConfig(
      assertGiven(this._settings.generationConfig),
      this.expressionSettings,
    );
    if (generationConfig) {
      msg.generation_config = generationConfig;
    }

    if (this._settings.pronunciationDictId) {
      msg.pronunciation_dict_id = this._settings.pronunciationDictId;
    }

    return pyJsonDumps(msg);
  }

  /**
   * Set up the service and connect.
   *
   * @param setup Configuration object containing setup parameters.
   */
  override async setup(setup: FrameProcessorSetup): Promise<void> {
    await super.setup(setup);
    this._outputSampleRate = this.sampleRate;
    await this._connect();
  }

  override async _connect(): Promise<void> {
    await super._connect();

    await this._connectWebsocket();

    if (this._websocket && !this._receiveTask) {
      this._receiveTask = this.createTask(() =>
        this._receiveTaskHandler((error, options) => this._reportError(error, options)),
      );
    }
  }

  override async _disconnect(): Promise<void> {
    await super._disconnect();

    if (this._receiveTask) {
      await this.cancelTask(this._receiveTask);
      this._receiveTask = null;
    }

    await this._disconnectWebsocket();
  }

  override async _connectWebsocket(): Promise<void> {
    try {
      if (this._websocket && this._websocket.state === State.OPEN) {
        return;
      }
      logger.debug("Connecting to Cartesia TTS");
      this._websocket = await this._websocketConnect(this._url, {
        additionalHeaders: {
          "X-API-Key": this._apiKey,
          "Cartesia-Version": this._cartesiaVersion,
          ...this._extraHeaders,
        },
      });
      await this._callEventHandler("on_connected");
    } catch (e) {
      rethrowIfCancelled(e);
      await this.pushError(`Unknown error occurred: ${errorMessage(e)}`, { exception: e });
      this._websocket = null;
      await this._callEventHandler("on_connection_error", errorMessage(e));
    }
  }

  override async _disconnectWebsocket(): Promise<void> {
    try {
      await this.stopAllMetrics();

      if (this._websocket) {
        logger.debug(`${this}: Disconnecting from Cartesia`);
        await this._websocket.close();
      }
    } catch (e) {
      rethrowIfCancelled(e);
      await this.pushError(`Unknown error occurred: ${errorMessage(e)}`, { exception: e });
    } finally {
      this._websocket = null;
      await this._callEventHandler("on_disconnected");
    }
  }

  protected _getWebsocket(): WebsocketClientConnection {
    if (this._websocket) {
      return this._websocket;
    }
    throw new Error("Websocket not connected");
  }

  /** Cancel the active Cartesia context when the bot is interrupted. */
  override async onAudioContextInterrupted(contextId: string): Promise<void> {
    await this.stopAllMetrics();
    if (contextId) {
      const cancelMsg = pyJsonDumps({ context_id: contextId, cancel: true });
      await this._getWebsocket().send(cancelMsg);
    }
    await super.onAudioContextInterrupted(contextId);
  }

  /**
   * Close the Cartesia context after all audio has been played.
   *
   * No close message is needed: the server already considers the context
   * done once it has sent its `done` message, which is handled in
   * `_processMessages`.
   */
  override async onAudioContextCompleted(contextId: string): Promise<void> {
    await super.onAudioContextCompleted(contextId);
  }

  /**
   * Flush any pending audio and finalize the current context.
   *
   * @param contextId The specific context to flush. If null, falls back to
   *   the currently active context.
   */
  override async flushAudio(contextId: string | null = null): Promise<void> {
    const flushId = contextId || this.getActiveAudioContextId();
    if (!flushId || !this._websocket) {
      return;
    }
    logger.trace(`${this}: flushing audio`);
    const msg = this._buildMsg({ text: "", continueTranscript: false, contextId: flushId });
    await this._websocket.send(msg);
  }

  /**
   * Apply a TTS settings delta, flushing the context if needed.
   *
   * Voice, model, and language are locked per Cartesia context. If any of
   * these change, the current context is flushed so the next sentence opens
   * a fresh one with the updated settings.
   *
   * @param delta A TTS settings delta.
   * @returns Record mapping changed field names to their previous values.
   */
  protected override async _updateSettings(delta: TTSSettings): Promise<Record<string, unknown>> {
    const changed = await super._updateSettings(delta);
    if (Object.keys(changed).length === 0) {
      return changed;
    }

    if (["voice", "model", "language"].some((key) => Object.hasOwn(changed, key))) {
      if (this._turnContextId) {
        // Finalize the old context's still-pending sentence so its
        // already-heard prefix still emits progress frames (mirrors the
        // LLMFullResponseEnd / TTSSpeak close paths). A mid-sentence
        // settings change would otherwise abandon it before promotion,
        // dropping that prefix from the transcript.
        await this._pushSequencerFrames(
          await this._aggregatedFrameSequencer.finalize(this._turnContextId),
          this._turnContextId,
        );
      }
      if (this._turnContextId && this.audioContextAvailable(this._turnContextId)) {
        await this.flushAudio(this._turnContextId);
      }
      // Assign a new turn context ID so subsequent sentences in this
      // turn open a new Cartesia context with the updated settings.
      if (this._turnContextId) {
        this._turnContextId = null;
        this._turnContextId = this.createContextId();
      }
    }

    return changed;
  }

  protected async _processMessages(): Promise<void> {
    for await (const message of this._getWebsocket()) {
      const text = typeof message === "string" ? message : new TextDecoder().decode(message);
      const msg = pyJsonLoads(text) as Dict | null;
      if (!msg || Object.keys(msg).length === 0) {
        continue;
      }
      // Upstream indexes msg["context_id"] / msg["type"], so a message missing
      // either raises KeyError and ends the receive loop (which reconnects).
      if (!Object.hasOwn(msg, "context_id")) {
        throw new Error("'context_id'");
      }
      if (!this.audioContextAvailable(msg.context_id as string)) {
        continue;
      }
      if (!Object.hasOwn(msg, "type")) {
        throw new Error("'type'");
      }
      const ctxId = msg.context_id as string;
      if (msg.type === "done") {
        await this.stopTtfbMetrics();
        await this.appendToAudioContext(ctxId, new TTSStoppedFrame({ contextId: ctxId }));
        await this.removeAudioContext(ctxId);
      } else if (msg.type === "timestamps") {
        // Process the timestamps based on language before adding them
        const processedTimestamps = this._normalizeWordTimestamps(
          msg.word_timestamps.words,
          msg.word_timestamps.start,
        );
        // Cartesia reports Chinese and Japanese one character at a time, with
        // each punctuation mark as its own token. Merging attaches the mark to
        // the character before it ("す", "。" -> "す。").
        const cjk = this._wordTimestampsIncludeInterFrameSpaces();
        await this.addWordTimestamps(processedTimestamps, ctxId, {
          includesInterFrameSpaces: cjk ? true : null,
          preMergeTokens: cjk,
        });
      } else if (msg.type === "chunk") {
        const frame = new TTSAudioRawFrame({
          audio: base64ToBytes(msg.data),
          sampleRate: this.sampleRate,
          numChannels: 1,
          contextId: ctxId,
        });
        await this.appendToAudioContext(ctxId, frame);
      } else if (msg.type === "error") {
        await this.pushFrame(new TTSStoppedFrame({ contextId: ctxId }));
        await this.stopAllMetrics();
        await this.pushError(`Error: ${pyRepr(msg)}`);
        this.resetActiveAudioContext();
      } else if (msg.type === "flush_done") {
        // Cartesia emits flush_done as a per-transcript boundary marker
        // within a context (e.g. when max_buffer_delay_ms=0 causes the
        // server to flush each submission). We don't need it: each turn
        // already has its own context_id and audio chunks are tagged
        // with it. Acknowledge silently.
      } else {
        await this.pushError(`Error, unknown message type: ${pyRepr(msg)}`);
      }
    }
  }

  override async _receiveMessages(): Promise<void> {
    while (true) {
      await this._processMessages();
      // Cartesia times out after 5 minutes of innactivity (no keepalive
      // mechanism is available). So, we try to reconnect.
      logger.debug(`${this} Cartesia connection was disconnected (timeout?), reconnecting`);
      await this._connectWebsocket();
    }
  }

  /**
   * Generate speech from text using Cartesia's streaming API.
   *
   * @param text The text to synthesize into speech.
   * @param contextId The context ID for tracking audio frames.
   * @returns Audio frames containing the synthesized speech.
   */
  override async *runTts(text: string, contextId: string): AsyncGenerator<Frame | null, void> {
    try {
      if (!this._websocket || this._websocket.state === State.CLOSED) {
        await this._connect();
      }

      const msg = this._buildMsg({ text, contextId });

      try {
        await this._getWebsocket().send(msg);
        await this.startTtsUsageMetrics(text);
      } catch (e) {
        rethrowIfCancelled(e);
        yield new ErrorFrame({ error: `Unknown error occurred: ${errorMessage(e)}` });
        yield new TTSStoppedFrame({ contextId });
        await this._disconnect();
        await this._connect();
        return;
      }
      yield null;
    } catch (e) {
      rethrowIfCancelled(e);
      yield new ErrorFrame({ error: `Unknown error occurred: ${errorMessage(e)}` });
    }
  }
}

export interface CartesiaHttpTTSServiceOptions extends TTSServiceOptions {
  /** Cartesia API key for authentication. */
  apiKey: string;
  /** Base URL for Cartesia HTTP API. */
  baseUrl?: string;
  /**
   * `fetch` used for HTTP requests. If not provided, the global `fetch` is
   * used, set up in `setup()` and released at teardown.
   *
   * DIVERGENCE: replaces upstream's `aiohttp_session`.
   */
  fetch?: typeof fetch | null;
  /** Audio encoding format. */
  encoding?: string;
  /** Audio container format. */
  container?: string;
  /** Optional additional HTTP headers to send with each synthesis request. */
  extraHeaders?: Record<string, string> | null;
  /** Runtime-updatable settings. */
  settings?: CartesiaTTSSettings | null;
}

/**
 * Cartesia HTTP-based TTS service.
 *
 * Provides text-to-speech using Cartesia's HTTP API for simpler,
 * non-streaming synthesis. Suitable for use cases where streaming is not
 * required and simpler integration is preferred.
 */
export class CartesiaHttpTTSService extends TTSService {
  static Settings: typeof CartesiaTTSSettings = CartesiaTTSSettings;
  declare protected _settings: CartesiaTTSSettings;
  static override expressionAdapterClass = CartesiaExpressionAdapter;

  static {
    installTracedTts(CartesiaHttpTTSService.prototype, "runTts");
  }

  protected _apiKey: string;
  protected _baseUrl: string;
  protected _cartesiaVersion: string;
  protected _extraHeaders: Record<string, string>;
  // Audio output format — init-only, not runtime-updatable
  protected _outputContainer: string;
  protected _outputEncoding: string;
  protected _outputSampleRate: number;
  protected _session: typeof fetch | null;
  protected _ownsSession: boolean;

  /**
   * Initialize the Cartesia HTTP TTS service.
   *
   * @param options.apiKey Cartesia API key for authentication.
   * @param options.baseUrl Base URL for Cartesia HTTP API.
   * @param options.fetch `fetch` used for HTTP requests. If not provided, the
   *   global `fetch` is used.
   * @param options.sampleRate Audio sample rate. If null, uses default.
   * @param options.encoding Audio encoding format.
   * @param options.container Audio container format.
   * @param options.extraHeaders Optional additional HTTP headers to send with
   *   each synthesis request.
   * @param options.settings Runtime-updatable settings.
   *   Other options are passed to the parent TTSService.
   */
  constructor(options: CartesiaHttpTTSServiceOptions) {
    // 1. Initialize defaultSettings with hardcoded defaults
    const defaultSettings = new (new.target as typeof CartesiaHttpTTSService).Settings({
      model: "sonic-3.6",
      voice: null,
      language: Language.EN,
      accent: null,
      generationConfig: null,
      pronunciationDictId: null,
    });

    // 2. Apply settings delta (canonical API, always wins)
    if (options.settings !== undefined && options.settings !== null) {
      defaultSettings.applyUpdate(options.settings);
    }

    super({
      ...options,
      sampleRate: options.sampleRate ?? null,
      pushStartFrame: true,
      pushStopFrames: true,
      settings: defaultSettings,
    });

    this._apiKey = options.apiKey;
    this._baseUrl = options.baseUrl ?? "https://api.cartesia.ai";
    this._cartesiaVersion = _CARTESIA_API_VERSION;
    this._extraHeaders = options.extraHeaders ? { ...options.extraHeaders } : {};

    // Audio output format — init-only, not runtime-updatable
    this._outputContainer = options.container ?? "raw";
    this._outputEncoding = options.encoding ?? "pcm_s16le";
    this._outputSampleRate = 0; // Set in setup() from this.sampleRate

    this._session = options.fetch ?? null;
    this._ownsSession = !options.fetch;
  }

  /**
   * Render a pronunciation as Cartesia inline phonemes.
   *
   * See `formatCartesiaPronunciation`.
   *
   * @param word The word being pronounced.
   * @param ipa The pronunciation, in IPA.
   * @returns The inline phoneme blocks, or null when the pronunciation cannot
   *   be used.
   */
  static override formatPronunciation(word: string, ipa: string): string | null {
    return formatCartesiaPronunciation(word, ipa);
  }

  /**
   * Check if this service can generate processing metrics.
   *
   * @returns True, as Cartesia HTTP service supports metrics generation.
   */
  override canGenerateMetrics(): boolean {
    return true;
  }

  /**
   * Convert a Language value to Cartesia language format.
   *
   * @param language The language to convert.
   * @returns The Cartesia-specific language code, or null if not supported.
   */
  override languageToServiceLanguage(language: Language): string | null {
    return languageToCartesiaLanguage(language);
  }

  /**
   * Set up the service.
   *
   * @param setup Configuration object containing setup parameters.
   */
  override async setup(setup: FrameProcessorSetup): Promise<void> {
    await super.setup(setup);

    this._outputSampleRate = this.sampleRate;
    if (this._ownsSession) {
      this._session = (input, init) => fetch(input, init);
    }
  }

  /** Close the HTTP session if we own it. */
  protected async _closeSession(): Promise<void> {
    if (this._ownsSession && this._session) {
      this._session = null;
    }
  }

  /** Close the owned HTTP session at teardown. */
  override async cleanup(): Promise<void> {
    await super.cleanup();
    await this._closeSession();
  }

  /**
   * Generate speech from text using Cartesia's HTTP API.
   *
   * @param text The text to synthesize into speech.
   * @param contextId The context ID for tracking audio frames.
   * @returns Audio frames containing the synthesized speech.
   */
  override async *runTts(text: string, contextId: string): AsyncGenerator<Frame, void> {
    try {
      if (this._session === null) {
        throw new Error("HTTP session is not initialized; call start() before run_tts()");
      }

      const voiceConfig: Dict = { mode: "id", id: this._settings.voice };

      const outputFormat: Dict = {
        container: this._outputContainer,
        encoding: this._outputEncoding,
        sample_rate: this._outputSampleRate,
      };

      const payload: Dict = {
        model_id: this._settings.model,
        transcript: text,
        voice: voiceConfig,
        output_format: outputFormat,
      };

      if (this._settings.language) {
        payload.language = this._settings.language;
      }

      if (assertGiven(this._settings.accent)) {
        payload.accent = this._settings.accent;
      }

      const generationConfig = _generationConfig(
        assertGiven(this._settings.generationConfig),
        this.expressionSettings,
      );
      if (generationConfig) {
        payload.generation_config = generationConfig;
      }

      if (this._settings.pronunciationDictId) {
        payload.pronunciation_dict_id = this._settings.pronunciationDictId;
      }

      const headers: Record<string, string> = {
        "Cartesia-Version": this._cartesiaVersion,
        "X-API-Key": this._apiKey,
        "Content-Type": "application/json",
        ...this._extraHeaders,
      };

      const url = `${this._baseUrl}/tts/bytes`;

      const session = this._session;
      const response = await abortable(
        session(url, {
          method: "POST",
          headers,
          body: pyJsonDumps(payload),
          signal: currentSignal(),
        }),
      );
      if (response.status !== 200) {
        const errorText = await abortable(response.text());
        yield new ErrorFrame({
          error: `Cartesia API error (status ${response.status}): ${errorText}`,
        });
        return;
      }

      const audioData = new Uint8Array(await abortable(response.arrayBuffer()));

      await this.startTtsUsageMetrics(text);

      const frame = new TTSAudioRawFrame({
        audio: audioData,
        sampleRate: this.sampleRate,
        numChannels: 1,
        contextId,
      });

      yield frame;
    } catch (e) {
      rethrowIfCancelled(e);
      yield new ErrorFrame({ error: `Unknown error occurred: ${errorMessage(e)}` });
    } finally {
      await this.stopTtfbMetrics();
    }
  }
}
