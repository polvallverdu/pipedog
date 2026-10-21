// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/services/azure/stt.py

/**
 * Azure Speech-to-Text service implementation for pipedog.
 *
 * This module provides speech-to-text functionality using the Azure AI Speech
 * service for real-time audio transcription.
 *
 * Porting notes:
 * - DIVERGENCE: upstream recognizes through the Azure Speech SDK
 *   (`azure-cognitiveservices-speech`), a native library. Here the service
 *   speaks the Speech service's WebSocket protocol directly (the one the SDKs
 *   use, see `speech_protocol.ts`) on the continuous "conversation" endpoint
 *   (`/speech/recognition/conversation/cognitiveservices/v1`), so it runs on
 *   Bun, Node, Deno and Cloudflare Workers.
 * - DIVERGENCE: `_speechConfig` is an `AzureSpeechConfig`, a small stand-in
 *   for the SDK's `SpeechConfig` that keeps the language, profanity option and
 *   properties the connection is built from (`setProfanity()` and
 *   `setProperty()` have the SDK's names).
 * - The SDK callbacks (`_onHandleRecognized`, `_onHandleRecognizing`,
 *   `_onHandleCanceled`) take SDK-shaped events and are called from the
 *   service's receive task, so they await their work instead of scheduling it
 *   with `run_coroutine_threadsafe`.
 * - DIVERGENCE: the connection opens in `start()`, once the input sample rate
 *   is known (upstream opens it in `setup()`, where the SDK defers the
 *   handshake to the first audio). After the service closes the connection
 *   (its session limit, an error), the next audio reopens it.
 * - Deprecated APIs are not ported: the `language` constructor option.
 */

import { rethrowIfCancelled, type Task } from "@pipedog/asyncio";
import {
  type CancelFrame,
  type EndFrame,
  ErrorFrame,
  type Frame,
  InterimTranscriptionFrame,
  type StartFrame,
  TranscriptionFrame,
} from "@pipedog/core/frames/frames";
import { STTSettings, type STTSettingsOptions } from "@pipedog/core/services/settings";
import { AZURE_TTFS_P99 } from "@pipedog/core/services/stt_latency";
import { STTService, type STTServiceOptions } from "@pipedog/core/services/stt_service";
import {
  type WebsocketClientConnection,
  type WebsocketConnectOptions,
  websocketConnect,
} from "@pipedog/core/services/websocket_service";
import { Language } from "@pipedog/core/transcriptions/language";
import { logger } from "@pipedog/core/utils/logger";
import { pyJsonDumps, pyJsonLoads } from "@pipedog/core/utils/py_json";
import { timeNowIso8601 } from "@pipedog/core/utils/time";
import { installTracedStt } from "@pipedog/core/utils/tracing/service_decorators";
import { assertGiven, NOT_GIVEN, type NotGiven } from "@pipedog/core/utils/types";
import { languageToAzureLanguage } from "./common.ts";
import {
  buildBinaryMessage,
  buildTextMessage,
  createNoDashGuid,
  parseSpeechMessage,
  speechConfigBody,
  speechHostSuffix,
  wavStreamHeader,
  withQuery,
} from "./speech_protocol.ts";

type Dict = Record<string, any>;

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * How Azure handles profanity in transcripts.
 *
 * - `"raw"`: return the text as recognized, no masking.
 * - `"masked"`: replace profane words with `****` (Azure default).
 * - `"removed"`: drop profane words from the output.
 */
export type AzureProfanity = "raw" | "masked" | "removed";

/** The SDK's `ProfanityOption`. */
export const ProfanityOption = {
  Masked: "Masked",
  Removed: "Removed",
  Raw: "Raw",
} as const;
export type ProfanityOption = (typeof ProfanityOption)[keyof typeof ProfanityOption];

/** The SDK's `PropertyId` names this service sets. */
export const PropertyId = {
  Speech_SegmentationSilenceTimeoutMs: "Speech_SegmentationSilenceTimeoutMs",
  SpeechServiceResponse_ProfanityOption: "SpeechServiceResponse_ProfanityOption",
} as const;
export type PropertyId = (typeof PropertyId)[keyof typeof PropertyId];

/** The SDK's `ResultReason` values the recognizer reports. */
export const ResultReason = {
  NoMatch: "NoMatch",
  Canceled: "Canceled",
  RecognizingSpeech: "RecognizingSpeech",
  RecognizedSpeech: "RecognizedSpeech",
} as const;
export type ResultReason = (typeof ResultReason)[keyof typeof ResultReason];

/** The SDK's `CancellationReason`. */
export const CancellationReason = {
  Error: "Error",
  EndOfStream: "EndOfStream",
  CancelledByUser: "CancelledByUser",
} as const;
export type CancellationReason = (typeof CancellationReason)[keyof typeof CancellationReason];

const _PROFANITY_OPTIONS: Record<AzureProfanity, ProfanityOption> = {
  raw: ProfanityOption.Raw,
  masked: ProfanityOption.Masked,
  removed: ProfanityOption.Removed,
};

/** Which query parameter each property is sent as (the SDK's `setCommonUrlParams`). */
const _PROPERTY_QUERY_PARAMETERS: Record<string, string> = {
  [PropertyId.Speech_SegmentationSilenceTimeoutMs]: "segmentationSilenceTimeoutMs",
  [PropertyId.SpeechServiceResponse_ProfanityOption]: "profanity",
};

export interface AzureSpeechConfigOptions {
  /** Azure Cognitive Services subscription key. */
  subscription: string;
  /** Azure region (e.g. "eastus"). */
  region?: string | null;
  /** Private endpoint URL, used instead of the region. */
  endpoint?: string | null;
  /** Recognition language (e.g. "en-US"). */
  speechRecognitionLanguage?: string | null;
}

/**
 * Where and how to recognize: a stand-in for the SDK's `SpeechConfig`.
 *
 * DIVERGENCE: not in upstream, which uses the SDK's `SpeechConfig`.
 */
export class AzureSpeechConfig {
  subscription: string;
  region: string | null;
  endpoint: string | null;
  speechRecognitionLanguage: string | null;
  /** Custom model endpoint id (sent as `cid`). */
  endpointId: string | null = null;
  readonly properties = new Map<string, string>();

  constructor(options: AzureSpeechConfigOptions) {
    this.subscription = options.subscription;
    this.region = options.region ?? null;
    this.endpoint = options.endpoint ?? null;
    this.speechRecognitionLanguage = options.speechRecognitionLanguage ?? null;
  }

  /** Set how profanity is handled in results. */
  setProfanity(profanity: ProfanityOption): void {
    this.properties.set(PropertyId.SpeechServiceResponse_ProfanityOption, profanity);
  }

  /** Set a property by its SDK `PropertyId` name. */
  setProperty(name: PropertyId | string, value: string): void {
    this.properties.set(name, value);
  }

  /** The recognition WebSocket URL (without the auth query parameters). */
  recognitionUrl(): string {
    const params: Record<string, string> = {};
    if (this.endpointId) {
      params.cid = this.endpointId;
    } else if (this.speechRecognitionLanguage) {
      params.language = this.speechRecognitionLanguage;
    }
    params.format = "simple";
    for (const [name, value] of this.properties) {
      const param = _PROPERTY_QUERY_PARAMETERS[name];
      if (param && value) params[param] = value.toLowerCase();
    }

    let base: string;
    if (this.endpoint) {
      const url = new URL(this.endpoint);
      if (url.pathname === "" || url.pathname === "/") {
        url.pathname = AzureSTTService.CONVERSATION_URI;
      }
      if (url.protocol === "https:") url.protocol = "wss:";
      else if (url.protocol === "http:") url.protocol = "ws:";
      // Keep parameters the endpoint already names.
      for (const key of Object.keys(params)) {
        if (url.searchParams.has(key)) delete params[key];
      }
      base = url.toString();
    } else {
      const region = this.region ?? "";
      base = `wss://${region}.stt.speech${speechHostSuffix(region)}${AzureSTTService.CONVERSATION_URI}`;
    }
    return withQuery(base, params);
  }
}

export interface AzureSTTSettingsOptions extends STTSettingsOptions {
  /** How Azure handles profanity in transcripts. */
  profanity?: AzureProfanity | null | NotGiven;
  /** Silence, in ms, inside a phrase before Azure finalizes it. */
  segmentationSilenceTimeoutMs?: number | null | NotGiven;
}

/**
 * Settings for AzureSTTService.
 *
 * `model` and `language` are inherited from `STTSettings` / `ServiceSettings`.
 *
 * - `profanity`: how Azure handles profanity in transcripts. One of "raw",
 *   "masked", or "removed" (see `AzureProfanity`). Store-mode default is null
 *   (Azure default = "masked"). Use "raw" for non-English deployments where
 *   Azure's profanity list is over-eager and masks ordinary words (e.g.
 *   Italian names containing common substrings), which breaks downstream
 *   fuzzy matching and LLM reasoning.
 * - `segmentationSilenceTimeoutMs`: how much silence Azure allows inside a
 *   phrase, in milliseconds, before it finalizes the recognition and emits a
 *   `TranscriptionFrame`. Azure accepts 100–5000; its default is 500.
 *   Store-mode default is null (keep Azure's default). Lower values finalize
 *   sooner, at the cost of splitting phrases that contain pauses; higher
 *   values keep slow or hesitant speech in one transcript. See
 *   https://learn.microsoft.com/en-us/azure/ai-services/speech-service/how-to-recognize-speech#change-how-silence-is-handled
 */
export class AzureSTTSettings extends STTSettings {
  profanity: AzureProfanity | null | NotGiven = NOT_GIVEN;
  segmentationSilenceTimeoutMs: number | null | NotGiven = NOT_GIVEN;

  constructor(options: AzureSTTSettingsOptions = {}) {
    super(options);
    this._assignOptions(options);
  }
}

/** An SDK-shaped recognition event. */
export interface RecognitionEvent {
  result: {
    reason: ResultReason;
    text: string;
    language?: string | null;
    [key: string]: unknown;
  };
}

/** An SDK-shaped canceled event. */
export interface RecognitionCanceledEvent {
  result: {
    cancellationDetails: { reason: CancellationReason; errorDetails: string | null };
  };
}

export interface AzureSTTServiceOptions extends STTServiceOptions {
  /** Azure Cognitive Services subscription key. */
  apiKey: string;
  /**
   * Azure region for the Speech service (e.g., 'eastus'). Required unless
   * `privateEndpoint` is provided.
   */
  region?: string | null;
  /**
   * Private endpoint for STT behind firewall. See
   * https://learn.microsoft.com/en-us/azure/ai-services/speech-service/speech-services-private-link?tabs=portal
   */
  privateEndpoint?: string | null;
  /** Custom model endpoint id. */
  endpointId?: string | null;
  /** Runtime-updatable settings. */
  settings?: AzureSTTSettings | null;
  /**
   * Creates the underlying `WebSocket`, to open it some other way. Defaults to
   * `websocketConnect`'s. Not in upstream.
   */
  webSocketFactory?: WebsocketConnectOptions["webSocketFactory"];
}

/**
 * Azure Speech-to-Text service for real-time audio transcription.
 *
 * This service uses the Azure AI Speech service to convert speech audio into
 * text transcriptions. It supports continuous recognition and provides
 * real-time transcription results with timing information.
 */
export class AzureSTTService extends STTService {
  static Settings: typeof AzureSTTSettings = AzureSTTSettings;
  declare protected _settings: AzureSTTSettings;

  /** The continuous recognition path. */
  static readonly CONVERSATION_URI = "/speech/recognition/conversation/cognitiveservices/v1";

  static {
    installTracedStt(AzureSTTService.prototype, "_handleTranscription");
  }

  _speechConfig: AzureSpeechConfig;
  protected _webSocketFactory: WebsocketConnectOptions["webSocketFactory"];
  protected _websocket: WebsocketClientConnection | null = null;
  protected _receiveTask: Task<unknown> | null = null;
  protected _requestId: string | null = null;
  protected _connecting = false;
  // Set while the service is started; audio after a dropped connection
  // reopens it.
  protected _started = false;

  /**
   * Initialize the Azure STT service.
   *
   * @param options.apiKey Azure Cognitive Services subscription key.
   * @param options.region Azure region for the Speech service (e.g.,
   *   'eastus'). Required unless `privateEndpoint` is provided.
   * @param options.sampleRate Audio sample rate in Hz. If null, uses service
   *   default.
   * @param options.privateEndpoint Private endpoint for STT behind firewall.
   * @param options.endpointId Custom model endpoint id.
   * @param options.settings Runtime-updatable settings.
   * @param options.ttfsP99Latency P99 latency from speech end to final
   *   transcript in seconds. Override for your deployment. See
   *   https://github.com/pipecat-ai/stt-benchmark
   *   Other options are passed to the parent STTService.
   * @throws Error (ValueError) if neither `region` nor `privateEndpoint` is
   *   given; (KeyError) if `profanity` is not a known option.
   */
  constructor(options: AzureSTTServiceOptions) {
    // 1. Initialize default_settings with hardcoded defaults
    const defaultSettings = new (new.target as typeof AzureSTTService).Settings({
      model: null,
      language: Language.EN_US,
      profanity: null,
      segmentationSilenceTimeoutMs: null,
    });

    // 4. Apply settings delta (canonical API, always wins)
    if (options.settings !== undefined && options.settings !== null) {
      defaultSettings.applyUpdate(options.settings);
    }

    super({
      ...options,
      sampleRate: options.sampleRate ?? null,
      ttfsP99Latency:
        options.ttfsP99Latency === undefined ? AZURE_TTFS_P99 : options.ttfsP99Latency,
      settings: defaultSettings,
    });

    const recognitionLanguage =
      (assertGiven(this._settings.language) as string | null) ||
      languageToAzureLanguage(Language.EN_US);

    const region = options.region ?? null;
    const privateEndpoint = options.privateEndpoint ?? null;
    if (!region && !privateEndpoint) {
      throw new Error("Either 'region' or 'private_endpoint' must be provided.");
    }

    if (privateEndpoint) {
      if (region) {
        logger.warning("Both 'region' and 'private_endpoint' provided; 'region' will be ignored.");
      }
      this._speechConfig = new AzureSpeechConfig({
        subscription: options.apiKey,
        endpoint: privateEndpoint,
        speechRecognitionLanguage: recognitionLanguage,
      });
    } else {
      this._speechConfig = new AzureSpeechConfig({
        subscription: options.apiKey,
        region,
        speechRecognitionLanguage: recognitionLanguage,
      });
    }

    if (options.endpointId) {
      this._speechConfig.endpointId = options.endpointId;
    }

    this._applyProfanity();
    this._applySegmentationSilenceTimeout();

    this._webSocketFactory = options.webSocketFactory ?? null;
  }

  /**
   * Check if this service can generate performance metrics.
   *
   * @returns True as this service supports metrics generation.
   */
  override canGenerateMetrics(): boolean {
    return true;
  }

  /**
   * Convert a Language enum to Azure service-specific language code.
   *
   * @param language The language to convert.
   * @returns The Azure-specific language identifier.
   */
  override languageToServiceLanguage(language: Language): string | null {
    return languageToAzureLanguage(language);
  }

  /**
   * Apply the current `profanity` setting to the speech config.
   *
   * A no-op when profanity is null (keeps Azure's default of "masked").
   *
   * @throws Error (KeyError) for an unknown value.
   */
  protected _applyProfanity(): void {
    const profanity = assertGiven(this._settings.profanity);
    if (profanity !== null) {
      const option = Object.hasOwn(_PROFANITY_OPTIONS, profanity)
        ? _PROFANITY_OPTIONS[profanity]
        : undefined;
      if (option === undefined) {
        throw new Error(`KeyError: '${profanity}'`);
      }
      this._speechConfig.setProfanity(option);
    }
  }

  /**
   * Apply the current `segmentationSilenceTimeoutMs` setting.
   *
   * A no-op when the setting is null (keeps Azure's default of 500 ms).
   */
  protected _applySegmentationSilenceTimeout(): void {
    const timeoutMs = assertGiven(this._settings.segmentationSilenceTimeoutMs);
    if (timeoutMs !== null) {
      this._speechConfig.setProperty(
        PropertyId.Speech_SegmentationSilenceTimeoutMs,
        String(timeoutMs),
      );
    }
  }

  /** Apply a settings delta and reconnect if a recognizer setting changed. */
  protected override async _updateSettings(delta: STTSettings): Promise<Record<string, unknown>> {
    const changed = await super._updateSettings(delta);

    if ("language" in changed) {
      this._speechConfig.speechRecognitionLanguage =
        (assertGiven(this._settings.language) as string | null) ||
        languageToAzureLanguage(Language.EN_US);
    }

    if ("profanity" in changed) {
      this._applyProfanity();
    }

    if ("segmentationSilenceTimeoutMs" in changed) {
      this._applySegmentationSilenceTimeout();
    }

    // These settings are baked into the recognizer at connect time, so a
    // live change only takes effect after a reconnect.
    if (
      ["language", "profanity", "segmentationSilenceTimeoutMs"].some((k) => k in changed) &&
      this._websocket
    ) {
      await this._disconnect();
      await this._connect();
    }

    return changed;
  }

  /**
   * Process audio data for speech-to-text conversion.
   *
   * Feeds audio data to the Azure recognizer. Recognition results are handled
   * asynchronously by the receive task.
   *
   * @param audio Raw audio bytes to process.
   * @returns null for successful processing, or an ErrorFrame on failure.
   */
  override async *runStt(audio: Uint8Array): AsyncGenerator<Frame | null, void, unknown> {
    try {
      if (!this._websocket && this._canReconnectStream()) {
        await this._connect();
      }
      if (this._websocket && this._requestId) {
        await this._websocket.send(buildBinaryMessage("audio", this._requestId, audio));
      }
      yield null;
    } catch (e) {
      rethrowIfCancelled(e);
      yield new ErrorFrame({ error: `Unknown error occurred: ${errorMessage(e)}` });
    }
  }

  protected _canReconnectStream(): boolean {
    return this._started && !this._connecting;
  }

  /**
   * Start the service and connect.
   *
   * @param frame The start frame.
   */
  override async start(frame: StartFrame): Promise<void> {
    await super.start(frame);
    this._started = true;
    await this._connect();
  }

  /** Release resources at pipeline teardown. */
  override async cleanup(): Promise<void> {
    await super.cleanup();
    this._started = false;
    await this._disconnect();
  }

  /**
   * Stop the speech recognition service.
   *
   * @param frame Frame indicating the end of processing.
   */
  override async stop(frame: EndFrame): Promise<void> {
    await super.stop(frame);
    this._started = false;
    await this._disconnect();
  }

  /**
   * Cancel the speech recognition service.
   *
   * @param frame Frame indicating cancellation.
   */
  override async cancel(frame: CancelFrame): Promise<void> {
    await super.cancel(frame);
    this._started = false;
    await this._disconnect();
  }

  /** Open the recognition connection and begin continuous recognition. */
  protected async _connect(): Promise<void> {
    if (this._websocket || this._connecting) {
      return;
    }

    this._connecting = true;
    try {
      const connectionId = createNoDashGuid();
      const headers = {
        "Ocp-Apim-Subscription-Key": this._speechConfig.subscription,
        "X-ConnectionId": connectionId,
      };
      const url = withQuery(this._speechConfig.recognitionUrl(), headers);
      const websocket = await websocketConnect(url, {
        additionalHeaders: headers,
        webSocketFactory: this._webSocketFactory,
      });
      this._websocket = websocket;
      this._requestId = createNoDashGuid();
      await websocket.send(
        buildTextMessage(
          "speech.config",
          this._requestId,
          "application/json",
          pyJsonDumps(speechConfigBody("conversation")),
        ),
      );
      await this._startTurn(websocket);
      this._receiveTask = this.createTask(
        () => this._receiveTaskHandler(websocket),
        "_receive_task_handler",
      );
    } catch (e) {
      rethrowIfCancelled(e);
      this._websocket = null;
      this._requestId = null;
      await this.pushError(`Uncaught exception during initialization: ${errorMessage(e)}`, {
        exception: e,
      });
    } finally {
      this._connecting = false;
    }
  }

  /** Send a turn's `speech.context` and WAV header (the SDK's pre-payload). */
  protected async _startTurn(websocket: WebsocketClientConnection): Promise<void> {
    const requestId = this._requestId ?? createNoDashGuid();
    this._requestId = requestId;
    await websocket.send(buildTextMessage("speech.context", requestId, "application/json", "{}"));
    await websocket.send(
      buildBinaryMessage("audio", requestId, wavStreamHeader(this.sampleRate), "audio/x-wav"),
    );
  }

  /** Stop recognition and close the connection. */
  protected async _disconnect(): Promise<void> {
    const websocket = this._websocket;
    const requestId = this._requestId;
    this._websocket = null;
    this._requestId = null;

    if (this._receiveTask) {
      const task = this._receiveTask;
      this._receiveTask = null;
      await this.cancelTask(task);
    }

    if (websocket) {
      try {
        if (requestId) {
          // An empty audio message ends the stream.
          await websocket.send(buildBinaryMessage("audio", requestId, null));
        }
        await websocket.close();
      } catch (e) {
        rethrowIfCancelled(e);
        logger.debug(`${this}: error closing websocket: ${errorMessage(e)}`);
      }
    }
  }

  /** Receive recognition messages and dispatch them to the handlers. */
  protected async _receiveTaskHandler(websocket: WebsocketClientConnection): Promise<void> {
    let code = 1000;
    let reason = "";
    try {
      for await (const data of websocket) {
        await this._handleMessage(websocket, data as string | Uint8Array);
      }
      code = websocket.closeCode ?? 1000;
      reason = websocket.closeReason ?? "";
    } catch (e) {
      rethrowIfCancelled(e);
      code = websocket.closeCode ?? 1006;
      reason = websocket.closeReason || errorMessage(e);
    }
    if (this._websocket === websocket) {
      this._websocket = null;
      this._requestId = null;
      this._receiveTask = null;
      if (code !== 1000) {
        await this._onHandleCanceled({
          result: {
            cancellationDetails: {
              reason: CancellationReason.Error,
              errorDetails: `${reason} websocket error code: ${code}`,
            },
          },
        });
      }
    }
  }

  /** Dispatch one service message. */
  protected async _handleMessage(
    websocket: WebsocketClientConnection,
    data: string | Uint8Array,
  ): Promise<void> {
    let message: ReturnType<typeof parseSpeechMessage>;
    try {
      message = parseSpeechMessage(data);
    } catch (e) {
      rethrowIfCancelled(e);
      logger.warning(`${this}: dropping malformed message: ${errorMessage(e)}`);
      return;
    }
    if (
      this._requestId === null ||
      message.requestId.toLowerCase() !== this._requestId.toLowerCase()
    ) {
      return;
    }
    switch (message.path) {
      case "speech.hypothesis":
      case "speech.fragment": {
        const body = pyJsonLoads(message.text ?? "{}") as Dict;
        await this._onHandleRecognizing({
          result: {
            reason: ResultReason.RecognizingSpeech,
            text: String(body.Text ?? ""),
            language: body.PrimaryLanguage?.Language ?? null,
            json: body,
          },
        });
        break;
      }
      case "speech.phrase": {
        const body = pyJsonLoads(message.text ?? "{}") as Dict;
        const status = String(body.RecognitionStatus ?? "");
        if (status === "Success") {
          await this._onHandleRecognized({
            result: {
              reason: ResultReason.RecognizedSpeech,
              text: String(body.DisplayText ?? ""),
              language: body.PrimaryLanguage?.Language ?? null,
              json: body,
            },
          });
        } else if (status === "Error" || status === "TooManyRequests" || status === "BadRequest") {
          await this._onHandleCanceled({
            result: {
              cancellationDetails: {
                reason: CancellationReason.Error,
                errorDetails: status,
              },
            },
          });
        }
        // NoMatch, InitialSilenceTimeout, BabbleTimeout, EndOfDictation: no text.
        break;
      }
      case "turn.end":
        // Continuous recognition: the next turn gets a new request id.
        if (this._websocket === websocket) {
          this._requestId = createNoDashGuid();
          await this._startTurn(websocket);
        }
        break;
      default:
        break;
    }
  }

  /** Handle a transcription result with tracing. */
  protected async _handleTranscription(
    _transcript: string,
    _isFinal: boolean,
    _language: Language | null = null,
  ): Promise<void> {}

  /** Handle a final recognition. */
  async _onHandleRecognized(event: RecognitionEvent): Promise<void> {
    if (event.result.reason === ResultReason.RecognizedSpeech && event.result.text.length > 0) {
      const language = (event.result.language ||
        assertGiven(this._settings.language)) as Language | null;
      // Azure's RecognizedSpeech event is by definition the final recognition
      // for an utterance — mark the frame as such so that downstream
      // turn-stop strategies (SpeechTimeoutUserTurnStop and friends) can take
      // their finalized fast-path instead of waiting for VAD events that may
      // never arrive on short replies.
      const frame = new TranscriptionFrame({
        text: event.result.text,
        userId: this._userId,
        timestamp: timeNowIso8601(),
        language,
        result: event,
        finalized: true,
      });
      await this._handleTranscription(event.result.text, true, language);
      // Report usage before the transcription frame so tracing can attach it
      // to the STT span the frame closes.
      await this.emitSttUsageMetrics();
      await this.pushFrame(frame);
    }
  }

  /** Handle an interim recognition. */
  async _onHandleRecognizing(event: RecognitionEvent): Promise<void> {
    if (event.result.reason === ResultReason.RecognizingSpeech && event.result.text.length > 0) {
      const language = (event.result.language ||
        assertGiven(this._settings.language)) as Language | null;
      const frame = new InterimTranscriptionFrame({
        text: event.result.text,
        userId: this._userId,
        timestamp: timeNowIso8601(),
        language,
        result: event,
      });
      await this.pushFrame(frame);
    }
  }

  /** Handle a canceled recognition. */
  async _onHandleCanceled(event: RecognitionCanceledEvent): Promise<void> {
    const details = event.result.cancellationDetails;
    if (details.reason === CancellationReason.Error) {
      let errorMsg = `Azure STT recognition canceled: CancellationReason.${details.reason}`;
      if (details.errorDetails) {
        errorMsg += ` - ${details.errorDetails}`;
      }
      await this.pushError(errorMsg);
    }
  }
}
