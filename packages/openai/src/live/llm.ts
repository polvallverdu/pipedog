// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/services/openai/live/llm.py

/**
 * OpenAI Live LLM service: full-duplex speech-to-speech over WebSocket.
 *
 * Porting notes:
 * - The WebSocket is opened with `websocketConnect` from core, which sends
 *   the `Authorization` header on Bun, Node and Deno. Runtimes whose
 *   `WebSocket` can't send headers (Cloudflare Workers) pass a
 *   `webSocketFactory` (an addition to the upstream options).
 * - `parse_server_event` raises only `ValueError`, which the receive loop
 *   skips; here any (non-cancellation) error from `parseServerEvent` is
 *   treated as that.
 * - `OpenAIResponsesReasoningConfig` is sent as its set fields (`effort`,
 *   `summary`, `mode`), which is what upstream's `model_dump(exclude_none=True)`
 *   produces.
 */

import {
  CancelledError,
  currentTask,
  Event,
  Lock,
  rethrowIfCancelled,
  sleep,
  type Task,
  TimeoutError,
  timeout,
  waitFor,
} from "@pipedog/asyncio";
import type { BaseLLMAdapter } from "@pipedog/core/adapters/base_llm_adapter";
import { OPENAI_NOT_GIVEN } from "@pipedog/core/adapters/services/open_ai_adapter";
import { createStreamResampler } from "@pipedog/core/audio/utils";
import {
  type CancelFrame,
  type EndFrame,
  type Frame,
  FunctionCallCancelFrame,
  FunctionCallFromLLM,
  FunctionCallResultFrame,
  InputAudioRawFrame,
  InterimTranscriptionFrame,
  LLMContextFrame,
  LLMFullResponseEndFrame,
  LLMFullResponseStartFrame,
  LLMServiceMetadataFrame,
  LLMSetToolsFrame,
  LLMTextFrame,
  ProposedUserStartedSpeakingFrame,
  ProposedUserStoppedSpeakingFrame,
  SpeechOutputAudioRawFrame,
  TextType,
  TranscriptionFrame,
  TTSStartedFrame,
  TTSStoppedFrame,
  TTSTextFrame,
} from "@pipedog/core/frames/frames";
import { LLMTokenUsage } from "@pipedog/core/metrics/metrics";
import type {
  LLMContext,
  LLMStandardMessage,
} from "@pipedog/core/processors/aggregators/llm_context";
import { FrameDirection, type FrameProcessorSetup } from "@pipedog/core/processors/frame_processor";
import {
  LLMService,
  type LLMServiceOptions,
  type LLMWithBackendRole,
} from "@pipedog/core/services/llm_service";
import { LLMSettings, type LLMSettingsOptions } from "@pipedog/core/services/settings";
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
import {
  _BackendSession,
  _renderTranscriptRequest,
  BackendError,
  BackendIdle,
  BackendLLMWorker,
  BackendOutput,
  BackendToolCall,
} from "@pipedog/core/workers/llm/backend_llm_worker";
import { OPENAI_SAMPLE_RATE } from "../_constants.ts";
import {
  OpenAILiveLLMAdapter,
  type OpenAILiveLLMInvocationParams,
} from "../open_ai_live_adapter.ts";
import {
  type OpenAIResponsesLLMSettings,
  OpenAIResponsesReasoningConfig,
} from "../responses/llm.ts";
import * as events from "./events.ts";

export const DEFAULT_MODEL = "gpt-live-1";

// Quiet time that ends a speaker's turn. The API emits transcript fragments on
// 200 ms frame boundaries, so this has to clear ordinary gaps within speech.
export const TURN_GAP_SECS = 0.8;

// The server drains delegation and output work for at most 10 seconds after
// `session.close` before emitting `session.closed`.
export const SESSION_CLOSE_TIMEOUT_SECS = 10.0;

/** How long a delegation waits for the session with the backend to open. */
export const BACKEND_ATTACH_TIMEOUT_SECS = 5.0;

// Each context append takes one text part of at most 500 tokens. Chunks are
// measured against a lower budget, since what counts them is an estimate.
export const MAX_CONTEXT_APPEND_TOKENS = 450;

// Correlation key for a wrapped event whose envelope carries no delegation id.
const _UNCORRELATED_DELEGATION = "uncorrelated";

function errorMessage(e: unknown): string {
  // Python's `str(TimeoutError())` is empty; asyncio's timeouts raise it bare.
  if (e instanceof TimeoutError && e.message === "Timed out") return "";
  return e instanceof Error ? e.message : String(e);
}

/** Python's `repr()` of a JSON-like value, for log lines. */
function pyRepr(value: unknown): string {
  if (value === null || value === undefined) return "None";
  if (value === true) return "True";
  if (value === false) return "False";
  if (typeof value === "string") return reprStr(value);
  if (Array.isArray(value)) return `[${value.map(pyRepr).join(", ")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    return `{${entries.map(([k, v]) => `${reprStr(k)}: ${pyRepr(v)}`).join(", ")}}`;
  }
  return String(value);
}

/** A pydantic model's `str()`: its fields as `name=repr(value)`, space-separated. */
function pydanticStr(model: { modelDump(): Record<string, unknown> }): string {
  return Object.entries(model.modelDump())
    .map(([k, v]) => `${k}=${pyRepr(v)}`)
    .join(" ");
}

/** Python truthiness, for values from JSON or function results. */
function pyTruthy(value: unknown): boolean {
  if (value === null || value === undefined || value === false) return false;
  if (value === 0 || value === "" || Number.isNaN(value)) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (value instanceof Map || value instanceof Set) return value.size > 0;
  if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.keys(value).length > 0;
  }
  return true;
}

/** Python's `repr()` of a string, for log lines. */
function reprStr(s: string): string {
  const quote = s.includes("'") && !s.includes('"') ? '"' : "'";
  const body = s
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t")
    .replaceAll(quote, `\\${quote}`);
  return `${quote}${body}${quote}`;
}

/** A copy of a JSON-like value with object keys sorted (`json.dumps(sort_keys=True)`). */
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (typeof value === "object" && value !== null) {
    const proto = Object.getPrototypeOf(value);
    if (proto === Object.prototype || proto === null) {
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(value).sort()) {
        out[key] = sortKeys((value as Record<string, unknown>)[key]);
      }
      return out;
    }
  }
  return value;
}

export interface OpenAILiveLLMSettingsOptions extends LLMSettingsOptions {
  /**
   * Output voice name (for example `marin` or `cedar`). `null` leaves the
   * choice to the API. Cannot be changed once the session has started.
   */
  voice?: string | null | NotGiven;
  /**
   * Whether the API keeps the session, making it available for 30 days as a
   * stereo recording from `GET /v1/live/sessions/{id}/content` and as a
   * source a later session can fork from. `false` by default at the API, and
   * requires a project whose data policy permits persistence. Cannot be
   * changed once the session has started.
   */
  store?: boolean | null | NotGiven;
}

/**
 * Settings for OpenAILiveLLMService.
 *
 * - `voice`: output voice name (for example `marin` or `cedar`). `null`
 *   leaves the choice to the API. Cannot be changed once the session has
 *   started.
 * - `store`: whether the API keeps the session, making it available for 30
 *   days as a stereo recording from `GET /v1/live/sessions/{id}/content` and
 *   as a source a later session can fork from. `false` by default at the API,
 *   and requires a project whose data policy permits persistence. Cannot be
 *   changed once the session has started.
 */
export class OpenAILiveLLMSettings extends LLMSettings {
  voice: string | null | NotGiven = NOT_GIVEN;
  store: boolean | null | NotGiven = NOT_GIVEN;

  constructor(options: OpenAILiveLLMSettingsOptions = {}) {
    super(options);
    this._assignOptions(options);
  }
}

/**
 * One speaker's in-progress turn, assembled from timed transcript fragments.
 *
 * - `gapSecs`: quiet time that ends the turn.
 * - `text`: fragments accumulated so far.
 * - `open`: whether a turn is currently open.
 * - `timer`: the task that closes the turn once `gapSecs` elapses.
 * - `lock`: held while the turn opens or closes. The timer runs in its own
 *   task, so this is what keeps one turn's end frames from landing among the
 *   next turn's start frames.
 */
export class _TurnGrouper {
  gapSecs: number;
  text = "";
  open = false;
  timer: Task<unknown> | null = null;
  lock: Lock = new Lock();

  constructor(options: { gapSecs: number }) {
    this.gapSecs = options.gapSecs;
  }
}

/**
 * A client delegation in progress: what to correlate the backend's outputs with.
 *
 * - `id`: the delegation's id, which the appends carry.
 * - `answered`: whether the backend has sent a spoken output for it yet; its
 *   notes do not count.
 * - `timeoutTask`: the task that abandons it if the backend takes too long.
 */
export class _LiveDelegation {
  id: string;
  answered = false;
  timeoutTask: Task<unknown> | null = null;

  constructor(options: { id: string }) {
    this.id = options.id;
  }
}

export interface ResponsesDelegationOptions {
  /**
   * Request settings for the backend model — the same object
   * `OpenAIResponsesLLMService` takes. `model` is required.
   */
  settings: OpenAIResponsesLLMSettings;
  /**
   * Responses API service tier for delegated requests (`auto`, `default`,
   * `flex` or `priority`).
   */
  serviceTier?: string | null;
}

/**
 * Responses delegation: OpenAI hosts the backend model the live model delegates to.
 *
 * Hosted tools run server-side; function calls are executed by this service
 * with the handlers registered for the tools in the pipeline's `LLMContext`
 * (which is also where the backend model's `tools` and `tool_choice` come
 * from).
 *
 * - `settings`: request settings for the backend model — the same object
 *   `OpenAIResponsesLLMService` takes. `model` is required.
 *   `systemInstruction` becomes the backend's `instructions`,
 *   `maxCompletionTokens` its `max_output_tokens`, `reasoning` is sent when
 *   configured (the server default applies otherwise) and `extra` is merged
 *   into the delegation configuration. Fields the Live API doesn't accept for
 *   a delegated model (`temperature`, `topP`, the penalties, `seed`, `topK`,
 *   `maxTokens`, and the user-turn-completion fields) are dropped with a
 *   warning.
 * - `serviceTier`: Responses API service tier for delegated requests
 *   (`auto`, `default`, `flex` or `priority`).
 */
export class ResponsesDelegation {
  settings: OpenAIResponsesLLMSettings;
  serviceTier: string | null;

  constructor(options: ResponsesDelegationOptions) {
    this.settings = options.settings;
    this.serviceTier = options.serviceTier ?? null;
  }
}

export interface ClientDelegationOptions {
  /**
   * The worker that runs delegated work — normally a `BackendLLMWorker`
   * wrapping any LLM service, or the name of one registered elsewhere.
   */
  backend: BackendLLMWorker | string;
  /** How long a delegation may take before it is abandoned. Defaults to 120. */
  timeoutSecs?: number;
}

/**
 * Client delegation: a Pipecat worker is the backend the live model delegates to.
 *
 * A delegation names no task: the live model signals only that it is handing
 * work over. Each one is put to the backend as a message carrying the
 * transcript fragments since the previous delegation, and the backend works
 * out the request from them. The service attaches to the backend for its
 * life and takes delegations one at a time: the next waits until the backend
 * reports it has nothing left to do, since they share one backend
 * conversation.
 *
 * What comes back is appended to the live session according to each output's
 * `prefersSpoken` flag: what it wants heard goes as commentary, for the model
 * to relay in its own words, and the rest as thinking — silent context it can
 * draw on if the conversation turns that way.
 *
 * - `backend`: the worker that runs delegated work — normally a
 *   `BackendLLMWorker` wrapping any LLM service, or the name of one
 *   registered elsewhere (in the app, or in another process on a shared
 *   bus). A worker given here is registered as a child of the pipeline worker
 *   at setup, so the pipeline must run under a `WorkerRunner`.
 * - `timeoutSecs`: how long a delegation may take before it is abandoned.
 */
export class ClientDelegation {
  backend: BackendLLMWorker | string;
  timeoutSecs: number;

  constructor(options: ClientDelegationOptions) {
    this.backend = options.backend;
    this.timeoutSecs = options.timeoutSecs ?? 120.0;
  }
}

/**
 * A delegated Responses run whose function calls we are collecting.
 *
 * - `callIds`: calls still awaiting an output.
 * - `hadCalls`: whether the response asked for any function call at all.
 * - `finished`: whether the response emitted all of its output items.
 */
export class _PendingResponse {
  callIds: Set<string> = new Set();
  hadCalls = false;
  finished = false;
}

export interface OpenAILiveLLMServiceOptions extends LLMServiceOptions {
  /** OpenAI project API key. */
  apiKey: string;
  /** WebSocket base URL of the Live API. */
  baseUrl?: string;
  /**
   * Runtime-updatable settings. `model`, `voice`, `store` and
   * `systemInstruction` are fixed once the session has started.
   */
  settings?: OpenAILiveLLMSettings | null;
  /**
   * Where the model's delegated work runs. `null` selects client delegation
   * with no backend configured.
   */
  delegation?: ResponsesDelegation | ClientDelegation | null;
  /**
   * Creates the underlying `WebSocket` (see `WebsocketConnectOptions`), for
   * runtimes whose `WebSocket` can't send the `Authorization` header.
   */
  webSocketFactory?: WebsocketConnectOptions["webSocketFactory"];
}

/**
 * OpenAI Live LLM service: full-duplex speech-to-speech over WebSocket.
 *
 * The live model (`gpt-live-1`) listens and speaks at the same time. It
 * decides on its own when to answer, when to stop talking when the user
 * speaks over it, and when to *delegate* work — search, reasoning, tool use —
 * to a backend text model while the conversation continues. In the
 * frontend/backend terms used throughout, the live model is the *frontend*
 * (the conversational model) and the delegated-to model is the *backend*.
 * There is no client-side turn detection or response triggering: the
 * pipeline streams audio in and plays audio out.
 *
 * Delegation modes, selected with `delegation`:
 *
 * - `ResponsesDelegation` — OpenAI hosts the backend (Responses API) model.
 *   Function calls it makes are executed here with the handlers registered
 *   for the pipeline context's tools; results go back to the API as soon as
 *   they are available.
 * - `ClientDelegation` — a `BackendLLMWorker` running any Pipecat LLM service
 *   is the backend. The model does not share its conversation with the
 *   backend, so the service ships the transcript turns since the previous
 *   delegation along with each request.
 * - `null` — client delegation mode with no backend configured; delegated
 *   requests are declined.
 *
 * Turn frames: the service proposes user turn boundaries from the API's
 * projected transcript turns, and the recommended
 * `new ExternalUserTurnStrategies({ enableInterruptions: false })` resolve
 * them into `UserStartedSpeakingFrame` / `UserStoppedSpeakingFrame` **without
 * broadcasting interruptions**: the model handles being talked over itself,
 * and a delegation keeps running when that happens (the model is expected to
 * disregard results the conversation has moved past). As a consequence every
 * tool behaves as `cancelOnInterruption: false`; use `cancellableByLlm: true`
 * for tools the model should be able to cancel on request.
 *
 * The context aggregators record both sides of the conversation from the
 * transcript frames. Unlike the Realtime services, this one is not flagged as
 * a realtime service for the aggregators: the service closes a user turn
 * itself once the speaker falls quiet and pushes its final transcript then,
 * so the user aggregator writes each user turn to the context as it ends —
 * before any tool calls it triggers — rather than when the assistant starts
 * to respond.
 *
 * The session starts on the first `LLMContextFrame` (typically queued as an
 * `LLMRunFrame`): the context's leading system message (or
 * `Settings.systemInstruction`) becomes the model's instructions and the
 * remaining text messages seed the session as prior conversation.
 *
 * Event handlers available:
 *
 * - on_session_started: called with the session resource once the session is
 *   ready for audio.
 * - on_delegation_created: called with the delegation item when the model
 *   delegates work.
 *
 * @example
 * const llm = new OpenAILiveLLMService({
 *   apiKey: process.env.OPENAI_API_KEY!,
 *   settings: new OpenAILiveLLMService.Settings({ systemInstruction: "..." }),
 *   delegation: new OpenAILiveLLMService.ResponsesDelegation({
 *     settings: new OpenAIResponsesLLMService.Settings({ model: "gpt-5.4-mini" }),
 *   }),
 * });
 */
export class OpenAILiveLLMService extends LLMService<OpenAILiveLLMAdapter & BaseLLMAdapter> {
  static Settings = OpenAILiveLLMSettings;
  static ResponsesDelegation = ResponsesDelegation;
  static ClientDelegation = ClientDelegation;
  declare protected _settings: OpenAILiveLLMSettings;

  static override adapterClass = OpenAILiveLLMAdapter;

  apiKey: string;
  baseUrl: string;
  protected _sessionModel: string;
  protected _delegation: ResponsesDelegation | ClientDelegation | null;
  protected _webSocketFactory: WebsocketConnectOptions["webSocketFactory"];

  protected _websocket: WebsocketClientConnection | null = null;
  protected _receiveTask: Task<unknown> | null = null;
  protected _disconnecting = false;

  protected _context: LLMContext | null = null;
  protected _needsSessionConfig = true;
  protected _sessionStarted = false;
  protected _sessionClosedEvent = new Event();
  protected _sentToolsSnapshot: string | null = null;
  // Whether a session has started on the current connection. Until one has,
  // an error indicates that the session failed to start. Unlike
  // _sessionStarted, this is not cleared on session close (which helps us
  // avoid treating errors during shutdown as session start failures). It is
  // cleared on disconnect, so the next connection is judged afresh.
  protected _sessionStartedOnConnection = false;

  protected _resampler = createStreamResampler();
  protected _warnedAudioDropped = false;

  // Turns assembled from transcript fragments, one per direction: in full
  // duplex the user and the model can be speaking at once.
  protected _userTurn = new _TurnGrouper({ gapSecs: TURN_GAP_SECS });
  protected _assistantTurn = new _TurnGrouper({ gapSecs: TURN_GAP_SECS });

  // A trailing developer message asking the model to open the conversation.
  protected _openingInstruction: string | null = null;

  // Responses delegation: calls awaiting an output, by call id, and the
  // responses they belong to, by response id.
  protected _openFunctionCalls = new Map<string, string>();
  protected _pendingResponses = new Map<string, _PendingResponse>();

  // Client delegation: the conversation not yet sent to the backend, whether
  // the backend has run before, the session with it, the delegation it is
  // working on and the ones waiting their turn.
  protected _transcriptFragments: { role: string; content: string }[] = [];
  protected _delegatedBefore = false;
  protected _backendSession: _BackendSession | null = null;
  protected _backendSessionTask: Task<unknown> | null = null;
  // Set while the session with the backend is open, so a delegation that
  // starts just after attaching waits for it.
  protected _backendAttached = new Event();
  protected _currentDelegation: _LiveDelegation | null = null;
  protected _queuedDelegations: [events.DelegationMetadata, string][] = [];

  /**
   * Initialize the OpenAI Live LLM service.
   *
   * @param options.apiKey OpenAI project API key.
   * @param options.baseUrl WebSocket base URL of the Live API.
   * @param options.settings Runtime-updatable settings. `model`, `voice`,
   *   `store` and `systemInstruction` are fixed once the session has started.
   * @param options.delegation Where the model's delegated work runs. `null`
   *   selects client delegation with no backend configured.
   *   Other options are passed to the parent LLMService.
   */
  constructor(options: OpenAILiveLLMServiceOptions) {
    const settingsClass = (new.target as typeof OpenAILiveLLMService).Settings;
    const defaultSettings = new settingsClass({
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
      voice: null,
      store: null,
    });
    if (options.settings !== undefined && options.settings !== null) {
      defaultSettings.applyUpdate(options.settings);
    }

    const delegation = options.delegation ?? null;
    if (delegation instanceof ResponsesDelegation) {
      const backendModel = delegation.settings.model;
      if (!isGiven(backendModel) || !backendModel) {
        throw new Error("ResponsesDelegation.settings.model is required");
      }
    }

    // The live model is fixed for the session's lifetime, so it is resolved
    // once, here.
    const sessionModel = assertGiven(defaultSettings.model);
    if (!sessionModel) {
      throw new Error("settings.model is required");
    }

    super({ ...options, settings: defaultSettings });

    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl ?? "wss://api.openai.com/v1/live/sessions";
    this._sessionModel = sessionModel;
    this._delegation = delegation;
    this._webSocketFactory = options.webSocketFactory ?? null;

    this._registerEventHandler("on_session_started");
    this._registerEventHandler("on_delegation_created");
  }

  /**
   * Check if the service can generate usage metrics.
   *
   * @returns True if metrics generation is supported.
   */
  override canGenerateMetrics(): boolean {
    return true;
  }

  /** The Live API takes one output per function call, so intermediate results are dropped. */
  override get acceptsIntermediateFunctionCallResults(): boolean {
    return false;
  }

  /**
   * Decline both roles: this service is a frontend with a backend of its own.
   *
   * @param role The role the service is being asked to take.
   * @returns The reason, naming what to use instead.
   */
  override llmWithBackendRoleObjection(role: LLMWithBackendRole): string | null {
    return (
      `${this.constructor.name} cannot be an LLMWithBackend ${role}: it is already a ` +
      "frontend with a backend of its own. Give it a delegation instead — " +
      "OpenAILiveLLMService.ClientDelegation for a backend worker, or " +
      "OpenAILiveLLMService.ResponsesDelegation for OpenAI's own."
    );
  }

  /**
   * Recommend external turn strategies, resolved from the API's projected turns.
   *
   * `isRealtimeService` is left off on purpose: the aggregators' realtime
   * mode defers the user-message write until the assistant responds, to
   * absorb late transcripts, and here that would place a delegation's tool
   * calls ahead of the user message that caused them.
   */
  override serviceMetadataFrame(): LLMServiceMetadataFrame {
    return new LLMServiceMetadataFrame({
      serviceName: this.name,
      userTurnStrategies: new ExternalUserTurnStrategies({ enableInterruptions: false }),
    });
  }

  //
  // lifecycle
  //

  /**
   * Set up the service, register the client-delegation backend, and connect.
   *
   * @param setup Configuration object containing setup parameters.
   */
  override async setup(setup: FrameProcessorSetup): Promise<void> {
    await super.setup(setup);
    if (this._delegation instanceof ClientDelegation) {
      if (this._delegation.backend instanceof BackendLLMWorker) {
        // A child of the pipeline worker: ended and cancelled with it.
        await this.pipelineWorker.addWorkers(this._delegation.backend);
      }
    }
    await this._connect();
  }

  /** Release resources at teardown. */
  override async cleanup(): Promise<void> {
    await super.cleanup();
    await this._disconnect();
    await this._detachBackend();
  }

  /**
   * Close the session gracefully and disconnect.
   *
   * @param frame The end frame triggering service shutdown.
   */
  override async stop(frame: EndFrame): Promise<void> {
    await super.stop(frame);
    await this._closeOpenTurns();
    await this._closeSession();
    await this._disconnect();
  }

  /**
   * Disconnect immediately.
   *
   * @param frame The cancel frame triggering service cancellation.
   */
  override async cancel(frame: CancelFrame): Promise<void> {
    await super.cancel(frame);
    await this._disconnect();
  }

  /**
   * Apply a settings delta.
   *
   * The API fixes the session's settings when it starts, so a change is
   * stored and reaches the API on the next session (see `resetConversation`).
   */
  protected override async _updateSettings(delta: LLMSettings): Promise<Record<string, unknown>> {
    const changed = await super._updateSettings(delta);
    this._warnUnhandledUpdatedSettings(changed);
    return changed;
  }

  /**
   * Start a new session seeded from the current context.
   *
   * The Live API only takes conversation history at session start, so
   * replacing the context (for example to restore a saved conversation) means
   * dropping the session and opening a new one configured from the context as
   * it is now. The old session is abandoned rather than closed gracefully: a
   * graceful close waits for its in-flight delegations to drain, and their
   * results belong to the conversation being replaced. Must not be called
   * from the receive task.
   */
  async resetConversation(): Promise<void> {
    logger.debug(`${this}: resetting conversation`);
    // Close out turns the old session was in the middle of, so the
    // aggregator records what was said and the response frames stay balanced
    // for the new session's turns.
    await this._closeOpenTurns();
    await this._disconnect();
    this._needsSessionConfig = true;
    await this._connect();
    if (this._context !== null) {
      await this._sendSessionConfig();
    }
  }

  //
  // frame processing
  //

  /**
   * Process incoming frames from the pipeline.
   *
   * @param frame The frame to process.
   * @param direction The direction of frame flow in the pipeline.
   */
  override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
    await super.processFrame(frame, direction);

    if (frame instanceof LLMContextFrame) {
      await this._handleContext(frame.context);
    } else if (frame instanceof InputAudioRawFrame) {
      await this._sendUserAudio(frame);
    } else if (frame instanceof LLMSetToolsFrame) {
      // Continuous session: no fresh context frame per turn, so sync the
      // registered tool handlers to the new tool set here (the base service
      // only does this on LLMContextFrame).
      this._syncRegisteredToolHandlers(frame.tools);
      await this._maybeSendToolsUpdate();
    }

    await this.pushFrame(frame, direction);
  }

  /**
   * Push a frame, delivering function call outcomes to the API on the way.
   *
   * Function call results and cancellations are broadcast by the base
   * service; the downstream copy is observed here and answered to the backend
   * model immediately. The frames continue to the assistant aggregator, which
   * records them in the context.
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
   * Take the context, configuring the session from the first one.
   *
   * A later context carries messages the aggregators recorded from this
   * session's own transcripts, tool results (delivered to the API as they are
   * produced, see `pushFrame`), or messages the app appended. None of it
   * reaches the API: user and assistant messages can't be told apart from the
   * transcript recordings. Newly appended system/developer messages can only
   * come from the app (the aggregators add user, assistant and tool messages,
   * and async-tool envelopes that `async_tool_messages.parseMessage`
   * identifies), so a future diff could forward those as
   * `session.context.append(channel="developer")` unambiguously.
   */
  protected async _handleContext(context: LLMContext): Promise<void> {
    this._context = context;
    if (this._needsSessionConfig) {
      await this._sendSessionConfig();
    }
  }

  //
  // session configuration
  //

  protected async _invocationParams(): Promise<OpenAILiveLLMInvocationParams> {
    if (this._context === null) throw new Error("assertion failed: no context");
    return await this.getLlmAdapter().getLlmInvocationParams(this._context, {
      systemInstruction: assertGiven(this._settings.systemInstruction),
    });
  }

  /** Send `session.start`, the first message on the socket. */
  protected async _sendSessionConfig(): Promise<void> {
    const params = await this._invocationParams();
    let history = params.input;
    // A trailing developer message is the app asking the bot to open the
    // conversation. The startup history is not the place for it: it is
    // delivered as commentary once the session starts, which is how the API
    // asks the model to speak first.
    this._openingInstruction = _trailingDeveloperText(history);
    if (this._openingInstruction) {
      history = history.slice(0, -1);
    }

    // The API fixes the model at session start, so it is read here: a change
    // applied mid-session takes effect on the next one.
    this._sessionModel = assertGiven(this._settings.model) || this._sessionModel;

    const voice = assertGiven(this._settings.voice);
    const session = new events.SessionConfig({
      model: this._sessionModel,
      instructions: params.instructions,
      audio: voice
        ? new events.AudioConfig({ output: new events.AudioOutputConfig({ voice }) })
        : null,
      delegation: this._delegationConfig(params.tools, params.tool_choice),
      input: history.length > 0 ? history : null,
      store: assertGiven(this._settings.store),
    });
    this._sentToolsSnapshot = OpenAILiveLLMService._toolsSnapshot(params);
    this._needsSessionConfig = false;
    logger.debug(
      `${this}: starting session with ${history.length} prior messages ` +
        `and ${session.delegation ? session.delegation.type : "client"} delegation`,
    );
    await this.sendClientEvent(new events.SessionStartEvent({ session }));
  }

  protected _delegationConfig(
    tools: Record<string, unknown>[],
    toolChoice: unknown,
  ): events.ClientDelegationConfig | events.ResponsesDelegationConfig {
    if (this._delegation instanceof ResponsesDelegation) {
      const responses = _responsesDelegationConfig(this._delegation);
      if (tools.length > 0) {
        responses.tools = tools;
      }
      if (toolChoice !== null && toolChoice !== undefined) {
        responses.tool_choice = toolChoice;
      }
      return new events.ResponsesDelegationConfig({ responses });
    }
    return new events.ClientDelegationConfig();
  }

  /** Send a sparse `session.update` when the backend model's tools changed. */
  protected async _maybeSendToolsUpdate(): Promise<void> {
    if (
      !(
        this._sessionStarted &&
        this._context !== null &&
        this._delegation instanceof ResponsesDelegation
      )
    ) {
      return;
    }
    const params = await this._invocationParams();
    const snapshot = OpenAILiveLLMService._toolsSnapshot(params);
    if (snapshot === this._sentToolsSnapshot) {
      return;
    }
    this._sentToolsSnapshot = snapshot;
    const responses: Record<string, unknown> = { tools: params.tools };
    if (params.tool_choice !== null && params.tool_choice !== undefined) {
      responses.tool_choice = params.tool_choice;
    }
    await this.sendClientEvent(
      new events.SessionUpdateEvent({
        session: new events.SessionUpdateConfig({
          delegation: new events.ResponsesDelegationConfig({ responses }),
        }),
      }),
    );
  }

  protected static _toolsSnapshot(params: OpenAILiveLLMInvocationParams): string {
    return pyJsonDumps(sortKeys({ tools: params.tools, tool_choice: params.tool_choice }), {
      default: String,
    });
  }

  //
  // websocket communication
  //

  /**
   * Send a client event to the Live API.
   *
   * @param event The client event to send.
   */
  async sendClientEvent(event: events.ClientEvent): Promise<void> {
    await this._wsSend(event.toPayload());
  }

  protected async _connect(): Promise<void> {
    await this._attachBackend();
    try {
      if (this._websocket) {
        return;
      }
      this._websocket = await websocketConnect(this.baseUrl, {
        additionalHeaders: { Authorization: `Bearer ${this.apiKey}` },
        webSocketFactory: this._webSocketFactory,
      });
      this._receiveTask = this.createTask(() => this._receiveTaskHandler(), "receiveTaskHandler");
    } catch (e) {
      rethrowIfCancelled(e);
      this._websocket = null;
      await this.pushError(`Error connecting: ${errorMessage(e)}`, {
        exception: e,
        forceTreatAsPermanent: true,
      });
    }
  }

  protected async _disconnect(): Promise<void> {
    // `_disconnecting` gates every outgoing event, so it is cleared in a
    // finally: a teardown that fails part-way still leaves the service able
    // to speak on its next session.
    try {
      this._disconnecting = true;
      this._sessionStarted = false;
      this._sessionStartedOnConnection = false;
      await this.stopAllMetrics();
      if (this._websocket) {
        await this._websocket.close();
        this._websocket = null;
      }
      if (this._receiveTask) {
        await this.cancelTask(this._receiveTask, 1.0);
        this._receiveTask = null;
      }
      await this._abandonDelegations();
      this._transcriptFragments.length = 0;
      this._delegatedBefore = false;
      this._sentToolsSnapshot = null;
      this._openFunctionCalls.clear();
      this._pendingResponses.clear();
    } catch (e) {
      rethrowIfCancelled(e);
      await this.pushError(`Error disconnecting: ${errorMessage(e)}`, { exception: e });
    } finally {
      this._disconnecting = false;
    }
  }

  /** Ask the server to shut down gracefully and wait for `session.closed`. */
  protected async _closeSession(): Promise<void> {
    if (!this._websocket || !this._sessionStarted) {
      return;
    }
    this._sessionClosedEvent.clear();
    await this.sendClientEvent(new events.SessionCloseEvent());
    try {
      await waitFor(() => this._sessionClosedEvent.wait(), SESSION_CLOSE_TIMEOUT_SECS);
    } catch (e) {
      if (!(e instanceof TimeoutError)) throw e;
      logger.warning(`${this}: timed out waiting for session.closed`);
    }
  }

  protected async _wsSend(message: Record<string, unknown>): Promise<void> {
    try {
      if (!this._disconnecting && this._websocket) {
        await this._websocket.send(pyJsonDumps(message));
      }
    } catch (e) {
      rethrowIfCancelled(e);
      if (this._disconnecting || !this._websocket) {
        return;
      }
      await this.pushError(`Error sending client event: ${errorMessage(e)}`, {
        exception: e,
        forceTreatAsPermanent: true,
      });
    }
  }

  //
  // inbound server event handling
  //

  protected async _receiveTaskHandler(): Promise<void> {
    const websocket = this._websocket;
    if (websocket === null) throw new Error("assertion failed: no websocket");
    try {
      for await (const message of websocket) {
        let evt: events.ServerEvent;
        try {
          evt = events.parseServerEvent(message);
        } catch (e) {
          rethrowIfCancelled(e);
          logger.warning(`${this}: ignoring unparseable server event: ${errorMessage(e)}`);
          continue;
        }
        await this._handleServerEvent(evt);
      }
    } catch (e) {
      if (!(e instanceof ConnectionClosed)) throw e;
      if (!this._disconnecting) {
        await this.pushError(`Connection closed: ${errorMessage(e)}`, {
          exception: e,
          forceTreatAsPermanent: true,
        });
      }
    }
  }

  protected async _handleServerEvent(evt: events.ServerEvent): Promise<void> {
    if (evt instanceof events.SessionStartedEvent) {
      await this._handleEvtSessionStarted(evt);
    } else if (evt instanceof events.OutputAudioDeltaEvent) {
      await this._handleEvtAudioDelta(evt);
    } else if (evt instanceof events.TranscriptDeltaEvent) {
      await this._handleEvtTranscriptDelta(evt);
    } else if (evt instanceof events.SessionDelegationCreatedEvent) {
      await this._handleEvtDelegationCreated(evt);
    } else if (evt instanceof events.ResponseEventEnvelope) {
      await this._handleEvtResponse(evt);
    } else if (evt instanceof events.SessionUsageUpdatedEvent) {
      await this._reportUsage(evt.usage);
    } else if (evt instanceof events.SessionClosedEvent) {
      await this._handleEvtSessionClosed(evt);
    } else if (evt instanceof events.ErrorEvent) {
      await this._handleEvtError(evt);
    } else if (evt instanceof events.SessionUpdatedEvent) {
      logger.debug(`${this}: session updated`);
    } else if (evt instanceof events.UnknownServerEvent) {
      logger.debug(`${this}: ignoring unknown server event ${evt.type}`);
    } else {
      logger.debug(`${this}: ${evt.type}`);
    }
  }

  protected async _handleEvtSessionStarted(evt: events.SessionStartedEvent): Promise<void> {
    this._sessionStarted = true;
    this._sessionStartedOnConnection = true;
    logger.info(
      `${this}: session ${evt.session.id} started. The live model handles being ` +
        "interrupted by itself; no InterruptionFrame is broadcast, so tools run to " +
        "completion regardless of cancel_on_interruption.",
    );
    // The API takes a session update only once the session has started, so
    // tools that changed while it was starting are sent now.
    await this._maybeSendToolsUpdate();
    await this._callEventHandler("on_session_started", evt.session);
    if (this._openingInstruction) {
      // Speakable context is how the API asks the model to open the
      // conversation; the model paraphrases rather than reads it out.
      const instruction = this._openingInstruction;
      this._openingInstruction = null;
      await this._sendContextAppend(null, instruction, { spoken: true });
    }
  }

  protected async _handleEvtSessionClosed(evt: events.SessionClosedEvent): Promise<void> {
    logger.debug(`${this}: session closed (${evt.reason ?? "None"})`);
    if (evt.usage) {
      await this._reportUsage(evt.usage);
    }
    this._sessionStarted = false;
    this._sessionClosedEvent.set();
  }

  protected async _handleEvtError(evt: events.ErrorEvent): Promise<void> {
    const error = evt.error;
    let details = `${error.type || "error"}/${error.code || "unknown"}: ${error.message ?? "None"}`;
    if (error.param) {
      details += ` (param: ${error.param})`;
    }
    if (!this._sessionStartedOnConnection) {
      // No session has started on this connection, so this one will not.
      await this.pushError(`Session startup failed: ${details}`, { forceTreatAsPermanent: true });
    } else {
      await this.pushError(details);
    }
  }

  //
  // audio
  //

  protected async _sendUserAudio(frame: InputAudioRawFrame): Promise<void> {
    if (!this._sessionStarted) {
      if (!this._warnedAudioDropped) {
        this._warnedAudioDropped = true;
        logger.debug(`${this}: dropping input audio until the session has started`);
      }
      return;
    }
    let audio = frame.audio;
    if (frame.sampleRate !== OPENAI_SAMPLE_RATE) {
      audio = await this._resampler.resample(audio, frame.sampleRate, OPENAI_SAMPLE_RATE);
    }
    if (audio.length === 0) {
      return;
    }
    const payload = bytesToBase64(audio);
    await this.sendClientEvent(new events.InputAudioAppendEvent({ audio: payload }));
  }

  protected async _handleEvtAudioDelta(evt: events.OutputAudioDeltaEvent): Promise<void> {
    // The model streams output continuously at real-time pace, silence
    // included, so this is a speech stream rather than TTS output: the output
    // transport derives BotStarted/StoppedSpeakingFrame from the audio itself
    // instead of from TTSStarted/StoppedFrame.
    await this.pushFrame(
      new SpeechOutputAudioRawFrame({
        audio: base64ToBytes(evt.delta),
        sampleRate: OPENAI_SAMPLE_RATE,
        numChannels: 1,
      }),
    );
  }

  //
  // transcript turns
  //

  protected async _handleEvtTranscriptDelta(evt: events.TranscriptDeltaEvent): Promise<void> {
    if (!evt.delta) {
      return;
    }
    const role = evt.role;
    // The delegation ledger keeps fragments as they arrive: the backend is
    // better served by the recent role-labelled sequence than by waiting for
    // a turn that may never be declared final.
    this._rememberFragment(role, evt.delta);

    const turn = role === "user" ? this._userTurn : this._assistantTurn;
    await turn.lock.run(async () => {
      if (!turn.open) {
        turn.open = true;
        turn.text = "";
        await this._openTurn(role);
      }
      turn.text += evt.delta;
      await this._appendTurn(role, evt.delta, turn.text, evt);
      await this._restartTurnTimer(role, turn);
    });
  }

  protected async _restartTurnTimer(role: string, turn: _TurnGrouper): Promise<void> {
    if (turn.timer !== null) {
      await this.cancelTask(turn.timer);
    }
    turn.timer = this.createTask(() => this._closeTurnAfterGap(role, turn), `turn-gap:${role}`);
  }

  protected async _closeTurnAfterGap(role: string, turn: _TurnGrouper): Promise<void> {
    await sleep(turn.gapSecs);
    await turn.lock.run(async () => {
      // Running inside the turn's own timer, so the timer must not cancel itself.
      turn.timer = null;
      await this._endTurn(role);
    });
  }

  /** Close an open turn, if any, emitting its end frames. */
  protected async _closeTurn(role: string): Promise<void> {
    const turn = role === "user" ? this._userTurn : this._assistantTurn;
    await turn.lock.run(async () => {
      if (turn.timer !== null) {
        await this.cancelTask(turn.timer);
        turn.timer = null;
      }
      await this._endTurn(role);
    });
  }

  /** Emit an open turn's end frames, with the turn's lock held. */
  protected async _endTurn(role: string): Promise<void> {
    const turn = role === "user" ? this._userTurn : this._assistantTurn;
    if (!turn.open) {
      return;
    }
    turn.open = false;
    const text = turn.text;
    turn.text = "";
    if (role === "user") {
      if (text.trim()) {
        await this.pushFrame(
          new TranscriptionFrame({ text, userId: "", timestamp: timeNowIso8601() }),
          FrameDirection.UPSTREAM,
        );
      }
      await this.broadcastFrame(ProposedUserStoppedSpeakingFrame);
    } else {
      await this.pushFrame(new TTSStoppedFrame());
      await this.pushFrame(new LLMFullResponseEndFrame());
    }
  }

  /** Close both directions, so response frames stay balanced across sessions. */
  protected async _closeOpenTurns(): Promise<void> {
    await this._closeTurn("user");
    await this._closeTurn("assistant");
  }

  protected async _openTurn(role: string): Promise<void> {
    if (role === "user") {
      await this.broadcastFrame(ProposedUserStartedSpeakingFrame);
    } else {
      await this.pushFrame(new LLMFullResponseStartFrame());
      await this.pushFrame(new TTSStartedFrame());
    }
  }

  protected async _appendTurn(
    role: string,
    delta: string,
    accumulated: string,
    evt: events.ServerEvent,
  ): Promise<void> {
    if (role === "user") {
      await this._pushInterimTranscription(accumulated, evt);
    } else {
      await this._pushAssistantText(delta);
    }
  }

  /**
   * Keep a transcript fragment for the next client delegation.
   *
   * Fragments land on frame boundaries, so consecutive ones from the same
   * speaker are joined back up as they arrive, giving the backend whole
   * utterances to read. Deltas carry their own leading spaces, so they
   * concatenate into the original text unaltered.
   */
  protected _rememberFragment(role: "user" | "assistant", delta: string): void {
    if (!(this._delegation instanceof ClientDelegation)) {
      return;
    }
    const fragments = this._transcriptFragments;
    const last = fragments[fragments.length - 1];
    if (last !== undefined && last.role === role) {
      last.content += delta;
    } else if (delta.trim()) {
      fragments.push({ role, content: delta.trimStart() });
    }
  }

  /** Take the conversation recorded since the previous delegation. */
  protected _takeTranscript(): LLMStandardMessage[] {
    const taken = this._transcriptFragments;
    this._transcriptFragments = [];
    return taken
      .filter((f) => f.content.trim())
      .map((f) => ({ role: f.role, content: f.content.trim() }) as LLMStandardMessage);
  }

  protected async _pushAssistantText(text: string): Promise<void> {
    if (!text) {
      return;
    }
    // RTVI relies on LLMTextFrames for its "bot-llm-text" event, but the
    // assistant aggregator records the TTSTextFrame, so the LLMTextFrame must
    // not also be appended to the context.
    const llmTextFrame = new LLMTextFrame({ text });
    llmTextFrame.appendToContext = false;
    await this.pushFrame(llmTextFrame);

    const ttsTextFrame = new TTSTextFrame({ text, textType: TextType.SENTENCE });
    ttsTextFrame.includesInterFrameSpaces = true;
    await this.pushFrame(ttsTextFrame);
  }

  protected async _pushInterimTranscription(
    transcript: string,
    evt: events.ServerEvent,
  ): Promise<void> {
    if (!transcript.trim()) {
      return;
    }
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

  //
  // delegation
  //

  protected async _handleEvtDelegationCreated(
    evt: events.SessionDelegationCreatedEvent,
  ): Promise<void> {
    const delegation = evt.delegation;
    logger.debug(`${this}: delegation ${delegation.id} created (target=${delegation.target})`);
    await this._callEventHandler("on_delegation_created", delegation);
    if (delegation.target === "client") {
      await this._handleClientDelegation(delegation);
    }
  }

  protected async _handleClientDelegation(delegation: events.DelegationMetadata): Promise<void> {
    if (!(this._delegation instanceof ClientDelegation)) {
      logger.warning(
        `${this}: the model delegated work but no backend is configured to handle ` +
          "client delegations; declining",
      );
      await this._sendContextAppend(
        delegation.id,
        "No backend is available to handle delegated work in this session.",
        { spoken: true },
      );
      return;
    }
    // The backend is handed the conversation since the last delegation and
    // works out the request from it. The transcript is taken now, so a
    // delegation that waits its turn still reads what prompted it.
    const request = _renderTranscriptRequest(this._takeTranscript(), {
      first: !this._delegatedBefore,
    });
    this._delegatedBefore = true;
    if (this._currentDelegation === null) {
      await this._startDelegation(delegation, request);
    } else {
      logger.debug(`${this}: delegation ${delegation.id} waits for the backend to finish`);
      this._queuedDelegations.push([delegation, request]);
    }
  }

  /** Hold the session with the backend, appending what it produces to the live session. */
  protected async _runBackendSession(): Promise<void> {
    const config = this._delegation;
    if (!(config instanceof ClientDelegation)) {
      throw new Error("assertion failed: client delegation is not configured");
    }
    const backendName = typeof config.backend === "string" ? config.backend : config.backend.name;
    try {
      const backendSession = new _BackendSession(this.pipelineWorker, backendName, {
        timeoutSecs: config.timeoutSecs,
      });
      await backendSession.run(async (session) => {
        this._backendSession = session;
        this._backendAttached.set();
        for await (const event of session) {
          await this._onBackendEvent(event);
        }
        if (!session.detached) {
          logger.warning(`${this}: backend '${backendName}' went away`);
        }
      });
    } catch (e) {
      if (e instanceof CancelledError) throw e;
      logger.error(`${this}: the session with backend '${backendName}' failed: ${errorMessage(e)}`);
    } finally {
      this._backendAttached.clear();
      this._backendSession = null;
    }
  }

  protected async _onBackendEvent(
    event: BackendOutput | BackendToolCall | BackendIdle | BackendError,
  ): Promise<void> {
    const current = this._currentDelegation;
    if (event instanceof BackendToolCall) {
      // Reported to clients as ExternalFunctionCall frames, as the
      // Responses-delegation backend's calls are.
      await this.pushFrame(event.toFrame());
    } else if (event instanceof BackendOutput) {
      if (!event.text) {
        return;
      }
      if (current !== null && event.prefersSpoken) {
        current.answered = true;
      }
      await this._sendContextAppend(current ? current.id : null, event.text, {
        spoken: event.prefersSpoken,
      });
    } else if (event instanceof BackendError) {
      if (current !== null) {
        logger.warning(`${this}: delegation ${current.id} failed: ${event.error}`);
        await this._sendContextAppend(current.id, "The delegated work could not be completed.", {
          spoken: true,
        });
        await this.pushError(`Delegation ${current.id} failed: ${event.error}`);
        await this._finishDelegation();
      }
    } else if (event instanceof BackendIdle) {
      if (current !== null) {
        if (!current.answered) {
          // The live model holds the conversation until the delegation says
          // something, so a run that produced nothing spoken still gets a
          // word back.
          logger.warning(`${this}: delegation ${current.id} produced no spoken output`);
          await this._sendContextAppend(
            current.id,
            "The delegated work finished without an answer.",
            { spoken: true },
          );
        }
        await this._finishDelegation();
      }
    }
  }

  protected async _startDelegation(
    delegation: events.DelegationMetadata,
    request: string,
  ): Promise<void> {
    const config = this._delegation;
    if (!(config instanceof ClientDelegation)) {
      throw new Error("assertion failed: client delegation is not configured");
    }
    const current = new _LiveDelegation({ id: delegation.id });
    this._currentDelegation = current;
    current.timeoutTask = this.createTask(
      () => this._delegationTimeout(current, config.timeoutSecs),
      `${this}::delegation_timeout:${delegation.id}`,
    );
    try {
      await timeout(BACKEND_ATTACH_TIMEOUT_SECS, () => this._backendAttached.wait());
      const session = this._backendSession;
      if (session === null) {
        throw new Error("the backend is not attached");
      }
      await session.send(request);
    } catch (e) {
      rethrowIfCancelled(e);
      logger.warning(`${this}: delegation ${delegation.id} failed: ${errorMessage(e)}`);
      await this._sendContextAppend(delegation.id, "The delegated work could not be completed.", {
        spoken: true,
      });
      await this.pushError(`Delegation ${delegation.id} failed: ${errorMessage(e)}`, {
        exception: e,
      });
      await this._finishDelegation();
    }
  }

  /** Close the delegation in progress and start the next one waiting, if any. */
  protected async _finishDelegation(): Promise<void> {
    const current = this._currentDelegation;
    this._currentDelegation = null;
    if (current !== null && current.timeoutTask !== null) {
      if (current.timeoutTask !== currentTask()) {
        await this.cancelTask(current.timeoutTask);
      }
      current.timeoutTask = null;
    }
    const next = this._queuedDelegations.shift();
    if (next !== undefined) {
      const [delegation, request] = next;
      await this._startDelegation(delegation, request);
    }
  }

  protected async _delegationTimeout(current: _LiveDelegation, timeoutSecs: number): Promise<void> {
    await sleep(timeoutSecs);
    if (this._currentDelegation !== current) {
      return;
    }
    logger.warning(`${this}: delegation ${current.id} timed out; abandoning it`);
    current.timeoutTask = null;
    // The backend may still be at work on it. Detaching stops that work, so
    // none of it is reported under a later delegation.
    await this._detachBackend();
    await this._attachBackend();
    await this._sendContextAppend(current.id, "The delegated work could not be completed.", {
      spoken: true,
    });
    await this._finishDelegation();
  }

  /**
   * Drop the delegation in progress and the ones waiting: the session they belong to is over.
   *
   * The backend is detached, which stops its work; the next connection
   * attaches again.
   */
  protected async _abandonDelegations(): Promise<void> {
    this._queuedDelegations.length = 0;
    const current = this._currentDelegation;
    this._currentDelegation = null;
    if (current !== null && current.timeoutTask !== null) {
      await this.cancelTask(current.timeoutTask);
      current.timeoutTask = null;
    }
    await this._detachBackend();
  }

  /** Open the session with the backend, when client delegation is configured and none is open. */
  protected async _attachBackend(): Promise<void> {
    if (this._delegation instanceof ClientDelegation && this._backendSessionTask === null) {
      this._backendSessionTask = this.createTask(
        () => this._runBackendSession(),
        `${this}::backend_session`,
      );
    }
  }

  /** Close the session with the backend, which stops its work. */
  protected async _detachBackend(): Promise<void> {
    if (this._backendSessionTask !== null) {
      await this.cancelTask(this._backendSessionTask);
      this._backendSessionTask = null;
    }
  }

  /**
   * Append text to the live session, for it to speak or to keep to itself.
   *
   * The API's two channels are named for what the live model does with the
   * text: commentary is paraphrased aloud, thinking joins its private
   * reasoning. That vantage is the model's own, which is why what arrives
   * from a backend is flagged `prefersSpoken` instead — ordinary prose can go
   * unspoken without being anything like a thought.
   */
  protected async _sendContextAppend(
    delegationId: string | null,
    text: string,
    options: { spoken: boolean },
  ): Promise<void> {
    const spoken = options.spoken;
    const channel = spoken ? "commentary" : "thinking";
    for (const chunk of _chunkText(text, MAX_CONTEXT_APPEND_TOKENS)) {
      logger.debug(
        `${this}: delegation ${delegationId ?? "None"} ${channel} context: ${reprStr(chunk)}`,
      );
      const eventClass = spoken
        ? events.SessionCommentaryAppendEvent
        : events.SessionThinkingAppendEvent;
      await this.sendClientEvent(new eventClass({ delegationId, content: chunk }));
    }
  }

  //
  // Responses delegation
  //

  /** Dispatch a wrapped Responses lifecycle event by its own type. */
  protected async _handleEvtResponse(evt: events.ResponseEventEnvelope): Promise<void> {
    const innerType = evt.innerType;
    if (innerType === "response.created") {
      this._trackResponse(evt);
    } else if (innerType === "response.output_item.done") {
      await this._handleResponseOutputItemDone(evt);
    } else if (
      innerType === "response.completed" ||
      innerType === "response.incomplete" ||
      innerType === "response.failed"
    ) {
      await this._handleResponseFinished(evt);
    } else {
      logger.trace(`${this}: ${innerType || evt.type}`);
    }
  }

  /**
   * Remember a delegated response so its function calls can be collected.
   *
   * @returns The response's correlation key.
   */
  protected _trackResponse(evt: events.ResponseEventEnvelope): string {
    const key = _correlationKey(evt);
    if (!this._pendingResponses.has(key)) {
      this._pendingResponses.set(key, new _PendingResponse());
    }
    return key;
  }

  protected async _handleResponseOutputItemDone(evt: events.ResponseEventEnvelope): Promise<void> {
    const rawItem = evt.event.item;
    const item = events.ResponseOutputItem.modelValidate(pyTruthy(rawItem) ? rawItem : {});
    if (item.type !== "function_call") {
      return;
    }
    if (item.status !== "completed") {
      logger.debug(`${this}: ignoring ${item.status ?? "None"} function call item`);
      return;
    }
    if (!item.callId || !item.name) {
      logger.warning(`${this}: function call item without call_id or name: ${pydanticStr(item)}`);
      return;
    }
    if (this._openFunctionCalls.has(item.callId)) {
      logger.warning(`${this}: function call ${item.callId} already in progress, skipping`);
      return;
    }

    let args: unknown;
    try {
      args = item.arguments ? pyJsonLoads(item.arguments) : {};
    } catch (e) {
      if (!(e instanceof SyntaxError)) throw e;
      await this.pushError(`Invalid arguments for function call ${item.name}: ${e.message}`, {
        exception: e,
      });
      return;
    }

    const key = this._trackResponse(evt);
    const pending = this._pendingResponses.get(key) as _PendingResponse;
    pending.callIds.add(item.callId);
    pending.hadCalls = true;
    this._openFunctionCalls.set(item.callId, key);
    await this.runFunctionCalls([
      new FunctionCallFromLLM({
        context: this._context as LLMContext,
        toolCallId: item.callId,
        functionName: item.name,
        arguments: args as Record<string, unknown>,
      }),
    ]);
  }

  /**
   * Note that a response emitted all of its output items.
   *
   * The lifecycle snapshot's `output` is empty even here, so the calls
   * collected from the individual item events are what has to be answered.
   */
  protected async _handleResponseFinished(evt: events.ResponseEventEnvelope): Promise<void> {
    const innerType = evt.innerType;
    if (innerType === "response.completed") {
      const response = evt.event.response;
      await this._reportBackendUsage(
        (pyTruthy(response) ? response : {}) as Record<string, unknown>,
      );
    } else if (innerType === "response.failed" || innerType === "response.incomplete") {
      const rawResponse = evt.event.response;
      const response = (pyTruthy(rawResponse) ? rawResponse : {}) as Record<string, unknown>;
      const rawError = pyTruthy(response.error)
        ? response.error
        : pyTruthy(response.incomplete_details)
          ? response.incomplete_details
          : {};
      let message: unknown = null;
      if (typeof rawError === "object" && rawError !== null && !Array.isArray(rawError)) {
        const error = rawError as Record<string, unknown>;
        message = pyTruthy(error.message) ? error.message : error.reason;
      }
      let status: unknown = "unknown";
      if ("status" in response) status = response.status ?? "None";
      await this.pushError(
        `Delegated response ${innerType.replace(/^response\./, "")}: ` +
          `${pyTruthy(message) ? String(message) : String(status)}`,
      );
    }
    const key = _correlationKey(evt);
    const pending = this._pendingResponses.get(key);
    if (pending === undefined) {
      return;
    }
    pending.finished = true;
    await this._maybeContinueResponse(key);
  }

  /** Continue a response once every function call it made has been answered. */
  protected async _maybeContinueResponse(key: string): Promise<void> {
    const pending = this._pendingResponses.get(key);
    if (
      pending === undefined ||
      !pending.finished ||
      !pending.hadCalls ||
      pending.callIds.size > 0
    ) {
      return;
    }
    this._pendingResponses.delete(key);
    logger.debug(`${this}: continuing delegated work for ${key}`);
    await this.sendClientEvent(new events.ResponseCreateEvent());
  }

  protected async _handleFunctionCallResult(frame: FunctionCallResultFrame): Promise<void> {
    if (!this._openFunctionCalls.has(frame.toolCallId)) {
      return;
    }
    const isFinal = frame.properties ? frame.properties.isFinal : true;
    if (!isFinal) {
      logger.warning(
        `${this}: the Live API accepts one output per function call; dropping ` +
          `intermediate result for ${frame.functionName}:${frame.toolCallId}`,
      );
      return;
    }
    // Same encoding the assistant aggregator records in the context.
    const output = pyTruthy(frame.result)
      ? pyJsonDumps(frame.result, { ensureAscii: false })
      : "COMPLETED";
    await this._sendFunctionCallOutput(frame.toolCallId, output);
  }

  protected async _handleFunctionCallCancel(frame: FunctionCallCancelFrame): Promise<void> {
    if (!this._openFunctionCalls.has(frame.toolCallId)) {
      return;
    }
    await this._sendFunctionCallOutput(
      frame.toolCallId,
      pyJsonDumps({ error: "The function call was cancelled before it produced a result." }),
    );
  }

  /** Queue one function result, and continue the response once all are in. */
  protected async _sendFunctionCallOutput(callId: string, output: string): Promise<void> {
    const key = this._openFunctionCalls.get(callId) ?? "";
    this._openFunctionCalls.delete(callId);
    logger.debug(`${this}: sending function call output for ${callId}`);
    await this.sendClientEvent(
      new events.ResponseItemCreateEvent({
        item: new events.FunctionCallOutputItem({ callId, output }),
      }),
    );
    const pending = this._pendingResponses.get(key);
    if (pending !== undefined) {
      pending.callIds.delete(callId);
    }
    await this._maybeContinueResponse(key);
  }

  //
  // usage metrics
  //

  /**
   * Log the session's cumulative live audio duration.
   *
   * The live model's usage is reported as seconds rather than tokens. Token
   * metrics come from the backend model instead, on the nested Responses
   * completion events.
   */
  protected async _reportUsage(usage: events.Usage): Promise<void> {
    if (usage.seconds !== null && usage.seconds !== undefined) {
      logger.debug(`${this}: live audio usage: ${usage.seconds.toFixed(1)}s (cumulative)`);
    }
  }

  /** Report the backend model's token usage from a completed delegated response. */
  protected async _reportBackendUsage(response: Record<string, unknown>): Promise<void> {
    const usage = response.usage;
    if (typeof usage !== "object" || usage === null || Array.isArray(usage)) {
      return;
    }
    const u = usage as Record<string, any>;
    const details = (pyTruthy(u.input_tokens_details) ? u.input_tokens_details : {}) as Record<
      string,
      any
    >;
    const outputDetails = (
      pyTruthy(u.output_tokens_details) ? u.output_tokens_details : {}
    ) as Record<string, any>;
    const tokens = new LLMTokenUsage({
      promptTokens: u.input_tokens || 0,
      completionTokens: u.output_tokens || 0,
      totalTokens: u.total_tokens || 0,
      cacheReadInputTokens: details.cached_tokens || 0,
      reasoningTokens: outputDetails.reasoning_tokens || 0,
    });
    if (tokens.totalTokens > 0) {
      await this.startLlmUsageMetrics(tokens);
    }
  }
}

/**
 * Identify the delegated work a wrapped Responses event belongs to.
 *
 * The envelope's `delegationId` is the correlator every wrapped event
 * carries; the Responses events inside do not all name their response. An
 * envelope without one falls back to a shared key, which keeps a single
 * delegated response's events together.
 */
function _correlationKey(evt: events.ResponseEventEnvelope): string {
  return evt.delegationId || _UNCORRELATED_DELEGATION;
}

/** Return the text of a trailing developer message, if the history ends with one. */
export function _trailingDeveloperText(items: readonly events.InputItem[]): string | null {
  const last = items[items.length - 1];
  if (last === undefined || last.role !== "developer") {
    return null;
  }
  return (
    last.content
      .filter((part) => part.text)
      .map((part) => part.text)
      .join("\n")
      .trim() || null
  );
}

/**
 * Build `delegation.responses` from the nested Responses settings.
 *
 * Mirrors how `OpenAIResponsesLLMService` builds a request from the same
 * settings, minus what the Live API owns for a delegated model.
 */
export function _responsesDelegationConfig(
  delegation: ResponsesDelegation,
): Record<string, unknown> {
  const settings = delegation.settings;

  const isSet = (value: unknown): boolean =>
    isGiven(value) && value !== null && value !== OPENAI_NOT_GIVEN;

  const config: Record<string, unknown> = { model: settings.model };
  if (isSet(settings.systemInstruction)) {
    config.instructions = settings.systemInstruction;
  }
  if (
    typeof settings.maxCompletionTokens === "number" &&
    Number.isInteger(settings.maxCompletionTokens)
  ) {
    config.max_output_tokens = settings.maxCompletionTokens;
  }
  if (settings.reasoning instanceof OpenAIResponsesReasoningConfig) {
    const reasoning: Record<string, unknown> = {};
    for (const [field, value] of [
      ["effort", settings.reasoning.effort],
      ["summary", settings.reasoning.summary],
      ["mode", settings.reasoning.mode],
    ] as const) {
      if (value !== null && value !== undefined) reasoning[field] = value;
    }
    config.reasoning = reasoning;
  }
  if (delegation.serviceTier !== null) {
    config.service_tier = delegation.serviceTier;
  }

  const unsupportedFields = [
    ["temperature", "temperature"],
    ["topP", "top_p"],
    ["frequencyPenalty", "frequency_penalty"],
    ["presencePenalty", "presence_penalty"],
    ["seed", "seed"],
    ["topK", "top_k"],
    ["maxTokens", "max_tokens"],
    ["userTurnCompletionConfig", "user_turn_completion_config"],
  ] as const;
  const unsupported: string[] = unsupportedFields
    .filter(([field]) => isSet((settings as unknown as Record<string, unknown>)[field]))
    .map(([, name]) => name);
  if (isSet(settings.filterIncompleteUserTurns) && settings.filterIncompleteUserTurns) {
    unsupported.push("filter_incomplete_user_turns");
  }
  if (unsupported.length > 0) {
    logger.warning(
      "Dropping Responses settings the OpenAI Live API doesn't accept for a delegated " +
        `model: [${unsupported.map((n) => `'${n}'`).join(", ")}]`,
    );
  }

  Object.assign(config, settings.extra);
  return config;
}

const _SENTENCE_BOUNDARY = /(?<=[.!?])\s+|\n+/;

/**
 * Estimate how many tokens a piece of text costs.
 *
 * A byte-pair encoding packs about four characters of ASCII into a token.
 * Other scripts cost more per character — CJK runs close to one token each —
 * so anything outside ASCII is counted whole.
 */
export function _estimatedTokens(text: string): number {
  return Math.floor((_tokenQuarters(text) + 3) / 4);
}

/** Return a text's cost in quarter-tokens: one for an ASCII character, four for any other. */
export function _tokenQuarters(text: string): number {
  let cost = 0;
  for (const char of text) {
    cost += (char.codePointAt(0) as number) < 128 ? 1 : 4;
  }
  return cost;
}

/**
 * Split off the longest prefix of `text` that fits `tokenLimit`.
 *
 * The cut lands on the last space within the limit, so words stay whole.
 */
export function _splitAtTokenLimit(text: string, tokenLimit: number): [string, string] {
  // Indexed by code point, as Python indexes a str.
  const chars = Array.from(text);
  const budget = tokenLimit * 4;
  let end = chars.length;
  let cost = 0;
  for (let index = 0; index < chars.length; index++) {
    cost += _tokenQuarters(chars[index] as string);
    if (cost > budget) {
      end = Math.max(index, 1);
      break;
    }
  }
  let space = -1;
  for (let i = end - 1; i >= 0; i--) {
    if (chars[i] === " ") {
      space = i;
      break;
    }
  }
  if (space > 0) {
    end = space;
  }
  return [chars.slice(0, end).join("").trim(), chars.slice(end).join("").trim()];
}

/**
 * Split text into chunks of at most `tokenLimit` estimated tokens.
 *
 * Chunks break on sentence boundaries; a sentence longer than the limit is
 * split at a space.
 */
export function _chunkText(text: string, tokenLimit: number): string[] {
  text = text.trim();
  if (!text) {
    return [];
  }
  if (_estimatedTokens(text) <= tokenLimit) {
    return [text];
  }

  const chunks: string[] = [];
  let current = "";

  const flush = (): void => {
    if (current) {
      chunks.push(current);
      current = "";
    }
  };

  for (let piece of text.split(_SENTENCE_BOUNDARY)) {
    piece = piece.trim();
    while (_estimatedTokens(piece) > tokenLimit) {
      const [head, rest] = _splitAtTokenLimit(piece, tokenLimit);
      piece = rest;
      flush();
      chunks.push(head);
    }
    if (!piece) {
      continue;
    }
    if (current && _estimatedTokens(`${current} ${piece}`) > tokenLimit) {
      flush();
    }
    current = `${current} ${piece}`.trim();
  }
  flush();
  return chunks;
}
