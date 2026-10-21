// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/services/inworld/realtime/llm.py

/**
 * Inworld Realtime LLM service implementation with WebSocket support.
 *
 * Based on Inworld's Realtime API documentation:
 * https://docs.inworld.ai/api-reference/realtimeAPI/realtime/realtime-websocket
 *
 * Porting notes:
 * - The websocket is `websocketConnect()` from core (the global `WebSocket`,
 *   or `fetch` with an `Upgrade` header on Cloudflare Workers), so the
 *   `Authorization` header works on every runtime.
 */

import { rethrowIfCancelled, type Task, time } from "@pipedog/asyncio";
import type { BaseLLMAdapter } from "@pipedog/core/adapters/base_llm_adapter";
import type { ToolsSchema } from "@pipedog/core/adapters/schemas/tools_schema";
import {
  BotStoppedSpeakingFrame,
  type CancelFrame,
  type EndFrame,
  type Frame,
  FunctionCallCancelFrame,
  FunctionCallFromLLM,
  FunctionCallResultFrame,
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
  type LLMWithBackendRole,
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
import { InworldRealtimeLLMAdapter } from "../inworld_realtime_adapter.ts";
import * as events from "./events.ts";

// The adapter's invocation params are an interface, which isn't assignable to
// the `Record<string, unknown>` of `LLMService`'s adapter constraint.
type RealtimeAdapter = InworldRealtimeLLMAdapter & BaseLLMAdapter;

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

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
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

export interface InworldRealtimeLLMSettingsOptions extends LLMSettingsOptions {
  /**
   * Inworld Realtime session properties (audio config, tools, etc.). `model`
   * and `instructions` are synced bidirectionally with the top-level `model`
   * and `systemInstruction` fields.
   */
  sessionProperties?: events.SessionProperties | NotGiven;
}

/**
 * Settings for InworldRealtimeLLMService.
 *
 * - `sessionProperties`: Inworld Realtime session properties (audio config,
 *   tools, etc.). `model` and `instructions` are synced bidirectionally with
 *   the top-level `model` and `systemInstruction` fields.
 */
export class InworldRealtimeLLMSettings extends LLMSettings {
  sessionProperties: events.SessionProperties | NotGiven = NOT_GIVEN;

  constructor(options: InworldRealtimeLLMSettingsOptions = {}) {
    super(options);
    this._assignOptions(options);
  }

  // -- Bidirectional sync helpers ------------------------------------------

  /** Push top-level `model`/`systemInstruction`/`temperature` into SP. */
  static _syncTopLevelToSp(settings: InworldRealtimeLLMSettings): void {
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
   * SP wholesale (matching legacy behaviour). Top-level field values always
   * take precedence over conflicting SP values.
   */
  override applyUpdate(delta: this): Record<string, unknown> {
    const changed = super.applyUpdate(delta);

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

    InworldRealtimeLLMSettings._syncTopLevelToSp(this);

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
    const cls = this as unknown as typeof InworldRealtimeLLMSettings &
      (new (
        options?: object,
      ) => T);
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

// Error codes that are non-fatal and should not exit the receive loop.
const _NON_FATAL_ERROR_CODES = new Set([
  "response_cancel_not_active",
  "conversation_already_has_active_response",
]);

export interface InworldRealtimeLLMServiceOptions extends LLMServiceOptions {
  /** Inworld API key for authentication. */
  apiKey: string;
  /**
   * LLM model to use (e.g. "openai/gpt-4.1-mini"). Shorthand for
   * `sessionProperties.model`.
   */
  llmModel?: string | null;
  /**
   * Voice ID for TTS output (e.g. "Sarah", "Clive"). Shorthand for
   * `sessionProperties.audio.output.voice`.
   */
  voice?: string | null;
  /**
   * TTS model to use (e.g. "inworld-tts-2"). Shorthand for
   * `sessionProperties.audio.output.model`.
   */
  ttsModel?: string | null;
  /**
   * STT model for input transcription (e.g. "inworld/inworld-stt-1").
   * Defaults to "inworld/inworld-stt-1". Shorthand for
   * `sessionProperties.audio.input.transcription.model`.
   */
  sttModel?: string | null;
  /**
   * WebSocket base URL for the realtime API. Defaults to
   * "wss://api.inworld.ai/api/v1/realtime/session".
   */
  baseUrl?: string;
  /**
   * Authentication type. "basic" for server-side API key auth, "bearer" for
   * client-side JWT auth. Defaults to "basic".
   */
  authType?: "basic" | "bearer";
  /**
   * Full settings for fine-grained control. When `sessionProperties` is
   * provided in settings, it **replaces** all defaults wholesale — provide a
   * complete `SessionProperties` in that case.
   */
  settings?: InworldRealtimeLLMSettings | null;
  /** Whether to start with audio input paused. Defaults to false. */
  startAudioPaused?: boolean;
}

/**
 * Inworld Realtime LLM service for real-time audio and text communication.
 *
 * Implements the Inworld Realtime API with WebSocket communication for
 * low-latency bidirectional audio and text interactions. The API operates as
 * a cascade STT/LLM/TTS pipeline under the hood, with built-in semantic voice
 * activity detection (VAD) for turn management.
 *
 * Supports function calling, conversation management, and real-time
 * transcription.
 *
 * Proposes turn boundaries from Inworld's server-side VAD events, which the
 * recommended external user turn strategies resolve into
 * `UserStartedSpeakingFrame` / `UserStoppedSpeakingFrame`.
 * `LLMContextAggregatorPair` auto-detects this realtime service and decouples
 * context writes from those frames. If you wire local VAD
 * (`LLMUserAggregatorParams.vadAnalyzer`) on top of this service, disable
 * Inworld's server-side turn detection first via `turnDetection: null`
 * (manual mode); otherwise both sources broadcast duplicate user-turn frames.
 * See `examples/realtime/realtime-inworld-locally-driven-turns.py`.
 *
 * @example
 * ```ts
 * const llm = new InworldRealtimeLLMService({
 *   apiKey: process.env.INWORLD_API_KEY ?? "",
 *   llmModel: "openai/gpt-4.1-mini",
 *   voice: "Sarah",
 *   ttsModel: "inworld-tts-2",
 * });
 * ```
 *
 * For full control over session properties (note: `sessionProperties`
 * **replaces** all defaults, so provide a complete config):
 *
 * ```ts
 * const llm = new InworldRealtimeLLMService({
 *   apiKey: process.env.INWORLD_API_KEY ?? "",
 *   settings: new InworldRealtimeLLMService.Settings({
 *     sessionProperties: new SessionProperties({
 *       model: "openai/gpt-4.1-mini",
 *       temperature: 0.7,
 *       audio: new AudioConfiguration({
 *         input: new AudioInput({
 *           format: new PCMAudioFormat({ rate: 24000 }),
 *           turnDetection: new TurnDetection({ type: "semantic_vad", eagerness: "low" }),
 *         }),
 *         output: new AudioOutput({
 *           format: new PCMAudioFormat({ rate: 24000 }),
 *           voice: "Sarah",
 *           model: "inworld-tts-2",
 *         }),
 *       }),
 *     }),
 *   }),
 * });
 * ```
 */
export class InworldRealtimeLLMService extends LLMService<RealtimeAdapter> {
  static Settings = InworldRealtimeLLMSettings;
  declare protected _settings: InworldRealtimeLLMSettings;

  static override adapterClass: LLMAdapterClass | null =
    InworldRealtimeLLMAdapter as unknown as LLMAdapterClass;

  // Target ~60ms audio chunks when sending to Inworld (16-bit mono).
  static _AUDIO_CHUNK_TARGET_MS = 60;

  apiKey: string;
  baseUrl: string;
  protected _authType: "basic" | "bearer";

  protected _audioInputPaused: boolean;
  protected _audioBuffer: Uint8Array = new Uint8Array(0);
  protected _audioSendLogged = false;
  protected _interimTranscriptionText = "";
  protected _websocket: WebsocketClientConnection | null = null;
  protected _receiveTask: Task<unknown> | null = null;
  protected _context: LLMContext | null = null;
  protected _lastContextMessageCount = 0;

  protected _inputSampleRate: number | undefined = undefined;
  protected _outputSampleRate: number | undefined = undefined;

  protected _llmNeedsConversationSetup = true;

  protected _disconnecting = false;
  protected _apiSessionReady = false;
  protected _runLlmWhenApiSessionReady = false;

  protected _currentAssistantResponse: events.ConversationItem | null = null;
  protected _currentAudioResponse: CurrentAudioResponse | null = null;
  protected _serverVadHandledTurn = false;

  protected _messagesAddedManually = new Map<string, boolean>();
  protected _pendingFunctionCalls = new Map<string, events.ConversationItem>();
  protected _completedToolCalls = new Set<string>();
  protected _asyncToolWarningLogged = false;
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

  /**
   * Initialize the Inworld Realtime LLM service.
   *
   * @param options.apiKey Inworld API key for authentication.
   * @param options.llmModel LLM model to use (e.g. "openai/gpt-4.1-mini").
   * @param options.voice Voice ID for TTS output (e.g. "Sarah", "Clive").
   * @param options.ttsModel TTS model to use (e.g. "inworld-tts-2").
   * @param options.sttModel STT model for input transcription.
   * @param options.baseUrl WebSocket base URL for the realtime API.
   * @param options.authType "basic" (server-side API key) or "bearer"
   *   (client-side JWT).
   * @param options.settings Full settings for fine-grained control.
   * @param options.startAudioPaused Whether to start with audio input paused.
   *   Other options are passed to the parent LLMService.
   */
  constructor(options: InworldRealtimeLLMServiceOptions) {
    const cls = new.target as typeof InworldRealtimeLLMService;
    const baseUrl = options.baseUrl ?? "wss://api.inworld.ai/api/v1/realtime/session";

    const defaultModel = options.llmModel || "openai/gpt-4.1-mini";
    const defaultVoice = options.voice || "Clive";
    const defaultTtsModel = options.ttsModel || "inworld-tts-2";
    const defaultSttModel = options.sttModel || "inworld/inworld-stt-1";

    const defaultSettings = new cls.Settings({
      model: defaultModel,
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
        model: defaultModel,
        outputModalities: ["audio", "text"],
        audio: new events.AudioConfiguration({
          input: new events.AudioInput({
            format: new events.PCMAudioFormat({ rate: 24000 }),
            transcription: new events.InputTranscription({ model: defaultSttModel }),
            turnDetection: new events.TurnDetection({
              type: "semantic_vad",
              eagerness: "low",
              createResponse: true,
              interruptResponse: true,
            }),
          }),
          output: new events.AudioOutput({
            format: new events.PCMAudioFormat({ rate: 24000 }),
            model: defaultTtsModel,
            voice: defaultVoice,
          }),
        }),
      }),
    });

    cls.Settings._syncTopLevelToSp(defaultSettings);

    if (options.settings !== null && options.settings !== undefined) {
      defaultSettings.applyUpdate(options.settings);
    }

    super({ ...options, settings: defaultSettings });

    this.apiKey = options.apiKey;
    this.baseUrl = baseUrl;
    this._authType = options.authType ?? "basic";

    this._audioInputPaused = options.startAudioPaused ?? false;

    this._registerEventHandler("on_conversation_item_created");
    this._registerEventHandler("on_conversation_item_updated");
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
   * Get the output sample rate.
   *
   * @returns Output sample rate in Hz, defaulting to 24000.
   */
  protected _getOutputSampleRate(): number {
    const rate = this._getConfiguredSampleRate("output");
    if (rate !== null) {
      return rate;
    }
    return this._outputSampleRate ?? 24000;
  }

  /** Whether server-side turn detection is disabled (manual mode). */
  protected _isManualTurnDetection(): boolean {
    const sessionProperties = assertGiven(this._settings.sessionProperties);
    const input = sessionProperties.audio?.input;
    return Boolean(input && input.turnDetection === null);
  }

  /** Decline the frontend role: the model calls a tool again when told a result beside it. */
  override llmWithBackendRoleObjection(role: LLMWithBackendRole): string | null {
    if (role === "frontend") {
      return (
        "InworldRealtimeLLMService cannot be an LLMWithBackend frontend: given a " +
        "message beside an open tool call, its model calls the tool again instead of " +
        "taking the message in"
      );
    }
    return null;
  }

  /**
   * Intermediate results don't reach the model here.
   *
   * The API takes one output per function call, and the model behind it does
   * not act on a result put in beside the call: given one it calls the tool
   * again rather than telling the user about it. This is the same model that
   * makes `cancelOnInterruption: false` unreliable here.
   */
  override get acceptsIntermediateFunctionCallResults(): boolean {
    return false;
  }

  /** Realtime service; recommends external turn strategies when server-side VAD is active. */
  override serviceMetadataFrame(): LLMServiceMetadataFrame {
    // In manual mode the server doesn't emit VAD events, so there are no turn frames.
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
   * Server-side VAD handles response cancellation and buffer cleanup
   * automatically; in manual mode the client must send the cancel and clear
   * events explicitly.
   */
  protected async _handleInterruption(): Promise<void> {
    if (this._isManualTurnDetection()) {
      await this.sendClientEvent(new events.InputAudioBufferClearEvent());
      await this.sendClientEvent(new events.ResponseCancelEvent());
    }
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

  /**
   * Handle user stopped speaking event.
   *
   * Server-side VAD handles commit and response creation automatically; in
   * manual mode the client must send them explicitly. Metrics are started in
   * `_handleEvtSpeechStopped` in the server-VAD path.
   */
  protected async _handleUserStoppedSpeaking(_frame: UserStoppedSpeakingFrame): Promise<void> {
    if (this._isManualTurnDetection()) {
      await this.startTtfbMetrics();
      await this.startProcessingMetrics();
      await this.sendClientEvent(new events.InputAudioBufferCommitEvent());
      await this.sendClientEvent(new events.ResponseCreateEvent());
    }
  }

  /** Handle bot stopped speaking event. */
  protected async _handleBotStoppedSpeaking(): Promise<void> {
    this._currentAudioResponse = null;
  }

  /** Truncates the current audio response (best-effort cleanup). */
  protected async _truncateCurrentAudioResponse(): Promise<void> {
    this._currentAudioResponse = null;
  }

  //
  // Standard AIService frame handling
  //

  /**
   * Ensure `sessionProperties.audio` has input and output configs.
   *
   * Preserves Inworld-specific fields (turnDetection, voice, model) and syncs
   * the PCM format sample rates with the transport's actual rates so Inworld
   * knows the correct input/output sample rates. The G.711 formats are fixed
   * at 8000 Hz and carry no rate to sync.
   *
   * @param inputSampleRate Sample rate for audio input (Hz).
   * @param outputSampleRate Sample rate for audio output (Hz).
   */
  protected _ensureAudioConfig(inputSampleRate: number, outputSampleRate: number): void {
    this._inputSampleRate = inputSampleRate;
    this._outputSampleRate = outputSampleRate;
    const props = assertGiven(this._settings.sessionProperties);
    if (!props.audio) {
      props.audio = new events.AudioConfiguration();
    }
    if (!props.audio.input) {
      props.audio.input = new events.AudioInput();
    }
    if (!props.audio.output) {
      props.audio.output = new events.AudioOutput();
    }
    if (!props.audio.input.format) {
      props.audio.input.format = new events.PCMAudioFormat();
    }
    if (!props.audio.output.format) {
      props.audio.output.format = new events.PCMAudioFormat();
    }
    if (props.audio.input.format instanceof events.PCMAudioFormat) {
      props.audio.input.format.rate = inputSampleRate as events.SUPPORTED_SAMPLE_RATES;
    }
    if (props.audio.output.format instanceof events.PCMAudioFormat) {
      props.audio.output.format.rate = outputSampleRate as events.SUPPORTED_SAMPLE_RATES;
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
      logger.warning(
        `${this}: Inworld Realtime does not act on a tool's intermediate results; ` +
          `dropping the one for ${frame.functionName}`,
      );
      return;
    }
    if (this._openFunctionCalls.has(frame.toolCallId)) {
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

  /** Put text into the conversation, for a result the API can no longer take as an output. */
  protected async _sendMessageItem(text: string): Promise<void> {
    const item = new events.ConversationItem({
      type: "message",
      role: "user",
      content: [new events.ItemContent({ type: "input_text", text })],
    });
    await this.sendClientEvent(new events.ConversationItemCreateEvent({ item }));
  }

  /** Handle LLM context updates. */
  protected async _handleContext(context: LLMContext, direction: FrameDirection): Promise<void> {
    if (!this._context) {
      this._context = context;
      this._lastContextMessageCount = context.getMessages().length;
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

      // Check for new user messages (e.g. from text input).
      // The context is a shared mutable object, so we track the last
      // known message count to detect new additions.
      const messages = this._context.getMessages();
      const currentCount = messages.length;
      if (currentCount > this._lastContextMessageCount) {
        const newMessages = messages.slice(this._lastContextMessageCount);
        const lastMsg = messages[messages.length - 1];
        this._lastContextMessageCount = currentCount;

        // LLMSpecificMessages are opaque provider-specific payloads, not
        // standard user messages — skip them.
        if (lastMsg instanceof LLMSpecificMessage) {
          return;
        }
        const last = lastMsg as unknown as Record<string, unknown>;

        if (last.role !== "user") {
          // A tool result or any other message the aggregator wrote.
          // Only a user message needs sending, and only a user message
          // settles the server-VAD turn below.
          return;
        }

        // When server-side VAD handled this turn, the server already
        // has the user's audio and auto-created a response. Skip the
        // corresponding context message, but do not consume this marker
        // for assistant/tool updates that can arrive before the deferred
        // realtime transcript.
        const serverUserMessageAdded = newMessages.some(
          (message) =>
            !(message instanceof LLMSpecificMessage) &&
            (message as unknown as Record<string, unknown>).role === "user",
        );
        if (this._serverVadHandledTurn && serverUserMessageAdded) {
          this._serverVadHandledTurn = false;
          return;
        }

        let content = (last.content ?? "") as string | Record<string, unknown>[];
        if (Array.isArray(content)) {
          content = content
            .filter((c) => c.type === "text")
            .map((c) => (c.text as string | undefined) ?? "")
            .join(" ");
        }
        if (content) {
          const item = new events.ConversationItem({
            role: "user",
            type: "message",
            content: [new events.ItemContent({ type: "input_text", text: content })],
          });
          await this.sendClientEvent(new events.ConversationItemCreateEvent({ item }));
          await this.startProcessingMetrics();
          await this.startTtfbMetrics();
          await this.sendClientEvent(new events.ResponseCreateEvent());
        }
      }
    }
  }

  /** Handle appending messages to the context (not yet supported). */
  protected async _handleMessagesAppend(_frame: LLMMessagesAppendFrame): Promise<void> {
    logger.warning(`${this}: LLMMessagesAppendFrame is not yet supported by Inworld Realtime`);
  }

  //
  // WebSocket communication
  //

  /**
   * Send a client event to the Inworld Realtime API.
   *
   * @param event The client event to send.
   */
  async sendClientEvent(event: events.ClientEvent): Promise<void> {
    const message = event.modelDump({ excludeNone: true, byAlias: true });
    if (event instanceof events.SessionUpdateEvent) {
      logger.debug(`${this} sending session.update: ${pyJsonDumps(message)}`);
    }
    await this._wsSend(message);
  }

  /** Establish WebSocket connection to Inworld. */
  protected async _connect(): Promise<void> {
    try {
      if (this._websocket) {
        return;
      }

      const authHeader =
        this._authType === "bearer" ? `Bearer ${this.apiKey}` : `Basic ${this.apiKey}`;

      // Inworld requires key and protocol query parameters
      const sessionKey = `pipecat-realtime-${crypto.randomUUID().replaceAll("-", "")}`;
      const params = new URLSearchParams({ key: sessionKey, protocol: "realtime" }).toString();
      const separator = this.baseUrl.includes("?") ? "&" : "?";
      const uri = `${this.baseUrl}${separator}${params}`;

      this._websocket = await websocketConnect(uri, {
        additionalHeaders: {
          Authorization: authHeader,
        },
      });
      this._receiveTask = this.createTask(
        () => this._receiveTaskHandler(),
        "_receive_task_handler",
      );
    } catch (e) {
      rethrowIfCancelled(e);
      await this.pushError(`Error connecting to Inworld: ${errorMessage(e)}`, { exception: e });
      this._websocket = null;
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
      // A new session knows none of the old call ids, and no response is
      // running in it.
      this._openFunctionCalls = new Set();
      this._responseActive = false;
      this._responseCreateOwed = false;
      this._asyncToolWarningLogged = false;
      this._audioBuffer = new Uint8Array(0);
      this._interimTranscriptionText = "";
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
    const inputRate = this._getConfiguredSampleRate("input");
    const outputRate = this._getConfiguredSampleRate("output");

    const changed = await super._updateSettings(delta);

    if ("sessionProperties" in changed && inputRate && outputRate) {
      this._ensureAudioConfig(inputRate, outputRate);
    }

    const handled = new Set(["sessionProperties", "systemInstruction", "model", "temperature"]);
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
      settings.tools = llmInvocationParams.tools as events.InworldTool[];
    } else {
      // No context yet: the init-provided tools; built-in tools ride along.
      settings.tools = adapter.fromStandardTools(settings.tools) as events.InworldTool[];
    }

    const providerData: Record<string, unknown> = { ...(settings.providerData ?? {}) };
    const metadata: Record<string, unknown> = {
      ...((providerData.metadata as Record<string, unknown> | null | undefined) ?? {}),
    };
    metadata.sdk = "pipecat-realtime";
    providerData.metadata = metadata;
    // Set to false because Pipecat creates a tool response from client
    providerData.auto_tool_response = false;
    settings.providerData = providerData;

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

    for await (const data of this._websocket) {
      const message = typeof data === "string" ? data : new TextDecoder().decode(data);
      let eventType: unknown;
      try {
        const raw = pyJsonLoads(message) as Record<string, unknown>;
        eventType = raw.type ?? "";
      } catch (e) {
        rethrowIfCancelled(e);
        logger.warning(`Failed to decode server message: ${message.slice(0, 200)}`);
        continue;
      }

      let evt: any;
      try {
        evt = events.parseServerEvent(message);
      } catch (e) {
        rethrowIfCancelled(e);
        logger.warning(`Failed to parse server event: ${errorMessage(e)}`);
        continue;
      }

      // Unrecognized event type (e.g. newer realtime server events without a
      // model, like response.output_text.done). Benign — log quietly and skip.
      if (evt === null) {
        logger.debug(`${this} ignoring unhandled server event: ${eventType}`);
        continue;
      }

      if (evt.type === "ping") {
        // pass
      } else if (evt.type === "session.created") {
        await this._handleEvtSessionCreated(evt);
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
      } else if (evt.type === "conversation.item.input_audio_transcription.delta") {
        await this._handleEvtInputAudioTranscriptionDelta(evt);
      } else if (evt.type === "conversation.item.input_audio_transcription.completed") {
        await this._handleEvtInputAudioTranscriptionCompleted(evt);
      } else if (evt.type === "response.done") {
        await this._handleEvtResponseDone(evt);
      } else if (evt.type === "input_audio_buffer.speech_started") {
        await this._handleEvtSpeechStarted(evt);
      } else if (evt.type === "input_audio_buffer.speech_stopped") {
        await this._handleEvtSpeechStopped(evt);
      } else if (evt.type === "response.output_audio_transcript.delta") {
        await this._handleEvtAudioTranscriptDelta(evt);
      } else if (evt.type === "response.function_call_arguments.delta") {
        // pass
      } else if (evt.type === "response.function_call_arguments.done") {
        await this._handleEvtFunctionCallArgumentsDone(evt);
      } else if (evt.type === "error") {
        if (_NON_FATAL_ERROR_CODES.has(evt.error.code)) {
          logger.debug(`${this} ${evt.error.message}`);
        } else {
          await this._handleEvtError(evt);
          return;
        }
      } else {
        logger.debug(`${this} received known but undispatched server event: ${evt.type}`);
      }
    }
  }

  /** Handle session.created event — first event after connecting. */
  protected async _handleEvtSessionCreated(_evt: events.SessionCreatedEvent): Promise<void> {
    await this._sendSessionUpdate();
  }

  /** Handle session.updated event. */
  protected async _handleEvtSessionUpdated(_evt: events.SessionUpdatedEvent): Promise<void> {
    this._apiSessionReady = true;
    if (this._runLlmWhenApiSessionReady) {
      this._runLlmWhenApiSessionReady = false;
      await this._createResponse();
    }
  }

  /** Handle audio delta event — streaming audio from assistant. */
  protected async _handleEvtAudioDelta(evt: events.ResponseAudioDelta): Promise<void> {
    await this.stopTtfbMetrics();

    if (this._currentAudioResponse && this._currentAudioResponse.itemId !== evt.itemId) {
      logger.warning(
        "Received a new audio delta for an already completed audio response before receiving the BotStoppedSpeakingFrame.",
      );
      logger.debug("Forcing previous audio response to None");
      this._currentAudioResponse = null;
    }

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
      const callId = evt.item.callId as string;
      if (!this._pendingFunctionCalls.has(callId)) {
        this._pendingFunctionCalls.set(callId, evt.item);
      } else {
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
    evt: events.ConversationItemInputAudioTranscriptionCompleted,
  ): Promise<void> {
    this._interimTranscriptionText = "";
    await this._callEventHandler("on_conversation_item_updated", evt.itemId, null);

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

      const functionCallItem = this._pendingFunctionCalls.get(evt.callId);
      if (functionCallItem) {
        this._pendingFunctionCalls.delete(evt.callId);

        // The API is waiting on this call now, so its id can be answered
        // with a function_call_output.
        this._openFunctionCalls.add(evt.callId);

        // Inworld may omit `name` from the done event — resolve from
        // the tracked function call item.
        const functionName = evt.name || functionCallItem.name;
        if (!functionName) {
          logger.warning(`No function name for call_id: ${evt.callId}`);
          return;
        }

        const functionCalls = [
          new FunctionCallFromLLM({
            context: this._context,
            toolCallId: evt.callId,
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

  /** Note the response, which takes in everything delivered before it. */
  protected async _handleEvtResponseCreated(_evt: events.ResponseCreated): Promise<void> {
    this._responseActive = true;
    this._resultsAwaitingResponse = false;
  }

  /** Handle speech started event from server-side VAD. */
  protected async _handleEvtSpeechStarted(
    _evt: events.InputAudioBufferSpeechStarted,
  ): Promise<void> {
    if (this._isManualTurnDetection()) {
      // In manual mode, the client is responsible for broadcasting user turn frames
      return;
    }

    this._responseCreateOwed = false;
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

    // Mark that the server is handling this turn (and will auto-create a
    // response when createResponse is true). This prevents _handleContext
    // from sending a duplicate ResponseCreateEvent when the user aggregator
    // appends the transcribed text to the context.
    this._serverVadHandledTurn = true;
    await this.startTtfbMetrics();
    await this.startProcessingMetrics();
    await this.broadcastFrame(ProposedUserStoppedSpeakingFrame);
  }

  /** Handle fatal error event. */
  protected async _handleEvtError(evt: events.ErrorEvent): Promise<void> {
    await this.pushError(`Inworld Realtime Error: ${evt.error.message}`);
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
    logger.debug("Resetting Inworld conversation");
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

      const llmInvocationParams = await adapter.getLlmInvocationParams(context, {
        systemInstruction: assertGiven(this._settings.systemInstruction),
      });
      const messages = llmInvocationParams.messages;

      for (const item of messages) {
        const evt = new events.ConversationItemCreateEvent({ item });
        this._messagesAddedManually.set(evt.item.id, true);
        await this.sendClientEvent(evt);
      }

      await this._sendSessionUpdate();
      this._llmNeedsConversationSetup = false;
    }

    logger.debug("Creating Inworld response");

    await this.startProcessingMetrics();
    await this.startTtfbMetrics();

    const outputModalities = assertGiven(this._settings.sessionProperties).outputModalities;
    const modalities: events.Modality[] =
      outputModalities && outputModalities.length > 0 ? outputModalities : ["text", "audio"];
    await this.sendClientEvent(
      new events.ResponseCreateEvent({
        response: new events.ResponseProperties({ modalities }),
      }),
    );
  }

  /** Process completed function calls and send results to the service. */
  protected async _processCompletedFunctionCalls(sendNewResults: boolean): Promise<void> {
    if (this._context === null) {
      throw new Error("AssertionError: _context is None");
    }

    // If the user registered a function with cancelOnInterruption: false,
    // the aggregator emits async-tool-style messages into the context. As
    // of this writing, Inworld Realtime doesn't appear to handle the
    // resulting delayed tool result reliably — the routing code below
    // is best-effort. Surface a one-time warning so users see they're not
    // getting what they expect.
    if (!this._asyncToolWarningLogged) {
      for (const message of this._context.getMessages()) {
        if (message instanceof LLMSpecificMessage) {
          continue;
        }
        if (asyncToolMessages.parseMessage(message) !== null) {
          logger.error(
            `${this}: cancel_on_interruption=False is not reliably ` +
              "supported by Inworld Realtime as of this writing. " +
              "Use cancel_on_interruption=True (the default), or " +
              "consider another LLM service if your tool needs the " +
              "async semantics.",
          );
          await this.pushError(
            "cancel_on_interruption=False is not reliably supported " +
              "by Inworld Realtime as of this writing.",
          );
          this._asyncToolWarningLogged = true;
          break;
        }
      }
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
      if (msg.role === "tool" && msg.content !== "IN_PROGRESS") {
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

    // If we reported any new tool call results to the service, trigger
    // another response
  }

  /** Send user audio to Inworld, buffered to ~60ms chunks. */
  protected async _sendUserAudio(frame: InputAudioRawFrame): Promise<void> {
    if (this._llmNeedsConversationSetup) {
      return;
    }

    if (!this._audioSendLogged) {
      logger.debug(
        `Streaming audio to Inworld: ${frame.sampleRate}Hz, ` +
          `${frame.numChannels}ch, ${frame.audio.length}B/frame`,
      );
      this._audioSendLogged = true;
    }

    // Compute chunk size from actual sample rate (16-bit mono = 2 bytes/sample)
    const chunkBytes = Math.trunc(
      (frame.sampleRate * 2 * InworldRealtimeLLMService._AUDIO_CHUNK_TARGET_MS) / 1000,
    );

    // Accumulate and send in chunks
    this._audioBuffer = concatBytes(this._audioBuffer, frame.audio);
    while (this._audioBuffer.length >= chunkBytes) {
      const chunk = this._audioBuffer.slice(0, chunkBytes);
      this._audioBuffer = this._audioBuffer.slice(chunkBytes);
      const payload = bytesToBase64(chunk);
      await this.sendClientEvent(new events.InputAudioBufferAppendEvent({ audio: payload }));
    }
  }

  /** Send a tool call result to Inworld. */
  protected async _sendToolResult(toolCallId: string, result: string | null): Promise<void> {
    this._openFunctionCalls.delete(toolCallId);
    const item = new events.ConversationItem({
      type: "function_call_output",
      callId: toolCallId,
      output: result,
    });
    await this.sendClientEvent(new events.ConversationItemCreateEvent({ item }));
  }
}
