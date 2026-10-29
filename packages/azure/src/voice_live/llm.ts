// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/services/azure/voice_live/llm.py

/**
 * Azure Voice Live LLM service implementation with WebSocket support.
 *
 * Based on Azure's Voice Live API documentation:
 * https://learn.microsoft.com/en-us/azure/ai-services/speech-service/voice-live
 *
 * Porting notes:
 * - The websocket is `websocketConnect()` from core (the global `WebSocket`,
 *   or `fetch` on Cloudflare Workers), opened through the service's
 *   `_websocketConnect()` so tests can replace it (upstream patches the
 *   module's `websocket_connect`).
 * - `SessionProperties.model_fields_set` is `modelFieldsSet` (camelCase
 *   field names).
 */

import { rethrowIfCancelled, type Task, time } from "@pipedog/asyncio";
import type { BaseLLMAdapter } from "@pipedog/core/adapters/llm/base_llm_adapter";
import type { ToolsSchema } from "@pipedog/core/adapters/llm/schemas/tools_schema";
import {
  BotStoppedSpeakingFrame,
  type CancelFrame,
  type EndFrame,
  type Frame,
  FunctionCallFromLLM,
  InputAudioRawFrame,
  InterimTranscriptionFrame,
  InterruptionFrame,
  LLMContextFrame,
  LLMFullResponseEndFrame,
  LLMFullResponseStartFrame,
  LLMMessagesAppendFrame,
  LLMServiceMetadataFrame,
  LLMSetToolsFrame,
  LLMTextFrame,
  ProposedUserStartedSpeakingFrame,
  ProposedUserStoppedSpeakingFrame,
  SpeechControlParamsFrame,
  TextType,
  TranscriptionFrame,
  TTSAudioRawFrame,
  TTSStartedFrame,
  TTSStoppedFrame,
  TTSTextFrame,
  UserStartedSpeakingFrame,
  UserStoppedSpeakingFrame,
} from "@pipedog/core/frames/frames";
import { LLMTokenUsage } from "@pipedog/core/metrics/metrics";
import * as asyncToolMessages from "@pipedog/core/processors/aggregators/async_tool_messages";
import {
  type LLMContext,
  LLMSpecificMessage,
} from "@pipedog/core/processors/aggregators/llm_context";
import { FrameDirection, type FrameProcessorSetup } from "@pipedog/core/processors/frame_processor";
import {
  type LLMAdapterClass,
  LLMService,
  type LLMServiceOptions,
} from "@pipedog/core/services/llm_service";
import {
  LLMSettings,
  type LLMSettingsOptions,
  type ServiceSettings,
} from "@pipedog/core/services/settings";
import {
  ConnectionClosed,
  type WebsocketClientConnection,
  type WebsocketConnectOptions,
  websocketConnect,
} from "@pipedog/core/services/websocket_service";
import { ExternalUserTurnStrategies } from "@pipedog/core/turns/user_turn_strategies";
import { base64ToBytes, bytesToBase64 } from "@pipedog/core/utils/base64";
import { logger } from "@pipedog/core/utils/logger";
import { pyJsonDumps, pyJsonLoads } from "@pipedog/core/utils/py_json";
import { timeNowIso8601 } from "@pipedog/core/utils/time";
import { assertGiven, isGiven, NOT_GIVEN, type NotGiven } from "@pipedog/core/utils/types";
import { AzureVoiceLiveLLMAdapter } from "../azure_voice_live_adapter.ts";
import type { AzureTokenProvider } from "../common.ts";
import * as events from "./events.ts";

/** Model backing the session when the settings name none. */
export const DEFAULT_MODEL = "gpt-4o-mini";

/** Voice Live API version this service speaks. */
export const DEFAULT_API_VERSION = "2026-07-15";

// Output sample rate implied by each PCM output format Voice Live offers.
const _OUTPUT_FORMAT_SAMPLE_RATES: Record<number, events.OutputAudioFormat> = {
  8000: "pcm16_8000hz",
  16000: "pcm16_16000hz",
  24000: "pcm16",
};

// With manual turn detection, the interruption that opens a caller's turn clears
// the input buffer after the speech onset was already sent, so the most recent
// audio is replayed. It covers the local VAD's `start_secs` plus a margin once
// the VAD's parameters arrive.
const _DEFAULT_USER_AUDIO_PREROLL_SECS = 0.5;
const _USER_AUDIO_PREROLL_MARGIN_SECS = 0.3;

// Error codes that are expected during normal turn-taking, logged at debug.
const _EXPECTED_ERROR_CODES = new Set([
  "response_cancel_not_active",
  "conversation_already_has_active_response",
  // With `auto_truncate`, Voice Live truncates an interrupted item itself
  // before this service's truncation arrives.
  "item_already_truncated",
]);

// The adapter's invocation params are an interface, which isn't assignable to
// the `Record<string, unknown>` of `LLMService`'s adapter constraint.
type VoiceLiveAdapter = AzureVoiceLiveLLMAdapter & BaseLLMAdapter;

type Dict = Record<string, any>;

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Convert a snake_case key to camelCase (`input_audio_format` → `inputAudioFormat`). */
function snakeToCamel(key: string): string {
  return key.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

/** A string as Python's `repr()` prints it. */
function pyRepr(value: unknown): string {
  return typeof value === "string" ? `'${value}'` : String(value);
}

export interface CurrentAudioResponseOptions {
  /** Unique identifier for the audio response item. */
  itemId: string;
  /** Index of the audio content within the item. */
  contentIndex: number;
  /** Timestamp when the audio response started in milliseconds. */
  startTimeMs: number;
  /** Total size of audio data received in bytes. Defaults to 0. */
  totalSize?: number;
}

/**
 * Tracks the current audio response from the assistant.
 *
 * - `itemId`: unique identifier for the audio response item.
 * - `contentIndex`: index of the audio content within the item.
 * - `startTimeMs`: timestamp when the audio response started in milliseconds.
 * - `totalSize`: total size of audio data received in bytes. Defaults to 0.
 */
export class CurrentAudioResponse {
  itemId: string;
  contentIndex: number;
  startTimeMs: number;
  totalSize: number;

  constructor(options: CurrentAudioResponseOptions) {
    this.itemId = options.itemId;
    this.contentIndex = options.contentIndex;
    this.startTimeMs = options.startTimeMs;
    this.totalSize = options.totalSize ?? 0;
  }
}

export interface AzureVoiceLiveLLMSettingsOptions extends LLMSettingsOptions {
  /**
   * Voice Live session properties (voice, turn detection, transcription,
   * tools, etc.). `model` and `instructions` are synced bidirectionally with
   * the top-level `model` and `systemInstruction` fields; a top-level
   * `temperature` is copied into it.
   */
  sessionProperties?: events.SessionProperties | NotGiven;
}

/**
 * Settings for AzureVoiceLiveLLMService.
 *
 * - `sessionProperties`: Voice Live session properties (voice, turn
 *   detection, transcription, tools, etc.). `model` and `instructions` are
 *   synced bidirectionally with the top-level `model` and `systemInstruction`
 *   fields; a top-level `temperature` is copied into it.
 */
export class AzureVoiceLiveLLMSettings extends LLMSettings {
  sessionProperties: events.SessionProperties | NotGiven = NOT_GIVEN;

  constructor(options: AzureVoiceLiveLLMSettingsOptions = {}) {
    super(options);
    this._assignOptions(options);
  }

  // -- Bidirectional sync helpers ------------------------------------------

  /** Push top-level `model`/`systemInstruction`/`temperature` into SP. */
  static _syncTopLevelToSp(settings: AzureVoiceLiveLLMSettings): void {
    if (!isGiven(settings.sessionProperties)) {
      return;
    }
    const sp = settings.sessionProperties;
    if (isGiven(settings.model) && settings.model !== null) {
      sp.model = settings.model;
    }
    if (isGiven(settings.systemInstruction)) {
      sp.instructions = settings.systemInstruction;
    }
    if (isGiven(settings.temperature) && settings.temperature !== null) {
      sp.temperature = settings.temperature;
    }
  }

  // -- applyUpdate override -------------------------------------------------

  /**
   * Merge a delta, keeping `model`/`systemInstruction` in sync with SP.
   *
   * When the delta contains `sessionProperties`, it **replaces** the stored
   * SP wholesale. Top-level field values always take precedence over
   * conflicting SP values.
   */
  override applyUpdate(delta: this): Record<string, unknown> {
    const changed = super.applyUpdate(delta);

    if ("sessionProperties" in changed && isGiven(this.sessionProperties)) {
      const sp = this.sessionProperties;
      if (!("model" in changed) && sp.model !== null) {
        const oldModel = this.model;
        this.model = sp.model;
        if (oldModel !== this.model) {
          changed.model = oldModel;
        }
      }
      if (!("systemInstruction" in changed) && sp.instructions !== null) {
        const oldSi = this.systemInstruction;
        this.systemInstruction = sp.instructions;
        if (oldSi !== this.systemInstruction) {
          changed.systemInstruction = oldSi;
        }
      }
    }

    AzureVoiceLiveLLMSettings._syncTopLevelToSp(this);

    return changed;
  }

  // -- fromMapping override -------------------------------------------------

  /**
   * Build a delta from a plain dict, routing SP keys into `sessionProperties`.
   *
   * Keys that correspond to `SessionProperties` fields are collected into a
   * nested `sessionProperties` value. `model` is always routed to the
   * top-level field. Unknown keys go to `extra`. Keys may use upstream's
   * snake_case spelling or the camelCase field names.
   */
  static override fromMapping<T extends ServiceSettings>(
    this: new (
      options?: object,
    ) => T,
    settings: Record<string, unknown>,
  ): T {
    // biome-ignore lint/complexity/noThisInStatic: polymorphic static, like Python's classmethod.
    const cls = this as unknown as typeof AzureVoiceLiveLLMSettings & (new (options?: object) => T);
    const ownFieldNames = new Set(new cls()._fieldNames());

    const top: Record<string, unknown> = {};
    const spDict: Record<string, unknown> = {};
    const extra: Record<string, unknown> = {};

    // `modelFields` maps camelCase field names to wire keys; both spellings
    // are accepted.
    const spKeys = new Map<string, string>();
    for (const [field, wire] of Object.entries(events.SessionProperties.modelFields)) {
      if (field === "model") continue;
      spKeys.set(field, field);
      spKeys.set(wire, field);
    }

    for (const [key, value] of Object.entries(settings)) {
      const canonical = cls._aliases[key] ?? key;
      if (ownFieldNames.has(canonical)) {
        top[canonical] = value;
      } else if (ownFieldNames.has(snakeToCamel(canonical))) {
        top[snakeToCamel(canonical)] = value;
      } else if (spKeys.has(canonical)) {
        spDict[spKeys.get(canonical)!] = value;
      } else {
        extra[key] = value;
      }
    }

    if (Object.keys(spDict).length > 0) {
      top.sessionProperties = new events.SessionProperties(spDict);
    }

    const instance = new cls(top);
    instance.extra = extra;
    return instance;
  }
}

export interface AzureVoiceLiveLLMServiceOptions extends LLMServiceOptions {
  /**
   * Voice Live endpoint for the Foundry resource. Accepts the resource
   * endpoint as shown in the Azure portal
   * (`https://<resource>.services.ai.azure.com`) or a full WebSocket URL; the
   * scheme and `/voice-live/realtime` path are filled in when absent.
   */
  endpoint: string;
  /** API key for the resource. Required unless `tokenProvider` is given. */
  apiKey?: string | null;
  /**
   * Async callable supplying a Microsoft Entra ID bearer token, used instead
   * of `apiKey` when given. Build one with `getBearerTokenProvider()` from
   * `@azure/identity` and the `https://ai.azure.com/.default` scope.
   */
  tokenProvider?: AzureTokenProvider | null;
  /** Voice Live API version to request. Defaults to `DEFAULT_API_VERSION`. */
  apiVersion?: string;
  /**
   * Runtime-updatable settings. `model` defaults to "gpt-4o-mini" and is sent
   * as a query parameter on the connection, so it is fixed for the session.
   * The default voice is "en-US-Ava:DragonHDLatestNeural", except for
   * `azure-realtime`, which picks one of its own native voices. When
   * `sessionProperties` is provided, it **replaces** all defaults wholesale —
   * provide a complete `SessionProperties` in that case.
   */
  settings?: AzureVoiceLiveLLMSettings | null;
  /** Whether to start with audio input paused. Defaults to false. */
  startAudioPaused?: boolean;
}

/**
 * Azure Voice Live LLM service for real-time audio and text communication.
 *
 * Implements Azure's Voice Live API over WebSocket for low-latency
 * bidirectional audio. Voice Live combines speech recognition, a generative
 * model and Azure text to speech behind a single realtime session, and adds
 * noise suppression, echo cancellation and semantic end-of-turn detection.
 *
 * Supports function calling, conversation management and real-time
 * transcription.
 *
 * Proposes turn boundaries from Voice Live's server-side VAD events, which
 * the recommended external user turn strategies resolve into
 * `UserStartedSpeakingFrame` / `UserStoppedSpeakingFrame`.
 * `LLMContextAggregatorPair` auto-detects this realtime service and decouples
 * context writes from those frames. To drive turns from local VAD
 * (`LLMUserAggregatorParams.vadAnalyzer`) instead, disable Voice Live's
 * server-side turn detection by passing `turnDetection: null` in
 * `sessionProperties` (manual mode): while it stays on, the strategies this
 * service recommends replace the ones the analyzer installs, leaving the
 * analyzer with no say in turn-taking.
 *
 * Azure's own Realtime deployments are a different product served by
 * `AzureRealtimeLLMService`; the two speak different event names and are not
 * interchangeable.
 *
 * @example
 * ```ts
 * const llm = new AzureVoiceLiveLLMService({
 *   apiKey: process.env.AZURE_VOICE_LIVE_API_KEY,
 *   endpoint: process.env.AZURE_VOICE_LIVE_ENDPOINT!,
 *   settings: new AzureVoiceLiveLLMService.Settings({ model: "gpt-4o-mini" }),
 * });
 * ```
 */
export class AzureVoiceLiveLLMService extends LLMService<VoiceLiveAdapter> {
  static Settings = AzureVoiceLiveLLMSettings;
  declare protected _settings: AzureVoiceLiveLLMSettings;

  static override adapterClass: LLMAdapterClass | null =
    AzureVoiceLiveLLMAdapter as unknown as LLMAdapterClass;

  apiKey: string | null;
  baseUrl: string;
  protected _tokenProvider: AzureTokenProvider | null;
  protected _apiVersion: string;
  protected _model: string;

  protected _audioInputPaused: boolean;
  protected _audioSendLogged = false;
  protected _interimTranscriptionText = "";
  protected _websocket: WebsocketClientConnection | null = null;
  protected _receiveTask: Task<unknown> | null = null;
  protected _context: LLMContext | null = null;
  protected _lastContextMessageCount = 0;

  protected _inputSampleRate: number | null = null;
  protected _outputSampleRate: number | null = null;

  protected _llmNeedsConversationSetup = true;

  protected _disconnecting = false;
  protected _apiSessionReady = false;
  protected _runLlmWhenApiSessionReady = false;
  protected _responseInFlight = false;
  protected _responseRequestEventId: string | null = null;
  protected _runLlmWhenResponseDone = false;
  protected _currentResponseId: string | null = null;
  protected _interruptedResponseId: string | null = null;
  protected _cancelAnnouncedResponse = false;

  protected _currentAssistantResponse: events.ConversationItem | null = null;
  protected _currentAudioResponse: CurrentAudioResponse | null = null;
  protected _ttsStarted = false;
  protected _transcriptAwaitingContext = false;
  protected _userAudioPreroll: Uint8Array = new Uint8Array(0);
  protected _userAudioPrerollSecs = _DEFAULT_USER_AUDIO_PREROLL_SECS;

  protected _pendingFunctionCalls = new Map<string, events.ConversationItem>();
  protected _completedToolCalls = new Set<string>();

  /**
   * Initialize the Azure Voice Live LLM service.
   *
   * @param options.endpoint Voice Live endpoint for the Foundry resource.
   * @param options.apiKey API key for the resource. Required unless
   *   `tokenProvider` is given.
   * @param options.tokenProvider Async callable supplying a Microsoft Entra ID
   *   bearer token, used instead of `apiKey` when given.
   * @param options.apiVersion Voice Live API version to request.
   * @param options.settings Runtime-updatable settings.
   * @param options.startAudioPaused Whether to start with audio input paused.
   *   Other options are passed to the parent LLMService.
   * @throws Error If neither `apiKey` nor `tokenProvider` is given (upstream:
   *   ValueError).
   */
  constructor(options: AzureVoiceLiveLLMServiceOptions) {
    if (
      (options.apiKey === undefined || options.apiKey === null) &&
      (options.tokenProvider === undefined || options.tokenProvider === null)
    ) {
      throw new Error("Either `api_key` or `token_provider` is required.");
    }

    const cls = new.target as typeof AzureVoiceLiveLLMService;
    const defaultVoice = new events.AzureStandardVoice({ name: "en-US-Ava:DragonHDLatestNeural" });

    const defaultSettings = new cls.Settings({
      model: DEFAULT_MODEL,
      systemInstruction: null,
      temperature: null,
      maxTokens: null,
      topP: null,
      topK: null,
      frequencyPenalty: null,
      presencePenalty: null,
      seed: null,
      filterIncompleteUserTurns: false,
      userTurnCompletionConfig: null,
      sessionProperties: new events.SessionProperties({
        modalities: ["text", "audio"],
        voice: defaultVoice,
        turnDetection: new events.TurnDetection({ type: "azure_semantic_vad" }),
        inputAudioTranscription: new events.InputAudioTranscription({ model: "azure-speech" }),
        inputAudioNoiseReduction: new events.InputAudioNoiseReduction(),
      }),
    });

    cls.Settings._syncTopLevelToSp(defaultSettings);

    if (options.settings !== undefined && options.settings !== null) {
      defaultSettings.applyUpdate(options.settings);
    }

    // `azure-realtime` rejects Azure standard voices, and chooses one of its
    // native voices when the session names none.
    const props = defaultSettings.sessionProperties;
    if (
      isGiven(props) &&
      props.voice === defaultVoice &&
      String(defaultSettings.model).startsWith("azure-realtime")
    ) {
      props.voice = null;
    }

    const baseUrl = cls._buildBaseUrl(options.endpoint);

    super({ ...options, settings: defaultSettings });

    this.apiKey = options.apiKey ?? null;
    this.baseUrl = baseUrl;
    this._tokenProvider = options.tokenProvider ?? null;
    this._apiVersion = options.apiVersion ?? DEFAULT_API_VERSION;
    // The connection URL selects the model, so it is fixed for the session.
    this._model = (assertGiven(this._settings.model) as string | null) || DEFAULT_MODEL;
    this._warnIfCallerIsNotTranscribed();

    this._audioInputPaused = options.startAudioPaused ?? false;

    this._registerEventHandler("on_conversation_item_created");
    this._registerEventHandler("on_conversation_item_updated");
  }

  /** Normalize a portal endpoint or full URL into a Voice Live WebSocket URL. */
  static _buildBaseUrl(endpoint: string): string {
    let url = endpoint
      .trim()
      .replace(/^(?:https?|wss?):\/\//i, "wss://")
      .replace(/\/+$/, "");
    if (!url.startsWith("wss://")) {
      url = `wss://${url}`;
    }
    if (!url.includes("/voice-live/realtime")) {
      url = `${url}/voice-live/realtime`;
    }
    return url;
  }

  /** Check if the service can generate usage metrics. */
  override canGenerateMetrics(): boolean {
    return true;
  }

  /**
   * Set whether audio input is paused.
   *
   * @param paused Whether to pause audio input.
   */
  setAudioInputPaused(paused: boolean): void {
    this._audioInputPaused = paused;
  }

  /** Sample rate of the audio Voice Live returns. */
  protected _getOutputSampleRate(): number {
    return this._outputSampleRate || 24000;
  }

  /**
   * Whether the caller drives turn boundaries instead of Voice Live.
   *
   * Leaving `turnDetection` unset keeps Voice Live's own defaults, which run
   * server-side VAD; only an explicit null or false opts out. That is the
   * same distinction `SessionUpdateEvent` makes when it decides whether to
   * send the disabling null.
   */
  protected _isManualTurnDetection(): boolean {
    const props = this._settings.sessionProperties;
    if (!isGiven(props)) {
      return false;
    }
    return props.modelFieldsSet.has("turnDetection") && !props.turnDetection;
  }

  /** Describe this service to the rest of the pipeline. */
  override serviceMetadataFrame(): LLMServiceMetadataFrame {
    const emitsTurnFrames = !this._isManualTurnDetection();
    this._warnIfRealtimeServiceEmitsNoTurnFrames(emitsTurnFrames);
    return new LLMServiceMetadataFrame({
      serviceName: this.name,
      isRealtimeService: true,
      userTurnStrategies: emitsTurnFrames ? new ExternalUserTurnStrategies() : null,
    });
  }

  /**
   * Handle user interruption of assistant speech.
   *
   * Voice Live cancels the response itself only for a barge-in its server
   * VAD detects, so any other interruption (manual turns, typed input, the
   * application) cancels it here. A cancelled response keeps streaming what
   * it already generated until `response.done`; that output is dropped. In
   * manual mode the input buffer is cleared as well, and the most recent
   * audio replayed so the caller's speech onset survives the clear.
   */
  protected async _handleInterruption(): Promise<void> {
    if (this._isManualTurnDetection()) {
      await this.sendClientEvent(new events.InputAudioBufferClearEvent());
      if (this._userAudioPreroll.length > 0) {
        const payload = bytesToBase64(this._userAudioPreroll);
        await this.sendClientEvent(new events.InputAudioBufferAppendEvent({ audio: payload }));
      }
    }

    if (this._responseInFlight) {
      await this.sendClientEvent(new events.ResponseCancelEvent());
      if (this._currentResponseId) {
        this._interruptedResponseId = this._currentResponseId;
      } else {
        // Asked for but not announced yet; its id arrives with
        // response.created.
        this._cancelAnnouncedResponse = true;
      }
    }

    await this._truncateCurrentAudioResponse();
    await this.stopAllMetrics();

    if (this._currentAssistantResponse) {
      // The cancelled response still reports response.done, so clear the
      // tracked item to keep that from closing the turn a second time.
      this._currentAssistantResponse = null;
      await this.pushFrame(new LLMFullResponseEndFrame());
    }
    // Tracked apart from the truncation state, which server VAD's
    // speech_started clears before the interruption reaches this point.
    if (this._ttsStarted) {
      this._ttsStarted = false;
      await this.pushFrame(new TTSStoppedFrame());
    }
    this._runLlmWhenResponseDone = false;
  }

  /** Handle user started speaking event. */
  protected async _handleUserStartedSpeaking(
    _frame: UserStartedSpeakingFrame | null,
  ): Promise<void> {}

  /**
   * Handle user stopped speaking event.
   *
   * Server-side VAD commits the buffer and creates the response itself; in
   * manual mode the client must send them. The response waits for one the
   * caller interrupted to finish, since Voice Live rejects a second response
   * while it streams. Metrics are started in `_handleEvtSpeechStopped` in
   * the server-VAD path.
   */
  protected async _handleUserStoppedSpeaking(
    _frame: UserStoppedSpeakingFrame | null,
  ): Promise<void> {
    // Before the first context there is no conversation to respond in.
    if (!this._isManualTurnDetection() || this._context === null) {
      return;
    }
    await this.sendClientEvent(new events.InputAudioBufferCommitEvent());
    await this._createResponse();
  }

  /** Handle bot stopped speaking event. */
  protected async _handleBotStoppedSpeaking(): Promise<void> {
    this._currentAudioResponse = null;
  }

  /** Whether an event belongs to the response an interruption cancelled. */
  protected _isFromInterruptedResponse(responseId: string | null): boolean {
    return responseId !== null && responseId === this._interruptedResponseId;
  }

  /**
   * Truncate the assistant audio the caller spoke over.
   *
   * Tells Voice Live how much of the response was actually heard, so the
   * conversation history matches what the caller received.
   */
  protected async _truncateCurrentAudioResponse(): Promise<void> {
    if (!this._currentAudioResponse) {
      return;
    }

    const current = this._currentAudioResponse;
    this._currentAudioResponse = null;

    // Playback runs behind the audio received, so the elapsed time can pass the
    // audio's length, and Voice Live rejects a truncation beyond it.
    const elapsedMs = Math.trunc(time() * 1000) - current.startTimeMs;
    const audioMs = Math.trunc((current.totalSize / 2 / this._getOutputSampleRate()) * 1000);
    await this.sendClientEvent(
      new events.ConversationItemTruncateEvent({
        itemId: current.itemId,
        contentIndex: current.contentIndex,
        audioEndMs: Math.max(Math.min(elapsedMs, audioMs), 0),
      }),
    );
  }

  //
  // Standard AIService frame handling
  //

  /**
   * Warn when the session properties leave out caller transcription.
   *
   * The caller's turns reach the context as transcripts, so without
   * `inputAudioTranscription` they are missing from the conversation history,
   * including the history `resetConversation` sends to the new session.
   * Setting it to `null` explicitly opts out of the warning.
   */
  protected _warnIfCallerIsNotTranscribed(): void {
    const props = this._settings.sessionProperties;
    if (isGiven(props) && !props.modelFieldsSet.has("inputAudioTranscription")) {
      logger.warning(
        `${this}: session_properties has no input_audio_transcription, so the ` +
          "caller's turns won't be added to the context. Set it (e.g. " +
          'InputAudioTranscription(model="azure-speech")), or set it to None ' +
          "to disable transcription without this warning.",
      );
    }
  }

  /**
   * Sync the session's audio formats with the transport's sample rates.
   *
   * Audio frames carry 16-bit PCM in both directions, so both formats are PCM
   * whatever the session properties name. Voice Live takes the input rate
   * directly but selects the output rate through the output format, so an
   * unsupported output rate falls back to the 24 kHz default.
   *
   * @param inputSampleRate Sample rate for audio input (Hz).
   * @param outputSampleRate Sample rate for audio output (Hz).
   */
  protected _ensureAudioConfig(inputSampleRate: number, outputSampleRate: number): void {
    this._inputSampleRate = inputSampleRate;
    const props = assertGiven(this._settings.sessionProperties);
    if (props.inputAudioFormat === "g711_ulaw" || props.inputAudioFormat === "g711_alaw") {
      logger.warning(
        `${this}: input_audio_format ${pyRepr(props.inputAudioFormat)} is not supported; ` +
          "audio is sent as PCM at the transport's input sample rate.",
      );
    }
    props.inputAudioFormat = "pcm16";
    props.inputAudioSamplingRate = inputSampleRate;

    if (props.outputAudioFormat === "g711_ulaw" || props.outputAudioFormat === "g711_alaw") {
      logger.warning(
        `${this}: output_audio_format ${pyRepr(props.outputAudioFormat)} is not supported; ` +
          "audio is returned as PCM at the transport's output sample rate.",
      );
    }

    const outputFormat = _OUTPUT_FORMAT_SAMPLE_RATES[outputSampleRate];
    if (outputFormat) {
      props.outputAudioFormat = outputFormat;
      this._outputSampleRate = outputSampleRate;
    } else {
      logger.warning(
        `${this}: Voice Live has no output format for ${outputSampleRate}Hz; ` +
          "using 24000Hz instead.",
      );
      props.outputAudioFormat = "pcm16";
      this._outputSampleRate = 24000;
    }
  }

  /**
   * Set up the service and connect.
   *
   * @param setup Configuration object containing setup parameters.
   */
  override async setup(setup: FrameProcessorSetup): Promise<void> {
    await super.setup(setup);
    this._ensureAudioConfig(setup.audioInSampleRate, setup.audioOutSampleRate);
    await this._connect();
  }

  /** Release resources on teardown. */
  override async cleanup(): Promise<void> {
    await super.cleanup();
    await this._disconnect();
  }

  /** Stop the service and close WebSocket connection. */
  override async stop(frame: EndFrame): Promise<void> {
    await super.stop(frame);
    await this._disconnect();
  }

  /** Cancel the service and close WebSocket connection. */
  override async cancel(frame: CancelFrame): Promise<void> {
    await super.cancel(frame);
    await this._disconnect();
  }

  //
  // Frame processing
  //

  /** Return the tools configured on `sessionProperties`, if any. */
  protected override _serviceTools(): ToolsSchema | unknown[] | null {
    return (assertGiven(this._settings.sessionProperties).tools ?? null) as
      | ToolsSchema
      | unknown[]
      | null;
  }

  /** Process incoming frames from the pipeline. */
  override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
    await super.processFrame(frame, direction);

    if (frame instanceof TranscriptionFrame) {
      // pass
    } else if (frame instanceof LLMContextFrame) {
      await this._handleContext(frame.context);
    } else if (frame instanceof InputAudioRawFrame) {
      if (!this._audioInputPaused) {
        await this._sendUserAudio(frame);
      }
    } else if (frame instanceof InterruptionFrame) {
      await this._handleInterruption();
    } else if (frame instanceof UserStartedSpeakingFrame) {
      await this._handleUserStartedSpeaking(frame);
    } else if (frame instanceof UserStoppedSpeakingFrame) {
      await this._handleUserStoppedSpeaking(frame);
    } else if (frame instanceof BotStoppedSpeakingFrame) {
      await this._handleBotStoppedSpeaking();
    } else if (frame instanceof SpeechControlParamsFrame) {
      this._handleSpeechControlParams(frame);
    } else if (frame instanceof LLMMessagesAppendFrame) {
      await this._handleMessagesAppend(frame);
    } else if (frame instanceof LLMSetToolsFrame) {
      // Continuous session: no fresh context frame per turn, so sync the
      // registered tool handlers to the new tool set here (the base service
      // only does this on LLMContextFrame).
      this._syncRegisteredToolHandlers(frame.tools);
      await this._sendSessionUpdate();
    }

    await this.pushFrame(frame, direction);
  }

  /** Handle LLM context updates. */
  protected async _handleContext(context: LLMContext): Promise<void> {
    if (!this._context) {
      this._context = context;
      this._lastContextMessageCount = context.getMessages().length;
      await this._processCompletedFunctionCalls(false);
      await this._createResponse();
    } else {
      this._context = context;
      await this._processCompletedFunctionCalls(true);

      // Check for new user messages (e.g. from text input).
      // The context is a shared mutable object, so we track the last
      // known message count to detect new additions.
      const messages = this._context.getMessages();
      const currentCount = messages.length;
      if (currentCount < this._lastContextMessageCount) {
        // A shorter context replaced the old one (setMessages, a new
        // LLMContext), so new messages are counted from its length. A
        // transcript still awaited may not be in it.
        this._lastContextMessageCount = currentCount;
        this._transcriptAwaitingContext = false;
      } else if (currentCount > this._lastContextMessageCount) {
        const newMessages = messages.slice(this._lastContextMessageCount);
        const lastMsg = messages[messages.length - 1];
        this._lastContextMessageCount = currentCount;

        // A transcript this service pushed is the caller's audio turn,
        // which Voice Live already has along with a response for it, so
        // sending it as a text item would duplicate the turn. Only a user
        // message consumes it: a tool result can reach the context first.
        if (this._transcriptAwaitingContext) {
          if (
            newMessages.some(
              (m) => !(m instanceof LLMSpecificMessage) && (m as Dict).role === "user",
            )
          ) {
            this._transcriptAwaitingContext = false;
          }
          return;
        }

        // LLMSpecificMessages are opaque provider-specific payloads, not
        // standard user messages — skip them.
        if (lastMsg instanceof LLMSpecificMessage) {
          return;
        }

        const last = lastMsg as Dict;
        if (last.role === "user") {
          let content: unknown = last.content ?? "";
          if (Array.isArray(content)) {
            content = (content as Dict[])
              .filter((c) => c.type === "text")
              .map((c) => c.text ?? "")
              .join(" ");
          }
          if (content) {
            const item = new events.ConversationItem({
              role: "user",
              type: "message",
              content: [new events.ItemContent({ type: "input_text", text: content as string })],
            });
            await this.sendClientEvent(new events.ConversationItemCreateEvent({ item }));
            await this._createResponse();
          }
        }
      }
    }
  }

  /** Handle a request to append messages to the conversation. */
  protected async _handleMessagesAppend(_frame: LLMMessagesAppendFrame): Promise<void> {
    logger.warning(`${this}: LLMMessagesAppendFrame is not yet supported by Voice Live`);
  }

  //
  // WebSocket communication
  //

  /**
   * Send a client event to the Voice Live API.
   *
   * @param event The client event to send.
   */
  async sendClientEvent(event: events.ClientEvent): Promise<void> {
    await this._wsSend(event.modelDump({ excludeNone: true }));
  }

  /**
   * Open the WebSocket connection.
   *
   * DIVERGENCE: upstream calls `websocket_connect` directly (its tests patch
   * the module); here the call goes through this method so tests and apps
   * can replace it.
   */
  protected async _websocketConnect(
    uri: string,
    options: WebsocketConnectOptions,
  ): Promise<WebsocketClientConnection> {
    return await websocketConnect(uri, options);
  }

  /** Establish WebSocket connection to Voice Live. */
  protected async _connect(): Promise<void> {
    try {
      if (this._websocket) {
        return;
      }

      let headers: Record<string, string>;
      if (this._tokenProvider) {
        headers = { Authorization: `Bearer ${await this._tokenProvider()}` };
      } else {
        headers = { "api-key": this.apiKey ?? "" };
      }

      const params = new URLSearchParams({
        "api-version": this._apiVersion,
        model: this._model,
      }).toString();
      const separator = this.baseUrl.includes("?") ? "&" : "?";
      const uri = `${this.baseUrl}${separator}${params}`;

      logger.info(`Connecting to ${this.baseUrl}`);
      this._websocket = await this._websocketConnect(uri, { additionalHeaders: headers });
      this._receiveTask = this.createTask(() => this._runReceiveLoop(), "_run_receive_loop");
    } catch (e) {
      rethrowIfCancelled(e);
      this._websocket = null;
      // Without a connection every later send is dropped, so the failure
      // is permanent and the unusable policy decides what follows.
      await this.pushError(`Error connecting to Voice Live: ${errorMessage(e)}`, {
        exception: e,
        forceTreatAsPermanent: true,
      });
    }
  }

  /** Close WebSocket connection. */
  protected async _disconnect(): Promise<void> {
    try {
      this._disconnecting = true;
      this._apiSessionReady = false;
      await this.stopAllMetrics();

      if (this._websocket) {
        await this._websocket.close();
        this._websocket = null;
      }

      if (this._receiveTask) {
        await this.cancelTask(this._receiveTask, 1.0);
        this._receiveTask = null;
      }

      this._completedToolCalls = new Set();
      this._audioSendLogged = false;
      this._interimTranscriptionText = "";
      this._responseInFlight = false;
      this._responseRequestEventId = null;
      this._runLlmWhenResponseDone = false;
      this._runLlmWhenApiSessionReady = false;
      this._transcriptAwaitingContext = false;
      this._userAudioPreroll = new Uint8Array(0);
      this._currentAssistantResponse = null;
      this._currentAudioResponse = null;
      this._ttsStarted = false;
      this._currentResponseId = null;
      this._interruptedResponseId = null;
      this._cancelAnnouncedResponse = false;
      this._pendingFunctionCalls = new Map();
    } catch (e) {
      rethrowIfCancelled(e);
      await this.pushError(`Error disconnecting: ${errorMessage(e)}`, { exception: e });
    } finally {
      // Sends are dropped while this is set, so it has to be cleared even
      // when closing failed partway through.
      this._disconnecting = false;
    }
  }

  /** Send a message over the WebSocket connection. */
  protected async _wsSend(realtimeMessage: Record<string, unknown>): Promise<void> {
    try {
      if (!this._disconnecting && this._websocket) {
        await this._websocket.send(pyJsonDumps(realtimeMessage));
      }
    } catch (e) {
      rethrowIfCancelled(e);
      if (e instanceof ConnectionClosed) {
        // The receive loop reports a lost connection once; every send after
        // it would otherwise report it again.
        return;
      }
      if (this._disconnecting || !this._websocket) {
        return;
      }
      await this.pushError(`Error sending client event: ${errorMessage(e)}`, { exception: e });
    }
  }

  /** Apply a settings delta, sending a session update when needed. */
  protected override async _updateSettings(delta: LLMSettings): Promise<Record<string, unknown>> {
    const inputRate = this._inputSampleRate;
    const outputRate = this._outputSampleRate;

    const changed = await super._updateSettings(delta);

    if ("sessionProperties" in changed) {
      this._warnIfCallerIsNotTranscribed();
      if (inputRate && outputRate) {
        this._ensureAudioConfig(inputRate, outputRate);
      }
    }

    // `model` is selected by the connection URL and rejected in the session
    // payload, so it stays unhandled and the base class reports the attempt.
    const handled = new Set(["sessionProperties", "systemInstruction", "temperature"]);
    const changedKeys = Object.keys(changed);
    if (changedKeys.some((key) => handled.has(key))) {
      await this._sendSessionUpdate();
    }
    this._warnUnhandledUpdatedSettings(changedKeys.filter((key) => !handled.has(key)));
    return changed;
  }

  /** Update session settings on the server. */
  protected async _sendSessionUpdate(): Promise<void> {
    // Mutate a copy: the stored session_properties is read elsewhere (e.g.
    // _serviceTools) and must stay intact.
    const settings = assertGiven(this._settings.sessionProperties).modelCopy();
    const adapter = this.getLlmAdapter();

    // The model is selected by the connection URL; repeating it in the
    // session payload is rejected.
    settings.model = null;

    // A repeated session update that names a voice on a text-only session is
    // rejected with "Text to speech synthesizer is not configured".
    if (
      settings.modalities &&
      settings.modalities.length > 0 &&
      !settings.modalities.includes("audio")
    ) {
      settings.voice = null;
    }

    if (this._context) {
      const llmInvocationParams = await adapter.getLlmInvocationParams(this._context, {
        systemInstruction: assertGiven(this._settings.systemInstruction),
        serviceTools: settings.tools,
      });

      // The adapter resolves conflicts between init-provided and
      // context-provided system instructions (preferring init-provided).
      if (llmInvocationParams.system_instruction) {
        settings.instructions = llmInvocationParams.system_instruction;
      }

      // The adapter settles the tools too: the context's own when it has
      // any, else the init-provided ones; built-in tools ride along either way.
      settings.tools = llmInvocationParams.tools as events.VoiceLiveTool[];
    } else {
      // No context yet: the init-provided tools; built-in tools ride along.
      settings.tools = adapter.fromStandardTools(settings.tools) as events.VoiceLiveTool[];
    }

    await this.sendClientEvent(new events.SessionUpdateEvent({ session: settings }));
  }

  //
  // Inbound server event handling
  //

  /**
   * Receive server events, reporting a connection that closes unexpectedly.
   *
   * Without its connection the service can't respond, so the loss is
   * reported as permanent and the pipeline worker's `ProcessorUnusablePolicy`
   * decides what follows.
   */
  protected async _runReceiveLoop(): Promise<void> {
    const websocket = this._websocket;
    if (websocket === null) {
      throw new Error("AssertionError: _websocket is None");
    }

    let error: ConnectionClosed | null = null;
    try {
      await this._receiveTaskHandler();
    } catch (e) {
      if (!(e instanceof ConnectionClosed)) throw e;
      error = e;
    }

    if (this._disconnecting) {
      return;
    }

    if (this._websocket === websocket) {
      this._websocket = null;
    }
    this._apiSessionReady = false;
    await this.pushError(`Voice Live connection closed${error ? `: ${error.message}` : ""}`, {
      exception: error ?? undefined,
      forceTreatAsPermanent: true,
    });
  }

  /** Handle incoming WebSocket messages. */
  protected async _receiveTaskHandler(): Promise<void> {
    if (this._websocket === null) {
      throw new Error("AssertionError: _websocket is None");
    }

    for await (const message of this._websocket) {
      let evt: any;
      try {
        evt = events.parseServerEvent(message as string | Uint8Array);
      } catch (e) {
        rethrowIfCancelled(e);
        logger.warning(`${this} failed to parse server event: ${errorMessage(e)}`);
        continue;
      }

      // Events this service doesn't act on aren't modelled and parse to null.
      if (evt === null) {
        continue;
      }

      if (evt.type === "session.created") {
        await this._handleEvtSessionCreated(evt);
      } else if (evt.type === "session.updated") {
        await this._handleEvtSessionUpdated(evt);
      } else if (evt.type === "response.created") {
        await this._handleEvtResponseCreated(evt);
      } else if (evt.type === "response.audio.delta") {
        await this._handleEvtAudioDelta(evt);
      } else if (evt.type === "response.output_item.added") {
        await this._handleEvtOutputItemAdded(evt);
      } else if (evt.type === "conversation.item.created") {
        await this._handleEvtConversationItemCreated(evt);
      } else if (evt.type === "conversation.item.input_audio_transcription.delta") {
        await this._handleEvtInputAudioTranscriptionDelta(evt);
      } else if (evt.type === "conversation.item.input_audio_transcription.completed") {
        await this._handleEvtInputAudioTranscriptionCompleted(evt);
      } else if (evt.type === "conversation.item.input_audio_transcription.failed") {
        await this._handleEvtInputAudioTranscriptionFailed(evt);
      } else if (evt.type === "response.done") {
        await this._handleEvtResponseDone(evt);
      } else if (evt.type === "input_audio_buffer.speech_started") {
        await this._handleEvtSpeechStarted(evt);
      } else if (evt.type === "input_audio_buffer.speech_stopped") {
        await this._handleEvtSpeechStopped(evt);
      } else if (evt.type === "response.audio_transcript.delta") {
        await this._handleEvtAudioTranscriptDelta(evt);
      } else if (evt.type === "response.text.delta") {
        await this._handleEvtTextDelta(evt);
      } else if (evt.type === "response.function_call_arguments.done") {
        await this._handleEvtFunctionCallArgumentsDone(evt);
      } else if (evt.type === "error") {
        await this._handleEvtError(evt);
      }
    }
  }

  /** Handle session.created event — first event after connecting. */
  protected async _handleEvtSessionCreated(_evt: events.SessionCreatedEvent): Promise<void> {
    await this._sendSessionUpdate();
  }

  /** Handle session.updated event. */
  protected async _handleEvtSessionUpdated(_evt: events.SessionUpdatedEvent | null): Promise<void> {
    this._apiSessionReady = true;
    if (this._runLlmWhenApiSessionReady) {
      this._runLlmWhenApiSessionReady = false;
      await this._createResponse();
    }
  }

  /** Handle response.created event. */
  protected async _handleEvtResponseCreated(evt: events.ResponseCreated): Promise<void> {
    this._responseInFlight = true;
    this._responseRequestEventId = null;
    this._currentResponseId = evt.response.id ?? null;
    if (this._cancelAnnouncedResponse) {
      this._cancelAnnouncedResponse = false;
      this._interruptedResponseId = this._currentResponseId;
    }
  }

  /** Handle audio delta event — streaming audio from assistant. */
  protected async _handleEvtAudioDelta(evt: events.ResponseAudioDelta): Promise<void> {
    if (this._isFromInterruptedResponse(evt.responseId)) {
      return;
    }

    await this.stopTtfbMetrics();

    // A new audio item can start before the previous one finishes playing (the
    // response after a tool result, for one). Truncation follows the newest.
    if (this._currentAudioResponse && this._currentAudioResponse.itemId !== evt.itemId) {
      logger.debug(`${this} tracking new audio item ${evt.itemId}`);
      this._currentAudioResponse = null;
    }

    if (!this._currentAudioResponse) {
      this._currentAudioResponse = new CurrentAudioResponse({
        itemId: evt.itemId as string,
        contentIndex: evt.contentIndex,
        startTimeMs: Math.trunc(time() * 1000),
      });
    }
    if (!this._ttsStarted) {
      this._ttsStarted = true;
      await this.pushFrame(new TTSStartedFrame());
    }

    const audio = base64ToBytes(evt.delta);
    this._currentAudioResponse.totalSize += audio.length;

    const frame = new TTSAudioRawFrame({
      audio,
      sampleRate: this._getOutputSampleRate(),
      numChannels: 1,
    });
    await this.pushFrame(frame);
  }

  /** Handle response.output_item.added, the first announcement of a response item. */
  protected async _handleEvtOutputItemAdded(evt: events.ResponseOutputItemAdded): Promise<void> {
    await this._trackItem(evt.item);
  }

  /**
   * Handle conversation.item.created, sent once for every item in the
   * conversation.
   *
   * A response's items were already announced by response.output_item.added,
   * so tracking them again is a no-op; the event handler fires only here.
   */
  protected async _handleEvtConversationItemCreated(
    evt: events.ConversationItemCreated,
  ): Promise<void> {
    await this._trackItem(evt.item);
    await this._callEventHandler("on_conversation_item_created", evt.item.id, evt.item);
  }

  /** Track a function call or open the assistant response for a new item. */
  protected async _trackItem(item: events.ConversationItem): Promise<void> {
    if (item.type === "function_call") {
      const callId = item.callId as string;
      if (!this._pendingFunctionCalls.has(callId)) {
        this._pendingFunctionCalls.set(callId, item);
      } else {
        logger.debug(`Function call ${callId} already tracked, skipping`);
      }
    }

    if (item.role === "assistant") {
      const alreadyOpen =
        this._currentAssistantResponse !== null && this._currentAssistantResponse.id === item.id;
      this._currentAssistantResponse = item;
      if (!alreadyOpen) {
        await this.pushFrame(new LLMFullResponseStartFrame());
      }
    }
  }

  /**
   * Handle streaming input audio transcription delta.
   *
   * Accumulates deltas per item and pushes the running text as an
   * InterimTranscriptionFrame so the UI shows the full partial transcript.
   */
  protected async _handleEvtInputAudioTranscriptionDelta(
    evt: events.ConversationItemInputAudioTranscriptionDelta,
  ): Promise<void> {
    if (evt.delta) {
      this._interimTranscriptionText += evt.delta;
      await this.pushFrame(
        new InterimTranscriptionFrame({
          text: this._interimTranscriptionText,
          userId: "",
          timestamp: timeNowIso8601(),
        }),
        FrameDirection.UPSTREAM,
      );
    }
  }

  /** Handle input audio transcription completed event. */
  protected async _handleEvtInputAudioTranscriptionCompleted(
    evt: Pick<events.ConversationItemInputAudioTranscriptionCompleted, "itemId" | "transcript">,
  ): Promise<void> {
    this._interimTranscriptionText = "";
    await this._callEventHandler("on_conversation_item_updated", evt.itemId, null);

    // Voice Live also reports an empty transcript for an item it already
    // transcribed once the next audio is committed; only a non-empty one
    // reaches the context.
    const transcript = evt.transcript ? evt.transcript.trim() : "";
    if (transcript) {
      this._transcriptAwaitingContext = true;
      await this.pushFrame(
        new TranscriptionFrame({
          text: transcript,
          userId: "",
          timestamp: timeNowIso8601(),
          result: evt,
        }),
        FrameDirection.UPSTREAM,
      );
    }
  }

  /**
   * Handle input audio transcription failed event.
   *
   * The partial text accumulated for this item would otherwise be carried
   * into the next turn, since only a completed transcription clears it.
   */
  protected async _handleEvtInputAudioTranscriptionFailed(
    evt: events.ConversationItemInputAudioTranscriptionFailed,
  ): Promise<void> {
    this._interimTranscriptionText = "";
    const message = evt.error ? evt.error.message : null;
    await this.pushError(`Voice Live transcription failed: ${message || "no detail given"}`);
  }

  /** Handle response.done event. */
  protected async _handleEvtResponseDone(evt: events.ResponseDone): Promise<void> {
    const usage = evt.usage;
    if (usage?.totalTokens) {
      const tokens = new LLMTokenUsage({
        promptTokens: usage.inputTokens || 0,
        completionTokens: usage.outputTokens || 0,
        totalTokens: usage.totalTokens || 0,
      });
      await this.startLlmUsageMetrics(tokens);
    }

    await this.stopProcessingMetrics();
    this._responseInFlight = false;
    this._currentResponseId = null;
    this._cancelAnnouncedResponse = false;
    if (this._interruptedResponseId === (evt.response.id ?? null)) {
      this._interruptedResponseId = null;
    }

    // Stopped here rather than on each item's response.audio.done, so a
    // response with several audio items is bracketed by one TTS pair. An
    // interruption closes both before the cancelled response reports done,
    // so only close what is still open.
    if (this._ttsStarted) {
      this._ttsStarted = false;
      await this.pushFrame(new TTSStoppedFrame());
    }
    if (this._currentAssistantResponse) {
      this._currentAssistantResponse = null;
      await this.pushFrame(new LLMFullResponseEndFrame());
    }

    if (evt.status === "failed") {
      const details = evt.response.status_details;
      // DIVERGENCE: upstream reports `str(details)` (a Python dict repr); the
      // details are reported as JSON here.
      await this.pushError(details ? pyJsonDumps(details) : "Response failed");
    } else {
      // A null output is treated as no output.
      for (const item of (evt.response.output as Dict[] | null | undefined) ?? []) {
        await this._callEventHandler("on_conversation_item_updated", item.id ?? null, item);
      }
    }

    // A response deferred behind this one is owed whichever way this one ended.
    if (this._runLlmWhenResponseDone) {
      this._runLlmWhenResponseDone = false;
      await this._createResponse();
    }
  }

  /**
   * Handle a text delta, which carries the response when "text" is the only
   * modality.
   *
   * A session that also responds with audio reports its text through
   * `response.audio_transcript.delta` instead.
   */
  protected async _handleEvtTextDelta(evt: events.ResponseTextDelta): Promise<void> {
    if (this._isFromInterruptedResponse(evt.responseId)) {
      return;
    }
    await this.stopTtfbMetrics();
    if (evt.delta) {
      await this.pushFrame(new LLMTextFrame({ text: evt.delta }));
    }
  }

  /** Handle audio transcript delta event. */
  protected async _handleEvtAudioTranscriptDelta(
    evt: events.ResponseAudioTranscriptDelta,
  ): Promise<void> {
    if (evt.delta && !this._isFromInterruptedResponse(evt.responseId)) {
      await this._pushOutputTranscriptTextFrames(evt.delta);
    }
  }

  protected async _pushOutputTranscriptTextFrames(text: string): Promise<void> {
    // Push LLMTextFrame for RTVI "bot-llm-text" events (not appended to context
    // to avoid duplication since the realtime API manages its own context).
    const llmTextFrame = new LLMTextFrame({ text });
    llmTextFrame.appendToContext = false;
    await this.pushFrame(llmTextFrame);

    // Push TTSTextFrame for output aggregation
    const ttsTextFrame = new TTSTextFrame({ text, textType: TextType.SENTENCE });
    ttsTextFrame.includesInterFrameSpaces = true;
    await this.pushFrame(ttsTextFrame);
  }

  /** Handle function call arguments done event. */
  protected async _handleEvtFunctionCallArgumentsDone(
    evt: events.ResponseFunctionCallArgumentsDone,
  ): Promise<void> {
    try {
      const args = pyJsonLoads(evt.arguments) as Record<string, unknown>;

      const callId = evt.callId as string;
      const functionCallItem = this._pendingFunctionCalls.get(callId);
      if (functionCallItem) {
        this._pendingFunctionCalls.delete(callId);

        const functionName = evt.name || functionCallItem.name;
        if (!functionName) {
          logger.warning(`No function name for call_id: ${evt.callId}`);
          return;
        }

        const functionCalls = [
          new FunctionCallFromLLM({
            context: this._context,
            toolCallId: callId,
            functionName,
            arguments: args,
          }),
        ];

        await this.runFunctionCalls(functionCalls);
        logger.debug(`Processed function call: ${functionName}`);
      } else {
        logger.warning(`No tracked function call found for call_id: ${evt.callId}`);
      }
    } catch (e) {
      rethrowIfCancelled(e);
      logger.error(`Failed to process function call arguments: ${errorMessage(e)}`);
    }
  }

  /** Handle speech started event from server-side VAD. */
  protected async _handleEvtSpeechStarted(
    _evt: events.InputAudioBufferSpeechStarted,
  ): Promise<void> {
    if (this._isManualTurnDetection()) {
      // In manual mode, the client is responsible for broadcasting user turn frames
      return;
    }

    await this._truncateCurrentAudioResponse();
    await this.broadcastFrame(ProposedUserStartedSpeakingFrame);
  }

  /** Handle speech stopped event from server-side VAD. */
  protected async _handleEvtSpeechStopped(
    _evt: events.InputAudioBufferSpeechStopped,
  ): Promise<void> {
    if (this._isManualTurnDetection()) {
      // In manual mode, the client is responsible for broadcasting user turn frames
      return;
    }

    await this.startTtfbMetrics();
    await this.startProcessingMetrics();
    await this.broadcastFrame(ProposedUserStoppedSpeakingFrame);
  }

  /**
   * Report an error event from Voice Live.
   *
   * An error event rejects one request and the session stays usable. An
   * error that ends the session also closes the connection, which the
   * receive loop reports as permanent.
   */
  protected async _handleEvtError(evt: events.ErrorEvent): Promise<void> {
    if (
      evt.error.eventId !== null &&
      evt.error.eventId === this._responseRequestEventId &&
      evt.error.code !== "conversation_already_has_active_response"
    ) {
      await this._handleRejectedResponseRequest();
    }

    if (evt.error.code !== null && _EXPECTED_ERROR_CODES.has(evt.error.code)) {
      logger.debug(`${this} ${evt.error.message}`);
      return;
    }
    await this.pushError(`Azure Voice Live Error: ${evt.error.message}`);
  }

  //
  // Response creation
  //

  /**
   * Reset the conversation by disconnecting and reconnecting.
   *
   * This fully resets the server-side conversation state. Audio buffers,
   * pending function calls, and conversation history are cleared.
   */
  async resetConversation(): Promise<void> {
    const context = this._context;
    if (context === null) {
      logger.warning(
        "reset_conversation called before an initial context was received; nothing to reset",
      );
      return;
    }

    logger.debug("Resetting Voice Live conversation");
    await this._disconnect();

    // Clearing the tracked context sends the history to the new session:
    // _handleContext only runs conversation setup when it has none.
    this._context = null;
    this._lastContextMessageCount = 0;
    this._llmNeedsConversationSetup = true;

    await this._connect();
    await this._handleContext(context);
  }

  /** Create an assistant response. */
  protected async _createResponse(): Promise<void> {
    if (!this._apiSessionReady) {
      this._runLlmWhenApiSessionReady = true;
      return;
    }

    // Voice Live rejects a second response while one is running, so a
    // response asked for mid-flight (a tool result landing before the
    // calling response finished) waits for response.done instead.
    if (this._responseInFlight) {
      this._runLlmWhenResponseDone = true;
      return;
    }

    if (this._context === null) {
      throw new Error("AssertionError: _context is None");
    }

    const adapter = this.getLlmAdapter();

    if (this._llmNeedsConversationSetup) {
      this._logLlmConversationSetup(this._context);

      const llmInvocationParams = await adapter.getLlmInvocationParams(this._context, {
        systemInstruction: assertGiven(this._settings.systemInstruction),
      });

      for (const item of llmInvocationParams.messages) {
        await this.sendClientEvent(new events.ConversationItemCreateEvent({ item }));
      }

      await this._sendSessionUpdate();
      this._llmNeedsConversationSetup = false;
    }

    logger.debug("Creating Voice Live response");

    await this.startProcessingMetrics();
    await this.startTtfbMetrics();

    // Running from the request on: an interruption can arrive before Voice
    // Live announces the response, and a second request before then is
    // rejected. A request Voice Live rejects for an unannounced response of
    // its own is cleared by that response's response.done; any other
    // rejection names the request's event_id and is cleared in
    // _handleEvtError.
    this._responseInFlight = true;
    // The response takes the session's modalities. Overriding them per response
    // is rejected for native-audio voices, which accept only ["text"] or ["audio"].
    const request = new events.ResponseCreateEvent();
    this._responseRequestEventId = request.eventId;
    await this.sendClientEvent(request);
  }

  /**
   * Release a response request Voice Live rejected before announcing it.
   *
   * No response.done follows a rejected request, so the in-flight state it
   * set is cleared here, and a response deferred behind it goes out now.
   */
  protected async _handleRejectedResponseRequest(): Promise<void> {
    this._responseRequestEventId = null;
    this._responseInFlight = false;
    this._cancelAnnouncedResponse = false;
    await this.stopAllMetrics();
    if (this._runLlmWhenResponseDone) {
      this._runLlmWhenResponseDone = false;
      await this._createResponse();
    }
  }

  /** Process completed function calls and send results to the service. */
  protected async _processCompletedFunctionCalls(sendNewResults: boolean): Promise<void> {
    if (this._context === null) {
      throw new Error("AssertionError: _context is None");
    }

    let sentNewResult = false;

    for (const message of this._context.getMessages()) {
      // LLMSpecificMessages are opaque provider-specific payloads, not
      // standard tool-result messages — skip them.
      if (message instanceof LLMSpecificMessage) {
        continue;
      }

      // Async-tool messages live alongside regular tool messages in the
      // context; detect and route them before the regular logic so we
      // don't try to send the async-tool envelope JSON as a tool result.
      const asyncPayload = asyncToolMessages.parseMessage(message);
      if (asyncPayload !== null) {
        if (this._completedToolCalls.has(asyncPayload.toolCallId)) {
          continue;
        }
        if (asyncPayload.kind === "started") {
          // The provider already issued the tool call and natively
          // awaits a result; nothing to send for the started marker.
          continue;
        }
        if (asyncPayload.kind === "intermediate") {
          logger.error(
            `${this}: Voice Live does not support streamed async ` +
              "tool results; dropping intermediate result for " +
              `tool_call_id=${asyncPayload.toolCallId}. Consider ` +
              "another LLM service if your tool needs to stream " +
              "intermediate results.",
          );
          await this.pushError("Voice Live does not support streamed async tool results.");
          continue;
        }
        if (asyncPayload.kind === "final") {
          // Deliver via the formal tool-result channel — same path
          // as a synchronous tool result, just delayed.
          if (sendNewResults) {
            sentNewResult = true;
            await this._sendToolResult(asyncPayload.toolCallId, asyncPayload.result);
          }
          this._completedToolCalls.add(asyncPayload.toolCallId);
          continue;
        }
        // Defensive: any async-tool message must not fall through
        // to the regular tool-result block below, even if it
        // carries a kind we don't recognize.
        continue;
      }

      // Look for newly-completed "regular" (as opposed to async-tool) results
      const msg = message as unknown as Dict;
      if (msg.role === "tool" && msg.content !== "IN_PROGRESS") {
        const toolCallId = msg.tool_call_id as string | undefined;
        if (toolCallId && !this._completedToolCalls.has(toolCallId)) {
          if (sendNewResults) {
            sentNewResult = true;
            await this._sendToolResult(toolCallId, (msg.content as string | undefined) ?? null);
          }
          this._completedToolCalls.add(toolCallId);
        }
      }
    }

    // If we reported any new tool call results to the service, trigger
    // another response
    if (sentNewResult) {
      await this._createResponse();
    }
  }

  /** Send user audio to Voice Live. */
  protected async _sendUserAudio(frame: InputAudioRawFrame): Promise<void> {
    if (!this._audioSendLogged) {
      logger.debug(
        `Streaming audio to Voice Live: ${frame.sampleRate}Hz, ` +
          `${frame.numChannels}ch, ${frame.audio.length}B/frame`,
      );
      this._audioSendLogged = true;
    }

    const payload = bytesToBase64(frame.audio);
    await this.sendClientEvent(new events.InputAudioBufferAppendEvent({ audio: payload }));
    if (this._isManualTurnDetection()) {
      const joined = new Uint8Array(this._userAudioPreroll.length + frame.audio.length);
      joined.set(this._userAudioPreroll, 0);
      joined.set(frame.audio, this._userAudioPreroll.length);
      const prerollBytes = Math.trunc(
        frame.sampleRate * frame.numChannels * 2 * this._userAudioPrerollSecs,
      );
      // `del buf[:-n]` keeps the last n bytes (and everything when n is 0).
      this._userAudioPreroll =
        prerollBytes > 0 && joined.length > prerollBytes
          ? joined.slice(joined.length - prerollBytes)
          : joined;
    }
  }

  /** Size the replayed speech onset to the local VAD's start delay. */
  protected _handleSpeechControlParams(frame: SpeechControlParamsFrame): void {
    if (frame.vadParams !== null) {
      this._userAudioPrerollSecs = frame.vadParams.startSecs + _USER_AUDIO_PREROLL_MARGIN_SECS;
    }
  }

  /** Send a tool call result to Voice Live. */
  protected async _sendToolResult(toolCallId: string, result: string | null): Promise<void> {
    const item = new events.ConversationItem({
      type: "function_call_output",
      callId: toolCallId,
      output: result,
    });
    await this.sendClientEvent(new events.ConversationItemCreateEvent({ item }));
  }
}
