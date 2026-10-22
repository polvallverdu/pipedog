// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/processors/frameworks/rtvi/observer.py

/**
 * RTVI observer for converting pipeline frames to outgoing RTVI messages.
 *
 * Porting notes:
 * - Deprecated upstream APIs are not ported: `RTVIObserverParams.userTranscriptionEnabled`
 *   and `skipAggregatorTypes`, the `aggregationType` argument of
 *   `addBotOutputTransformer()` / `removeBotOutputTransformer()`, and the
 *   2-parameter `(text, textType) => string` transform signature. Every
 *   transform is called with the 4-parameter, progress-aware signature.
 * - The deprecated `bot-llm-text`, `bot-tts-text`, `bot-transcription` and
 *   `user-transcription` messages are still sent, because they are part of the
 *   wire protocol current clients consume. With `userTranscriptionEnabled`
 *   gone, `user-transcription` is always sent (upstream's default).
 * - RTVI models are dumped with `modelDump({ excludeNone })` (see `processor.ts`);
 *   metrics models are plain classes, dumped to their snake_case wire form here.
 */

import { createTask, rethrowIfCancelled, type Task, time } from "@pipedog/asyncio";
import { AudioVolumeTracker } from "../../../audio/volume.ts";
import {
  AggregatedTextFrame,
  AggregatedTextProgressFrame,
  AudioRawFrame,
  BotStartedSpeakingFrame,
  BotStoppedSpeakingFrame,
  ExternalFunctionCallCancelFrame,
  ExternalFunctionCallInProgressFrame,
  ExternalFunctionCallResultFrame,
  ExternalFunctionCallsStartedFrame,
  type Frame,
  FunctionCallCancelFrame,
  FunctionCallInProgressFrame,
  FunctionCallResultFrame,
  FunctionCallsStartedFrame,
  InputAudioRawFrame,
  InterimTranscriptionFrame,
  InterruptionFrame,
  LLMContextFrame,
  LLMFullResponseEndFrame,
  LLMFullResponseStartFrame,
  LLMMarkerResponseFrame,
  LLMTextFrame,
  MetricsFrame,
  TextType,
  TranscriptionFrame,
  TTSAudioRawFrame,
  TTSStartedFrame,
  TTSStoppedFrame,
  TTSTextFrame,
  UserBackchannelFrame,
  UserMuteStartedFrame,
  UserMuteStoppedFrame,
  UserStartedSpeakingFrame,
  UserStoppedSpeakingFrame,
  VADUserStartedSpeakingFrame,
  VADUserStoppedSpeakingFrame,
} from "../../../frames/frames.ts";
import {
  LLMUsageMetricsData,
  ProcessingMetricsData,
  STTUsageMetricsData,
  TTFAMetricsData,
  TTFATMetricsData,
  TTFBMetricsData,
  TTSUsageMetricsData,
} from "../../../metrics/metrics.ts";
import {
  BaseObserver,
  type BaseObserverOptions,
  type FramePushed,
} from "../../../observers/base_observer.ts";
import { BaseOutputTransport } from "../../../transports/base_output.ts";
import { type LogRecord, logger } from "../../../utils/logger.ts";
import { matchEndofsentence } from "../../../utils/string.ts";
import { timeNowIso8601 } from "../../../utils/time.ts";
import { FrameDirection, type FrameProcessor } from "../../frame_processor.ts";
import {
  RTVIConfigureObserverFrame,
  RTVISendTextFrame,
  RTVIServerMessageFrame,
  RTVIServerResponseFrame,
  RTVIUICommandFrame,
  RTVIUIJobGroupFrame,
} from "./frames.ts";
import * as RTVI from "./models.ts";
import { BotOutputTransformResult } from "./models.ts";
import type { RTVIModelLike, RTVIProcessor } from "./processor.ts";

/**
 * Level of detail to include in function call RTVI events.
 *
 * Controls what information is exposed in function call events for security.
 *
 * - DISABLED: No events emitted for this function call.
 * - NONE: Events only with tool_call_id, no function name or metadata (most secure).
 * - NAME: Events with function name, no arguments or results.
 * - ARGUMENTS: Events with function name and arguments, no results.
 * - FULL: Events with function name, arguments, and results.
 */
export const RTVIFunctionCallReportLevel = {
  DISABLED: "disabled",
  NONE: "none",
  NAME: "name",
  ARGUMENTS: "arguments",
  FULL: "full",
} as const;
export type RTVIFunctionCallReportLevel =
  (typeof RTVIFunctionCallReportLevel)[keyof typeof RTVIFunctionCallReportLevel];

/**
 * A bot output transform.
 *
 * When `accumulatedText` and `remainingText` are null the transform is being
 * called for the full segment text (from `bot-output`). When they are
 * provided the transform is being called for a progress event and must return
 * a `BotOutputTransformResult` with `accumulatedText` and `remainingText` set.
 */
export type BotOutputTransform = (
  text: string,
  textType: TextType | string,
  accumulatedText: string | null,
  remainingText: string | null,
) => Promise<BotOutputTransformResult | string>;

/** Options for `RTVIObserverParams`. Every field is optional. */
export interface RTVIObserverParamsOptions {
  botOutputEnabled?: boolean;
  botLlmEnabled?: boolean;
  botLlmMarkerEnabled?: boolean;
  botTtsEnabled?: boolean;
  botSpeakingEnabled?: boolean;
  botAudioLevelEnabled?: boolean;
  userLlmEnabled?: boolean;
  userSpeakingEnabled?: boolean;
  vadUserSpeakingEnabled?: boolean;
  userMuteEnabled?: boolean;
  userInputEnabled?: boolean;
  userAudioLevelEnabled?: boolean;
  metricsEnabled?: boolean;
  systemLogsEnabled?: boolean;
  sttRawTextEnabled?: boolean;
  llmRawTextEnabled?: boolean;
  ttsRawTextEnabled?: boolean;
  ignoredSources?: FrameProcessor[];
  skipTextTypes?: (TextType | string)[] | null;
  botOutputTransforms?: [TextType | string, BotOutputTransform][] | null;
  audioLevelPeriodSecs?: number;
  functionCallReportLevel?: Record<string, RTVIFunctionCallReportLevel>;
}

/**
 * Parameters for configuring RTVI Observer behavior.
 *
 * - `botOutputEnabled`: Indicates if bot output messages should be sent.
 * - `botLlmEnabled`: Indicates if the bot's LLM messages should be sent. Of
 *   these, the `bot-llm-text` message is deprecated in favor of `llm-raw-text`
 *   (`llmRawTextEnabled`) and will be removed in 2.0.0. This flag stays, for
 *   `bot-llm-started` and `bot-llm-stopped`.
 * - `botLlmMarkerEnabled`: Indicates if the bot's LLM marker reports
 *   (`LLMMarkerResponseFrame`, e.g. from `filterIncompleteUserTurns`) should
 *   be sent. A report carries the marker the LLM emitted and the raw text of
 *   the whole response, which is meant for evaluation, not for clients, so
 *   this is off by default. Defaults to false.
 * - `botTtsEnabled`: Indicates if the bot's TTS messages should be sent. Of
 *   these, the `bot-tts-text` message is deprecated in favor of
 *   `tts-raw-text` (`ttsRawTextEnabled`) and will be removed in 2.0.0. This
 *   flag stays, for `bot-tts-started` and `bot-tts-stopped`.
 * - `botSpeakingEnabled`: Indicates if the bot's started/stopped speaking and
 *   interrupted messages should be sent.
 * - `botAudioLevelEnabled`: Indicates if bot's audio level messages should be sent.
 * - `userLlmEnabled`: Indicates if the user's LLM input messages should be sent.
 * - `userSpeakingEnabled`: Indicates if the user's started/stopped speaking
 *   messages should be sent.
 * - `vadUserSpeakingEnabled`: Indicates if raw VAD user started/stopped
 *   speaking messages should be sent. These reflect the VAD signal directly,
 *   independent of turn finalization (unlike `userSpeakingEnabled`, which a
 *   turn strategy may gate or defer). Off by default. Defaults to false.
 * - `userMuteEnabled`: Indicates if user mute started/stopped messages should be sent.
 * - `userInputEnabled`: Indicates if the user's input messages should be sent.
 *   They report what the user said or typed: transcriptions, including
 *   interim ones, backchannels, and the text the client sent.
 * - `userAudioLevelEnabled`: Indicates if user's audio level messages should be sent.
 * - `metricsEnabled`: Indicates if metrics messages should be sent.
 * - `systemLogsEnabled`: Indicates if system logs should be sent.
 * - `sttRawTextEnabled`: Indicates if the STT's raw text messages should be
 *   sent. They report each transcription, interim ones included, as the STT
 *   produced it. Only sent to clients of protocol 2.2.0 or later. Defaults to false.
 * - `llmRawTextEnabled`: Indicates if the LLM's raw text messages should be
 *   sent. They report each chunk of text the LLM streams. Only sent to
 *   clients of protocol 2.2.0 or later. Defaults to false.
 * - `ttsRawTextEnabled`: Indicates if the TTS's raw text messages should be
 *   sent. They report the text the TTS speaks, as it is spoken, and leave out
 *   the same text types as bot output messages. Only sent to clients of
 *   protocol 2.2.0 or later. Defaults to false.
 * - `ignoredSources`: List of frame processors whose frames should be
 *   silently ignored by this observer. Useful for suppressing RTVI messages
 *   from secondary pipeline branches (e.g. a silent evaluation LLM) that
 *   should not be visible to clients. Sources can also be added and removed
 *   dynamically via `addIgnoredSource()` and `removeIgnoredSource()`.
 * - `skipTextTypes`: List of text types to skip sending as tts/output
 *   messages. Text of type `backchannel` is only sent to clients of protocol
 *   2.2.0 or later; add `"backchannel"` here to keep it from every client.
 *   Note: if using this to avoid sending secure information, be sure to also
 *   disable botLlmEnabled, and leave llmRawTextEnabled off, to avoid leaking
 *   through LLM messages.
 * - `botOutputTransforms`: A list of `[textType | "*", transform]` tuples to
 *   transform text before sending it to the client. See `BotOutputTransform`.
 * - `audioLevelPeriodSecs`: How often audio levels should be sent if enabled.
 * - `functionCallReportLevel`: Controls what information is exposed in
 *   function call events for security. A record mapping function names to
 *   levels, where `"*"` sets the default level for unlisted functions.
 *   Defaults to `{ "*": RTVIFunctionCallReportLevel.NONE }`.
 *
 * @example
 * new RTVIObserverParams({
 *   functionCallReportLevel: {
 *     "*": RTVIFunctionCallReportLevel.NONE, // Default: events with no metadata
 *     get_weather: RTVIFunctionCallReportLevel.FULL, // Expose everything
 *   },
 * });
 */
export class RTVIObserverParams {
  botOutputEnabled: boolean;
  botLlmEnabled: boolean;
  botLlmMarkerEnabled: boolean;
  botTtsEnabled: boolean;
  botSpeakingEnabled: boolean;
  botAudioLevelEnabled: boolean;
  userLlmEnabled: boolean;
  userSpeakingEnabled: boolean;
  vadUserSpeakingEnabled: boolean;
  userMuteEnabled: boolean;
  userInputEnabled: boolean;
  userAudioLevelEnabled: boolean;
  metricsEnabled: boolean;
  systemLogsEnabled: boolean;
  sttRawTextEnabled: boolean;
  llmRawTextEnabled: boolean;
  ttsRawTextEnabled: boolean;
  ignoredSources: FrameProcessor[];
  skipTextTypes: (TextType | string)[] | null;
  botOutputTransforms: [TextType | string, BotOutputTransform][] | null;
  audioLevelPeriodSecs: number;
  functionCallReportLevel: Record<string, RTVIFunctionCallReportLevel>;

  constructor(options: RTVIObserverParamsOptions = {}) {
    this.botOutputEnabled = options.botOutputEnabled ?? true;
    this.botLlmEnabled = options.botLlmEnabled ?? true;
    this.botLlmMarkerEnabled = options.botLlmMarkerEnabled ?? false;
    this.botTtsEnabled = options.botTtsEnabled ?? true;
    this.botSpeakingEnabled = options.botSpeakingEnabled ?? true;
    this.botAudioLevelEnabled = options.botAudioLevelEnabled ?? false;
    this.userLlmEnabled = options.userLlmEnabled ?? true;
    this.userSpeakingEnabled = options.userSpeakingEnabled ?? true;
    this.vadUserSpeakingEnabled = options.vadUserSpeakingEnabled ?? false;
    this.userMuteEnabled = options.userMuteEnabled ?? true;
    this.userInputEnabled = options.userInputEnabled ?? true;
    this.userAudioLevelEnabled = options.userAudioLevelEnabled ?? false;
    this.metricsEnabled = options.metricsEnabled ?? true;
    this.systemLogsEnabled = options.systemLogsEnabled ?? false;
    this.sttRawTextEnabled = options.sttRawTextEnabled ?? false;
    this.llmRawTextEnabled = options.llmRawTextEnabled ?? false;
    this.ttsRawTextEnabled = options.ttsRawTextEnabled ?? false;
    this.ignoredSources = options.ignoredSources ?? [];
    this.skipTextTypes = options.skipTextTypes ?? null;
    this.botOutputTransforms = options.botOutputTransforms ?? null;
    this.audioLevelPeriodSecs = options.audioLevelPeriodSecs ?? 0.15;
    this.functionCallReportLevel = options.functionCallReportLevel ?? {
      "*": RTVIFunctionCallReportLevel.NONE,
    };
  }
}

/** Options for `RTVIObserver`. */
export interface RTVIObserverOptions extends BaseObserverOptions {
  /** Settings to enable/disable specific messages. */
  params?: RTVIObserverParams | null;
}

type FunctionCallPhase = "started" | "in_progress" | "stopped";

// Python truthiness, for `x if x else None`.
function pyTruthy(value: unknown): boolean {
  if (value === null || value === undefined || value === false || value === 0 || value === "") {
    return false;
  }
  if (Array.isArray(value)) return value.length > 0;
  if (value instanceof Map || value instanceof Set) return value.size > 0;
  if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.keys(value).length > 0;
  }
  return true;
}

// Pydantic's `model_dump(exclude_none=True)` for the metrics models, which
// are plain classes here: camelCase fields become their snake_case wire keys
// and null fields are dropped, recursively.
function dumpExcludeNone(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(dumpExcludeNone);
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, field] of Object.entries(value)) {
      if (field === null || field === undefined) continue;
      out[key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)] = dumpExcludeNone(field);
    }
    return out;
  }
  return value;
}

function dumpMetrics(model: object): Record<string, unknown> {
  return dumpExcludeNone(model) as Record<string, unknown>;
}

// Python's list comparison `a >= b`.
function versionAtLeast(a: number[], b: number[]): boolean {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i] as number;
    const y = b[i] as number;
    if (x !== y) return x > y;
  }
  return a.length >= b.length;
}

/**
 * Pipeline frame observer for RTVI server message handling.
 *
 * This observer monitors pipeline frames and converts them into appropriate
 * RTVI messages for client communication. It handles various frame types
 * including speech events, transcriptions, LLM responses, and TTS events.
 *
 * Note: this observer only handles outgoing messages. Incoming RTVI client
 * messages are handled by the RTVIProcessor.
 */
export class RTVIObserver extends BaseObserver {
  protected _rtvi: RTVIProcessor | null;
  protected _params: RTVIObserverParams;

  protected _ignoredSources: Set<FrameProcessor>;

  protected _botTranscription = "";
  protected _lastUserAudioLevel = 0;
  protected _lastBotAudioLevel = 0;
  protected _userVolumeTracker = new AudioVolumeTracker();
  protected _botVolumeTracker = new AudioVolumeTracker();

  // Track bot speaking state for queuing aggregated text frames
  protected _botIsSpeaking = false;
  protected _queuedAggregatedTextFrames: AggregatedTextFrame[] = [];
  // Skipped segments whose spoken text may still come (see _isSkipped)
  protected _skippedSegmentIds = new Set<number>();
  // Whether an interruption cut off the skipped segments still remembered
  protected _skippedSegmentsInterrupted = false;

  // Removes the system logs sink (loguru's `logger.remove(id)`).
  protected _systemLoggerRemove: (() => void) | null = null;
  // Tasks sending system logs; loguru schedules coroutine sinks as tasks.
  readonly #systemLogTasks = new Set<Task<unknown>>();

  protected _aggregationTransforms: [TextType | string, BotOutputTransform][] = [];

  /**
   * Initialize the RTVI observer.
   *
   * @param rtvi The RTVI processor to push frames to.
   * @param options.params Settings to enable/disable specific messages.
   *   Other options are passed to the parent class.
   */
  constructor(rtvi: RTVIProcessor | null = null, options: RTVIObserverOptions = {}) {
    super(options);
    this._rtvi = rtvi;
    this._params = options.params || new RTVIObserverParams();

    this._ignoredSources = new Set(this._params.ignoredSources);

    if (this._params.systemLogsEnabled) {
      this._systemLoggerRemove = logger.addSink((record) => this.#scheduleLoggerSink(record));
    }

    for (const [textType, fn] of this._params.botOutputTransforms ?? []) {
      this.addBotOutputTransformer(fn, textType);
    }
  }

  /** Whether the connected client uses a deprecated 1.x protocol. */
  protected get _isLegacyClient(): boolean {
    if (!this._rtvi) {
      return false;
    }
    return this._rtvi.clientVersion[0] === RTVI.LEGACY_SUPPORTED_MAJOR;
  }

  /** Whether the connected client's protocol is `version` or later. */
  protected _clientIsAtLeast(version: number[]): boolean {
    if (!this._rtvi) {
      // No client has negotiated a version, so assume the current protocol, as
      // _isLegacyClient does.
      return true;
    }
    return versionAtLeast(this._rtvi.clientVersion, version);
  }

  /** Whether the connected client supports the backchannel text type (2.2.0+). */
  protected get _clientSupportsBackchannels(): boolean {
    return this._clientIsAtLeast([2, 2, 0]);
  }

  /** Whether the connected client supports the raw text messages (2.2.0+). */
  protected get _clientSupportsRawText(): boolean {
    return this._clientIsAtLeast([2, 2, 0]);
  }

  /**
   * Register a text transformer for a specific text type.
   *
   * When `accumulatedText` and `remainingText` are null the transform is
   * being called for the full segment text (`bot-output` message). When they
   * are provided it is being called for a progress event; return a
   * `BotOutputTransformResult` with `accumulatedText` and `remainingText`
   * populated so the client can display word-level progress on the
   * transformed text.
   *
   * @param transformFunction The transform callable.
   * @param textType Text type to match, or `"*"` for all types.
   */
  addBotOutputTransformer(
    transformFunction: BotOutputTransform,
    textType: TextType | string = "*",
  ): void {
    this._aggregationTransforms.push([textType, transformFunction]);
  }

  /**
   * Remove a text transformer for a specific text type.
   *
   * @param transformFunction The function to remove.
   * @param textType The type of text to remove the transformer for.
   */
  removeBotOutputTransformer(
    transformFunction: BotOutputTransform,
    textType: TextType | string = "*",
  ): void {
    this._aggregationTransforms = this._aggregationTransforms.filter(
      ([transformType, func]) => !(transformType === textType && func === transformFunction),
    );
  }

  /**
   * Ignore all frames pushed by the given processor.
   *
   * Any frame whose source matches `source` will be silently skipped,
   * preventing RTVI messages from being emitted for activity in that
   * processor. Useful for suppressing events from secondary pipeline
   * branches (e.g. a silent evaluation LLM) that should not be visible
   * to clients.
   *
   * @param source The frame processor to ignore.
   */
  addIgnoredSource(source: FrameProcessor): void {
    this._ignoredSources.add(source);
  }

  /**
   * Stop ignoring frames pushed by the given processor.
   *
   * Reverses a previous call to `addIgnoredSource()`. If `source` was not
   * previously ignored this is a no-op.
   *
   * @param source The frame processor to stop ignoring.
   */
  removeIgnoredSource(source: FrameProcessor): void {
    this._ignoredSources.delete(source);
  }

  /**
   * Get the report level for a specific function call.
   *
   * @param functionName The name of the function to get the report level for.
   * @returns The report level for the function. Looks up the function name
   *   first, then falls back to "*" key, then NONE.
   */
  protected _getFunctionCallReportLevel(functionName: string): RTVIFunctionCallReportLevel {
    const levels = this._params.functionCallReportLevel;
    if (Object.hasOwn(levels, functionName)) {
      return levels[functionName] as RTVIFunctionCallReportLevel;
    }
    return Object.hasOwn(levels, "*")
      ? (levels["*"] as RTVIFunctionCallReportLevel)
      : RTVIFunctionCallReportLevel.NONE;
  }

  /**
   * Apply a dynamic observer-config update (only the fields that are set).
   *
   * @param frame The config frame; null fields leave the current value unchanged.
   */
  protected _applyConfig(frame: RTVIConfigureObserverFrame): void {
    if (frame.functionCallReportLevel !== null && frame.functionCallReportLevel !== undefined) {
      this._params.functionCallReportLevel = frame.functionCallReportLevel;
      logger.debug(
        `${this}: function_call_report_level set to ${JSON.stringify(frame.functionCallReportLevel)}`,
      );
    }
    if (frame.vadUserSpeakingEnabled !== null && frame.vadUserSpeakingEnabled !== undefined) {
      this._params.vadUserSpeakingEnabled = frame.vadUserSpeakingEnabled;
      logger.debug(`${this}: vad_user_speaking_enabled set to ${frame.vadUserSpeakingEnabled}`);
    }
    if (frame.botLlmMarkerEnabled !== null && frame.botLlmMarkerEnabled !== undefined) {
      this._params.botLlmMarkerEnabled = frame.botLlmMarkerEnabled;
      logger.debug(`${this}: bot_llm_marker_enabled set to ${frame.botLlmMarkerEnabled}`);
    }
  }

  // Log sinks are synchronous here; run the async sink as a tracked task, as
  // loguru does with coroutine sinks.
  #scheduleLoggerSink(record: LogRecord): void {
    const message = `${record.time.toISOString()} | ${record.level.padEnd(8)} | ${record.message}`;
    const task = createTask(() => this._loggerSink(message));
    this.#systemLogTasks.add(task);
    task.addDoneCallback(() => this.#systemLogTasks.delete(task));
  }

  /** Logger sink so we can send system logs to RTVI clients. */
  protected async _loggerSink(message: string): Promise<void> {
    const rtviMessage = new RTVI.SystemLogMessage({
      data: new RTVI.TextMessageData({ text: message }),
    });
    await this.sendRtviMessage(rtviMessage);
  }

  /** Cleanup RTVI observer resources. */
  override async cleanup(): Promise<void> {
    await super.cleanup();
    if (this._systemLoggerRemove !== null) {
      this._systemLoggerRemove();
      this._systemLoggerRemove = null;
    }
  }

  /**
   * Send an RTVI message.
   *
   * By default, we push a transport frame. But this function can be
   * overridden by subclass to send RTVI messages in different ways.
   *
   * @param model The message to send.
   * @param excludeNone Whether to exclude null values from the model dump.
   */
  async sendRtviMessage(model: RTVIModelLike, excludeNone = true): Promise<void> {
    if (this._rtvi) {
      await this._rtvi.pushTransportMessage(model, excludeNone);
    }
  }

  /** Report a function-call frame, the pipeline's own or an external one. */
  protected async _reportFunctionCallFrame(frame: Frame): Promise<void> {
    if (frame instanceof FunctionCallsStartedFrame) {
      for (const functionCall of frame.functionCalls) {
        await this._reportFunctionCall(
          "started",
          functionCall.functionName,
          functionCall.toolCallId,
        );
      }
    } else if (frame instanceof FunctionCallInProgressFrame) {
      await this._reportFunctionCall("in_progress", frame.functionName, frame.toolCallId, {
        arguments: frame.arguments,
      });
    } else if (frame instanceof FunctionCallCancelFrame) {
      await this._reportFunctionCall("stopped", frame.functionName, frame.toolCallId, {
        cancelled: true,
      });
    } else if (frame instanceof FunctionCallResultFrame) {
      // An intermediate result leaves the call running.
      if (frame.properties === null || frame.properties === undefined || frame.properties.isFinal) {
        await this._reportFunctionCall("stopped", frame.functionName, frame.toolCallId, {
          result: frame.result,
        });
      }
    } else if (frame instanceof ExternalFunctionCallsStartedFrame) {
      for (const call of frame.functionCalls) {
        await this._reportFunctionCall("started", call.functionName, call.toolCallId);
      }
    } else if (frame instanceof ExternalFunctionCallInProgressFrame) {
      await this._reportFunctionCall("in_progress", frame.functionName, frame.toolCallId, {
        arguments: frame.arguments,
      });
    } else if (frame instanceof ExternalFunctionCallResultFrame) {
      if (frame.isFinal) {
        await this._reportFunctionCall("stopped", frame.functionName, frame.toolCallId, {
          result: frame.result,
        });
      }
    } else if (frame instanceof ExternalFunctionCallCancelFrame) {
      await this._reportFunctionCall("stopped", frame.functionName, frame.toolCallId, {
        cancelled: true,
      });
    }
  }

  /**
   * Send the function-call message for a phase, as the report level allows.
   *
   * The pipeline's own calls and calls reported from elsewhere (the
   * `ExternalFunctionCall*Frame` family) go through here alike, so both obey
   * the per-function report level.
   */
  protected async _reportFunctionCall(
    phase: FunctionCallPhase,
    functionName: string,
    toolCallId: string,
    options: { arguments?: unknown; result?: unknown; cancelled?: boolean } = {},
  ): Promise<void> {
    const args = options.arguments ?? null;
    const result = options.result ?? null;
    const cancelled = options.cancelled ?? false;

    const reportLevel = this._getFunctionCallReportLevel(functionName);
    if (reportLevel === RTVIFunctionCallReportLevel.DISABLED) {
      return;
    }
    const named =
      reportLevel === RTVIFunctionCallReportLevel.NAME ||
      reportLevel === RTVIFunctionCallReportLevel.ARGUMENTS ||
      reportLevel === RTVIFunctionCallReportLevel.FULL;
    const withArguments =
      reportLevel === RTVIFunctionCallReportLevel.ARGUMENTS ||
      reportLevel === RTVIFunctionCallReportLevel.FULL;
    const full = reportLevel === RTVIFunctionCallReportLevel.FULL;
    let message: RTVIModelLike;
    if (phase === "started") {
      message = new RTVI.LLMFunctionCallStartMessage({
        data: new RTVI.LLMFunctionCallStartMessageData({
          functionName: named ? functionName : null,
        }),
      });
    } else if (phase === "in_progress") {
      message = new RTVI.LLMFunctionCallInProgressMessage({
        data: new RTVI.LLMFunctionCallInProgressMessageData({
          toolCallId,
          functionName: named ? functionName : null,
          arguments: withArguments ? (args as Record<string, unknown> | null) : null,
        }),
      });
    } else {
      message = new RTVI.LLMFunctionCallStoppedMessage({
        data: new RTVI.LLMFunctionCallStoppedMessageData({
          toolCallId,
          cancelled,
          functionName: named ? functionName : null,
          result: full && !cancelled ? (pyTruthy(result) ? result : null) : null,
        }),
      });
    }
    await this.sendRtviMessage(message);
  }

  /**
   * Process a frame being pushed through the pipeline.
   *
   * @param data Frame push event data containing source, frame, direction,
   *   and timestamp.
   */
  /**
   * The pushes `onPushFrame` would return from at once, told apart from the
   * push alone (see `BaseObserver.acceptsPush`), so the worker doesn't wake
   * this observer for every hop of every frame. A subclass that overrides
   * `onPushFrame` is sent every push, as before.
   */
  override acceptsPush(data: FramePushed): boolean {
    if (this.onPushFrame !== RTVIObserver.prototype.onPushFrame) return true;
    const frame = data.frame;
    if (frame.broadcastSiblingId !== null && data.direction !== FrameDirection.DOWNSTREAM) {
      return false;
    }
    if (
      frame instanceof AudioRawFrame &&
      !(this._params.userAudioLevelEnabled || this._params.botAudioLevelEnabled)
    ) {
      return false;
    }
    return (
      data.firstPush ||
      frame instanceof AggregatedTextFrame ||
      frame instanceof AggregatedTextProgressFrame
    );
  }

  override async onPushFrame(data: FramePushed): Promise<void> {
    const src = data.source;
    const frame = data.frame;
    const direction = data.direction;

    // Frames from explicitly ignored sources are always skipped.
    if (this._ignoredSources.size > 0 && this._ignoredSources.has(src)) {
      return;
    }

    // For broadcast frames (pushed in both directions), only process
    // the downstream copy to avoid sending duplicate RTVI messages.
    if (frame.broadcastSiblingId !== null && direction !== FrameDirection.DOWNSTREAM) {
      return;
    }

    // Audio frames are the bulk of what a pipeline pushes, and they are
    // only handled when audio levels are reported.
    if (
      frame instanceof AudioRawFrame &&
      !(this._params.userAudioLevelEnabled || this._params.botAudioLevelEnabled)
    ) {
      return;
    }

    // A frame is handled the first time it is pushed, except aggregated
    // text, which is handled once it has gone through the output
    // transport and has the right timing.
    if (
      !data.firstPush &&
      !(frame instanceof AggregatedTextFrame || frame instanceof AggregatedTextProgressFrame)
    ) {
      return;
    }

    if (
      (frame instanceof UserStartedSpeakingFrame || frame instanceof UserStoppedSpeakingFrame) &&
      this._params.userSpeakingEnabled
    ) {
      await this._handleInterruptions(frame);
    } else if (
      (frame instanceof VADUserStartedSpeakingFrame ||
        frame instanceof VADUserStoppedSpeakingFrame) &&
      this._params.vadUserSpeakingEnabled
    ) {
      await this._handleVadSpeaking(frame);
    } else if (
      (frame instanceof UserMuteStartedFrame || frame instanceof UserMuteStoppedFrame) &&
      this._params.userMuteEnabled
    ) {
      await this._handleUserMute(frame);
    } else if (
      frame instanceof BotStartedSpeakingFrame ||
      frame instanceof BotStoppedSpeakingFrame
    ) {
      await this._handleBotSpeaking(frame);
    } else if (frame instanceof InterruptionFrame) {
      await this._handleBotInterrupted();
    } else if (frame instanceof TranscriptionFrame || frame instanceof InterimTranscriptionFrame) {
      await this._handleUserTranscriptions(frame);
    } else if (frame instanceof UserBackchannelFrame && this._params.userInputEnabled) {
      await this._sendUserInput(frame.text, "backchannel", {
        timestamp: frame.timestamp,
        final: true,
        userId: frame.userId,
      });
    } else if (frame instanceof RTVISendTextFrame && this._params.userInputEnabled) {
      await this._sendUserInput(frame.text, "chat", {
        timestamp: timeNowIso8601(),
        final: true,
        userId: frame.userId,
        msgId: frame.msgId,
      });
    } else if (frame instanceof LLMContextFrame && this._params.userLlmEnabled) {
      await this._handleContext(frame);
    } else if (frame instanceof LLMFullResponseStartFrame && this._params.botLlmEnabled) {
      await this.sendRtviMessage(new RTVI.BotLLMStartedMessage());
    } else if (frame instanceof LLMFullResponseEndFrame && this._params.botLlmEnabled) {
      await this.sendRtviMessage(new RTVI.BotLLMStoppedMessage());
    } else if (
      frame instanceof LLMTextFrame &&
      (this._params.botLlmEnabled || this._params.llmRawTextEnabled)
    ) {
      await this._handleLlmTextFrame(frame);
    } else if (frame instanceof LLMMarkerResponseFrame && this._params.botLlmMarkerEnabled) {
      await this.sendRtviMessage(
        new RTVI.BotLLMMarkerMessage({
          data: new RTVI.BotLLMMarkerMessageData({
            text: frame.marker || "",
            kind: frame.kind,
            raw: frame.raw,
            markers: [...frame.markers],
          }),
        }),
      );
    } else if (frame instanceof TTSStartedFrame && this._params.botTtsEnabled) {
      await this.sendRtviMessage(new RTVI.BotTTSStartedMessage());
    } else if (frame instanceof TTSStoppedFrame && this._params.botTtsEnabled) {
      await this.sendRtviMessage(new RTVI.BotTTSStoppedMessage());
    } else if (frame instanceof AggregatedTextProgressFrame) {
      if (src instanceof BaseOutputTransport) {
        await this._handleAggregatedProgress(frame);
      }
    } else if (
      frame instanceof AggregatedTextFrame &&
      (this._params.botOutputEnabled ||
        this._params.botTtsEnabled ||
        this._params.ttsRawTextEnabled)
    ) {
      if (src instanceof BaseOutputTransport) {
        await this._handleAggregatedLlmText(frame);
      }
    } else if (frame instanceof MetricsFrame && this._params.metricsEnabled) {
      await this._handleMetrics(frame);
    } else if (
      frame instanceof FunctionCallsStartedFrame ||
      frame instanceof FunctionCallInProgressFrame ||
      frame instanceof FunctionCallCancelFrame ||
      frame instanceof FunctionCallResultFrame ||
      frame instanceof ExternalFunctionCallsStartedFrame ||
      frame instanceof ExternalFunctionCallInProgressFrame ||
      frame instanceof ExternalFunctionCallCancelFrame ||
      frame instanceof ExternalFunctionCallResultFrame
    ) {
      await this._reportFunctionCallFrame(frame);
    } else if (frame instanceof RTVIServerMessageFrame) {
      const message = new RTVI.ServerMessage({ data: frame.data });
      await this.sendRtviMessage(message);
    } else if (frame instanceof RTVIUICommandFrame) {
      const message = new RTVI.UICommandMessage({
        data: new RTVI.UICommandData({ command: frame.command, payload: frame.payload }),
      });
      await this.sendRtviMessage(message);
    } else if (frame instanceof RTVIUIJobGroupFrame) {
      if (frame.data !== null && frame.data !== undefined) {
        const message = new RTVI.UIJobGroupMessage({ data: frame.data });
        await this.sendRtviMessage(message);
      }
    } else if (frame instanceof RTVIConfigureObserverFrame) {
      this._applyConfig(frame);
    } else if (frame instanceof RTVIServerResponseFrame) {
      if (frame.error !== null && frame.error !== undefined) {
        await this._sendErrorResponse(frame);
      } else {
        await this._sendServerResponse(frame);
      }
    } else if (frame instanceof InputAudioRawFrame && this._params.userAudioLevelEnabled) {
      // Every frame feeds the rolling window, but the window is only
      // measured when a level is due to be reported.
      this._userVolumeTracker.update(frame.audio, frame.sampleRate);
      const currTime = time();
      const diffTime = currTime - this._lastUserAudioLevel;
      if (diffTime > this._params.audioLevelPeriodSecs) {
        const level = this._userVolumeTracker.volume;
        const message = new RTVI.UserAudioLevelMessage({
          data: new RTVI.AudioLevelMessageData({ value: level }),
        });
        await this.sendRtviMessage(message);
        this._lastUserAudioLevel = currTime;
      }
    } else if (frame instanceof TTSAudioRawFrame && this._params.botAudioLevelEnabled) {
      this._botVolumeTracker.update(frame.audio, frame.sampleRate);
      const currTime = time();
      const diffTime = currTime - this._lastBotAudioLevel;
      if (diffTime > this._params.audioLevelPeriodSecs) {
        const level = this._botVolumeTracker.volume;
        const message = new RTVI.BotAudioLevelMessage({
          data: new RTVI.AudioLevelMessageData({ value: level }),
        });
        await this.sendRtviMessage(message);
        this._lastBotAudioLevel = currTime;
      }
    }
  }

  /** Handle user speaking interruption frames. */
  protected async _handleInterruptions(frame: Frame): Promise<void> {
    let message: RTVIModelLike | null = null;
    if (frame instanceof UserStartedSpeakingFrame) {
      message = new RTVI.UserStartedSpeakingMessage();
    } else if (frame instanceof UserStoppedSpeakingFrame) {
      message = new RTVI.UserStoppedSpeakingMessage();
    }

    if (message) {
      await this.sendRtviMessage(message);
    }
  }

  /** Emit raw VAD user started/stopped speaking messages. */
  protected async _handleVadSpeaking(frame: Frame): Promise<void> {
    let message: RTVIModelLike | null = null;
    if (frame instanceof VADUserStartedSpeakingFrame) {
      message = new RTVI.VADUserStartedSpeakingMessage();
    } else if (frame instanceof VADUserStoppedSpeakingFrame) {
      message = new RTVI.VADUserStoppedSpeakingMessage();
    }

    if (message) {
      await this.sendRtviMessage(message);
    }
  }

  /** Handle user mute/unmute frames. */
  protected async _handleUserMute(frame: Frame): Promise<void> {
    let message: RTVIModelLike | null = null;
    if (frame instanceof UserMuteStartedFrame) {
      message = new RTVI.UserMuteStartedMessage();
    } else if (frame instanceof UserMuteStoppedFrame) {
      message = new RTVI.UserMuteStoppedMessage();
    }

    if (message) {
      await this.sendRtviMessage(message);
    }
  }

  /** Track whether the bot is speaking, and tell clients if they want to know. */
  protected async _handleBotSpeaking(frame: Frame): Promise<void> {
    if (frame instanceof BotStartedSpeakingFrame) {
      if (this._params.botSpeakingEnabled) {
        await this.sendRtviMessage(new RTVI.BotStartedSpeakingMessage());
      }
      this._forgetInterruptedSegments();
      // Flush any queued aggregated text frames
      for (const queuedFrame of this._queuedAggregatedTextFrames) {
        await this._sendAggregatedLlmText(queuedFrame);
      }
      this._queuedAggregatedTextFrames.length = 0;
      this._botIsSpeaking = true;
    } else if (frame instanceof BotStoppedSpeakingFrame) {
      if (this._params.botSpeakingEnabled) {
        await this.sendRtviMessage(new RTVI.BotStoppedSpeakingMessage());
      }
      this._forgetInterruptedSegments();
      this._botIsSpeaking = false;
    }
  }

  /** Tell clients the bot's output was cut off, and drop what it won't say. */
  protected async _handleBotInterrupted(): Promise<void> {
    // The bot's in-flight output was cut off (VAD barge-in or a programmatic
    // runImmediately interrupt). Let clients drop what it was mid-saying.
    if (this._params.botSpeakingEnabled) {
      await this.sendRtviMessage(new RTVI.BotInterruptedMessage());
    }
    this._skippedSegmentsInterrupted = true;
    // Queued text whose speech was cut off would otherwise go out with the
    // next speech, and hold back text that won't be spoken.
    this._queuedAggregatedTextFrames = this._queuedAggregatedTextFrames.filter(
      (f) => !f.interruptible,
    );
  }

  /** Handle aggregated LLM text output frames. */
  protected async _handleAggregatedLlmText(frame: AggregatedTextFrame): Promise<void> {
    // Text waits for the bot to start speaking, including text spoken without
    // a TTS service (a speech-to-speech service's transcript). Text the TTS
    // left out (skipTts) has nothing to wait for, except text queued before it.
    if (this._botIsSpeaking || (frame.skipTts && this._queuedAggregatedTextFrames.length === 0)) {
      await this._sendAggregatedLlmText(frame);
    } else {
      this._queuedAggregatedTextFrames.push(frame);
    }
  }

  /** Handle progress frames. */
  protected async _handleAggregatedProgress(frame: AggregatedTextProgressFrame): Promise<void> {
    if (this._isSkippedType(frame.textType)) {
      if (frame.remainingText === "") {
        // The skipped segment's last word has been spoken.
        this._skippedSegmentIds.delete(frame.segmentId);
      }
      return;
    }

    // 1.4.x clients use the old separate bot-output-progress event which was never
    // released, so progress events are simply not sent to legacy clients.
    if (this._isLegacyClient) {
      return;
    }

    logger.trace(
      `${this} TTS progress: context_id=${frame.contextId} ` +
        `source_segment_id=${frame.segmentId} ` +
        `accumulated=${JSON.stringify(frame.accumulatedText)} ` +
        `remaining=${JSON.stringify(frame.remainingText)}`,
    );

    let accumulated = frame.accumulatedText;
    let remaining = frame.remainingText;
    let text = frame.text;
    const textType = frame.textType;

    for (const [transformType, transform] of this._aggregationTransforms) {
      if (transformType === textType || transformType === "*") {
        const result = await transform(text, textType, accumulated, remaining);
        if (result instanceof BotOutputTransformResult) {
          accumulated = result.accumulatedText || accumulated;
          remaining = result.remainingText || remaining;
          text = result.text || text;
        }
      }
    }

    if (this._params.botOutputEnabled) {
      const spokenStatus: RTVI.SpokenStatus = remaining === "" ? "completed" : "in-progress";
      const message = new RTVI.BotOutputMessage({
        data: new RTVI.BotOutputMessageData({
          text,
          willBeSpoken: true,
          textType,
          segmentId: frame.segmentId,
          spokenStatus,
          spokenProgress: new RTVI.SpokenProgressData({
            accumulatedText: accumulated,
            remainingText: remaining,
          }),
        }),
      });
      await this.sendRtviMessage(message);
    }
  }

  /** Forget the skipped segments an interruption cut off. */
  protected _forgetInterruptedSegments(): void {
    // By the time the bot next starts or stops speaking, the output transport
    // has dropped the interrupted words, so none of them can still come.
    if (this._skippedSegmentsInterrupted) {
      this._skippedSegmentIds.clear();
      this._skippedSegmentsInterrupted = false;
    }
  }

  /** Whether text of this type is kept out of bot output and TTS text messages. */
  protected _isSkippedType(textType: TextType | string): boolean {
    // A client that doesn't support backchannels would show one as part of the
    // bot's response.
    if (textType === TextType.BACKCHANNEL && !this._clientSupportsBackchannels) {
      return true;
    }
    const skipTypes = this._params.skipTextTypes;
    return Boolean(skipTypes && skipTypes.length > 0 && skipTypes.includes(textType));
  }

  /** Whether the frame's text type, or its segment's, keeps it from bot output. */
  protected _isSkipped(frame: AggregatedTextFrame): boolean {
    const segmentId = frame instanceof TTSTextFrame ? frame.segmentId : null;
    if (this._isSkippedType(frame.textType)) {
      if (segmentId !== null && segmentId !== undefined) {
        // The segment spoken in one piece: no words of it follow.
        this._skippedSegmentIds.delete(segmentId);
      } else if (frame.willBeSpoken) {
        // A segment the TTS will speak: skip the words it is spoken in too.
        this._skippedSegmentIds.add(frame.id);
      }
      return true;
    }
    // A word is skipped with the segment it was spoken in.
    return segmentId !== null && segmentId !== undefined && this._skippedSegmentIds.has(segmentId);
  }

  /** Send aggregated LLM text messages. */
  protected async _sendAggregatedLlmText(frame: AggregatedTextFrame): Promise<void> {
    if (this._isSkipped(frame)) {
      return;
    }

    const textType = frame.textType;

    // For 2.0.0+ clients, word and token types are not emitted as bot-output events;
    // word-level progress is covered by the spoken_status/spoken_progress fields.
    // bot-tts-text is a separate channel and is NOT suppressed here.
    const suppressBotOutput =
      !this._isLegacyClient && (textType === TextType.WORD || textType === TextType.TOKEN);

    let text = frame.text;
    for (const [transformType, transform] of this._aggregationTransforms) {
      if (transformType === textType || transformType === "*") {
        const result = await transform(text, textType, null, null);
        text = result instanceof BotOutputTransformResult ? result.text : result;
      }
    }

    const isTTS = frame instanceof TTSTextFrame;
    const willBeSpoken = frame.willBeSpoken;
    // Text the TTS spoke for a segment is reported as that segment.
    let segmentId = frame.id;
    if (
      frame instanceof TTSTextFrame &&
      frame.segmentId !== null &&
      frame.segmentId !== undefined
    ) {
      segmentId = frame.segmentId;
    }
    if (this._params.botOutputEnabled && !suppressBotOutput) {
      let spokenStatus: RTVI.SpokenStatus;
      let progress: RTVI.SpokenProgressData | null;
      if (willBeSpoken) {
        if (isTTS) {
          // pushTextFrames path: TTSTextFrame arrives after synthesis completes
          spokenStatus = "completed";
          progress = new RTVI.SpokenProgressData({ accumulatedText: text, remainingText: "" });
        } else {
          // word-timestamp path: AggregatedTextFrame arrives before synthesis starts
          spokenStatus = "new";
          progress = new RTVI.SpokenProgressData({ accumulatedText: "", remainingText: text });
        }
      } else {
        // Text that isn't spoken gets this one message, which starts its
        // segment as spoken text's first message does.
        spokenStatus = "new";
        progress = null;
      }

      const data = new RTVI.BotOutputMessageData({
        text,
        spoken: isTTS,
        willBeSpoken,
        textType,
        segmentId,
        spokenStatus,
        spokenProgress: progress,
      });
      const message = new RTVI.BotOutputMessage({ data });
      await this.sendRtviMessage(message);
    }

    if (isTTS && this._params.ttsRawTextEnabled && this._clientSupportsRawText) {
      await this.sendRtviMessage(
        new RTVI.TTSRawTextMessage({ data: new RTVI.TextMessageData({ text }) }),
      );
    }

    if (isTTS && this._params.botTtsEnabled) {
      const ttsMessage = new RTVI.BotTTSTextMessage({ data: new RTVI.TextMessageData({ text }) });
      await this.sendRtviMessage(ttsMessage);
    }
  }

  /** Handle LLM text output frames. */
  protected async _handleLlmTextFrame(frame: LLMTextFrame): Promise<void> {
    if (this._params.llmRawTextEnabled && this._clientSupportsRawText) {
      await this.sendRtviMessage(
        new RTVI.LLMRawTextMessage({ data: new RTVI.TextMessageData({ text: frame.text }) }),
      );
    }

    if (!this._params.botLlmEnabled) {
      return;
    }

    const message = new RTVI.BotLLMTextMessage({
      data: new RTVI.TextMessageData({ text: frame.text }),
    });
    await this.sendRtviMessage(message);

    // TODO (mrkb): Remove all this logic when we fully deprecate bot-transcription messages.
    this._botTranscription += frame.text;

    if (matchEndofsentence(this._botTranscription) && this._botTranscription.length > 0) {
      await this.sendRtviMessage(
        new RTVI.BotTranscriptionMessage({
          data: new RTVI.TextMessageData({ text: this._botTranscription }),
        }),
      );
      this._botTranscription = "";
    }
  }

  /** Handle user transcription frames. */
  protected async _handleUserTranscriptions(
    frame: TranscriptionFrame | InterimTranscriptionFrame,
  ): Promise<void> {
    const final = frame instanceof TranscriptionFrame;
    if (this._params.userInputEnabled) {
      await this._sendUserInput(frame.text, "transcription", {
        timestamp: frame.timestamp,
        final,
        userId: frame.userId,
      });
    }
    if (this._params.sttRawTextEnabled && this._clientSupportsRawText) {
      await this.sendRtviMessage(
        new RTVI.STTRawTextMessage({
          data: new RTVI.STTRawTextMessageData({
            text: frame.text,
            userId: frame.userId,
            timestamp: frame.timestamp,
            final,
          }),
        }),
      );
    }
    // `user-transcription` is deprecated upstream, but clients still consume
    // it; the deprecated switch to turn it off is not ported.
    const message = new RTVI.UserTranscriptionMessage({
      data: new RTVI.UserTranscriptionMessageData({
        text: frame.text,
        userId: frame.userId,
        timestamp: frame.timestamp,
        final,
      }),
    });
    await this.sendRtviMessage(message);
  }

  /** Send a user input message. */
  protected async _sendUserInput(
    text: string,
    inputType: RTVI.UserInputType,
    options: {
      timestamp: string;
      final: boolean;
      userId?: string | null;
      msgId?: string | null;
    },
  ): Promise<void> {
    const message = new RTVI.UserInputMessage({
      data: new RTVI.UserInputMessageData({
        text,
        inputType,
        timestamp: options.timestamp,
        final: options.final,
        userId: options.userId ?? null,
        msgId: options.msgId ?? null,
      }),
    });
    await this.sendRtviMessage(message);
  }

  /** Process LLM context frames to extract user messages for the RTVI client. */
  protected async _handleContext(frame: LLMContextFrame): Promise<void> {
    try {
      const messages = frame.context.getMessages() as unknown[];
      if (!messages || messages.length === 0) {
        return;
      }

      const message = messages[messages.length - 1] as Record<string, unknown> | null;
      // Upstream tells the two formats apart by `getattr` (never true for a
      // dict) vs `isinstance(message, dict)`: a plain object here is a dict.
      const isObject = message !== null && typeof message === "object";
      const proto = isObject ? Object.getPrototypeOf(message) : undefined;
      const isDict = isObject && (proto === Object.prototype || proto === null);

      // Handle Google LLM format (objects with a `parts` attribute)
      // Note: not possible if frame is a universal LLMContextFrame
      if (isObject && !isDict && message.role === "user" && "parts" in message) {
        const parts = (message.parts ?? []) as { text?: unknown }[];
        const text = parts
          .filter((part) => part !== null && typeof part === "object" && "text" in part)
          .map((part) => part.text)
          .join("");
        if (text) {
          const rtviMessage = new RTVI.UserLLMTextMessage({
            data: new RTVI.TextMessageData({ text }),
          });
          await this.sendRtviMessage(rtviMessage);
        }
      }

      // Handle OpenAI format (original implementation)
      else if (isDict) {
        if (message.role === "user") {
          const content = message.content;
          if (content === null || content === undefined) {
            return;
          }
          let text: string;
          if (typeof content === "string") {
            text = content;
          } else {
            // Anything else is a sequence of content parts.
            text = (content as Record<string, unknown>[])
              .filter((item) => "text" in item)
              .map((item) => item.text)
              .join(" ");
          }
          const rtviMessage = new RTVI.UserLLMTextMessage({
            data: new RTVI.TextMessageData({ text }),
          });
          await this.sendRtviMessage(rtviMessage);
        }
      }
    } catch (e) {
      rethrowIfCancelled(e);
      logger.warning(
        `Caught an error while trying to handle context: ${e instanceof Error ? e.message : e}`,
      );
    }
  }

  /** Handle metrics frames and convert to RTVI metrics messages. */
  protected async _handleMetrics(frame: MetricsFrame): Promise<void> {
    const metrics: Record<string, Record<string, unknown>[]> = {};
    const append = (key: string, value: Record<string, unknown>) => {
      if (!(key in metrics)) {
        metrics[key] = [];
      }
      (metrics[key] as Record<string, unknown>[]).push(value);
    };
    for (const d of frame.data) {
      if (d instanceof TTFBMetricsData) {
        append("ttfb", dumpMetrics(d));
      } else if (d instanceof TTFAMetricsData) {
        append("ttfa", dumpMetrics(d));
      } else if (d instanceof TTFATMetricsData) {
        append("ttfat", dumpMetrics(d));
      } else if (d instanceof ProcessingMetricsData) {
        append("processing", dumpMetrics(d));
      } else if (d instanceof LLMUsageMetricsData) {
        append("tokens", dumpMetrics(d.value));
      } else if (d instanceof STTUsageMetricsData) {
        append("stt_usage", dumpMetrics(d));
      } else if (d instanceof TTSUsageMetricsData) {
        append("characters", dumpMetrics(d));
      }
    }

    const message = new RTVI.MetricsMessage({ data: metrics });
    await this.sendRtviMessage(message);
  }

  /** Send a response to the client for a specific request. */
  protected async _sendServerResponse(frame: RTVIServerResponseFrame): Promise<void> {
    const message = new RTVI.ServerResponse({
      id: String(frame.clientMsg.msgId),
      data: new RTVI.RawServerResponseData({ t: frame.clientMsg.type, d: frame.data }),
    });
    await this.sendRtviMessage(message);
  }

  /** Send a response to the client for a specific request. */
  protected async _sendErrorResponse(frame: RTVIServerResponseFrame): Promise<void> {
    if (frame.error === null || frame.error === undefined) {
      throw new Error("assertion failed: frame.error is not None");
    }

    const message = new RTVI.ErrorResponse({
      id: String(frame.clientMsg.msgId),
      data: new RTVI.ErrorResponseData({ error: frame.error }),
    });
    await this.sendRtviMessage(message);
  }
}
