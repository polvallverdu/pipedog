// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/services/google/tts.py

/**
 * Google Cloud Text-to-Speech service implementations.
 *
 * This module provides integration with Google Cloud Text-to-Speech API,
 * offering both HTTP-based synthesis with SSML support and streaming
 * synthesis for real-time applications.
 *
 * It also includes GeminiTTSService which uses Gemini's TTS-specific models
 * for natural voice control and multi-speaker conversations.
 *
 * Porting notes:
 * - Cloud Text-to-Speech (`GoogleHttpTTSService`, `GoogleTTSService` and the
 *   GCP backend of `GeminiTTSService`) goes through the Node SDK
 *   `@google-cloud/text-to-speech` (an optional peer dependency): streaming
 *   synthesis is gRPC only. The SDK is loaded lazily with `import()` on the
 *   first request, so importing this module, and using the GenAI backend of
 *   `GeminiTTSService`, works on every runtime; the Cloud TTS classes need
 *   Node or Bun. The SDK sits behind the small `GoogleCloudTTSClient`
 *   interface, so a custom client can be supplied by overriding
 *   `_createClient()`.
 * - Credentials: `credentials` (a service account JSON string) is parsed at
 *   construction, as upstream does; `credentialsPath` is the SDK's
 *   `keyFilename`. Without either, the SDK resolves Application Default
 *   Credentials on the first request, so a missing credential surfaces as a
 *   synthesis error rather than as upstream's construction-time
 *   `ValueError("No valid credentials provided.")`.
 * - The GenAI backend uses `GoogleGenAI` from `@google/genai` (fetch based).
 *   Its `inlineData.data` is base64 and is decoded here. The JS client owns no
 *   closable session, so `_closeClient()` has nothing to close.
 * - Upstream reports Gemini 3.8 TTS models unusable when the installed Python
 *   SDK lacks `SpeechMetadata`. The JS SDK sends request objects as given, so
 *   that gate never trips here (`GENAI_SUPPORTS_SPEECH_METADATA`).
 * - Deprecated APIs are not ported: the `InputParams` classes, the
 *   `params`, `voiceId` and (Gemini) `model` constructor options, and the
 *   `GoogleStreamTTSSettings` alias.
 * - Upstream sets `GRPC_ENABLE_FORK_SUPPORT=false` at import; there is no
 *   fork in JS, so it is not ported.
 */

import { GoogleGenAI, type HttpOptions } from "@google/genai";
import { abortable, currentSignal, rethrowIfCancelled } from "@pipedog/asyncio";
import {
  type CancelFrame,
  type EndFrame,
  ErrorFrame,
  type Frame,
  type StartFrame,
  TTSAudioRawFrame,
} from "@pipedog/core/frames/frames";
import type { FrameProcessorSetup } from "@pipedog/core/processors/frame_processor";
import { TTSSettings, type TTSSettingsOptions } from "@pipedog/core/services/settings";
import { TTSService, type TTSServiceOptions } from "@pipedog/core/services/tts_service";
import { Language, resolveLanguage } from "@pipedog/core/transcriptions/language";
import { base64ToBytes } from "@pipedog/core/utils/base64";
import { getEnv } from "@pipedog/core/utils/env";
import { ErrorCategory } from "@pipedog/core/utils/errors";
import { logger } from "@pipedog/core/utils/logger";
import { installTracedTts } from "@pipedog/core/utils/tracing/service_decorators";
import { assertGiven, isGiven, NOT_GIVEN, type NotGiven } from "@pipedog/core/utils/types";

/**
 * Whether the GenAI SDK can send `speechMetadata` (needed by Gemini 3.8 TTS
 * models). Upstream checks for `google.genai.types.SpeechMetadata`; the JS SDK
 * passes request objects through, so it always can.
 */
const GENAI_SUPPORTS_SPEECH_METADATA = true;

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** `xml.sax.saxutils.escape`: escape `&`, `<` and `>`. */
function escapeXml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll(">", "&gt;").replaceAll("<", "&lt;");
}

/** Bytes from an SDK field that may be a `Uint8Array` (or Node `Buffer`) or base64. */
function toBytes(data: Uint8Array | string | null | undefined): Uint8Array {
  if (data === null || data === undefined) return new Uint8Array(0);
  if (typeof data === "string") return base64ToBytes(data);
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/** Iterate a foreign async iterable, making every step a cancellation point. */
async function* abortableIter<T>(iterable: AsyncIterable<T>): AsyncGenerator<T, void> {
  const it = iterable[Symbol.asyncIterator]();
  try {
    while (true) {
      const result = await abortable(it.next());
      if (result.done) return;
      yield result.value;
    }
  } finally {
    await it.return?.();
  }
}

/** The parts of a GenAI `GenerateContentResponse` the GenAI backend reads. */
interface GenaiResponseChunk {
  candidates?: {
    content?: { parts?: { inlineData?: { data?: string | Uint8Array } }[] };
  }[];
}

// ---------------------------------------------------------------------------
// Cloud Text-to-Speech client
// ---------------------------------------------------------------------------

/** `texttospeech_v1.VoiceSelectionParams` (camelCase proto fields). */
export interface GoogleVoiceSelectionParams {
  languageCode?: string | null;
  name?: string | null;
  modelName?: string | null;
  voiceClone?: { voiceCloningKey: string };
  multiSpeakerVoiceConfig?: {
    speakerVoiceConfigs: { speakerAlias: string; speakerId: string | null }[];
  };
}

/** `texttospeech_v1.SynthesizeSpeechRequest`. */
export interface GoogleSynthesizeSpeechRequest {
  input: { text?: string; ssml?: string };
  voice: GoogleVoiceSelectionParams;
  audioConfig: {
    audioEncoding: "LINEAR16" | "PCM" | string;
    sampleRateHertz?: number;
    speakingRate?: number;
  };
}

/** `texttospeech_v1.StreamingSynthesizeConfig`. */
export interface GoogleStreamingSynthesizeConfig {
  voice: GoogleVoiceSelectionParams;
  streamingAudioConfig: {
    audioEncoding: "PCM" | string;
    sampleRateHertz?: number;
    speakingRate?: number;
  };
}

/** `texttospeech_v1.StreamingSynthesizeRequest`. */
export type GoogleStreamingSynthesizeRequest =
  | { streamingConfig: GoogleStreamingSynthesizeConfig }
  | { input: { text: string; prompt?: string } };

/** A response carrying audio (`SynthesizeSpeechResponse` / `StreamingSynthesizeResponse`). */
export interface GoogleAudioResponse {
  audioContent?: Uint8Array | string | null;
}

/**
 * The Cloud Text-to-Speech operations these services use. The default
 * implementation wraps `TextToSpeechClient` from
 * `@google-cloud/text-to-speech`.
 */
export interface GoogleCloudTTSClient {
  /** Unary synthesis (`synthesize_speech`). */
  synthesizeSpeech(request: GoogleSynthesizeSpeechRequest): Promise<GoogleAudioResponse>;
  /** Bidirectional streaming synthesis (`streaming_synthesize`). */
  streamingSynthesize(
    requests: AsyncIterable<GoogleStreamingSynthesizeRequest>,
  ): Promise<AsyncIterable<GoogleAudioResponse>>;
}

/** Options for `createGoogleCloudTTSClient`. */
export interface GoogleCloudTTSClientOptions {
  /** Parsed service account credentials. */
  credentials?: Record<string, unknown> | null;
  /** Path to a service account JSON file. */
  keyFilename?: string | null;
  /** Regional API endpoint, e.g. `us-central1-texttospeech.googleapis.com`. */
  apiEndpoint?: string | null;
  /**
   * Extra options for the SDK's `TextToSpeechClient` (e.g. `apiEndpoint`,
   * `port`, `sslCreds`), merged over the ones above.
   */
  clientOptions?: Record<string, unknown> | null;
  /**
   * The `@google-cloud/text-to-speech` module (`import * as textToSpeech from
   * "@google-cloud/text-to-speech"`), instead of importing it by name on the first request.
   * A bundler (`bun build`) cannot see an import by name, so a bundled app imports the SDK
   * itself and passes it here.
   *
   * DIVERGENCE: pipedog-only.
   */
  module?: GoogleTextToSpeechModule | null;
}

/** The part of `@google-cloud/text-to-speech` the services use: its v1 `TextToSpeechClient`. */
export interface GoogleTextToSpeechModule {
  v1: { TextToSpeechClient: new (options: any) => any };
}

// A variable specifier keeps the Node-only SDK out of bundles and static
// import graphs (Workers); it is only loaded when a Cloud TTS request runs.
const TEXT_TO_SPEECH_SDK = "@google-cloud/text-to-speech";

interface NodeTextToSpeechStream extends AsyncIterable<GoogleAudioResponse> {
  write(request: unknown): boolean;
  end(): void;
  cancel?(): void;
  destroy?(error?: Error): void;
  once?(event: "close", listener: () => void): unknown;
}

interface NodeTextToSpeechClient {
  synthesizeSpeech(request: unknown): Promise<[GoogleAudioResponse, ...unknown[]]>;
  streamingSynthesize(): NodeTextToSpeechStream;
}

interface NodeTextToSpeechModule {
  v1: { TextToSpeechClient: new (opts: object) => NodeTextToSpeechClient };
}

/**
 * Create a Cloud Text-to-Speech client backed by `@google-cloud/text-to-speech`.
 * The SDK is imported, and the client built, on the first request.
 */
export function createGoogleCloudTTSClient(
  options: GoogleCloudTTSClientOptions = {},
): GoogleCloudTTSClient {
  let client: Promise<NodeTextToSpeechClient> | null = null;

  const getClient = (): Promise<NodeTextToSpeechClient> => {
    client ??= (async () => {
      let sdk: NodeTextToSpeechModule;
      try {
        const mod = (options.module ??
          (await import(/* @vite-ignore */ TEXT_TO_SPEECH_SDK))) as NodeTextToSpeechModule & {
          default?: NodeTextToSpeechModule;
        };
        // A CommonJS package: its exports may only be reachable as `default`.
        sdk = mod.v1 ? mod : (mod.default as NodeTextToSpeechModule);
      } catch (e) {
        rethrowIfCancelled(e);
        logger.error(`Exception: ${errorMessage(e)}`);
        logger.error(
          "In order to use Google Cloud Text-to-Speech, you need to install " +
            "`@google-cloud/text-to-speech`. Also, set `GOOGLE_APPLICATION_CREDENTIALS` environment variable. " +
            "In a bundled app (bun build) it is not found by name: import it yourself " +
            "(`import * as textToSpeechModule`) and pass `textToSpeechModule` to the service.",
        );
        throw new Error(`Missing module: ${TEXT_TO_SPEECH_SDK}`, { cause: e });
      }
      const clientOptions: Record<string, unknown> = {
        scopes: ["https://www.googleapis.com/auth/cloud-platform"],
      };
      if (options.credentials) clientOptions.credentials = options.credentials;
      if (options.keyFilename) clientOptions.keyFilename = options.keyFilename;
      if (options.apiEndpoint) clientOptions.apiEndpoint = options.apiEndpoint;
      Object.assign(clientOptions, options.clientOptions);
      return new sdk.v1.TextToSpeechClient(clientOptions);
    })();
    // Retry the import / construction on the next request if it failed.
    client.catch(() => {
      client = null;
    });
    return client;
  };

  return {
    async synthesizeSpeech(request) {
      const c = await abortable(getClient());
      const [response] = await abortable(c.synthesizeSpeech(request));
      return response;
    },
    async streamingSynthesize(requests) {
      const c = await abortable(getClient());
      const stream = c.streamingSynthesize();
      // Cancelling the task that reads the responses cancels the call. The
      // listener goes away with the call, so a long-lived task (the
      // service's) doesn't collect one per utterance.
      const signal = currentSignal();
      const onAbort = () => stream.cancel?.();
      signal.addEventListener("abort", onAbort, { once: true });
      stream.once?.("close", () => signal.removeEventListener("abort", onAbort));
      // Feed the requests as gRPC consumes the request iterator upstream. This
      // never rejects: a failing iterator fails the call instead.
      // (Any error, cancellation included, just fails the call, so this is a
      // rejection handler rather than a catch that would have to re-raise.)
      const pump = async () => {
        for await (const request of requests) stream.write(request);
        stream.end();
      };
      void pump().then(undefined, (e: unknown) => {
        stream.destroy?.(e instanceof Error ? e : new Error(String(e)));
      });
      return stream;
    },
  };
}

// ---------------------------------------------------------------------------
// Language maps
// ---------------------------------------------------------------------------

/**
 * Convert a Language value to Google TTS language code.
 *
 * Source: https://docs.cloud.google.com/text-to-speech/docs/chirp3-hd
 *
 * @param language The Language value to convert.
 * @returns The corresponding service language code. If `language` is not in
 *   the verified mapping, falls back to the full language code string and
 *   logs a warning (via `resolveLanguage(..., useBaseCode = false)`).
 */
export function languageToGoogleTtsLanguage(language: Language): string {
  const LANGUAGE_MAP: Partial<Record<Language, string>> = {
    // Arabic
    [Language.AR]: "ar-XA",
    // Bengali
    [Language.BN]: "bn-IN",
    [Language.BN_IN]: "bn-IN",
    // Bulgarian
    [Language.BG]: "bg-BG",
    [Language.BG_BG]: "bg-BG",
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
    [Language.NL]: "nl-NL",
    [Language.NL_BE]: "nl-BE",
    [Language.NL_NL]: "nl-NL",
    // English
    [Language.EN]: "en-US",
    [Language.EN_US]: "en-US",
    [Language.EN_AU]: "en-AU",
    [Language.EN_GB]: "en-GB",
    [Language.EN_IN]: "en-IN",
    // Estonian
    [Language.ET]: "et-EE",
    [Language.ET_EE]: "et-EE",
    // Finnish
    [Language.FI]: "fi-FI",
    [Language.FI_FI]: "fi-FI",
    // French
    [Language.FR]: "fr-FR",
    [Language.FR_CA]: "fr-CA",
    [Language.FR_FR]: "fr-FR",
    // German
    [Language.DE]: "de-DE",
    [Language.DE_DE]: "de-DE",
    // Greek
    [Language.EL]: "el-GR",
    [Language.EL_GR]: "el-GR",
    // Gujarati
    [Language.GU]: "gu-IN",
    [Language.GU_IN]: "gu-IN",
    // Hebrew
    [Language.HE]: "he-IL",
    [Language.HE_IL]: "he-IL",
    // Hindi
    [Language.HI]: "hi-IN",
    [Language.HI_IN]: "hi-IN",
    // Hungarian
    [Language.HU]: "hu-HU",
    [Language.HU_HU]: "hu-HU",
    // Indonesian
    [Language.ID]: "id-ID",
    [Language.ID_ID]: "id-ID",
    // Italian
    [Language.IT]: "it-IT",
    [Language.IT_IT]: "it-IT",
    // Japanese
    [Language.JA]: "ja-JP",
    [Language.JA_JP]: "ja-JP",
    // Kannada
    [Language.KN]: "kn-IN",
    [Language.KN_IN]: "kn-IN",
    // Korean
    [Language.KO]: "ko-KR",
    [Language.KO_KR]: "ko-KR",
    // Latvian
    [Language.LV]: "lv-LV",
    [Language.LV_LV]: "lv-LV",
    // Lithuanian
    [Language.LT]: "lt-LT",
    [Language.LT_LT]: "lt-LT",
    // Malayalam
    [Language.ML]: "ml-IN",
    [Language.ML_IN]: "ml-IN",
    // Chinese (Mandarin)
    [Language.ZH]: "cmn-CN",
    [Language.ZH_CN]: "cmn-CN",
    // Marathi
    [Language.MR]: "mr-IN",
    [Language.MR_IN]: "mr-IN",
    // Norwegian
    [Language.NO]: "nb-NO",
    [Language.NB]: "nb-NO",
    [Language.NB_NO]: "nb-NO",
    // Polish
    [Language.PL]: "pl-PL",
    [Language.PL_PL]: "pl-PL",
    // Portuguese
    [Language.PT]: "pt-BR",
    [Language.PT_BR]: "pt-BR",
    // Romanian
    [Language.RO]: "ro-RO",
    [Language.RO_RO]: "ro-RO",
    // Russian
    [Language.RU]: "ru-RU",
    [Language.RU_RU]: "ru-RU",
    // Serbian
    [Language.SR]: "sr-RS",
    [Language.SR_RS]: "sr-RS",
    // Slovak
    [Language.SK]: "sk-SK",
    [Language.SK_SK]: "sk-SK",
    // Slovenian
    [Language.SL]: "sl-SI",
    [Language.SL_SI]: "sl-SI",
    // Spanish
    [Language.ES]: "es-ES",
    [Language.ES_ES]: "es-ES",
    [Language.ES_US]: "es-US",
    // Swahili
    [Language.SW]: "sw-KE",
    [Language.SW_KE]: "sw-KE",
    // Swedish
    [Language.SV]: "sv-SE",
    [Language.SV_SE]: "sv-SE",
    // Tamil
    [Language.TA]: "ta-IN",
    [Language.TA_IN]: "ta-IN",
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
    [Language.UR]: "ur-IN",
    [Language.UR_IN]: "ur-IN",
    // Vietnamese
    [Language.VI]: "vi-VN",
    [Language.VI_VN]: "vi-VN",
  };

  return resolveLanguage(language, LANGUAGE_MAP, false);
}

/**
 * Convert a Language value to Gemini TTS language code.
 *
 * Source: https://docs.cloud.google.com/text-to-speech/docs/gemini-tts#available_languages
 *
 * @param language The Language value to convert.
 * @returns The corresponding service language code. If `language` is not in
 *   the verified mapping, falls back to the full language code string and
 *   logs a warning (via `resolveLanguage(..., useBaseCode = false)`).
 */
export function languageToGeminiTtsLanguage(language: Language): string {
  const LANGUAGE_MAP: Partial<Record<Language, string>> = {
    // Afrikaans (Preview)
    [Language.AF]: "af-ZA",
    [Language.AF_ZA]: "af-ZA",
    // Albanian (Preview)
    [Language.SQ]: "sq-AL",
    [Language.SQ_AL]: "sq-AL",
    // Amharic (Preview)
    [Language.AM]: "am-ET",
    [Language.AM_ET]: "am-ET",
    // Arabic
    [Language.AR]: "ar-EG", // GA: Egypt
    [Language.AR_EG]: "ar-EG",
    [Language.AR_001]: "ar-001", // Preview: World
    // Armenian (Preview)
    [Language.HY]: "hy-AM",
    [Language.HY_AM]: "hy-AM",
    // Azerbaijani (Preview)
    [Language.AZ]: "az-AZ",
    [Language.AZ_AZ]: "az-AZ",
    // Basque (Preview)
    [Language.EU]: "eu-ES",
    [Language.EU_ES]: "eu-ES",
    // Belarusian (Preview)
    [Language.BE]: "be-BY",
    [Language.BE_BY]: "be-BY",
    // Bengali (GA)
    [Language.BN]: "bn-BD",
    [Language.BN_BD]: "bn-BD",
    // Bulgarian (Preview)
    [Language.BG]: "bg-BG",
    [Language.BG_BG]: "bg-BG",
    // Burmese (Preview)
    [Language.MY]: "my-MM",
    [Language.MY_MM]: "my-MM",
    // Catalan (Preview)
    [Language.CA]: "ca-ES",
    [Language.CA_ES]: "ca-ES",
    // Cebuano (Preview)
    [Language.CEB]: "ceb-PH",
    [Language.CEB_PH]: "ceb-PH",
    // Chinese (Mandarin)
    [Language.ZH]: "cmn-CN", // Preview
    [Language.ZH_CN]: "cmn-CN",
    [Language.ZH_TW]: "cmn-TW", // Preview
    // Croatian (Preview)
    [Language.HR]: "hr-HR",
    [Language.HR_HR]: "hr-HR",
    // Czech (Preview)
    [Language.CS]: "cs-CZ",
    [Language.CS_CZ]: "cs-CZ",
    // Danish (Preview)
    [Language.DA]: "da-DK",
    [Language.DA_DK]: "da-DK",
    // Dutch (GA)
    [Language.NL]: "nl-NL",
    [Language.NL_NL]: "nl-NL",
    // English
    [Language.EN]: "en-US", // GA
    [Language.EN_US]: "en-US",
    [Language.EN_AU]: "en-AU", // Preview
    [Language.EN_GB]: "en-GB", // Preview
    [Language.EN_IN]: "en-IN", // GA
    // Estonian (Preview)
    [Language.ET]: "et-EE",
    [Language.ET_EE]: "et-EE",
    // Filipino (Preview)
    [Language.FIL]: "fil-PH",
    [Language.FIL_PH]: "fil-PH",
    // Finnish (Preview)
    [Language.FI]: "fi-FI",
    [Language.FI_FI]: "fi-FI",
    // French
    [Language.FR]: "fr-FR", // GA
    [Language.FR_FR]: "fr-FR",
    [Language.FR_CA]: "fr-CA", // Preview
    // Galician (Preview)
    [Language.GL]: "gl-ES",
    [Language.GL_ES]: "gl-ES",
    // Georgian (Preview)
    [Language.KA]: "ka-GE",
    [Language.KA_GE]: "ka-GE",
    // German (GA)
    [Language.DE]: "de-DE",
    [Language.DE_DE]: "de-DE",
    // Greek (Preview)
    [Language.EL]: "el-GR",
    [Language.EL_GR]: "el-GR",
    // Gujarati (Preview)
    [Language.GU]: "gu-IN",
    [Language.GU_IN]: "gu-IN",
    // Haitian Creole (Preview)
    [Language.HT]: "ht-HT",
    [Language.HT_HT]: "ht-HT",
    // Hebrew (Preview)
    [Language.HE]: "he-IL",
    [Language.HE_IL]: "he-IL",
    // Hindi (GA)
    [Language.HI]: "hi-IN",
    [Language.HI_IN]: "hi-IN",
    // Hungarian (Preview)
    [Language.HU]: "hu-HU",
    [Language.HU_HU]: "hu-HU",
    // Icelandic (Preview)
    [Language.IS]: "is-IS",
    [Language.IS_IS]: "is-IS",
    // Indonesian (GA)
    [Language.ID]: "id-ID",
    [Language.ID_ID]: "id-ID",
    // Italian (GA)
    [Language.IT]: "it-IT",
    [Language.IT_IT]: "it-IT",
    // Japanese (GA)
    [Language.JA]: "ja-JP",
    [Language.JA_JP]: "ja-JP",
    // Javanese (Preview)
    [Language.JV]: "jv-JV",
    [Language.JV_JV]: "jv-JV",
    // Kannada (Preview)
    [Language.KN]: "kn-IN",
    [Language.KN_IN]: "kn-IN",
    // Konkani (Preview)
    [Language.KOK]: "kok-IN",
    [Language.KOK_IN]: "kok-IN",
    // Korean (GA)
    [Language.KO]: "ko-KR",
    [Language.KO_KR]: "ko-KR",
    // Lao (Preview)
    [Language.LO]: "lo-LA",
    [Language.LO_LA]: "lo-LA",
    // Latin (Preview)
    [Language.LA]: "la-VA",
    [Language.LA_VA]: "la-VA",
    // Latvian (Preview)
    [Language.LV]: "lv-LV",
    [Language.LV_LV]: "lv-LV",
    // Lithuanian (Preview)
    [Language.LT]: "lt-LT",
    [Language.LT_LT]: "lt-LT",
    // Luxembourgish (Preview)
    [Language.LB]: "lb-LU",
    [Language.LB_LU]: "lb-LU",
    // Macedonian (Preview)
    [Language.MK]: "mk-MK",
    [Language.MK_MK]: "mk-MK",
    // Maithili (Preview)
    [Language.MAI]: "mai-IN",
    [Language.MAI_IN]: "mai-IN",
    // Malagasy (Preview)
    [Language.MG]: "mg-MG",
    [Language.MG_MG]: "mg-MG",
    // Malay (Preview)
    [Language.MS]: "ms-MY",
    [Language.MS_MY]: "ms-MY",
    // Malayalam (Preview)
    [Language.ML]: "ml-IN",
    [Language.ML_IN]: "ml-IN",
    // Marathi (GA)
    [Language.MR]: "mr-IN",
    [Language.MR_IN]: "mr-IN",
    // Mongolian (Preview)
    [Language.MN]: "mn-MN",
    [Language.MN_MN]: "mn-MN",
    // Nepali (Preview)
    [Language.NE]: "ne-NP",
    [Language.NE_NP]: "ne-NP",
    // Norwegian
    [Language.NO]: "nb-NO", // Preview: Bokmål
    [Language.NB]: "nb-NO",
    [Language.NB_NO]: "nb-NO",
    [Language.NN]: "nn-NO", // Preview: Nynorsk
    [Language.NN_NO]: "nn-NO",
    // Odia (Preview)
    [Language.OR]: "or-IN",
    [Language.OR_IN]: "or-IN",
    // Pashto (Preview)
    [Language.PS]: "ps-AF",
    [Language.PS_AF]: "ps-AF",
    // Persian (Preview)
    [Language.FA]: "fa-IR",
    [Language.FA_IR]: "fa-IR",
    // Polish (GA)
    [Language.PL]: "pl-PL",
    [Language.PL_PL]: "pl-PL",
    // Portuguese
    [Language.PT]: "pt-BR", // GA: Brazil
    [Language.PT_BR]: "pt-BR",
    [Language.PT_PT]: "pt-PT", // Preview: Portugal
    // Punjabi (Preview)
    [Language.PA]: "pa-IN",
    [Language.PA_IN]: "pa-IN",
    // Romanian (GA)
    [Language.RO]: "ro-RO",
    [Language.RO_RO]: "ro-RO",
    // Russian (GA)
    [Language.RU]: "ru-RU",
    [Language.RU_RU]: "ru-RU",
    // Serbian (Preview)
    [Language.SR]: "sr-RS",
    [Language.SR_RS]: "sr-RS",
    // Sindhi (Preview)
    [Language.SD]: "sd-IN",
    [Language.SD_IN]: "sd-IN",
    // Sinhala (Preview)
    [Language.SI]: "si-LK",
    [Language.SI_LK]: "si-LK",
    // Slovak (Preview)
    [Language.SK]: "sk-SK",
    [Language.SK_SK]: "sk-SK",
    // Slovenian (Preview)
    [Language.SL]: "sl-SI",
    [Language.SL_SI]: "sl-SI",
    // Spanish
    [Language.ES]: "es-ES", // GA
    [Language.ES_ES]: "es-ES",
    [Language.ES_419]: "es-419", // Preview: Latin America
    [Language.ES_MX]: "es-MX", // Preview: Mexico
    // Swahili (Preview)
    [Language.SW]: "sw-KE",
    [Language.SW_KE]: "sw-KE",
    // Swedish (Preview)
    [Language.SV]: "sv-SE",
    [Language.SV_SE]: "sv-SE",
    // Tamil (GA)
    [Language.TA]: "ta-IN",
    [Language.TA_IN]: "ta-IN",
    // Telugu (GA)
    [Language.TE]: "te-IN",
    [Language.TE_IN]: "te-IN",
    // Thai (GA)
    [Language.TH]: "th-TH",
    [Language.TH_TH]: "th-TH",
    // Turkish (GA)
    [Language.TR]: "tr-TR",
    [Language.TR_TR]: "tr-TR",
    // Ukrainian (GA)
    [Language.UK]: "uk-UA",
    [Language.UK_UA]: "uk-UA",
    // Urdu (Preview)
    [Language.UR]: "ur-PK",
    [Language.UR_PK]: "ur-PK",
    // Vietnamese (GA)
    [Language.VI]: "vi-VN",
    [Language.VI_VN]: "vi-VN",
  };

  return resolveLanguage(language, LANGUAGE_MAP, false);
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export interface GoogleHttpTTSSettingsOptions extends TTSSettingsOptions {
  /** Voice pitch adjustment (e.g., "+2st", "-50%"). */
  pitch?: string | null | NotGiven;
  /**
   * Speaking rate adjustment (e.g., "slow", "fast", "125%"). Used for SSML
   * prosody tags (non-Chirp voices).
   */
  rate?: string | null | NotGiven;
  /** Speaking rate for AudioConfig (Chirp/Journey voices). Range [0.25, 2.0]. */
  speakingRate?: number | null | NotGiven;
  /** Volume adjustment (e.g., "loud", "soft", "+6dB"). */
  volume?: string | null | NotGiven;
  /** Emphasis level for the text. */
  emphasis?: "strong" | "moderate" | "reduced" | "none" | null | NotGiven;
  /** Voice gender preference. */
  gender?: "male" | "female" | "neutral" | null | NotGiven;
  /** Google-specific voice style. */
  googleStyle?: "apologetic" | "calm" | "empathetic" | "firm" | "lively" | null | NotGiven;
}

/**
 * Settings for GoogleHttpTTSService.
 *
 * - `pitch`: voice pitch adjustment (e.g., "+2st", "-50%").
 * - `rate`: speaking rate adjustment (e.g., "slow", "fast", "125%"). Used for
 *   SSML prosody tags (non-Chirp voices).
 * - `speakingRate`: speaking rate for AudioConfig (Chirp/Journey voices).
 *   Range [0.25, 2.0].
 * - `volume`: volume adjustment (e.g., "loud", "soft", "+6dB").
 * - `emphasis`: emphasis level for the text.
 * - `gender`: voice gender preference.
 * - `googleStyle`: Google-specific voice style.
 */
export class GoogleHttpTTSSettings extends TTSSettings {
  pitch: string | null | NotGiven = NOT_GIVEN;
  rate: string | null | NotGiven = NOT_GIVEN;
  speakingRate: number | null | NotGiven = NOT_GIVEN;
  volume: string | null | NotGiven = NOT_GIVEN;
  emphasis: "strong" | "moderate" | "reduced" | "none" | null | NotGiven = NOT_GIVEN;
  gender: "male" | "female" | "neutral" | null | NotGiven = NOT_GIVEN;
  googleStyle: "apologetic" | "calm" | "empathetic" | "firm" | "lively" | null | NotGiven =
    NOT_GIVEN;

  constructor(options: GoogleHttpTTSSettingsOptions = {}) {
    super(options);
    this._assignOptions(options);
  }
}

export interface GoogleTTSSettingsOptions extends TTSSettingsOptions {
  /** The speaking rate, in the range [0.25, 2.0]. */
  speakingRate?: number | null | NotGiven;
}

/**
 * Settings for GoogleTTSService.
 *
 * - `speakingRate`: the speaking rate, in the range [0.25, 2.0].
 */
export class GoogleTTSSettings extends TTSSettings {
  speakingRate: number | null | NotGiven = NOT_GIVEN;

  constructor(options: GoogleTTSSettingsOptions = {}) {
    super(options);
    this._assignOptions(options);
  }
}

/** A speaker configuration for Gemini multi-speaker mode. */
export type GeminiSpeakerConfig = Record<string, unknown>;

export interface GeminiTTSSettingsOptions extends TTSSettingsOptions {
  /**
   * Optional style instructions for how to synthesize the content. Supported
   * on the GCP backend, and on the Gemini API backend by Gemini 3.8 TTS
   * models (sent as a `speechMetadata.style` annotation); older models on
   * the Gemini API backend ignore it with a warning.
   */
  prompt?: string | null | NotGiven;
  /** Whether to enable multi-speaker support (GCP backend only). */
  multiSpeaker?: boolean | NotGiven;
  /** List of speaker configurations for multi-speaker mode. */
  speakerConfigs?: GeminiSpeakerConfig[] | null | NotGiven;
}

/**
 * Settings for GeminiTTSService.
 *
 * - `prompt`: optional style instructions for how to synthesize the content.
 *   Supported on the GCP backend, and on the Gemini API backend by Gemini 3.8
 *   TTS models (sent as a `speechMetadata.style` annotation); older models on
 *   the Gemini API backend ignore it with a warning.
 * - `multiSpeaker`: whether to enable multi-speaker support (GCP backend
 *   only).
 * - `speakerConfigs`: list of speaker configurations for multi-speaker mode
 *   (`{ speaker_alias, speaker_id? }`).
 */
export class GeminiTTSSettings extends TTSSettings {
  prompt: string | null | NotGiven = NOT_GIVEN;
  multiSpeaker: boolean | NotGiven = NOT_GIVEN;
  speakerConfigs: GeminiSpeakerConfig[] | null | NotGiven = NOT_GIVEN;

  constructor(options: GeminiTTSSettingsOptions = {}) {
    super(options);
    this._assignOptions(options);
  }
}

/**
 * Build the Cloud TTS client options from the credential arguments.
 *
 * @param credentials JSON string with service account credentials.
 * @param credentialsPath Path to service account JSON file.
 * @param location Google Cloud location for the regional endpoint.
 */
function cloudTTSClientOptions(
  credentials: string | null,
  credentialsPath: string | null,
  location: string | null,
  clientOptions: Record<string, unknown> | null = null,
  module: GoogleTextToSpeechModule | null = null,
): GoogleCloudTTSClientOptions {
  const options: GoogleCloudTTSClientOptions = { clientOptions, module };

  if (credentials) {
    // Use provided credentials JSON string
    options.credentials = JSON.parse(credentials) as Record<string, unknown>;
  } else if (credentialsPath) {
    // Use service account JSON file if provided
    options.keyFilename = credentialsPath;
  }
  // Otherwise the SDK uses Application Default Credentials.

  if (location) {
    options.apiEndpoint = `${location}-texttospeech.googleapis.com`;
  }

  return options;
}

// ---------------------------------------------------------------------------
// GoogleHttpTTSService
// ---------------------------------------------------------------------------

export interface GoogleHttpTTSServiceOptions extends TTSServiceOptions {
  /** JSON string containing Google Cloud service account credentials. */
  credentials?: string | null;
  /** Path to Google Cloud service account JSON file. */
  credentialsPath?: string | null;
  /** Google Cloud location for regional endpoint (e.g., "us-central1"). */
  location?: string | null;
  /**
   * Extra options for the `@google-cloud/text-to-speech` `TextToSpeechClient`
   * (e.g. `apiEndpoint`, `port`, `sslCreds`), merged over the ones derived
   * from `location` and the credentials.
   *
   * DIVERGENCE: pipedog-only. Upstream builds its client from `location` and
   * the credentials alone.
   */
  clientOptions?: Record<string, unknown> | null;
  /** The `@google-cloud/text-to-speech` module, for a bundled app: see `GoogleCloudTTSClientOptions.module`. */
  textToSpeechModule?: GoogleTextToSpeechModule | null;
  /** Runtime-updatable settings. */
  settings?: GoogleHttpTTSSettings | null;
}

/**
 * Google Cloud Text-to-Speech HTTP service with SSML support.
 *
 * Provides text-to-speech synthesis using Google Cloud's HTTP API with
 * comprehensive SSML support for voice customization, prosody control, and
 * styling options. Ideal for applications requiring fine-grained control over
 * speech output.
 *
 * Note: requires Google Cloud credentials via service account JSON,
 * credentials file, or default application credentials
 * (GOOGLE_APPLICATION_CREDENTIALS). Chirp and Journey voices don't support
 * SSML and will use plain text input.
 */
export class GoogleHttpTTSService extends TTSService {
  static Settings = GoogleHttpTTSSettings;
  declare protected _settings: GoogleHttpTTSSettings;

  static {
    installTracedTts(GoogleHttpTTSService.prototype, "runTts");
  }

  protected _location: string | null;
  protected _clientOptions: Record<string, unknown> | null = null;
  protected _textToSpeechModule: GoogleTextToSpeechModule | null = null;
  protected _client: GoogleCloudTTSClient;

  /**
   * Initializes the Google HTTP TTS service.
   *
   * @param options.credentials JSON string containing Google Cloud service
   *   account credentials.
   * @param options.credentialsPath Path to Google Cloud service account JSON
   *   file.
   * @param options.location Google Cloud location for regional endpoint
   *   (e.g., "us-central1").
   * @param options.sampleRate Audio sample rate in Hz. If null, uses default.
   * @param options.settings Runtime-updatable settings.
   *   Other options are passed to the parent TTSService.
   */
  constructor(options: GoogleHttpTTSServiceOptions = {}) {
    // 1. Initialize defaultSettings with hardcoded defaults
    const defaultSettings = new GoogleHttpTTSSettings({
      model: null,
      voice: "en-US-Chirp3-HD-Charon",
      language: "en-US",
      pitch: null,
      rate: null,
      speakingRate: null,
      volume: null,
      emphasis: null,
      gender: null,
      googleStyle: null,
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

    this._location = options.location ?? null;
    this._clientOptions = options.clientOptions ?? null;
    this._textToSpeechModule = options.textToSpeechModule ?? null;
    this._client = this._createClient(options.credentials ?? null, options.credentialsPath ?? null);
  }

  /**
   * Create authenticated Google Text-to-Speech client.
   *
   * @param credentials JSON string with service account credentials.
   * @param credentialsPath Path to service account JSON file.
   * @returns Authenticated Text-to-Speech client.
   */
  protected _createClient(
    credentials: string | null,
    credentialsPath: string | null,
  ): GoogleCloudTTSClient {
    return createGoogleCloudTTSClient(
      cloudTTSClientOptions(
        credentials,
        credentialsPath,
        this._location,
        this._clientOptions,
        this._textToSpeechModule,
      ),
    );
  }

  /**
   * Check if this service can generate processing metrics.
   *
   * @returns True, as Google HTTP TTS service supports metrics generation.
   */
  override canGenerateMetrics(): boolean {
    return true;
  }

  /**
   * Convert a Language value to Google TTS language format.
   *
   * @param language The language to convert.
   * @returns The Google TTS-specific language code, or null if not supported.
   */
  override languageToServiceLanguage(language: Language): string | null {
    return languageToGoogleTtsLanguage(language);
  }

  /**
   * Override to handle speakingRate validation.
   *
   * @param delta Settings delta. Can include `speakingRate` (number).
   */
  protected override async _updateSettings(delta: TTSSettings): Promise<Record<string, unknown>> {
    if (
      delta instanceof GoogleHttpTTSSettings &&
      isGiven(delta.speakingRate) &&
      delta.speakingRate !== null // null == "up to Google"; no check needed
    ) {
      const rateValue = Number(delta.speakingRate);
      if (!(rateValue >= 0.25 && rateValue <= 2.0)) {
        logger.warning(`Invalid speaking_rate value: ${rateValue}. Must be between 0.25 and 2.0`);
        delta.speakingRate = NOT_GIVEN;
      }
    }
    return await super._updateSettings(delta);
  }

  protected _constructSsml(text: string): string {
    let ssml = "<speak>";

    // Voice tag
    const voiceAttrs = [`name='${this._settings.voice}'`];

    const language = this._settings.language;
    voiceAttrs.push(`language='${language}'`);

    if (this._settings.gender) {
      voiceAttrs.push(`gender='${this._settings.gender}'`);
    }
    ssml += `<voice ${voiceAttrs.join(" ")}>`;

    // Prosody tag
    const prosodyAttrs: string[] = [];
    if (this._settings.pitch) {
      prosodyAttrs.push(`pitch='${this._settings.pitch}'`);
    }
    if (this._settings.rate) {
      prosodyAttrs.push(`rate='${this._settings.rate}'`);
    }
    if (this._settings.volume) {
      prosodyAttrs.push(`volume='${this._settings.volume}'`);
    }

    if (prosodyAttrs.length > 0) {
      ssml += `<prosody ${prosodyAttrs.join(" ")}>`;
    }

    // Emphasis tag
    if (this._settings.emphasis) {
      ssml += `<emphasis level='${this._settings.emphasis}'>`;
    }

    // Google style tag
    if (this._settings.googleStyle) {
      ssml += `<google:style name='${this._settings.googleStyle}'>`;
    }

    ssml += escapeXml(text);

    // Close tags
    if (this._settings.googleStyle) {
      ssml += "</google:style>";
    }
    if (this._settings.emphasis) {
      ssml += "</emphasis>";
    }
    if (prosodyAttrs.length > 0) {
      ssml += "</prosody>";
    }
    ssml += "</voice></speak>";

    return ssml;
  }

  /**
   * Generate speech from text using Google's HTTP TTS API.
   *
   * @param text The text to synthesize into speech.
   * @param contextId The context ID for tracking audio frames.
   * @returns Audio frames containing the synthesized speech.
   */
  override async *runTts(text: string, contextId: string): AsyncGenerator<Frame, void> {
    try {
      // Check if the voice is a Chirp voice (including Chirp 3) or Journey voice
      const voiceName = assertGiven(this._settings.voice);
      const isChirpVoice = (voiceName ?? "").toLowerCase().includes("chirp");
      const isJourneyVoice = (voiceName ?? "").toLowerCase().includes("journey");

      // Create synthesis input based on voice
      let synthesisInput: GoogleSynthesizeSpeechRequest["input"];
      if (isChirpVoice || isJourneyVoice) {
        // Chirp and Journey voices don't support SSML, use plain text
        synthesisInput = { text };
      } else {
        const ssml = this._constructSsml(text);
        synthesisInput = { ssml };
      }

      const voice: GoogleVoiceSelectionParams = {
        languageCode: this._settings.language as string | null,
        name: this._settings.voice as string | null,
      };
      // Build audio config with conditional speakingRate
      const audioConfig: GoogleSynthesizeSpeechRequest["audioConfig"] = {
        audioEncoding: "LINEAR16",
        sampleRateHertz: this.sampleRate,
      };

      // For Chirp and Journey voices, include speakingRate in AudioConfig
      const speakingRate = this._settings.speakingRate;
      if ((isChirpVoice || isJourneyVoice) && speakingRate !== null && isGiven(speakingRate)) {
        audioConfig.speakingRate = speakingRate;
      }

      const request: GoogleSynthesizeSpeechRequest = { input: synthesisInput, voice, audioConfig };

      const response = await this._client.synthesizeSpeech(request);

      await this.startTtsUsageMetrics(text);

      // Skip the first 44 bytes to remove the WAV header
      const audioContent = toBytes(response.audioContent).subarray(44);

      const CHUNK_SIZE = this.chunkSize;

      for (let i = 0; i < audioContent.length; i += CHUNK_SIZE) {
        const chunk = audioContent.subarray(i, i + CHUNK_SIZE);
        if (chunk.length === 0) {
          break;
        }
        await this.stopTtfbMetrics();
        const frame = new TTSAudioRawFrame({
          audio: chunk,
          sampleRate: this.sampleRate,
          numChannels: 1,
          contextId,
        });
        yield frame;
      }
    } catch (e) {
      rethrowIfCancelled(e);
      const errorMessageText = `TTS generation error: ${errorMessage(e)}`;
      yield new ErrorFrame({ error: errorMessageText });
    }
  }
}

// ---------------------------------------------------------------------------
// GoogleBaseTTSService
// ---------------------------------------------------------------------------

/**
 * Base class for Google Cloud Text-to-Speech streaming services.
 *
 * Provides shared streaming synthesis logic for Google TTS services. This is
 * an abstract base class. Use GoogleTTSService or GeminiTTSService instead.
 */
export abstract class GoogleBaseTTSService extends TTSService {
  protected _location: string | null = null;
  protected _clientOptions: Record<string, unknown> | null = null;
  protected _textToSpeechModule: GoogleTextToSpeechModule | null = null;

  // Subclasses build the client in their constructor. Gemini can run against
  // the GenAI API instead of GCP, so each backend's code path casts to the
  // client it holds.
  protected _client!: GoogleCloudTTSClient | GoogleGenAI;

  /**
   * Create authenticated Google Text-to-Speech client.
   *
   * @param credentials JSON string with service account credentials.
   * @param credentialsPath Path to service account JSON file.
   * @returns Authenticated Text-to-Speech client.
   */
  protected _createClient(
    credentials: string | null,
    credentialsPath: string | null,
  ): GoogleCloudTTSClient | GoogleGenAI {
    return createGoogleCloudTTSClient(
      cloudTTSClientOptions(
        credentials,
        credentialsPath,
        this._location,
        this._clientOptions,
        this._textToSpeechModule,
      ),
    );
  }

  /**
   * Check if this service can generate processing metrics.
   *
   * @returns True, as Google streaming TTS services support metrics
   *   generation.
   */
  override canGenerateMetrics(): boolean {
    return true;
  }

  /**
   * Convert a Language value to Google TTS language format.
   *
   * @param language The language to convert.
   * @returns The Google TTS-specific language code, or null if not supported.
   */
  override languageToServiceLanguage(language: Language): string | null {
    return languageToGoogleTtsLanguage(language);
  }

  /**
   * Shared streaming synthesis logic.
   *
   * @param streamingConfig The streaming configuration.
   * @param text The text to synthesize.
   * @param contextId Unique identifier for this TTS context.
   * @param prompt Optional prompt for style instructions (Gemini only).
   * @returns Audio frames containing the synthesized speech.
   */
  protected async *_streamTts(
    streamingConfig: GoogleStreamingSynthesizeConfig,
    text: string,
    contextId: string,
    prompt: string | null = null,
  ): AsyncGenerator<Frame, void> {
    const configRequest: GoogleStreamingSynthesizeRequest = { streamingConfig };

    async function* requestGenerator(): AsyncGenerator<GoogleStreamingSynthesizeRequest> {
      yield configRequest;
      const synthesisInputParams: { text: string; prompt?: string } = { text };
      if (prompt !== null) {
        synthesisInputParams.prompt = prompt;
      }
      yield { input: synthesisInputParams };
    }

    // Streaming synthesis is the GCP path; the GenAI backend has its own.
    const client = this._client as GoogleCloudTTSClient;
    const streamingResponses = await client.streamingSynthesize(requestGenerator());
    await this.startTtsUsageMetrics(text);

    let audioBuffer: Uint8Array = new Uint8Array(0);
    let firstChunkForTtfb = false;

    const CHUNK_SIZE = this.chunkSize;

    for await (const response of abortableIter(streamingResponses)) {
      const chunk = toBytes(response.audioContent);
      if (chunk.length === 0) {
        continue;
      }

      if (!firstChunkForTtfb) {
        await this.stopTtfbMetrics();
        firstChunkForTtfb = true;
      }

      audioBuffer = concatBytes(audioBuffer, chunk);
      while (audioBuffer.length >= CHUNK_SIZE) {
        const piece = audioBuffer.slice(0, CHUNK_SIZE);
        audioBuffer = audioBuffer.slice(CHUNK_SIZE);
        yield new TTSAudioRawFrame({
          audio: piece,
          sampleRate: this.sampleRate,
          numChannels: 1,
          contextId,
        });
      }
    }

    if (audioBuffer.length > 0) {
      yield new TTSAudioRawFrame({
        audio: audioBuffer,
        sampleRate: this.sampleRate,
        numChannels: 1,
        contextId,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// GoogleTTSService
// ---------------------------------------------------------------------------

export interface GoogleTTSServiceOptions extends TTSServiceOptions {
  /** JSON string containing Google Cloud service account credentials. */
  credentials?: string | null;
  /** Path to Google Cloud service account JSON file. */
  credentialsPath?: string | null;
  /** Google Cloud location for regional endpoint (e.g., "us-central1"). */
  location?: string | null;
  /** The voice cloning key for Chirp 3 custom voices. */
  voiceCloningKey?: string | null;
  /**
   * Extra options for the `@google-cloud/text-to-speech` `TextToSpeechClient`
   * (e.g. `apiEndpoint`, `port`, `sslCreds`), merged over the ones derived
   * from `location` and the credentials.
   *
   * DIVERGENCE: pipedog-only. Upstream builds its client from `location` and
   * the credentials alone.
   */
  clientOptions?: Record<string, unknown> | null;
  /** The `@google-cloud/text-to-speech` module, for a bundled app: see `GoogleCloudTTSClientOptions.module`. */
  textToSpeechModule?: GoogleTextToSpeechModule | null;
  /** Runtime-updatable settings. */
  settings?: GoogleTTSSettings | null;
}

/**
 * Google Cloud Text-to-Speech streaming service.
 *
 * Provides real-time text-to-speech synthesis using Google Cloud's streaming
 * API for low-latency applications. Optimized for Chirp 3 HD and Journey
 * voices with continuous audio streaming capabilities.
 *
 * Note: requires Google Cloud credentials via service account JSON, file
 * path, or default application credentials (GOOGLE_APPLICATION_CREDENTIALS
 * env var). Only Chirp 3 HD and Journey voices are supported. Use
 * GoogleHttpTTSService for other voices.
 *
 * @example
 * const tts = new GoogleTTSService({
 *   credentialsPath: "/path/to/service-account.json",
 *   settings: new GoogleTTSService.Settings({
 *     voice: "en-US-Chirp3-HD-Charon",
 *     language: Language.EN_US,
 *   }),
 * });
 */
export class GoogleTTSService extends GoogleBaseTTSService {
  static Settings = GoogleTTSSettings;
  declare protected _settings: GoogleTTSSettings;

  static {
    installTracedTts(GoogleTTSService.prototype, "runTts");
  }

  protected _voiceCloningKey: string | null;

  /**
   * Initializes the Google streaming TTS service.
   *
   * @param options.credentials JSON string containing Google Cloud service
   *   account credentials.
   * @param options.credentialsPath Path to Google Cloud service account JSON
   *   file.
   * @param options.location Google Cloud location for regional endpoint
   *   (e.g., "us-central1").
   * @param options.voiceCloningKey The voice cloning key for Chirp 3 custom
   *   voices.
   * @param options.sampleRate Audio sample rate in Hz. If null, uses default.
   * @param options.settings Runtime-updatable settings.
   *   Other options are passed to the parent TTSService.
   */
  constructor(options: GoogleTTSServiceOptions = {}) {
    // 1. Initialize defaultSettings with hardcoded defaults
    const defaultSettings = new GoogleTTSSettings({
      model: null,
      voice: "en-US-Chirp3-HD-Charon",
      language: "en-US",
      speakingRate: null,
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

    this._location = options.location ?? null;
    this._clientOptions = options.clientOptions ?? null;
    this._textToSpeechModule = options.textToSpeechModule ?? null;
    this._voiceCloningKey = options.voiceCloningKey ?? null;
    this._client = this._createClient(options.credentials ?? null, options.credentialsPath ?? null);
  }

  /**
   * Override to handle speakingRate validation.
   *
   * @param delta Settings delta. Can include `speakingRate` (number).
   */
  protected override async _updateSettings(delta: TTSSettings): Promise<Record<string, unknown>> {
    if (
      delta instanceof GoogleTTSSettings &&
      isGiven(delta.speakingRate) &&
      delta.speakingRate !== null // null == "up to Google"; no check needed
    ) {
      const rateValue = Number(delta.speakingRate);
      if (!(rateValue >= 0.25 && rateValue <= 2.0)) {
        logger.warning(`Invalid speaking_rate value: ${rateValue}. Must be between 0.25 and 2.0`);
        delta.speakingRate = NOT_GIVEN;
      }
    }
    return await super._updateSettings(delta);
  }

  /**
   * Generate streaming speech from text using Google's streaming API.
   *
   * @param text The text to synthesize into speech.
   * @param contextId The context ID for tracking audio frames.
   * @returns Audio frames containing the synthesized speech as it's
   *   generated.
   */
  override async *runTts(text: string, contextId: string): AsyncGenerator<Frame, void> {
    try {
      // Build voice selection params
      let voice: GoogleVoiceSelectionParams;
      if (this._voiceCloningKey) {
        voice = {
          languageCode: this._settings.language as string | null,
          voiceClone: { voiceCloningKey: this._voiceCloningKey },
        };
      } else {
        voice = {
          languageCode: this._settings.language as string | null,
          name: this._settings.voice as string | null,
        };
      }

      // Create streaming config
      const speakingRate = this._settings.speakingRate;
      const streamingConfig: GoogleStreamingSynthesizeConfig = {
        voice,
        streamingAudioConfig: {
          audioEncoding: "PCM",
          sampleRateHertz: this.sampleRate,
          ...(isGiven(speakingRate) && speakingRate !== null ? { speakingRate } : {}),
        },
      };

      // Use base class streaming logic
      yield* this._streamTts(streamingConfig, text, contextId);
    } catch (e) {
      rethrowIfCancelled(e);
      await this.pushError(`TTS generation error: ${errorMessage(e)}`, { exception: e });
    }
  }
}

// ---------------------------------------------------------------------------
// GeminiTTSService
// ---------------------------------------------------------------------------

export interface GeminiTTSServiceOptions extends TTSServiceOptions {
  /** Google AI API key for authentication when using GenAI. */
  apiKey?: string | null;
  /** JSON string containing Google Cloud service account credentials. */
  credentials?: string | null;
  /** Path to Google Cloud service account JSON file. */
  credentialsPath?: string | null;
  /** Google Cloud location for regional endpoint (e.g., "us-central1"). */
  location?: string | null;
  /**
   * Extra options for the `@google-cloud/text-to-speech` `TextToSpeechClient`
   * (e.g. `apiEndpoint`, `port`, `sslCreds`), merged over the ones derived
   * from `location` and the credentials.
   *
   * DIVERGENCE: pipedog-only. Upstream builds its client from `location` and
   * the credentials alone.
   */
  clientOptions?: Record<string, unknown> | null;
  /** The `@google-cloud/text-to-speech` module, for a bundled app: see `GoogleCloudTTSClientOptions.module`. */
  textToSpeechModule?: GoogleTextToSpeechModule | null;
  /** Runtime-updatable settings. */
  settings?: GeminiTTSSettings | null;
  /** Force use of the google-genai client if true. */
  useGenai?: boolean | null;
  /** HTTP client options for the google-genai client. */
  httpOptions?: HttpOptions | null;
}

/**
 * Gemini Text-to-Speech streaming service using Gemini TTS models.
 *
 * Provides real-time text-to-speech synthesis using Gemini's TTS-specific
 * models, with support for natural voice control, prompts for style
 * instructions, expressive markup tags, and multi-speaker conversations.
 *
 * Model names differ by backend. Cloud Text-to-Speech takes
 * `gemini-3.1-flash-tts-preview`, `gemini-2.5-flash-tts`,
 * `gemini-2.5-flash-lite-preview-tts` and `gemini-2.5-pro-tts`; the Gemini
 * API takes `gemini-3.8-flash-tts`, `gemini-3.8-flash-lite-tts`,
 * `gemini-3.1-flash-tts-preview`, `gemini-2.5-flash-preview-tts` and
 * `gemini-2.5-pro-preview-tts`. Defaults to `gemini-3.1-flash-tts-preview`,
 * which both backends accept.
 *
 * Gemini 3.8 TTS models (Gemini API backend) treat the input text strictly as
 * a verbatim transcript: the `prompt` setting is sent as a structured
 * `speechMetadata.style` annotation, and only momentary vocal events belong
 * inline in the text as angle-bracket tags (`<laugh>`, `<sigh>`,
 * `<short pause>`). Custom voices from Voice design are supported via their
 * `voice_...` IDs.
 *
 * Note: requires Google Cloud credentials via service account JSON,
 * credentials file, or default application credentials
 * (GOOGLE_APPLICATION_CREDENTIALS). Uses the Google Cloud Text-to-Speech
 * streaming API for low-latency synthesis.
 *
 * @example
 * const tts = new GeminiTTSService({
 *   credentialsPath: "/path/to/service-account.json",
 *   settings: new GeminiTTSService.Settings({
 *     model: "gemini-3.1-flash-tts-preview",
 *     voice: "Kore",
 *     language: Language.EN_US,
 *     prompt: "Say this in a friendly and helpful tone",
 *   }),
 * });
 */
export class GeminiTTSService extends GoogleBaseTTSService {
  static Settings = GeminiTTSSettings;
  declare protected _settings: GeminiTTSSettings;

  static {
    installTracedTts(GeminiTTSService.prototype, "runTts");
  }

  /** Google TTS always outputs at 24kHz. */
  static GOOGLE_SAMPLE_RATE = 24000;

  /** List of available Gemini TTS voices. */
  static AVAILABLE_VOICES: readonly string[] = [
    "Achernar",
    "Achird",
    "Algenib",
    "Algieba",
    "Alnilam",
    "Aoede",
    "Autonoe",
    "Callirrhoe",
    "Charon",
    "Despina",
    "Enceladus",
    "Erinome",
    "Fenrir",
    "Gacrux",
    "Iapetus",
    "Kore",
    "Laomedeia",
    "Leda",
    "Orus",
    "Puck",
    "Pulcherrima",
    "Rasalgethi",
    "Sadachbia",
    "Sadaltager",
    "Schedar",
    "Sulafat",
    "Umbriel",
    "Vindemiatrix",
    "Zephyr",
    "Zubenelgenubi",
  ];

  protected _useGenai: boolean;
  protected _apiKey: string | null;
  protected _httpOptions: GeminiTTSServiceOptions["httpOptions"] | null;

  /**
   * Initializes the Gemini TTS service.
   *
   * @param options.apiKey Google AI API key for authentication when using
   *   GenAI.
   * @param options.credentials JSON string containing Google Cloud service
   *   account credentials.
   * @param options.credentialsPath Path to Google Cloud service account JSON
   *   file.
   * @param options.location Google Cloud location for regional endpoint
   *   (e.g., "us-central1").
   * @param options.sampleRate Audio sample rate in Hz. If null, uses Google's
   *   default 24kHz.
   * @param options.settings Runtime-updatable settings.
   * @param options.useGenai Force use of the google-genai client if true.
   * @param options.httpOptions HTTP client options for the google-genai
   *   client.
   *   Other options are passed to the parent TTSService.
   */
  constructor(options: GeminiTTSServiceOptions = {}) {
    // Backend selection: an explicit `useGenai` wins; otherwise passing an
    // `apiKey` opts into the GenAI client. We deliberately don't auto-select
    // GenAI from the GOOGLE_API_KEY env var alone — that var is commonly set
    // for other Google services (e.g. the LLM), and reading it here would
    // silently flip the backend out from under a GCP-credentialed user.
    let useGenai: boolean;
    if (options.useGenai !== undefined && options.useGenai !== null) {
      useGenai = options.useGenai;
    } else {
      useGenai = options.apiKey !== undefined && options.apiKey !== null;
    }

    // The API key (param, then env) is only meaningful for the GenAI backend.
    const apiKey = useGenai ? options.apiKey || getEnv("GOOGLE_API_KEY") || null : null;

    const sampleRate = options.sampleRate ?? null;
    if (sampleRate && sampleRate !== GeminiTTSService.GOOGLE_SAMPLE_RATE) {
      logger.warning(
        `Google TTS only supports ${GeminiTTSService.GOOGLE_SAMPLE_RATE}Hz sample rate. ` +
          `Current rate of ${sampleRate}Hz may cause issues.`,
      );
    }

    // 1. Initialize defaultSettings with hardcoded defaults
    const defaultSettings = new GeminiTTSSettings({
      model: "gemini-3.1-flash-tts-preview",
      voice: "Kore",
      language: "en-US",
      prompt: null,
      multiSpeaker: false,
      speakerConfigs: null,
    });

    const voice = assertGiven(defaultSettings.voice);
    // Custom voice IDs begin with `voice_`
    if (
      !GeminiTTSService.AVAILABLE_VOICES.includes(voice as string) &&
      !voice?.startsWith("voice_")
    ) {
      logger.warning(`Voice '${defaultSettings.voice}' not in known voices list. Using anyway.`);
    }

    // 2. Apply settings delta (canonical API, always wins)
    if (options.settings !== undefined && options.settings !== null) {
      defaultSettings.applyUpdate(options.settings);
    }

    super({
      ...options,
      sampleRate,
      pushStartFrame: true,
      pushStopFrames: true,
      settings: defaultSettings,
    });

    this._useGenai = useGenai;
    this._apiKey = apiKey;
    this._httpOptions = options.httpOptions ?? null;

    this._location = options.location ?? null;
    this._clientOptions = options.clientOptions ?? null;
    this._textToSpeechModule = options.textToSpeechModule ?? null;
    this._client = this._createClient(options.credentials ?? null, options.credentialsPath ?? null);

    // Warn once now about settings the GenAI backend ignores, rather than on
    // every utterance in runTts.
    this._warnUnsupportedGenaiSettings({
      multiSpeaker: assertGiven(defaultSettings.multiSpeaker),
      prompt: assertGiven(defaultSettings.prompt),
      model: assertGiven(defaultSettings.model),
    });
  }

  protected override _createClient(
    credentials: string | null,
    credentialsPath: string | null,
  ): GoogleCloudTTSClient | GoogleGenAI {
    if (this._useGenai) {
      return new GoogleGenAI({
        apiKey: this._apiKey ?? undefined,
        httpOptions: this._httpOptions ?? undefined,
      });
    }
    return super._createClient(credentials, credentialsPath);
  }

  /**
   * Stop the Gemini TTS service.
   *
   * @param frame The end frame.
   */
  override async stop(frame: EndFrame): Promise<void> {
    await super.stop(frame);
    await this._closeClient();
  }

  /**
   * Cancel the Gemini TTS service.
   *
   * @param frame The cancel frame.
   */
  override async cancel(frame: CancelFrame): Promise<void> {
    await super.cancel(frame);
    await this._closeClient();
  }

  protected async _closeClient(): Promise<void> {
    // Only the GenAI client could own a closable async session; the GCP
    // client manages its own lifecycle. The JS GenAI client keeps no session
    // for generateContentStream, so there is nothing to close; a client that
    // does expose `aclose()` (e.g. a custom one) is closed.
    if (this._useGenai) {
      const client = this._client as unknown as { aclose?: () => Promise<void> };
      try {
        await client.aclose?.();
      } catch (e) {
        rethrowIfCancelled(e);
        // Do nothing - we're shutting down anyway.
      }
    }
  }

  /**
   * Whether the model follows the Gemini 3.8 TTS request contract.
   *
   * Gemini 3.8 TTS models treat input text as a verbatim transcript, take
   * style instructions via `speechMetadata`, and return WAV by default.
   * Covers the official `gemini-3.8-*-tts` names and the `sonic-*` preview
   * codenames.
   */
  static _isGemini38Tts(model: string | null): boolean {
    if (!model) {
      return false;
    }
    return model.includes("-3.8-") || model.startsWith("sonic-");
  }

  /**
   * Warn about settings the GenAI backend silently ignores.
   *
   * The Gemini API (GenAI) backend does not support multi-speaker output.
   * Prompt/style instructions are supported only by Gemini 3.8 TTS models
   * (sent as `speechMetadata.style`). This is a no-op on the GCP backend.
   */
  protected _warnUnsupportedGenaiSettings(options: {
    multiSpeaker: boolean | null;
    prompt: string | null;
    model: string | null;
  }): void {
    if (!this._useGenai) {
      return;
    }
    if (options.multiSpeaker) {
      logger.warning(
        `${this}: Multi-speaker is not supported by the Gemini API (GenAI) TTS ` +
          "backend; using a single speaker.",
      );
    }
    if (options.prompt && !GeminiTTSService._isGemini38Tts(options.model)) {
      logger.warning(
        `${this}: Prompt/style instructions require a Gemini 3.8 TTS model on ` +
          "the Gemini API (GenAI) backend.",
      );
    }
  }

  /**
   * Convert a Language value to Gemini TTS language format.
   *
   * @param language The language to convert.
   * @returns The Gemini TTS-specific language code, or null if not supported.
   */
  override languageToServiceLanguage(language: Language): string | null {
    return languageToGeminiTtsLanguage(language);
  }

  /**
   * Set up the service.
   *
   * @param setup Configuration object containing setup parameters.
   */
  override async setup(setup: FrameProcessorSetup): Promise<void> {
    await super.setup(setup);
    if (this.sampleRate !== GeminiTTSService.GOOGLE_SAMPLE_RATE) {
      logger.warning(
        `Google TTS requires ${GeminiTTSService.GOOGLE_SAMPLE_RATE}Hz sample rate. ` +
          `Current rate of ${this.sampleRate}Hz may cause issues.`,
      );
    }
  }

  /**
   * Start the service.
   *
   * @param frame The start frame containing initialization parameters.
   */
  override async start(frame: StartFrame): Promise<void> {
    await super.start(frame);
    await this._checkGenaiModelSupported();
  }

  /**
   * Report the service unusable if the installed SDK can't drive its model.
   *
   * Gemini 3.8 TTS models need `speechMetadata` support in the SDK. The
   * error's category is permanent, so the service stops being given work
   * until its settings change.
   */
  protected async _checkGenaiModelSupported(): Promise<void> {
    if (!this._useGenai) {
      return;
    }
    const model = assertGiven(this._settings.model);
    if (GeminiTTSService._isGemini38Tts(model) && !GENAI_SUPPORTS_SPEECH_METADATA) {
      await this.pushError(
        `Gemini 3.8 TTS models require google-genai >= 2.25.0 (model: ${model})`,
        { category: ErrorCategory.INVALID_REQUEST },
      );
    }
  }

  /**
   * Apply a settings delta with voice validation.
   *
   * @param delta Settings delta. Can include `voice`, `prompt`, etc.
   * @returns Dict mapping changed field names to their previous values.
   */
  protected override async _updateSettings(delta: TTSSettings): Promise<Record<string, unknown>> {
    if (
      isGiven(delta.voice) &&
      !GeminiTTSService.AVAILABLE_VOICES.includes(delta.voice as string) &&
      !delta.voice?.startsWith("voice_")
    ) {
      logger.warning(`Voice '${delta.voice}' not in known voices list. Using anyway.`);
    }

    if (delta instanceof GeminiTTSSettings) {
      const model = isGiven(delta.model) ? delta.model : this._settings.model;
      this._warnUnsupportedGenaiSettings({
        multiSpeaker: isGiven(delta.multiSpeaker) ? delta.multiSpeaker : null,
        prompt: isGiven(delta.prompt) ? delta.prompt : null,
        model: isGiven(model) ? model : null,
      });
    }

    const changed = await super._updateSettings(delta);
    // Any settings change makes the service usable again, so check that the
    // model still works with the installed SDK.
    if (Object.keys(changed).length > 0) {
      await this._checkGenaiModelSupported();
    }
    return changed;
  }

  /**
   * Generate streaming speech from text using Gemini TTS models.
   *
   * Gemini 3.8 TTS models treat the text as a verbatim transcript. Momentary
   * vocal events may appear inline as angle-bracket tags (e.g. `<laugh>`,
   * `<sigh>`, `<short pause>`); sustained delivery style belongs in the
   * `prompt` setting, not in the text. Older models accept square-bracket
   * markup tags like `[sigh]` or `[whispering]` in the text instead.
   *
   * @param text The text to synthesize into speech.
   * @param contextId The context ID for tracking audio frames.
   * @returns Audio frames containing the synthesized speech as it's
   *   generated.
   */
  override async *runTts(text: string, contextId: string): AsyncGenerator<Frame, void> {
    if (this._useGenai) {
      yield* this._runGenaiTts(text, contextId);
    } else {
      yield* this._runGcpTts(text, contextId);
    }
  }

  protected async *_runGcpTts(text: string, contextId: string): AsyncGenerator<Frame, void> {
    logger.debug(`${this}: Generating GCP TTS [${text}]`);

    try {
      // Build voice selection params
      let voice: GoogleVoiceSelectionParams;
      const speakerConfigs = this._settings.speakerConfigs;
      if (this._settings.multiSpeaker && isGiven(speakerConfigs) && speakerConfigs?.length) {
        // Multi-speaker mode
        const speakerVoiceConfigs: { speakerAlias: string; speakerId: string | null }[] = [];
        for (const speakerConfig of speakerConfigs) {
          if (!("speaker_alias" in speakerConfig)) {
            // Upstream's `speaker_config["speaker_alias"]` raises KeyError, whose str() is quoted.
            throw new Error("'speaker_alias'");
          }
          speakerVoiceConfigs.push({
            speakerAlias: speakerConfig.speaker_alias as string,
            speakerId:
              "speaker_id" in speakerConfig
                ? (speakerConfig.speaker_id as string | null)
                : (this._settings.voice as string | null),
          });
        }

        voice = {
          languageCode: this._settings.language as string | null,
          modelName: this._settings.model as string | null,
          multiSpeakerVoiceConfig: { speakerVoiceConfigs },
        };
      } else {
        // Single speaker mode
        voice = {
          languageCode: this._settings.language as string | null,
          name: this._settings.voice as string | null,
          modelName: this._settings.model as string | null,
        };
      }

      // Create streaming config
      const streamingConfig: GoogleStreamingSynthesizeConfig = {
        voice,
        streamingAudioConfig: {
          audioEncoding: "PCM",
          sampleRateHertz: this.sampleRate,
        },
      };

      // Use base class streaming logic with prompt support
      yield* this._streamTts(streamingConfig, text, contextId, assertGiven(this._settings.prompt));
    } catch (e) {
      rethrowIfCancelled(e);
      yield new ErrorFrame({ error: `Gemini GCP TTS generation error: ${errorMessage(e)}` });
    }
  }

  protected async *_runGenaiTts(text: string, contextId: string): AsyncGenerator<Frame, void> {
    logger.debug(`${this}: Generating GenAI TTS [${text}]`);

    try {
      const model = assertGiven(this._settings.model);
      if (model === null) {
        throw new Error("GeminiTTSService requires a model");
      }
      const isGemini38 = GeminiTTSService._isGemini38Tts(model);

      const config: Record<string, unknown> = {
        responseModalities: ["AUDIO"],
        speechConfig: {
          languageCode: assertGiven(this._settings.language),
          voiceConfig: {
            prebuiltVoiceConfig: {
              voiceName: assertGiven(this._settings.voice),
            },
          },
        },
        abortSignal: currentSignal(),
      };

      let contents: unknown = text;
      if (isGemini38) {
        // Gemini 3.8 TTS treats the input strictly as a verbatim
        // transcript: sustained style goes in speechMetadata. The response
        // defaults to WAV (the SDK offers no way to request raw PCM via
        // GenerateContentConfig), so the audio streaming below strips a RIFF
        // header when one arrives.
        const part: Record<string, unknown> = { text };
        const prompt = this._settings.prompt;
        if (isGiven(prompt) && prompt) {
          part.speechMetadata = { style: prompt };
        }
        contents = [{ role: "user", parts: [part] }];
      }

      await this.startTtsUsageMetrics(text);

      const client = this._client as GoogleGenAI;

      const response = (await abortable(
        client.models.generateContentStream({
          model,
          contents: contents as never,
          config,
        }),
      )) as AsyncIterable<GenaiResponseChunk>;

      const audioChunks = async function* (
        this: GeminiTTSService,
      ): AsyncGenerator<Uint8Array, void> {
        let firstChunkForTtfb = false;
        let buffer: Uint8Array = new Uint8Array(0);
        const chunkSize = this.chunkSize;
        for await (const chunk of abortableIter(response)) {
          const parts = chunk.candidates?.[0]?.content?.parts;
          if (!parts || parts.length === 0) {
            continue;
          }
          for (const part of parts) {
            // Python's truthiness: empty bytes (or an empty base64 string) is skipped.
            const data = part.inlineData?.data ? toBytes(part.inlineData.data) : null;
            if (data && data.length > 0) {
              if (!firstChunkForTtfb) {
                await this.stopTtfbMetrics();
                firstChunkForTtfb = true;
              }
              buffer = concatBytes(buffer, data);
              while (buffer.length >= chunkSize) {
                yield buffer.slice(0, chunkSize);
                buffer = buffer.slice(chunkSize);
              }
            }
          }
        }
        if (buffer.length > 0) {
          yield buffer;
        }
      }.call(this);

      yield* this._streamAudioFramesFromIterator(audioChunks, {
        stripWavHeader: isGemini38,
        contextId,
      });
    } catch (e) {
      rethrowIfCancelled(e);
      yield new ErrorFrame({ error: `Gemini GenAI TTS generation error: ${errorMessage(e)}` });
    }
  }
}
