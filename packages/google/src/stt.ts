// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/services/google/stt.py

/**
 * Google speech-to-text service implementations for Pipecat.
 *
 * `GoogleSTTService` provides Google Cloud Speech-to-Text V2, with features
 * like automatic punctuation, voice activity detection, and multi-language
 * support.
 *
 * Porting notes:
 * - Google Cloud Speech V2 streaming is gRPC-only, so the default client is
 *   the Node SDK `@google-cloud/speech` (an optional peer dependency), loaded
 *   lazily on first connect. Importing this module does not load it. A
 *   different transport can be supplied with the `client` option
 *   (`GoogleSTTClient`).
 * - DIVERGENCE: upstream resolves credentials and the project ID in the
 *   constructor. Reading a credentials file and Application Default
 *   Credentials are asynchronous in JS, so with `credentialsPath` or ADC the
 *   client is created, and the "No valid credentials provided." / "Project ID
 *   not found in credentials" errors are raised, on first connect (in
 *   `setup()`). Inline `credentials` are still validated in the constructor.
 * - Protobuf messages (`SpeechAdaptation`, `DenoiserConfig`) are plain
 *   objects. Keys may be given in snake_case, as upstream documents them, or
 *   camelCase; they are converted to the SDK's camelCase field names when
 *   the request is built.
 * - Deprecated upstream APIs are not ported: `GoogleSTTService.InputParams`
 *   and the `params` option, `setLanguages()` and `updateOptions()`.
 * - DIVERGENCE: `GoogleSTTSettings.languageCodes` is kept (upstream
 *   deprecated it) because `Language` cannot express Google-only codes such
 *   as `"auto"`, Chirp's automatic language detection.
 * - DIVERGENCE: pipedog-only `finalizeOnVadStop` option (see
 *   `GoogleSTTServiceOptions`), and a gRPC CANCELLED error (code 1) on the
 *   response stream is a quiet end of that stream, not an error.
 * - DIVERGENCE: pipedog-only `sharedClient` option (one Speech client per
 *   location, credentials and client options in the process) and
 *   `prewarm()`, which connects the gRPC channel and fetches a token ahead of
 *   the first stream.
 * - DIVERGENCE: pipedog-only `setLanguageCodes()`, the same API as
 *   `GeminiSTTService`'s: changed codes are applied, reconnecting, on the
 *   next `BotStartedSpeakingFrame`, or once the user's turn ends if they are
 *   speaking then.
 */

import { abortable, Queue, rethrowIfCancelled, sleep, type Task, time } from "@pipedog/asyncio";
import {
  BotStartedSpeakingFrame,
  type CancelFrame,
  type EndFrame,
  type Frame,
  InterimTranscriptionFrame,
  TranscriptionFrame,
  VADUserStoppedSpeakingFrame,
} from "@pipedog/core/frames/frames";
import type { FrameDirection, FrameProcessorSetup } from "@pipedog/core/processors/frame_processor";
import { STTSettings, type STTSettingsOptions } from "@pipedog/core/services/settings";
import { GOOGLE_TTFS_P99 } from "@pipedog/core/services/stt_latency";
import { STTService, type STTServiceOptions } from "@pipedog/core/services/stt_service";
import { Language, resolveLanguage } from "@pipedog/core/transcriptions/language";
import { logger } from "@pipedog/core/utils/logger";
import { timeNowIso8601 } from "@pipedog/core/utils/time";
import { installTracedStt } from "@pipedog/core/utils/tracing/service_decorators";
import { assertGiven, isGiven, NOT_GIVEN, type NotGiven } from "@pipedog/core/utils/types";

const GOOGLE_CLOUD_SPEECH = "@google-cloud/speech";

/**
 * Maps Language enum to Google Speech-to-Text V2 language codes.
 *
 * @param language Language enum value.
 * @returns The corresponding Google STT language code. If `language` is not in
 *   the verified mapping, falls back to the full language code string and logs
 *   a warning (via `resolveLanguage(..., useBaseCode = false)`).
 */
export function languageToGoogleSttLanguage(language: Language): string {
  const LANGUAGE_MAP: Partial<Record<Language, string>> = {
    // Afrikaans
    [Language.AF]: "af-ZA",
    [Language.AF_ZA]: "af-ZA",
    // Albanian
    [Language.SQ]: "sq-AL",
    [Language.SQ_AL]: "sq-AL",
    // Amharic
    [Language.AM]: "am-ET",
    [Language.AM_ET]: "am-ET",
    // Arabic
    [Language.AR]: "ar-EG", // Default to Egypt
    [Language.AR_AE]: "ar-AE",
    [Language.AR_BH]: "ar-BH",
    [Language.AR_DZ]: "ar-DZ",
    [Language.AR_EG]: "ar-EG",
    [Language.AR_IQ]: "ar-IQ",
    [Language.AR_JO]: "ar-JO",
    [Language.AR_KW]: "ar-KW",
    [Language.AR_LB]: "ar-LB",
    [Language.AR_MA]: "ar-MA",
    [Language.AR_OM]: "ar-OM",
    [Language.AR_QA]: "ar-QA",
    [Language.AR_SA]: "ar-SA",
    [Language.AR_SY]: "ar-SY",
    [Language.AR_TN]: "ar-TN",
    [Language.AR_YE]: "ar-YE",
    // Armenian
    [Language.HY]: "hy-AM",
    [Language.HY_AM]: "hy-AM",
    // Azerbaijani
    [Language.AZ]: "az-AZ",
    [Language.AZ_AZ]: "az-AZ",
    // Basque
    [Language.EU]: "eu-ES",
    [Language.EU_ES]: "eu-ES",
    // Bengali
    [Language.BN]: "bn-IN", // Default to India
    [Language.BN_BD]: "bn-BD",
    [Language.BN_IN]: "bn-IN",
    // Bosnian
    [Language.BS]: "bs-BA",
    [Language.BS_BA]: "bs-BA",
    // Bulgarian
    [Language.BG]: "bg-BG",
    [Language.BG_BG]: "bg-BG",
    // Burmese
    [Language.MY]: "my-MM",
    [Language.MY_MM]: "my-MM",
    // Catalan
    [Language.CA]: "ca-ES",
    [Language.CA_ES]: "ca-ES",
    // Chinese
    [Language.ZH]: "cmn-Hans-CN", // Default to Simplified Chinese
    [Language.ZH_CN]: "cmn-Hans-CN",
    [Language.ZH_HK]: "cmn-Hans-HK",
    [Language.ZH_TW]: "cmn-Hant-TW",
    [Language.YUE]: "yue-Hant-HK", // Cantonese
    [Language.YUE_CN]: "yue-Hant-HK",
    // Croatian
    [Language.HR]: "hr-HR",
    [Language.HR_HR]: "hr-HR",
    // Czech
    [Language.CS]: "cs-CZ",
    [Language.CS_CZ]: "cs-CZ",
    // Danish
    [Language.DA]: "da-DK",
    [Language.DA_DK]: "da-DK",
    // Dutch
    [Language.NL]: "nl-NL", // Default to Netherlands
    [Language.NL_BE]: "nl-BE",
    [Language.NL_NL]: "nl-NL",
    // English
    [Language.EN]: "en-US", // Default to US
    [Language.EN_AU]: "en-AU",
    [Language.EN_CA]: "en-CA",
    [Language.EN_GB]: "en-GB",
    [Language.EN_GH]: "en-GH",
    [Language.EN_HK]: "en-HK",
    [Language.EN_IN]: "en-IN",
    [Language.EN_IE]: "en-IE",
    [Language.EN_KE]: "en-KE",
    [Language.EN_NG]: "en-NG",
    [Language.EN_NZ]: "en-NZ",
    [Language.EN_PH]: "en-PH",
    [Language.EN_SG]: "en-SG",
    [Language.EN_TZ]: "en-TZ",
    [Language.EN_US]: "en-US",
    [Language.EN_ZA]: "en-ZA",
    // Estonian
    [Language.ET]: "et-EE",
    [Language.ET_EE]: "et-EE",
    // Filipino
    [Language.FIL]: "fil-PH",
    [Language.FIL_PH]: "fil-PH",
    // Finnish
    [Language.FI]: "fi-FI",
    [Language.FI_FI]: "fi-FI",
    // French
    [Language.FR]: "fr-FR", // Default to France
    [Language.FR_BE]: "fr-BE",
    [Language.FR_CA]: "fr-CA",
    [Language.FR_CH]: "fr-CH",
    [Language.FR_FR]: "fr-FR",
    // Galician
    [Language.GL]: "gl-ES",
    [Language.GL_ES]: "gl-ES",
    // Georgian
    [Language.KA]: "ka-GE",
    [Language.KA_GE]: "ka-GE",
    // German
    [Language.DE]: "de-DE", // Default to Germany
    [Language.DE_AT]: "de-AT",
    [Language.DE_CH]: "de-CH",
    [Language.DE_DE]: "de-DE",
    // Greek
    [Language.EL]: "el-GR",
    [Language.EL_GR]: "el-GR",
    // Gujarati
    [Language.GU]: "gu-IN",
    [Language.GU_IN]: "gu-IN",
    // Hebrew
    [Language.HE]: "iw-IL",
    [Language.HE_IL]: "iw-IL",
    // Hindi
    [Language.HI]: "hi-IN",
    [Language.HI_IN]: "hi-IN",
    // Hungarian
    [Language.HU]: "hu-HU",
    [Language.HU_HU]: "hu-HU",
    // Icelandic
    [Language.IS]: "is-IS",
    [Language.IS_IS]: "is-IS",
    // Indonesian
    [Language.ID]: "id-ID",
    [Language.ID_ID]: "id-ID",
    // Italian
    [Language.IT]: "it-IT",
    [Language.IT_IT]: "it-IT",
    [Language.IT_CH]: "it-CH",
    // Japanese
    [Language.JA]: "ja-JP",
    [Language.JA_JP]: "ja-JP",
    // Javanese
    [Language.JV]: "jv-ID",
    [Language.JV_ID]: "jv-ID",
    // Kannada
    [Language.KN]: "kn-IN",
    [Language.KN_IN]: "kn-IN",
    // Kazakh
    [Language.KK]: "kk-KZ",
    [Language.KK_KZ]: "kk-KZ",
    // Khmer
    [Language.KM]: "km-KH",
    [Language.KM_KH]: "km-KH",
    // Korean
    [Language.KO]: "ko-KR",
    [Language.KO_KR]: "ko-KR",
    // Lao
    [Language.LO]: "lo-LA",
    [Language.LO_LA]: "lo-LA",
    // Latvian
    [Language.LV]: "lv-LV",
    [Language.LV_LV]: "lv-LV",
    // Lithuanian
    [Language.LT]: "lt-LT",
    [Language.LT_LT]: "lt-LT",
    // Macedonian
    [Language.MK]: "mk-MK",
    [Language.MK_MK]: "mk-MK",
    // Malay
    [Language.MS]: "ms-MY",
    [Language.MS_MY]: "ms-MY",
    // Malayalam
    [Language.ML]: "ml-IN",
    [Language.ML_IN]: "ml-IN",
    // Marathi
    [Language.MR]: "mr-IN",
    [Language.MR_IN]: "mr-IN",
    // Mongolian
    [Language.MN]: "mn-MN",
    [Language.MN_MN]: "mn-MN",
    // Nepali
    [Language.NE]: "ne-NP",
    [Language.NE_NP]: "ne-NP",
    // Norwegian
    [Language.NO]: "no-NO",
    [Language.NB]: "no-NO",
    [Language.NB_NO]: "no-NO",
    // Persian
    [Language.FA]: "fa-IR",
    [Language.FA_IR]: "fa-IR",
    // Polish
    [Language.PL]: "pl-PL",
    [Language.PL_PL]: "pl-PL",
    // Portuguese
    [Language.PT]: "pt-PT", // Default to Portugal
    [Language.PT_BR]: "pt-BR",
    [Language.PT_PT]: "pt-PT",
    // Punjabi
    [Language.PA]: "pa-Guru-IN",
    [Language.PA_IN]: "pa-Guru-IN",
    // Romanian
    [Language.RO]: "ro-RO",
    [Language.RO_RO]: "ro-RO",
    // Russian
    [Language.RU]: "ru-RU",
    [Language.RU_RU]: "ru-RU",
    // Serbian
    [Language.SR]: "sr-RS",
    [Language.SR_RS]: "sr-RS",
    // Sinhala
    [Language.SI]: "si-LK",
    [Language.SI_LK]: "si-LK",
    // Slovak
    [Language.SK]: "sk-SK",
    [Language.SK_SK]: "sk-SK",
    // Slovenian
    [Language.SL]: "sl-SI",
    [Language.SL_SI]: "sl-SI",
    // Spanish
    [Language.ES]: "es-ES", // Default to Spain
    [Language.ES_AR]: "es-AR",
    [Language.ES_BO]: "es-BO",
    [Language.ES_CL]: "es-CL",
    [Language.ES_CO]: "es-CO",
    [Language.ES_CR]: "es-CR",
    [Language.ES_DO]: "es-DO",
    [Language.ES_EC]: "es-EC",
    [Language.ES_ES]: "es-ES",
    [Language.ES_GT]: "es-GT",
    [Language.ES_HN]: "es-HN",
    [Language.ES_MX]: "es-MX",
    [Language.ES_NI]: "es-NI",
    [Language.ES_PA]: "es-PA",
    [Language.ES_PE]: "es-PE",
    [Language.ES_PR]: "es-PR",
    [Language.ES_PY]: "es-PY",
    [Language.ES_SV]: "es-SV",
    [Language.ES_US]: "es-US",
    [Language.ES_UY]: "es-UY",
    [Language.ES_VE]: "es-VE",
    // Sundanese
    [Language.SU]: "su-ID",
    [Language.SU_ID]: "su-ID",
    // Swahili
    [Language.SW]: "sw-TZ", // Default to Tanzania
    [Language.SW_KE]: "sw-KE",
    [Language.SW_TZ]: "sw-TZ",
    // Swedish
    [Language.SV]: "sv-SE",
    [Language.SV_SE]: "sv-SE",
    // Tamil
    [Language.TA]: "ta-IN", // Default to India
    [Language.TA_IN]: "ta-IN",
    [Language.TA_MY]: "ta-MY",
    [Language.TA_SG]: "ta-SG",
    [Language.TA_LK]: "ta-LK",
    // Telugu
    [Language.TE]: "te-IN",
    [Language.TE_IN]: "te-IN",
    // Thai
    [Language.TH]: "th-TH",
    [Language.TH_TH]: "th-TH",
    // Turkish
    [Language.TR]: "tr-TR",
    [Language.TR_TR]: "tr-TR",
    // Ukrainian
    [Language.UK]: "uk-UA",
    [Language.UK_UA]: "uk-UA",
    // Urdu
    [Language.UR]: "ur-IN", // Default to India
    [Language.UR_IN]: "ur-IN",
    [Language.UR_PK]: "ur-PK",
    // Uzbek
    [Language.UZ]: "uz-UZ",
    [Language.UZ_UZ]: "uz-UZ",
    // Vietnamese
    [Language.VI]: "vi-VN",
    [Language.VI_VN]: "vi-VN",
    // Xhosa
    [Language.XH]: "xh-ZA",
    // Zulu
    [Language.ZU]: "zu-ZA",
    [Language.ZU_ZA]: "zu-ZA",
  };

  return resolveLanguage(language, LANGUAGE_MAP, false);
}

//
// Speech V2 message shapes
//

/**
 * A `SpeechAdaptation` message, as a plain object.
 *
 * `phrase_sets` (or `phraseSets`) entries are `{ phrase_set: "<resource name>" }`
 * or `{ inline_phrase_set: { phrases: [...] } }`. Other fields of the message
 * (e.g. `custom_classes`) pass through unchanged.
 */
export type SpeechAdaptation = Record<string, unknown>;

/** A `DenoiserConfig` message, as a plain object (e.g. `{ denoise_audio: true }`). */
export type DenoiserConfig = Record<string, unknown>;

/** One request on the Speech V2 `StreamingRecognize` stream (SDK field names). */
export interface StreamingRecognizeRequest {
  recognizer?: string;
  streamingConfig?: Record<string, unknown>;
  audio?: Uint8Array;
}

/** A recognition alternative in a streaming result. */
export interface SpeechRecognitionAlternative {
  transcript?: string | null;
  confidence?: number | null;
  [key: string]: unknown;
}

/** A result in a `StreamingRecognizeResponse`. */
export interface StreamingRecognitionResult {
  alternatives?: SpeechRecognitionAlternative[] | null;
  isFinal?: boolean | null;
  languageCode?: string | null;
  [key: string]: unknown;
}

/** One response on the Speech V2 `StreamingRecognize` stream. */
export interface StreamingRecognizeResponse {
  results?: StreamingRecognitionResult[] | null;
  [key: string]: unknown;
}

/**
 * A bidirectional `StreamingRecognize` call.
 *
 * Requests are written with `write()` and the request side is closed with
 * `end()`; responses are read by iterating the call. `cancel()` abandons the
 * call. The Node SDK's gRPC stream has this shape.
 */
export interface GoogleSTTStreamingCall extends AsyncIterable<StreamingRecognizeResponse> {
  write(request: StreamingRecognizeRequest): unknown;
  end(): unknown;
  cancel(): unknown;
}

/** The subset of the Speech V2 client that `GoogleSTTService` uses. */
export interface GoogleSTTClient {
  /** Open a bidirectional streaming recognition call. */
  streamingRecognize(): GoogleSTTStreamingCall;
  /** Resolve the project ID of the client's credentials. */
  getProjectId?(): Promise<string | null | undefined>;
  /**
   * Connect ahead of the first stream: open the gRPC channel and fetch an
   * access token. Rejects if that fails. pipedog-only.
   */
  prewarm?(options?: { timeout?: number }): Promise<void>;
}

/** The parts of `@google-cloud/speech`'s v2 `SpeechClient` we use. */
interface NodeSpeechV2ClientLike {
  _streamingRecognize?(): GoogleSTTStreamingCall;
  streamingRecognize?(): GoogleSTTStreamingCall;
  getProjectId(): Promise<string>;
  /** Builds the gRPC stub (and its channel). */
  initialize?(): Promise<{
    waitForReady?(deadline: number, callback: (error?: Error | null) => void): void;
  }>;
  auth?: { getAccessToken?(): Promise<unknown> };
}

// Shared Speech clients (`sharedClient`), by everything the client is built
// from: plain values by content, anything else (a module, gRPC channel
// credentials) by identity. A failed build is dropped, so the next connect
// tries again.
const sharedSttClients = new Map<string, Promise<GoogleSTTClient>>();
const sharedKeyIds = new WeakMap<object, number>();
let nextSharedKeyId = 0;

function sharedClientKey(options: object): string {
  return JSON.stringify(options, (_key, value: unknown) => {
    const isObject = typeof value === "object" && value !== null;
    if (
      typeof value === "function" ||
      (isObject && !Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype)
    ) {
      let id = sharedKeyIds.get(value as object);
      if (id === undefined) {
        id = ++nextSharedKeyId;
        sharedKeyIds.set(value as object, id);
      }
      return `#${id}`;
    }
    return value;
  });
}

interface NodeSpeechModuleLike {
  v2: { SpeechClient: new (options: Record<string, unknown>) => NodeSpeechV2ClientLike };
}

/** Whether `e` is gRPC `ABORTED` (google.api_core.exceptions.Aborted, HTTP 409). */
function isAbortedError(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { code?: unknown }).code === 10;
}

/** gRPC CANCELLED (code 1): the call was cancelled on our side. */
function isCancelledGrpcError(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { code?: unknown }).code === 1;
}

// Queued after the last audio of an utterance (`finalizeOnVadStop`): ends
// that request stream. Compared by identity.
const HALF_CLOSE = new Uint8Array(0);

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    !ArrayBuffer.isView(value)
  );
}

function typeName(value: unknown): string {
  if (value === null || value === undefined) return "NoneType";
  if (typeof value === "string") return "str";
  if (Array.isArray(value)) return "list";
  if (typeof value === "number") return Number.isInteger(value) ? "int" : "float";
  if (typeof value === "boolean") return "bool";
  if (typeof value === "object") return (value as object).constructor?.name ?? "object";
  return typeof value;
}

/** Convert a snake_case key to camelCase (`phrase_sets` → `phraseSets`). */
function snakeToCamel(key: string): string {
  return key.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

/** Deep-convert plain-object keys to the SDK's camelCase field names. */
function toMessageFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(toMessageFields);
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[snakeToCamel(k)] = toMessageFields(v);
    return out;
  }
  return value;
}

/**
 * Return whether a Google STT v2 model accepts a SpeechAdaptation config.
 *
 * The telephony model rejects it with `Recognizer does not support feature:
 * speech_adaptation_boost`. Support elsewhere is a per-model, per-language
 * matrix that Google validates on its own, so every other model is passed
 * through and left to report its own errors.
 */
export function _modelSupportsAdaptation(model: string | null | undefined): boolean {
  return (model || "").toLowerCase() !== "telephony";
}

/**
 * Normalize adaptation input to a SpeechAdaptation message.
 *
 * A `phrase_sets` entry may be a resource name string, an
 * `AdaptationPhraseSet` object, or a bare inline phrase set; a single entry
 * may be given in place of a list.
 *
 * @param adaptation A `SpeechAdaptation` message, or a dict payload to convert.
 * @returns The equivalent `SpeechAdaptation` message.
 * @throws Error If the payload has a shape Google's API can't represent
 *   (upstream: ValueError).
 */
export function _normalizeSpeechAdaptation(adaptation: SpeechAdaptation): SpeechAdaptation {
  const normalized: Record<string, unknown> = { ...adaptation };

  const key =
    "phrase_sets" in normalized || !("phraseSets" in normalized) ? "phrase_sets" : "phraseSets";
  let rawPhraseSets: unknown = normalized[key] ?? [];
  // Whether the input is already in message form (nothing to convert).
  let alreadyMessage = Array.isArray(rawPhraseSets) || !(key in normalized);
  if (typeof rawPhraseSets === "string" || isPlainObject(rawPhraseSets)) {
    rawPhraseSets = [rawPhraseSets];
  }
  const phraseSets = [...(rawPhraseSets as Iterable<unknown>)];

  const convertedPhraseSets: Record<string, unknown>[] = [];
  for (const phraseSet of phraseSets) {
    if (typeof phraseSet === "string") {
      convertedPhraseSets.push({ phrase_set: phraseSet });
      alreadyMessage = false;
      continue;
    }

    if (!isPlainObject(phraseSet)) {
      throw new Error(
        "Invalid Google SpeechAdaptation phrase_set entry: expected string or object, " +
          `got ${typeName(phraseSet)}.`,
      );
    }

    if (
      "phrase_set" in phraseSet ||
      "inline_phrase_set" in phraseSet ||
      "phraseSet" in phraseSet ||
      "inlinePhraseSet" in phraseSet
    ) {
      convertedPhraseSets.push(phraseSet);
      continue;
    }

    convertedPhraseSets.push({ inline_phrase_set: phraseSet });
    alreadyMessage = false;
  }

  if (convertedPhraseSets.length > 0) {
    normalized[key] = convertedPhraseSets;
  }

  // Upstream builds a `cloud_speech.SpeechAdaptation` message here, which
  // rejects a mistyped phrase (e.g. a bare string) with a TypeError. Messages
  // are plain objects in this port, so check the phrases ourselves.
  for (const phraseSet of convertedPhraseSets) {
    validateInlinePhraseSet(phraseSet.inline_phrase_set ?? phraseSet.inlinePhraseSet);
  }

  // Upstream returns a `SpeechAdaptation` message unchanged; here that is an
  // object that needed no conversion.
  if (alreadyMessage) {
    return adaptation;
  }
  return normalized;
}

/** Reject inline phrases that a `PhraseSet` message cannot hold (upstream: TypeError). */
function validateInlinePhraseSet(inlinePhraseSet: unknown): void {
  if (!isPlainObject(inlinePhraseSet)) return;
  const phrases = inlinePhraseSet.phrases;
  if (phrases === undefined || phrases === null) return;
  if (!Array.isArray(phrases)) {
    throw new TypeError(
      `Invalid Google SpeechAdaptation phrases: expected list of Phrase, got ${typeName(phrases)}.`,
    );
  }
  for (const phrase of phrases) {
    if (!isPlainObject(phrase)) {
      throw new TypeError(
        `Invalid Google SpeechAdaptation phrase: expected Phrase object, got ${typeName(phrase)}.`,
      );
    }
  }
}

export interface GoogleSTTSettingsOptions extends STTSettingsOptions {
  /** List of Language values for recognition (e.g. `[Language.EN_US]`). */
  languages?: Language[] | NotGiven;
  /**
   * Google language codes sent as-is, instead of `languages` (e.g. `["auto"]`
   * for Chirp's language detection). `null` uses `languages`.
   *
   * DIVERGENCE: deprecated upstream, kept in pipedog for codes `Language`
   * cannot express.
   */
  languageCodes?: string[] | null | NotGiven;
  /** Process each audio channel separately. */
  useSeparateRecognitionPerChannel?: boolean | NotGiven;
  /** Add punctuation to transcripts. */
  enableAutomaticPunctuation?: boolean | NotGiven;
  /** Include spoken punctuation in transcript. */
  enableSpokenPunctuation?: boolean | NotGiven;
  /** Include spoken emojis in transcript. */
  enableSpokenEmojis?: boolean | NotGiven;
  /** Filter profanity from transcript. */
  profanityFilter?: boolean | NotGiven;
  /** Include timing information for each word. */
  enableWordTimeOffsets?: boolean | NotGiven;
  /** Include confidence scores for each word. */
  enableWordConfidence?: boolean | NotGiven;
  /** Stream partial recognition results. */
  enableInterimResults?: boolean | NotGiven;
  /** Detect voice activity in audio. */
  enableVoiceActivityEvents?: boolean | NotGiven;
  /** Phrase sets biasing recognition toward specific words. */
  adaptation?: SpeechAdaptation | null | NotGiven;
  /** Background-noise removal (Chirp 3 models only). */
  denoiserConfig?: DenoiserConfig | null | NotGiven;
}

/**
 * Settings for GoogleSTTService.
 *
 * - `languages`: list of Language values for recognition (e.g.
 *   `[Language.EN_US]`).
 * - `languageCodes`: Google language codes sent as-is, taking precedence over
 *   `languages` (e.g. `["auto"]`). pipedog-only (deprecated upstream).
 * - `useSeparateRecognitionPerChannel`: process each audio channel separately.
 * - `enableAutomaticPunctuation`: add punctuation to transcripts.
 * - `enableSpokenPunctuation`: include spoken punctuation in transcript.
 * - `enableSpokenEmojis`: include spoken emojis in transcript.
 * - `profanityFilter`: filter profanity from transcript.
 * - `enableWordTimeOffsets`: include timing information for each word.
 * - `enableWordConfidence`: include confidence scores for each word.
 * - `enableInterimResults`: stream partial recognition results.
 * - `enableVoiceActivityEvents`: detect voice activity in audio.
 * - `adaptation`: phrase sets biasing recognition toward specific words, as a
 *   `SpeechAdaptation` message or an equivalent dict. Each `phrase_sets`
 *   entry is either the resource name of a phrase set or an inline one:
 *
 *   ```ts
 *   adaptation: {
 *     phrase_sets: [
 *       "projects/my-project/locations/global/phraseSets/catalog",
 *       { phrases: [{ value: "pipecat", boost: 15.0 }] },
 *     ],
 *   }
 *   ```
 *
 *   Referenced phrase sets must live in the same location as the service.
 *   The telephony model rejects adaptation and transcribes without it;
 *   support otherwise varies by model and language — see
 *   https://cloud.google.com/speech-to-text/v2/docs/speech-to-text-supported-languages
 * - `denoiserConfig`: background-noise removal, as a `DenoiserConfig` message
 *   or an equivalent dict (`{ denoise_audio: true }`). Only the Chirp 3 models
 *   denoise; see https://cloud.google.com/speech-to-text/docs/models/chirp-3
 */
export class GoogleSTTSettings extends STTSettings {
  languages: Language[] | NotGiven = NOT_GIVEN;
  languageCodes: string[] | null | NotGiven = NOT_GIVEN;
  useSeparateRecognitionPerChannel: boolean | NotGiven = NOT_GIVEN;
  enableAutomaticPunctuation: boolean | NotGiven = NOT_GIVEN;
  enableSpokenPunctuation: boolean | NotGiven = NOT_GIVEN;
  enableSpokenEmojis: boolean | NotGiven = NOT_GIVEN;
  profanityFilter: boolean | NotGiven = NOT_GIVEN;
  enableWordTimeOffsets: boolean | NotGiven = NOT_GIVEN;
  enableWordConfidence: boolean | NotGiven = NOT_GIVEN;
  enableInterimResults: boolean | NotGiven = NOT_GIVEN;
  enableVoiceActivityEvents: boolean | NotGiven = NOT_GIVEN;
  adaptation: SpeechAdaptation | null | NotGiven = NOT_GIVEN;
  denoiserConfig: DenoiserConfig | null | NotGiven = NOT_GIVEN;

  constructor(options: GoogleSTTSettingsOptions = {}) {
    super(options);
    this._assignOptions(options);
  }
}

export interface GoogleSTTServiceOptions extends STTServiceOptions {
  /** JSON string containing Google Cloud service account credentials. */
  credentials?: string | null;
  /** Path to service account credentials JSON file. */
  credentialsPath?: string | null;
  /** Google Cloud location (e.g., "global", "us-central1"). */
  location?: string;
  /** Runtime-updatable settings. */
  settings?: GoogleSTTSettings | null;
  /**
   * A Speech V2 client to use instead of `@google-cloud/speech`. When given,
   * credentials are not read; the project ID comes from `credentials` or from
   * the client's `getProjectId()`.
   */
  client?: GoogleSTTClient | null;
  /**
   * Extra options for the `@google-cloud/speech` v2 `SpeechClient` (e.g.
   * `apiEndpoint`, `port`, `sslCreds`, `fallback`), merged over the ones the
   * service derives from `location` and the credentials.
   *
   * DIVERGENCE: pipedog-only. Upstream builds its client from `location` and
   * the credentials alone.
   */
  clientOptions?: Record<string, unknown> | null;
  /**
   * The `@google-cloud/speech` module (`import * as speech from "@google-cloud/speech"`),
   * instead of importing it by name on first connect. A bundler (`bun build`) cannot see an
   * import by name, so a bundled app imports the SDK itself and passes it here.
   *
   * DIVERGENCE: pipedog-only.
   */
  speechModule?: GoogleSpeechModule | null;
  /**
   * Use the process-wide Speech client for this location, credentials,
   * `clientOptions` and `speechModule` instead of building one per service,
   * so a server running one pipeline per call opens one gRPC channel and
   * fetches tokens once. Pair it with `prewarm()` at start-up. Default false:
   * each service has its own client (upstream's behavior), since one channel
   * carries every concurrent stream of the process. Services never close
   * clients. Ignored when `client` is given.
   *
   * DIVERGENCE: pipedog-only.
   */
  sharedClient?: boolean;
  /**
   * Finalize an utterance as soon as VAD reports the user stopped speaking.
   *
   * Google only sends a final result once its own endpointing decides the
   * utterance is over (about 1.5 s after speech ends). With this option the
   * service half-closes the request stream on `VADUserStoppedSpeakingFrame`,
   * so Google returns the final for the audio it has right away (about
   * 0.6 s), and opens a new stream for the next audio, which waits in the
   * queue meanwhile. The finals of the closing stream are pushed as one
   * finalized `TranscriptionFrame`. Requires a VAD upstream. Default false.
   *
   * DIVERGENCE: pipedog-only.
   */
  finalizeOnVadStop?: boolean;
}

/** The part of `@google-cloud/speech` the service uses: its v2 `SpeechClient`. */
export interface GoogleSpeechModule {
  v2: { SpeechClient: new (options: any) => any };
}

/**
 * Google Cloud Speech-to-Text V2 service implementation.
 *
 * Provides real-time speech recognition using Google Cloud's Speech-to-Text
 * V2 API with streaming support. Handles audio transcription and optional
 * voice activity detection. Implements automatic stream reconnection to
 * handle Google's 4-minute streaming limit.
 *
 * - `Settings`: the settings class for the STT service.
 * - `STREAMING_LIMIT`: Google Cloud's streaming limit in milliseconds (4
 *   minutes).
 *
 * @throws Error If neither credentials nor credentialsPath is provided (and
 *   no default credentials are found).
 * @throws Error If project ID is not found in credentials.
 */
export class GoogleSTTService extends STTService {
  static Settings = GoogleSTTSettings;
  declare protected _settings: GoogleSTTSettings;

  // Google Cloud's STT service has a connection time limit of 5 minutes per stream.
  // They've shared an "endless streaming" example that guided this implementation:
  // https://cloud.google.com/speech-to-text/docs/transcribe-streaming-audio#endless-streaming

  /** 4 minutes in milliseconds. */
  static readonly STREAMING_LIMIT = 240000;

  protected _location: string;
  protected _stream: unknown = null;
  protected _config: Record<string, unknown> | null = null;
  protected _streamingTask: Task<unknown> | null = null;
  protected _requestQueue: Queue<Uint8Array> = new Queue();

  // Used for keep-alive logic
  protected _streamStartTime = 0;
  protected _lastAudioInput: Uint8Array[] = [];
  protected _audioInput: Uint8Array[] = [];
  protected _resultEndTime = 0;
  protected _isFinalEndTime = 0;
  protected _finalRequestEndTime = 0;
  protected _bridgingOffset = 0;
  protected _lastTranscriptWasFinal = false;
  protected _newStream = true;
  protected _restartCounter = 0;

  protected _projectId: string | null = null;
  protected _client: GoogleSTTClient | null = null;

  #credentials: Record<string, unknown> | null = null;

  /** `self.STREAMING_LIMIT` upstream: honors a subclass override. */
  get #streamingLimit(): number {
    return (this.constructor as typeof GoogleSTTService).STREAMING_LIMIT;
  }
  #credentialsPath: string | null = null;
  #clientOptions: Record<string, unknown> | null = null;
  #speechModule: GoogleSpeechModule | null = null;
  #finalizeOnVadStop: boolean;
  #sharedClient: boolean;
  // Codes from setLanguageCodes(), until the language settings change, and
  // whether they are being written to the settings.
  #languageCodesSource: string[] | (() => string[]) | null = null;
  #applyingLanguageCodes = false;
  // finalizeOnVadStop: a half-close is pending, and the finals it produced.
  #halfClosing = false;
  #heldFinals: TranscriptionFrame[] = [];

  /**
   * Initialize the Google STT service.
   *
   * @param options.credentials JSON string containing Google Cloud service
   *   account credentials.
   * @param options.credentialsPath Path to service account credentials JSON
   *   file.
   * @param options.location Google Cloud location (e.g., "global",
   *   "us-central1").
   * @param options.sampleRate Audio sample rate in Hertz.
   * @param options.settings Runtime-updatable settings.
   * @param options.ttfsP99Latency P99 latency from speech end to final
   *   transcript in seconds. Override for your deployment. See
   *   https://github.com/pipecat-ai/stt-benchmark
   * @param options.client A Speech V2 client to use instead of the Node SDK.
   *   Other options are passed to STTService.
   */
  constructor(options: GoogleSTTServiceOptions = {}) {
    const {
      credentials,
      credentialsPath,
      location,
      client,
      clientOptions,
      speechModule,
      finalizeOnVadStop,
      sharedClient,
      settings,
      ...rest
    } = options;

    // 1. Initialize default_settings with hardcoded defaults
    const defaultSettings = new GoogleSTTSettings({
      language: null,
      languages: [Language.EN_US],
      languageCodes: null,
      model: "latest_long",
      useSeparateRecognitionPerChannel: false,
      enableAutomaticPunctuation: true,
      enableSpokenPunctuation: false,
      enableSpokenEmojis: false,
      profanityFilter: false,
      enableWordTimeOffsets: false,
      enableWordConfidence: false,
      enableInterimResults: true,
      enableVoiceActivityEvents: false,
      adaptation: null,
      denoiserConfig: null,
    });

    // 2. No direct init arg overrides

    // 3. Apply settings delta (canonical API, always wins)
    if (settings !== undefined && settings !== null) {
      defaultSettings.applyUpdate(settings);
    }

    if (isGiven(defaultSettings.adaptation) && defaultSettings.adaptation !== null) {
      defaultSettings.adaptation = _normalizeSpeechAdaptation(defaultSettings.adaptation);
    }

    super({
      ...rest,
      sampleRate: options.sampleRate ?? null,
      ttfsP99Latency:
        options.ttfsP99Latency !== undefined ? options.ttfsP99Latency : GOOGLE_TTFS_P99,
      settings: defaultSettings,
    });

    this._location = location ?? "global";
    this._client = client ?? null;
    this.#clientOptions = clientOptions ?? null;
    this.#speechModule = speechModule ?? null;
    this.#finalizeOnVadStop = finalizeOnVadStop ?? false;
    this.#sharedClient = sharedClient ?? false;

    // Extract project ID. With a credentials file or default credentials the
    // client (and the project ID) are resolved on first connect.
    if (credentials) {
      const jsonAccountInfo = JSON.parse(credentials) as Record<string, unknown>;
      this._projectId = (jsonAccountInfo.project_id as string | undefined) ?? null;
      this.#credentials = jsonAccountInfo;
      if (!this._projectId) {
        throw new Error("Project ID not found in credentials");
      }
    } else if (credentialsPath) {
      this.#credentialsPath = credentialsPath;
    }
  }

  /**
   * Check if the service can generate metrics.
   *
   * @returns True, as this service supports metrics generation.
   */
  override canGenerateMetrics(): boolean {
    return true;
  }

  /**
   * Convert a Language enum to a Google STT language code.
   *
   * Narrower return type than the base class's `string | null`: this override
   * always returns a string, falling back to `"en-US"` for languages not in
   * the verified mapping (see `languageToGoogleSttLanguage`).
   *
   * @param language The Language enum value to convert.
   * @returns The Google STT language code.
   */
  override languageToServiceLanguage(language: Language): string {
    return languageToGoogleSttLanguage(language) || "en-US";
  }

  /**
   * Resolve the current language settings to Google STT language code strings.
   *
   * Uses `languageCodes` if set, else `languages` (Language values). Falls
   * back to `["en-US"]`.
   *
   * @returns Google STT language code strings.
   */
  protected _getLanguageCodes(): string[] {
    const codes = assertGiven(this._settings.languageCodes);
    if (codes && codes.length > 0) {
      return [...codes];
    }
    const languages = assertGiven(this._settings.languages);
    if (languages && languages.length > 0) {
      return languages.map((lang) => this.languageToServiceLanguage(lang));
    }
    return ["en-US"];
  }

  /** Build the SpeechAdaptation message from settings. */
  protected _getSpeechAdaptation(): SpeechAdaptation | null {
    const adaptation = this._settings.adaptation;
    if (!isGiven(adaptation) || adaptation === null) {
      return null;
    }
    // Already a message: normalizing on the way in leaves nothing to convert.
    return _normalizeSpeechAdaptation(adaptation);
  }

  /** Build the DenoiserConfig message from settings. */
  protected _getDenoiserConfig(): DenoiserConfig | null {
    const denoiserConfig = this._settings.denoiserConfig;
    if (!isGiven(denoiserConfig) || denoiserConfig === null) {
      return null;
    }
    return denoiserConfig;
  }

  /** Reconnect the stream if it's currently active. */
  protected async _reconnectIfNeeded(): Promise<void> {
    if (this._streamingTask) {
      logger.debug("Reconnecting stream due to configuration changes");
      await this._disconnect();
      await this._connect();
    }
  }

  /**
   * Apply settings delta and reconnect if anything changed.
   *
   * Handles `language` from base `setLanguage` by converting it to
   * `languages`. All other fields (model, boolean flags) are applied directly.
   * Reconnects the stream on any change.
   *
   * @param delta A settings delta.
   * @returns Record mapping changed field names to their previous values.
   */
  protected override async _updateSettings(delta: STTSettings): Promise<Record<string, unknown>> {
    const googleDelta = delta as GoogleSTTSettings;

    if (
      !this.#applyingLanguageCodes &&
      (isGiven(delta.language) ||
        (delta instanceof GoogleSTTSettings &&
          (isGiven(delta.languages) || isGiven(delta.languageCodes))))
    ) {
      // New language settings replace codes set with setLanguageCodes().
      this.#languageCodesSource = null;
    }

    // If base set_language sent a Language value, convert to languages list
    if (isGiven(delta.language)) {
      googleDelta.languages = [delta.language as Language];
      // A language set this way replaces explicit codes.
      googleDelta.languageCodes = null;
      // Clear language so the base class doesn't try to store it
      delta.language = NOT_GIVEN;
    }

    if (
      googleDelta.adaptation !== undefined &&
      isGiven(googleDelta.adaptation) &&
      googleDelta.adaptation !== null
    ) {
      googleDelta.adaptation = _normalizeSpeechAdaptation(googleDelta.adaptation);
    }

    const changed = await super._updateSettings(delta);

    if (Object.keys(changed).length > 0) {
      await this._reconnectIfNeeded();
    }

    return changed;
  }

  /**
   * Set up the service and connect.
   *
   * @param setup Configuration object containing setup parameters.
   */
  override async setup(setup: FrameProcessorSetup): Promise<void> {
    await super.setup(setup);
    await this._connect();
  }

  /** Release streaming resources. */
  override async cleanup(): Promise<void> {
    await super.cleanup();
    await this._disconnect();
  }

  /**
   * Stop the STT service and clean up resources.
   *
   * @param frame The end frame triggering the service stop.
   */
  override async stop(frame: EndFrame): Promise<void> {
    await super.stop(frame);
    await this._disconnect();
  }

  /**
   * Cancel the STT service and clean up resources.
   *
   * @param frame The cancel frame triggering the service cancellation.
   */
  override async cancel(frame: CancelFrame): Promise<void> {
    await super.cancel(frame);
    await this._disconnect();
  }

  /**
   * Create the Speech V2 client (and resolve the project ID) if not done yet.
   *
   * Mirrors upstream's constructor: client options use the regional endpoint
   * for a non-global location, and credentials come from `credentials`,
   * `credentialsPath` or Application Default Credentials.
   */
  protected async _ensureClient(): Promise<GoogleSTTClient> {
    if (this._client && this._projectId) {
      return this._client;
    }

    if (!this._client) {
      // Configure client options based on location
      const clientOptions: Record<string, unknown> = {};
      if (this._location !== "global") {
        clientOptions.apiEndpoint = `${this._location}-speech.googleapis.com`;
      }
      if (this.#credentials) {
        clientOptions.credentials = this.#credentials;
        clientOptions.projectId = this._projectId;
      } else if (this.#credentialsPath) {
        clientOptions.keyFilename = this.#credentialsPath;
      } else {
        clientOptions.scopes = ["https://www.googleapis.com/auth/cloud-platform"];
      }
      Object.assign(clientOptions, this.#clientOptions);

      if (this.#sharedClient) {
        const key = sharedClientKey({ clientOptions, module: this.#speechModule });
        let shared = sharedSttClients.get(key);
        if (!shared) {
          shared = this.#buildClient(clientOptions);
          sharedSttClients.set(key, shared);
          const built = shared;
          built.catch(() => {
            if (sharedSttClients.get(key) === built) sharedSttClients.delete(key);
          });
        }
        this._client = await abortable(shared);
      } else {
        this._client = await this.#buildClient(clientOptions);
      }
    }

    if (!this._projectId) {
      let projectId: string | null | undefined = null;
      try {
        projectId = await abortable(this._client.getProjectId?.() ?? Promise.resolve(null));
      } catch (e) {
        rethrowIfCancelled(e);
        if (!this.#credentials && !this.#credentialsPath) {
          throw new Error("No valid credentials provided.", { cause: e });
        }
        throw e;
      }
      this._projectId = projectId ?? null;
    }

    if (!this._projectId) {
      throw new Error("Project ID not found in credentials");
    }

    return this._client;
  }

  /** Load `@google-cloud/speech` and build a v2 `SpeechClient` behind `GoogleSTTClient`. */
  async #buildClient(clientOptions: Record<string, unknown>): Promise<GoogleSTTClient> {
    let speech: NodeSpeechModuleLike;
    try {
      const mod = (this.#speechModule ??
        (await import(GOOGLE_CLOUD_SPEECH))) as NodeSpeechModuleLike & {
        default?: NodeSpeechModuleLike;
      };
      speech = mod.v2 ? mod : (mod.default as NodeSpeechModuleLike);
    } catch (e) {
      rethrowIfCancelled(e);
      logger.error(`Exception: ${errorMessage(e)}`);
      logger.error(
        "In order to use Google STT, you need to install `@google-cloud/speech`. Also, set `GOOGLE_APPLICATION_CREDENTIALS` environment variable. " +
          "In a bundled app (bun build) it is not found by name: import it yourself " +
          "(`import * as speechModule`) and pass `speechModule` to the service.",
      );
      throw new Error(`Missing module: ${GOOGLE_CLOUD_SPEECH}`, { cause: e });
    }

    const sdkClient = new speech.v2.SpeechClient(clientOptions);
    return {
      streamingRecognize: () => {
        const fn = sdkClient._streamingRecognize ?? sdkClient.streamingRecognize;
        if (!fn) {
          throw new Error("@google-cloud/speech v2 client has no streamingRecognize method");
        }
        return fn.call(sdkClient);
      },
      getProjectId: () => sdkClient.getProjectId(),
      prewarm: async (options = {}) => {
        // Build the stub, wait for its channel, and fetch a token (cached by
        // the client for the streams that follow).
        const stub = await abortable(sdkClient.initialize?.() ?? Promise.resolve(undefined));
        if (stub?.waitForReady) {
          const deadline = Date.now() + (options.timeout ?? 10) * 1000;
          // A callback API: wrapped here, and awaited through abortable().
          const ready = new Promise<void>((resolve, reject) =>
            stub.waitForReady?.(deadline, (error) => (error ? reject(error) : resolve())),
          );
          await abortable(ready);
        }
        await abortable(sdkClient.auth?.getAccessToken?.() ?? Promise.resolve(undefined));
      },
    };
  }

  /**
   * Connect the client ahead of the first stream (load the SDK, resolve the
   * project ID, open the gRPC channel, fetch a token), e.g. at server
   * start-up with `sharedClient`. Fails soft: on failure the first stream
   * connects.
   *
   * DIVERGENCE: pipedog-only.
   *
   * @param options.timeout Seconds to wait for the channel. Default 10.
   * @returns Whether the client is connected.
   */
  async prewarm(options: { timeout?: number } = {}): Promise<boolean> {
    try {
      const client = await this._ensureClient();
      await client.prewarm?.({ timeout: options.timeout ?? 10 });
      return true;
    } catch (e) {
      rethrowIfCancelled(e);
      logger.warning(`${this}: prewarm failed, the first stream connects: ${errorMessage(e)}`);
      return false;
    }
  }

  /**
   * Set the language codes to recognize, e.g. when the bot switches
   * language: Google codes sent as-is (e.g. `["es-ES", "en-US"]`), written to
   * the `languageCodes` setting. Pass a function to have the codes read again
   * on every `BotStartedSpeakingFrame`; it stays in effect until the
   * `language`, `languages` or `languageCodes` setting is updated.
   *
   * The stream is not reconnected at once: when the codes differ from the
   * current ones, the service reconnects on the next
   * `BotStartedSpeakingFrame`, or once the user's turn ends if they are
   * speaking then, so no utterance is cut. Before the stream opens, the codes
   * are written right away.
   *
   * DIVERGENCE: pipedog-only (the same API as `GeminiSTTService`).
   *
   * @param codes The language codes, or a function returning them.
   */
  async setLanguageCodes(codes: string[] | (() => string[])): Promise<void> {
    this.#languageCodesSource = typeof codes === "function" ? codes : [...codes];
    if (!this._streamingTask) {
      await this.#applyLanguageCodes();
    } else {
      logger.debug(`${this}: language codes set; applied on the next safe reconnect`);
    }
  }

  /** The codes from `setLanguageCodes()`, if they differ from the current ones. */
  #changedLanguageCodes(): string[] | null {
    const source = this.#languageCodesSource;
    if (source === null) return null;
    const codes = [...(typeof source === "function" ? source() : source)];
    const current = assertGiven(this._settings.languageCodes) ?? [];
    const same = codes.length === current.length && codes.every((c, i) => c === current[i]);
    return same ? null : codes;
  }

  /** Write the codes from `setLanguageCodes()`, reconnecting if they changed. */
  async #applyLanguageCodes(): Promise<void> {
    const codes = this.#changedLanguageCodes();
    if (codes === null) return;
    logger.debug(`${this}: language codes changed to [${codes.join(", ")}]`);
    this.#applyingLanguageCodes = true;
    try {
      await this._updateSettings(new GoogleSTTSettings({ languageCodes: codes }));
    } finally {
      this.#applyingLanguageCodes = false;
    }
  }

  /**
   * Called by `STTService._reconnect()`, which buffers the audio meanwhile.
   * This service only asks for a reconnect for `setLanguageCodes()`, so it
   * writes the codes, which reconnects the stream if they changed.
   */
  protected override async _doReconnect(): Promise<void> {
    await this.#applyLanguageCodes();
  }

  /** Initialize streaming recognition config and stream. */
  protected async _connect(): Promise<void> {
    logger.debug("Connecting to Google Speech-to-Text");

    await this._ensureClient();

    // Set stream start time
    this._streamStartTime = Math.trunc(time() * 1000);
    this._newStream = true;

    const recognitionConfig: Record<string, unknown> = {
      explicitDecodingConfig: {
        encoding: "LINEAR16",
        sampleRateHertz: this.sampleRate,
        audioChannelCount: 1,
      },
      languageCodes: this._getLanguageCodes(),
      model: this._settings.model,
      features: {
        enableAutomaticPunctuation: this._settings.enableAutomaticPunctuation,
        enableSpokenPunctuation: this._settings.enableSpokenPunctuation,
        enableSpokenEmojis: this._settings.enableSpokenEmojis,
        profanityFilter: this._settings.profanityFilter,
        enableWordTimeOffsets: this._settings.enableWordTimeOffsets,
        enableWordConfidence: this._settings.enableWordConfidence,
      },
    };

    const denoiserConfig = this._getDenoiserConfig();
    if (denoiserConfig !== null) {
      recognitionConfig.denoiserConfig = toMessageFields(denoiserConfig);
    }

    const speechAdaptation = this._getSpeechAdaptation();
    if (speechAdaptation !== null) {
      if (_modelSupportsAdaptation(assertGiven(this._settings.model))) {
        recognitionConfig.adaptation = toMessageFields(speechAdaptation);
      } else {
        logger.warning(
          `Google STT model '${this._settings.model}' rejects adaptation; transcribing without it.`,
        );
      }
    }

    this._config = {
      config: recognitionConfig,
      streamingFeatures: {
        enableVoiceActivityEvents: this._settings.enableVoiceActivityEvents,
        interimResults: this._settings.enableInterimResults,
      },
    };

    this._requestQueue = new Queue();
    this.#halfClosing = false;
    this.#heldFinals = [];
    this._streamingTask = this.createTask(() => this._streamAudio(), "_stream_audio");

    await this._callEventHandler("on_connected");
  }

  /** Clean up streaming recognition resources. */
  protected async _disconnect(): Promise<void> {
    if (this._streamingTask) {
      logger.debug("Disconnecting from Google Speech-to-Text");
      await this.cancelTask(this._streamingTask);
      this._streamingTask = null;
    }

    await this._callEventHandler("on_disconnected");
  }

  /** Generates requests for the streaming recognize method. */
  protected async *_requestGenerator(): AsyncGenerator<StreamingRecognizeRequest, void, unknown> {
    const recognizerPath = `projects/${this._projectId}/locations/${this._location}/recognizers/_`;
    logger.trace(`Using recognizer path: ${recognizerPath}`);

    try {
      // Send initial config
      yield {
        recognizer: recognizerPath,
        streamingConfig: this._config ?? undefined,
      };

      while (true) {
        const audioData = await this._requestQueue.get();

        this._requestQueue.taskDone();

        if (audioData === HALF_CLOSE) {
          // finalizeOnVadStop: end this request stream; Google answers with
          // the final for the audio it has.
          break;
        }

        // Check streaming limit
        if (Math.trunc(time() * 1000) - this._streamStartTime > this.#streamingLimit) {
          logger.debug("Streaming limit reached, initiating graceful reconnection");
          // Instead of immediate reconnection, we'll break and let the stream close naturally
          this._lastAudioInput = this._audioInput;
          this._audioInput = [];
          this._restartCounter += 1;
          // Put the current audio chunk back in the queue
          await this._requestQueue.put(audioData);
          break;
        }

        this._audioInput.push(audioData);
        yield { audio: audioData };
      }
    } catch (e) {
      rethrowIfCancelled(e);
      await this.pushError(`Unknown error occurred: ${errorMessage(e)}`, { exception: e });
      throw e;
    }
  }

  /**
   * Feed `_requestGenerator()` into a streaming call, then close its request
   * side. This is the work gRPC does with the request iterator upstream.
   */
  protected async _sendRequests(call: GoogleSTTStreamingCall): Promise<void> {
    try {
      for await (const request of this._requestGenerator()) {
        call.write(request);
      }
      call.end();
    } catch (e) {
      rethrowIfCancelled(e);
      // A failing request iterator fails the call.
      call.cancel();
    }
  }

  /** Handle bi-directional streaming with Google STT. */
  protected async _streamAudio(): Promise<void> {
    try {
      while (true) {
        try {
          if (this._requestQueue.empty()) {
            // wait for 10ms in case we don't have audio
            await sleep(0.01);
            continue;
          }

          if (this.#finalizeOnVadStop) {
            // Each stream gets its own time budget.
            this._streamStartTime = Math.trunc(time() * 1000);
          }

          // Start bi-directional streaming
          const client = await this._ensureClient();
          const streamingRecognize = client.streamingRecognize();
          const requestsTask = this.createTask(
            () => this._sendRequests(streamingRecognize),
            "_request_generator",
          );

          try {
            // Process responses
            await this._processResponses(streamingRecognize);
          } finally {
            if (!requestsTask.done()) {
              await this.cancelTask(requestsTask);
            }
            streamingRecognize.cancel();
          }

          await this.#releaseHeldFinals();

          // If we're here, check if we need to reconnect
          if (this.#finalizeOnVadStop) {
            // A half-closed stream ended: the next audio opens a new one.
            continue;
          }
          if (Math.trunc(time() * 1000) - this._streamStartTime > this.#streamingLimit) {
            logger.debug("Reconnecting stream after timeout");
            // Reset stream start time
            this._streamStartTime = Math.trunc(time() * 1000);
          } else {
            // Normal stream end
            break;
          }
        } catch (e) {
          rethrowIfCancelled(e);
          await this.#releaseHeldFinals();
          // A cancelled call is not a failure (see _processResponses).
          if (!isCancelledGrpcError(e)) {
            await this.pushError(`Unknown error occurred: ${errorMessage(e)}`, { exception: e });
          }

          await sleep(1); // Brief delay before reconnecting
          this._streamStartTime = Math.trunc(time() * 1000);
        }
      }
    } catch (e) {
      rethrowIfCancelled(e);
      await this.pushError(`Unknown error occurred: ${errorMessage(e)}`, { exception: e });
    }
  }

  /**
   * Process a frame; with `finalizeOnVadStop`, a `VADUserStoppedSpeakingFrame`
   * half-closes the current request stream, and a `BotStartedSpeakingFrame`
   * applies codes from `setLanguageCodes()`.
   *
   * DIVERGENCE: pipedog-only override (upstream does not override it).
   */
  override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
    await super.processFrame(frame, direction);
    if (
      frame instanceof BotStartedSpeakingFrame &&
      this._streamingTask &&
      this.#changedLanguageCodes() !== null
    ) {
      // setLanguageCodes(): the bot is talking, so the user's turn is over
      // and a reconnect cuts no speech; if the user is speaking over the bot,
      // it waits for the end of their turn.
      await this._requestReconnect();
    }
    if (
      this.#finalizeOnVadStop &&
      frame instanceof VADUserStoppedSpeakingFrame &&
      this._streamingTask &&
      !this.#halfClosing
    ) {
      this.#halfClosing = true;
      await this._requestQueue.put(HALF_CLOSE);
    }
  }

  /**
   * Push the finals held from a half-closed stream as one finalized
   * transcription (`finalizeOnVadStop`).
   */
  async #releaseHeldFinals(): Promise<void> {
    if (!this.#halfClosing) return;
    const held = this.#heldFinals;
    this.#heldFinals = [];
    this.#halfClosing = false;
    const last = held.at(-1);
    // Nothing recognized: the turn falls back to the STT timeout.
    if (!last) return;
    const text = held
      .map((frame) => frame.text.trim())
      .filter(Boolean)
      .join(" ");
    await this.emitSttUsageMetrics();
    await this.pushFrame(
      new TranscriptionFrame({
        text,
        userId: last.userId,
        timestamp: last.timestamp,
        language: last.language,
        result: last.result,
        finalized: true,
      }),
    );
    await this._handleTranscription(text, true, last.language);
  }

  /**
   * Process an audio chunk for STT transcription.
   *
   * @param audio Raw audio bytes to transcribe.
   * @returns An async generator yielding null (actual transcription frames
   *   are pushed via internal processing).
   */
  override async *runStt(audio: Uint8Array): AsyncGenerator<Frame | null, void, unknown> {
    if (this._streamingTask) {
      // Queue the audio data
      await this._requestQueue.put(audio);
    }
    yield null;
  }

  protected async _handleTranscription(
    _transcript: string,
    _isFinal: boolean,
    _language: string | null = null,
  ): Promise<void> {}

  static {
    installTracedStt(GoogleSTTService.prototype, "_handleTranscription");
  }

  /** Process streaming recognition responses. */
  protected async _processResponses(
    streamingRecognize: AsyncIterable<StreamingRecognizeResponse>,
  ): Promise<void> {
    const iterator = streamingRecognize[Symbol.asyncIterator]();
    try {
      while (true) {
        // The response stream is a foreign await: make it a cancellation point.
        const next = await abortable(iterator.next());
        if (next.done) break;
        const response = next.value;

        // Check streaming limit
        if (Math.trunc(time() * 1000) - this._streamStartTime > this.#streamingLimit) {
          logger.debug("Stream timeout reached in response processing");
          break;
        }

        if (!response.results || response.results.length === 0) {
          continue;
        }

        for (const result of response.results) {
          if (!result.alternatives || result.alternatives.length === 0) {
            continue;
          }

          const transcript = result.alternatives[0]?.transcript;
          if (!transcript) {
            continue;
          }

          // Google's language codes are the values Language is built from.
          // With "auto" (language detection), the code Google detected.
          const configured = this._getLanguageCodes()[0];
          const primaryLanguage = (
            configured === "auto" && result.languageCode ? result.languageCode : configured
          ) as Language;

          if (result.isFinal && this.#halfClosing) {
            // finalizeOnVadStop: released as one frame when this stream ends.
            this._lastTranscriptWasFinal = true;
            this.#heldFinals.push(
              new TranscriptionFrame({
                text: transcript,
                userId: this._userId,
                timestamp: timeNowIso8601(),
                language: primaryLanguage,
                result,
                finalized: true,
              }),
            );
          } else if (result.isFinal) {
            this._lastTranscriptWasFinal = true;
            // Report usage before the transcription frame so
            // tracing can attach it to the STT span the frame
            // closes.
            await this.emitSttUsageMetrics();
            await this.pushFrame(
              new TranscriptionFrame({
                text: transcript,
                userId: this._userId,
                timestamp: timeNowIso8601(),
                language: primaryLanguage,
                result,
                finalized: true,
              }),
            );
            await this._handleTranscription(transcript, true, primaryLanguage);
          } else {
            this._lastTranscriptWasFinal = false;
            await this.pushFrame(
              new InterimTranscriptionFrame({
                text: transcript,
                userId: this._userId,
                timestamp: timeNowIso8601(),
                language: primaryLanguage,
                result,
              }),
            );
          }
        }
      }
    } catch (e) {
      rethrowIfCancelled(e);
      if (isAbortedError(e)) {
        // Handle stream abort due to inactivity (409 error).
        // This occurs when no audio is sent to the stream for 10+ seconds,
        // which can happen when InputAudioRawFrames are blocked.
        // Google's STT service automatically closes the stream in this case.
        // We log at DEBUG level (not ERROR) since this is recoverable, then re-raise
        // to trigger automatic reconnection in _streamAudio.
        logger.debug(
          `${this} Stream aborted due to inactivity (no audio input). Reconnecting automatically...`,
        );
        throw e;
      }
      if (isCancelledGrpcError(e)) {
        // The call was cancelled on our side (e.g. a failed request stream,
        // already reported): not a recognition error.
        logger.debug(`${this} Stream cancelled`);
        throw e;
      }
      await this.pushError(`Unknown error occurred: ${errorMessage(e)}`, { exception: e });
      // Re-raise the exception to let it propagate (e.g. in the case of a
      // timeout, propagate to _streamAudio to reconnect)
      throw e;
    } finally {
      // Leaving the loop early (`break`) closes the response stream, as
      // `async for` does upstream.
      await iterator.return?.();
    }
  }
}
