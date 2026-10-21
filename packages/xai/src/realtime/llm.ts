// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/services/xai/realtime/llm.py

/**
 * Grok Realtime Voice Agent LLM service implementation with WebSocket support.
 *
 * Porting notes:
 * - The websocket is `websocketConnect()` from core (the global `WebSocket`,
 *   or `fetch` with an `Upgrade` header on Cloudflare Workers), so the
 *   `Authorization` header works on every runtime.
 * - The deprecated `sessionProperties` constructor option is not ported; use
 *   `settings: new GrokRealtimeLLMService.Settings({ sessionProperties })`.
 */

import { rethrowIfCancelled, type Task, time } from "@pipedog/asyncio";
import type { BaseLLMAdapter } from "@pipedog/core/adapters/base_llm_adapter";
import type { ToolsSchema } from "@pipedog/core/adapters/schemas/tools_schema";
import { KeypadEntry } from "@pipedog/core/audio/dtmf/types";
import {
  BotStoppedSpeakingFrame,
  type CancelFrame,
  type EndFrame,
  type Frame,
  FunctionCallCancelFrame,
  FunctionCallFromLLM,
  FunctionCallResultFrame,
  InputAudioRawFrame,
  InputDTMFFrame,
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
import { ExternalUserTurnStrategies } from "@pipedog/core/turns/user_turn_strategies";
import { base64ToBytes, bytesToBase64 } from "@pipedog/core/utils/base64";
import { logger } from "@pipedog/core/utils/logger";
import { pyJsonDumps, pyJsonLoads } from "@pipedog/core/utils/py_json";
import { timeNowIso8601 } from "@pipedog/core/utils/time";
import { assertGiven, isGiven, NOT_GIVEN, type NotGiven } from "@pipedog/core/utils/types";
import { GrokRealtimeLLMAdapter } from "../grok_realtime_adapter.ts";
import * as events from "./events.ts";

// The adapter's invocation params are an interface, which isn't assignable to
// the `Record<string, unknown>` of `LLMService`'s adapter constraint.
type RealtimeAdapter = GrokRealtimeLLMAdapter & BaseLLMAdapter;

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Convert a snake_case key to camelCase (`turn_detection` → `turnDetection`). */
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

const KEYPAD_VALUES: readonly string[] = Object.values(KeypadEntry);

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

export interface GrokRealtimeLLMSettingsOptions extends LLMSettingsOptions {
  /**
   * Grok Realtime session properties (voice, audio config, tools, etc.).
   * `instructions` is synced bidirectionally with the top-level
   * `systemInstruction` field.
   */
  sessionProperties?: events.SessionProperties | NotGiven;
}

/**
 * Settings for GrokRealtimeLLMService.
 *
 * - `sessionProperties`: Grok Realtime session properties (voice, audio
 *   config, tools, etc.). `instructions` is synced bidirectionally with the
 *   top-level `systemInstruction` field.
 */
export class GrokRealtimeLLMSettings extends LLMSettings {
  sessionProperties: events.SessionProperties | NotGiven = NOT_GIVEN;

  constructor(options: GrokRealtimeLLMSettingsOptions = {}) {
    super(options);
    this._assignOptions(options);
  }

  // -- Bidirectional sync helpers ------------------------------------------

  /** Push top-level `systemInstruction` into `sessionProperties`. */
  static _syncTopLevelToSp(settings: GrokRealtimeLLMSettings): void {
    if (!isGiven(settings.sessionProperties)) {
      return;
    }
    const sp = settings.sessionProperties;
    if (isGiven(settings.systemInstruction)) {
      sp.instructions = settings.systemInstruction;
    }
  }

  // -- applyUpdate override -------------------------------------------------

  /**
   * Merge a delta, keeping `systemInstruction` in sync with SP.
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
    //    instructions that the delta didn't set at top level, pull it up.
    if ("sessionProperties" in changed && isGiven(this.sessionProperties)) {
      const sp = this.sessionProperties;
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
    GrokRealtimeLLMSettings._syncTopLevelToSp(this);

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
    const cls = this as unknown as typeof GrokRealtimeLLMSettings & (new (options?: object) => T);
    // Determine which keys belong to our own dataclass fields.
    const ownFieldNames = new Set(new cls()._fieldNames());

    const top: Record<string, unknown> = {};
    const spDict: Record<string, unknown> = {};
    const extra: Record<string, unknown> = {};

    // `modelFields` maps camelCase field names to wire keys; both spellings
    // are accepted. (`model` is one of our own fields, so it is routed to the
    // top level before the SP keys are checked.)
    const spKeys = new Map<string, string>();
    for (const [field, wire] of Object.entries(events.SessionProperties.modelFields)) {
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

export interface GrokRealtimeLLMServiceOptions extends LLMServiceOptions {
  /** xAI API key for authentication. */
  apiKey: string;
  /** WebSocket base URL for the realtime API. Defaults to "wss://api.x.ai/v1/realtime". */
  baseUrl?: string;
  /**
   * Runtime-updatable settings for this service. Set the voice and the rest
   * of the session with `sessionProperties`, e.g.
   * `new SessionProperties({ voice: "rex" })`. Built-in voice IDs are
   * documented by xAI (https://docs.x.ai/docs/guides/voice/agent); a custom
   * voice ID from the Custom Voices API may be used too.
   */
  settings?: GrokRealtimeLLMSettings | null;
  /** Whether to start with audio input paused. Defaults to false. */
  startAudioPaused?: boolean;
}

/**
 * Grok Realtime Voice Agent LLM service providing real-time audio and text
 * communication.
 *
 * Implements the Grok Voice Agent API with WebSocket communication for
 * low-latency bidirectional audio and text interactions. Supports function
 * calling, conversation management, and real-time transcription.
 *
 * Features:
 * - Real-time audio streaming (PCM, PCMU, PCMA formats)
 * - Configurable sample rates (8kHz to 48kHz for PCM)
 * - Built-in and custom voice IDs
 * - Built-in tools (web_search, x_search, file_search)
 * - Custom function calling
 * - Server-side VAD (Voice Activity Detection)
 *
 * Proposes turn boundaries from Grok's server-side VAD events, which the
 * recommended external user turn strategies resolve into
 * `UserStartedSpeakingFrame` / `UserStoppedSpeakingFrame`.
 * `LLMContextAggregatorPair` auto-detects this realtime service and decouples
 * context writes from those frames. If you wire local VAD
 * (`LLMUserAggregatorParams.vadAnalyzer`) on top of this service, disable
 * Grok's server-side turn detection first via `turnDetection: null` (manual
 * mode); otherwise both sources broadcast duplicate user-turn frames. See
 * `examples/realtime/realtime-grok-locally-driven-turns.py`.
 */
export class GrokRealtimeLLMService extends LLMService<RealtimeAdapter> {
  static Settings = GrokRealtimeLLMSettings;
  declare protected _settings: GrokRealtimeLLMSettings;

  // Use the Grok-specific adapter
  static override adapterClass: LLMAdapterClass | null =
    GrokRealtimeLLMAdapter as unknown as LLMAdapterClass;

  apiKey: string;
  baseUrl: string;

  protected _audioInputPaused: boolean;
  protected _websocket: WebsocketClientConnection | null = null;
  protected _receiveTask: Task<unknown> | null = null;
  protected _context: LLMContext | null = null;

  protected _llmNeedsConversationSetup = true;

  protected _disconnecting = false;
  protected _apiSessionReady = false;
  protected _runLlmWhenApiSessionReady = false;
  protected _loggedAudioDropBeforeSessionReady = false;

  protected _currentAssistantResponse: events.ConversationItem | null = null;
  protected _currentAudioResponse: CurrentAudioResponse | null = null;

  protected _messagesAddedManually = new Map<string, boolean>();
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

  protected _sessionId: string | null = null;
  protected _conversationId: string | null = null;
  protected _currentResponseId: string | null = null;

  /**
   * Initialize the Grok Realtime Voice Agent LLM service.
   *
   * @param options.apiKey xAI API key for authentication.
   * @param options.baseUrl WebSocket base URL for the realtime API.
   * @param options.settings Runtime-updatable settings for this service.
   * @param options.startAudioPaused Whether to start with audio input paused.
   *   Other options are passed to the parent LLMService.
   */
  constructor(options: GrokRealtimeLLMServiceOptions) {
    const cls = new.target as typeof GrokRealtimeLLMService;
    const baseUrl = options.baseUrl ?? "wss://api.x.ai/v1/realtime";

    // 1. Initialize default_settings with hardcoded defaults
    const defaultSettings = new cls.Settings({
      model: "grok-voice-latest",
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
      sessionProperties: new events.SessionProperties(),
    });

    // Sync top-level systemInstruction back into sessionProperties
    cls.Settings._syncTopLevelToSp(defaultSettings);

    // 2. Apply settings delta (canonical API, always wins)
    if (options.settings !== null && options.settings !== undefined) {
      defaultSettings.applyUpdate(options.settings);
    }

    super({ ...options, settings: defaultSettings });

    this.apiKey = options.apiKey;
    this.baseUrl = baseUrl;

    this._audioInputPaused = options.startAudioPaused ?? false;

    this._registerEventHandler("on_conversation_item_created");
    this._registerEventHandler("on_conversation_item_updated");
    this._registerEventHandler("on_conversation_item_deleted");
    this._registerEventHandler("on_conversation_item_truncated");
    this._registerEventHandler("on_idle_timeout");
    this._registerEventHandler("on_dtmf_received");
    this._registerEventHandler("on_mcp_event");
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
   * Get manually configured sample rate for input or output.
   *
   * @param direction Either "input" or "output".
   * @returns Configured sample rate or null if not manually configured. For
   *   PCMU/PCMA formats, returns 8000 Hz (G.711 standard).
   */
  protected _getConfiguredSampleRate(direction: "input" | "output"): number | null {
    const sessionProperties = assertGiven(this._settings.sessionProperties);
    if (!sessionProperties.audio) {
      return null;
    }

    const audioConfig =
      direction === "input" ? sessionProperties.audio.input : sessionProperties.audio.output;

    if (audioConfig?.format) {
      // PCM format has configurable rate
      if (audioConfig.format instanceof events.PCMAudioFormat) {
        return audioConfig.format.rate;
      }
      // PCMU/PCMA formats are fixed at 8000 Hz (G.711 standard)
      if (audioConfig.format.type === "audio/pcmu" || audioConfig.format.type === "audio/pcma") {
        return 8000;
      }
    }

    return null;
  }

  /**
   * Get the output sample rate from session properties.
   *
   * This assumes `setup()` has run, which guarantees
   * `sessionProperties.audio.output` exists.
   *
   * @returns Output sample rate in Hz.
   */
  protected _getOutputSampleRate(): number {
    const rate = this._getConfiguredSampleRate("output");
    if (rate === null) {
      throw new Error("Output sample rate not configured.");
    }
    return rate;
  }

  /** Check if server-side VAD is enabled. */
  protected _isTurnDetectionEnabled(): boolean {
    const sessionProperties = assertGiven(this._settings.sessionProperties);
    if (sessionProperties.turnDetection) {
      return sessionProperties.turnDetection.type === "server_vad";
    }
    return false;
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
    const emitsTurnFrames = this._isTurnDetectionEnabled();
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
   * Always send `response.cancel` so in-flight assistant audio stops on the
   * wire promptly. When server VAD is off, also clear the input buffer
   * (manual turn mode owns commit/cancel). With server VAD on, leave the
   * input buffer intact so the interrupting user speech is not wiped.
   */
  protected async _handleInterruption(): Promise<void> {
    if (!this._isTurnDetectionEnabled()) {
      await this.sendClientEvent(new events.InputAudioBufferClearEvent());
    }

    await this.sendClientEvent(new events.ResponseCancelEvent());

    await this._truncateCurrentAudioResponse();
    await this.stopAllMetrics();
    // Whatever the interrupted response was going to say is moot, and so is
    // a response owed behind it: the user's turn makes one of its own.
    this._responseCreateOwed = false;

    if (this._currentAssistantResponse) {
      await this.pushFrame(new LLMFullResponseEndFrame());
      await this.pushFrame(new TTSStoppedFrame());
    }
  }

  /** Handle user started speaking event. */
  protected async _handleUserStartedSpeaking(_frame: UserStartedSpeakingFrame): Promise<void> {}

  /** Handle user stopped speaking event. */
  protected async _handleUserStoppedSpeaking(_frame: UserStoppedSpeakingFrame): Promise<void> {
    if (!this._isTurnDetectionEnabled()) {
      await this.sendClientEvent(new events.InputAudioBufferCommitEvent());
      await this.sendClientEvent(new events.ResponseCreateEvent());
    }
  }

  /** Handle bot stopped speaking event. */
  protected async _handleBotStoppedSpeaking(): Promise<void> {
    this._currentAudioResponse = null;
  }

  /** Calculate audio duration in milliseconds based on PCM audio parameters. */
  protected _calculateAudioDurationMs(
    totalBytes: number,
    sampleRate: number | null = null,
    bytesPerSample = 2,
  ): number {
    const rate = sampleRate ?? this._getOutputSampleRate();
    const samples = totalBytes / bytesPerSample;
    const durationSeconds = samples / rate;
    return Math.trunc(durationSeconds * 1000);
  }

  /**
   * Truncate the in-flight assistant audio item on the server and locally.
   *
   * Sends `conversation.item.truncate` at the shorter of wall-clock elapsed
   * time and bytes received so conversation history matches what the user
   * heard. Failures are non-fatal — `response.cancel` still stops playback.
   */
  protected async _truncateCurrentAudioResponse(): Promise<void> {
    if (!this._currentAudioResponse) {
      return;
    }

    try {
      const current = this._currentAudioResponse;
      this._currentAudioResponse = null;

      const audioDurationMs = this._calculateAudioDurationMs(current.totalSize);
      const elapsedMs = Math.trunc(time() * 1000 - current.startTimeMs);
      const truncateMs = Math.max(0, Math.min(elapsedMs, audioDurationMs));

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
      logger.warning(`Audio truncation failed (non-fatal): ${errorMessage(e)}`);
    }
  }

  /**
   * Delete a conversation item by id.
   *
   * @param itemId ID of the conversation item to delete.
   */
  async deleteConversationItem(itemId: string): Promise<void> {
    await this.sendClientEvent(new events.ConversationItemDeleteEvent({ itemId }));
  }

  /**
   * Speak a hard-coded TTS line without involving the model.
   *
   * Sends a `force_message` conversation item. Do not follow with
   * `response.create` — the server injects the response lifecycle.
   *
   * @param text Verbatim text to synthesize and play.
   */
  async forceMessage(text: string): Promise<void> {
    await this.sendClientEvent(
      new events.ConversationItemCreateEvent({
        item: new events.ConversationItem({
          type: "force_message",
          role: "assistant",
          content: [new events.ItemContent({ type: "text", text })],
        }),
      }),
    );
  }

  //
  // Standard AIService frame handling
  //

  /**
   * Ensure `sessionProperties.audio` has input and output configs.
   *
   * Fills in any missing audio configuration using the given sample rates.
   *
   * @param inputSampleRate Sample rate for audio input (Hz).
   * @param outputSampleRate Sample rate for audio output (Hz).
   */
  protected _ensureAudioConfig(inputSampleRate: number, outputSampleRate: number): void {
    const props = assertGiven(this._settings.sessionProperties);
    if (!props.audio) {
      props.audio = new events.AudioConfiguration();
    }
    if (!props.audio.input) {
      props.audio.input = new events.AudioInput({
        format: new events.PCMAudioFormat({
          rate: inputSampleRate as events.SUPPORTED_SAMPLE_RATES,
        }),
      });
    }
    if (!props.audio.output) {
      props.audio.output = new events.AudioOutput({
        format: new events.PCMAudioFormat({
          rate: outputSampleRate as events.SUPPORTED_SAMPLE_RATES,
        }),
      });
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
  // Frame processing
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
    } else if (frame instanceof InterruptionFrame) {
      await this._handleInterruption();
    } else if (frame instanceof UserStartedSpeakingFrame) {
      await this._handleUserStartedSpeaking(frame);
    } else if (frame instanceof UserStoppedSpeakingFrame) {
      await this._handleUserStoppedSpeaking(frame);
    } else if (frame instanceof BotStoppedSpeakingFrame) {
      await this._handleBotStoppedSpeaking();
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

  /** Put text into the conversation for the model to take in, without answering it. */
  protected async _sendMessageItem(text: string, role = "user"): Promise<void> {
    const item = new events.ConversationItem({
      type: "message",
      role: role as "user" | "assistant",
      content: [new events.ItemContent({ type: "input_text", text })],
    });
    await this.sendClientEvent(new events.ConversationItemCreateEvent({ item }));
  }

  /** Handle LLM context updates. */
  protected async _handleContext(context: LLMContext, direction: FrameDirection): Promise<void> {
    if (!this._context) {
      this._context = context;
      await this._processCompletedFunctionCalls(false);
      await this._createResponse();
    } else {
      this._context = context;
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
      await this._sendMessageItem(text, role === "assistant" ? "assistant" : "user");
    }
    this._resultsAwaitingResponse = true;
  }

  //
  // WebSocket communication
  //

  /**
   * Send a client event to the Grok Voice Agent API.
   *
   * @param event The client event to send.
   */
  async sendClientEvent(event: events.ClientEvent): Promise<void> {
    await this._wsSend(event.modelDump({ excludeNone: true }));
  }

  /** Establish WebSocket connection to Grok. */
  protected async _connect(): Promise<void> {
    try {
      if (this._websocket) {
        return;
      }

      // Model is selected via query param at connection time; xAI does
      // not support changing it via session.update.
      const model = assertGiven(this._settings.model);
      // The service is constructed with a model and the URL needs one.
      if (model === null) {
        throw new Error("AssertionError: model is None");
      }
      const uri = `${this.baseUrl}?model=${encodeURIComponent(model)}`;

      this._websocket = await websocketConnect(uri, {
        additionalHeaders: {
          Authorization: `Bearer ${this.apiKey}`,
        },
      });
      this._receiveTask = this.createTask(
        () => this._receiveTaskHandler(),
        "_receive_task_handler",
      );
    } catch (e) {
      rethrowIfCancelled(e);
      await this.pushError(`Error connecting to Grok: ${errorMessage(e)}`, { exception: e });
      this._websocket = null;
    }
  }

  /** Close WebSocket connection. */
  protected async _disconnect(): Promise<void> {
    try {
      this._disconnecting = true;
      this._apiSessionReady = false;
      this._loggedAudioDropBeforeSessionReady = false;
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

  /** Send a message over the WebSocket connection. */
  protected async _wsSend(realtimeMessage: Record<string, unknown>): Promise<void> {
    try {
      if (!this._disconnecting && this._websocket) {
        await this._websocket.send(pyJsonDumps(realtimeMessage));
      }
    } catch (e) {
      rethrowIfCancelled(e);
      if (this._disconnecting || !this._websocket) {
        return;
      }
      await this.pushError(`Error sending client event: ${errorMessage(e)}`, { exception: e });
    }
  }

  /** Apply a settings delta, sending a session update when needed. */
  protected override async _updateSettings(delta: LLMSettings): Promise<Record<string, unknown>> {
    // Capture audio config before the update — a wholesale SP replacement
    // would lose it since the new SP likely has audio=None.
    const inputRate = this._getConfiguredSampleRate("input");
    const outputRate = this._getConfiguredSampleRate("output");

    const changed = await super._updateSettings(delta);

    // Re-establish audio config if it was lost during SP replacement.
    if ("sessionProperties" in changed && inputRate && outputRate) {
      this._ensureAudioConfig(inputRate, outputRate);
    }

    const handled = new Set(["sessionProperties", "systemInstruction"]);
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
      settings.tools = llmInvocationParams.tools as events.GrokTool[];
    } else {
      // No context yet: the init-provided tools; built-in tools ride along.
      settings.tools = adapter.fromStandardTools(settings.tools) as events.GrokTool[];
    }

    await this.sendClientEvent(new events.SessionUpdateEvent({ session: settings }));
  }

  //
  // Inbound server event handling
  //

  /** Handle incoming WebSocket messages. */
  protected async _receiveTaskHandler(): Promise<void> {
    if (this._websocket === null) {
      throw new Error("AssertionError: _websocket is None");
    }

    for await (const message of this._websocket) {
      let evt: any;
      try {
        evt = events.parseServerEvent(message);
      } catch (e) {
        rethrowIfCancelled(e);
        logger.warning(`Failed to parse server event: ${errorMessage(e)}`);
        continue;
      }

      if (evt.type === "ping") {
        // Ignore ping events (keep-alive)
      } else if (evt.type === "session.created") {
        await this._handleEvtSessionCreated(evt);
      } else if (evt.type === "conversation.created") {
        await this._handleEvtConversationCreated(evt);
      } else if (evt.type === "session.updated") {
        await this._handleEvtSessionUpdated(evt);
      } else if (evt.type === "response.created") {
        await this._handleEvtResponseCreated(evt);
      } else if (evt.type === "response.output_audio.delta") {
        await this._handleEvtAudioDelta(evt);
      } else if (evt.type === "response.output_audio.done") {
        await this._handleEvtAudioDone(evt);
      } else if (
        evt.type === "response.content_part.added" ||
        evt.type === "response.content_part.done"
      ) {
        // pass
      } else if (evt.type === "response.output_item.added") {
        await this._handleEvtConversationItemAdded(evt);
      } else if (evt.type === "response.output_item.done") {
        // pass
      } else if (evt.type === "conversation.item.added") {
        await this._handleEvtConversationItemAdded(evt);
      } else if (evt.type === "conversation.item.deleted") {
        await this._handleEvtConversationItemDeleted(evt);
      } else if (evt.type === "conversation.item.truncated") {
        await this._handleEvtConversationItemTruncated(evt);
      } else if (evt.type === "conversation.item.input_audio_transcription.updated") {
        await this._handleEvtInputAudioTranscriptionUpdated(evt);
      } else if (evt.type === "conversation.item.input_audio_transcription.completed") {
        await this._handleEvtInputAudioTranscriptionCompleted(evt);
      } else if (evt.type === "response.done") {
        await this._handleEvtResponseDone(evt);
      } else if (evt.type === "input_audio_buffer.speech_started") {
        await this._handleEvtSpeechStarted(evt);
      } else if (evt.type === "input_audio_buffer.speech_stopped") {
        await this._handleEvtSpeechStopped(evt);
      } else if (
        evt.type === "input_audio_buffer.committed" ||
        evt.type === "input_audio_buffer.cleared"
      ) {
        // pass
      } else if (evt.type === "input_audio_buffer.timeout_triggered") {
        await this._handleEvtTimeoutTriggered(evt);
      } else if (evt.type === "input_audio_buffer.dtmf_event_received") {
        await this._handleEvtDtmfReceived(evt);
      } else if (evt.type === "response.output_audio_transcript.delta") {
        await this._handleEvtAudioTranscriptDelta(evt);
      } else if (evt.type === "response.output_audio_transcript.done") {
        // pass
      } else if (evt.type === "response.output_text.delta" || evt.type === "response.text.delta") {
        await this._handleEvtTextDelta(evt);
      } else if (evt.type === "response.function_call_arguments.delta") {
        // Function call arguments streaming - we wait for the .done event
      } else if (evt.type === "response.function_call_arguments.done") {
        await this._handleEvtFunctionCallArgumentsDone(evt);
      } else if (
        evt.type.startsWith("mcp_list_tools.") ||
        evt.type.startsWith("response.mcp_call")
      ) {
        await this._handleEvtMcp(evt);
      } else if (evt.type === "error") {
        // Match Grok's actual codes/messages for cancel-not-active
        // and already-active. Grok's error codes diverge from
        // OpenAI's here, so fall back to substring matching on the
        // message text. Without this, an otherwise-benign cancel
        // race ("Cancellation failed: no active response found")
        // falls through to `_handleEvtError` + `return`, which
        // exits the receive loop and stalls the conversation.
        const msg = ((evt.error.message as string | null) || "").toLowerCase();
        if (
          evt.error.code === "response_cancel_not_active" ||
          evt.error.code === "conversation_already_has_active_response" ||
          msg.includes("no active response") ||
          msg.includes("already has an active response") ||
          msg.includes("truncat")
        ) {
          logger.debug(`${this} ${evt.error.message}`);
        } else {
          await this._handleEvtError(evt);
          return;
        }
      }
    }
  }

  /** Record the server session snapshot; config is sent on conversation.created. */
  protected async _handleEvtSessionCreated(evt: events.SessionCreatedEvent): Promise<void> {
    this._sessionId = evt.session?.id || this._sessionId;
  }

  /** Handle conversation.created — send the initial session update. */
  protected async _handleEvtConversationCreated(evt: events.ConversationCreated): Promise<void> {
    this._conversationId = evt.conversation.id;
    await this._sendSessionUpdate();
  }

  /** Handle response.created event - response generation started. */
  protected async _handleEvtResponseCreated(evt: events.ResponseCreated): Promise<void> {
    this._currentResponseId = evt.response ? evt.response.id : null;
    // The response takes in everything delivered before it.
    this._responseActive = true;
    this._resultsAwaitingResponse = false;
  }

  /** Handle session.updated event. */
  protected async _handleEvtSessionUpdated(evt: events.SessionUpdatedEvent): Promise<void> {
    if (evt.session?.id) {
      this._sessionId = evt.session.id;
    }
    this._apiSessionReady = true;
    if (this._runLlmWhenApiSessionReady) {
      this._runLlmWhenApiSessionReady = false;
      await this._createResponse();
    }
  }

  /** Handle conversation.item.deleted confirmation. */
  protected async _handleEvtConversationItemDeleted(
    evt: events.ConversationItemDeleted,
  ): Promise<void> {
    await this._callEventHandler("on_conversation_item_deleted", evt.itemId);
  }

  /** Handle conversation.item.truncated confirmation. */
  protected async _handleEvtConversationItemTruncated(
    evt: events.ConversationItemTruncated,
  ): Promise<void> {
    await this._callEventHandler(
      "on_conversation_item_truncated",
      evt.itemId,
      evt.contentIndex,
      evt.audioEndMs,
    );
  }

  /** Handle idle timeout — server starts a proactive check-in response. */
  protected async _handleEvtTimeoutTriggered(
    evt: events.InputAudioBufferTimeoutTriggered,
  ): Promise<void> {
    logger.debug(`${this} Idle timeout triggered; server will check in`);
    await this._callEventHandler("on_idle_timeout", evt.itemId);
    await this.startTtfbMetrics();
    await this.startProcessingMetrics();
  }

  /** Push SIP DTMF digits into the pipeline as InputDTMFFrame. */
  protected async _handleEvtDtmfReceived(
    evt: events.InputAudioBufferDtmfEventReceived,
  ): Promise<void> {
    const digit = evt.digit;
    if (!digit) {
      return;
    }
    if (!KEYPAD_VALUES.includes(digit)) {
      logger.warning(`${this} Ignoring unsupported DTMF digit: ${pyRepr(digit)}`);
      return;
    }
    const button = digit as KeypadEntry;
    await this._callEventHandler("on_dtmf_received", button);
    await this.pushFrame(new InputDTMFFrame({ button }), FrameDirection.UPSTREAM);
  }

  /** Handle MCP discovery / call lifecycle events. */
  protected async _handleEvtMcp(
    evt: events.McpListToolsEvent | events.ResponseMcpCallEvent,
  ): Promise<void> {
    await this._callEventHandler("on_mcp_event", evt.type, evt);
    if (evt.type.endsWith(".failed")) {
      await this.pushError(`Grok Realtime MCP failure: ${evt.type}`);
    }
  }

  /** Handle audio delta event - streaming audio from assistant. */
  protected async _handleEvtAudioDelta(evt: events.ResponseAudioDelta): Promise<void> {
    await this.stopTtfbMetrics();

    if (!this._currentAudioResponse) {
      this._currentAudioResponse = new CurrentAudioResponse({
        itemId: evt.itemId,
        contentIndex: evt.contentIndex,
        startTimeMs: Math.trunc(time() * 1000),
      });
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

  /** Handle audio done event. */
  protected async _handleEvtAudioDone(_evt: events.ResponseAudioDone): Promise<void> {
    if (this._currentAudioResponse) {
      await this.pushFrame(new TTSStoppedFrame());
    }
  }

  /** Handle conversation.item.added event. */
  protected async _handleEvtConversationItemAdded(
    evt: events.ConversationItemAdded | events.ResponseOutputItemAdded,
  ): Promise<void> {
    if (evt.item.type === "function_call") {
      // Track this function call for when arguments are completed
      // Only add if not already tracked (prevent duplicates)
      const callId = evt.item.callId as string;
      if (!this._pendingFunctionCalls.has(callId)) {
        this._pendingFunctionCalls.set(callId, evt.item);
      } else {
        // Grok may send multiple conversation.item.added events for the same function call
        logger.debug(`Function call ${callId} already tracked, skipping`);
      }
    }

    await this._callEventHandler("on_conversation_item_created", evt.item.id, evt.item);

    if (this._messagesAddedManually.get(evt.item.id)) {
      this._messagesAddedManually.delete(evt.item.id);
      return;
    }

    if (evt.item.role === "assistant") {
      this._currentAssistantResponse = evt.item;
      await this.pushFrame(new LLMFullResponseStartFrame());
    }
  }

  /** Handle cumulative streaming user transcription (grok-transcribe). */
  protected async _handleEvtInputAudioTranscriptionUpdated(
    evt: events.ConversationItemInputAudioTranscriptionUpdated,
  ): Promise<void> {
    const transcript = evt.transcript ? evt.transcript.trim() : "";
    if (transcript) {
      await this.pushFrame(
        new InterimTranscriptionFrame({
          text: transcript,
          userId: "",
          timestamp: timeNowIso8601(),
          result: evt,
        }),
        FrameDirection.UPSTREAM,
      );
    }
  }

  /** Handle input audio transcription completed event. */
  protected async _handleEvtInputAudioTranscriptionCompleted(
    evt: events.ConversationItemInputAudioTranscriptionCompleted,
  ): Promise<void> {
    await this._callEventHandler("on_conversation_item_updated", evt.itemId, null);

    // Only push transcription if we have actual text (not empty or just whitespace)
    const transcript = evt.transcript ? evt.transcript.trim() : "";
    if (transcript) {
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

  /** Handle response.done event. */
  protected async _handleEvtResponseDone(evt: events.ResponseDone): Promise<void> {
    this._responseActive = false;
    // A response asked for while this one was running is owed now, unless
    // this one took in what it was for.
    if (this._responseCreateOwed) {
      this._responseCreateOwed = false;
      if (this._resultsAwaitingResponse) {
        await this._createResponse();
      }
    }

    // Usage metrics - check both response.usage and top-level usage
    const usage = evt.usage ?? evt.response.usage;
    if (usage?.totalTokens) {
      const tokens = new LLMTokenUsage({
        promptTokens: usage.inputTokens ?? 0,
        completionTokens: usage.outputTokens ?? 0,
        totalTokens: usage.totalTokens ?? 0,
      });
      await this.startLlmUsageMetrics(tokens);
    }

    await this.stopProcessingMetrics();
    await this.pushFrame(new LLMFullResponseEndFrame());
    this._currentAssistantResponse = null;
    this._currentResponseId = null;

    // Error handling
    if (evt.response.status === "failed") {
      let errorMsg = "Response failed";
      if (pyTruthy(evt.response.statusDetails)) {
        // DIVERGENCE: upstream uses `str(status_details)` (a Python dict
        // repr); a non-string is rendered as JSON here.
        const details = evt.response.statusDetails;
        errorMsg = typeof details === "string" ? details : pyJsonDumps(details);
      }
      await this.pushError(errorMsg);
      return;
    }

    // Update conversation items
    for (const item of evt.response.output) {
      await this._callEventHandler("on_conversation_item_updated", item.id, item);
    }
  }

  /** Handle audio transcript delta event. */
  protected async _handleEvtAudioTranscriptDelta(
    evt: events.ResponseAudioTranscriptDelta,
  ): Promise<void> {
    if (evt.delta) {
      await this._pushOutputTranscriptTextFrames(evt.delta);
    }
  }

  /** Handle text-mode output deltas (`response.*.text.delta`). */
  protected async _handleEvtTextDelta(evt: events.ResponseTextDelta): Promise<void> {
    if (evt.delta) {
      const frame = new LLMTextFrame({ text: evt.delta });
      await this.pushFrame(frame);
    }
  }

  protected async _pushOutputTranscriptTextFrames(text: string): Promise<void> {
    // In a typical "cascade" LLM + TTS setup, LLMTextFrames would not
    // proceed beyond the TTS service. Therefore, since a speech-to-speech
    // service like Grok Realtime combines both LLM and TTS functionality,
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

  /** Handle function call arguments done event. */
  protected async _handleEvtFunctionCallArgumentsDone(
    evt: events.ResponseFunctionCallArgumentsDone,
  ): Promise<void> {
    try {
      const args = pyJsonLoads(evt.arguments) as Record<string, unknown>;

      const functionCallItem = this._pendingFunctionCalls.get(evt.callId);
      if (functionCallItem) {
        this._pendingFunctionCalls.delete(evt.callId);

        // The API is waiting on this call now, so its id can be answered
        // with a function_call_output.
        this._openFunctionCalls.add(evt.callId);

        const functionCalls = [
          new FunctionCallFromLLM({
            context: this._context,
            toolCallId: evt.callId,
            functionName: evt.name,
            arguments: args,
          }),
        ];

        await this.runFunctionCalls(functionCalls);
        logger.debug(`Processed function call: ${evt.name}`);
      } else {
        logger.warning(`No tracked function call found for call_id: ${evt.callId}`);
      }
    } catch (e) {
      rethrowIfCancelled(e);
      logger.error(`Failed to process function call arguments: ${errorMessage(e)}`);
    }
  }

  /** Handle speech started event from VAD. */
  protected async _handleEvtSpeechStarted(
    _evt: events.InputAudioBufferSpeechStarted,
  ): Promise<void> {
    if (!this._isTurnDetectionEnabled()) {
      // In local turn detection mode, the client is responsible for broadcasting user turn frames
      return;
    }

    this._responseCreateOwed = false;
    await this._truncateCurrentAudioResponse();
    await this.broadcastFrame(ProposedUserStartedSpeakingFrame);
  }

  /** Handle speech stopped event from VAD. */
  protected async _handleEvtSpeechStopped(
    _evt: events.InputAudioBufferSpeechStopped,
  ): Promise<void> {
    if (!this._isTurnDetectionEnabled()) {
      // In local turn detection mode, the client is responsible for broadcasting user turn frames
      return;
    }

    await this.startTtfbMetrics();
    await this.startProcessingMetrics();
    await this.broadcastFrame(ProposedUserStoppedSpeakingFrame);
  }

  /** Handle error event. */
  protected async _handleEvtError(evt: events.ErrorEvent): Promise<void> {
    await this.pushError(`Grok Realtime Error: ${evt.error.message}`);
  }

  //
  // Response creation
  //

  /** Reset the conversation by disconnecting and reconnecting. */
  async resetConversation(): Promise<void> {
    logger.debug("Resetting Grok conversation");
    await this._disconnect();

    this._llmNeedsConversationSetup = true;
    await this._processCompletedFunctionCalls(false);

    await this._connect();
  }

  /** Create an assistant response. */
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

    if (this._llmNeedsConversationSetup) {
      this._logLlmConversationSetup(context);

      const llmInvocationParams = await adapter.getLlmInvocationParams(context);
      const messages = llmInvocationParams.messages;

      for (const item of messages) {
        const evt = new events.ConversationItemCreateEvent({ item });
        this._messagesAddedManually.set(evt.item.id, true);
        await this.sendClientEvent(evt);
      }

      await this._sendSessionUpdate();
      this._llmNeedsConversationSetup = false;
    }

    logger.debug("Creating Grok response");
    // Active from the moment the create is sent, not from response.created: a
    // second create in between would be refused by the API.
    this._responseActive = true;

    await this.pushFrame(new LLMFullResponseStartFrame());
    await this.startProcessingMetrics();
    await this.startTtfbMetrics();

    await this.sendClientEvent(
      new events.ResponseCreateEvent({
        response: new events.ResponseProperties({ modalities: ["text", "audio"] }),
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
   * Send user audio to Grok.
   *
   * Audio is gated on `_apiSessionReady` (set after `session.updated`), once
   * the session sample rate has been applied. Conversation seeding
   * (`_llmNeedsConversationSetup`) is independent so audio-only pipelines can
   * stream without calling `_createResponse`.
   */
  protected async _sendUserAudio(frame: InputAudioRawFrame): Promise<void> {
    if (!this._apiSessionReady) {
      if (!this._loggedAudioDropBeforeSessionReady) {
        this._loggedAudioDropBeforeSessionReady = true;
        logger.debug(
          `${this} Dropping user audio; realtime session is not ready yet ` +
            "(waiting for session.updated)",
        );
      }
      return;
    }

    const payload = bytesToBase64(frame.audio);
    await this.sendClientEvent(new events.InputAudioBufferAppendEvent({ audio: payload }));
  }

  /** Send a tool call result to Grok. */
  protected async _sendToolResult(toolCallId: string, result: string | null): Promise<void> {
    logger.debug(`Sending tool result to Grok Realtime for tool_call_id=${toolCallId}`);
    this._openFunctionCalls.delete(toolCallId);
    const item = new events.ConversationItem({
      type: "function_call_output",
      callId: toolCallId,
      output: result,
    });
    await this.sendClientEvent(new events.ConversationItemCreateEvent({ item }));
  }
}
