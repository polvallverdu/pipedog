// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/services/aws/tts.py

/**
 * AWS Polly text-to-speech service implementation.
 *
 * This module provides integration with Amazon Polly for text-to-speech synthesis,
 * supporting multiple languages, voices, and SSML features.
 *
 * Porting notes:
 * - `synthesize_speech` is a SigV4-signed `fetch` to Polly's REST API
 *   (`POST /v1/speech`, service `polly`), with the JSON body botocore sends.
 *   It runs on Bun, Node, Deno and Cloudflare Workers.
 * - DIVERGENCE: no botocore default credential chain; keys come from the
 *   options, the environment, or the `credentialsProvider` option (called for
 *   every request).
 * - DIVERGENCE: upstream yields an `ErrorFrame` for `BotoCoreError` and
 *   `ClientError` only. Here every request failure (a non-2xx response, a
 *   network error, missing credentials) becomes an `ErrorFrame`, since they
 *   are the JS counterparts of those botocore errors.
 * - Deprecated APIs are not ported: `InputParams`, and the `voiceId` and
 *   `params` constructor options.
 */

import { abortable, currentSignal, rethrowIfCancelled } from "@pipedog/asyncio";
import { createStreamResampler } from "@pipedog/core/audio/utils";
import { ErrorFrame, type Frame, TTSAudioRawFrame } from "@pipedog/core/frames/frames";
import { TTSSettings, type TTSSettingsOptions } from "@pipedog/core/services/settings";
import { TTSService, type TTSServiceOptions } from "@pipedog/core/services/tts_service";
import { Language, resolveLanguage } from "@pipedog/core/transcriptions/language";
import { logger } from "@pipedog/core/utils/logger";
import { pyJsonDumps } from "@pipedog/core/utils/py_json";
import { installTracedTts } from "@pipedog/core/utils/tracing/service_decorators";
import { NOT_GIVEN, type NotGiven } from "@pipedog/core/utils/types";
import { type AWSClientOptions, AWSSession, awsEndpoint } from "./aws_session.ts";

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** `xml.sax.saxutils.escape`: escape `&`, `<` and `>`. */
function escapeXml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/>/g, "&gt;").replace(/</g, "&lt;");
}

const LANGUAGE_MAP: Partial<Record<Language, string>> = {
  // Arabic
  [Language.AR]: "arb",
  [Language.AR_AE]: "ar-AE",
  // Catalan
  [Language.CA]: "ca-ES",
  // Chinese
  [Language.ZH]: "cmn-CN", // Mandarin
  [Language.YUE]: "yue-CN", // Cantonese
  [Language.YUE_CN]: "yue-CN",
  // Czech
  [Language.CS]: "cs-CZ",
  // Danish
  [Language.DA]: "da-DK",
  // Dutch
  [Language.NL]: "nl-NL",
  [Language.NL_BE]: "nl-BE",
  // English
  [Language.EN]: "en-US", // Default to US English
  [Language.EN_AU]: "en-AU",
  [Language.EN_GB]: "en-GB",
  [Language.EN_IE]: "en-IE",
  [Language.EN_IN]: "en-IN",
  [Language.EN_NZ]: "en-NZ",
  [Language.EN_SG]: "en-SG",
  [Language.EN_US]: "en-US",
  [Language.EN_ZA]: "en-ZA",
  // Finnish
  [Language.FI]: "fi-FI",
  // French
  [Language.FR]: "fr-FR",
  [Language.FR_BE]: "fr-BE",
  [Language.FR_CA]: "fr-CA",
  // German
  [Language.DE]: "de-DE",
  [Language.DE_AT]: "de-AT",
  [Language.DE_CH]: "de-CH",
  // Hindi
  [Language.HI]: "hi-IN",
  // Icelandic
  [Language.IS]: "is-IS",
  // Italian
  [Language.IT]: "it-IT",
  // Japanese
  [Language.JA]: "ja-JP",
  // Korean
  [Language.KO]: "ko-KR",
  // Norwegian
  [Language.NO]: "nb-NO",
  [Language.NB]: "nb-NO",
  [Language.NB_NO]: "nb-NO",
  // Polish
  [Language.PL]: "pl-PL",
  // Portuguese
  [Language.PT]: "pt-PT",
  [Language.PT_BR]: "pt-BR",
  [Language.PT_PT]: "pt-PT",
  // Romanian
  [Language.RO]: "ro-RO",
  // Russian
  [Language.RU]: "ru-RU",
  // Spanish
  [Language.ES]: "es-ES",
  [Language.ES_MX]: "es-MX",
  [Language.ES_US]: "es-US",
  // Swedish
  [Language.SV]: "sv-SE",
  // Turkish
  [Language.TR]: "tr-TR",
  // Welsh
  [Language.CY]: "cy-GB",
  [Language.CY_GB]: "cy-GB",
};

/**
 * Convert a Language enum to AWS Polly language code.
 *
 * @param language The Language enum value to convert.
 * @returns The corresponding service language code. If `language` is not in
 *   the verified mapping, falls back to the full language code string and
 *   logs a warning.
 */
export function languageToAwsLanguage(language: Language): string {
  return resolveLanguage(language, LANGUAGE_MAP, false);
}

export interface AWSPollyTTSSettingsOptions extends TTSSettingsOptions {
  /** TTS engine to use ('standard', 'neural', etc.). */
  engine?: string | null | NotGiven;
  /** Voice pitch adjustment (for standard engine only). */
  pitch?: string | null | NotGiven;
  /** Speech rate adjustment. */
  rate?: string | null | NotGiven;
  /** Voice volume adjustment. */
  volume?: string | null | NotGiven;
  /** List of pronunciation lexicons to apply. */
  lexiconNames?: string[] | null | NotGiven;
}

/**
 * Settings for AWSPollyTTSService.
 *
 * - `engine`: TTS engine to use ('standard', 'neural', etc.).
 * - `pitch`: Voice pitch adjustment (for standard engine only).
 * - `rate`: Speech rate adjustment.
 * - `volume`: Voice volume adjustment.
 * - `lexiconNames`: List of pronunciation lexicons to apply.
 */
export class AWSPollyTTSSettings extends TTSSettings {
  engine: string | null | NotGiven = NOT_GIVEN;
  pitch: string | null | NotGiven = NOT_GIVEN;
  rate: string | null | NotGiven = NOT_GIVEN;
  volume: string | null | NotGiven = NOT_GIVEN;
  lexiconNames: string[] | null | NotGiven = NOT_GIVEN;

  constructor(options: AWSPollyTTSSettingsOptions = {}) {
    super(options);
    this._assignOptions(options);
  }
}

export interface AWSPollyTTSServiceOptions extends TTSServiceOptions, AWSClientOptions {
  /** AWS secret access key. If null, falls back to environment variables and `credentialsProvider`. */
  apiKey?: string | null;
  /** AWS access key ID. Same fallback behaviour as `apiKey`. */
  awsAccessKeyId?: string | null;
  /** AWS session token for temporary credentials. */
  awsSessionToken?: string | null;
  /** AWS region for Polly service. Defaults to 'us-east-1'. */
  region?: string | null;
  /** Runtime-updatable settings. */
  settings?: AWSPollyTTSSettings | null;
}

/**
 * AWS Polly text-to-speech service.
 *
 * Provides text-to-speech synthesis using Amazon Polly with support for
 * multiple languages, voices, SSML features, and voice customization
 * options including prosody controls.
 */
export class AWSPollyTTSService extends TTSService {
  static Settings: typeof AWSPollyTTSSettings = AWSPollyTTSSettings;
  declare protected _settings: AWSPollyTTSSettings;

  static {
    installTracedTts(AWSPollyTTSService.prototype, "runTts");
  }

  protected _awsSession: AWSSession;
  protected _endpointUrl: string | null;
  protected override _resampler = createStreamResampler();

  /**
   * Initializes the AWS Polly TTS service.
   *
   * @param options.apiKey AWS secret access key. If null, falls back to
   *   environment variables and `credentialsProvider`.
   * @param options.awsAccessKeyId AWS access key ID. Same fallback behaviour as `apiKey`.
   * @param options.awsSessionToken AWS session token for temporary credentials.
   * @param options.region AWS region for Polly service. Defaults to 'us-east-1'.
   * @param options.sampleRate Audio sample rate. If null, uses service default.
   * @param options.settings Runtime-updatable settings.
   *   Other options are passed to the parent TTSService class.
   */
  constructor(options: AWSPollyTTSServiceOptions = {}) {
    // 1. Initialize default_settings with hardcoded defaults
    const defaultSettings = new (new.target as typeof AWSPollyTTSService).Settings({
      model: null,
      voice: "Joanna",
      language: "en-US",
      engine: null,
      pitch: null,
      rate: null,
      volume: null,
      lexiconNames: null,
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

    // Explicit or environment keys. Without them, each request is signed
    // with keys from `credentialsProvider`.
    this._awsSession = AWSSession.fromOptions({
      awsAccessKeyId: options.awsAccessKeyId,
      awsSecretAccessKey: options.apiKey,
      awsSessionToken: options.awsSessionToken,
      region: options.region,
      credentialsProvider: options.credentialsProvider,
      fetch: options.fetch,
    });
    this._endpointUrl = options.endpointUrl ?? null;
  }

  /**
   * Check if this service can generate processing metrics.
   *
   * @returns True, as AWS Polly service supports metrics generation.
   */
  override canGenerateMetrics(): boolean {
    return true;
  }

  /**
   * Convert a Language enum to AWS Polly language format.
   *
   * @param language The language to convert.
   * @returns The AWS Polly-specific language code, or null if not supported.
   */
  override languageToServiceLanguage(language: Language): string | null {
    return languageToAwsLanguage(language);
  }

  protected _constructSsml(text: string): string {
    let ssml = "<speak>";

    const language = this._settings.language;
    ssml += `<lang xml:lang='${language}'>`;

    const prosodyAttrs: string[] = [];
    // Prosody tags are only supported for standard and neural engines
    if (this._settings.engine === "standard") {
      if (this._settings.pitch) {
        prosodyAttrs.push(`pitch='${this._settings.pitch}'`);
      }
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

    // Escape XML-reserved characters so arbitrary text can't break the
    // SSML document (Polly rejects it with InvalidSsmlException).
    ssml += escapeXml(text);

    if (prosodyAttrs.length > 0) {
      ssml += "</prosody>";
    }

    ssml += "</lang>";

    ssml += "</speak>";

    logger.trace(`${this} SSML: ${ssml}`);

    return ssml;
  }

  /**
   * Generate speech from text using AWS Polly.
   *
   * @param text The text to synthesize into speech.
   * @param contextId The context ID for tracking audio frames.
   * @yields Audio frames containing the synthesized speech.
   */
  override async *runTts(text: string, contextId: string): AsyncGenerator<Frame | null, void> {
    let error: unknown = null;
    let audioData: Uint8Array;
    try {
      // Construct the parameters dictionary
      const ssml = this._constructSsml(text);

      const params: Record<string, unknown> = {
        Text: ssml,
        TextType: "ssml",
        OutputFormat: "pcm",
        VoiceId: this._settings.voice,
        Engine: this._settings.engine,
        // AWS only supports 8000 and 16000 for PCM. We select 16000.
        SampleRate: "16000",
        LexiconNames: this._settings.lexiconNames,
      };

      // Filter out None values
      const filteredParams: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(params)) {
        if (v !== null && v !== undefined) filteredParams[k] = v;
      }

      const endpoint = awsEndpoint("polly", this._awsSession.region, this._endpointUrl);
      const response = await abortable(
        this._awsSession.requestOk({
          service: "polly",
          url: `${endpoint}/v1/speech`,
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: pyJsonDumps(filteredParams),
          signal: currentSignal(),
        }),
      );
      if (!response.body) {
        logger.error(`${this} No audio stream in response`);
        return;
      }
      // Get the streaming body and read it
      audioData = new Uint8Array(await abortable(response.arrayBuffer()));
    } catch (e) {
      rethrowIfCancelled(e);
      error = e;
      audioData = new Uint8Array(0);
    }
    if (error !== null) {
      yield new ErrorFrame({ error: `AWS Polly TTS error: ${errorMessage(error)}` });
      return;
    }

    audioData = await this._resampler.resample(audioData, 16000, this.sampleRate);

    await this.startTtsUsageMetrics(text);

    const CHUNK_SIZE = this.chunkSize;

    for (let i = 0; i < audioData.length; i += CHUNK_SIZE) {
      const chunk = audioData.subarray(i, i + CHUNK_SIZE);
      if (chunk.length > 0) {
        await this.stopTtfbMetrics();
        yield new TTSAudioRawFrame({
          audio: chunk,
          sampleRate: this.sampleRate,
          numChannels: 1,
          contextId,
        });
      }
    }
  }
}
