// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/services/azure/tts.py

/**
 * Azure Cognitive Services Text-to-Speech service implementations.
 *
 * Porting notes:
 * - DIVERGENCE: upstream synthesizes through the Azure Speech SDK
 *   (`azure-cognitiveservices-speech`), a native library. Here
 *   `AzureTTSService` speaks the Speech service's WebSocket synthesis
 *   protocol directly (the one the SDKs use, see `speech_protocol.ts`), and
 *   `AzureHttpTTSService` calls the REST endpoint
 *   (`/cognitiveservices/v1`) with `fetch`. Both run on Bun, Node, Deno and
 *   Cloudflare Workers.
 * - The SDK callbacks upstream runs on native threads (`_handleSynthesizing`,
 *   `_handleWordBoundary`, `_handleCompleted`, `_handleCanceled`) are called
 *   from the service's receive task, with event objects shaped like the SDK's
 *   (camelCase). They hand items to the run loop with `putNowait`, which wakes
 *   a parked getter like upstream's `run_coroutine_threadsafe(queue.put(...))`.
 * - The completed event's `audioDuration` is computed from the PCM bytes
 *   received (the SDK computes it the same way).
 * - DIVERGENCE: on interruption upstream calls the SDK's
 *   `stop_speaking_async()`. Here the synthesis connection is closed (it
 *   reopens on the next synthesis), which stops the service from sending more
 *   audio and word boundaries for the interrupted request.
 * - DIVERGENCE: `AzureHttpTTSService` requests a `raw-*-16bit-mono-pcm`
 *   format, which has no WAV header, so there are no 44 header bytes to strip
 *   as upstream does with the SDK's RIFF result.
 * - `setup()` builds `_speechConfig`, a plain record of the endpoint and
 *   output format (upstream: the SDK's `SpeechConfig`); there is no
 *   `SpeechSynthesizer` object.
 * - Deprecated APIs are not ported: `AzureBaseTTSService.InputParams`, and the
 *   `voice`, `params` and `aggregateSentences` constructor options.
 */

import {
  abortable,
  CancelledError,
  currentSignal,
  Queue,
  rethrowIfCancelled,
  type Task,
} from "@pipedog/asyncio";
import {
  type CancelFrame,
  type EndFrame,
  ErrorFrame,
  type Frame,
  InterruptionFrame,
  type StartFrame,
  TTSAudioRawFrame,
  TTSStoppedFrame,
} from "@pipedog/core/frames/frames";
import { FrameDirection, type FrameProcessorSetup } from "@pipedog/core/processors/frame_processor";
import { TTSSettings, type TTSSettingsOptions } from "@pipedog/core/services/settings";
import { TTSService, type TTSServiceOptions } from "@pipedog/core/services/tts_service";
import {
  type WebsocketClientConnection,
  type WebsocketConnectOptions,
  websocketConnect,
} from "@pipedog/core/services/websocket_service";
import type { Language } from "@pipedog/core/transcriptions/language";
import { logger } from "@pipedog/core/utils/logger";
import { pyJsonDumps, pyJsonLoads } from "@pipedog/core/utils/py_json";
import { installTracedTts } from "@pipedog/core/utils/tracing/service_decorators";
import { assertGiven, NOT_GIVEN, type NotGiven } from "@pipedog/core/utils/types";
import { languageToAzureLanguage } from "./common.ts";
import {
  buildTextMessage,
  createNoDashGuid,
  getRedirectUrlFromEndpoint,
  parseSpeechMessage,
  speechConfigBody,
  speechHostSuffix,
  withQuery,
} from "./speech_protocol.ts";

type Dict = Record<string, any>;

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * The SDK's `SpeechSynthesisOutputFormat` values pipedog requests: raw 16-bit
 * mono PCM, as the service names them.
 */
export const SpeechSynthesisOutputFormat = {
  Raw8Khz16BitMonoPcm: "raw-8khz-16bit-mono-pcm",
  Raw16Khz16BitMonoPcm: "raw-16khz-16bit-mono-pcm",
  Raw22050Hz16BitMonoPcm: "raw-22050hz-16bit-mono-pcm",
  Raw24Khz16BitMonoPcm: "raw-24khz-16bit-mono-pcm",
  Raw44100Hz16BitMonoPcm: "raw-44100hz-16bit-mono-pcm",
  Raw48Khz16BitMonoPcm: "raw-48khz-16bit-mono-pcm",
} as const;
export type SpeechSynthesisOutputFormat =
  (typeof SpeechSynthesisOutputFormat)[keyof typeof SpeechSynthesisOutputFormat];

/** The SDK's `CancellationReason`. */
export const CancellationReason = {
  Error: "Error",
  EndOfStream: "EndOfStream",
  CancelledByUser: "CancelledByUser",
} as const;
export type CancellationReason = (typeof CancellationReason)[keyof typeof CancellationReason];

/**
 * Convert sample rate to Azure speech synthesis output format.
 *
 * @param sampleRate Sample rate in Hz.
 * @returns Corresponding output format. Defaults to Raw24Khz16BitMonoPcm if
 *   sample rate not found.
 */
export function sampleRateToOutputFormat(sampleRate: number): SpeechSynthesisOutputFormat {
  const sampleRateMap: Record<number, SpeechSynthesisOutputFormat> = {
    8000: SpeechSynthesisOutputFormat.Raw8Khz16BitMonoPcm,
    16000: SpeechSynthesisOutputFormat.Raw16Khz16BitMonoPcm,
    22050: SpeechSynthesisOutputFormat.Raw22050Hz16BitMonoPcm,
    24000: SpeechSynthesisOutputFormat.Raw24Khz16BitMonoPcm,
    44100: SpeechSynthesisOutputFormat.Raw44100Hz16BitMonoPcm,
    48000: SpeechSynthesisOutputFormat.Raw48Khz16BitMonoPcm,
  };
  return sampleRateMap[sampleRate] ?? SpeechSynthesisOutputFormat.Raw24Khz16BitMonoPcm;
}

export interface AzureTTSSettingsOptions extends TTSSettingsOptions {
  /** Audio effect processor (SSML's `effect` attribute on `<voice>`). */
  effect?: string | null | NotGiven;
  /** Emphasis level for speech ("strong", "moderate", "reduced"). */
  emphasis?: string | null | NotGiven;
  /** Wrap synthesized text in SSML's `<lang xml:lang>`. */
  forceLocale?: boolean | NotGiven;
  /** Voice pitch adjustment (e.g., "+10%", "-5Hz", "high"). */
  pitch?: string | null | NotGiven;
  /** Speech rate adjustment (e.g., "1.0", "1.25", "slow", "fast"). */
  rate?: string | null | NotGiven;
  /** Voice role for expression (e.g., "YoungAdultFemale"). */
  role?: string | null | NotGiven;
  /** Speaking style (e.g., "cheerful", "sad", "excited"). */
  style?: string | null | NotGiven;
  /** Intensity of the speaking style (0.01 to 2.0). */
  styleDegree?: string | null | NotGiven;
  /** Model parameters for HD voices (SSML's `parameters` attribute). */
  voiceParameters?: string | null | NotGiven;
  /** Volume level (e.g., "+20%", "loud", "x-soft"). */
  volume?: string | null | NotGiven;
}

/**
 * Settings for AzureTTSService and AzureHttpTTSService.
 *
 * - `effect`: audio effect processor that compensates for playback distortion
 *   on a target device, as SSML's `effect` attribute on `<voice>`: "eq_car"
 *   for enclosed vehicles, "eq_telecomhp8k" for narrowband telephony (pair it
 *   with an 8 kHz pipeline, or the output is not optimized). Azure ignores an
 *   unrecognized value.
 * - `emphasis`: emphasis level for speech ("strong", "moderate", "reduced").
 * - `forceLocale`: wrap synthesized text in SSML's `<lang xml:lang>` so the
 *   voice speaks in the configured `language` rather than the one it
 *   auto-detects from the text. Multilingual voices (e.g.
 *   `en-US-EmmaMultilingualNeural`) use this to pin an accent; standard,
 *   single-locale voices ignore the element. Enabling it also disables
 *   per-segment language switching, so mixed-language text is spoken entirely
 *   in the configured locale. A multilingual voice synthesizes no audio at all
 *   for a locale outside the set it speaks, so pair this with a `language` the
 *   voice supports. Defaults to false.
 * - `pitch`: voice pitch adjustment (e.g., "+10%", "-5Hz", "high").
 * - `rate`: speech rate adjustment (e.g., "1.0", "1.25", "slow", "fast").
 * - `role`: voice role for expression (e.g., "YoungAdultFemale").
 * - `style`: speaking style (e.g., "cheerful", "sad", "excited").
 * - `styleDegree`: intensity of the speaking style (0.01 to 2.0).
 * - `voiceParameters`: model parameters for HD voices, as SSML's
 *   semicolon-separated `parameters` attribute on `<voice>` (e.g.
 *   "temperature=0.7;top_p=0.8;top_k=22;cfg_scale=1.4", or
 *   "enhancePronunciation=true"). Which keys apply depends on the voice's base
 *   model; standard neural voices ignore the attribute.
 * - `volume`: volume level (e.g., "+20%", "loud", "x-soft").
 */
export class AzureTTSSettings extends TTSSettings {
  effect: string | null | NotGiven = NOT_GIVEN;
  emphasis: string | null | NotGiven = NOT_GIVEN;
  forceLocale: boolean | NotGiven = NOT_GIVEN;
  pitch: string | null | NotGiven = NOT_GIVEN;
  rate: string | null | NotGiven = NOT_GIVEN;
  role: string | null | NotGiven = NOT_GIVEN;
  style: string | null | NotGiven = NOT_GIVEN;
  styleDegree: string | null | NotGiven = NOT_GIVEN;
  voiceParameters: string | null | NotGiven = NOT_GIVEN;
  volume: string | null | NotGiven = NOT_GIVEN;

  constructor(options: AzureTTSSettingsOptions = {}) {
    super(options);
    this._assignOptions(options);
  }
}

// Define SSML escape mappings based on SSML reserved characters
// See - https://learn.microsoft.com/en-us/azure/ai-services/speech-service/speech-synthesis-markup-structure
const SSML_ESCAPE_CHARS: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&apos;",
};

/**
 * The SDK's `SpeechConfig`, reduced to what the services send: where to
 * connect and in which format.
 *
 * DIVERGENCE: a plain record; upstream builds the SDK's `SpeechConfig`.
 */
export interface AzureSynthesisConfig {
  /** Azure Cognitive Services subscription key. */
  subscription: string;
  /** Azure region, or null with a private endpoint. */
  region: string | null;
  /** Private endpoint URL, or null. */
  endpoint: string | null;
  /** Synthesis language, or null. */
  speechSynthesisLanguage: string | null;
  /** The requested audio format. */
  outputFormat: SpeechSynthesisOutputFormat;
}

/**
 * Build the SSML for `text` from the service's settings.
 *
 * Shared by both Azure TTS services (upstream's `AzureBaseTTSService` mixin).
 */
function constructSsml(settings: AzureTTSSettings, text: string): string {
  const language = settings.language;

  // Escape special characters
  const escapedText = escapeText(text);

  let voiceAttrs = `name='${settings.voice}'`;
  if (settings.effect) {
    voiceAttrs += ` effect='${settings.effect}'`;
  }
  if (settings.voiceParameters) {
    voiceAttrs += ` parameters='${settings.voiceParameters}'`;
  }

  let ssml =
    `<speak version='1.0' xml:lang='${language}' ` +
    "xmlns='http://www.w3.org/2001/10/synthesis' " +
    "xmlns:mstts='http://www.w3.org/2001/mstts'>" +
    `<voice ${voiceAttrs}>` +
    "<mstts:silence type='Sentenceboundary' value='20ms' />";

  if (settings.forceLocale) {
    ssml += `<lang xml:lang='${language}'>`;
  }

  if (settings.style) {
    ssml += `<mstts:express-as style='${settings.style}'`;
    if (settings.styleDegree) {
      ssml += ` styledegree='${settings.styleDegree}'`;
    }
    if (settings.role) {
      ssml += ` role='${settings.role}'`;
    }
    ssml += ">";
  }

  const prosodyAttrs: string[] = [];
  if (settings.rate) {
    prosodyAttrs.push(`rate='${settings.rate}'`);
  }
  if (settings.pitch) {
    prosodyAttrs.push(`pitch='${settings.pitch}'`);
  }
  if (settings.volume) {
    prosodyAttrs.push(`volume='${settings.volume}'`);
  }

  // Only wrap in prosody tag if there are prosody attributes
  if (prosodyAttrs.length > 0) {
    ssml += `<prosody ${prosodyAttrs.join(" ")}>`;
  }

  if (settings.emphasis) {
    ssml += `<emphasis level='${settings.emphasis}'>`;
  }

  ssml += escapedText;

  if (settings.emphasis) {
    ssml += "</emphasis>";
  }

  if (prosodyAttrs.length > 0) {
    ssml += "</prosody>";
  }

  if (settings.style) {
    ssml += "</mstts:express-as>";
  }

  if (settings.forceLocale) {
    ssml += "</lang>";
  }

  ssml += "</voice></speak>";

  return ssml;
}

/**
 * Escapes XML/SSML reserved characters according to Microsoft documentation.
 *
 * `&` → `&amp;`, `<` → `&lt;`, `>` → `&gt;`, `"` → `&quot;`, `'` → `&apos;`.
 *
 * @param text The text to escape.
 * @returns The escaped text.
 */
function escapeText(text: string): string {
  let escapedText = text;
  for (const [char, escapeCode] of Object.entries(SSML_ESCAPE_CHARS)) {
    escapedText = escapedText.replaceAll(char, escapeCode);
  }
  return escapedText;
}

/** Options shared by both Azure TTS services. */
export interface AzureBaseTTSServiceOptions extends TTSServiceOptions {
  /** Azure Cognitive Services subscription key. */
  apiKey: string;
  /**
   * Azure region identifier (e.g., "eastus", "westus2"). Required unless
   * `privateEndpoint` is provided.
   */
  region?: string | null;
  /**
   * Custom endpoint URL for Azure Speech Services (e.g.,
   * "https://my-resource.cognitiveservices.azure.com/"). Use this when
   * connecting via Private Link or a custom domain. See
   * https://learn.microsoft.com/en-us/azure/ai-services/speech-service/speech-services-private-link
   */
  privateEndpoint?: string | null;
  /** Runtime-updatable settings. */
  settings?: AzureTTSSettings | null;
  /**
   * `fetch` used for HTTP requests (the REST synthesis, and the
   * custom-domain redirect lookup). Defaults to the global `fetch`. Not in
   * upstream.
   */
  fetch?: typeof fetch | null;
}

function defaultAzureTTSSettings(cls: { Settings: typeof AzureTTSSettings }): AzureTTSSettings {
  // 1. Initialize default_settings with hardcoded defaults
  return new cls.Settings({
    model: null,
    voice: "en-US-SaraNeural",
    language: "en-US",
    effect: null,
    emphasis: null,
    forceLocale: false,
    pitch: null,
    rate: null,
    role: null,
    style: null,
    styleDegree: null,
    voiceParameters: null,
    volume: null,
  });
}

function checkRegion(region: string | null, privateEndpoint: string | null): void {
  if (!region && !privateEndpoint) {
    throw new Error("Either 'region' or 'private_endpoint' must be provided.");
  }
  if (region && privateEndpoint) {
    logger.warning("Both 'region' and 'private_endpoint' provided; 'region' will be ignored.");
  }
}

/** An SDK-shaped synthesizing event: `evt.result.audioData` is a PCM chunk. */
export interface SynthesisAudioEvent {
  result: { audioData: Uint8Array | null } | null;
}

/** An SDK-shaped completed event: `evt.result.audioDuration` in seconds. */
export interface SynthesisCompletedEvent {
  result: { audioDuration: number | null } | null;
}

/** An SDK-shaped canceled event. */
export interface SynthesisCanceledEvent {
  result: {
    cancellationDetails: { reason: CancellationReason; errorDetails: string | null };
  };
}

/** An SDK-shaped word boundary event: `audioOffset` in ticks (100 ns). */
export interface SynthesisWordBoundaryEvent {
  text: string;
  audioOffset: number;
}

/** Item on the audio queue: a chunk, an error, or null for the end of the stream. */
type AudioQueueItem = Uint8Array | Error | null;
/** Item on the word queue: a word and its time, or null for completion. */
type WordQueueItem = readonly [string, number] | null;

export interface AzureTTSServiceOptions extends AzureBaseTTSServiceOptions {
  /**
   * Creates the underlying `WebSocket`, to open it some other way. Defaults to
   * `websocketConnect`'s. Not in upstream.
   */
  webSocketFactory?: WebsocketConnectOptions["webSocketFactory"];
}

/**
 * Azure Cognitive Services streaming TTS service with word timestamps.
 *
 * Provides real-time text-to-speech synthesis using Azure's WebSocket-based
 * streaming API. Audio chunks and word boundaries are streamed as they become
 * available for lower latency playback and accurate word-level
 * synchronization.
 */
export class AzureTTSService extends TTSService {
  static Settings: typeof AzureTTSSettings = AzureTTSSettings;
  declare protected _settings: AzureTTSSettings;

  /** The synthesis path the SDK connects to. */
  static readonly SYNTHESIS_URI = "/tts/cognitiveservices/websocket/v1";

  static {
    installTracedTts(AzureTTSService.prototype, "runTts");
  }

  protected _apiKey: string;
  protected _region: string | null;
  protected _privateEndpoint: string | null;
  protected _fetch: typeof fetch;
  protected _webSocketFactory: WebsocketConnectOptions["webSocketFactory"];
  protected _speechConfig: AzureSynthesisConfig | null = null;
  protected _websocket: WebsocketClientConnection | null = null;
  protected _receiveTask: Task<unknown> | null = null;
  // The request being synthesized, and its audio stream id.
  protected _currentRequestId: string | null = null;
  protected _currentStreamId: string | null = null;
  protected _currentRequestBytes = 0;

  _audioQueue = new Queue<AudioQueueItem>();
  _wordBoundaryQueue = new Queue<WordQueueItem>();
  protected _wordProcessorTask: Task<unknown> | null = null;
  protected _cumulativeAudioOffset = 0.0; // Cumulative audio duration in seconds
  protected _currentSentenceBaseOffset = 0.0; // Base offset for current sentence
  protected _currentSentenceDuration = 0.0; // Duration from Azure callback
  // Max word boundary offset seen in current sentence (for 8kHz workaround)
  protected _currentSentenceMaxWordOffset = 0.0;
  protected _lastWord: string | null = null; // Track last word for punctuation merging
  protected _lastTimestamp: number | null = null; // Track last timestamp
  protected _currentContextId: string | null = null; // Track current context_id for word timestamps

  /**
   * Initialize the Azure streaming TTS service.
   *
   * @param options.apiKey Azure Cognitive Services subscription key.
   * @param options.region Azure region identifier (e.g., "eastus",
   *   "westus2"). Required unless `privateEndpoint` is provided.
   * @param options.privateEndpoint Custom endpoint URL for Azure Speech
   *   Services (Private Link or a custom domain).
   * @param options.sampleRate Audio sample rate in Hz. If null, uses service
   *   default.
   * @param options.settings Runtime-updatable settings.
   * @param options.textAggregationMode How to aggregate text before synthesis.
   *   Other options are passed to the parent TTSService.
   * @throws Error (ValueError) if neither `region` nor `privateEndpoint` is
   *   given.
   */
  constructor(options: AzureTTSServiceOptions) {
    const defaultSettings = defaultAzureTTSSettings(new.target as typeof AzureTTSService);

    // 4. Apply settings delta (canonical API, always wins)
    if (options.settings !== undefined && options.settings !== null) {
      defaultSettings.applyUpdate(options.settings);
    }

    super({
      ...options,
      pushTextFrames: false, // We'll push text frames based on word timestamps
      pushStopFrames: true,
      pushStartFrame: true,
      pauseFrameProcessing: true,
      sampleRate: options.sampleRate ?? null,
      settings: defaultSettings,
    });

    const region = options.region ?? null;
    const privateEndpoint = options.privateEndpoint ?? null;
    checkRegion(region, privateEndpoint);

    this._apiKey = options.apiKey;
    this._region = region;
    this._privateEndpoint = privateEndpoint;
    this._fetch = options.fetch ?? (((input, init) => fetch(input, init)) as typeof fetch);
    this._webSocketFactory = options.webSocketFactory ?? null;
  }

  /**
   * Convert a Language enum to Azure language format.
   *
   * @param language The language to convert.
   * @returns The Azure-specific language code.
   */
  override languageToServiceLanguage(language: Language): string | null {
    return languageToAzureLanguage(language);
  }

  /** Build the SSML for `text` from the current settings. */
  _constructSsml(text: string): string {
    return constructSsml(this._settings, text);
  }

  /** Escape XML/SSML reserved characters. */
  _escapeText(text: string): string {
    return escapeText(text);
  }

  /**
   * Check if this service can generate processing metrics.
   *
   * @returns True, as Azure TTS service supports metrics generation.
   */
  override canGenerateMetrics(): boolean {
    return true;
  }

  /**
   * Set up the service.
   *
   * @param setup Configuration object containing setup parameters.
   */
  override async setup(setup: FrameProcessorSetup): Promise<void> {
    await super.setup(setup);
    // Now this.sampleRate is properly initialized
    this._speechConfig = {
      subscription: this._apiKey,
      region: this._privateEndpoint ? null : this._region,
      endpoint: this._privateEndpoint,
      speechSynthesisLanguage: (assertGiven(this._settings.language) as string | null) || null,
      outputFormat: sampleRateToOutputFormat(this.sampleRate),
    };
  }

  /**
   * Start the Azure TTS service.
   *
   * @param frame Start frame containing initialization parameters.
   */
  override async start(frame: StartFrame): Promise<void> {
    await super.start(frame);
    if (this._speechConfig) {
      this._speechConfig.outputFormat = sampleRateToOutputFormat(this.sampleRate);
    }

    // Start word processor task
    if (!this._wordProcessorTask) {
      this._wordProcessorTask = this.createTask(
        () => this._wordProcessorTaskHandler(),
        "_word_processor_task_handler",
      );
    }
  }

  /**
   * Stop the Azure TTS service.
   *
   * @param frame End frame signaling service stop.
   */
  override async stop(frame: EndFrame): Promise<void> {
    await super.stop(frame);
    await this._stopTasks();
  }

  /**
   * Cancel the Azure TTS service.
   *
   * @param frame Cancel frame signaling service cancellation.
   */
  override async cancel(frame: CancelFrame): Promise<void> {
    await super.cancel(frame);
    await this._stopTasks();
  }

  /** Clean up the Azure TTS service. */
  override async cleanup(): Promise<void> {
    await super.cleanup();
    await this._stopTasks();
  }

  /** Cancel the word processor task and close the connection. Idempotent. */
  protected async _stopTasks(): Promise<void> {
    if (this._wordProcessorTask) {
      await this.cancelTask(this._wordProcessorTask);
      this._wordProcessorTask = null;
    }
    await this._disconnect();
  }

  //
  // Connection (the SDK's SpeechSynthesizer)
  //

  /** The WebSocket URL to synthesize on. */
  protected async _synthesisUrl(): Promise<string> {
    if (this._privateEndpoint) {
      const url = new URL(this._privateEndpoint);
      if (
        url.pathname === "" ||
        url.pathname === "/" ||
        url.pathname.toLowerCase() === AzureTTSService.SYNTHESIS_URI
      ) {
        // The SDK generates the path, and checks for a redirect.
        url.pathname = AzureTTSService.SYNTHESIS_URI;
        const resolved = await getRedirectUrlFromEndpoint(url.toString(), this._fetch);
        return toWebSocketUrl(resolved);
      }
      return toWebSocketUrl(url.toString());
    }
    const region = this._region ?? "";
    return `wss://${region}.tts.speech${speechHostSuffix(region)}${AzureTTSService.SYNTHESIS_URI}`;
  }

  /** Open the synthesis connection (if needed) and send `speech.config`. */
  protected async _connect(): Promise<WebsocketClientConnection> {
    if (this._websocket) {
      return this._websocket;
    }
    const connectionId = createNoDashGuid();
    const headers = {
      "Ocp-Apim-Subscription-Key": this._apiKey,
      "X-ConnectionId": connectionId,
    };
    const url = withQuery(await this._synthesisUrl(), headers);
    logger.debug(`${this}: Connecting to Azure TTS`);
    const websocket = await websocketConnect(url, {
      additionalHeaders: headers,
      webSocketFactory: this._webSocketFactory,
    });
    this._websocket = websocket;
    await websocket.send(
      buildTextMessage(
        "speech.config",
        connectionId,
        "application/json",
        pyJsonDumps(speechConfigBody()),
      ),
    );
    this._receiveTask = this.createTask(
      () => this._receiveTaskHandler(websocket),
      "_receive_task_handler",
    );
    return websocket;
  }

  /** Close the synthesis connection. */
  protected async _disconnect(): Promise<void> {
    const websocket = this._websocket;
    this._websocket = null;
    this._currentRequestId = null;
    if (this._receiveTask) {
      const task = this._receiveTask;
      this._receiveTask = null;
      await this.cancelTask(task);
    }
    if (websocket) {
      try {
        await websocket.close();
      } catch (e) {
        rethrowIfCancelled(e);
        logger.debug(`${this}: error closing websocket: ${errorMessage(e)}`);
      }
    }
  }

  /** Receive messages and dispatch them to the SDK-shaped handlers. */
  protected async _receiveTaskHandler(websocket: WebsocketClientConnection): Promise<void> {
    try {
      for await (const data of websocket) {
        this._handleMessage(data as string | Uint8Array);
      }
      this._onConnectionClosed(websocket, websocket.closeCode ?? 1000, websocket.closeReason ?? "");
    } catch (e) {
      rethrowIfCancelled(e);
      this._onConnectionClosed(
        websocket,
        websocket.closeCode ?? 1006,
        websocket.closeReason || errorMessage(e),
      );
    }
  }

  /** The connection closed: a request in flight is canceled with an error. */
  protected _onConnectionClosed(
    websocket: WebsocketClientConnection,
    code: number,
    reason: string,
  ): void {
    if (this._websocket === websocket) {
      this._websocket = null;
      this._receiveTask = null;
    }
    if (this._currentRequestId !== null) {
      this._currentRequestId = null;
      this._handleCanceled({
        result: {
          cancellationDetails: {
            reason: CancellationReason.Error,
            errorDetails: `${reason} websocket error code: ${code}`,
          },
        },
      });
    }
  }

  /** Dispatch one service message for the request in flight. */
  protected _handleMessage(data: string | Uint8Array): void {
    let message: ReturnType<typeof parseSpeechMessage>;
    try {
      message = parseSpeechMessage(data);
    } catch (e) {
      rethrowIfCancelled(e);
      logger.warning(`${this}: dropping malformed message: ${errorMessage(e)}`);
      return;
    }
    if (
      this._currentRequestId === null ||
      message.requestId.toLowerCase() !== this._currentRequestId.toLowerCase()
    ) {
      return;
    }
    switch (message.path) {
      case "turn.start":
        break;
      case "response": {
        const response = pyJsonLoads(message.text ?? "{}") as Dict;
        this._currentStreamId = response?.audio?.streamId ?? null;
        break;
      }
      case "audio": {
        const streamId = message.headers["x-streamid"];
        if (
          this._currentStreamId !== null &&
          streamId !== undefined &&
          streamId.toLowerCase() !== String(this._currentStreamId).toLowerCase()
        ) {
          break;
        }
        if (message.binary && message.binary.length > 0) {
          this._currentRequestBytes += message.binary.length;
          this._handleSynthesizing({ result: { audioData: message.binary } });
        }
        break;
      }
      case "audio.metadata": {
        const metadata = pyJsonLoads(message.text ?? "{}") as Dict;
        for (const item of (metadata?.Metadata ?? []) as Dict[]) {
          if (item.Type === "WordBoundary") {
            this._handleWordBoundary({
              text: item.Data?.text?.Text ?? "",
              audioOffset: Number(item.Data?.Offset ?? 0),
            });
          }
        }
        break;
      }
      case "turn.end": {
        this._currentRequestId = null;
        // 16-bit mono PCM: two bytes per sample.
        const duration =
          this.sampleRate > 0 ? this._currentRequestBytes / (2 * this.sampleRate) : 0;
        this._handleCompleted({ result: { audioDuration: duration } });
        break;
      }
      default:
        logger.trace(`${this}: unhandled message ${message.path}`);
    }
  }

  /** Send the synthesis request for `ssml`. */
  protected async _speakSsml(ssml: string): Promise<void> {
    const websocket = await this._connect();
    const requestId = createNoDashGuid();
    this._currentRequestId = requestId;
    this._currentStreamId = null;
    this._currentRequestBytes = 0;
    const outputFormat =
      this._speechConfig?.outputFormat ?? sampleRateToOutputFormat(this.sampleRate);
    const context = {
      synthesis: {
        audio: {
          metadataOptions: {
            bookmarkEnabled: false,
            punctuationBoundaryEnabled: true,
            sentenceBoundaryEnabled: false,
            sessionEndEnabled: true,
            visemeEnabled: false,
            wordBoundaryEnabled: true,
          },
          outputFormat,
        },
        language: { autoDetection: false },
      },
    };
    await websocket.send(
      buildTextMessage("synthesis.context", requestId, "application/json", pyJsonDumps(context)),
    );
    await websocket.send(buildTextMessage("ssml", requestId, "application/ssml+xml", ssml));
  }

  //
  // Word boundaries
  //

  /**
   * Check if the configured language is CJK (Chinese, Japanese, Korean).
   *
   * @returns True if the language is CJK, False otherwise.
   */
  protected _isCjkLanguage(): boolean {
    const language = String(assertGiven(this._settings.language) || "").toLowerCase();
    // Check if language starts with CJK language codes
    return ["zh", "ja", "ko", "cmn", "yue", "wuu"].some((code) => language.startsWith(code));
  }

  /**
   * Check if text consists only of punctuation and whitespace.
   *
   * @param text Text to check.
   * @returns True if text is only punctuation/whitespace, False otherwise.
   */
  protected _isPunctuationOnly(text: string): boolean {
    return Boolean(text) && !/[\p{L}\p{N}]/u.test(text);
  }

  /**
   * Handle word boundary events.
   *
   * Azure sends punctuation as separate word boundaries, and breaks CJK text
   * into individual characters/particles. This method routes to
   * language-specific handlers to properly merge and emit word boundaries.
   *
   * @param evt The word boundary, with word text and audio offset timing.
   */
  _handleWordBoundary(evt: SynthesisWordBoundaryEvent): void {
    // evt.text contains the word
    // evt.audioOffset contains timing in ticks (100-nanosecond units)
    // Convert ticks to seconds: divide by 10,000,000
    const word = evt.text;
    const sentenceRelativeSeconds = evt.audioOffset / 10_000_000.0;

    // Use base offset captured at start of runTts to avoid race conditions
    // with callbacks from overlapping TTS requests
    const absoluteSeconds = this._currentSentenceBaseOffset + sentenceRelativeSeconds;

    // Track max word offset for accurate cumulative timing
    // (audio_duration from Azure doesn't always match word boundary offsets at 8kHz)
    if (sentenceRelativeSeconds > this._currentSentenceMaxWordOffset) {
      this._currentSentenceMaxWordOffset = sentenceRelativeSeconds;
    }

    if (!word) {
      return;
    }

    // Route to language-specific handler
    if (this._isCjkLanguage()) {
      this._handleCjkWordBoundary(word, absoluteSeconds);
    } else {
      this._handleNonCjkWordBoundary(word, absoluteSeconds);
    }
  }

  /** Emit the currently buffered word if one exists. */
  protected _emitPendingWord(): void {
    if (this._lastWord !== null) {
      this._wordBoundaryQueue.putNowait([this._lastWord, this._lastTimestamp ?? 0]);
      this._lastWord = null;
      this._lastTimestamp = null;
    }
  }

  /**
   * Handle word boundaries for CJK languages (Chinese, Japanese, Korean).
   *
   * CJK languages don't use spaces between words, so we merge characters
   * together and only emit at natural break points (punctuation or whitespace
   * boundaries). Without this logic, we don't get word output for CJK
   * languages.
   *
   * @param word The word/character from Azure.
   * @param timestamp Timestamp in seconds.
   */
  protected _handleCjkWordBoundary(word: string, timestamp: number): void {
    // First word: just store it
    if (this._lastWord === null) {
      this._lastWord = word;
      this._lastTimestamp = timestamp;
      return;
    }

    // Punctuation: merge and emit (natural break)
    if (this._isPunctuationOnly(word)) {
      this._lastWord += word;
      this._emitPendingWord();
      return;
    }

    // Whitespace: emit before boundary, start new segment
    if (word.trim() !== word) {
      this._emitPendingWord();
      this._lastWord = word;
      this._lastTimestamp = timestamp;
      return;
    }

    // Default: continue merging CJK characters
    this._lastWord += word;
  }

  /**
   * Handle word boundaries for non-CJK languages.
   *
   * Non-CJK languages use spaces between words, so we emit each word
   * separately after merging any trailing punctuation.
   *
   * @param word The word from Azure.
   * @param timestamp Timestamp in seconds.
   */
  protected _handleNonCjkWordBoundary(word: string, timestamp: number): void {
    // Punctuation: merge with previous word (don't emit yet)
    if (this._isPunctuationOnly(word) && this._lastWord !== null) {
      this._lastWord += word;
      return;
    }

    // Regular word: emit previous, store current
    if (this._lastWord !== null) {
      this._wordBoundaryQueue.putNowait([this._lastWord, this._lastTimestamp ?? 0]);
    }
    this._lastWord = word;
    this._lastTimestamp = timestamp;
  }

  /**
   * Process word timestamps from the queue and call addWordTimestamps.
   *
   * Also handles a null sentinel from `_handleCompleted`: once all pending
   * words have been drained, it signals audio stream completion via
   * `_audioQueue` so that runTts exits only after the last word has been
   * processed.
   */
  protected async _wordProcessorTaskHandler(): Promise<void> {
    while (true) {
      try {
        const item = await this._wordBoundaryQueue.get();
        if (item === null) {
          // All words drained — now signal audio completion.
          this._audioQueue.putNowait(null);
        } else {
          const [word, timestampSeconds] = item;
          if (this._currentContextId) {
            await this.addWordTimestamps([[word, timestampSeconds]], this._currentContextId);
          }
        }
        this._wordBoundaryQueue.taskDone();
      } catch (e) {
        if (e instanceof CancelledError) {
          break;
        }
        await this.pushError(`Unknown error occurred: ${errorMessage(e)}`, { exception: e });
      }
    }
  }

  //
  // Synthesis events
  //

  /**
   * Handle audio chunks as they arrive.
   *
   * @param evt Synthesis event containing audio data.
   */
  _handleSynthesizing(evt: SynthesisAudioEvent): void {
    if (evt.result?.audioData && evt.result.audioData.length > 0) {
      this._audioQueue.putNowait(evt.result.audioData);
    }
  }

  /**
   * Handle synthesis completion.
   *
   * @param evt Completion event.
   */
  _handleCompleted(evt: SynthesisCompletedEvent): void {
    // Store duration for cumulative offset calculation
    if (evt.result?.audioDuration) {
      this._currentSentenceDuration = evt.result.audioDuration;
    }

    // Flush any pending word before completing
    if (this._lastWord !== null) {
      this._wordBoundaryQueue.putNowait([this._lastWord, this._lastTimestamp ?? 0]);
      this._lastWord = null;
      this._lastTimestamp = null;
    }

    // Route completion through the word boundary queue so the word processor
    // task drains all pending words before signaling audio stream completion.
    // Without this, the last word's TTSTextFrame may arrive after
    // TTSStoppedFrame, causing it to be missed by observers and the UI.
    this._wordBoundaryQueue.putNowait(null);
  }

  /**
   * Handle synthesis cancellation.
   *
   * @param evt Cancellation event.
   */
  _handleCanceled(evt: SynthesisCanceledEvent): void {
    const reason = evt.result.cancellationDetails.reason;
    // User cancellation (from interruption) is expected, not an error
    if (reason === CancellationReason.CancelledByUser) {
      logger.debug(`${this}: Speech synthesis canceled by user (interruption)`);
      this._audioQueue.putNowait(null);
    } else {
      const details = evt.result.cancellationDetails;
      let errorMsg = `Azure TTS synthesis canceled: CancellationReason.${reason}`;
      if (details.errorDetails) {
        errorMsg += ` - ${details.errorDetails}`;
      }
      this._audioQueue.putNowait(new Error(errorMsg));
    }
  }

  /**
   * Push a frame and handle state changes.
   *
   * @param frame The frame to push.
   * @param direction The direction to push the frame.
   */
  override async pushFrame(
    frame: Frame,
    direction: FrameDirection = FrameDirection.DOWNSTREAM,
  ): Promise<void> {
    await super.pushFrame(frame, direction);
    if (frame instanceof TTSStoppedFrame || frame instanceof InterruptionFrame) {
      this._resetState();
    }
  }

  /** Reset TTS state between turns. */
  protected _resetState(): void {
    this._cumulativeAudioOffset = 0.0;
    this._currentSentenceBaseOffset = 0.0;
    this._currentSentenceDuration = 0.0;
    this._currentSentenceMaxWordOffset = 0.0;
    this._lastWord = null;
    this._lastTimestamp = null;
    this._currentContextId = null;
  }

  /** Flush any pending audio data. */
  override async flushAudio(_contextId: string | null = null): Promise<void> {
    logger.trace(`${this}: flushing audio`);
  }

  /**
   * Handle interruption by stopping current synthesis.
   *
   * @param frame The interruption frame.
   * @param direction Frame processing direction.
   */
  protected override async _handleInterruption(
    frame: InterruptionFrame,
    direction: FrameDirection,
  ): Promise<void> {
    await super._handleInterruption(frame, direction);
    await this.stopAllMetrics();

    // Stop Azure synthesis to prevent more word boundaries from being added.
    // DIVERGENCE: closing the connection stands in for the SDK's
    // stop_speaking_async(); it reopens on the next synthesis.
    if (this._currentRequestId !== null) {
      try {
        this._currentRequestId = null;
        await this._disconnect();
      } catch (e) {
        rethrowIfCancelled(e);
        await this.pushError(`Unknown error occurred: ${errorMessage(e)}`, { exception: e });
      }
    }

    // Reset state on interruption
    this._resetState();
    // Clear the audio queue
    while (!this._audioQueue.empty()) {
      this._audioQueue.getNowait();
      this._audioQueue.taskDone();
    }
    // Clear the word boundary queue
    while (!this._wordBoundaryQueue.empty()) {
      this._wordBoundaryQueue.getNowait();
      this._wordBoundaryQueue.taskDone();
    }
  }

  /**
   * Generate speech from text using Azure's streaming synthesis.
   *
   * @param text The text to synthesize into speech.
   * @param contextId The context ID for tracking audio frames.
   * @returns Audio frames containing synthesized speech data.
   */
  override async *runTts(text: string, contextId: string): AsyncGenerator<Frame | null, void> {
    // Clear the audio queue in case there's still audio in it, causing the
    // next audio response to be cut off by the null element returned at the
    // end of the previous audio synthesis.
    while (!this._audioQueue.empty()) {
      this._audioQueue.getNowait();
      this._audioQueue.taskDone();
    }

    try {
      if (this._speechConfig === null) {
        return;
      }

      try {
        this._currentContextId = contextId;

        // Capture base offset BEFORE starting synthesis to avoid race
        // conditions. Word boundary callbacks will use this value.
        this._currentSentenceBaseOffset = this._cumulativeAudioOffset;
        this._currentSentenceDuration = 0.0;
        this._currentSentenceMaxWordOffset = 0.0;

        const ssml = this._constructSsml(text);
        await this._speakSsml(ssml);
        await this.startTtsUsageMetrics(text);

        // Stream audio chunks as they arrive
        while (true) {
          const chunk = await this._audioQueue.get();
          if (chunk === null) {
            // End of stream
            break;
          }
          if (chunk instanceof Error) {
            // Error from _handleCanceled
            yield new ErrorFrame({ error: chunk.message });
            break;
          }

          yield new TTSAudioRawFrame({
            audio: chunk,
            sampleRate: this.sampleRate,
            numChannels: 1,
            contextId,
          });
        }

        // Update cumulative offset for next sentence
        // At 8kHz, Azure's audio_duration doesn't match word boundary offsets,
        // so we use max_word_offset as a workaround. At other sample rates,
        // audio_duration is accurate.
        // TODO: Remove after Azure fixes word boundary timing at 8kHz
        if (this.sampleRate === 8000) {
          this._cumulativeAudioOffset += this._currentSentenceMaxWordOffset;
        } else {
          this._cumulativeAudioOffset += this._currentSentenceDuration;
        }
      } catch (e) {
        rethrowIfCancelled(e);
        yield new ErrorFrame({ error: `Unknown error occurred: ${errorMessage(e)}` });
        yield new TTSStoppedFrame({ contextId });
        this._resetState();
        return;
      }
    } catch (e) {
      rethrowIfCancelled(e);
      yield new ErrorFrame({ error: `Unknown error occurred: ${errorMessage(e)}` });
    }
  }
}

function toWebSocketUrl(url: string): string {
  if (url.startsWith("https://")) return `wss://${url.slice("https://".length)}`;
  if (url.startsWith("http://")) return `ws://${url.slice("http://".length)}`;
  return url;
}

export interface AzureHttpTTSServiceOptions extends AzureBaseTTSServiceOptions {}

/**
 * Azure Cognitive Services HTTP-based TTS service.
 *
 * Provides text-to-speech synthesis using Azure's HTTP API for simpler,
 * non-streaming synthesis. Suitable for use cases where streaming is not
 * required and simpler integration is preferred.
 */
export class AzureHttpTTSService extends TTSService {
  static Settings: typeof AzureTTSSettings = AzureTTSSettings;
  declare protected _settings: AzureTTSSettings;

  /** The REST synthesis path. */
  static readonly SYNTHESIS_URI = "/cognitiveservices/v1";

  static {
    installTracedTts(AzureHttpTTSService.prototype, "runTts");
  }

  protected _apiKey: string;
  protected _region: string | null;
  protected _privateEndpoint: string | null;
  protected _fetch: typeof fetch;
  protected _speechConfig: AzureSynthesisConfig | null = null;

  /**
   * Initialize the Azure HTTP TTS service.
   *
   * @param options.apiKey Azure Cognitive Services subscription key.
   * @param options.region Azure region identifier (e.g., "eastus",
   *   "westus2"). Required unless `privateEndpoint` is provided.
   * @param options.privateEndpoint Custom endpoint URL for Azure Speech
   *   Services (Private Link or a custom domain).
   * @param options.sampleRate Audio sample rate in Hz. If null, uses service
   *   default.
   * @param options.settings Runtime-updatable settings.
   *   Other options are passed to the parent TTSService.
   * @throws Error (ValueError) if neither `region` nor `privateEndpoint` is
   *   given.
   */
  constructor(options: AzureHttpTTSServiceOptions) {
    const defaultSettings = defaultAzureTTSSettings(new.target as typeof AzureHttpTTSService);

    // 4. Apply settings delta (canonical API, always wins)
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

    const region = options.region ?? null;
    const privateEndpoint = options.privateEndpoint ?? null;
    checkRegion(region, privateEndpoint);

    this._apiKey = options.apiKey;
    this._region = region;
    this._privateEndpoint = privateEndpoint;
    this._fetch = options.fetch ?? (((input, init) => fetch(input, init)) as typeof fetch);
  }

  /**
   * Convert a Language enum to Azure language format.
   *
   * @param language The language to convert.
   * @returns The Azure-specific language code.
   */
  override languageToServiceLanguage(language: Language): string | null {
    return languageToAzureLanguage(language);
  }

  /** Build the SSML for `text` from the current settings. */
  _constructSsml(text: string): string {
    return constructSsml(this._settings, text);
  }

  /** Escape XML/SSML reserved characters. */
  _escapeText(text: string): string {
    return escapeText(text);
  }

  /**
   * Check if this service can generate processing metrics.
   *
   * @returns True, as Azure TTS service supports metrics generation.
   */
  override canGenerateMetrics(): boolean {
    return true;
  }

  /**
   * Set up the service.
   *
   * @param setup Configuration object containing setup parameters.
   */
  override async setup(setup: FrameProcessorSetup): Promise<void> {
    await super.setup(setup);
    this._speechConfig = {
      subscription: this._apiKey,
      region: this._privateEndpoint ? null : this._region,
      endpoint: this._privateEndpoint,
      speechSynthesisLanguage: (assertGiven(this._settings.language) as string | null) || null,
      outputFormat: sampleRateToOutputFormat(this.sampleRate),
    };
  }

  /** The REST URL to synthesize with. */
  protected _synthesisUrl(): string {
    if (this._privateEndpoint) {
      const url = new URL(this._privateEndpoint);
      if (url.pathname === "" || url.pathname === "/") {
        url.pathname = `/tts${AzureHttpTTSService.SYNTHESIS_URI}`;
      }
      return url.toString();
    }
    const region = this._region ?? "";
    return `https://${region}.tts.speech${speechHostSuffix(region)}${AzureHttpTTSService.SYNTHESIS_URI}`;
  }

  /**
   * Generate speech from text using Azure's HTTP synthesis API.
   *
   * @param text The text to synthesize into speech.
   * @param contextId The context ID for tracking audio frames.
   * @returns Audio frames containing the complete synthesized speech.
   */
  override async *runTts(text: string, contextId: string): AsyncGenerator<Frame | null, void> {
    if (this._speechConfig === null) {
      return;
    }

    const ssml = this._constructSsml(text);

    let response: Response;
    let audio: Uint8Array;
    try {
      response = await abortable(
        this._fetch(this._synthesisUrl(), {
          method: "POST",
          headers: {
            "Ocp-Apim-Subscription-Key": this._apiKey,
            "Content-Type": "application/ssml+xml",
            "X-Microsoft-OutputFormat": sampleRateToOutputFormat(this.sampleRate),
            "User-Agent": "pipedog",
          },
          body: ssml,
          signal: currentSignal(),
        }),
      );
      if (response.status !== 200) {
        const errorText = await abortable(response.text());
        logger.warning(`Speech synthesis canceled: CancellationReason.Error`);
        yield new ErrorFrame({
          error: `Unknown error occurred: HTTP ${response.status}: ${errorText}`,
        });
        return;
      }
      audio = new Uint8Array(await abortable(response.arrayBuffer()));
    } catch (e) {
      rethrowIfCancelled(e);
      logger.warning(`Speech synthesis canceled: CancellationReason.Error`);
      yield new ErrorFrame({ error: `Unknown error occurred: ${errorMessage(e)}` });
      return;
    }

    await this.startTtsUsageMetrics(text);
    await this.stopTtfbMetrics();
    // The raw format carries no WAV header (upstream strips the SDK's 44
    // bytes here).
    yield new TTSAudioRawFrame({
      audio,
      sampleRate: this.sampleRate,
      numChannels: 1,
      contextId,
    });
  }
}
