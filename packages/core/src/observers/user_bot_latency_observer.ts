// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipecat-ts contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/observers/user_bot_latency_observer.py

/**
 * Observer for tracking user-to-bot response latency.
 *
 * Provides an observer that monitors the time between when a user stops
 * speaking and when the bot starts speaking, emitting events when latency is
 * measured. When `enableMetrics` is true it also collects a breakdown of the
 * interval: per-service metrics (TTFB, text aggregation), and contributions
 * that name each part of the timeline, including the parts no service
 * measures.
 */

import { time } from "@pipecat-ts/asyncio";
import {
  BotStartedSpeakingFrame,
  ClientConnectedFrame,
  FunctionCallInProgressFrame,
  FunctionCallResultFrame,
  InterruptionFrame,
  LLMFullResponseStartFrame,
  LLMMarkerFrame,
  LLMTextFrame,
  MetricsFrame,
  TranscriptionFrame,
  TTSAudioRawFrame,
  UserStoppedSpeakingFrame,
  VADUserStartedSpeakingFrame,
  VADUserStoppedSpeakingFrame,
} from "../frames/frames.ts";
import { TextAggregationMetricsData, TTFBMetricsData } from "../metrics/metrics.ts";
import { FrameDirection } from "../processors/frame_processor.ts";
import { BaseObserver, type BaseObserverOptions, type FramePushed } from "./base_observer.ts";

export interface TTFBBreakdownMetricsOptions {
  processor: string;
  model?: string | null;
  startTime: number;
  durationSecs: number;
}

/**
 * TTFB measurement with timestamp for timeline placement.
 *
 * - `processor`: name of the processor that reported the TTFB.
 * - `model`: optional model name associated with the metric.
 * - `startTime`: Unix timestamp (seconds) when the TTFB measurement started.
 * - `durationSecs`: TTFB duration in seconds.
 */
export class TTFBBreakdownMetrics {
  processor: string;
  model: string | null;
  startTime: number;
  durationSecs: number;

  constructor(options: TTFBBreakdownMetricsOptions) {
    this.processor = options.processor;
    this.model = options.model ?? null;
    this.startTime = options.startTime;
    this.durationSecs = options.durationSecs;
  }
}

export interface TextAggregationBreakdownMetricsOptions {
  processor: string;
  startTime: number;
  durationSecs: number;
}

/**
 * Text aggregation measurement with timestamp for timeline placement.
 *
 * - `processor`: name of the processor that reported the metric.
 * - `startTime`: Unix timestamp (seconds) when text aggregation started.
 * - `durationSecs`: aggregation duration in seconds.
 */
export class TextAggregationBreakdownMetrics {
  processor: string;
  startTime: number;
  durationSecs: number;

  constructor(options: TextAggregationBreakdownMetricsOptions) {
    this.processor = options.processor;
    this.startTime = options.startTime;
    this.durationSecs = options.durationSecs;
  }
}

export interface FunctionCallMetricsOptions {
  functionName: string;
  startTime: number;
  durationSecs: number;
}

/**
 * Latency for a single function call execution.
 *
 * - `functionName`: name of the function that was called.
 * - `startTime`: Unix timestamp (seconds) when execution started.
 * - `durationSecs`: time in seconds from execution start to result.
 */
export class FunctionCallMetrics {
  functionName: string;
  startTime: number;
  durationSecs: number;

  constructor(options: FunctionCallMetricsOptions) {
    this.functionName = options.functionName;
    this.startTime = options.startTime;
    this.durationSecs = options.durationSecs;
  }
}

/**
 * Anything shorter than this is a frame hop rather than work worth naming, so
 * it is rolled into the single pipeline contribution.
 */
export const MIN_CONTRIBUTION_SECS = 0.005;

/**
 * Half of the last digit `turnContributionLines()` prints, below which a span
 * would show as zero and so is not part of the timeline at all.
 */
export const PRINTS_AS_ZERO_SECS = 0.0005;

/**
 * A point in a user-to-bot cycle that a contribution can start or end at.
 *
 * Most are observed as frames. `LLM_CHUNK` and `SENTENCE` are worked back from
 * a service's own metric, because no frame marks them.
 */
const _MomentKind = {
  SILENCE: "silence",
  READY: "ready",
  VAD_STOP: "vad stop",
  TRANSCRIPT: "transcript",
  LLM_REQUEST: "llm request",
  LLM_CHUNK: "llm chunk",
  MARKER_COMPLETE: "marker complete",
  MARKER_INCOMPLETE: "marker incomplete",
  HANDLERS_START: "handlers start",
  HANDLERS_END: "handlers end",
  FIRST_TEXT: "first text",
  SENTENCE: "sentence",
  FIRST_AUDIO: "first audio",
  BOT_SPEAKING: "bot speaking",
} as const;
type _MomentKind = (typeof _MomentKind)[keyof typeof _MomentKind];

/**
 * One moment in a cycle.
 *
 * - `at`: Unix timestamp (seconds) of the moment.
 * - `kind`: what happened.
 * - `source`: name of whatever produced it, used when a span takes its owner
 *   from one end.
 * - `derived`: whether it was worked back from a metric rather than observed
 *   as a frame. A derived moment sits at or before the frame that reported
 *   it, which decides the order when the two share a time.
 */
class _Moment {
  readonly at: number;
  readonly kind: _MomentKind;
  readonly source: string;
  readonly derived: boolean;

  constructor(options: { at: number; kind: _MomentKind; source?: string; derived?: boolean }) {
    this.at = options.at;
    this.kind = options.kind;
    this.source = options.source ?? "";
    this.derived = options.derived ?? false;
  }
}

const OPENER: unique symbol = Symbol("OPENER");
const CLOSER: unique symbol = Symbol("CLOSER");

/** Which end of a span supplies its owner, when a setting does not. */
const _Owner = { OPENER, CLOSER } as const;
type _Owner = (typeof _Owner)[keyof typeof _Owner];

const _TURN_COMPLETION = "config: filter_incomplete_user_turns";

/**
 * One stretch of a cycle, named by the moments at its ends.
 *
 * - `start`: the moment the stretch runs from.
 * - `end`: the moment it runs to.
 * - `key`: stable identifier, which survives a label being reworded.
 * - `label`: how the stretch reads in a timeline.
 * - `owner`: the setting that governs the time, the bot whose code spends it,
 *   or which end of the span supplies the processor that does.
 * - `core`: whether this is a core stage, which stays listed however brief so
 *   the timeline keeps its shape from one turn to the next.
 */
class _Span {
  readonly start: _MomentKind;
  readonly end: _MomentKind;
  readonly key: string;
  readonly label: string;
  readonly owner: string | _Owner;
  readonly core: boolean;

  constructor(options: {
    start: _MomentKind;
    end: _MomentKind;
    key: string;
    label: string;
    owner: string | _Owner;
    core: boolean;
  }) {
    this.start = options.start;
    this.end = options.end;
    this.key = options.key;
    this.label = options.label;
    this.owner = options.owner;
    this.core = options.core;
  }
}

// Each pair of adjacent moments names the span between them, and a pair that
// is absent leaves that stretch unnamed, to be reported as pipeline time.
const _SPANS: readonly _Span[] = [
  // Silence the VAD had to hear before it would call the turn over. It is a
  // setting rather than a service, and shortening it trades latency for
  // transcription accuracy.
  new _Span({
    start: _MomentKind.SILENCE,
    end: _MomentKind.VAD_STOP,
    key: "endpointing_wait",
    label: "endpointing wait",
    owner: "config: VAD stop_secs",
    core: true,
  }),
  // From a pipeline that is ready with a client on it, to the bot asking for
  // something to say: the application's connected handler, and the frame it
  // queues reaching the LLM.
  new _Span({
    start: _MomentKind.READY,
    end: _MomentKind.LLM_REQUEST,
    key: "first_request",
    label: "first request",
    owner: "bot",
    core: true,
  }),
  new _Span({
    start: _MomentKind.VAD_STOP,
    end: _MomentKind.TRANSCRIPT,
    key: "transcription",
    label: "transcription",
    owner: _Owner.CLOSER,
    core: true,
  }),
  // Whatever decides the user is done: a fixed speech timeout, a smart-turn
  // model's inference, or an external signal.
  new _Span({
    start: _MomentKind.TRANSCRIPT,
    end: _MomentKind.LLM_REQUEST,
    key: "turn_detection",
    label: "turn detection",
    owner: "config: user turn strategies",
    core: true,
  }),
  new _Span({
    start: _MomentKind.LLM_REQUEST,
    end: _MomentKind.LLM_CHUNK,
    key: "llm_inference",
    label: "LLM inference",
    owner: _Owner.OPENER,
    core: true,
  }),
  // The gate reading the verdict, whichever way it went.
  new _Span({
    start: _MomentKind.LLM_CHUNK,
    end: _MomentKind.MARKER_COMPLETE,
    key: "turn_completion",
    label: "turn completion",
    owner: _TURN_COMPLETION,
    core: false,
  }),
  new _Span({
    start: _MomentKind.LLM_CHUNK,
    end: _MomentKind.MARKER_INCOMPLETE,
    key: "turn_completion",
    label: "turn completion",
    owner: _TURN_COMPLETION,
    core: false,
  }),
  // The token the marker occupies before anything can be spoken.
  new _Span({
    start: _MomentKind.MARKER_COMPLETE,
    end: _MomentKind.FIRST_TEXT,
    key: "turn_completion",
    label: "turn completion",
    owner: _TURN_COMPLETION,
    core: false,
  }),
  new _Span({
    start: _MomentKind.MARKER_INCOMPLETE,
    end: _MomentKind.LLM_REQUEST,
    key: "waiting_for_user",
    label: "waiting for user",
    owner: _TURN_COMPLETION,
    core: false,
  }),
  // Between the LLM's first chunk and the call being dispatched, the LLM is
  // still writing the call.
  new _Span({
    start: _MomentKind.LLM_CHUNK,
    end: _MomentKind.HANDLERS_START,
    key: "llm_tool_call",
    label: "LLM tool call",
    owner: _Owner.OPENER,
    core: false,
  }),
  new _Span({
    start: _MomentKind.HANDLERS_START,
    end: _MomentKind.HANDLERS_END,
    key: "function_handler",
    label: "function handler",
    owner: _Owner.CLOSER,
    core: false,
  }),
  // Waiting for a full sentence before speaking any of it.
  new _Span({
    start: _MomentKind.FIRST_TEXT,
    end: _MomentKind.SENTENCE,
    key: "sentence_aggregation",
    label: "sentence aggregation",
    owner: "config: text_aggregation_mode",
    core: false,
  }),
  new _Span({
    start: _MomentKind.SENTENCE,
    end: _MomentKind.FIRST_AUDIO,
    key: "speech_synthesis",
    label: "speech synthesis",
    owner: _Owner.CLOSER,
    core: true,
  }),
  new _Span({
    start: _MomentKind.FIRST_TEXT,
    end: _MomentKind.FIRST_AUDIO,
    key: "speech_synthesis",
    label: "speech synthesis",
    owner: _Owner.CLOSER,
    core: true,
  }),
  new _Span({
    start: _MomentKind.FIRST_AUDIO,
    end: _MomentKind.BOT_SPEAKING,
    key: "output_transport",
    label: "output transport",
    owner: _Owner.CLOSER,
    core: false,
  }),
];

function spanKey(start: _MomentKind, end: _MomentKind): string {
  return `${start}\u0000${end}`;
}

const _SPANS_BY_MOMENTS: ReadonlyMap<string, _Span> = new Map(
  _SPANS.map((span) => [spanKey(span.start, span.end), span]),
);

// One stretch is two spans rather than one, so it is chosen rather than looked
// up: where turn completion is in use, a response that carried no marker is
// buffered whole before anything can be spoken; where it is not, the same wait
// is the LLM still streaming, so its inference covers it.
const _AWAITING_SPEAKABLE_TEXT = new _Span({
  start: _MomentKind.LLM_CHUNK,
  end: _MomentKind.FIRST_TEXT,
  key: "awaiting_speakable_text",
  label: "awaiting speakable text",
  owner: _Owner.CLOSER,
  core: false,
});
const _LLM_INFERENCE_UNTIL_TEXT = new _Span({
  start: _MomentKind.LLM_CHUNK,
  end: _MomentKind.FIRST_TEXT,
  key: "llm_inference",
  label: "LLM inference",
  owner: _Owner.OPENER,
  core: true,
});

/**
 * Where a measured interval was anchored.
 *
 * A greeting is timed from the client connecting, a turn from the user
 * falling silent, so a partial interval is never mistaken for a whole one.
 */
export const MeasuredFrom = {
  USER_SILENCE: "user_silence",
  CLIENT_CONNECTED: "client_connected",
} as const;
export type MeasuredFrom = (typeof MeasuredFrom)[keyof typeof MeasuredFrom];

/**
 * What kind of thing a contribution's owner is.
 *
 * Grouping on this answers where a turn's time went without matching on the
 * owner's name: a service that could be swapped, a setting the bot chose, the
 * bot's own code, or the pipeline between them.
 */
export const LatencyOwnerKind = {
  SERVICE: "service",
  SETTING: "setting",
  BOT: "bot",
  PIPELINE: "pipeline",
} as const;
export type LatencyOwnerKind = (typeof LatencyOwnerKind)[keyof typeof LatencyOwnerKind];

export interface LatencyContributionOptions {
  key: string;
  label: string;
  owner: string;
  ownerKind: LatencyOwnerKind;
  startTime: number;
  durationSecs: number;
}

/**
 * One named part of the user-to-bot interval.
 *
 * Contributions account for the whole interval, so their durations sum to the
 * measured latency. Unlike a TTFB, which reports what a service spent once it
 * was asked, a contribution can also name time no service is measuring: the
 * silence a VAD waits out, the tokens a turn-completion marker occupies before
 * any speakable text, or a hold while the pipeline waits for the user to
 * finish a sentence.
 *
 * - `key`: stable identifier for this part of a turn. Unlike `label`, it is
 *   safe to group on: it survives the label being reworded.
 * - `label`: what the time was spent on.
 * - `owner`: what spent it — a processor name, or a `config:` tag naming the
 *   setting that governs it.
 * - `ownerKind`: what kind of thing the owner is.
 * - `startTime`: Unix timestamp (seconds) when it started.
 * - `durationSecs`: how long it took, in seconds.
 */
export class LatencyContribution {
  key: string;
  label: string;
  owner: string;
  ownerKind: LatencyOwnerKind;
  startTime: number;
  durationSecs: number;

  constructor(options: LatencyContributionOptions) {
    this.key = options.key;
    this.label = options.label;
    this.owner = options.owner;
    this.ownerKind = options.ownerKind;
    this.startTime = options.startTime;
    this.durationSecs = options.durationSecs;
  }
}

export interface LatencyBreakdownOptions {
  ttfb?: TTFBBreakdownMetrics[];
  contributions?: LatencyContribution[];
  measuredFrom?: MeasuredFrom | null;
  totalSecs?: number;
  textAggregation?: TextAggregationBreakdownMetrics | null;
  userTurnStartTime?: number | null;
  userTurnSecs?: number | null;
  functionCalls?: FunctionCallMetrics[];
}

/**
 * Per-service latency breakdown for a single user-to-bot cycle.
 *
 * Collected between `VADUserStoppedSpeakingFrame` and
 * `BotStartedSpeakingFrame` when `enableMetrics` is true in `PipelineParams`.
 *
 * - `ttfb`: time-to-first-byte metrics from each service in the pipeline.
 * - `textAggregation`: first text aggregation measurement, representing the
 *   latency cost of sentence aggregation in the TTS pipeline.
 * - `userTurnStartTime`: Unix timestamp when the user turn started (actual
 *   user silence, adjusted for VAD stop_secs). null if no
 *   `VADUserStoppedSpeakingFrame` was observed.
 * - `userTurnSecs`: duration in seconds of the user's turn, measured from
 *   when the user actually stopped speaking to when the turn was released
 *   (`UserStoppedSpeakingFrame`). This includes VAD silence detection, STT
 *   finalization, and any turn analyzer wait. null if no
 *   `UserStoppedSpeakingFrame` was observed (e.g. no turn analyzer
 *   configured).
 * - `functionCalls`: latency for each function call executed during this
 *   cycle. Empty if no function calls occurred.
 * - `contributions`: named parts of the interval, in chronological order,
 *   summing to the measured latency. A part is listed only if it happened, so
 *   a bot without turn completion has no marker or wait entries.
 * - `measuredFrom`: where the interval was anchored, so a greeting is not
 *   compared with a turn.
 * - `totalSecs`: the measured interval, which the contributions sum to.
 */
export class LatencyBreakdown {
  ttfb: TTFBBreakdownMetrics[];
  contributions: LatencyContribution[];
  measuredFrom: MeasuredFrom | null;
  totalSecs: number;
  textAggregation: TextAggregationBreakdownMetrics | null;
  userTurnStartTime: number | null;
  userTurnSecs: number | null;
  functionCalls: FunctionCallMetrics[];

  constructor(options: LatencyBreakdownOptions = {}) {
    this.ttfb = options.ttfb ?? [];
    this.contributions = options.contributions ?? [];
    this.measuredFrom = options.measuredFrom ?? null;
    this.totalSecs = options.totalSecs ?? 0.0;
    this.textAggregation = options.textAggregation ?? null;
    this.userTurnStartTime = options.userTurnStartTime ?? null;
    this.userTurnSecs = options.userTurnSecs ?? null;
    this.functionCalls = options.functionCalls ?? [];
  }

  /**
   * Format the contributions for logging, one per line plus a total.
   *
   * One breakdown covers one user-to-bot cycle, so these lines describe a
   * single turn — or, for the first thing the bot says, the wait before it
   * from the pipeline being ready with a client on it, which the total line
   * names.
   *
   * @param options.byCost Order by duration, largest first, rather than in
   *   the order things happened. Useful when the question is what to optimize
   *   rather than what the turn did.
   * @returns One formatted line per contribution, then a total line. Empty if
   *   no contributions were collected.
   */
  turnContributionLines(options: { byCost?: boolean } = {}): string[] {
    if (this.contributions.length === 0) {
      return [];
    }

    const ordered = options.byCost
      ? [...this.contributions].sort((a, b) => b.durationSecs - a.durationSecs)
      : this.contributions;
    const lines = ordered.map(
      (c) => `${formatSecs(c.durationSecs)}s  ${c.label.padEnd(20)} [${c.owner}]`,
    );
    const total = this.contributions.reduce((sum, c) => sum + c.durationSecs, 0);
    const anchor =
      this.measuredFrom === MeasuredFrom.CLIENT_CONNECTED ? " (from client connected)" : "";
    lines.push(`${formatSecs(total)}s  TOTAL${anchor}`);
    return lines;
  }
}

/** Python's `f"{secs:6.3f}"`. */
function formatSecs(secs: number): string {
  return secs.toFixed(3).padStart(6);
}

export interface UserBotLatencyObserverOptions extends BaseObserverOptions {
  /**
   * Contributions shorter than this are rolled into the single pipeline entry
   * rather than listed. Pass 0 to list every one, including individual frame
   * hops.
   */
  minContributionSecs?: number;
  /**
   * Reads the current time in seconds. Supplying one lets a test drive a
   * cycle without waiting out the intervals it describes.
   */
  timeSource?: () => number;
}

/**
 * Observer that tracks user-to-bot response latency.
 *
 * Measures the time between when a user stops speaking
 * (VADUserStoppedSpeakingFrame) and when the bot starts speaking
 * (BotStartedSpeakingFrame). Emits events when latency is measured, allowing
 * consumers to log, trace, or otherwise process the latency data.
 *
 * When `enableMetrics` is true in pipeline params, also collects a latency
 * breakdown and emits an `on_latency_breakdown` event alongside the existing
 * latency measurement. The breakdown carries per-service metrics (TTFB, text
 * aggregation) and, in `contributions`, the whole interval named part by part:
 *
 * @example
 * for (const line of breakdown.turnContributionLines()) {
 *   logger.info(line);
 * }
 * // 0.200s  endpointing wait     [config: VAD stop_secs]
 * // 0.125s  transcription        [DeepgramSTTService#0]
 * // 0.336s  LLM inference        [OpenAILLMService#0]
 * // 0.359s  speech synthesis     [CartesiaTTSService#0]
 * // 1.020s  TOTAL
 *
 * This observer follows the composition pattern used by
 * TurnTrackingObserver, acting as a reusable component for latency
 * measurement.
 *
 * Events:
 *
 * - on_latency_measured(observer, latencySeconds): emitted when
 *   time-to-first-bot-speech is calculated. Measures the time from when the
 *   user stopped speaking to when the bot starts speaking.
 * - on_latency_breakdown(observer, breakdown): emitted at each
 *   `BotStartedSpeakingFrame` with a `LatencyBreakdown` containing
 *   per-service metrics collected during the user→bot cycle.
 * - on_first_bot_speech_latency(observer, latencySeconds): emitted once, the
 *   first time `BotStartedSpeakingFrame` arrives after `ClientConnectedFrame`.
 *   Measures the time from client connection to the first bot speech.
 */
export class UserBotLatencyObserver extends BaseObserver {
  protected _minContributionSecs: number;
  protected _now: () => number;
  protected _userStoppedTime: number | null = null;
  protected _userTurnStartTime: number | null = null;
  protected _userTurn: number | null = null;

  // First bot speech tracking
  protected _clientConnectedTime: number | null = null;
  protected _pipelineStartedTime: number | null = null;
  protected _firstBotSpeechMeasured = false;

  // The moments of the cycle, in the order they were observed.
  protected _moments: _Moment[] = [];
  protected _llmRequest: _Moment | null = null;
  // Whether this bot uses turn completion at all, which a marker frame
  // proves. Not per-cycle: a bot that emits markers keeps using them.
  protected _markersSeen = false;

  // Per-cycle metric accumulators
  protected _ttfb: TTFBBreakdownMetrics[] = [];
  protected _textAggregation: TextAggregationBreakdownMetrics | null = null;
  protected _functionCallStarts = new Map<string, [string, number]>();
  protected _functionCallMetrics: FunctionCallMetrics[] = [];

  /**
   * Initialize the user-bot latency observer.
   *
   * @param options.minContributionSecs Contributions shorter than this are
   *   rolled into the single pipeline entry rather than listed.
   * @param options.timeSource Reads the current time in seconds.
   */
  constructor(options: UserBotLatencyObserverOptions = {}) {
    super({ ...options, observeEveryPush: false });
    this._minContributionSecs = options.minContributionSecs ?? MIN_CONTRIBUTION_SECS;
    this._now = options.timeSource ?? time;

    this._registerEventHandler("on_latency_measured");
    this._registerEventHandler("on_latency_breakdown");
    this._registerEventHandler("on_first_bot_speech_latency");
  }

  /**
   * Record that the pipeline finished starting.
   *
   * The `StartFrame` has reached every processor by now, which is where
   * `StartupTimingObserver` stops measuring. A greeting is timed from here so
   * the two reports meet rather than overlap.
   */
  override async onPipelineStarted(): Promise<void> {
    if (this._pipelineStartedTime === null) {
      this._pipelineStartedTime = this._now();
    }
  }

  /**
   * Process frames to track speech timing and calculate latency.
   *
   * Tracks VAD events and bot speaking events to measure the time between
   * user stopping speech and bot starting speech. Also accumulates metrics
   * from MetricsFrame for the latency breakdown.
   *
   * @param data Frame push event containing the frame and direction information.
   */
  override async onPushFrame(data: FramePushed): Promise<void> {
    // Only process downstream frames
    if (data.direction !== FrameDirection.DOWNSTREAM) {
      return;
    }

    const frame = data.frame;

    // Track client connection (first occurrence only)
    if (frame instanceof ClientConnectedFrame) {
      if (this._clientConnectedTime === null) {
        this._clientConnectedTime = this._now();
      }
      return;
    }

    // Track speech and pipeline events for latency
    if (frame instanceof VADUserStartedSpeakingFrame) {
      // Reset when user starts speaking
      this._userStoppedTime = null;
      this._userTurnStartTime = null;
      this._userTurn = null;
      this._resetAccumulators();
      // If user speaks before the bot's first speech, abandon the
      // first-bot-speech measurement — it's only meaningful for greetings.
      this._firstBotSpeechMeasured = true;
    } else if (frame instanceof VADUserStoppedSpeakingFrame) {
      // Record the actual time the user stopped speaking, which is the VAD
      // determination time minus the stop_secs silence duration that had to
      // elapse before the VAD confirmed speech ended.
      this._userStoppedTime = frame.timestamp - frame.stopSecs;
      this._userTurnStartTime = this._userStoppedTime;
      this._mark(_MomentKind.VAD_STOP, { at: frame.timestamp });
    } else if (frame instanceof UserStoppedSpeakingFrame) {
      // Measure the user turn duration: from actual user silence to turn
      // release. Includes VAD silence detection, STT finalization, and any
      // turn analyzer wait.
      if (this._userStoppedTime !== null) {
        this._userTurn = this._now() - this._userStoppedTime;
      }
    } else if (frame instanceof TranscriptionFrame) {
      // A service can finalize an utterance in several pieces. The turn is
      // not detectable until the last of them, which is also where the
      // service stops its own TTFB clock, so a later one replaces the earlier
      // until the LLM is asked.
      if (!this._seen(_MomentKind.LLM_REQUEST)) {
        this._moments = this._moments.filter((m) => m.kind !== _MomentKind.TRANSCRIPT);
        this._mark(_MomentKind.TRANSCRIPT, { source: data.source.name });
      }
    } else if (frame instanceof LLMFullResponseStartFrame) {
      this._llmRequest = this._mark(_MomentKind.LLM_REQUEST, { source: data.source.name });
    } else if (frame instanceof LLMMarkerFrame) {
      // A stand-alone marker holds the turn open; one that prefixes a
      // response is the completion the pipeline was waiting for.
      this._markersSeen = true;
      // A turn can be held more than once before it completes, so every
      // incomplete verdict is recorded; only the completion is kept once.
      this._mark(
        frame.appendToContextImmediately
          ? _MomentKind.MARKER_INCOMPLETE
          : _MomentKind.MARKER_COMPLETE,
        { once: !frame.appendToContextImmediately },
      );
    } else if (frame instanceof LLMTextFrame) {
      this._mark(_MomentKind.FIRST_TEXT, { source: data.source.name, once: true });
    } else if (frame instanceof TTSAudioRawFrame) {
      this._mark(_MomentKind.FIRST_AUDIO, { source: data.source.name, once: true });
    } else if (frame instanceof InterruptionFrame) {
      // Discard stale metrics from cancelled LLM/TTS cycles
      this._resetAccumulators();
    } else if (frame instanceof FunctionCallInProgressFrame) {
      this._functionCallStarts.set(frame.toolCallId, [frame.functionName, this._now()]);
    } else if (frame instanceof FunctionCallResultFrame) {
      const start = this._functionCallStarts.get(frame.toolCallId);
      this._functionCallStarts.delete(frame.toolCallId);
      if (start !== undefined) {
        const [functionName, startTime] = start;
        this._functionCallMetrics.push(
          new FunctionCallMetrics({
            functionName,
            startTime,
            durationSecs: this._now() - startTime,
          }),
        );
      }
    } else if (frame instanceof MetricsFrame) {
      this._handleMetricsFrame(frame);
    } else if (frame instanceof BotStartedSpeakingFrame) {
      this._mark(_MomentKind.BOT_SPEAKING, { source: data.source.name, once: true });
      await this._handleBotStartedSpeaking();
    }
  }

  /**
   * Record a moment, if a cycle is being measured.
   *
   * @param kind What happened.
   * @param options.at When, defaulting to now. Derived moments pass their own time.
   * @param options.source Name of whatever produced it.
   * @param options.once Keep only the first of this kind, for frames that
   *   repeat within a cycle such as text and audio.
   * @param options.derived Whether it comes from a metric rather than from a frame.
   * @returns The recorded moment, or null if it was not recorded.
   */
  protected _mark(
    kind: _MomentKind,
    options: { at?: number | null; source?: string; once?: boolean; derived?: boolean } = {},
  ): _Moment | null {
    if (!this._measuring) {
      return null;
    }
    if (options.once && this._seen(kind)) {
      return null;
    }
    const moment = new _Moment({
      at: options.at ?? this._now(),
      kind,
      source: options.source ?? "",
      derived: options.derived ?? false,
    });
    this._moments.push(moment);
    return moment;
  }

  /** Whether a moment of this kind has been recorded this cycle. */
  protected _seen(kind: _MomentKind): boolean {
    return this._moments.some((m) => m.kind === kind);
  }

  /** Whether a cycle is open: a user turn, or the wait for the greeting. */
  protected get _measuring(): boolean {
    if (this._userStoppedTime !== null) {
      return true;
    }
    return this._clientConnectedTime !== null && !this._firstBotSpeechMeasured;
  }

  /**
   * Moments that come from metrics rather than from frames.
   *
   * Handlers dispatched together run concurrently, so they become one pair of
   * moments named for the one the wait actually depends on: listing each
   * would count the same stretch of wall clock more than once.
   *
   * @returns The sentence-aggregation and function-handler moments, if any.
   */
  protected _derivedMoments(): _Moment[] {
    const moments: _Moment[] = [];

    const firstText = this._moments.find((m) => m.kind === _MomentKind.FIRST_TEXT);
    if (firstText && this._textAggregation && this._textAggregation.durationSecs > 0) {
      moments.push(
        new _Moment({
          at: firstText.at + this._textAggregation.durationSecs,
          kind: _MomentKind.SENTENCE,
          derived: true,
        }),
      );
    }

    for (const group of this._concurrentHandlers()) {
      // max() keeps the first of equal values.
      let slowest = group[0] as FunctionCallMetrics;
      for (const c of group) {
        if (c.durationSecs > slowest.durationSecs) slowest = c;
      }
      let owner = slowest.functionName;
      if (group.length > 1) {
        owner += ` +${group.length - 1}`;
      }
      moments.push(
        new _Moment({
          at: Math.min(...group.map((c) => c.startTime)),
          kind: _MomentKind.HANDLERS_START,
          derived: true,
        }),
      );
      moments.push(
        new _Moment({
          at: Math.max(...group.map((c) => c.startTime + c.durationSecs)),
          kind: _MomentKind.HANDLERS_END,
          source: owner,
          derived: true,
        }),
      );
    }
    return moments;
  }

  /**
   * Group function handlers whose executions overlap in time.
   *
   * @returns Groups of overlapping calls, in the order they started.
   */
  protected _concurrentHandlers(): FunctionCallMetrics[][] {
    const groups: FunctionCallMetrics[][] = [];
    const sorted = [...this._functionCallMetrics].sort((a, b) => a.startTime - b.startTime);
    for (const call of sorted) {
      const last = groups[groups.length - 1];
      if (last && call.startTime <= Math.max(...last.map((c) => c.startTime + c.durationSecs))) {
        last.push(call);
      } else {
        groups.push([call]);
      }
    }
    return groups;
  }

  /**
   * Name each stretch between one moment and the next.
   *
   * Spans run from one moment to the following one, so they tile the cycle
   * and cannot overlap. A stretch whose pair of moments has no entry in the
   * table is left unnamed and reported as pipeline time, which is what makes
   * a gap in the accounting visible rather than silently absorbed.
   *
   * @returns Contributions in chronological order, or empty if the cycle was
   *   never measured.
   */
  protected _buildContributions(): LatencyContribution[] {
    let start = this._userTurnStartTime;
    if (start === null) {
      // A greeting begins once the pipeline is ready and someone is there to
      // hear it, whichever came second: before the pipeline started, the
      // startup report has the time; before a client connected, the bot was
      // waiting on a person rather than working.
      const ready = [this._clientConnectedTime, this._pipelineStartedTime].filter(
        (moment): moment is number => moment !== null,
      );
      start = ready.length > 0 ? Math.max(...ready) : null;
    }
    if (start === null || !this._seen(_MomentKind.BOT_SPEAKING)) {
      return [];
    }
    const cycleStart = start;

    const moments = [
      new _Moment({
        at: cycleStart,
        kind: this._userTurnStartTime !== null ? _MomentKind.SILENCE : _MomentKind.READY,
      }),
      ...this._moments.filter((m) => m.at >= cycleStart),
      ...this._derivedMoments(),
    ].sort((a, b) => a.at - b.at || Number(!a.derived) - Number(!b.derived));

    let spans: LatencyContribution[] = [];
    const core = new Set<string>();
    for (let i = 0; i + 1 < moments.length; i++) {
      const opener = moments[i] as _Moment;
      const closer = moments[i + 1] as _Moment;
      if (closer.at <= opener.at) {
        continue;
      }
      let span: _Span | undefined;
      if (opener.kind === _MomentKind.LLM_CHUNK && closer.kind === _MomentKind.FIRST_TEXT) {
        span = this._markersSeen ? _AWAITING_SPEAKABLE_TEXT : _LLM_INFERENCE_UNTIL_TEXT;
      } else {
        span = _SPANS_BY_MOMENTS.get(spanKey(opener.kind, closer.kind));
      }
      if (span === undefined) {
        continue;
      }
      let owner: string;
      let ownerKind: LatencyOwnerKind = LatencyOwnerKind.SERVICE;
      if (span.owner === _Owner.OPENER) {
        owner = opener.source;
      } else if (span.owner === _Owner.CLOSER) {
        owner = closer.source;
      } else {
        owner = span.owner;
        // A literal owner is not a processor: either the setting that governs
        // the time, or the bot's own code.
        ownerKind = owner.startsWith("config: ") ? LatencyOwnerKind.SETTING : LatencyOwnerKind.BOT;
      }
      if (span.core) {
        core.add(span.label);
      }
      spans.push(
        new LatencyContribution({
          key: span.key,
          label: span.label,
          owner,
          ownerKind,
          startTime: opener.at,
          durationSecs: closer.at - opener.at,
        }),
      );
    }

    spans = UserBotLatencyObserver._mergeAdjacent(spans);

    // A core stage stays listed however brief, but nothing is listed that
    // would print as zero: a stage that took no measurable time is not part of
    // the timeline.
    const named = spans.filter(
      (c) =>
        c.durationSecs >= this._minContributionSecs ||
        (core.has(c.label) && c.durationSecs >= PRINTS_AS_ZERO_SECS),
    );

    // Time the named stages did not cover, which includes the spans the
    // threshold filtered out. It is spread across the cycle rather than
    // sitting anywhere in it, so it is listed last, and it is listed whenever
    // there is any of it, so the contributions always sum to the interval
    // they describe.
    const last = moments[moments.length - 1] as _Moment;
    const pipelineSecs = last.at - cycleStart - named.reduce((sum, c) => sum + c.durationSecs, 0);
    if (pipelineSecs >= PRINTS_AS_ZERO_SECS) {
      named.push(
        new LatencyContribution({
          key: "pipeline",
          label: "pipeline",
          owner: "pipecat",
          ownerKind: LatencyOwnerKind.PIPELINE,
          startTime: cycleStart,
          durationSecs: pipelineSecs,
        }),
      );
    }
    return named;
  }

  /**
   * Join neighbouring spans that say the same thing.
   *
   * A marker sits in the middle of what a reader thinks of as one stretch, so
   * the table names both halves the same way and they are joined here. Only
   * spans that meet are joined: two of the same name either side of an
   * unnamed gap stay apart, so the gap is reported rather than absorbed.
   *
   * @param spans Contributions in chronological order.
   * @returns The same coverage, with runs of one label and owner joined.
   */
  protected static _mergeAdjacent(spans: LatencyContribution[]): LatencyContribution[] {
    const merged: LatencyContribution[] = [];
    for (const span of spans) {
      const previous =
        merged.length > 0 ? (merged[merged.length - 1] as LatencyContribution) : null;
      const touching =
        previous !== null &&
        span.startTime - (previous.startTime + previous.durationSecs) < PRINTS_AS_ZERO_SECS;
      if (previous && touching && previous.label === span.label && previous.owner === span.owner) {
        previous.durationSecs = span.startTime + span.durationSecs - previous.startTime;
      } else {
        merged.push(span);
      }
    }
    return merged;
  }

  /** Handle BotStartedSpeakingFrame to emit latency and breakdown. */
  protected async _handleBotStartedSpeaking(): Promise<void> {
    let emitBreakdown = false;

    // One-time first bot speech measurement (client connect → first speech)
    if (this._clientConnectedTime !== null && !this._firstBotSpeechMeasured) {
      this._firstBotSpeechMeasured = true;
      const latency = this._now() - this._clientConnectedTime;
      await this._callEventHandler("on_first_bot_speech_latency", latency);
      emitBreakdown = true;
    }

    if (this._userStoppedTime !== null) {
      const latency = this._now() - this._userStoppedTime;
      this._userStoppedTime = null;
      await this._callEventHandler("on_latency_measured", latency);
      emitBreakdown = true;
    }

    if (emitBreakdown) {
      const contributions = this._buildContributions();
      const breakdown = new LatencyBreakdown({
        ttfb: [...this._ttfb],
        contributions,
        measuredFrom:
          contributions.length > 0
            ? this._userTurnStartTime !== null
              ? MeasuredFrom.USER_SILENCE
              : MeasuredFrom.CLIENT_CONNECTED
            : null,
        totalSecs: contributions.reduce((sum, c) => sum + c.durationSecs, 0),
        textAggregation: this._textAggregation,
        userTurnStartTime: this._userTurnStartTime,
        userTurnSecs: this._userTurn,
        functionCalls: [...this._functionCallMetrics],
      });
      await this._callEventHandler("on_latency_breakdown", breakdown);
      this._resetAccumulators();
    }
  }

  /**
   * Extract latency metrics from a MetricsFrame.
   *
   * Accumulates metrics when a measurement is in progress: either a user→bot
   * cycle (after `VADUserStoppedSpeakingFrame`) or the first-bot-speech
   * window (after `ClientConnectedFrame`).
   */
  protected _handleMetricsFrame(frame: MetricsFrame): void {
    const waitingForFirstSpeech =
      this._clientConnectedTime !== null && !this._firstBotSpeechMeasured;
    if (this._userStoppedTime === null && !waitingForFirstSpeech) {
      return;
    }

    const now = this._now();
    for (const metricsData of frame.data) {
      if (metricsData instanceof TTFBMetricsData && metricsData.value > 0) {
        this._ttfb.push(
          new TTFBBreakdownMetrics({
            processor: metricsData.processor,
            model: metricsData.model,
            startTime: now - metricsData.value,
            durationSecs: metricsData.value,
          }),
        );
        if (this._llmRequest && metricsData.processor === this._llmRequest.source) {
          // The first chunk landed before this metric was pushed, so cap it
          // there rather than letting a derived moment sort after the frames
          // that followed it.
          this._mark(_MomentKind.LLM_CHUNK, {
            at: Math.min(this._llmRequest.at + metricsData.value, now),
            source: this._llmRequest.source,
            derived: true,
          });
        }
      } else if (metricsData instanceof TextAggregationMetricsData) {
        // Only keep the first measurement — it's the one that impacts the
        // initial speaking latency.
        if (this._textAggregation === null) {
          this._textAggregation = new TextAggregationBreakdownMetrics({
            processor: metricsData.processor,
            startTime: now - metricsData.value,
            durationSecs: metricsData.value,
          });
        }
      }
    }
  }

  /** Clear per-cycle metric accumulators. */
  protected _resetAccumulators(): void {
    this._moments = [];
    this._llmRequest = null;
    this._ttfb = [];
    this._textAggregation = null;
    this._userTurnStartTime = null;
    this._userTurn = null;
    this._functionCallStarts = new Map();
    this._functionCallMetrics = [];
  }
}
