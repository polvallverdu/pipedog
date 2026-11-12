// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/services/openai/realtime/llm.py

/**
 * OpenAI Realtime LLM service implementation with WebSocket support.
 *
 * Porting notes:
 * - The deprecated `model` and `sessionProperties` constructor options are
 *   not ported; use `settings: new OpenAIRealtimeLLMService.Settings({ model,
 *   sessionProperties })` instead.
 * - The websocket is `websocketConnect()` from core (the global `WebSocket`).
 * - Video frames are encoded with core's `encodeImage()` (upstream: Pillow).
 * - The tracing decorators are applied in a static block (decorator syntax is
 *   not erasable).
 */

import { Future, rethrowIfCancelled, type Task, time } from "@pipedog/asyncio";
import type { BaseLLMAdapter } from "@pipedog/core/adapters/llm/base_llm_adapter";
import type { ToolsSchema } from "@pipedog/core/adapters/llm/schemas/tools_schema";
import { createStreamResampler } from "@pipedog/core/audio/utils";
import {
  BotStoppedSpeakingFrame,
  type CancelFrame,
  type EndFrame,
  type Frame,
  FunctionCallCancelFrame,
  FunctionCallFromLLM,
  FunctionCallResultFrame,
  InputAudioRawFrame,
  InputImageRawFrame,
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
  standardMessageText,
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
  type WebsocketClientConnection,
  websocketConnect,
} from "@pipedog/core/services/websocket_service";
import { Language } from "@pipedog/core/transcriptions/language";
import { ExternalUserTurnStrategies } from "@pipedog/core/turns/user_turn_strategies";
import { base64ToBytes, bytesToBase64 } from "@pipedog/core/utils/base64";
import { encodeImage } from "@pipedog/core/utils/image";
import { logger } from "@pipedog/core/utils/logger";
import { pyJsonDumps, pyJsonLoads } from "@pipedog/core/utils/py_json";
import { timeNowIso8601 } from "@pipedog/core/utils/time";
import {
  installTracedStt,
  tracedOpenaiRealtime,
} from "@pipedog/core/utils/tracing/service_decorators";
import { assertGiven, isGiven, NOT_GIVEN, type NotGiven } from "@pipedog/core/utils/types";
import { OPENAI_REALTIME_WHISPER_MODEL, OPENAI_SAMPLE_RATE } from "../_constants.ts";
import { OpenAIRealtimeLLMAdapter } from "../open_ai_realtime_adapter.ts";
import * as events from "./events.ts";

// Pre-roll cushion added on top of the auto-sized duration (start_secs), to
// absorb small timing slop between start_secs and the audio actually clipped,
// and to give a bit of extra audio context for the model.
// Not applied to an explicit userAudioPrerollSecs override.
export const AUTOSIZED_USER_AUDIO_PREROLL_MARGIN_SECS = 0.3;
// Pre-roll used before start_secs is known (no SpeechControlParamsFrame yet, or
// no upstream VAD) and no override is given.
export const DEFAULT_USER_AUDIO_PREROLL_SECS = 0.5;

// The adapter's invocation params are an interface, which isn't assignable to
// the `Record<string, unknown>` of `LLMService`'s adapter constraint.
type RealtimeAdapter = OpenAIRealtimeLLMAdapter & BaseLLMAdapter;

/** The values of `events.ImageDetail` (upstream reads them with `get_args`). */
const IMAGE_DETAILS: readonly string[] = ["auto", "low", "high"];

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Convert a snake_case key to camelCase (`output_modalities` → `outputModalities`). */
function snakeToCamel(key: string): string {
  return key.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

/** Python truthiness, for `x if value else y`. */
function pyTruthy(value: unknown): boolean {
  if (value === null || value === undefined || value === false) return false;
  if (value === 0 || value === "") return false;
  if (Array.isArray(value)) return value.length > 0;
  if (value instanceof Map || value instanceof Set) return value.size > 0;
  if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.keys(value).length > 0;
  }
  return true;
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
  /** ID of the server response the item belongs to. Defaults to "". */
  responseId?: string;
}

/**
 * Tracks the current audio response from the assistant.
 *
 * - `itemId`: unique identifier for the audio response item.
 * - `contentIndex`: index of the audio content within the item.
 * - `startTimeMs`: timestamp when the audio response started in milliseconds.
 * - `totalSize`: total size of audio data received in bytes. Defaults to 0.
 * - `responseId`: ID of the server response the item belongs to. Defaults to "".
 */
export class CurrentAudioResponse {
  itemId: string;
  contentIndex: number;
  startTimeMs: number;
  totalSize: number;
  responseId: string;

  constructor(options: CurrentAudioResponseOptions) {
    this.itemId = options.itemId;
    this.contentIndex = options.contentIndex;
    this.startTimeMs = options.startTimeMs;
    this.totalSize = options.totalSize ?? 0;
    this.responseId = options.responseId ?? "";
  }
}

export interface OpenAIRealtimeLLMSettingsOptions extends LLMSettingsOptions {
  /**
   * OpenAI Realtime session properties (modalities, audio config, tools,
   * etc.). `model` and `instructions` are synced bidirectionally with the
   * top-level `model` and `systemInstruction` fields.
   */
  sessionProperties?: events.SessionProperties | NotGiven;
}

/**
 * Settings for OpenAIRealtimeLLMService.
 *
 * - `sessionProperties`: OpenAI Realtime session properties (modalities,
 *   audio config, tools, etc.). `model` and `instructions` are synced
 *   bidirectionally with the top-level `model` and `systemInstruction` fields.
 */
export class OpenAIRealtimeLLMSettings extends LLMSettings {
  sessionProperties: events.SessionProperties | NotGiven = NOT_GIVEN;

  constructor(options: OpenAIRealtimeLLMSettingsOptions = {}) {
    super(options);
    this._assignOptions(options);
  }

  // -- Bidirectional sync helpers ------------------------------------------

  /** Push top-level `model`/`systemInstruction` into `sessionProperties`. */
  static _syncTopLevelToSp(settings: OpenAIRealtimeLLMSettings): void {
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
  }

  // -- applyUpdate override -------------------------------------------------

  /**
   * Merge a delta, keeping `model`/`systemInstruction` in sync with SP.
   *
   * When the delta contains `sessionProperties`, it **replaces** the stored
   * SP wholesale (matching legacy behaviour). Top-level field values always
   * take precedence over conflicting SP values.
   */
  override applyUpdate(delta: this): Record<string, unknown> {
    // 1. Let the base class handle all fields including sessionProperties
    //    (wholesale replacement when given).
    const changed = super.applyUpdate(delta);

    // 2. SP → top-level: if the SP was just replaced and carries
    //    model/instructions that the delta didn't set at top level,
    //    pull them up.
    if ("sessionProperties" in changed && isGiven(this.sessionProperties)) {
      const sp = this.sessionProperties;
      if (!("model" in changed) && sp.model !== null && sp.model !== undefined) {
        const oldModel = this.model;
        this.model = sp.model;
        if (oldModel !== this.model) {
          changed.model = oldModel;
        }
      }
      if (
        !("systemInstruction" in changed) &&
        sp.instructions !== null &&
        sp.instructions !== undefined
      ) {
        const oldSi = this.systemInstruction;
        this.systemInstruction = sp.instructions;
        if (oldSi !== this.systemInstruction) {
          changed.systemInstruction = oldSi;
        }
      }
    }

    // 3. Top-level → SP: ensure SP mirrors the authoritative top-level
    //    values. Covers all cases: top-level-only delta, SP-only delta,
    //    and mixed deltas where top-level takes precedence.
    OpenAIRealtimeLLMSettings._syncTopLevelToSp(this);

    return changed;
  }

  // -- fromMapping override -------------------------------------------------

  /**
   * Build a delta from a plain dict, routing SP keys into `sessionProperties`.
   *
   * Keys that correspond to `SessionProperties` fields (except `model`) are
   * collected into a nested `sessionProperties` value. `model` is always
   * routed to the top-level field. Unknown keys go to `extra`. Keys may use
   * upstream's snake_case spelling or the camelCase field names.
   */
  static override fromMapping<T extends ServiceSettings>(
    this: new (
      options?: object,
    ) => T,
    settings: Record<string, unknown>,
  ): T {
    const cls = this as unknown as typeof OpenAIRealtimeLLMSettings & (new (options?: object) => T);
    // Determine which keys belong to our own dataclass fields.
    const ownFieldNames = new Set(new cls()._fieldNames());

    const top: Record<string, unknown> = {};
    const spDict: Record<string, unknown> = {};
    const extra: Record<string, unknown> = {};

    // Build the SP field set without instantiating (avoid constructor
    // cost for every fromMapping call). `modelFields` maps camelCase field
    // names to wire keys; both spellings are accepted.
    const spKeys = new Map<string, string>();
    for (const [field, wire] of Object.entries(events.SessionProperties.modelFields)) {
      if (field === "model") continue;
      spKeys.set(field, field);
      spKeys.set(wire, field);
    }

    for (const [key, value] of Object.entries(settings)) {
      // Resolve aliases first
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

export interface OpenAIRealtimeLLMServiceOptions extends LLMServiceOptions {
  /** OpenAI API key for authentication. */
  apiKey: string;
  /**
   * WebSocket base URL for the realtime API. Defaults to
   * "wss://api.openai.com/v1/realtime".
   */
  baseUrl?: string;
  /** Runtime-updatable settings for this service. */
  settings?: OpenAIRealtimeLLMSettings | null;
  /** Whether to start with audio input paused. Defaults to false. */
  startAudioPaused?: boolean;
  /** Whether to start with video input paused. Defaults to false. */
  startVideoPaused?: boolean;
  /**
   * Detail level for video processing. Can be "auto", "low", or "high". This
   * sets the image_detail parameter in the OpenAI Realtime API. "auto" lets
   * the model decide, "low" is faster and uses fewer tokens, "high" provides
   * more detail. Defaults to "auto".
   */
  videoFrameDetail?: events.ImageDetail;
  /**
   * In manual turn-detection mode (`turn_detection=False`, locally-driven
   * turns), how much recent audio to replay after an interruption clears the
   * input audio buffer, so the speech onset isn't lost. Defaults to null:
   * auto-sized to the upstream VAD's `startSecs` plus a small margin, falling
   * back to `DEFAULT_USER_AUDIO_PREROLL_SECS` when no VAD is present.
   * Auto-sizing assumes VAD drives turn starts (the default
   * `VADUserTurnStartStrategy`); set this explicitly if you use a non-VAD
   * turn-start strategy. No effect when server-side turn detection is enabled.
   */
  userAudioPrerollSecs?: number | null;
}

/**
 * OpenAI Realtime LLM service providing real-time audio and text communication.
 *
 * Implements the OpenAI Realtime API with WebSocket communication for
 * low-latency bidirectional audio and text interactions. Supports function
 * calling, conversation management, and real-time transcription.
 *
 * Proposes turn boundaries from OpenAI's server-side VAD events, which the
 * recommended external user turn strategies resolve into
 * `UserStartedSpeakingFrame` / `UserStoppedSpeakingFrame`, so pipeline
 * processors that depend on those frames (RTVI client speech events,
 * `TurnTrackingObserver`, `AudioBufferProcessor` turn recording,
 * `UserIdleController`, user mute strategies, voicemail detector) work out of
 * the box. `LLMContextAggregatorPair` auto-detects this realtime service and
 * decouples context writes from those frames; see the
 * `examples/realtime/realtime-openai.py` example.
 *
 * If you wire local VAD (`LLMUserAggregatorParams.vadAnalyzer`) on top of this
 * service, disable OpenAI's server-side turn detection first
 * (`turn_detection=False`); otherwise both sources broadcast duplicate
 * user-turn frames. See
 * `examples/realtime/realtime-openai-locally-driven-turns.py`.
 */
export class OpenAIRealtimeLLMService extends LLMService<RealtimeAdapter> {
  static Settings = OpenAIRealtimeLLMSettings;
  declare protected _settings: OpenAIRealtimeLLMSettings;

  // Overriding the default adapter to use the OpenAIRealtimeLLMAdapter one.
  static override adapterClass: LLMAdapterClass | null =
    OpenAIRealtimeLLMAdapter as unknown as LLMAdapterClass;

  // Substrings used to recognize reasoning-capable Realtime models. Substring
  // match (rather than exact equality) so date-versioned variants of the same
  // base model also match without code changes. Extend this tuple as OpenAI
  // ships more reasoning-capable Realtime models.
  static _REASONING_CAPABLE_MODEL_SUBSTRINGS: readonly string[] = [
    "gpt-realtime-2",
    "gpt-realtime-2.1",
  ];

  static {
    const proto = OpenAIRealtimeLLMService.prototype as unknown as Record<string, any>;
    proto._handleEvtSessionCreated = tracedOpenaiRealtime("llm_setup")(
      proto._handleEvtSessionCreated,
    );
    proto._handleEvtResponseDone = tracedOpenaiRealtime("llm_response")(
      proto._handleEvtResponseDone,
    );
    proto._createResponse = tracedOpenaiRealtime("llm_request")(proto._createResponse);
    installTracedStt(OpenAIRealtimeLLMService.prototype, "_handleUserTranscription");
  }

  apiKey: string;
  baseUrl: string;
  protected _audioInputPaused: boolean;
  protected _videoInputPaused: boolean;
  protected _videoFrameDetail: events.ImageDetail;
  protected _lastSentTime = 0;
  protected _websocket: WebsocketClientConnection | null = null;
  protected _receiveTask: Task<unknown> | null = null;
  protected _context: LLMContext | null = null;

  protected _llmNeedsConversationSetup = true;

  protected _disconnecting = false;
  protected _apiSessionReady = false;
  protected _runLlmWhenApiSessionReady = false;

  protected _currentAssistantResponse: events.ConversationItem | null = null;
  protected _currentAudioResponse: CurrentAudioResponse | null = null;

  protected _resampler = createStreamResampler();

  protected _userAudioPrerollBuffer: Uint8Array = new Uint8Array(0);
  // When set, pins the pre-roll duration; otherwise auto-sized from the
  // upstream VAD's start_secs (see _handleSpeechControlParams).
  protected _userAudioPrerollSecsOverride: number | null;
  protected _userAudioPrerollSecs: number;

  protected _messagesAddedManually = new Map<string, boolean>();
  // Track function calls by call_id
  protected _pendingFunctionCalls = new Map<string, events.ConversationItem>();
  protected _completedToolCalls = new Set<string>();
  // Calls the API is waiting on, by call_id: only these can be answered
  // with a function_call_output. Cleared on disconnect, since a reconnect
  // replays the conversation as text and the API no longer knows the ids.
  protected _openFunctionCalls = new Set<string>();
  // Something was delivered that no response has taken in yet. A response
  // starting clears it; an inference request while it stands creates one.
  protected _resultsAwaitingResponse = false;
  // A response was asked for while one was already running, and is owed
  // once that one is done.
  protected _responseCreateOwed = false;
  protected _responseActive = false;
  // Whether we've already emitted the "stripping `reasoning`" warning for
  // this service instance. The Realtime API doesn't allow swapping the model
  // mid-session, so once is enough.
  protected _reasoningStripWarned = false;

  protected _retrieveConversationItemFutures = new Map<string, Future<events.ConversationItem>[]>();

  /**
   * Initialize the OpenAI Realtime LLM service.
   *
   * @param options.apiKey OpenAI API key for authentication.
   * @param options.baseUrl WebSocket base URL for the realtime API.
   * @param options.settings Runtime-updatable settings for this service.
   * @param options.startAudioPaused Whether to start with audio input paused.
   * @param options.startVideoPaused Whether to start with video input paused.
   * @param options.videoFrameDetail Detail level for video processing.
   * @param options.userAudioPrerollSecs Pre-roll replayed after an
   *   interruption clears the input audio buffer, in manual turn-detection
   *   mode. See `OpenAIRealtimeLLMServiceOptions.userAudioPrerollSecs`.
   *   Other options are passed to the parent LLMService.
   */
  constructor(options: OpenAIRealtimeLLMServiceOptions) {
    const cls = new.target as typeof OpenAIRealtimeLLMService;
    const baseUrl = options.baseUrl ?? "wss://api.openai.com/v1/realtime";

    // 1. Initialize default_settings with hardcoded defaults
    const defaultSettings = new cls.Settings({
      model: "gpt-realtime-2.1",
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
      sessionProperties: new events.SessionProperties({}),
    });

    // Sync top-level model back into session_properties
    cls.Settings._syncTopLevelToSp(defaultSettings);

    // 2. Apply settings delta (canonical API, always wins)
    if (options.settings !== null && options.settings !== undefined) {
      defaultSettings.applyUpdate(options.settings);
    }

    cls._omitUnsupportedInputAudioTranscriptionPrompt(
      assertGiven(defaultSettings.sessionProperties),
    );

    // Build WebSocket URL with model query parameter
    // Source: https://platform.openai.com/docs/guides/realtime-websocket
    const fullUrl = `${baseUrl}?model=${defaultSettings.model}`;
    super({ ...options, settings: defaultSettings });

    this.apiKey = options.apiKey;
    this.baseUrl = fullUrl;
    this._audioInputPaused = options.startAudioPaused ?? false;
    this._videoInputPaused = options.startVideoPaused ?? false;
    this._videoFrameDetail = options.videoFrameDetail ?? "auto";

    const userAudioPrerollSecs = options.userAudioPrerollSecs ?? null;
    this._userAudioPrerollSecsOverride = userAudioPrerollSecs;
    this._userAudioPrerollSecs =
      userAudioPrerollSecs !== null ? userAudioPrerollSecs : DEFAULT_USER_AUDIO_PREROLL_SECS;

    this._registerEventHandler("on_conversation_item_created");
    this._registerEventHandler("on_conversation_item_updated");
  }

  /** Drop input transcription prompt settings unsupported by the selected model. */
  static _omitUnsupportedInputAudioTranscriptionPrompt(
    sessionProperties: events.SessionProperties,
  ): boolean {
    const transcription = sessionProperties.audio?.input?.transcription ?? null;
    if (transcription && transcription.model === OPENAI_REALTIME_WHISPER_MODEL) {
      if (transcription.prompt) {
        transcription.prompt = null;
        logger.warning(
          `${OPENAI_REALTIME_WHISPER_MODEL} does not support the prompt ` +
            "parameter; omitting prompt from OpenAI Realtime input audio " +
            "transcription settings.",
        );
        return true;
      }
    }
    return false;
  }

  /**
   * Check if the service can generate usage metrics.
   *
   * @returns True if metrics generation is supported.
   */
  override canGenerateMetrics(): boolean {
    return true;
  }

  /**
   * Set whether audio input is paused.
   *
   * @param paused True to pause audio input, false to resume.
   */
  setAudioInputPaused(paused: boolean): void {
    this._audioInputPaused = paused;
  }

  /**
   * Set whether video input is paused.
   *
   * @param paused True to pause video input, false to resume.
   */
  setVideoInputPaused(paused: boolean): void {
    this._videoInputPaused = paused;
  }

  /**
   * Set the detail level for video processing.
   *
   * @param detail Detail level - "auto", "low", or "high".
   */
  setVideoFrameDetail(detail: string): void {
    if (!IMAGE_DETAILS.includes(detail)) {
      logger.warning(
        `Invalid video detail '${detail}', must be one of ('${IMAGE_DETAILS.join("', '")}')`,
      );
      return;
    }
    this._videoFrameDetail = detail as events.ImageDetail;
  }

  /** Check if a specific modality is enabled, "text" or "audio". */
  protected _isModalityEnabled(modality: string): boolean {
    const modalities: string[] = pyTruthy(
      assertGiven(this._settings.sessionProperties).outputModalities,
    )
      ? (assertGiven(this._settings.sessionProperties).outputModalities as string[])
      : ["audio", "text"];
    return modalities.includes(modality);
  }

  /** Get the list of enabled modalities. */
  protected _getEnabledModalities(): events.Modality[] {
    const modalities: string[] = pyTruthy(
      assertGiven(this._settings.sessionProperties).outputModalities,
    )
      ? (assertGiven(this._settings.sessionProperties).outputModalities as string[])
      : ["audio", "text"];
    // API only supports single modality responses: either ["text"] or ["audio"]
    if (modalities.includes("audio")) {
      return ["audio"];
    }
    return ["text"];
  }

  /**
   * Retrieve a conversation item by ID from the server.
   *
   * @param itemId The ID of the conversation item to retrieve.
   * @returns The retrieved conversation item.
   */
  async retrieveConversationItem(itemId: string): Promise<events.ConversationItem> {
    const future = new Future<events.ConversationItem>();
    let retrievalInFlight = false;
    const pending = this._retrieveConversationItemFutures.get(itemId);
    if (!pending || pending.length === 0) {
      this._retrieveConversationItemFutures.set(itemId, []);
    } else {
      retrievalInFlight = true;
    }
    this._retrieveConversationItemFutures.get(itemId)!.push(future);
    if (!retrievalInFlight) {
      await this.sendClientEvent(
        // Set event_id to "rci_{item_id}" so that we can identify an
        // error later if the retrieval fails. We don't need a UUID
        // suffix to the event_id because we're ensuring only one
        // in-flight retrieval per item_id. (Note: "rci" = "retrieve
        // conversation item")
        new events.ConversationItemRetrieveEvent({ itemId, eventId: `rci_${itemId}` }),
      );
    }
    return await future;
  }

  //
  // standard AIService frame handling
  //

  /**
   * Set up the service and connect.
   *
   * @param setup Configuration object containing setup parameters.
   */
  override async setup(setup: FrameProcessorSetup): Promise<void> {
    await super.setup(setup);
    await this._connect();
  }

  /** Release realtime LLM resources at teardown. */
  override async cleanup(): Promise<void> {
    await super.cleanup();
    await this._disconnect();
  }

  /**
   * Stop the service and close WebSocket connection.
   *
   * @param frame The end frame triggering service shutdown.
   */
  override async stop(frame: EndFrame): Promise<void> {
    await super.stop(frame);
    await this._disconnect();
  }

  /**
   * Cancel the service and close WebSocket connection.
   *
   * @param frame The cancel frame triggering service cancellation.
   */
  override async cancel(frame: CancelFrame): Promise<void> {
    await super.cancel(frame);
    await this._disconnect();
  }

  //
  // speech and interruption handling
  //

  /**
   * Whether server-side turn detection is explicitly disabled.
   *
   * `null` and `false` are different. `null` means we're using OpenAI's
   * built-in turn detection defaults (so server VAD is active); `false` is
   * the opt-out that puts the service in manual mode.
   */
  protected _isTurnDetectionDisabled(): boolean {
    const sessionProperties = assertGiven(this._settings.sessionProperties);
    return Boolean(
      sessionProperties.audio &&
        sessionProperties.audio.input &&
        sessionProperties.audio.input.turnDetection === false,
    );
  }

  /**
   * Intermediate results reach the model as conversation items.
   *
   * The API takes one output per function call, so an intermediate result
   * goes in beside the call instead of through it (see `pushFrame`).
   */
  override get acceptsIntermediateFunctionCallResults(): boolean {
    return true;
  }

  /** Realtime service; recommends external turn strategies when server-side VAD is active. */
  override serviceMetadataFrame(): LLMServiceMetadataFrame {
    // When turn_detection is disabled the server doesn't emit VAD events,
    // so there are no UserStarted/StoppedSpeakingFrame to drive external strategies.
    const emitsTurnFrames = !this._isTurnDetectionDisabled();
    this._warnIfRealtimeServiceEmitsNoTurnFrames(emitsTurnFrames);
    return new LLMServiceMetadataFrame({
      serviceName: this.name,
      isRealtimeService: true,
      userTurnStrategies: emitsTurnFrames ? new ExternalUserTurnStrategies() : null,
    });
  }

  protected async _handleInterruption(): Promise<void> {
    if (this._isTurnDetectionDisabled()) {
      await this.sendClientEvent(new events.InputAudioBufferClearEvent({}));
      // The clear wipes the speech onset appended before local turn
      // detection fired this interruption; replay it so it isn't lost.
      await this._replayUserAudioPreroll();
      await this.sendClientEvent(new events.ResponseCancelEvent({}));
    }
    await this._truncateCurrentAudioResponse();
    await this.stopAllMetrics();
    // Whatever the interrupted response was going to say is moot, and so is
    // a response owed behind it: the user's turn makes one of its own.
    this._responseCreateOwed = false;
    if (this._currentAssistantResponse) {
      await this.pushFrame(new LLMFullResponseEndFrame());
      // Only push TTSStoppedFrame if audio modality is enabled
      if (this._isModalityEnabled("audio")) {
        await this.pushFrame(new TTSStoppedFrame());
      }
    }
  }

  protected async _handleUserStartedSpeaking(_frame: UserStartedSpeakingFrame): Promise<void> {}

  protected async _handleUserStoppedSpeaking(_frame: UserStoppedSpeakingFrame): Promise<void> {
    if (this._isTurnDetectionDisabled()) {
      await this.sendClientEvent(new events.InputAudioBufferCommitEvent({}));
      await this.sendClientEvent(new events.ResponseCreateEvent({}));
    }
  }

  protected async _handleBotStoppedSpeaking(): Promise<void> {
    this._currentAudioResponse = null;
  }

  /** Calculate audio duration in milliseconds based on PCM audio parameters. */
  protected _calculateAudioDurationMs(
    totalBytes: number,
    sampleRate: number = OPENAI_SAMPLE_RATE,
    bytesPerSample = 2,
  ): number {
    const samples = totalBytes / bytesPerSample;
    const durationSeconds = samples / sampleRate;
    return Math.trunc(durationSeconds * 1000);
  }

  /**
   * Truncates the current audio response at the appropriate duration.
   *
   * Calculates the actual duration of the audio content and truncates at the
   * shorter of either the wall clock time or the actual audio duration to
   * prevent invalid truncation requests.
   */
  protected async _truncateCurrentAudioResponse(): Promise<void> {
    if (!this._currentAudioResponse) {
      return;
    }

    // if the bot is still speaking, truncate the last message
    try {
      const current = this._currentAudioResponse;
      this._currentAudioResponse = null;

      // Calculate actual audio duration instead of using wall clock time
      const audioDurationMs = this._calculateAudioDurationMs(current.totalSize);

      // Use the shorter of wall clock time or actual audio duration
      const elapsedMs = Math.trunc(time() * 1000 - current.startTimeMs);
      const truncateMs = Math.min(elapsedMs, audioDurationMs);

      logger.trace(
        `Truncating audio: duration=${audioDurationMs}ms, ` +
          `elapsed=${elapsedMs}ms, truncate=${truncateMs}ms`,
      );

      await this.sendClientEvent(
        new events.ConversationItemTruncateEvent({
          itemId: current.itemId,
          contentIndex: current.contentIndex,
          audioEndMs: truncateMs,
        }),
      );
    } catch (e) {
      rethrowIfCancelled(e);
      // Log warning and don't re-raise - allow session to continue
      logger.warning(`Audio truncation failed (non-fatal): ${errorMessage(e)}`);
    }
  }

  //
  // frame processing
  //
  // StartFrame, StopFrame, CancelFrame implemented in base class
  //

  /** Return the tools configured on `sessionProperties`, if any. */
  protected override _serviceTools(): ToolsSchema | unknown[] | null {
    return (assertGiven(this._settings.sessionProperties).tools ?? null) as
      | ToolsSchema
      | unknown[]
      | null;
  }

  /**
   * Process incoming frames from the pipeline.
   *
   * @param frame The frame to process.
   * @param direction The direction of frame flow in the pipeline.
   */
  override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
    await super.processFrame(frame, direction);

    if (frame instanceof TranscriptionFrame) {
      // pass
    } else if (frame instanceof LLMContextFrame) {
      await this._handleContext(frame.context, direction);
    } else if (frame instanceof InputAudioRawFrame) {
      if (!this._audioInputPaused) {
        await this._sendUserAudio(frame);
      }
    } else if (frame instanceof InputImageRawFrame) {
      if (!this._videoInputPaused) {
        await this._sendUserVideo(frame);
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

  /**
   * Push a frame, delivering function call outcomes to the API on the way.
   *
   * Function call results and cancellations are broadcast by the base
   * service; the downstream copy is observed here and sent to the API as it
   * is produced, intermediate results included. The frames travel on to the
   * assistant aggregator, which records them in the context and decides when
   * inference should run.
   *
   * @param frame The frame to push.
   * @param direction The direction of frame pushing.
   */
  override async pushFrame(
    frame: Frame,
    direction: FrameDirection = FrameDirection.DOWNSTREAM,
  ): Promise<void> {
    if (direction === FrameDirection.DOWNSTREAM) {
      if (frame instanceof FunctionCallResultFrame) {
        await this._handleFunctionCallResult(frame);
      } else if (frame instanceof FunctionCallCancelFrame) {
        await this._handleFunctionCallCancel(frame);
      }
    }
    await super.pushFrame(frame, direction);
  }

  protected async _handleContext(context: LLMContext, direction: FrameDirection): Promise<void> {
    if (!this._context) {
      // We got our initial context
      this._context = context;
      // Initialize our bookkeeping of already-completed tool calls in
      // the context
      await this._processCompletedFunctionCalls(false);
      // Run the LLM at next opportunity
      await this._createResponse();
    } else {
      // We got an updated context.
      // This may contain a new user message or tool call result.
      this._context = context;
      // Send results for newly-completed function calls, if any (results
      // this service pushed are already sent; this catches any written
      // into the context some other way).
      await this._processCompletedFunctionCalls(true);
      // A context frame travelling upstream comes from the assistant
      // aggregator, which is asking the model to respond to what was
      // delivered since its last response.
      if (direction === FrameDirection.UPSTREAM && this._resultsAwaitingResponse) {
        await this._createResponse();
      }
    }
  }

  /**
   * Put appended messages into the conversation as items, for the model to
   * take in.
   *
   * Whether the model answers them is the aggregator's call: an append that
   * asks to run comes back to this service as the context frame the assistant
   * aggregator pushes upstream, which creates the response (see
   * `_handleContext`). Before the session's conversation is set up, nothing
   * is sent: the setup sends the context, which the aggregator records the
   * messages in.
   */
  protected async _handleMessagesAppend(frame: LLMMessagesAppendFrame): Promise<void> {
    if (!this._apiSessionReady || this._llmNeedsConversationSetup) {
      return;
    }
    for (const message of frame.messages) {
      const text = standardMessageText(message);
      if (!text) {
        continue;
      }
      const role =
        message instanceof LLMSpecificMessage
          ? null
          : (message as unknown as Record<string, unknown>).role;
      await this._sendMessageItem(text, role === "assistant" ? "assistant" : "system");
    }
    this._resultsAwaitingResponse = true;
  }

  //
  // websocket communication
  //

  /**
   * Send a client event to the OpenAI Realtime API.
   *
   * @param event The client event to send.
   */
  async sendClientEvent(event: events.ClientEvent): Promise<void> {
    await this._wsSend(event.modelDump({ excludeNone: true }));
  }

  /** Return the headers that authenticate the WebSocket connection. */
  protected async _authHeaders(): Promise<Record<string, string>> {
    return { Authorization: `Bearer ${this.apiKey}` };
  }

  protected async _connect(): Promise<void> {
    try {
      if (this._websocket) {
        // Here we assume that if we have a websocket, we are connected. We
        // handle disconnections in the send/recv code paths.
        return;
      }
      this._websocket = await websocketConnect(this.baseUrl, {
        additionalHeaders: await this._authHeaders(),
      });
      this._receiveTask = this.createTask(
        () => this._receiveTaskHandler(),
        "_receive_task_handler",
      );
    } catch (e) {
      rethrowIfCancelled(e);
      await this.pushError(`Error connecting: ${errorMessage(e)}`, { exception: e });
      this._websocket = null;
    }
  }

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
      // A new session knows none of the old call ids, and no response is
      // running in it.
      this._openFunctionCalls = new Set();
      this._responseActive = false;
      this._responseCreateOwed = false;
      this._disconnecting = false;
    } catch (e) {
      rethrowIfCancelled(e);
      await this.pushError(`Error disconnecting: ${errorMessage(e)}`, { exception: e });
    }
  }

  protected async _wsSend(realtimeMessage: Record<string, unknown>): Promise<void> {
    try {
      if (!this._disconnecting && this._websocket) {
        await this._websocket.send(pyJsonDumps(realtimeMessage));
      }
    } catch (e) {
      rethrowIfCancelled(e);
      if (this._disconnecting || !this._websocket) {
        // We're in the process of disconnecting.
        // (If not this._websocket, that could indicate that we
        // somehow *started* the websocket send attempt while we still
        // had a connection)
        return;
      }
      // In server-to-server contexts, a WebSocket error should be quite rare.
      // Given how hard it is to recover from a send-side error with proper
      // state management, and that exponential backoff for retries can have
      // cost/stability implications for a service cluster, let's just treat
      // a send-side error as fatal.
      await this.pushError(`Error sending client event: ${errorMessage(e)}`, { exception: e });
    }
  }

  /** Apply a settings delta, sending a session update when needed. */
  protected override async _updateSettings(delta: LLMSettings): Promise<Record<string, unknown>> {
    const changed = await super._updateSettings(delta);
    const promptOmitted = (
      this.constructor as typeof OpenAIRealtimeLLMService
    )._omitUnsupportedInputAudioTranscriptionPrompt(assertGiven(this._settings.sessionProperties));
    const handled = new Set(["sessionProperties", "systemInstruction"]);
    const changedKeys = Object.keys(changed);
    const handledSettingsChanged = changedKeys.some((key) => handled.has(key));
    if (handledSettingsChanged || promptOmitted) {
      await this._sendSessionUpdate();
    }
    this._warnUnhandledUpdatedSettings(changedKeys.filter((key) => !handled.has(key)));
    return changed;
  }

  /**
   * Drop `reasoning` from an outgoing session.update if the model can't use it.
   *
   * The server otherwise rejects the whole update and kills the session.
   * Returns a copy when stripping; the user's stored config is preserved.
   */
  protected _stripUnsupportedReasoning(
    settings: events.SessionProperties,
  ): events.SessionProperties {
    if (settings.reasoning === null || settings.reasoning === undefined || !settings.model) {
      return settings;
    }
    const model = settings.model;
    const substrings = (this.constructor as typeof OpenAIRealtimeLLMService)
      ._REASONING_CAPABLE_MODEL_SUBSTRINGS;
    if (substrings.some((s) => model.includes(s))) {
      return settings;
    }
    if (!this._reasoningStripWarned) {
      logger.warning(
        `${this} stripping \`reasoning\` from session.update: model=${pyRepr(model)} ` +
          "isn't a known reasoning-capable Realtime model.",
      );
      this._reasoningStripWarned = true;
    }
    return settings.modelCopy({ update: { reasoning: null } });
  }

  protected async _sendSessionUpdate(): Promise<void> {
    // Mutate a copy: the stored session_properties is read elsewhere (e.g.
    // _serviceTools) and must stay intact.
    const settings = assertGiven(this._settings.sessionProperties).modelCopy();
    const adapter = this.getLlmAdapter();

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
      settings.tools = llmInvocationParams.tools as any;
    } else {
      // No context yet: the init-provided tools; built-in tools ride along.
      settings.tools = adapter.fromStandardTools(settings.tools) as any;
    }

    const outgoing = this._stripUnsupportedReasoning(settings);

    await this.sendClientEvent(new events.SessionUpdateEvent({ session: outgoing }));
  }

  //
  // inbound server event handling
  // https://platform.openai.com/docs/api-reference/realtime-server-events
  //

  protected async _receiveTaskHandler(): Promise<void> {
    if (this._websocket === null) {
      throw new Error("AssertionError: _websocket is None");
    }

    for await (const message of this._websocket) {
      const evt: any = events.parseServerEvent(
        typeof message === "string" ? message : new TextDecoder().decode(message),
      );
      if (evt === null) {
        continue;
      }
      if (evt.type === "session.created") {
        await this._handleEvtSessionCreated(evt);
      } else if (evt.type === "session.updated") {
        await this._handleEvtSessionUpdated(evt);
      } else if (evt.type === "response.created") {
        await this._handleEvtResponseCreated(evt);
      } else if (evt.type === "response.output_audio.delta") {
        await this._handleEvtAudioDelta(evt);
      } else if (evt.type === "conversation.item.added") {
        await this._handleEvtConversationItemAdded(evt);
      } else if (evt.type === "conversation.item.done") {
        await this._handleEvtConversationItemDone(evt);
      } else if (evt.type === "conversation.item.input_audio_transcription.delta") {
        await this._handleEvtInputAudioTranscriptionDelta(evt);
      } else if (evt.type === "conversation.item.input_audio_transcription.completed") {
        await this.handleEvtInputAudioTranscriptionCompleted(evt);
      } else if (evt.type === "conversation.item.retrieved") {
        await this._handleConversationItemRetrieved(evt);
      } else if (evt.type === "response.done") {
        await this._handleEvtResponseDone(evt);
      } else if (evt.type === "input_audio_buffer.speech_started") {
        await this._handleEvtSpeechStarted(evt);
      } else if (evt.type === "input_audio_buffer.speech_stopped") {
        await this._handleEvtSpeechStopped(evt);
      } else if (evt.type === "response.output_text.delta") {
        await this._handleEvtTextDelta(evt);
      } else if (evt.type === "response.output_audio_transcript.delta") {
        await this._handleEvtAudioTranscriptDelta(evt);
      } else if (evt.type === "response.function_call_arguments.done") {
        await this._handleEvtFunctionCallArgumentsDone(evt);
      } else if (evt.type === "error") {
        if (!(await this._maybeHandleEvtRetrieveConversationItemError(evt))) {
          if (
            evt.error.code === "response_cancel_not_active" ||
            evt.error.code === "conversation_already_has_active_response"
          ) {
            logger.debug(`${this} ${evt.error.message}`);
          } else {
            await this._handleEvtError(evt);
            // errors are fatal, so exit the receive loop
            return;
          }
        }
      }
    }
  }

  // Traced with tracedOpenaiRealtime("llm_setup") (see the static block).
  protected async _handleEvtSessionCreated(_evt: events.SessionCreatedEvent): Promise<void> {
    // session.created is received right after connecting. Send a message
    // to configure the session properties.
    await this._sendSessionUpdate();
  }

  protected async _handleEvtSessionUpdated(_evt: events.SessionUpdatedEvent): Promise<void> {
    // If this is our first context frame, run the LLM
    this._apiSessionReady = true;
    // Now that we've configured the session, we can run the LLM if we need to.
    if (this._runLlmWhenApiSessionReady) {
      this._runLlmWhenApiSessionReady = false;
      await this._createResponse();
    }
  }

  protected async _handleEvtAudioDelta(evt: events.ResponseAudioDelta): Promise<void> {
    // note: ttfb is faster by 1/2 RTT than ttfb as measured for other
    // services, since we're getting this event from the server
    await this.stopTtfbMetrics();

    if (!this._currentAudioResponse) {
      // First delta of a new assistant turn.
      this._currentAudioResponse = new CurrentAudioResponse({
        itemId: evt.itemId,
        contentIndex: evt.contentIndex,
        startTimeMs: Math.trunc(time() * 1000),
        responseId: evt.responseId,
      });
      await this.pushFrame(new TTSStartedFrame());
    } else if (this._currentAudioResponse.itemId !== evt.itemId) {
      // A response can contain multiple output items (observed with
      // gpt-realtime-2 on long replies). Deltas arrive in playback order
      // across items, so we treat them as one continuous TTS turn:
      // advance the tracked item in place without emitting another
      // TTSStartedFrame. Reset totalSize so truncation math reflects the
      // current item only (last-item-wins, matching openai-agents-python).
      logger.debug(
        `${this} advancing to next audio output item ` +
          `(prev item_id=${this._currentAudioResponse.itemId} -> ` +
          `new item_id=${evt.itemId} response_id=${evt.responseId} ` +
          `output_index=${evt.outputIndex} content_index=${evt.contentIndex})`,
      );
      this._currentAudioResponse.itemId = evt.itemId;
      this._currentAudioResponse.contentIndex = evt.contentIndex;
      this._currentAudioResponse.responseId = evt.responseId;
      this._currentAudioResponse.startTimeMs = Math.trunc(time() * 1000);
      this._currentAudioResponse.totalSize = 0;
    }

    const audio = base64ToBytes(evt.delta);
    this._currentAudioResponse.totalSize += audio.length;
    const frame = new TTSAudioRawFrame({
      audio,
      sampleRate: OPENAI_SAMPLE_RATE,
      numChannels: 1,
    });
    await this.pushFrame(frame);
  }

  /** Handle conversation.item.added event - item is added but may still be processing. */
  protected async _handleEvtConversationItemAdded(
    evt: events.ConversationItemAdded,
  ): Promise<void> {
    if (evt.item.type === "function_call") {
      // Track this function call for when arguments are completed
      // Only add if not already tracked (prevent duplicates)
      const callId = evt.item.callId as string;
      if (!this._pendingFunctionCalls.has(callId)) {
        this._pendingFunctionCalls.set(callId, evt.item);
      } else {
        logger.warning(`Function call ${callId} already tracked, skipping`);
      }
    }

    await this._callEventHandler("on_conversation_item_created", evt.item.id, evt.item);

    // This will get sent from the server every time a new "message" is added
    // to the server's conversation state, whether we create it via the API
    // or the server creates it from LLM output.
    if (this._messagesAddedManually.get(evt.item.id)) {
      this._messagesAddedManually.delete(evt.item.id);
      return;
    }

    if (evt.item.role === "assistant") {
      this._currentAssistantResponse = evt.item;
      await this.pushFrame(new LLMFullResponseStartFrame());
    }
  }

  /** Handle conversation.item.done event - item is fully completed. */
  protected async _handleEvtConversationItemDone(evt: events.ConversationItemDone): Promise<void> {
    await this._callEventHandler("on_conversation_item_updated", evt.item.id, evt.item);
    // The item is now fully processed and ready
    // For now, no additional logic needed beyond the event handler call
  }

  protected async _handleEvtInputAudioTranscriptionDelta(
    evt: events.ConversationItemInputAudioTranscriptionDelta,
  ): Promise<void> {
    await this.pushFrame(
      // no way to get a language code?
      new InterimTranscriptionFrame({
        text: evt.delta,
        userId: "",
        timestamp: timeNowIso8601(),
        result: evt,
      }),
      FrameDirection.UPSTREAM,
    );
  }

  /** Handle a transcription result with tracing. */
  protected async _handleUserTranscription(
    _transcript: string,
    _isFinal: boolean,
    _language: Language | null = null,
  ): Promise<void> {}

  /**
   * Handle completion of input audio transcription.
   *
   * @param evt The transcription completed event.
   */
  async handleEvtInputAudioTranscriptionCompleted(
    evt: events.ConversationItemInputAudioTranscriptionCompleted,
  ): Promise<void> {
    await this._callEventHandler("on_conversation_item_updated", evt.itemId, null);

    await this.pushFrame(
      // no way to get a language code?
      new TranscriptionFrame({
        text: evt.transcript,
        userId: "",
        timestamp: timeNowIso8601(),
        result: evt,
      }),
      FrameDirection.UPSTREAM,
    );
    await this._handleUserTranscription(evt.transcript, true, Language.EN);
  }

  protected async _handleConversationItemRetrieved(
    evt: events.ConversationItemRetrieved,
  ): Promise<void> {
    const futures = this._retrieveConversationItemFutures.get(evt.item.id);
    this._retrieveConversationItemFutures.delete(evt.item.id);
    if (futures && futures.length > 0) {
      for (const future of futures) {
        future.setResult(evt.item);
      }
    }
  }

  /** Note the response, which takes in everything delivered before it. */
  protected async _handleEvtResponseCreated(_evt: events.ResponseCreated): Promise<void> {
    this._responseActive = true;
    this._resultsAwaitingResponse = false;
  }

  // Traced with tracedOpenaiRealtime("llm_response") (see the static block).
  protected async _handleEvtResponseDone(evt: events.ResponseDone): Promise<void> {
    // todo: figure out whether there's anything we need to do for "cancelled" events
    // usage metrics
    const usage = evt.response.usage;
    if (usage !== null) {
      const inputDetails = usage.inputTokenDetails as any;
      const outputDetails = usage.outputTokenDetails as any;
      const cachedDetails = inputDetails ? (inputDetails.cachedTokensDetails ?? null) : null;
      const cachedAudioTokens = cachedDetails ? cachedDetails.audioTokens : null;
      const tokens = new LLMTokenUsage({
        promptTokens: usage.inputTokens || 0,
        completionTokens: usage.outputTokens || 0,
        totalTokens: usage.totalTokens || 0,
        cacheReadInputTokens: inputDetails ? inputDetails.cachedTokens : null,
        inputAudioTokens: inputDetails ? inputDetails.audioTokens : null,
        outputAudioTokens: outputDetails ? outputDetails.audioTokens : null,
        cacheReadInputAudioTokens: cachedAudioTokens,
      });
      await this.startLlmUsageMetrics(tokens);
    }
    await this.stopProcessingMetrics();
    // Push TTSStoppedFrame here (rather than on each per-item
    // response.output_audio.done) so that a response containing multiple
    // output items still emits exactly one bracketing TTSStartedFrame /
    // TTSStoppedFrame pair around the audio. In practice gpt-realtime-2's
    // audio.done events arrive batched within a few milliseconds of
    // response.done, so this is effectively coincident with end-of-audio.
    // The strictly-sequential variant (audio.done A before item B begins)
    // is theoretical — we haven't observed it — but this placement handles
    // it too: per-item gating would otherwise emit Stopped/Started/Stopped.
    if (this._currentAudioResponse !== null) {
      await this.pushFrame(new TTSStoppedFrame());
    }
    await this.pushFrame(new LLMFullResponseEndFrame());
    this._currentAssistantResponse = null;
    this._responseActive = false;
    // A response asked for while this one was running is owed now, unless
    // this one took in what it was for.
    if (this._responseCreateOwed) {
      this._responseCreateOwed = false;
      if (this._resultsAwaitingResponse) {
        await this._createResponse();
      }
    }
    // error handling
    if (evt.response.status === "failed") {
      const error = (evt.response.statusDetails || {}).error || {};
      await this.pushError(error.message || "Response failed");
      return;
    }
    // response content
    for (const item of evt.response.output ?? []) {
      await this._callEventHandler("on_conversation_item_updated", item.id, item);
    }
  }

  protected async _handleEvtTextDelta(evt: events.ResponseTextDelta): Promise<void> {
    // We receive text deltas (as opposed to audio transcript deltas) when
    // the output modality is "text"
    if (evt.delta) {
      const frame = new LLMTextFrame({ text: evt.delta });
      await this.pushFrame(frame);
    }
  }

  protected async _handleEvtAudioTranscriptDelta(
    evt: events.ResponseAudioTranscriptDelta,
  ): Promise<void> {
    // We receive audio transcript deltas (as opposed to text deltas) when
    // the output modality is "audio" (the default)
    if (evt.delta) {
      await this._pushOutputTranscriptTextFrames(evt.delta);
    }
  }

  protected async _pushOutputTranscriptTextFrames(text: string): Promise<void> {
    // In a typical "cascade" LLM + TTS setup, LLMTextFrames would not
    // proceed beyond the TTS service. Therefore, since a speech-to-speech
    // service like OpenAI Realtime combines both LLM and TTS functionality,
    // you might think we wouldn't need to push LLMTextFrames at all.
    // However, RTVI relies on LLMTextFrames being pushed to trigger its
    // "bot-llm-text" event. So here we push an LLMTextFrame, too, but avoid
    // appending it to context to avoid context message duplication.

    // Push LLMTextFrame
    const llmTextFrame = new LLMTextFrame({ text });
    llmTextFrame.appendToContext = false;
    await this.pushFrame(llmTextFrame);

    // Push TTSTextFrame
    const ttsTextFrame = new TTSTextFrame({ text, textType: TextType.SENTENCE });
    ttsTextFrame.includesInterFrameSpaces = true;
    await this.pushFrame(ttsTextFrame);
  }

  /**
   * Handle completion of function call arguments.
   *
   * @param evt The response.function_call_arguments.done event.
   */
  protected async _handleEvtFunctionCallArgumentsDone(
    evt: events.ResponseFunctionCallArgumentsDone,
  ): Promise<void> {
    // Process the function call immediately when arguments are complete
    // This is needed because function calls might not trigger response.done
    try {
      // Parse the arguments
      const args = pyJsonLoads(evt.arguments) as Record<string, unknown>;

      // Get the function call item we tracked earlier
      const functionCallItem = this._pendingFunctionCalls.get(evt.callId);
      if (functionCallItem) {
        // Remove from pending calls FIRST to prevent duplicate processing
        this._pendingFunctionCalls.delete(evt.callId);

        // The API is waiting on this call now, so its id can be answered
        // with a function_call_output.
        this._openFunctionCalls.add(evt.callId);

        // Create the function call and process it
        const functionCalls = [
          new FunctionCallFromLLM({
            context: this._context,
            toolCallId: evt.callId,
            functionName: functionCallItem.name as string,
            arguments: args,
          }),
        ];

        await this.runFunctionCalls(functionCalls);
        logger.debug(`Processed function call: ${functionCallItem.name}`);
      } else {
        logger.warning(`No tracked function call found for call_id: ${evt.callId}`);
        logger.warning(
          `Available pending calls: [${[...this._pendingFunctionCalls.keys()]
            .map((k) => pyRepr(k))
            .join(", ")}]`,
        );
      }
    } catch (e) {
      rethrowIfCancelled(e);
      logger.error(`Failed to process function call arguments: ${errorMessage(e)}`);
    }
  }

  protected async _handleEvtSpeechStarted(
    _evt: events.InputAudioBufferSpeechStarted,
  ): Promise<void> {
    // Note: this event is not received when turn detection is disabled,
    // which is good: in that case, local turn detection is responsible for
    // this work.
    this._responseCreateOwed = false;
    await this._truncateCurrentAudioResponse();
    await this.broadcastFrame(ProposedUserStartedSpeakingFrame);
  }

  protected async _handleEvtSpeechStopped(
    _evt: events.InputAudioBufferSpeechStopped,
  ): Promise<void> {
    // Note: this event is not received when turn detection is disabled,
    // which is good: in that case, local turn detection is responsible for
    // this work.
    await this.startTtfbMetrics();
    await this.startProcessingMetrics();
    await this.broadcastFrame(ProposedUserStoppedSpeakingFrame);
  }

  /**
   * Maybe handle an error event related to retrieving a conversation item.
   *
   * If the given error event is an error retrieving a conversation item:
   *
   * - set an exception on the future that `retrieveConversationItem()` is
   *   waiting on
   * - return true
   *
   * Otherwise:
   *
   * - return false
   */
  protected async _maybeHandleEvtRetrieveConversationItemError(
    evt: events.ErrorEvent,
  ): Promise<boolean> {
    if (evt.error.code === "item_retrieve_invalid_item_id") {
      const eventId = evt.error.eventId;
      if (eventId === null || eventId === undefined) {
        throw new Error("AssertionError: error.event_id is None");
      }
      // event_id is of the form "rci_{item_id}"
      const sep = eventId.indexOf("_");
      if (sep === -1) {
        // Python's `split("_", 1)[1]` on an id without "_".
        throw new Error("IndexError: list index out of range");
      }
      const itemId = eventId.slice(sep + 1);
      const futures = this._retrieveConversationItemFutures.get(itemId);
      this._retrieveConversationItemFutures.delete(itemId);
      if (futures && futures.length > 0) {
        for (const future of futures) {
          future.setException(new Error(evt.error.message));
        }
      }
      return true;
    }
    return false;
  }

  protected async _handleEvtError(evt: events.ErrorEvent): Promise<void> {
    // Errors are fatal to this connection. Send an ErrorFrame.
    await this.pushError(`Error: ${evt}`);
  }

  //
  // state and client events for the current conversation
  // https://platform.openai.com/docs/api-reference/realtime-client-events
  //

  /**
   * Reset the conversation by disconnecting and reconnecting.
   *
   * This is the safest way to start a new conversation. Note that this will
   * fail if called from the receive task.
   */
  async resetConversation(): Promise<void> {
    logger.debug("Resetting conversation");
    await this._disconnect();

    // Prepare to setup server-side conversation from local context again
    this._llmNeedsConversationSetup = true;
    await this._processCompletedFunctionCalls(false);

    await this._connect();
  }

  // Traced with tracedOpenaiRealtime("llm_request") (see the static block).
  protected async _createResponse(): Promise<void> {
    if (!this._apiSessionReady) {
      this._runLlmWhenApiSessionReady = true;
      return;
    }

    if (this._responseActive) {
      // The API refuses a second response while one is running. Hold this
      // one for response.done rather than losing it to that error.
      logger.debug("Response already active — holding the next one until it is done");
      this._responseCreateOwed = true;
      return;
    }

    if (this._context === null) {
      throw new Error("AssertionError: _context is None");
    }
    const context = this._context;

    const adapter = this.getLlmAdapter();

    // Configure the LLM for this session if needed
    if (this._llmNeedsConversationSetup) {
      this._logLlmConversationSetup(context);

      // Send initial messages
      const llmInvocationParams = await adapter.getLlmInvocationParams(context);
      const messages = llmInvocationParams.messages;
      for (const item of messages) {
        const evt = new events.ConversationItemCreateEvent({ item });
        this._messagesAddedManually.set(evt.item.id, true);
        await this.sendClientEvent(evt);
      }

      // Send new settings if needed
      await this._sendSessionUpdate();

      // We're done configuring the LLM for this session
      this._llmNeedsConversationSetup = false;
    }

    logger.debug("Creating response");
    // Active from the moment the create is sent, not from response.created: a
    // second create in between would be refused by the API.
    this._responseActive = true;

    await this.pushFrame(new LLMFullResponseStartFrame());
    await this.startProcessingMetrics();
    await this.startTtfbMetrics();
    await this.sendClientEvent(
      new events.ResponseCreateEvent({
        response: new events.ResponseProperties({
          outputModalities: this._getEnabledModalities(),
        }),
      }),
    );
  }

  /**
   * Send any tool result the context holds that hasn't reached the API yet.
   *
   * Results this service produced are already sent, as they are produced (see
   * `pushFrame`), so what this finds is a result written into the context
   * some other way, plus, with `sendNewResults` false, the results a context
   * brings with it at the start of a session.
   */
  protected async _processCompletedFunctionCalls(sendNewResults: boolean): Promise<void> {
    if (this._context === null) {
      throw new Error("AssertionError: _context is None");
    }

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
          // Sent as a message when it was produced; the call stays
          // open for the final result.
          continue;
        }
        if (asyncPayload.kind === "final") {
          // Deliver via the formal tool-result channel — same path
          // as a synchronous tool result, just delayed.
          if (sendNewResults) {
            this._resultsAwaitingResponse = true;
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
      const msg = message as unknown as Record<string, unknown>;
      if (pyTruthy(msg.role) && msg.content !== "IN_PROGRESS") {
        const toolCallId = msg.tool_call_id as string | undefined;
        if (toolCallId && !this._completedToolCalls.has(toolCallId)) {
          // Found a newly-completed function call - send the result to the service
          if (sendNewResults) {
            this._resultsAwaitingResponse = true;
            await this._sendToolResult(toolCallId, (msg.content as string | undefined) ?? null);
          }
          this._completedToolCalls.add(toolCallId);
        }
      }
    }
  }

  /**
   * Auto-size the pre-roll from the upstream VAD's startSecs.
   *
   * `VADController` broadcasts the current `VADParams` at pipeline start (and
   * on any runtime change), so the pre-roll tracks `startSecs` — the leading
   * speech local turn detection consumes before confirming the turn — plus a
   * margin.
   *
   * This assumes VAD drives turn starts (the default
   * `VADUserTurnStartStrategy`). With a non-VAD turn-start strategy the
   * onset-to-turn-start gap isn't governed by `startSecs`; in that case the
   * developer should pin a pre-roll duration via `userAudioPrerollSecs`
   * (which short-circuits this).
   *
   * This mechanism is harmless when server-side turn detection is enabled
   * (the buffer is simply unused).
   */
  protected _handleSpeechControlParams(frame: SpeechControlParamsFrame): void {
    if (this._userAudioPrerollSecsOverride !== null) {
      return;
    }
    if (frame.vadParams !== null) {
      this._userAudioPrerollSecs =
        frame.vadParams.startSecs + AUTOSIZED_USER_AUDIO_PREROLL_MARGIN_SECS;
    }
  }

  protected async _sendUserAudio(frame: InputAudioRawFrame): Promise<void> {
    // The session's input format is PCM at a fixed 24 kHz.
    let audio = frame.audio;
    if (frame.sampleRate !== OPENAI_SAMPLE_RATE) {
      audio = await this._resampler.resample(audio, frame.sampleRate, OPENAI_SAMPLE_RATE);
    }
    if (audio.length === 0) {
      return;
    }
    const payload = bytesToBase64(audio);
    await this.sendClientEvent(new events.InputAudioBufferAppendEvent({ audio: payload }));

    // In manual turn-detection mode, keep a rolling pre-roll buffer of the
    // most recent audio so _handleInterruption can replay the speech onset
    // after clearing the input buffer. (Server-side turn detection never
    // clears it, so no buffer is needed.)
    if (this._isTurnDetectionDisabled()) {
      const buffer = new Uint8Array(this._userAudioPrerollBuffer.length + audio.length);
      buffer.set(this._userAudioPrerollBuffer, 0);
      buffer.set(audio, this._userAudioPrerollBuffer.length);
      const prerollLen = Math.trunc(
        OPENAI_SAMPLE_RATE * frame.numChannels * 2 * this._userAudioPrerollSecs,
      );
      // Python's `buffer[-0:]` keeps the whole buffer.
      this._userAudioPrerollBuffer =
        prerollLen > 0 && prerollLen < buffer.length
          ? buffer.slice(buffer.length - prerollLen)
          : buffer;
    }
  }

  /**
   * Re-append the buffered pre-roll audio to the input buffer.
   *
   * Called right after `InputAudioBufferClearEvent` so the speech onset
   * (appended before local turn detection fired the interruption) survives
   * the clear. The buffer is left intact — it's a rolling window, so a later
   * interruption can restore the onset again.
   */
  protected async _replayUserAudioPreroll(): Promise<void> {
    if (this._userAudioPrerollBuffer.length === 0) {
      return;
    }
    const payload = bytesToBase64(this._userAudioPrerollBuffer);
    await this.sendClientEvent(new events.InputAudioBufferAppendEvent({ audio: payload }));
  }

  /**
   * Send user video frame to OpenAI Realtime API.
   *
   * @param frame The InputImageRawFrame to send.
   */
  protected async _sendUserVideo(frame: InputImageRawFrame): Promise<void> {
    if (this._videoInputPaused || this._disconnecting || !this._websocket) {
      return;
    }

    const now = time();
    if (now - this._lastSentTime < 1) {
      return; // Ignore if less than 1 second has passed
    }

    this._lastSentTime = now; // Update last sent time
    logger.trace(`Sending video frame to OpenAI Realtime: ${frame}`);

    // Convert video frame to JPEG format and encode as base64
    if (frame.format === null) {
      throw new Error("AssertionError: frame.format is None");
    }
    const [encoded, mimeType] = await encodeImage(frame.image, frame.size, frame.format);
    const data = bytesToBase64(encoded);

    // Create data URI for the video frame
    const dataUri = `data:${mimeType};base64,${data}`;

    // Create a conversation item with the video frame
    const item = new events.ConversationItem({
      type: "message",
      role: "user",
      content: [
        new events.ItemContent({
          type: "input_image",
          imageUrl: dataUri,
          detail: this._videoFrameDetail,
        }),
      ],
    });

    // Send the conversation item
    try {
      await this.sendClientEvent(new events.ConversationItemCreateEvent({ item }));
    } catch (e) {
      rethrowIfCancelled(e);
      await this.pushError(`Send error: ${errorMessage(e)}`);
    }
  }

  protected async _sendToolResult(toolCallId: string, result: string | null): Promise<void> {
    logger.debug(`Sending tool result to OpenAI Realtime for tool_call_id=${toolCallId}`);
    this._openFunctionCalls.delete(toolCallId);
    const item = new events.ConversationItem({
      type: "function_call_output",
      callId: toolCallId,
      output: result,
    });
    await this.sendClientEvent(new events.ConversationItemCreateEvent({ item }));
  }

  /** Put text into the conversation for the model to take in, without answering it. */
  protected async _sendMessageItem(text: string, role = "system"): Promise<void> {
    const item = new events.ConversationItem({
      type: "message",
      role: role as "user" | "assistant" | "system",
      content: [new events.ItemContent({ type: "input_text", text })],
    });
    await this.sendClientEvent(new events.ConversationItemCreateEvent({ item }));
  }

  /**
   * Send one function call result to the API as it is produced.
   *
   * An intermediate result can't go through the tool-result channel — the
   * API takes one output per call — so it goes in as a message carrying the
   * same envelope a text LLM would read from the context. A final result
   * answers the call, unless a reconnect has left the API without the id to
   * answer, in which case it goes in as a message too.
   */
  protected async _handleFunctionCallResult(frame: FunctionCallResultFrame): Promise<void> {
    const result = pyTruthy(frame.result)
      ? pyJsonDumps(frame.result, { ensureAscii: false })
      : "COMPLETED";
    const isFinal = frame.properties ? frame.properties.isFinal : true;

    if (!isFinal) {
      const message = asyncToolMessages.buildIntermediateResultMessage(frame.toolCallId, result);
      await this._sendMessageItem(
        ((message as unknown as Record<string, unknown>).content as string | undefined) ?? "",
      );
    } else if (this._openFunctionCalls.has(frame.toolCallId)) {
      await this._sendToolResult(frame.toolCallId, result);
    } else {
      const message = asyncToolMessages.buildFinalResultMessage(frame.toolCallId, result);
      await this._sendMessageItem(
        ((message as unknown as Record<string, unknown>).content as string | undefined) ?? "",
      );
    }

    this._completedToolCalls.add(frame.toolCallId);
    this._resultsAwaitingResponse = true;
  }

  /** Settle a cancelled call, so the API isn't left waiting on it. */
  protected async _handleFunctionCallCancel(frame: FunctionCallCancelFrame): Promise<void> {
    if (!this._openFunctionCalls.has(frame.toolCallId)) {
      return;
    }
    await this._sendToolResult(frame.toolCallId, "CANCELLED");
    this._completedToolCalls.add(frame.toolCallId);
  }
}
