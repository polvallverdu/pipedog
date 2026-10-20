// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/processors/aggregators/llm_response_universal.py

/**
 * LLM response aggregators for handling conversation context and message aggregation.
 *
 * This module provides aggregators that process and accumulate LLM responses,
 * user inputs, and conversation context. These aggregators handle the flow
 * between speech-to-text, LLM processing, and text-to-speech components in
 * conversational AI pipelines.
 *
 * Porting notes: the deprecated `LLMUserAggregatorParams.filterIncompleteUserTurns`
 * / `userTurnCompletionConfig` and `LLMAssistantAggregatorParams.enableContextSummarization`
 * / `contextSummarizationConfig` fields are not ported.
 */

import { rethrowIfCancelled, sleep, type Task } from "@pipedog/asyncio";
import type { ToolsSchema } from "../../adapters/schemas/tools_schema.ts";
import type { VADAnalyzer } from "../../audio/vad/vad_analyzer.ts";
import { VADController } from "../../audio/vad/vad_controller.ts";
import {
  AggregatedTextFrame,
  AssistantImageRawFrame,
  BotStartedSpeakingFrame,
  BotStoppedSpeakingFrame,
  CancelFrame,
  EagerEndOfTurnCancelFrame,
  EagerTranscriptionFrame,
  EndFrame,
  type Frame,
  FunctionCallCancelFrame,
  FunctionCallInProgressFrame,
  FunctionCallResultFrame,
  FunctionCallsStartedFrame,
  InputAudioRawFrame,
  InterimTranscriptionFrame,
  InterruptionFrame,
  LLMAssistantPushAggregationFrame,
  LLMContextAssistantTimestampFrame,
  LLMContextAssistantTurnFrame,
  LLMContextFrame,
  type LLMContextSummaryRequestFrame,
  LLMContextUserTurnFrame,
  LLMFullResponseEndFrame,
  LLMFullResponseStartFrame,
  LLMMarkerFrame,
  LLMMessagesAppendFrame,
  LLMMessagesTransformFrame,
  LLMMessagesUpdateFrame,
  LLMRunFrame,
  LLMServiceMetadataFrame,
  LLMSetToolChoiceFrame,
  LLMSetToolsFrame,
  LLMThoughtEndFrame,
  LLMThoughtStartFrame,
  LLMThoughtTextFrame,
  ProposedUserStartedSpeakingFrame,
  ProposedUserStoppedSpeakingFrame,
  ServiceMetadataFrame,
  STTMetadataFrame,
  StartFrame,
  TextFrame,
  TranscriptionFrame,
  TranslationFrame,
  TTSStartedFrame,
  TTSTextFrame,
  UserBackchannelFrame,
  UserFileRawFrame,
  UserImageRawFrame,
  UserMuteStartedFrame,
  UserMuteStoppedFrame,
  UserSpeakingFrame,
  UserStartedSpeakingFrame,
  UserStoppedSpeakingFrame,
  VADUserStartedSpeakingFrame,
  VADUserStoppedSpeakingFrame,
} from "../../frames/frames.ts";
import { DEFAULT_TTFS_P99 } from "../../services/stt_latency.ts";
import { EmptyUserTurnConfig } from "../../turns/empty_user_turn.ts";
import type { UserTurnSpeculation } from "../../turns/types.ts";
import { UserIdleController } from "../../turns/user_idle_controller.ts";
import type { BaseUserMuteStrategy } from "../../turns/user_mute/base_user_mute_strategy.ts";
import type {
  BaseUserTurnStartStrategy,
  UserTurnStartedParams,
} from "../../turns/user_start/base_user_turn_start_strategy.ts";
import { TranscriptionUserTurnStartStrategy } from "../../turns/user_start/transcription_user_turn_start_strategy.ts";
import type {
  BaseUserTurnStopStrategy,
  UserTurnStoppedParams,
} from "../../turns/user_stop/base_user_turn_stop_strategy.ts";
import {
  USER_TURN_COMPLETE_MARKER,
  USER_TURN_INCOMPLETE_LONG_MARKER,
  USER_TURN_INCOMPLETE_SHORT_MARKER,
} from "../../turns/user_turn_completion_mixin.ts";
import { UserTurnController } from "../../turns/user_turn_controller.ts";
import {
  ExternalUserTurnStrategies,
  UserTurnStrategies,
} from "../../turns/user_turn_strategies.ts";
import type { LLMAutoContextSummarizationConfig } from "../../utils/context/llm_context_summarization.ts";
import { logger } from "../../utils/logger.ts";
import { concatenateAggregatedText, TextPartForConcatenation } from "../../utils/string.ts";
import { TextType } from "../../utils/text/base_text_aggregator.ts";
import { timeNowIso8601 } from "../../utils/time.ts";
import {
  FrameDirection,
  FrameProcessor,
  type FrameProcessorOptions,
  type FrameProcessorSetup,
} from "../frame_processor.ts";
import * as asyncToolMessages from "./async_tool_messages.ts";
import {
  isGiven,
  LLMContext,
  type LLMContextMessage,
  type LLMContextToolChoice,
  LLMSpecificMessage,
  type LLMStandardMessage,
  type NotGiven,
} from "./llm_context.ts";
import { LLMContextSummarizer, type SummaryAppliedEvent } from "./llm_context_summarizer.ts";

/**
 * Python `json.dumps(value, ensure_ascii=False)`: same output as
 * `JSON.stringify`, but with Python's `", "` and `": "` separators so
 * contexts are identical across ports.
 */
function jsonDumps(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  const withToJson = value as { toJSON?: () => unknown };
  if (typeof withToJson.toJSON === "function") {
    return jsonDumps(withToJson.toJSON());
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => jsonDumps(v)).join(", ")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined && typeof v !== "function")
    .map(([k, v]) => `${JSON.stringify(k)}: ${jsonDumps(v)}`);
  return `{${entries.join(", ")}}`;
}

/** Python truthiness for a function call result (empty dicts/lists/strings are falsy). */
function isTruthy(value: unknown): boolean {
  if (value === null || value === undefined || value === false || value === 0 || value === "") {
    return false;
  }
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.keys(value as object).length > 0;
  }
  return true;
}

/** Python `repr()` of a list of strings, as used in log lines. */
function reprList(items: string[]): string {
  return `[${items.map((i) => `'${i}'`).join(", ")}]`;
}

export interface LLMUserAggregatorParamsOptions {
  /**
   * When true, on each `LLMSetToolsFrame` the aggregator computes the diff
   * against the currently advertised tools and appends a developer-role
   * message to the context describing additions/removals. Helps the LLM stay
   * coherent across mid-conversation tool changes, mitigating several
   * flavors of tool-call-related hallucination: calling tools that have been
   * removed, avoiding tools that have been re-added, and hallucinating output
   * (made-up answers or tool-call-shaped non-tool-calls) when tools are
   * unavailable. Only standard tools are diffed; custom (LLM-specific) tools
   * are ignored. When using `LLMContextAggregatorPair`, prefer setting this
   * via its `addToolChangeMessages` argument instead. Defaults to false.
   */
  addToolChangeMessages?: boolean;
  /**
   * Timeout in seconds to force speech stop when no audio frames are
   * received while in SPEAKING state (e.g. user mutes mic mid-speech). Set to
   * 0 to disable. Defaults to 1.0.
   */
  audioIdleTimeout?: number;
  /** User turn start and stop strategies. */
  userTurnStrategies?: UserTurnStrategies | null;
  /** List of user mute strategies. */
  userMuteStrategies?: BaseUserMuteStrategy[];
  /** Time in seconds to wait before considering the user's turn finished. */
  userTurnStopTimeout?: number;
  /**
   * Timeout in seconds for detecting user idle state. The aggregator will
   * emit an `on_user_turn_idle` event when the user has been idle (not
   * speaking) for this duration. Set to 0 to disable idle detection.
   */
  userIdleTimeout?: number;
  /** Voice Activity Detection analyzer instance. */
  vadAnalyzer?: VADAnalyzer | null;
  /**
   * How to respond to a user turn that ends with no transcript. By default,
   * the bot answers such a turn when it interrupted the bot, and leaves it
   * unanswered otherwise. `null` leaves every such turn unanswered. Ignored
   * with a realtime LLM service, which hears the user's audio directly.
   */
  emptyUserTurn?: EmptyUserTurnConfig | null;
}

/**
 * Parameters for configuring LLM user aggregation behavior.
 *
 * See `LLMUserAggregatorParamsOptions` for the fields.
 */
export class LLMUserAggregatorParams {
  addToolChangeMessages: boolean;
  audioIdleTimeout: number;
  userTurnStrategies: UserTurnStrategies | null;
  userMuteStrategies: BaseUserMuteStrategy[];
  userTurnStopTimeout: number;
  userIdleTimeout: number;
  vadAnalyzer: VADAnalyzer | null;
  emptyUserTurn: EmptyUserTurnConfig | null;

  constructor(options: LLMUserAggregatorParamsOptions = {}) {
    this.addToolChangeMessages = options.addToolChangeMessages ?? false;
    this.audioIdleTimeout = options.audioIdleTimeout ?? 1.0;
    this.userTurnStrategies = options.userTurnStrategies ?? null;
    this.userMuteStrategies = options.userMuteStrategies ?? [];
    this.userTurnStopTimeout = options.userTurnStopTimeout ?? 5.0;
    this.userIdleTimeout = options.userIdleTimeout ?? 0;
    this.vadAnalyzer = options.vadAnalyzer ?? null;
    this.emptyUserTurn =
      options.emptyUserTurn === undefined ? new EmptyUserTurnConfig() : options.emptyUserTurn;
  }
}

export interface LLMAssistantAggregatorParamsOptions {
  /**
   * Enable automatic context summarization when token or message-count
   * limits are reached (disabled by default). When enabled, older
   * conversation messages are automatically compressed into summaries to
   * manage context size.
   */
  enableAutoContextSummarization?: boolean;
  /**
   * Configuration for automatic context summarization. Controls trigger
   * thresholds, message preservation, and summarization prompts. If null,
   * uses default `LLMAutoContextSummarizationConfig` values.
   */
  autoContextSummarizationConfig?: LLMAutoContextSummarizationConfig | null;
  /**
   * When true, on each `LLMSetToolsFrame` the aggregator computes the diff
   * against the currently advertised tools and appends a developer-role
   * message to the context describing additions/removals. See
   * `LLMUserAggregatorParamsOptions.addToolChangeMessages`. Defaults to false.
   */
  addToolChangeMessages?: boolean;
}

/**
 * Parameters for configuring LLM assistant aggregation behavior.
 *
 * See `LLMAssistantAggregatorParamsOptions` for the fields.
 */
export class LLMAssistantAggregatorParams {
  enableAutoContextSummarization: boolean;
  autoContextSummarizationConfig: LLMAutoContextSummarizationConfig | null;
  addToolChangeMessages: boolean;

  constructor(options: LLMAssistantAggregatorParamsOptions = {}) {
    this.enableAutoContextSummarization = options.enableAutoContextSummarization ?? false;
    this.autoContextSummarizationConfig = options.autoContextSummarizationConfig ?? null;
    this.addToolChangeMessages = options.addToolChangeMessages ?? false;
  }
}

export interface UserTurnStoppedMessageOptions {
  content: string | null;
  timestamp: string;
  userId?: string | null;
}

/**
 * A user turn stopped message containing a user transcript update.
 *
 * A message in a conversation transcript containing the user content. This
 * is the aggregated transcript that is then used in the context.
 *
 * - `content`: The message content/text. `null` in realtime mode
 *   (`realtimeServiceMode: true`) when fired from a user-turn-stop frame: in
 *   realtime mode the user message isn't finalized until the assistant
 *   response start acts as the effective end-of-turn signal. Subscribers that
 *   need the finalized text should listen to `on_user_turn_message_added`
 *   instead.
 * - `timestamp`: When the user turn started.
 * - `userId`: Optional identifier for the user.
 */
export class UserTurnStoppedMessage {
  content: string | null;
  timestamp: string;
  userId: string | null;

  constructor(options: UserTurnStoppedMessageOptions) {
    this.content = options.content;
    this.timestamp = options.timestamp;
    this.userId = options.userId ?? null;
  }
}

export interface UserTurnMessageAddedMessageOptions {
  content: string;
  timestamp: string;
  userId?: string | null;
}

/**
 * A message accompanying `on_user_turn_message_added`.
 *
 * Fired when a user message is written to the LLM context. In cascade mode
 * (`realtimeServiceMode: false`) this coincides with `on_user_turn_stopped`.
 * In realtime mode (`realtimeServiceMode: true`) the write is triggered by
 * the assistant response start (or session end), so this event fires
 * decoupled from user-turn-end frames. `content` is always populated.
 *
 * - `content`: The aggregated user transcript.
 * - `timestamp`: When the user turn started.
 * - `userId`: Optional identifier for the user.
 */
export class UserTurnMessageAddedMessage {
  content: string;
  timestamp: string;
  userId: string | null;

  constructor(options: UserTurnMessageAddedMessageOptions) {
    this.content = options.content;
    this.timestamp = options.timestamp;
    this.userId = options.userId ?? null;
  }
}

export interface UserBackchannelMessageOptions {
  content: string;
  timestamp: string;
  userId?: string | null;
}

/**
 * A message accompanying `on_user_backchannel`.
 *
 * A short acknowledgment the user said while the bot talks, such as "mhm",
 * which stays out of the LLM context.
 *
 * - `content`: What the user said.
 * - `timestamp`: When the user said it.
 * - `userId`: Optional identifier for the user.
 */
export class UserBackchannelMessage {
  content: string;
  timestamp: string;
  userId: string | null;

  constructor(options: UserBackchannelMessageOptions) {
    this.content = options.content;
    this.timestamp = options.timestamp;
    this.userId = options.userId ?? null;
  }
}

export interface AssistantTurnStoppedMessageOptions {
  content: string;
  interrupted: boolean;
  timestamp: string;
}

/**
 * An assistant turn stopped message containing an assistant transcript update.
 *
 * A message in a conversation transcript containing the assistant content.
 * This is the aggregated transcript that is then used in the context.
 *
 * - `content`: The message content/text. May be empty if the LLM returned
 *   zero tokens (e.g. turn was interrupted before any tokens were received or
 *   pushed).
 * - `interrupted`: Whether the assistant turn was interrupted.
 * - `timestamp`: When the assistant turn started.
 */
export class AssistantTurnStoppedMessage {
  content: string;
  interrupted: boolean;
  timestamp: string;

  constructor(options: AssistantTurnStoppedMessageOptions) {
    this.content = options.content;
    this.interrupted = options.interrupted;
    this.timestamp = options.timestamp;
  }
}

export interface AssistantBackchannelMessageOptions {
  content: string;
  timestamp: string;
}

/**
 * A message accompanying `on_assistant_backchannel`.
 *
 * A short acknowledgment the assistant said while the user talks, such as
 * "Mm-hmm.".
 *
 * - `content`: What the assistant said.
 * - `timestamp`: When the assistant started saying it.
 */
export class AssistantBackchannelMessage {
  content: string;
  timestamp: string;

  constructor(options: AssistantBackchannelMessageOptions) {
    this.content = options.content;
    this.timestamp = options.timestamp;
  }
}

export interface AssistantThoughtMessageOptions {
  content: string;
  timestamp: string;
}

/**
 * An assistant thought message containing an assistant thought update.
 *
 * A message in a conversation transcript containing the assistant thought
 * content.
 *
 * - `content`: The message content/text.
 * - `timestamp`: When the thought started.
 */
export class AssistantThoughtMessage {
  content: string;
  timestamp: string;

  constructor(options: AssistantThoughtMessageOptions) {
    this.content = options.content;
    this.timestamp = options.timestamp;
  }
}

export interface LLMContextAggregatorOptions extends FrameProcessorOptions {
  /** The LLM context to use for conversation storage. */
  context: LLMContext;
  /** The role this aggregator represents (e.g. "user", "assistant"). */
  role: string;
  /**
   * See the field of the same name on the aggregator-specific params
   * classes. Subclasses propagate this from their `params`.
   */
  addToolChangeMessages?: boolean;
}

/**
 * Base LLM aggregator that uses an LLMContext for conversation storage.
 *
 * This aggregator maintains conversation state using an LLMContext and pushes
 * LLMContextFrame objects as aggregation frames. It provides common
 * functionality for context-based conversation management.
 */
export abstract class LLMContextAggregator extends FrameProcessor {
  // Developer-role messages appended to the context when tools are added/
  // removed via `LLMSetToolsFrame` (only when `addToolChangeMessages` is
  // enabled on the aggregator's params). `{function_names}` is substituted
  // with a sorted, comma-separated, backtick-wrapped list.
  static readonly TOOL_ACTIVATION_MESSAGE_TEMPLATE =
    "The following function(s) have just been added and may now be called: " +
    "{function_names}. Any previously available functions remain available.";
  static readonly TOOL_DEACTIVATION_MESSAGE_TEMPLATE =
    "The following function(s) have just been removed and should not be called: " +
    "{function_names}. Any previously available functions remain available. " +
    "The removed function(s) may become available again later, in which case " +
    "you will be informed.";

  protected _context: LLMContext;
  protected _role: string;
  protected _addToolChangeMessages: boolean;

  protected _aggregation: TextPartForConcatenation[] = [];

  /** Initialize the context response aggregator. */
  constructor(options: LLMContextAggregatorOptions) {
    super(options);
    this._context = options.context;
    this._role = options.role;
    this._addToolChangeMessages = options.addToolChangeMessages ?? false;
  }

  /**
   * Append a developer message describing tool add/remove deltas.
   *
   * No-op unless `addToolChangeMessages` was enabled on the aggregator, and
   * no-op when the diff against the currently advertised tools is empty.
   * Custom (LLM-specific) tools are ignored — only standard tools are diffed.
   *
   * Both aggregators call this on every `LLMSetToolsFrame` they handle.
   * Whichever aggregator handles the frame first computes a real diff against
   * the shared context and adds the announcement; by the time the other
   * aggregator sees it (if at all), the context already reflects the new
   * tools, so its diff is empty and no duplicate message is added. This is
   * order-independent: it works whether the frame flows downstream (user
   * aggregator first) or upstream (assistant aggregator first, and consumed
   * without being forwarded).
   */
  protected _maybeAddToolChangeMessages(newTools: ToolsSchema | NotGiven): void {
    if (!this._addToolChangeMessages) {
      return;
    }

    const names = (tools: ToolsSchema | NotGiven): Set<string> => {
      if (!isGiven(tools)) {
        return new Set();
      }
      return new Set((tools as ToolsSchema).standardTools.map((s) => s.name));
    };

    const oldNames = names(this._context.tools);
    const newNames = names(newTools);
    const added = [...newNames].filter((n) => !oldNames.has(n));
    const removed = [...oldNames].filter((n) => !newNames.has(n));
    if (added.length === 0 && removed.length === 0) {
      return;
    }

    const ctor = this.constructor as typeof LLMContextAggregator;
    const parts: string[] = [];
    if (added.length > 0) {
      const list = added
        .sort()
        .map((n) => `\`${n}\``)
        .join(", ");
      parts.push(ctor.TOOL_ACTIVATION_MESSAGE_TEMPLATE.replaceAll("{function_names}", list));
    }
    if (removed.length > 0) {
      const list = removed
        .sort()
        .map((n) => `\`${n}\``)
        .join(", ");
      parts.push(ctor.TOOL_DEACTIVATION_MESSAGE_TEMPLATE.replaceAll("{function_names}", list));
    }

    this._context.addMessage({ role: "developer", content: parts.join(" ") });
  }

  /** Messages from the LLM context. */
  get messages(): LLMContextMessage[] {
    return this._context.getMessages();
  }

  /** The role for this aggregator. */
  get role(): string {
    return this._role;
  }

  /** The LLMContext instance used by this aggregator. */
  get context(): LLMContext {
    return this._context;
  }

  /**
   * Create a context frame with the current context.
   *
   * @returns LLMContextFrame containing the current context.
   */
  protected _getContextFrame(): LLMContextFrame {
    return new LLMContextFrame({ context: this._context });
  }

  /**
   * Push a context frame in the specified direction.
   *
   * @param direction The direction to push the frame (upstream or downstream).
   */
  async pushContextFrame(direction: FrameDirection = FrameDirection.DOWNSTREAM): Promise<void> {
    const frame = this._getContextFrame();
    await this.pushFrame(frame, direction);
  }

  /**
   * Add messages to the context.
   *
   * @param messages Messages to add to the conversation context.
   */
  addMessages(messages: LLMContextMessage[]): void {
    this._context.addMessages(messages);
  }

  /**
   * Set the context messages.
   *
   * @param messages Messages to replace the current context messages.
   */
  setMessages(messages: LLMContextMessage[]): void {
    this._context.setMessages(messages);
  }

  /**
   * Transform the context messages using a provided function.
   *
   * @param transform A function that takes the current list of messages and
   *   returns a modified list of messages to set in the context.
   */
  transformMessages(transform: (messages: LLMContextMessage[]) => LLMContextMessage[]): void {
    this._context.transformMessages(transform);
  }

  /**
   * Set tools in the context.
   *
   * @param tools List of tool definitions to set in the context.
   */
  setTools(tools: ToolsSchema | NotGiven): void {
    this._context.setTools(tools);
  }

  /**
   * Set tool choice in the context.
   *
   * @param toolChoice Tool choice configuration for the context.
   */
  setToolChoice(toolChoice: "none" | "auto" | "required" | Record<string, unknown>): void {
    this._context.setToolChoice(toolChoice as LLMContextToolChoice);
  }

  /** Reset the aggregation state. */
  async reset(): Promise<void> {
    this._aggregation = [];
  }

  /**
   * Push the current aggregation downstream.
   *
   * @returns The pushed aggregation.
   */
  abstract pushAggregation(): Promise<string>;

  /**
   * Get the current aggregation as a string.
   *
   * @returns The concatenated aggregation string.
   */
  aggregationString(): string {
    return concatenateAggregatedText(this._aggregation);
  }
}

export interface LLMUserAggregatorOptions extends FrameProcessorOptions {
  /** Configuration parameters for aggregation behavior. */
  params?: LLMUserAggregatorParams | null;
  /**
   * Pair-internal. Realtime-mode flag propagated from
   * `LLMContextAggregatorPair` (`null` = auto-configure from service
   * metadata). Not intended for direct use — construct the aggregators via
   * the pair.
   */
  _realtimeServiceMode?: boolean | null;
}

// The pieces of a VADController the aggregator reads in its event handlers.
interface VADControllerAnalyzerAccess {
  _vadAnalyzer: VADAnalyzer;
}

/**
 * User LLM aggregator that aggregates user input during active user turns.
 *
 * This aggregator uses a turn controller and operates within turn boundaries
 * defined by the controller's configured user turn strategies. User turn
 * start strategies indicate when a user turn begins, while user turn stop
 * strategies signal when the user turn has ended.
 *
 * The aggregator collects and aggregates speech-to-text transcriptions that
 * occur while a user turn is active and pushes the final aggregation when the
 * user turn is finished.
 *
 * Event handlers available:
 *
 * - on_user_turn_started: Called when the user turn starts
 * - on_user_turn_stopped: Called when the user turn ends
 * - on_user_turn_stop_timeout: Called when no user turn stop strategy triggers
 * - on_user_turn_idle: Called when the user has been idle for the configured timeout
 * - on_user_turn_message_added: Called when a user message is written to
 *   context. In realtime mode (`realtimeServiceMode: true`) the write is
 *   triggered by the assistant response start rather than the user-turn-end
 *   frame, so this fires decoupled from `on_user_turn_stopped` — subscribe
 *   here for the finalized user text.
 * - on_user_mute_started: Called when the user becomes muted
 * - on_user_mute_stopped: Called when the user becomes unmuted
 * - on_user_backchannel: Called when the user acknowledges the bot without
 *   interrupting it, from a `UserBackchannelFrame`
 *
 * @example
 * aggregator.eventHandler("on_user_turn_started", async (aggregator, strategy: BaseUserTurnStartStrategy) => {});
 * aggregator.eventHandler(
 *   "on_user_turn_stopped",
 *   async (aggregator, strategy: BaseUserTurnStopStrategy, message: UserTurnStoppedMessage) => {},
 * );
 * aggregator.eventHandler("on_user_turn_stop_timeout", async (aggregator) => {});
 * aggregator.eventHandler("on_user_turn_idle", async (aggregator) => {});
 * // In realtime mode the user message is written when the assistant response
 * // starts, not at user-turn-end — subscribe here for the finalized text.
 * aggregator.eventHandler(
 *   "on_user_turn_message_added",
 *   async (aggregator, message: UserTurnMessageAddedMessage) => {},
 * );
 * aggregator.eventHandler("on_user_mute_started", async (aggregator) => {});
 * aggregator.eventHandler("on_user_mute_stopped", async (aggregator) => {});
 * aggregator.eventHandler("on_user_backchannel", async (aggregator, message: UserBackchannelMessage) => {});
 */
export class LLMUserAggregator extends LLMContextAggregator {
  protected _params: LLMUserAggregatorParams;

  // Realtime-mode wiring. null (the default) means auto-configure from
  // service metadata: cascade behavior until a realtime service announces
  // itself, at which point _handleLlmServiceMetadata flips this to true.
  // Explicit true/false force the mode on or off (legacy context writes).
  protected _realtimeServiceMode: boolean | null;

  protected _userIsMuted = false;
  protected _userTurnStartTimestamp = "";
  // One-shot guard: whether the first realtime LLM service metadata frame has
  // been handled this session — see _handleLlmServiceMetadata.
  protected _realtimeMetadataHandled = false;
  // Realtime-mode deferred-flush state. Realtime mode treats the assistant
  // response start as the "user turn ended" signal for context-writing
  // purposes, then waits up to this many seconds for any in-flight
  // `TranscriptionFrame` to land before flushing — mirroring the cascade-mode
  // pattern of waiting up to `ttfsP99Latency` after
  // `UserStoppedSpeakingFrame`. Captured from the most recent
  // `STTMetadataFrame` (which a realtime LLM service may broadcast for its
  // internal STT pass), falling back to `DEFAULT_TTFS_P99`.
  protected _ttfsP99Latency: number | null = null;
  protected _realtimeHandoffFlushTask: Task<unknown> | null = null;
  // Full transcript across the user turn. Each
  // `_onUserTurnInferenceTriggered` push captures only the new segment since
  // the previous push (pushAggregation resets `_aggregation` after writing to
  // context); we accumulate those segments here so the eventual
  // `on_user_turn_stopped` event surfaces the full turn transcript even when
  // several inferences fire before finalization.
  protected _fullUserTurnAggregation: string | null = null;

  // Whether the current user turn interrupted the bot.
  protected _userTurnInterruptedBot = false;
  protected _consecutiveEmptyUserTurnRecoveries = 0;

  // Pair-internal: read by the paired LLMAssistantAggregator.
  _userTurnController: UserTurnController;
  protected _userIdleController: UserIdleController;

  // VAD controller
  protected _vadController: VADController | null = null;

  /**
   * Initialize the user context aggregator.
   *
   * @param context The LLM context for conversation storage.
   */
  constructor(context: LLMContext, options: LLMUserAggregatorOptions = {}) {
    const params = options.params || new LLMUserAggregatorParams();
    super({
      ...options,
      context,
      role: "user",
      addToolChangeMessages: params.addToolChangeMessages,
    });
    this._params = params;

    this._registerEventHandler("on_user_turn_started");
    this._registerEventHandler("on_user_turn_stopped");
    this._registerEventHandler("on_user_turn_stop_timeout");
    this._registerEventHandler("on_user_turn_idle");
    this._registerEventHandler("on_user_turn_inference_triggered");
    this._registerEventHandler("on_user_turn_message_added");
    this._registerEventHandler("on_user_mute_started");
    this._registerEventHandler("on_user_mute_stopped");
    this._registerEventHandler("on_user_backchannel");

    this._realtimeServiceMode = options._realtimeServiceMode ?? null;

    const userTurnStrategies = this._params.userTurnStrategies || new UserTurnStrategies();

    // Realtime-mode strategy mutation: drop the transcription-based start
    // strategy and flip waitForTranscript on stop strategies that expose it,
    // so turn-stop fires as soon as VAD / the turn analyzer / external frames
    // report end-of-speech.
    //
    // This only runs here when realtime mode was explicitly enabled. When
    // it's auto-configured (the default — _realtimeServiceMode is null until a
    // realtime service announces itself), the mutation is deferred to
    // _handleLlmServiceMetadata, which also applies it on top of any
    // service-recommended external strategies.
    if (this._realtimeServiceMode) {
      this._applyRealtimeModeStrategyMutations(
        userTurnStrategies,
        this._params.userTurnStrategies !== null,
      );
      this._disableEmptyUserTurnRecovery();
    }

    this._userTurnController = new UserTurnController({
      userTurnStrategies,
      userTurnStopTimeout: this._params.userTurnStopTimeout,
    });
    this._userTurnController.addEventHandler("on_push_frame", (controller, frame, direction) =>
      this._onPushFrame(controller, frame, direction),
    );
    this._userTurnController.addEventHandler(
      "on_broadcast_frame",
      (controller, frameCls, frameOptions) =>
        this._onBroadcastFrame(controller, frameCls, frameOptions),
    );
    this._userTurnController.addEventHandler("on_user_turn_speculation_cancelled", (controller) =>
      this._onUserTurnSpeculationCancelled(controller),
    );
    this._userTurnController.addEventHandler(
      "on_user_turn_started",
      (controller, strategy, params) => this._onUserTurnStarted(controller, strategy, params),
    );
    this._userTurnController.addEventHandler(
      "on_user_turn_inference_triggered",
      (controller, strategy, speculation) =>
        this._onUserTurnInferenceTriggered(controller, strategy, speculation),
    );
    this._userTurnController.addEventHandler(
      "on_user_turn_stopped",
      (controller, strategy, params) => this._onUserTurnStopped(controller, strategy, params),
    );
    this._userTurnController.addEventHandler("on_user_turn_stop_timeout", (controller) =>
      this._onUserTurnStopTimeout(controller),
    );
    this._userTurnController.addEventHandler("on_reset_aggregation", (controller, strategy) =>
      this._onResetAggregation(controller, strategy),
    );

    this._userIdleController = new UserIdleController({
      userIdleTimeout: this._params.userIdleTimeout,
    });
    this._userIdleController.addEventHandler("on_user_turn_idle", (controller) =>
      this._onUserTurnIdle(controller),
    );

    // VAD controller
    if (this._params.vadAnalyzer) {
      this._vadController = new VADController(this._params.vadAnalyzer, {
        audioIdleTimeout: this._params.audioIdleTimeout,
      });
      this._vadController.addEventHandler("on_speech_started", (controller) =>
        this._onVadSpeechStarted(controller),
      );
      this._vadController.addEventHandler("on_speech_stopped", (controller) =>
        this._onVadSpeechStopped(controller),
      );
      this._vadController.addEventHandler("on_speech_activity", (controller) =>
        this._onVadSpeechActivity(controller),
      );
      this._vadController.addEventHandler("on_push_frame", (controller, frame, direction) =>
        this._onPushFrame(controller, frame, direction),
      );
      this._vadController.addEventHandler(
        "on_broadcast_frame",
        (controller, frameCls, frameOptions) =>
          this._onBroadcastFrame(controller, frameCls, frameOptions),
      );
    }
  }

  /**
   * Set up the aggregator.
   *
   * @param setup Configuration object containing setup parameters.
   */
  override async setup(setup: FrameProcessorSetup): Promise<void> {
    await super.setup(setup);
    if (this._vadController) {
      await this._vadController.setup(setup);
    }

    await this._userTurnController.setup(setup);

    await this._userIdleController.setup(setup);

    for (const s of this._params.userMuteStrategies) {
      await s.setup(setup);
    }
  }

  /** Release this aggregator's resources at teardown. */
  override async cleanup(): Promise<void> {
    await super.cleanup();

    await this._cancelRealtimeHandoffFlushTask();

    if (this._vadController) {
      await this._vadController.cleanup();
    }

    await this._userTurnController.cleanup();
    await this._userIdleController.cleanup();

    for (const s of this._params.userMuteStrategies) {
      await s.cleanup();
    }
  }

  /**
   * Process frames for user speech aggregation and context management.
   *
   * @param frame The frame to process.
   * @param direction The direction of frame flow in the pipeline.
   */
  override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
    await super.processFrame(frame, direction);

    if (await this._maybeMuteFrame(frame)) {
      return;
    }

    if (frame instanceof StartFrame) {
      await this.pushFrame(frame, direction);
      await this._start(frame);
    } else if (frame instanceof EndFrame) {
      // Push EndFrame before stop(), because stop() waits on the task to
      // finish and the task finishes when EndFrame is processed.
      await this.pushFrame(frame, direction);
      await this._stop(frame);
    } else if (frame instanceof CancelFrame) {
      await this._cancel(frame);
      await this.pushFrame(frame, direction);
    } else if (frame instanceof TranscriptionFrame) {
      await this._handleTranscription(frame);
    } else if (
      frame instanceof InterimTranscriptionFrame ||
      frame instanceof TranslationFrame ||
      frame instanceof EagerTranscriptionFrame
    ) {
      // Interim transcriptions, translations and eager end-of-turn
      // transcripts are consumed here and not pushed downstream, same as
      // final TranscriptionFrame. The turn strategies still see them: the
      // controller is fed every frame below.
    } else if (frame instanceof UserBackchannelFrame) {
      const message = new UserBackchannelMessage({
        content: frame.text,
        timestamp: frame.timestamp,
        userId: frame.userId,
      });
      await this._callEventHandler("on_user_backchannel", message);
      await this.pushFrame(frame, direction);
    } else if (frame instanceof LLMRunFrame) {
      await this._handleLlmRun(frame);
    } else if (frame instanceof LLMMessagesAppendFrame) {
      await this._handleLlmMessagesAppend(frame);
    } else if (frame instanceof LLMMessagesUpdateFrame) {
      await this._handleLlmMessagesUpdate(frame);
    } else if (frame instanceof LLMMessagesTransformFrame) {
      await this._handleLlmMessagesTransform(frame);
    } else if (frame instanceof LLMSetToolsFrame) {
      // Normalize and validate (a plain list of direct functions /
      // FunctionSchema objects becomes a ToolsSchema) so the tool-change diff
      // and setTools see a consistent type.
      const normalizedTools = LLMContext._normalizeAndValidateTools(frame.tools);
      this._maybeAddToolChangeMessages(normalizedTools);
      this.setTools(normalizedTools);
      // Push the LLMSetToolsFrame as well, since speech-to-speech LLM
      // services (like OpenAI Realtime) may need to know about tool changes;
      // unlike text-based LLM services they won't just "pick up the change"
      // on the next LLM run, as the LLM is continuously running.
      await this.pushFrame(frame, direction);
    } else if (frame instanceof LLMSetToolChoiceFrame) {
      this.setToolChoice(frame.toolChoice);
    } else if (frame instanceof ServiceMetadataFrame) {
      await this._handleServiceMetadata(frame);
      await this.pushFrame(frame, direction);
    } else if (frame instanceof ProposedUserStartedSpeakingFrame) {
      // A proposal is resolved once. Forwarding one our own strategies
      // resolve would let a resolver further down the pipeline decide the
      // same turn a second time.
      if (!this._userTurnController.resolvesProposedTurnStartFrames) {
        await this.pushFrame(frame, direction);
      }
    } else if (frame instanceof ProposedUserStoppedSpeakingFrame) {
      if (!this._userTurnController.resolvesProposedTurnStopFrames) {
        await this.pushFrame(frame, direction);
      }
    } else {
      await this.pushFrame(frame, direction);
    }

    if (this._vadController) {
      await this._vadController.processFrame(frame);
    }

    await this._userTurnController.processFrame(frame);

    await this._userIdleController.processFrame(frame);
  }

  /** Push the current aggregation. */
  async pushAggregation(): Promise<string> {
    return await this._pushAggregation();
  }

  /**
   * Write the aggregated user turn to the context.
   *
   * @param options.runLlm Whether to emit the LLMContextFrame that runs
   *   inference. False when the response is already generated — an eager end
   *   of turn that held — and only the context write is still owed.
   * @returns The text written, or "" when there was nothing to write.
   */
  protected async _pushAggregation(options: { runLlm?: boolean } = {}): Promise<string> {
    const runLlm = options.runLlm ?? true;
    if (this._aggregation.length === 0) {
      return "";
    }

    const aggregation = this.aggregationString();
    await this.reset();
    this._context.addMessage({ role: this.role, content: aggregation });
    await this.broadcastFrame(LLMContextUserTurnFrame, {
      text: aggregation,
      timestamp: this._userTurnStartTimestamp,
    });
    if (runLlm) {
      await this.pushContextFrame();
    }

    const message = new UserTurnMessageAddedMessage({
      content: aggregation,
      timestamp: this._userTurnStartTimestamp,
    });
    await this._callEventHandler("on_user_turn_message_added", message);

    return aggregation;
  }

  protected async _start(_frame: StartFrame): Promise<void> {
    await this._startControllers();
  }

  protected async _stop(_frame: EndFrame): Promise<void> {
    if (this._realtimeServiceMode) {
      // Realtime mode: cancel any pending deferred handoff flush and commit
      // trailing user content directly. The on_user_turn_stopped event
      // already fired (if turn frames were emitted), so don't re-fire it from
      // session end.
      await this._cancelRealtimeHandoffFlushTask();
      await this.pushAggregation();
    } else {
      await this._maybeEmitUserTurnStopped({ onSessionEnd: true });
    }
    await this._stopControllers();
  }

  protected async _cancel(_frame: CancelFrame): Promise<void> {
    // See _stop — same realtime-mode vs cascade dispatch.
    if (this._realtimeServiceMode) {
      await this._cancelRealtimeHandoffFlushTask();
      await this.pushAggregation();
    } else {
      await this._maybeEmitUserTurnStopped({ onSessionEnd: true });
    }
    await this._stopControllers();
  }

  /**
   * Mutate turn strategies for realtime mode.
   *
   * Drops `TranscriptionUserTurnStartStrategy` from the start strategies
   * (transcripts shouldn't start a turn when the realtime service drives the
   * conversation) and flips `waitForTranscript = false` on stop strategies
   * that expose the flag, so end-of-turn fires as soon as VAD / the turn
   * analyzer reports end-of-speech.
   */
  protected _applyRealtimeModeStrategyMutations(
    userTurnStrategies: UserTurnStrategies,
    areUserProvidedCustomStrategies: boolean,
  ): void {
    const startStrategies = userTurnStrategies.start ?? [];
    const dropped: string[] = [];
    const keptStart: BaseUserTurnStartStrategy[] = [];
    for (const s of startStrategies) {
      if (s instanceof TranscriptionUserTurnStartStrategy) {
        dropped.push(s.constructor.name);
      } else {
        keptStart.push(s);
      }
    }
    userTurnStrategies.start = keptStart;

    const flipped: string[] = [];
    for (const s of userTurnStrategies.stop ?? []) {
      // The flag is a property on some stop strategies, not on the base.
      const withFlag = s as unknown as { waitForTranscript?: boolean };
      if (withFlag.waitForTranscript) {
        try {
          withFlag.waitForTranscript = false;
          flipped.push(s.constructor.name);
        } catch (e) {
          rethrowIfCancelled(e);
          // Strategy exposes the property but no setter — skip.
          if (!(e instanceof TypeError)) throw e;
        }
      }
    }

    if (dropped.length === 0 && flipped.length === 0) {
      return;
    }

    const msg =
      `${this}: realtime mode — mutated turn strategies: ` +
      `dropped ${dropped.length > 0 ? reprList(dropped) : "no"} start strategy(ies); set ` +
      `wait_for_transcript=False on ${flipped.length > 0 ? reprList(flipped) : "no"} stop strategy(ies).`;
    if (areUserProvidedCustomStrategies) {
      logger.warning(msg);
    } else {
      logger.debug(msg);
    }
  }

  /**
   * Turn off empty user turn recovery for realtime mode.
   *
   * A realtime LLM service hears the user's audio directly, so an empty
   * transcript doesn't mean the model missed the speech.
   */
  protected _disableEmptyUserTurnRecovery(): void {
    if (this._params.emptyUserTurn === null) {
      return;
    }
    this._params.emptyUserTurn = null;
    logger.debug(
      `${this}: realtime mode — empty user turn recovery disabled; the realtime ` +
        "LLM service hears the user's audio directly.",
    );
  }

  /**
   * Dispatch a service metadata frame.
   *
   * Any service may recommend user turn strategies via the base
   * `userTurnStrategies` field, so apply that first — regardless of service
   * type or realtime mode — then run type-specific handling.
   */
  protected async _handleServiceMetadata(frame: ServiceMetadataFrame): Promise<void> {
    await this._handleServiceUserTurnStrategies(frame.serviceName, frame.userTurnStrategies);
    if (frame instanceof STTMetadataFrame) {
      await this._handleSttMetadata(frame);
    } else if (frame instanceof LLMServiceMetadataFrame) {
      await this._handleLlmServiceMetadata(frame);
    }
  }

  /**
   * Handle an `STTMetadataFrame` broadcast by an STT service at start.
   *
   * Captures the STT TTFS P99 so the realtime-mode deferred handoff flush can
   * size itself to the real transcript-arrival latency. Any recommended user
   * turn strategies were already applied by `_handleServiceMetadata`.
   */
  protected async _handleSttMetadata(frame: STTMetadataFrame): Promise<void> {
    this._ttfsP99Latency = frame.ttfsP99Latency;
  }

  /**
   * Apply user turn strategies a service recommends via its metadata frame.
   *
   * Honored only when the user did not pass their own `userTurnStrategies`,
   * which always wins. `updateStrategies` is idempotent, so this is safe to
   * re-run on a later broadcast (e.g. a ServiceSwitcher switch).
   */
  protected async _handleServiceUserTurnStrategies(
    serviceName: string,
    userTurnStrategies: UserTurnStrategies | null,
  ): Promise<void> {
    if (userTurnStrategies === null || userTurnStrategies === undefined) {
      return;
    }

    if (this._params.userTurnStrategies !== null) {
      logger.debug(
        `${this}: ignoring user turn strategies recommended by ` +
          `\`${serviceName}\`; using the user-provided strategies.`,
      );
      this._warnOnDiscardedInterruptionSetting(serviceName, userTurnStrategies);
      return;
    }

    logger.debug(`${this}: applying user turn strategies recommended by \`${serviceName}\`.`);
    await this._userTurnController.updateStrategies(userTurnStrategies);
  }

  /**
   * Warn when (maybe unintentionally) overruling a service silently turns interruptions back on.
   *
   * A service recommends turn strategies by putting them on its
   * `ServiceMetadataFrame.userTurnStrategies`, and one configured with
   * `shouldInterrupt: false` carries that setting there. User-provided
   * strategies discard the recommendation whole — so the pipeline would
   * start interrupting with no indication why.
   *
   * Passing `ExternalUserTurnStrategies` explicitly was a safe way to opt out
   * of the recommendation until 1.8.0, because the external start strategy
   * never interrupted no matter how it was constructed. It broadcasts the
   * interruption now, so explicit strategies can contradict the service, and
   * this warning names the two ways to reconcile them.
   *
   * Only that container is checked. A `UserTurnStrategies` assembled by hand
   * around a bare `ExternalUserTurnStartStrategy` contradicts the service the
   * same way and goes unwarned — not expected to come up often enough to
   * justify inspecting the individual strategies.
   */
  protected _warnOnDiscardedInterruptionSetting(
    serviceName: string,
    recommended: UserTurnStrategies,
  ): void {
    if (!(recommended instanceof ExternalUserTurnStrategies)) {
      return;
    }
    if (recommended.enableInterruptions) {
      return;
    }

    const provided = this._params.userTurnStrategies;
    if (!(provided instanceof ExternalUserTurnStrategies) || !provided.enableInterruptions) {
      return;
    }

    logger.warning(
      `${this}: \`${serviceName}\` asked for interruptions to stay off, but the ` +
        "user-provided `ExternalUserTurnStrategies` leaves them on, so the bot will " +
        "be interrupted when the user starts speaking. Drop `user_turn_strategies` to " +
        "use the service's recommendation, or pass " +
        "`ExternalUserTurnStrategies(enable_interruptions=False)`.",
    );
  }

  /**
   * Handle an `LLMServiceMetadataFrame` broadcast by an LLM service.
   *
   * Non-realtime services need no configuration. For a realtime service,
   * auto-configure `realtimeServiceMode` (once) when the user left it unset
   * (`null`); an explicit `true`/`false` is honored as-is (`false` opts out
   * silently). When the mode is active, strip transcript dependence from the
   * active strategies — including any external strategies
   * `_handleServiceMetadata` just adopted.
   *
   * The strategy mutation re-runs on every broadcast (so a re-adopted
   * recommendation is re-mutated, e.g. after a ServiceSwitcher switch); only
   * the auto-configuration + log is one-shot. `updateStrategies` is
   * idempotent, so re-applying is safe.
   */
  protected async _handleLlmServiceMetadata(frame: LLMServiceMetadataFrame): Promise<void> {
    if (!frame.isRealtimeService) {
      return;
    }

    // Auto-configure + log once per session.
    if (!this._realtimeMetadataHandled) {
      this._realtimeMetadataHandled = true;
      if (this._realtimeServiceMode === null) {
        this._realtimeServiceMode = true;
        logger.debug(
          `${this}: detected realtime service \`${frame.serviceName}\`; ` +
            "auto-enabled realtime_service_mode.",
        );
      }
    }

    if (!this._realtimeServiceMode) {
      // Explicitly disabled — honor it silently; the user opted out.
      return;
    }

    this._disableEmptyUserTurnRecovery();

    const strategies = this._userTurnController.userTurnStrategies;
    this._applyRealtimeModeStrategyMutations(strategies, this._params.userTurnStrategies !== null);
    await this._userTurnController.updateStrategies(strategies);
  }

  /**
   * Commit the user message in realtime mode, allowing for late transcripts.
   *
   * Called by the paired assistant half when the assistant response starts —
   * realtime mode treats that as the user turn's end signal for
   * context-writing purposes (in place of `UserStoppedSpeakingFrame`).
   * Realtime services may deliver the finalized user `TranscriptionFrame` in
   * pieces, and some deliver it only after the assistant starts responding,
   * so we always defer the flush by `ttfsP99Latency` to let any in-flight
   * transcript land. The `_realtimeHandoffFlushImmediate` failsafe on
   * `LLMFullResponseEndFrame` catches any stragglers.
   *
   * Pair-internal: called by the paired LLMAssistantAggregator.
   */
  async _realtimeHandoffFlush(): Promise<void> {
    // Cancel any prior deferred flush task — a new turn supersedes it.
    await this._cancelRealtimeHandoffFlushTask();

    this._realtimeHandoffFlushTask = this.createTask(
      () => this._realtimeDeferredHandoffFlush(),
      `${this}::realtime_handoff_flush`,
    );
  }

  /** Wait one `ttfsP99Latency` window, then flush whatever has arrived. */
  protected async _realtimeDeferredHandoffFlush(): Promise<void> {
    const wait = this._ttfsP99Latency !== null ? this._ttfsP99Latency : DEFAULT_TTFS_P99;
    await sleep(wait);
    if (this._aggregation.length > 0) {
      await this.pushAggregation();
      this._userTurnStartTimestamp = "";
    }
  }

  /**
   * Failsafe flush invoked when the assistant response ends.
   *
   * By the time the assistant response has fully completed, even slow
   * transcripts should have landed. Cancel any pending deferred flush and
   * write the user message now so it precedes the assistant message in
   * context.
   *
   * Pair-internal: called by the paired LLMAssistantAggregator.
   */
  async _realtimeHandoffFlushImmediate(): Promise<void> {
    await this._cancelRealtimeHandoffFlushTask();
    if (this._aggregation.length > 0) {
      await this.pushAggregation();
      this._userTurnStartTimestamp = "";
    }
  }

  protected async _cancelRealtimeHandoffFlushTask(): Promise<void> {
    if (this._realtimeHandoffFlushTask === null) {
      return;
    }
    if (!this._realtimeHandoffFlushTask.done()) {
      await this.cancelTask(this._realtimeHandoffFlushTask);
    }
    this._realtimeHandoffFlushTask = null;
  }

  protected async _startControllers(): Promise<void> {
    if (this._vadController) {
      await this._vadController.start();
    }
    await this._userTurnController.start();
  }

  protected async _stopControllers(): Promise<void> {
    // At session end the controllers' timers can only report what ending
    // looks like: no audio arriving, no turn finishing, the user idle. They
    // stop here, while what they hold (the VAD analyzer, the turn strategies)
    // may be shared and is released in cleanup() instead.
    await this._cancelRealtimeHandoffFlushTask();
    if (this._vadController) {
      await this._vadController.stop();
    }
    await this._userTurnController.stop();
    await this._userIdleController.stop();
  }

  protected async _maybeMuteFrame(frame: Frame): Promise<boolean> {
    // Lifecycle frames should never be muted and should not trigger mute
    // state changes. Evaluating mute strategies on StartFrame would broadcast
    // UserMuteStartedFrame before StartFrame reaches downstream processors.
    if (frame instanceof StartFrame || frame instanceof EndFrame || frame instanceof CancelFrame) {
      return false;
    }

    const shouldMuteFrame =
      this._userIsMuted &&
      (frame instanceof InterruptionFrame ||
        frame instanceof VADUserStartedSpeakingFrame ||
        frame instanceof VADUserStoppedSpeakingFrame ||
        frame instanceof ProposedUserStartedSpeakingFrame ||
        frame instanceof ProposedUserStoppedSpeakingFrame ||
        frame instanceof UserStartedSpeakingFrame ||
        frame instanceof UserStoppedSpeakingFrame ||
        frame instanceof InputAudioRawFrame ||
        frame instanceof InterimTranscriptionFrame ||
        frame instanceof TranscriptionFrame ||
        frame instanceof EagerTranscriptionFrame ||
        frame instanceof UserBackchannelFrame);

    if (shouldMuteFrame) {
      logger.trace(`${frame.name} suppressed - user currently muted`);
    }

    let shouldMuteNextTime = false;
    for (const s of this._params.userMuteStrategies) {
      // Every strategy sees the frame, so no short-circuiting.
      const mute = await s.processFrame(frame);
      shouldMuteNextTime = shouldMuteNextTime || Boolean(mute);
    }

    if (shouldMuteNextTime !== this._userIsMuted) {
      logger.debug(`${this}: user is now ${shouldMuteNextTime ? "muted" : "unmuted"}`);
      this._userIsMuted = shouldMuteNextTime;

      // Emit mute state change events
      if (this._userIsMuted) {
        await this._callEventHandler("on_user_mute_started");
        await this.broadcastFrame(UserMuteStartedFrame);
      } else {
        await this._callEventHandler("on_user_mute_stopped");
        await this.broadcastFrame(UserMuteStoppedFrame);
      }
    }

    return shouldMuteFrame;
  }

  protected async _handleLlmRun(_frame: LLMRunFrame): Promise<void> {
    await this.pushContextFrame();
  }

  protected async _handleLlmMessagesAppend(frame: LLMMessagesAppendFrame): Promise<void> {
    this.addMessages(frame.messages);
    if (frame.runLlm) {
      await this.pushContextFrame();
    }
  }

  protected async _handleLlmMessagesUpdate(frame: LLMMessagesUpdateFrame): Promise<void> {
    this.setMessages(frame.messages);
    if (frame.runLlm) {
      await this.pushContextFrame();
    }
  }

  protected async _handleLlmMessagesTransform(frame: LLMMessagesTransformFrame): Promise<void> {
    this.transformMessages(frame.transform);
    if (frame.runLlm) {
      await this.pushContextFrame();
    }
  }

  protected async _handleTranscription(frame: TranscriptionFrame): Promise<void> {
    const text = frame.text;

    // Make sure we really have some text.
    if (!text.trim()) {
      return;
    }

    // In realtime mode with a service that doesn't emit user-turn frames
    // (Gemini Live, AWS Nova Sonic, Ultravox), `_onUserTurnStarted` never
    // fires, so seed `_userTurnStartTimestamp` here from the first transcript
    // so the eventual `on_user_turn_message_added` event carries one.
    // Harmless in cascade mode — turn frames set it before this runs (the
    // timestamp check is a no-op).
    if (!this._userTurnStartTimestamp) {
      this._userTurnStartTimestamp = timeNowIso8601();
    }

    // Transcriptions never include inter-part spaces (so far).
    this._aggregation.push(
      new TextPartForConcatenation({
        text,
        includesInterPartSpaces: frame.includesInterFrameSpaces,
      }),
    );
  }

  /**
   * Broadcasts a frame upstream and queues it for internal processing.
   *
   * Queues the frame so it flows through `processFrame` and is handled
   * internally (e.g. by the `UserTurnController`). The upstream frame is
   * pushed directly.
   *
   * @param frameCls The class of the frame to be broadcasted.
   * @param options Options to be passed to the frame's constructor.
   */
  protected async _queuedBroadcastFrame<O>(
    frameCls: new (options: O) => Frame,
    options?: O,
  ): Promise<void> {
    await this.queueFrame(new frameCls(options as O));
    await this.pushFrame(new frameCls(options as O), FrameDirection.UPSTREAM);
  }

  protected async _onPushFrame(
    _controller: unknown,
    frame: Frame,
    direction: FrameDirection = FrameDirection.DOWNSTREAM,
  ): Promise<void> {
    await this.queueFrame(frame, direction);
  }

  protected async _onBroadcastFrame<O>(
    _controller: unknown,
    frameCls: new (options: O) => Frame,
    options?: O,
  ): Promise<void> {
    await this._queuedBroadcastFrame(frameCls, options);
  }

  protected async _onUserTurnSpeculationCancelled(_controller: unknown): Promise<void> {
    // Broadcast rather than queued, so it reaches a downstream gate ahead of
    // the turn end that follows it. Queued, it would arrive after, and the
    // gate would release the response this withdraws.
    await this.broadcastFrame(EagerEndOfTurnCancelFrame);
  }

  protected async _onVadSpeechStarted(controller: VADController): Promise<void> {
    const analyzer = (controller as unknown as VADControllerAnalyzerAccess)._vadAnalyzer;
    await this._queuedBroadcastFrame(VADUserStartedSpeakingFrame, {
      startSecs: analyzer.params.startSecs,
    });
  }

  protected async _onVadSpeechStopped(controller: VADController): Promise<void> {
    const analyzer = (controller as unknown as VADControllerAnalyzerAccess)._vadAnalyzer;
    await this._queuedBroadcastFrame(VADUserStoppedSpeakingFrame, {
      stopSecs: analyzer.params.stopSecs,
    });
  }

  protected async _onVadSpeechActivity(_controller: VADController): Promise<void> {
    await this._queuedBroadcastFrame(UserSpeakingFrame);
  }

  protected async _onUserTurnStarted(
    _controller: UserTurnController,
    strategy: BaseUserTurnStartStrategy,
    params: UserTurnStartedParams,
  ): Promise<void> {
    logger.debug(`${this}: User started speaking (strategy: ${strategy})`);

    this._userTurnStartTimestamp = timeNowIso8601();
    this._fullUserTurnAggregation = null;

    // Unless the bot is waiting for the user, it's thinking, speaking or
    // running a function call, and the interruption below cancels that.
    this._userTurnInterruptedBot =
      params.enableInterruptions && !this._userIdleController.waitingForUser;

    if (params.enableUserSpeakingFrames) {
      await this.broadcastFrame(UserStartedSpeakingFrame);
    }

    await this._userIdleController.processFrame(new UserStartedSpeakingFrame());

    if (params.enableInterruptions) {
      await this.broadcastInterruption();
    }

    await this._callEventHandler("on_user_turn_started", strategy);
  }

  protected async _onUserTurnInferenceTriggered(
    _controller: UserTurnController,
    strategy: BaseUserTurnStopStrategy,
    speculation: UserTurnSpeculation | null = null,
  ): Promise<void> {
    if (this._realtimeServiceMode) {
      // Realtime mode: the assistant response start, not turn frames, is the
      // signal that the user turn has ended for context-writing purposes.
      // Fire the event without pushing aggregation here.
      logger.debug(
        `${this}: User turn inference triggered (strategy: ${strategy}) ` +
          "[realtime mode: event-only, no context push]",
      );
      await this._callEventHandler("on_user_turn_inference_triggered", strategy);
      return;
    }

    if (speculation) {
      logger.debug(`${this}: User turn inference triggered speculatively (strategy: ${strategy})`);
      await this._runSpeculativeInference(speculation);
      await this._callEventHandler("on_user_turn_inference_triggered", strategy);
      return;
    }

    logger.debug(`${this}: User turn inference triggered (strategy: ${strategy})`);

    // Push aggregation now: this writes the user message segment to the
    // context and emits LLMContextFrame, which kicks LLM inference.
    // Concatenate the segment into `_fullUserTurnAggregation` so multiple
    // inferences in the same turn don't lose earlier segments from the
    // eventual `on_user_turn_stopped` event.
    const segment = await this.pushAggregation();
    if (segment) {
      if (this._fullUserTurnAggregation) {
        this._fullUserTurnAggregation = `${this._fullUserTurnAggregation} ${segment}`.trim();
      } else {
        this._fullUserTurnAggregation = segment;
      }
    }

    await this._callEventHandler("on_user_turn_inference_triggered", strategy);
  }

  /**
   * Run an inference for a turn that hasn't ended yet.
   *
   * The turn is still open, so the context must not record it. The inference
   * runs against a provisional copy carrying the speculated turn text:
   * nothing here mutates the real context, and `_aggregation` keeps
   * accumulating for whenever the turn does end. The response is held
   * downstream until the turn is confirmed, and discarded if it isn't.
   *
   * @param speculation The speculation to run, from the stop strategy that
   *   started it.
   */
  protected async _runSpeculativeInference(speculation: UserTurnSpeculation): Promise<void> {
    const provisional = new LLMContext({
      messages: [...this._context.messages, { role: this.role, content: speculation.text }],
      tools: this._context.tools,
      toolChoice: this._context.toolChoice,
    });
    await this.pushFrame(new LLMContextFrame({ context: provisional, speculation: true }));
  }

  protected async _onUserTurnStopped(
    _controller: UserTurnController,
    strategy: BaseUserTurnStopStrategy,
    params: UserTurnStoppedParams,
  ): Promise<void> {
    logger.debug(`${this}: User stopped speaking (strategy: ${strategy})`);

    if (params.enableUserSpeakingFrames) {
      await this.broadcastFrame(UserStoppedSpeakingFrame);
    }

    await this._userIdleController.processFrame(new UserStoppedSpeakingFrame());

    if (this._realtimeServiceMode) {
      // Realtime mode: the user message isn't finalized at turn-stop time —
      // the assistant response start is the effective end-of-turn signal,
      // and the user message is written then. Content is null here;
      // subscribers wanting the finalized text use on_user_turn_message_added
      // instead.
      const message = new UserTurnStoppedMessage({
        content: null,
        timestamp: this._userTurnStartTimestamp,
      });
      await this._callEventHandler("on_user_turn_stopped", strategy, message);
      return;
    }

    // A turn end that confirms a speculation has its response already: the
    // context write is all that's left, and running inference again would
    // answer the same turn twice.
    await this._maybeEmitUserTurnStopped({
      strategy,
      runLlm: !params.confirmsSpeculation,
    });
  }

  protected async _onResetAggregation(
    _controller: UserTurnController,
    strategy: BaseUserTurnStartStrategy,
  ): Promise<void> {
    logger.debug(`${this}: Resetting aggregation (strategy: ${strategy})`);
    await this.reset();
  }

  protected async _onUserTurnStopTimeout(_controller: unknown): Promise<void> {
    await this._callEventHandler("on_user_turn_stop_timeout");
  }

  protected async _onUserTurnIdle(_controller: unknown): Promise<void> {
    await this._callEventHandler("on_user_turn_idle");
  }

  /**
   * Maybe emit user turn stopped event.
   *
   * Earlier inference triggers in the same turn have already pushed their
   * segments to the context and accumulated them into
   * `this._fullUserTurnAggregation`. Any aggregation that arrived after the
   * last inference trigger is flushed here so end-of-turn content is never
   * lost from the public event.
   *
   * @param options.strategy The strategy that triggered the turn stop.
   * @param options.onSessionEnd If true, only emit if there's unemitted
   *   content (avoids duplicate events when session ends).
   * @param options.runLlm Whether the context write should run inference.
   */
  protected async _maybeEmitUserTurnStopped(
    options: {
      strategy?: BaseUserTurnStopStrategy | null;
      onSessionEnd?: boolean;
      runLlm?: boolean;
    } = {},
  ): Promise<void> {
    const strategy = options.strategy ?? null;
    const onSessionEnd = options.onSessionEnd ?? false;
    const runLlm = options.runLlm ?? true;

    const segment = await this._pushAggregation({ runLlm });
    const fullAggregation = this._fullUserTurnAggregation;
    this._fullUserTurnAggregation = null;

    let content: string;
    if (segment && fullAggregation) {
      content = `${fullAggregation} ${segment}`.trim();
    } else {
      content = fullAggregation || segment;
    }

    if (!onSessionEnd || content) {
      const message = new UserTurnStoppedMessage({
        content,
        timestamp: this._userTurnStartTimestamp,
      });
      await this._callEventHandler("on_user_turn_stopped", strategy, message);
      this._userTurnStartTimestamp = "";
    }

    const interruptedBot = this._userTurnInterruptedBot;
    this._userTurnInterruptedBot = false;

    if (content) {
      this._consecutiveEmptyUserTurnRecoveries = 0;
    } else if (!onSessionEnd) {
      // An empty turn doesn't run the LLM, so the bot stays silent unless a
      // recovery runs it. Without one, restart the idle timer, which this
      // turn's start cancelled.
      if (!(await this._maybeRecoverEmptyUserTurn(interruptedBot))) {
        await this._userIdleController.waitForUser();
      }
    }
  }

  /**
   * Run the LLM for a user turn that ended with no transcript.
   *
   * @param interruptedBot Whether the turn interrupted a response in progress.
   * @returns Whether the LLM was asked to respond.
   */
  protected async _maybeRecoverEmptyUserTurn(interruptedBot: boolean): Promise<boolean> {
    const config = this._params.emptyUserTurn;
    if (!config) {
      return false;
    }

    const prompt = interruptedBot ? config.interruptedPrompt : config.idlePrompt;
    if (!prompt) {
      return false;
    }

    if (this._consecutiveEmptyUserTurnRecoveries >= config.maxConsecutiveRecoveries) {
      logger.debug(`${this}: Empty user turn left unanswered (too many in a row)`);
      return false;
    }

    // A pending function call result runs the LLM itself, and a muted user
    // shouldn't be prompted to speak.
    if (this._userIsMuted || this._userIdleController.functionCallsInProgress) {
      return false;
    }

    logger.debug(
      `${this}: Empty user turn (${interruptedBot ? "interrupted" : "idle"}), running LLM`,
    );
    this._consecutiveEmptyUserTurnRecoveries += 1;
    this._context.addMessage({ role: "developer", content: prompt });
    await this.pushContextFrame();
    return true;
  }
}

export interface LLMAssistantAggregatorOptions extends FrameProcessorOptions {
  /** Configuration parameters for aggregation behavior. */
  params?: LLMAssistantAggregatorParams | null;
  /**
   * Pair-internal. Realtime-mode flag propagated from
   * `LLMContextAggregatorPair` (`null` = auto-configure from service
   * metadata). Not intended for direct use — construct the aggregators via
   * the pair.
   */
  _realtimeServiceMode?: boolean | null;
  /**
   * Pair-internal. Back-reference to the paired `LLMUserAggregator`. The
   * assistant flushes it on `LLMFullResponseStartFrame` so the user message
   * lands in context before the assistant turn starts.
   */
  _pairedUserAggregator?: LLMUserAggregator | null;
}

/**
 * Assistant LLM aggregator that processes bot responses and function calls.
 *
 * This aggregator handles the complex logic of processing assistant
 * responses including:
 *
 * - Text frame aggregation between response start/end markers
 * - Function call lifecycle management
 * - Context updates with timestamps
 * - Tool execution and result handling
 * - Interruption handling during responses
 *
 * The aggregator manages function calls in progress and coordinates between
 * text generation and tool execution phases of LLM responses.
 *
 * Event handlers available:
 *
 * - on_assistant_turn_started: Called when the assistant turn starts
 * - on_assistant_turn_stopped: Called when the assistant turn ends
 * - on_assistant_thought: Called when an assistant thought is available
 * - on_assistant_backchannel: Called when the assistant starts saying text of
 *   type `backchannel`, such as a `BotBackchannelFrame`
 * - on_summary_applied: Called when a context summarization is applied
 *
 * @example
 * aggregator.eventHandler("on_assistant_turn_started", async (aggregator) => {});
 * aggregator.eventHandler(
 *   "on_assistant_turn_stopped",
 *   async (aggregator, message: AssistantTurnStoppedMessage) => {},
 * );
 * aggregator.eventHandler("on_assistant_thought", async (aggregator, message: AssistantThoughtMessage) => {});
 * aggregator.eventHandler(
 *   "on_assistant_backchannel",
 *   async (aggregator, message: AssistantBackchannelMessage) => {},
 * );
 * aggregator.eventHandler(
 *   "on_summary_applied",
 *   async (aggregator, summarizer: LLMContextSummarizer, event: SummaryAppliedEvent) => {},
 * );
 */
export class LLMAssistantAggregator extends LLMContextAggregator {
  protected _params: LLMAssistantAggregatorParams;

  // Realtime-mode wiring. null (the default) auto-configures from service
  // metadata, mirroring the user half (see LLMUserAggregator constructor).
  protected _realtimeServiceMode: boolean | null;
  protected _pairedUserAggregator: LLMUserAggregator | null;

  protected _functionCallsInProgress = new Map<string, FunctionCallInProgressFrame | null>();
  protected _functionCallsImageResults = new Map<string, UserImageRawFrame>();
  // Markers seen on LLMMarkerFrames, so a service configured with markers
  // other than the defaults still gets them stripped from transcripts.
  protected _seenTurnMarkers = new Set<string>();
  protected _contextUpdatedTasks = new Set<Task<unknown>>();

  protected _userSpeaking = false;
  protected _botSpeaking = false;

  // When a function call result arrives while the bot is speaking, we defer
  // the LLM re-invocation until the bot stops speaking. This flag is set to
  // true in that case so that `BotStoppedSpeakingFrame` knows to push a
  // context frame. Multiple results arriving in the same speaking window are
  // bundled into a single deferred push.
  protected _pushContextOnBotStoppedSpeaking = false;

  // A function call result asked to run inference and the push hasn't
  // happened yet: it was held for results still queued, or for a user who is
  // speaking. Whichever result is handled once the way is clear makes the
  // push, whatever its own `runLlm` says. A run that starts meanwhile, such
  // as the one the user's turn brings, settles it: that run sees the context
  // as it stands. A user turn with nothing in it brings no run, so the push
  // stays owed until the next arrival.
  protected _contextPushOwed = false;

  protected _assistantTurnStartTimestamp = "";

  protected _thoughtAppendToContext = false;
  protected _thoughtLlm = "";
  protected _thoughtAggregation: TextPartForConcatenation[] = [];
  protected _thoughtStartTime = "";

  protected _summarizer: LLMContextSummarizer | null;

  /**
   * Initialize the assistant context aggregator.
   *
   * @param context The LLM context for conversation storage.
   */
  constructor(context: LLMContext, options: LLMAssistantAggregatorOptions = {}) {
    const params = options.params || new LLMAssistantAggregatorParams();
    super({
      ...options,
      context,
      role: "assistant",
      addToolChangeMessages: params.addToolChangeMessages,
    });
    this._params = params;

    this._realtimeServiceMode = options._realtimeServiceMode ?? null;
    this._pairedUserAggregator = options._pairedUserAggregator ?? null;

    // Context summarization — always create the summarizer so that manually
    // pushed LLMSummarizeContextFrame frames are always handled.
    // Auto-triggering based on thresholds is only enabled when
    // enableAutoContextSummarization is true.
    this._summarizer = new LLMContextSummarizer({
      context: this._context,
      config: this._params.autoContextSummarizationConfig,
      autoTrigger: this._params.enableAutoContextSummarization,
    });
    this._summarizer.addEventHandler("on_request_summarization", (summarizer, frame) =>
      this._onRequestSummarization(summarizer, frame),
    );
    this._summarizer.addEventHandler("on_summary_applied", (summarizer, event) =>
      this._onSummaryApplied(summarizer, event),
    );

    this._registerEventHandler("on_assistant_turn_started");
    this._registerEventHandler("on_assistant_turn_stopped");
    this._registerEventHandler("on_assistant_thought");
    this._registerEventHandler("on_assistant_backchannel");
    this._registerEventHandler("on_summary_applied");
  }

  /** Whether there are any function calls currently in progress. */
  get hasFunctionCallsInProgress(): boolean {
    return this._functionCallsInProgress.size > 0;
  }

  /**
   * Whether a synchronous call is in flight, one whose result the model waits for.
   *
   * A synchronous call leaves the context without its result until it
   * returns, so the model cannot run in the meantime; an asynchronous one
   * (`cancelOnInterruption: false`) has a placeholder result in the context
   * and the model runs on. A call announced but not yet started counts as
   * synchronous.
   */
  get hasSynchronousFunctionCallsInProgress(): boolean {
    for (const frame of this._functionCallsInProgress.values()) {
      if (frame === null || frame.cancelOnInterruption) {
        return true;
      }
    }
    return false;
  }

  /**
   * Set up the aggregator.
   *
   * @param setup Configuration object containing setup parameters.
   */
  override async setup(setup: FrameProcessorSetup): Promise<void> {
    await super.setup(setup);
    if (this._summarizer) {
      await this._summarizer.setup(setup);
    }
  }

  /** Release this aggregator's resources at teardown. */
  override async cleanup(): Promise<void> {
    await super.cleanup();
    await this._cleanup();
  }

  /** Reset the aggregation state. */
  override async reset(): Promise<void> {
    await super.reset();
    await this._resetThoughtAggregation(); // Just to be safe
    this._pushContextOnBotStoppedSpeaking = false;
    this._contextPushOwed = false;
  }

  /** Reset the thought aggregation state. */
  protected async _resetThoughtAggregation(): Promise<void> {
    this._thoughtAppendToContext = false;
    this._thoughtLlm = "";
    this._thoughtAggregation = [];
  }

  /**
   * Process frames for assistant response aggregation and function call management.
   *
   * @param frame The frame to process.
   * @param direction The direction of frame flow in the pipeline.
   */
  override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
    await super.processFrame(frame, direction);

    if (frame instanceof StartFrame) {
      // Push StartFrame before start(), because we want StartFrame to be
      // processed by every processor before any other frame is processed.
      await this.pushFrame(frame, direction);
      await this._start(frame);
    } else if (frame instanceof InterruptionFrame) {
      await this._handleInterruptions(frame);
      await this.pushFrame(frame, direction);
    } else if (frame instanceof EndFrame || frame instanceof CancelFrame) {
      await this._handleEndOrCancel(frame);
      await this.pushFrame(frame, direction);
    } else if (frame instanceof LLMAssistantPushAggregationFrame) {
      await this._handlePushAggregation();
    } else if (frame instanceof TTSStartedFrame) {
      await this._handleTtsStarted(frame);
      await this.pushFrame(frame, direction);
    } else if (frame instanceof LLMFullResponseStartFrame) {
      this._contextPushOwed = false;
      await this._handleLlmStart(frame);
    } else if (frame instanceof LLMFullResponseEndFrame) {
      await this._handleLlmEnd(frame);
    } else if (frame instanceof TextFrame) {
      await this._handleText(frame);
    } else if (frame instanceof LLMMarkerFrame) {
      await this._handleMarkerFrame(frame);
    } else if (frame instanceof LLMThoughtStartFrame) {
      await this._handleThoughtStart(frame);
    } else if (frame instanceof LLMThoughtTextFrame) {
      await this._handleThoughtText(frame);
    } else if (frame instanceof LLMThoughtEndFrame) {
      await this._handleThoughtEnd(frame);
    } else if (frame instanceof LLMRunFrame) {
      await this._handleLlmRun(frame);
    } else if (frame instanceof LLMMessagesAppendFrame) {
      await this._handleLlmMessagesAppend(frame);
    } else if (frame instanceof LLMMessagesUpdateFrame) {
      await this._handleLlmMessagesUpdate(frame);
    } else if (frame instanceof LLMMessagesTransformFrame) {
      await this._handleLlmMessagesTransform(frame);
    } else if (frame instanceof LLMSetToolsFrame) {
      // Normalize and validate (a plain list of direct functions /
      // FunctionSchema objects becomes a ToolsSchema) so the tool-change diff
      // and setTools see a consistent type.
      const normalizedTools = LLMContext._normalizeAndValidateTools(frame.tools);
      this._maybeAddToolChangeMessages(normalizedTools);
      this.setTools(normalizedTools);
    } else if (frame instanceof LLMSetToolChoiceFrame) {
      this.setToolChoice(frame.toolChoice);
    } else if (frame instanceof FunctionCallsStartedFrame) {
      await this._handleFunctionCallsStarted(frame);
    } else if (frame instanceof FunctionCallInProgressFrame) {
      await this._handleFunctionCallInProgress(frame);
    } else if (frame instanceof FunctionCallResultFrame) {
      await this._handleFunctionCallResult(frame);
    } else if (frame instanceof FunctionCallCancelFrame) {
      await this._handleFunctionCallCancel(frame);
    } else if (frame instanceof UserImageRawFrame) {
      await this._handleUserImageFrame(frame);
    } else if (frame instanceof UserFileRawFrame) {
      await this._handleUserFileFrame(frame);
    } else if (frame instanceof AssistantImageRawFrame) {
      await this._handleAssistantImageFrame(frame);
    } else if (frame instanceof UserStartedSpeakingFrame) {
      this._userSpeaking = true;
      await this.pushFrame(frame, direction);
    } else if (frame instanceof UserStoppedSpeakingFrame) {
      this._userSpeaking = false;
      await this.pushFrame(frame, direction);
    } else if (frame instanceof BotStartedSpeakingFrame) {
      this._botSpeaking = true;
      await this.pushFrame(frame, direction);
    } else if (frame instanceof BotStoppedSpeakingFrame) {
      this._botSpeaking = false;
      await this.pushFrame(frame, direction);
      if (this._pushContextOnBotStoppedSpeaking && !this._userSpeaking) {
        logger.debug(`${this}: Bot stopped speaking — pushing deferred context frame!`);
        await this.pushContextFrame(FrameDirection.UPSTREAM);
      }
    } else if (frame instanceof LLMServiceMetadataFrame) {
      // Auto-configure realtime mode on the assistant half too — the
      // broadcast reaches both halves. The assistant only needs the flag for
      // its trailing flush; the user half owns the strategy mutations.
      if (frame.isRealtimeService && this._realtimeServiceMode === null) {
        this._realtimeServiceMode = true;
        // The mode just auto-enabled: the trailing flush needs the
        // back-reference to the user half (always wired by the pair — this
        // surfaces unsupported direct construction instead of silently
        // dropping user messages).
        this._requirePairedUserAggregator();
      }
      await this.pushFrame(frame, direction);
    } else if (frame instanceof ProposedUserStartedSpeakingFrame) {
      // A broadcast sends a copy each way, so a proposal from a service
      // sitting between the two halves — a realtime LLM — reaches the user
      // half as the upstream copy while this copy travels on. A proposal
      // should be resolved once, so stop it here if the user half resolves
      // it. No standard pipeline has a resolver downstream of this half, so
      // this guards the invariant rather than fixing an observed escape.
      const user = this._pairedUserAggregator;
      if (!user?._userTurnController.resolvesProposedTurnStartFrames) {
        await this.pushFrame(frame, direction);
      }
    } else if (frame instanceof ProposedUserStoppedSpeakingFrame) {
      const user = this._pairedUserAggregator;
      if (!user?._userTurnController.resolvesProposedTurnStopFrames) {
        await this.pushFrame(frame, direction);
      }
    } else {
      await this.pushFrame(frame, direction);
    }

    // Pass frames to summarizer for monitoring
    if (this._summarizer) {
      await this._summarizer.processFrame(frame);
    }
  }

  protected async _start(_frame: StartFrame): Promise<void> {
    if (this._realtimeServiceMode) {
      this._requirePairedUserAggregator();
    }
  }

  /**
   * Throw if realtime mode is active without a paired user aggregator.
   *
   * Realtime mode needs the assistant half to hold a back-reference to the
   * user half so it can flush the user message on `LLMFullResponseStartFrame`.
   * The pair wires this unconditionally (so the halves are always configured
   * together); this guards unsupported direct construction, surfacing the
   * missing flush loudly instead of silently dropping user messages. Checked
   * at `StartFrame` for an explicit mode and again when the mode auto-enables.
   *
   * @throws Error (upstream: RuntimeError) when no user aggregator is paired.
   */
  protected _requirePairedUserAggregator(): void {
    if (this._pairedUserAggregator === null) {
      throw new Error(
        `${this}: realtime_service_mode is enabled but this assistant ` +
          "aggregator has no paired user aggregator. Build both aggregators " +
          "with LLMContextAggregatorPair(context) rather than constructing " +
          "them individually, so realtime mode is configured once and shared " +
          "across both halves.",
      );
    }
  }

  /** Push the current assistant aggregation with timestamp. */
  async pushAggregation(): Promise<string> {
    const aggregation = await this._addAggregationToContext();
    if (!aggregation) {
      return "";
    }

    // Push context frame
    await this.pushContextFrame();

    // Push timestamp frame with current time
    const timestampFrame = new LLMContextAssistantTimestampFrame({ timestamp: timeNowIso8601() });
    await this.pushFrame(timestampFrame);

    return aggregation;
  }

  /**
   * Commit the held assistant aggregation as a context message, pushing no frames.
   *
   * For flushes in the middle of an open assistant turn (a user file or image
   * arriving mid-reply), where the downstream context and timestamp frames —
   * and pushContextFrame()'s side effects — belong to the turn's real end,
   * not to this commit.
   *
   * @returns The committed aggregation, or an empty string if none was held.
   */
  protected async _addAggregationToContext(): Promise<string> {
    if (this._aggregation.length === 0) {
      return "";
    }

    const aggregation = this.aggregationString();
    await this.reset();

    this._context.addMessage({ role: "assistant", content: aggregation });

    return aggregation;
  }

  /**
   * Push a context frame in the specified direction.
   *
   * @param direction The direction to push the frame (upstream or downstream).
   */
  override async pushContextFrame(
    direction: FrameDirection = FrameDirection.DOWNSTREAM,
  ): Promise<void> {
    await super.pushContextFrame(direction);
    this._pushContextOnBotStoppedSpeaking = false;
    this._contextPushOwed = false;
  }

  protected async _handleLlmRun(_frame: LLMRunFrame): Promise<void> {
    await this.pushContextFrame(FrameDirection.UPSTREAM);
  }

  protected async _handleLlmMessagesAppend(frame: LLMMessagesAppendFrame): Promise<void> {
    // An LLMMessagesAppendFrame with runLlm=true is treated as a
    // FunctionCallResultFrame with runLlm=true is: held while the bot speaks,
    // owed while the user speaks, and bundled with the appends and results
    // queued behind it. Run at once, a message appended mid-sentence runs the
    // model on a context that lacks the answer in progress, and the model
    // answers it again.
    this.addMessages(frame.messages);
    if (frame.runLlm) {
      this._contextPushOwed = true;
    }
    if (this._contextPushOwed && !this._userSpeaking) {
      await this._maybePushContext();
    } else if (this._contextPushOwed) {
      logger.debug(`${this}: User is speaking — context frame push owed until the turn ends.`);
    }
  }

  protected async _handleLlmMessagesUpdate(frame: LLMMessagesUpdateFrame): Promise<void> {
    this.setMessages(frame.messages);
    if (frame.runLlm) {
      await this.pushContextFrame(FrameDirection.UPSTREAM);
    }
  }

  protected async _handleLlmMessagesTransform(frame: LLMMessagesTransformFrame): Promise<void> {
    this.transformMessages(frame.transform);
    if (frame.runLlm) {
      await this.pushContextFrame(FrameDirection.UPSTREAM);
    }
  }

  protected async _handleInterruptions(_frame: InterruptionFrame): Promise<void> {
    await this._triggerAssistantTurnStopped({ interrupted: true });
    await this.reset();
  }

  protected async _handleEndOrCancel(frame: Frame): Promise<void> {
    await this._triggerAssistantTurnStopped({ interrupted: frame instanceof CancelFrame });
    await this._cleanup();
  }

  protected async _cleanup(): Promise<void> {
    // Cancel any in-flight onContextUpdated callback tasks and tear down the
    // summarizer. Idempotent so it is safe to run from both the
    // EndFrame/CancelFrame handler and cleanup().
    for (const task of [...this._contextUpdatedTasks]) {
      await this.cancelTask(task);
    }
    this._contextUpdatedTasks.clear();
    if (this._summarizer) {
      await this._summarizer.cleanup();
    }
  }

  protected async _handleFunctionCallsStarted(frame: FunctionCallsStartedFrame): Promise<void> {
    const functionNames = frame.functionCalls.map((f) => `${f.functionName}:${f.toolCallId}`);
    logger.debug(`${this} FunctionCallsStartedFrame: ${reprList(functionNames)}`);
    for (const functionCall of frame.functionCalls) {
      this._functionCallsInProgress.set(functionCall.toolCallId, null);
    }
  }

  protected async _handleFunctionCallInProgress(frame: FunctionCallInProgressFrame): Promise<void> {
    logger.debug(
      `${this} FunctionCallInProgressFrame: [${frame.functionName}:${frame.toolCallId}]`,
    );

    // Update context with the in-progress function call
    this._context.addMessage({
      role: "assistant",
      tool_calls: [
        {
          id: frame.toolCallId,
          function: {
            name: frame.functionName,
            arguments: jsonDumps(frame.arguments),
          },
          type: "function",
        },
      ],
    });

    const isAsync = !frame.cancelOnInterruption;
    if (isAsync) {
      this._context.addMessage(asyncToolMessages.buildStartedMessage(frame.toolCallId));
    } else {
      this._context.addMessage({
        role: "tool",
        content: "IN_PROGRESS",
        tool_call_id: frame.toolCallId,
      });
    }

    this._functionCallsInProgress.set(frame.toolCallId, frame);
  }

  protected async _handleFunctionCallResult(frame: FunctionCallResultFrame): Promise<void> {
    logger.debug(`${this} FunctionCallResultFrame: [${frame.functionName}:${frame.toolCallId}]`);
    if (!this._functionCallsInProgress.has(frame.toolCallId)) {
      logger.warning(`FunctionCallResultFrame tool_call_id [${frame.toolCallId}] is not running`);
      return;
    }

    const inProgressFrame = this._functionCallsInProgress.get(frame.toolCallId) ?? null;
    if (inProgressFrame === null) {
      // Started, but its in-progress frame hasn't arrived: there's nothing
      // yet to attach the result to.
      logger.warning(
        `FunctionCallResultFrame tool_call_id [${frame.toolCallId}] is not in progress`,
      );
      return;
    }

    const groupId = inProgressFrame.groupId;
    const properties = frame.properties;
    const isFinal = frame.properties ? frame.properties.isFinal : true;

    if (isFinal) {
      await this._handleFunctionCallFinished(frame, inProgressFrame);
    } else {
      await this._handleFunctionCallIntermediateResult(frame, inProgressFrame);
    }

    let runLlm = false;

    // Append any images that were generated by function calls.
    const imageFrame = this._functionCallsImageResults.get(frame.toolCallId);
    if (imageFrame !== undefined) {
      this._functionCallsImageResults.delete(frame.toolCallId);

      // If an image frame has been added to the context, let's run inference.
      runLlm = await this._maybeAppendImageToContext(imageFrame);
    }

    // Run inference if the function call result requires it.
    if (isTruthy(frame.result)) {
      if (properties && properties.runLlm !== null && properties.runLlm !== undefined) {
        // If the tool call result has a runLlm property, use it.
        runLlm = properties.runLlm;
      } else if (frame.runLlm !== null && frame.runLlm !== undefined) {
        // If the frame is indicating we should run the LLM, do it.
        runLlm = frame.runLlm;
      } else {
        // Run the LLM when this is the last function call in the group to
        // complete. If groupId is set, only consider sibling calls; otherwise
        // always execute as soon as we receive the result.
        if (groupId) {
          runLlm = ![...this._functionCallsInProgress.values()].some(
            (f) =>
              f !== null &&
              f.groupId === groupId &&
              // We are now able to receive "updates", so the current frame
              // can still be in the in progress list, and we need to ignore it.
              f.toolCallId !== frame.toolCallId,
          );
        } else {
          runLlm = true;
        }
      }
    }

    if (runLlm) {
      this._contextPushOwed = true;
    }

    if (this._contextPushOwed && !this._userSpeaking) {
      await this._maybePushContext();
    }

    // Call the `onContextUpdated` callback once the function call result is
    // added to the context. Also, run this in a separate task to make sure we
    // don't block the pipeline.
    const onContextUpdated = properties?.onContextUpdated;
    if (onContextUpdated) {
      const workerName = `${frame.functionName}:${frame.toolCallId}:on_context_updated`;
      const task = this.createTask(() => onContextUpdated(), workerName);
      this._contextUpdatedTasks.add(task);
      task.addDoneCallback((t) => this._contextUpdatedTaskFinished(t));
    }
  }

  /**
   * Decide whether to push a context frame after a function call settles or a message is appended.
   *
   * Push an `LLMContextFrame` upstream (with care to avoid duplicate pushes
   * while results or appends are queued or the bot is still speaking).
   * Cascade LLMs use the context frame to re-run inference with the new tool
   * result in scope. Realtime LLMs read the new tool result out of the
   * context the same way — they don't get function results from
   * `FunctionCallResultFrame` directly — so the same push is load-bearing for
   * both modes.
   */
  protected async _maybePushContext(): Promise<void> {
    if (
      this.hasQueuedFrame(FunctionCallResultFrame) ||
      this.hasQueuedFrame(LLMMessagesAppendFrame)
    ) {
      // Another result or append is already queued. Defer the context push to
      // bundle them all into a single LLM call instead of triggering one
      // inference pass per frame. The push is owed until it happens, so the
      // last frame in the queue makes it whether or not that frame asks to
      // run — a burst can end with an intermediate result, or an
      // LLMMessagesAppendFrame with runLlm=false, that doesn't.
      logger.debug(`${this}: More results or appends queued — deferring context frame push.`);
    } else if (this._botSpeaking) {
      // Defer the context frame push until the bot finishes speaking. If
      // multiple function call results arrive while the bot is speaking, they
      // all accumulate in the context and a single push is performed once
      // speaking stops, preventing the LLM from running multiple times and
      // producing duplicated responses. This should be an edge case, since it
      // would require a FunctionCallResultFrame being queued between an LLM
      // response start and end frame.
      logger.debug(`${this}: Bot is speaking — deferring context frame push.`);
      this._pushContextOnBotStoppedSpeaking = true;
    } else {
      logger.debug(`${this}: Pushing context frame!`);
      await this.pushContextFrame(FrameDirection.UPSTREAM);
    }
  }

  /**
   * Handle an intermediate result for an async function call.
   *
   * Injects an intermediate developer message into the context without
   * removing the call from the in-progress map.
   */
  protected async _handleFunctionCallIntermediateResult(
    frame: FunctionCallResultFrame,
    _inProgressFrame: FunctionCallInProgressFrame,
  ): Promise<void> {
    if (!isTruthy(frame.result)) {
      logger.warning(`${this} result_callback called with is_final=False but no result!`);
      return;
    }

    const result = jsonDumps(frame.result);
    this._context.addMessage(
      asyncToolMessages.buildIntermediateResultMessage(frame.toolCallId, result),
    );
  }

  /**
   * Handle the final result of a function call.
   *
   * Removes the call from the in-progress map, updates the context, and
   * triggers LLM inference when appropriate.
   */
  protected async _handleFunctionCallFinished(
    frame: FunctionCallResultFrame,
    inProgressFrame: FunctionCallInProgressFrame,
  ): Promise<void> {
    const deferred = this._isDeferred(inProgressFrame);
    this._functionCallsInProgress.delete(frame.toolCallId);

    const result = isTruthy(frame.result) ? jsonDumps(frame.result) : "COMPLETED";

    if (deferred) {
      // The conversation moved on while the call ran, so the LLM is told
      // about the result in a developer message rather than in the tool
      // message it has already seen.
      this._context.addMessage(asyncToolMessages.buildFinalResultMessage(frame.toolCallId, result));
    } else {
      this._updateFunctionCallResult(frame.functionName, frame.toolCallId, result);
    }
  }

  protected async _handleFunctionCallCancel(frame: FunctionCallCancelFrame): Promise<void> {
    logger.debug(`${this} FunctionCallCancelFrame: [${frame.functionName}:${frame.toolCallId}]`);
    const functionCall = this._functionCallsInProgress.get(frame.toolCallId);
    if (!functionCall) {
      return;
    }

    // Update context with the function call cancellation. An async call is
    // settled with a developer message, the same channel its results use,
    // whether or not the conversation moved on, since the notice says the
    // call did not complete and asks for the user to be told.
    if (functionCall.cancelOnInterruption) {
      this._updateFunctionCallResult(frame.functionName, frame.toolCallId, "CANCELLED");
    } else {
      this._context.addMessage(asyncToolMessages.buildCancelledMessage(frame.toolCallId));
    }

    const groupId = functionCall.groupId;
    this._functionCallsInProgress.delete(frame.toolCallId);

    if (!frame.runLlm || this._userSpeaking) {
      return;
    }

    // Hold off while siblings from the same LLM response are still running:
    // whichever of them settles last runs inference, with this cancellation
    // already in the context.
    if (
      groupId &&
      [...this._functionCallsInProgress.values()].some((f) => f !== null && f.groupId === groupId)
    ) {
      return;
    }

    await this._maybePushContext();
  }

  protected async _handleUserImageFrame(frame: UserImageRawFrame): Promise<void> {
    let imageAppended = false;

    // Check if this image is a result of a function call.
    if (frame.request?.toolCallId && this._functionCallsInProgress.has(frame.request.toolCallId)) {
      this._functionCallsImageResults.set(frame.request.toolCallId, frame);

      // Call the resultCallback if provided. This signals that the image has
      // been retrieved and the function call can now complete.
      if (frame.request.resultCallback) {
        const resultCallback = frame.request.resultCallback as (result: unknown) => unknown;
        await resultCallback(null);
      }
    } else {
      // Commit any in-progress assistant aggregation before appending, so the
      // image message lands after it in the context. Context-only: the turn
      // stays open and its frames fire at the turn's real end.
      await this._addAggregationToContext();
      imageAppended = await this._maybeAppendImageToContext(frame);
    }

    if (imageAppended && frame.runLlm !== false) {
      await this.pushContextFrame(FrameDirection.UPSTREAM);
    }
  }

  protected async _handleUserFileFrame(frame: UserFileRawFrame): Promise<void> {
    // TODO: Should this have a similar function-call check like _handleUserImageFrame?
    if (!frame.appendToContext) {
      return;
    }

    // Commit any in-progress assistant aggregation before appending, so the
    // file message lands after it in the context. The order matters beyond
    // chronology: LLMContext.removeInvalidFileMessage() only considers
    // messages after the last assistant message, so a file message written
    // before a later-committed assistant message could never be cleaned up if
    // the provider rejects it. Context-only: the assistant turn stays open,
    // any remaining reply text commits at the turn's end, and the turn's
    // frames fire there.
    await this._addAggregationToContext();

    logger.debug(`${this} Appending UserFileRawFrame to LLM context (format: ${frame.format})`);
    await this._context.addFileFrameMessage({
      type: frame.type,
      format: frame.format,
      text: frame.text,
      file: frame.file,
      name: frame.filename,
      // TODO: pass customOptions through to adapters via the universal message
    });

    if (frame.runLlm !== false) {
      await this.pushContextFrame(FrameDirection.UPSTREAM);
    }
  }

  protected async _handleAssistantImageFrame(frame: AssistantImageRawFrame): Promise<void> {
    logger.debug(
      `${this} Appending AssistantImageRawFrame to LLM context (size: (${frame.size.join(", ")}))`,
    );

    if (frame.originalData && frame.originalMimeType) {
      await this._context.addImageFrameMessage({
        format: frame.originalMimeType,
        size: frame.size, // Technically doesn't matter, since already encoded
        image: frame.originalData,
        role: "assistant",
      });
    } else {
      if (frame.format === null) {
        throw new Error("AssistantImageRawFrame.format must not be null");
      }
      await this._context.addImageFrameMessage({
        format: frame.format,
        size: frame.size,
        image: frame.image,
        role: "assistant",
      });
    }
  }

  protected async _handleLlmStart(_frame: LLMFullResponseStartFrame): Promise<void> {
    // Realtime mode treats LLMFullResponseStartFrame as the user turn's end
    // signal for context-writing purposes — see _realtimeHandleLlmStart.
    if (this._realtimeServiceMode) {
      await this._realtimeHandleLlmStart();
      return;
    }
    await this._triggerAssistantTurnStarted();
  }

  /**
   * Realtime mode: commit the paired user message, then start the assistant turn.
   *
   * Realtime mode treats `LLMFullResponseStartFrame` as the user turn's end
   * signal for context-writing purposes (in place of
   * `UserStoppedSpeakingFrame`). The paired user aggregator may defer the
   * actual write for one `ttfsP99Latency` window to allow a late-arriving
   * transcript to land.
   */
  protected async _realtimeHandleLlmStart(): Promise<void> {
    if (this._pairedUserAggregator !== null) {
      await this._pairedUserAggregator._realtimeHandoffFlush();
    }
    await this._triggerAssistantTurnStarted();
  }

  protected async _handleLlmEnd(_frame: LLMFullResponseEndFrame): Promise<void> {
    // Realtime mode failsafe: by the time the assistant response fully
    // completes, even slow transcripts should have landed. Cancel any
    // still-pending deferred handoff flush and commit the user message now so
    // it precedes the assistant message in context.
    if (this._realtimeServiceMode && this._pairedUserAggregator !== null) {
      await this._pairedUserAggregator._realtimeHandoffFlushImmediate();
    }
    await this._triggerAssistantTurnStopped();
  }

  protected async _handleTtsStarted(frame: TTSStartedFrame): Promise<void> {
    // If this TTS output will be written to context and we don't already have
    // an open assistant turn, open one. This handles the case of
    // TTSSpeakFrame-driven utterances that have no surrounding LLM response
    // frames to signal assistant turn boundaries, while rightly deferring to
    // any earlier LLM-driven turn start.
    if (frame.appendToContext && !this._assistantTurnStartTimestamp) {
      await this._triggerAssistantTurnStarted();
    }
  }

  protected async _handlePushAggregation(): Promise<void> {
    // LLMAssistantPushAggregationFrame is emitted at the end of a
    // TTSSpeakFrame-driven utterance to commit the spoken text.
    await this._triggerAssistantTurnStopped();
  }

  protected async _handleText(frame: TextFrame): Promise<void> {
    // Skip TextFrame types not intended to build the assistant context
    if (
      frame instanceof TranscriptionFrame ||
      frame instanceof TranslationFrame ||
      frame instanceof InterimTranscriptionFrame ||
      frame instanceof EagerTranscriptionFrame
    ) {
      return;
    }

    // A backchannel is reported once, by the segment the TTS will speak,
    // which the output transport releases as its audio starts.
    if (
      frame instanceof AggregatedTextFrame &&
      !(frame instanceof TTSTextFrame) &&
      frame.textType === TextType.BACKCHANNEL &&
      frame.willBeSpoken
    ) {
      const message = new AssistantBackchannelMessage({
        content: frame.text,
        timestamp: timeNowIso8601(),
      });
      await this._callEventHandler("on_assistant_backchannel", message);
    }

    if (!frame.appendToContext) {
      return;
    }

    // Make sure we really have text (spaces count, too!)
    if (frame.text.length === 0) {
      return;
    }

    const text = frame instanceof AggregatedTextFrame && frame.rawText ? frame.rawText : frame.text;
    this._aggregation.push(
      new TextPartForConcatenation({
        text,
        includesInterPartSpaces: frame.includesInterFrameSpaces,
      }),
    );
  }

  protected async _handleMarkerFrame(frame: LLMMarkerFrame): Promise<void> {
    this._seenTurnMarkers.add(frame.marker);

    if (frame.appendToContextImmediately) {
      // Stand-alone marker: write it to the context now as its own assistant
      // message. Used when the marker is the entire assistant turn — e.g. the
      // ◐ / ○ incomplete-turn signals, where the spoken response is
      // suppressed and the marker is the only artifact.
      this._context.addMessage({ role: "assistant", content: frame.marker });
      await this.pushContextFrame();
      const timestampFrame = new LLMContextAssistantTimestampFrame({
        timestamp: timeNowIso8601(),
      });
      await this.pushFrame(timestampFrame);
      return;
    }

    // Marker is part of an in-progress assistant response. Append it to the
    // running aggregation so `pushAggregation` writes marker + text as a
    // single context message — e.g. the ● complete-turn signal that prefixes
    // the spoken response, producing "● <response>" in context. Markers are
    // stripped from the transcript via `_maybeStripTurnCompletionMarkers` so
    // consumers see clean text.
    this._aggregation.push(
      new TextPartForConcatenation({ text: frame.marker, includesInterPartSpaces: false }),
    );
  }

  protected async _handleThoughtStart(frame: LLMThoughtStartFrame): Promise<void> {
    await this._resetThoughtAggregation();
    this._thoughtAppendToContext = frame.appendToContext;
    // frame.llm is required when frame.appendToContext is true, which is the
    // only case where we read this value, so we can safely default to an
    // empty string here for typing purposes.
    this._thoughtLlm = frame.llm || "";
    this._thoughtStartTime = timeNowIso8601();
  }

  protected async _handleThoughtText(frame: LLMThoughtTextFrame): Promise<void> {
    // Make sure we really have text (spaces count, too!)
    if (frame.text.length === 0) {
      return;
    }

    this._thoughtAggregation.push(
      new TextPartForConcatenation({
        text: frame.text,
        includesInterPartSpaces: frame.includesInterFrameSpaces,
      }),
    );
  }

  protected async _handleThoughtEnd(frame: LLMThoughtEndFrame): Promise<void> {
    const thought = concatenateAggregatedText(this._thoughtAggregation);

    if (this._thoughtAppendToContext) {
      const llm = this._thoughtLlm;
      this._context.addMessage(
        new LLMSpecificMessage({
          llm,
          message: {
            type: "thought",
            text: thought,
            signature: frame.signature,
          },
        }),
      );
    }

    const message = new AssistantThoughtMessage({
      content: thought,
      timestamp: this._thoughtStartTime,
    });

    await this._resetThoughtAggregation();

    await this._callEventHandler("on_assistant_thought", message);
  }

  protected async _maybeAppendImageToContext(frame: UserImageRawFrame): Promise<boolean> {
    if (!frame.appendToContext) {
      return false;
    }

    logger.debug(
      `${this} Appending UserImageRawFrame to LLM context (size: (${frame.size.join(", ")}))`,
    );

    if (frame.format === null) {
      throw new Error("UserImageRawFrame.format must not be null");
    }
    await this._context.addImageFrameMessage({
      format: frame.format,
      size: frame.size,
      image: frame.image,
      text: frame.text,
    });

    return true;
  }

  /**
   * Whether a call's final result must be delivered as a deferred message.
   *
   * An async call (`cancelOnInterruption: false`) whose result arrives before
   * the conversation moved on is indistinguishable from a synchronous one,
   * and settles in place: its "started" placeholder becomes the tool result,
   * and the LLM sees an ordinary call. The context alone decides. The result
   * is deferred when a user or developer message follows the placeholder:
   * something the user said, new task instructions, or an intermediate update
   * from this call. Assistant messages are ignored, so filler spoken with a
   * `TTSSpeakFrame` while the call runs does not defer it, whether the tool
   * handler or an event handler spoke it. The same holds for text the model
   * wrote after seeing the placeholder with no user turn in between, as when
   * an ungrouped sibling's result runs inference; the result still settles in
   * place. Other calls' placeholders, results, and deferred messages are
   * ignored too. A placeholder that is no longer in the context, because the
   * context was rebuilt while the call ran, also defers.
   *
   * @param inProgressFrame The call's in-progress frame.
   * @returns True when the result goes into a developer message.
   */
  protected _isDeferred(inProgressFrame: FunctionCallInProgressFrame): boolean {
    if (inProgressFrame.cancelOnInterruption) {
      return false;
    }
    const toolCallId = inProgressFrame.toolCallId;
    let afterPlaceholder = false;
    for (const message of this._context.messages) {
      if (message instanceof LLMSpecificMessage) {
        continue;
      }
      if (!afterPlaceholder) {
        afterPlaceholder = message.role === "tool" && message.tool_call_id === toolCallId;
        continue;
      }
      const role = message.role;
      if (role === "tool" || role === "assistant") {
        // A sibling's placeholder or result, or assistant output.
        continue;
      }
      const payload = asyncToolMessages.parseMessage(message);
      if (payload !== null && payload.toolCallId !== toolCallId) {
        // A sibling's deferred update or result.
        continue;
      }
      return true;
    }
    return !afterPlaceholder;
  }

  protected _updateFunctionCallResult(
    _functionName: string,
    toolCallId: string,
    result: unknown,
  ): void {
    for (const message of this._context.getMessages()) {
      if (
        !(message instanceof LLMSpecificMessage) &&
        message.role === "tool" &&
        message.tool_call_id &&
        message.tool_call_id === toolCallId
      ) {
        (message as LLMStandardMessage).content = result;
      }
    }
  }

  protected _contextUpdatedTaskFinished(task: Task<unknown>): void {
    this._contextUpdatedTasks.delete(task);
  }

  protected async _triggerAssistantTurnStarted(): Promise<void> {
    this._assistantTurnStartTimestamp = timeNowIso8601();

    await this._callEventHandler("on_assistant_turn_started");
  }

  protected async _triggerAssistantTurnStopped(
    options: { interrupted?: boolean } = {},
  ): Promise<void> {
    const interrupted = options.interrupted ?? false;
    if (!this._assistantTurnStartTimestamp) {
      return;
    }

    let aggregation = await this.pushAggregation();
    if (aggregation) {
      // Strip turn completion markers from the transcript
      aggregation = this._maybeStripTurnCompletionMarkers(aggregation);
    }

    const message = new AssistantTurnStoppedMessage({
      content: aggregation,
      interrupted,
      timestamp: this._assistantTurnStartTimestamp,
    });
    await this._callEventHandler("on_assistant_turn_stopped", message);
    if (aggregation) {
      await this.broadcastFrame(LLMContextAssistantTurnFrame, {
        text: aggregation,
        timestamp: this._assistantTurnStartTimestamp,
      });
    }

    this._assistantTurnStartTimestamp = "";
  }

  /**
   * Strip turn completion markers from assistant transcript.
   *
   * Turn completion markers are used internally for turn completion detection
   * and shouldn't appear in the final transcript. Both the default markers
   * and any seen on this turn's marker frames are removed, so a custom marker
   * set is stripped too.
   */
  protected _maybeStripTurnCompletionMarkers(text: string): string {
    let markerFound = false;
    const markers = new Set<string>([
      USER_TURN_COMPLETE_MARKER,
      USER_TURN_INCOMPLETE_SHORT_MARKER,
      USER_TURN_INCOMPLETE_LONG_MARKER,
      ...this._seenTurnMarkers,
    ]);
    for (const marker of markers) {
      if (text.includes(marker)) {
        text = text.replaceAll(marker, "");
        markerFound = true;
      }
    }

    // Only strip whitespace if we removed a marker
    return markerFound ? text.trim() : text;
  }

  /**
   * Handle summarization request from the summarizer.
   *
   * Push the request frame UPSTREAM to the LLM service for processing.
   *
   * @param summarizer The summarizer that generated the request.
   * @param frame The summarization request frame to broadcast.
   */
  protected async _onRequestSummarization(
    _summarizer: LLMContextSummarizer,
    frame: LLMContextSummaryRequestFrame,
  ): Promise<void> {
    await this.pushFrame(frame, FrameDirection.UPSTREAM);
  }

  /**
   * Handle summary applied event from the summarizer.
   *
   * Forwards the event to any registered `on_summary_applied` handlers.
   *
   * @param summarizer The summarizer that applied the summary.
   * @param event The summary applied event.
   */
  protected async _onSummaryApplied(
    summarizer: LLMContextSummarizer,
    event: SummaryAppliedEvent,
  ): Promise<void> {
    await this._callEventHandler("on_summary_applied", summarizer, event);
  }
}

export interface LLMContextAggregatorPairOptions {
  /** Parameters for the user context aggregator. */
  userParams?: LLMUserAggregatorParams | null;
  /** Parameters for the assistant context aggregator. */
  assistantParams?: LLMAssistantAggregatorParams | null;
  /**
   * When provided, sets the field of the same name on both `userParams` and
   * `assistantParams`, overriding any value already set on either. This is
   * the preferred way to enable tool-change announcements: it ensures both
   * aggregators participate, which makes the feature robust regardless of
   * which aggregator handles a given `LLMSetToolsFrame`. The shared context
   * guarantees the announcement is added exactly once (the second
   * aggregator's diff is empty by the time it sees the frame). Leave as
   * `null` to respect per-params settings.
   */
  addToolChangeMessages?: boolean | null;
  /**
   * Configures the pair for use with a realtime (speech-to-speech) LLM
   * service. When enabled, context writes become trailing — driven by the
   * content stream itself (transcripts, `LLMFullResponseStartFrame`) rather
   * than turn frames — and turn-end strategies stop waiting for transcripts.
   * `null` (the default) auto-configures: the mode turns on when a realtime
   * service announces itself via service metadata, and stays off otherwise.
   * `true` / `false` force it on or off (`false` keeps legacy pre-realtime
   * context-write behavior). Both halves share this setting.
   */
  realtimeServiceMode?: boolean | null;
}

/** Pair of LLM context aggregators for updating context with user and assistant messages. */
export class LLMContextAggregatorPair {
  protected _user: LLMUserAggregator;
  protected _assistant: LLMAssistantAggregator;

  /**
   * Initialize the LLM context aggregator pair.
   *
   * @param context The context to be managed by the aggregators.
   */
  constructor(context: LLMContext, options: LLMContextAggregatorPairOptions = {}) {
    const userParams = options.userParams || new LLMUserAggregatorParams();
    const assistantParams = options.assistantParams || new LLMAssistantAggregatorParams();
    const addToolChangeMessages = options.addToolChangeMessages ?? null;
    if (addToolChangeMessages !== null) {
      userParams.addToolChangeMessages = addToolChangeMessages;
      assistantParams.addToolChangeMessages = addToolChangeMessages;
    }
    const realtimeServiceMode = options.realtimeServiceMode ?? null;

    this._user = new LLMUserAggregator(context, {
      params: userParams,
      _realtimeServiceMode: realtimeServiceMode,
    });
    // Wire the assistant→user back-reference unconditionally: realtime mode
    // may be auto-configured later (realtimeServiceMode=null), so the
    // reference must already exist when it flips on. Realtime mode treats the
    // assistant response start as the user turn's end signal — the assistant
    // half triggers a (possibly deferred) flush of the user half so the user
    // message lands in context before the assistant turn starts. The user
    // side has nothing to flush back, and the behavior stays gated on the
    // resolved realtime flag, so this reference is inert in cascade mode.
    this._assistant = new LLMAssistantAggregator(context, {
      params: assistantParams,
      _realtimeServiceMode: realtimeServiceMode,
      _pairedUserAggregator: this._user,
    });
  }

  /**
   * Get the user context aggregator.
   *
   * @returns The user context aggregator instance.
   */
  user(): LLMUserAggregator {
    return this._user;
  }

  /**
   * Get the assistant context aggregator.
   *
   * @returns The assistant context aggregator instance.
   */
  assistant(): LLMAssistantAggregator {
    return this._assistant;
  }

  /**
   * Allow destructuring of the aggregator pair.
   *
   * @example
   * const pair = new LLMContextAggregatorPair(context); // The instance
   * const [user, assistant] = new LLMContextAggregatorPair(context); // Destructured
   */
  *[Symbol.iterator](): IterableIterator<LLMUserAggregator | LLMAssistantAggregator> {
    yield this._user;
    yield this._assistant;
  }
}
