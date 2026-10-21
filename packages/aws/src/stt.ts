// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/services/aws/stt.py

/**
 * AWS Transcribe Speech-to-Text service implementation.
 *
 * This module provides a WebSocket-based connection to AWS Transcribe for real-time
 * speech-to-text transcription with support for multiple languages and audio formats.
 *
 * Porting notes:
 * - Connects with the global `WebSocket` through `WebsocketService._websocketConnect()`
 *   to Transcribe's WebSocket API, signed with a SigV4 presigned URL (WebCrypto),
 *   so it runs on Bun, Node, Deno and Cloudflare Workers.
 * - DIVERGENCE: upstream falls back to the botocore default credential chain
 *   through an aiobotocore session when no keys are configured. Here keys come
 *   from the options or the environment, and otherwise from the
 *   `credentialsProvider` option, which is called for every connection (see
 *   `aws_session.ts`). `_signingCredentials()` keeps upstream's contract.
 * - DIVERGENCE: only the `Origin` handshake header is sent. Upstream also sets
 *   `Sec-WebSocket-Key`, `Sec-WebSocket-Version` and `Connection`, which the
 *   runtime's `WebSocket` owns and sets itself.
 * - `endpointUrl` (a pipedog addition) replaces
 *   `wss://transcribestreaming.<region>.amazonaws.com:8443` in the presigned
 *   URL, e.g. for a local fake; the URL is still signed for the AWS host.
 * - Deprecated APIs are not ported: the `language` constructor option.
 */

import { rethrowIfCancelled, type Task } from "@pipedog/asyncio";
import {
  type CancelFrame,
  type EndFrame,
  ErrorFrame,
  type Frame,
  InterimTranscriptionFrame,
  TranscriptionFrame,
} from "@pipedog/core/frames/frames";
import type { FrameProcessorSetup } from "@pipedog/core/processors/frame_processor";
import { STTSettings, type STTSettingsOptions } from "@pipedog/core/services/settings";
import { AWS_TRANSCRIBE_TTFS_P99 } from "@pipedog/core/services/stt_latency";
import {
  WebsocketSTTService,
  type WebsocketSTTServiceOptions,
} from "@pipedog/core/services/stt_service";
import { State, type WebsocketClientConnection } from "@pipedog/core/services/websocket_service";
import { Language, resolveLanguage } from "@pipedog/core/transcriptions/language";
import { ErrorCategory, extractHttpStatusCode } from "@pipedog/core/utils/errors";
import { logger } from "@pipedog/core/utils/logger";
import { pyJsonDumps } from "@pipedog/core/utils/py_json";
import { timeNowIso8601 } from "@pipedog/core/utils/time";
import { installTracedStt } from "@pipedog/core/utils/tracing/service_decorators";
import { assertGiven, NOT_GIVEN, type NotGiven } from "@pipedog/core/utils/types";
import { type AWSClientOptions, AWSSession } from "./aws_session.ts";
import { buildEventMessage, decodeEvent, getPresignedUrl } from "./utils.ts";

type Dict = Record<string, any>;

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export interface AWSTranscribeSTTSettingsOptions extends STTSettingsOptions {
  /** How stable interim results should be (`"high"`, `"medium"` or `"low"`). */
  partialResultsStability?: "high" | "medium" | "low" | NotGiven;
}

/**
 * Settings for AWSTranscribeSTTService.
 *
 * - `partialResultsStability`: How stable interim results should be, trading
 *   accuracy against latency: `"low"` is the most accurate, `"high"` the
 *   fastest. AWS binds this to a connection, so updating it at runtime
 *   triggers a reconnect. See
 *   https://docs.aws.amazon.com/transcribe/latest/dg/streaming.html#streaming-partial-result-stabilization.
 */
export class AWSTranscribeSTTSettings extends STTSettings {
  partialResultsStability: "high" | "medium" | "low" | NotGiven = NOT_GIVEN;

  constructor(options: AWSTranscribeSTTSettingsOptions = {}) {
    super(options);
    this._assignOptions(options);
  }
}

export interface AWSTranscribeSTTServiceOptions
  extends WebsocketSTTServiceOptions,
    AWSClientOptions {
  /** AWS secret access key. If null, falls back to environment variables and `credentialsProvider`. */
  apiKey?: string | null;
  /** AWS access key ID. Same fallback behaviour as `apiKey`. */
  awsAccessKeyId?: string | null;
  /** AWS session token for temporary credentials. */
  awsSessionToken?: string | null;
  /** AWS region for the service. */
  region?: string | null;
  /** Runtime-updatable settings. */
  settings?: AWSTranscribeSTTSettings | null;
}

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
  [Language.AR]: "ar-SA", // Default to Modern Standard Arabic
  [Language.AR_AE]: "ar-AE", // Gulf Arabic
  [Language.AR_SA]: "ar-SA", // Modern Standard Arabic
  // Armenian
  [Language.HY]: "hy-AM",
  [Language.HY_AM]: "hy-AM",
  // Basque
  [Language.EU]: "eu-ES",
  [Language.EU_ES]: "eu-ES",
  // Belarusian
  [Language.BE]: "be-BY",
  [Language.BE_BY]: "be-BY",
  // Bengali
  [Language.BN]: "bn-IN", // AWS streams only the Indian variety
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
  // Central Kurdish
  [Language.CKB_IQ]: "ckb-IQ",
  [Language.CKB_IR]: "ckb-IR",
  // Chinese
  [Language.ZH]: "zh-CN", // Default to Simplified
  [Language.ZH_CN]: "zh-CN", // Simplified
  [Language.ZH_TW]: "zh-TW", // Traditional
  [Language.ZH_HK]: "zh-HK", // Cantonese (also yue-HK)
  [Language.YUE]: "zh-HK", // Cantonese fallback
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
  [Language.NL_NL]: "nl-NL",
  // English
  [Language.EN]: "en-US", // Default to US
  [Language.EN_AB]: "en-AB", // Scottish
  [Language.EN_AU]: "en-AU", // Australian
  [Language.EN_GB]: "en-GB", // British
  [Language.EN_IN]: "en-IN", // Indian
  [Language.EN_IE]: "en-IE", // Irish
  [Language.EN_NZ]: "en-NZ", // New Zealand
  [Language.EN_US]: "en-US", // US
  [Language.EN_WL]: "en-WL", // Welsh
  [Language.EN_ZA]: "en-ZA", // South African
  // Estonian
  [Language.ET]: "et-ET", // AWS uses et-ET rather than the BCP 47 et-EE
  [Language.ET_EE]: "et-ET",
  // Persian/Farsi
  [Language.FA]: "fa-IR",
  [Language.FA_AF]: "fa-AF",
  [Language.FA_IR]: "fa-IR",
  // Finnish
  [Language.FI]: "fi-FI",
  [Language.FI_FI]: "fi-FI",
  // French
  [Language.FR]: "fr-FR", // Default to France
  [Language.FR_FR]: "fr-FR",
  [Language.FR_CA]: "fr-CA", // Canadian
  // Galician
  [Language.GL]: "gl-ES",
  [Language.GL_ES]: "gl-ES",
  // Georgian
  [Language.KA]: "ka-GE",
  [Language.KA_GE]: "ka-GE",
  // German
  [Language.DE]: "de-DE", // Default to Germany
  [Language.DE_DE]: "de-DE",
  [Language.DE_CH]: "de-CH", // Swiss
  // Greek
  [Language.EL]: "el-GR",
  [Language.EL_GR]: "el-GR",
  // Gujarati
  [Language.GU]: "gu-IN",
  [Language.GU_IN]: "gu-IN",
  // Haitian Creole
  [Language.HT]: "ht-HT",
  [Language.HT_HT]: "ht-HT",
  // Hebrew
  [Language.HE]: "he-IL",
  [Language.HE_IL]: "he-IL",
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
  // Japanese
  [Language.JA]: "ja-JP",
  [Language.JA_JP]: "ja-JP",
  // Javanese
  [Language.JV]: "jv-ID",
  [Language.JV_ID]: "jv-ID",
  // Kabyle
  [Language.KAB]: "kab-DZ",
  [Language.KAB_DZ]: "kab-DZ",
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
  // Latvian
  [Language.LV]: "lv-LV",
  [Language.LV_LV]: "lv-LV",
  // Lithuanian
  [Language.LT]: "lt-LT",
  [Language.LT_LT]: "lt-LT",
  // Luganda
  [Language.LG]: "lg-IN", // AWS uses lg-IN rather than the BCP 47 lg-UG
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
  // Nepali
  [Language.NE]: "ne-NP",
  [Language.NE_NP]: "ne-NP",
  // Norwegian
  [Language.NB]: "no-NO", // Norwegian Bokmål
  [Language.NB_NO]: "no-NO",
  [Language.NO]: "no-NO",
  // Odia
  [Language.OR]: "or-IN",
  [Language.OR_IN]: "or-IN",
  // Pashto
  [Language.PS]: "ps-AF",
  [Language.PS_AF]: "ps-AF",
  // Polish
  [Language.PL]: "pl-PL",
  [Language.PL_PL]: "pl-PL",
  // Portuguese
  [Language.PT]: "pt-PT", // Default to Portugal
  [Language.PT_PT]: "pt-PT",
  [Language.PT_BR]: "pt-BR", // Brazilian
  // Punjabi
  [Language.PA]: "pa-IN",
  [Language.PA_IN]: "pa-IN",
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
  // Somali
  [Language.SO]: "so-SO",
  [Language.SO_SO]: "so-SO",
  // Spanish
  [Language.ES]: "es-ES", // Default to Spain
  [Language.ES_ES]: "es-ES",
  [Language.ES_MX]: "es-MX", // Mexican
  [Language.ES_US]: "es-US", // US Spanish
  // Sundanese
  [Language.SU]: "su-ID",
  [Language.SU_ID]: "su-ID",
  // Swahili
  [Language.SW]: "sw-KE", // Default to Kenya
  [Language.SW_BI]: "sw-BI",
  [Language.SW_KE]: "sw-KE",
  [Language.SW_RW]: "sw-RW",
  [Language.SW_TZ]: "sw-TZ",
  [Language.SW_UG]: "sw-UG",
  // Swedish
  [Language.SV]: "sv-SE",
  [Language.SV_SE]: "sv-SE",
  // Tagalog/Filipino
  [Language.TL]: "tl-PH",
  [Language.FIL]: "tl-PH", // Filipino maps to Tagalog
  [Language.FIL_PH]: "tl-PH",
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
  // Uzbek
  [Language.UZ]: "uz-UZ",
  [Language.UZ_UZ]: "uz-UZ",
  // Vietnamese
  [Language.VI]: "vi-VN",
  [Language.VI_VN]: "vi-VN",
  // Welsh
  [Language.CY]: "cy-WL", // AWS uses cy-WL rather than the BCP 47 cy-GB
  [Language.CY_GB]: "cy-WL",
  // Zulu
  [Language.ZU]: "zu-ZA",
  [Language.ZU_ZA]: "zu-ZA",
};

/**
 * AWS Transcribe Speech-to-Text service using WebSocket streaming.
 *
 * Provides real-time speech transcription using AWS Transcribe's streaming API.
 * Supports multiple languages, configurable sample rates, and both interim and
 * final transcription results.
 */
export class AWSTranscribeSTTService extends WebsocketSTTService {
  static Settings: typeof AWSTranscribeSTTSettings = AWSTranscribeSTTSettings;
  declare protected _settings: AWSTranscribeSTTSettings;

  static {
    installTracedStt(AWSTranscribeSTTService.prototype, "_handleTranscription");
  }

  protected _mediaEncoding: string;
  protected _numberOfChannels: number;
  protected _showSpeakerLabel: boolean;
  protected _enableChannelIdentification: boolean;
  protected _awsSession: AWSSession;
  protected _endpointUrl: string | null;
  protected _receiveTask: Task<unknown> | null;

  /**
   * Treat rejected credentials as recoverable.
   *
   * Every connection is signed afresh, so a rejected signature can be an
   * expired one rather than a misconfigured service, and reconnecting is
   * what clears it.
   */
  protected override _classifyError(exception: unknown): ErrorCategory | null {
    const status = extractHttpStatusCode(exception);
    if (status === 401 || status === 403) {
      return ErrorCategory.CONNECTIVITY;
    }
    return null;
  }

  /**
   * Initialize the AWS Transcribe STT service.
   *
   * @param options.apiKey AWS secret access key. If null, falls back to
   *   environment variables and `credentialsProvider`.
   * @param options.awsAccessKeyId AWS access key ID. Same fallback behaviour as `apiKey`.
   * @param options.awsSessionToken AWS session token for temporary credentials.
   * @param options.region AWS region for the service.
   * @param options.sampleRate Audio sample rate in Hz. If null, uses the
   *   pipeline sample rate. AWS Transcribe only supports 8000 or 16000 Hz;
   *   other values are clamped to 16000 Hz at connect time.
   * @param options.settings Runtime-updatable settings.
   * @param options.ttfsP99Latency P99 latency from speech end to final
   *   transcript in seconds. Override for your deployment. See
   *   https://github.com/pipecat-ai/stt-benchmark
   *   Other options are passed to the parent STTService class.
   */
  constructor(options: AWSTranscribeSTTServiceOptions = {}) {
    // 1. Initialize default_settings with hardcoded defaults
    const defaultSettings = new (new.target as typeof AWSTranscribeSTTService).Settings({
      model: null,
      language: Language.EN,
      partialResultsStability: "high",
    });

    // 2. Apply settings delta (canonical API, always wins)
    if (options.settings !== undefined && options.settings !== null) {
      defaultSettings.applyUpdate(options.settings);
    }

    super({
      ...options,
      sampleRate: options.sampleRate ?? null,
      ttfsP99Latency:
        options.ttfsP99Latency === undefined ? AWS_TRANSCRIBE_TTFS_P99 : options.ttfsP99Latency,
      settings: defaultSettings,
    });

    // Init-only connection config (not runtime-updatable).
    this._mediaEncoding = "linear16";
    this._numberOfChannels = 1;
    this._showSpeakerLabel = false;
    this._enableChannelIdentification = false;

    // Explicit or environment keys. Without them, each connection is signed
    // with keys from `credentialsProvider` (see `_signingCredentials`).
    this._awsSession = AWSSession.fromOptions({
      awsAccessKeyId: options.awsAccessKeyId,
      awsSecretAccessKey: options.apiKey,
      awsSessionToken: options.awsSessionToken,
      region: options.region,
      credentialsProvider: options.credentialsProvider,
      fetch: options.fetch,
    });
    this._endpointUrl = options.endpointUrl ?? null;

    this._receiveTask = null;
  }

  /**
   * Check if this service can generate processing metrics.
   *
   * @returns True, as AWS Transcribe STT supports metrics generation.
   */
  override canGenerateMetrics(): boolean {
    return true;
  }

  /**
   * Convert internal encoding format to AWS Transcribe format.
   *
   * @param encoding Internal encoding format string.
   * @returns AWS Transcribe compatible encoding format.
   */
  getServiceEncoding(encoding: string): string {
    const encodingMap: Record<string, string> = {
      linear16: "pcm", // AWS expects "pcm" for 16-bit linear PCM
    };
    return encodingMap[encoding] ?? encoding;
  }

  /** Apply a settings delta and reconnect if anything changed. */
  protected override async _updateSettings(delta: STTSettings): Promise<Record<string, unknown>> {
    const changed = await super._updateSettings(delta);

    if (Object.keys(changed).length > 0 && this._websocket) {
      await this._disconnect();
      await this._connect();
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

  /**
   * Stop the service and disconnect from AWS Transcribe.
   *
   * @param frame End frame signaling service shutdown.
   */
  override async stop(frame: EndFrame): Promise<void> {
    await super.stop(frame);
    await this._disconnect();
  }

  /**
   * Cancel the service and disconnect from AWS Transcribe.
   *
   * @param frame Cancel frame signaling service cancellation.
   */
  override async cancel(frame: CancelFrame): Promise<void> {
    await super.cancel(frame);
    await this._disconnect();
  }

  /**
   * Process audio data and send to AWS Transcribe.
   *
   * @param audio Raw audio bytes to transcribe.
   * @yields ErrorFrame if processing fails or connection issues occur.
   */
  override async *runStt(audio: Uint8Array): AsyncGenerator<Frame | null, void, unknown> {
    if (this._websocket && this._websocket.state === State.OPEN) {
      let error: unknown = null;
      try {
        // Format the audio data according to AWS event stream format
        const eventMessage = buildEventMessage(audio);

        // Send the formatted event message
        await this._websocket.send(eventMessage);
      } catch (e) {
        rethrowIfCancelled(e);
        error = e;
      }
      if (error !== null) {
        yield new ErrorFrame({ error: `Error sending audio: ${errorMessage(error)}` });
      }
    }

    yield null;
  }

  /**
   * Connect to the AWS Transcribe service.
   *
   * Establishes websocket connection and starts receive task.
   */
  override async _connect(): Promise<void> {
    await super._connect();

    await this._connectWebsocket();

    // Started even when the connection failed: with no socket the receive
    // loop goes straight to its reconnect path, which retries the connect.
    if (!this._receiveTask) {
      this._receiveTask = this.createTask(() =>
        this._receiveTaskHandler((error, options) => this._reportError(error, options)),
      );
    }
  }

  /**
   * Disconnect from the AWS Transcribe service.
   *
   * Sends end-stream message and cleans up.
   */
  override async _disconnect(): Promise<void> {
    await super._disconnect();

    if (this._receiveTask) {
      await this.cancelTask(this._receiveTask);
      this._receiveTask = null;
    }

    // Send end-stream message before closing
    if (this._websocket && this._websocket.state === State.OPEN) {
      try {
        const endStream = { "message-type": "event", event: "end" };
        await this._websocket.send(pyJsonDumps(endStream));
      } catch (e) {
        rethrowIfCancelled(e);
        await this.pushError(`Error sending end-stream: ${errorMessage(e)}`, { exception: e });
      }
    }

    await this._disconnectWebsocket();
  }

  /**
   * Return the keys to sign the next connection's URL with.
   *
   * Keys passed in or set in the environment are used as given. Otherwise
   * they come from `credentialsProvider`, which is called for every
   * connection, so each one is signed with current keys.
   *
   * @throws Error If no keys are passed in, set in the environment, or
   *   returned by the provider.
   */
  async _signingCredentials(): Promise<{
    access_key: string | null;
    secret_key: string | null;
    session_token: string | null;
  }> {
    const creds = this._awsSession.credentials;
    if (creds.accessKey || creds.secretKey) {
      return {
        access_key: creds.accessKey,
        secret_key: creds.secretKey,
        session_token: creds.sessionToken,
      };
    }

    const provided = await this._awsSession.getCredentials();
    return {
      access_key: provided.accessKeyId,
      secret_key: provided.secretAccessKey,
      session_token: provided.sessionToken ?? null,
    };
  }

  /** Establish the websocket connection to AWS Transcribe. */
  override async _connectWebsocket(): Promise<void> {
    try {
      if (this._websocket && this._websocket.state === State.OPEN) {
        return;
      }

      logger.debug("Connecting to AWS Transcribe WebSocket");

      const languageCode = assertGiven(this._settings.language);
      if (!languageCode) {
        throw new Error(`Unsupported language: ${languageCode}`);
      }

      // Validate sample rate — AWS Transcribe only supports 8000 or 16000 Hz
      let connectSampleRate = this.sampleRate;
      if (connectSampleRate !== 8000 && connectSampleRate !== 16000) {
        logger.warning(
          `AWS Transcribe only supports 8000 Hz or 16000 Hz sample rates. Converting from ${connectSampleRate} Hz to 16000 Hz.`,
        );
        connectSampleRate = 16000;
      }

      // Add required headers
      const additionalHeaders = {
        Origin: "https://localhost",
      };

      // Get presigned URL
      const region = this._awsSession.region;
      let presignedUrl = await getPresignedUrl({
        region,
        credentials: await this._signingCredentials(),
        languageCode: String(languageCode),
        mediaEncoding: this.getServiceEncoding(this._mediaEncoding), // Convert to AWS format
        sampleRate: connectSampleRate,
        numberOfChannels: this._numberOfChannels,
        enablePartialResultsStabilization: true,
        partialResultsStability: assertGiven(this._settings.partialResultsStability),
        showSpeakerLabel: this._showSpeakerLabel,
        enableChannelIdentification: this._enableChannelIdentification,
      });
      if (this._endpointUrl) {
        const awsEndpoint = `wss://transcribestreaming.${region}.amazonaws.com:8443`;
        presignedUrl =
          this._endpointUrl.replace(/\/+$/, "") + presignedUrl.slice(awsEndpoint.length);
      }

      logger.debug(`${this} Connecting to WebSocket with URL: ${presignedUrl.slice(0, 100)}...`);

      // Connect with the required headers and settings
      this._websocket = await this._websocketConnect(presignedUrl, {
        additionalHeaders,
        subprotocols: ["mqtt"],
      });

      await this._callEventHandler("on_connected");
      logger.info(`${this} Successfully connected to AWS Transcribe`);
    } catch (e) {
      rethrowIfCancelled(e);
      this._websocket = null;
      await this.pushError(`Unable to connect to AWS Transcribe: ${errorMessage(e)}`, {
        exception: e,
      });
    }
  }

  /** Close the websocket connection to AWS Transcribe. */
  override async _disconnectWebsocket(): Promise<void> {
    try {
      if (this._websocket) {
        logger.debug("Disconnecting from AWS Transcribe WebSocket");
        await this._websocket.close();
      }
    } catch (e) {
      rethrowIfCancelled(e);
      await this.pushError(`Error closing websocket: ${errorMessage(e)}`, { exception: e });
    } finally {
      this._websocket = null;
      await this._callEventHandler("on_disconnected");
    }
  }

  /**
   * Convert internal language enum to AWS Transcribe language code.
   *
   * Source: https://docs.aws.amazon.com/transcribe/latest/dg/supported-languages.html
   *
   * @param language Internal language enumeration value.
   * @returns AWS Transcribe compatible language code, or null if unsupported.
   */
  override languageToServiceLanguage(language: Language): string | null {
    return resolveLanguage(language, LANGUAGE_MAP, false);
  }

  protected async _handleTranscription(
    _transcript: string,
    _isFinal: boolean,
    _language: string | null = null,
  ): Promise<void> {}

  /**
   * Get the current WebSocket connection.
   *
   * @returns The WebSocket connection.
   * @throws Error If WebSocket is not connected.
   */
  protected _getWebsocket(): WebsocketClientConnection {
    if (this._websocket) {
      return this._websocket;
    }
    throw new Error("Websocket not connected");
  }

  /**
   * Receive and process websocket messages.
   *
   * Continuously processes messages from the websocket connection.
   */
  override async _receiveMessages(): Promise<void> {
    for await (const response of this._getWebsocket()) {
      try {
        const bytes = typeof response === "string" ? new TextEncoder().encode(response) : response;
        const [headers, rawPayload] = decodeEvent(bytes);
        const payload = (rawPayload ?? {}) as Dict;

        if (headers[":message-type"] === "event") {
          // Process transcription results
          const results = (payload.Transcript?.Results ?? []) as Dict[];
          if (results.length > 0) {
            const result = results[0] as Dict;
            const alternatives = (result.Alternatives ?? []) as Dict[];
            if (alternatives.length > 0) {
              const transcript = String((alternatives[0] as Dict).Transcript ?? "");
              const isFinal = !(result.IsPartial ?? true);

              if (transcript) {
                const language = assertGiven(this._settings.language) as Language | null;
                if (isFinal) {
                  // Report usage before the transcription frame so tracing
                  // can attach it to the STT span the frame closes.
                  await this.emitSttUsageMetrics();
                  await this.pushFrame(
                    new TranscriptionFrame({
                      text: transcript,
                      userId: this._userId,
                      timestamp: timeNowIso8601(),
                      language,
                      result,
                    }),
                  );
                  await this._handleTranscription(transcript, isFinal, language);
                } else {
                  await this.pushFrame(
                    new InterimTranscriptionFrame({
                      text: transcript,
                      userId: this._userId,
                      timestamp: timeNowIso8601(),
                      language,
                      result,
                    }),
                  );
                }
              }
            }
          }
        } else if (headers[":message-type"] === "exception") {
          const errorMsg = payload.Message ?? "Unknown error";
          await this.pushError(`AWS Transcribe error: ${errorMsg}`);
        } else {
          logger.debug(`${this} Other message type received: ${pyJsonDumps(headers)}`);
          logger.debug(`${this} Payload: ${pyJsonDumps(payload)}`);
        }
      } catch (e) {
        rethrowIfCancelled(e);
        logger.warning(`Error processing message: ${errorMessage(e)}`);
      }
    }
  }
}
