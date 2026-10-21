// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/evals/results.py

/**
 * What an eval run produces.
 *
 * Per-assertion failures, per-turn outcomes, the run's `EvalScriptResult` (a
 * scenario) or `EvalSimulationResult` (a simulation), the live progress
 * records, and the harness's own trace.
 *
 * Each result dataclass has `toDict()`, the snake_case JSON upstream's
 * `dataclasses.asdict` produces (what a harness worker writes back), and a
 * static `fromDict()` that rebuilds it.
 */

import { monotonic } from "@pipedog/asyncio";

/** A JSON object, as upstream's `dict`. */
export type EvalDict = Record<string, unknown>;

/**
 * Categories for `EvalAssertionFailure.kind`, the stable key for grouping
 * failures across runs. Each says how an assertion failed, so a repeated suite can
 * report "10x timeout on turn 3" without parsing free-text reasons.
 */
export const FAILURE_KINDS = [
  "timeout", // no event of the expected type arrived within the budget
  "judge_no", // the judge rejected the reply, or a function call's `eval:`
  "judge_continue", // the judge never accepted the reply before the budget ran out
  "no_judge", // the scenario uses `eval:` but no judge could be built
  "no_content", // the matched event carried no text to judge
  "text_mismatch", // `text_contains` not present in the event's text
  "text_present", // `text_excludes` found in the event's text
  "missing_function_call", // an expected function call never arrived
  "function_args_mismatch", // the call arrived with unexpected arguments
  "unexpected_event", // an `absent:` expectation saw the event it forbade
  "send_after_timeout", // a turn's `send_after` event never fired
  "bot_ended", // the bot ended the call before a turn's send_after or expectation was met
  "connect_failed", // never connected to the bot's eval transport
  "closed_before_ready", // connected, but the bot closed the connection before bot-ready
  "handshake_timeout", // connected, but the bot never sent bot-ready
  "judge_no_verdict", // the judge answered nothing usable about a simulation's goal
  "error", // the harness itself raised (a sub-pipeline, the judge, ...), not the bot
] as const;

/**
 * Statuses for `EvalScriptTurnResult.status`. `not_run` is distinct from a pass:
 * a run that stops at the first failure leaves its later turns undriven, and
 * counting those as passes would inflate any rate computed from the result.
 */
export const TURN_STATUSES = ["passed", "failed", "not_run"] as const;

/**
 * Python's `format(x, ".Nf")`: fixed-point with `digits` decimals, rounding the
 * double's exact value half to even (`Number.toFixed` rounds exact ties up).
 */
export function pyFormatFixed(x: number, digits: number): string {
  if (!Number.isFinite(x)) return Number.isNaN(x) ? "nan" : x > 0 ? "inf" : "-inf";
  const fixed = x.toFixed(digits);
  // toFixed(100) is the exact decimal expansion of any double that can tie at
  // `digits` decimals; a tie is a 5 followed only by zeros.
  const exact = Math.abs(x).toFixed(100);
  const point = exact.indexOf(".");
  const rest = exact.slice(point + 1 + digits);
  if (!/^50*$/.test(rest)) return fixed;
  // An exact tie: keep the even neighbour.
  const truncated = exact.slice(0, point + 1 + digits).replace(/\.$/, "");
  const lastDigit = Number(truncated[truncated.length - 1]);
  if (lastDigit % 2 === 0) {
    const sign = x < 0 || Object.is(x, -0) ? "-" : "";
    return sign + truncated;
  }
  return fixed;
}

export interface EvalAssertionFailureOptions {
  /** Index of the turn that failed. */
  turnIndex: number;
  /**
   * Index of the expectation within the turn, or -1 for a turn-level failure
   * (e.g. a `send_after` that never fired).
   */
  expectationIndex: number;
  /** The expectation's event name. */
  eventName: string;
  /** Human-readable explanation of the failure. */
  reason: string;
  /**
   * Machine-readable failure category, one of `FAILURE_KINDS`. Says *how* the
   * assertion failed (the judge rejected the reply, no event arrived, a function
   * call was missing, ...), not what it means about the bot. `reason` is free
   * text and differs on every run — often judge prose — so grouping failures
   * across many runs keys on this.
   */
  kind: string;
}

/** A single failed assertion within an eval. */
export class EvalAssertionFailure {
  turnIndex: number;
  expectationIndex: number;
  eventName: string;
  reason: string;
  kind: string;

  constructor(options: EvalAssertionFailureOptions) {
    this.turnIndex = options.turnIndex;
    this.expectationIndex = options.expectationIndex;
    this.eventName = options.eventName;
    this.reason = options.reason;
    this.kind = options.kind;
  }

  toString(): string {
    return (
      `turn ${this.turnIndex} expectation ${this.expectationIndex} ` +
      `(${this.eventName}): ${this.reason}`
    );
  }

  /** The snake_case JSON upstream's `dataclasses.asdict` produces. */
  toDict(): EvalDict {
    return {
      turn_index: this.turnIndex,
      expectation_index: this.expectationIndex,
      event_name: this.eventName,
      reason: this.reason,
      kind: this.kind,
    };
  }

  /** Rebuild from `toDict()`'s JSON (upstream: `EvalAssertionFailure(**data)`). */
  static fromDict(data: EvalDict): EvalAssertionFailure {
    return new EvalAssertionFailure({
      turnIndex: data.turn_index as number,
      expectationIndex: data.expectation_index as number,
      eventName: data.event_name as string,
      reason: data.reason as string,
      kind: data.kind as string,
    });
  }
}

export interface EvalExpectationResultOptions {
  /** Index of the expectation within the turn. */
  expectationIndex: number;
  /** The expectation's event name. */
  eventName: string;
  /** Whether the expectation was satisfied. */
  passed: boolean;
  /**
   * What it matched, in short, when it passed: the marker of an `llm_marker`, a
   * function call's signature, the text of a reply or a transcript. Empty for an
   * event that carries no text, and on a failure, whose reason is in the turn's
   * failures.
   */
  matched?: string;
}

/** What one expectation of a turn resolved to, pass or fail. */
export class EvalExpectationResult {
  expectationIndex: number;
  eventName: string;
  passed: boolean;
  matched: string;

  constructor(options: EvalExpectationResultOptions) {
    this.expectationIndex = options.expectationIndex;
    this.eventName = options.eventName;
    this.passed = options.passed;
    this.matched = options.matched ?? "";
  }

  /** The snake_case JSON upstream's `dataclasses.asdict` produces. */
  toDict(): EvalDict {
    return {
      expectation_index: this.expectationIndex,
      event_name: this.eventName,
      passed: this.passed,
      matched: this.matched,
    };
  }

  /** Rebuild from `toDict()`'s JSON (upstream: `EvalExpectationResult(**data)`). */
  static fromDict(data: EvalDict): EvalExpectationResult {
    return new EvalExpectationResult({
      expectationIndex: data.expectation_index as number,
      eventName: data.event_name as string,
      passed: data.passed as boolean,
      matched: (data.matched as string | undefined) ?? "",
    });
  }
}

export interface EvalScriptTurnResultOptions {
  /** Index of the turn in the scenario. */
  turnIndex: number;
  /**
   * One of `TURN_STATUSES`. `not_run` means the run ended before reaching this
   * turn — see `EvalScriptScenario.stopOnFailure`. Defaults to "not_run".
   */
  status?: string;
  /** The turn's failed assertions, in order; empty unless `status` is `failed`. */
  failures?: EvalAssertionFailure[];
  /**
   * What each expectation resolved to, in order, up to the one that timed out;
   * what a passed run matched is only recorded here.
   */
  expectations?: EvalExpectationResult[];
  /** Wall-clock time the turn took, in milliseconds; 0 when the turn was not run. */
  durationMs?: number;
}

/**
 * Outcome of one turn within a scenario run.
 *
 * A turn's expectations share one deadline and stop at the first to time
 * out, so the turn is the unit a run is scored by.
 */
export class EvalScriptTurnResult {
  turnIndex: number;
  status: string;
  failures: EvalAssertionFailure[];
  expectations: EvalExpectationResult[];
  durationMs: number;

  constructor(options: EvalScriptTurnResultOptions) {
    this.turnIndex = options.turnIndex;
    this.status = options.status ?? "not_run";
    this.failures = options.failures ?? [];
    this.expectations = options.expectations ?? [];
    this.durationMs = options.durationMs ?? 0;
  }

  /** The snake_case JSON upstream's `dataclasses.asdict` produces. */
  toDict(): EvalDict {
    return {
      turn_index: this.turnIndex,
      status: this.status,
      failures: this.failures.map((f) => f.toDict()),
      expectations: this.expectations.map((e) => e.toDict()),
      duration_ms: this.durationMs,
    };
  }

  /** Rebuild from `toDict()`'s JSON, as upstream's suite does. */
  static fromDict(data: EvalDict): EvalScriptTurnResult {
    return new EvalScriptTurnResult({
      turnIndex: data.turn_index as number,
      status: (data.status as string | undefined) ?? "not_run",
      failures: ((data.failures as EvalDict[] | undefined) ?? []).map((f) =>
        EvalAssertionFailure.fromDict(f),
      ),
      expectations: ((data.expectations as EvalDict[] | undefined) ?? []).map((e) =>
        EvalExpectationResult.fromDict(e),
      ),
      durationMs: (data.duration_ms as number | undefined) ?? 0,
    });
  }
}

export interface EvalScriptResultOptions {
  /** Name of the scenario that was run. */
  scenarioName: string;
  /** Whether every assertion passed. */
  passed: boolean;
  /** The assertions that failed, in order. */
  failures?: EvalAssertionFailure[];
  /**
   * One `EvalScriptTurnResult` per scenario turn, in order — what a per-turn pass
   * rate is computed from, without needing the scenario file for a denominator.
   * `failures` is these turns' failures flattened, plus any that belong to no
   * turn (a failed connect).
   */
  turns?: EvalScriptTurnResult[];
  /** Wall-clock time the run took, in milliseconds. */
  durationMs?: number;
  /** Every friendly event observed, for diagnostics. */
  eventsSeen?: EvalDict[];
  /**
   * Timestamped trace of the harness's own decisions (events received, audio
   * transcribed, matcher progress), for diagnosing flaky runs. Saved
   * per-scenario by the orchestrator alongside the bot log.
   */
  debugLog?: string[];
  /**
   * When set, the scenario was not run (e.g. a `tts_response` assertion without
   * audio mode); the string is the reason. Such a result is neither passed nor
   * failed.
   */
  skipped?: string | null;
}

/** Outcome of running a scenario in an `EvalScriptSession`. */
export class EvalScriptResult {
  scenarioName: string;
  passed: boolean;
  failures: EvalAssertionFailure[];
  turns: EvalScriptTurnResult[];
  durationMs: number;
  eventsSeen: EvalDict[];
  debugLog: string[];
  skipped: string | null;

  constructor(options: EvalScriptResultOptions) {
    this.scenarioName = options.scenarioName;
    this.passed = options.passed;
    this.failures = options.failures ?? [];
    this.turns = options.turns ?? [];
    this.durationMs = options.durationMs ?? 0;
    this.eventsSeen = options.eventsSeen ?? [];
    this.debugLog = options.debugLog ?? [];
    this.skipped = options.skipped ?? null;
  }

  /** The snake_case JSON upstream's `dataclasses.asdict` produces. */
  toDict(): EvalDict {
    return {
      scenario_name: this.scenarioName,
      passed: this.passed,
      failures: this.failures.map((f) => f.toDict()),
      turns: this.turns.map((t) => t.toDict()),
      duration_ms: this.durationMs,
      events_seen: this.eventsSeen,
      debug_log: this.debugLog,
      skipped: this.skipped,
    };
  }

  /**
   * Rebuild from the JSON a harness worker writes back (upstream: the suite's
   * `_result_from_dict`).
   */
  static fromDict(data: EvalDict): EvalScriptResult {
    return new EvalScriptResult({
      scenarioName: data.scenario_name as string,
      passed: data.passed as boolean,
      failures: ((data.failures as EvalDict[] | undefined) ?? []).map((f) =>
        EvalAssertionFailure.fromDict(f),
      ),
      turns: ((data.turns as EvalDict[] | undefined) ?? []).map((t) =>
        EvalScriptTurnResult.fromDict(t),
      ),
      durationMs: (data.duration_ms as number | undefined) ?? 0,
      eventsSeen: (data.events_seen as EvalDict[] | undefined) ?? [],
      debugLog: (data.debug_log as string[] | undefined) ?? [],
      skipped: (data.skipped as string | null | undefined) ?? null,
    });
  }
}

/** How a simulation run came to an end, for `EvalSimulationResult.endedBy`. */
export const SIMULATION_ENDINGS = [
  "end_call", // the persona called its end_call tool
  "bot", // the bot ended the call (it closed the connection)
  "max_turns", // the persona's turn cap was reached
  "max_duration", // the run's wall-clock cap was reached
  "silence", // neither side did anything for `max_silence_s`
  "error", // the run did not complete (see `error`)
] as const;

export interface EvalSimulationTurnVerdictOptions {
  /**
   * The bot turn, 1-based, counting the turns in which the bot said something;
   * it indexes the `assistant` messages of the run's conversation.
   */
  turn: number;
  /** Whether the turn satisfied the criterion. */
  passed: boolean;
  /**
   * The explainer's one-sentence reason for the verdict, or the classifier's
   * probabilities when nothing explained it.
   */
  reason: string;
  /**
   * The judge's answer: `yes`, `no`, or `none` when it gave no verdict on the
   * turn, which counts as a no. Defaults to "no".
   */
  verdict?: string;
  /** How sure the judge is of the verdict, from 0 to 1; null when it gave none. */
  confidence?: number | null;
  /** The probability of each outcome the classifier was offered; empty when it gave no verdict. */
  probabilities?: Record<string, number>;
}

/** The judge's verdict on one bot turn, for a per-turn metric. */
export class EvalSimulationTurnVerdict {
  turn: number;
  passed: boolean;
  reason: string;
  verdict: string;
  confidence: number | null;
  probabilities: Record<string, number>;

  constructor(options: EvalSimulationTurnVerdictOptions) {
    this.turn = options.turn;
    this.passed = options.passed;
    this.reason = options.reason;
    this.verdict = options.verdict ?? "no";
    this.confidence = options.confidence ?? null;
    this.probabilities = options.probabilities ?? {};
  }

  /** The snake_case JSON upstream's `dataclasses.asdict` produces. */
  toDict(): EvalDict {
    return {
      turn: this.turn,
      passed: this.passed,
      reason: this.reason,
      verdict: this.verdict,
      confidence: this.confidence,
      probabilities: { ...this.probabilities },
    };
  }

  /** Rebuild from `toDict()`'s JSON (upstream: `EvalSimulationTurnVerdict(**data)`). */
  static fromDict(data: EvalDict): EvalSimulationTurnVerdict {
    return new EvalSimulationTurnVerdict({
      turn: data.turn as number,
      passed: data.passed as boolean,
      reason: data.reason as string,
      verdict: (data.verdict as string | undefined) ?? "no",
      confidence: (data.confidence as number | null | undefined) ?? null,
      probabilities: (data.probabilities as Record<string, number> | undefined) ?? {},
    });
  }
}

export interface EvalSimulationMetricScoreOptions {
  /** The metric's name, from the simulation file. */
  name: string;
  /**
   * The share of the bot's turns the judge answered yes for, in 0..1, each turn
   * a yes or a no; null when there was no turn to judge.
   */
  score: number | null;
  /**
   * Whether the metric let the run pass: its score reached its `min_score`, or
   * it has none. Defaults to true.
   */
  passed?: boolean;
  /** What the score rests on: the turns that fell short and why, or that every turn passed. */
  reason?: string;
  /** The score the metric needed, or null when it only reports. */
  minScore?: number | null;
  /** The judge's verdict on each bot turn, in order; empty for a measured metric. */
  verdicts?: EvalSimulationTurnVerdict[];
  /**
   * What a measured metric measured, in its unit; null for a judged one, or
   * when there was nothing to measure.
   */
  value?: number | null;
  /**
   * How the metric failed, for grouping across runs: `judge_no` when the judge
   * rejected a turn, `judge_no_verdict` when it only left turns unanswered,
   * `out_of_range` for a measure outside its bounds, `function_calls` for a call
   * list that did not match; null when it passed.
   */
  failureKind?: string | null;
  /**
   * The criterion each bot turn was judged on, as the simulation worded it;
   * null for a measured metric.
   */
  criterion?: string | null;
}

/** One quality metric's outcome for a simulation run. */
export class EvalSimulationMetricScore {
  name: string;
  score: number | null;
  passed: boolean;
  reason: string;
  minScore: number | null;
  verdicts: EvalSimulationTurnVerdict[];
  value: number | null;
  failureKind: string | null;
  criterion: string | null;

  constructor(options: EvalSimulationMetricScoreOptions) {
    this.name = options.name;
    this.score = options.score;
    this.passed = options.passed ?? true;
    this.reason = options.reason ?? "";
    this.minScore = options.minScore ?? null;
    this.verdicts = options.verdicts ?? [];
    this.value = options.value ?? null;
    this.failureKind = options.failureKind ?? null;
    this.criterion = options.criterion ?? null;
  }

  /** The snake_case JSON upstream's `dataclasses.asdict` produces. */
  toDict(): EvalDict {
    return {
      name: this.name,
      score: this.score,
      passed: this.passed,
      reason: this.reason,
      min_score: this.minScore,
      verdicts: this.verdicts.map((v) => v.toDict()),
      value: this.value,
      failure_kind: this.failureKind,
      criterion: this.criterion,
    };
  }

  /** Rebuild from `toDict()`'s JSON, as upstream's suite does. */
  static fromDict(data: EvalDict): EvalSimulationMetricScore {
    return new EvalSimulationMetricScore({
      name: data.name as string,
      score: data.score as number | null,
      passed: (data.passed as boolean | undefined) ?? true,
      reason: (data.reason as string | undefined) ?? "",
      minScore: (data.min_score as number | null | undefined) ?? null,
      verdicts: ((data.verdicts as EvalDict[] | undefined) ?? []).map((v) =>
        EvalSimulationTurnVerdict.fromDict(v),
      ),
      value: (data.value as number | null | undefined) ?? null,
      failureKind: (data.failure_kind as string | null | undefined) ?? null,
      criterion: (data.criterion as string | null | undefined) ?? null,
    });
  }
}

export interface EvalSimulationResultOptions {
  /** Name of the simulation that was run. */
  simulationName: string;
  /** Whether the judge decided the goal was achieved. */
  succeeded: boolean;
  /** The judge's justification for `succeeded`, or the error. */
  reason?: string;
  /**
   * When set, the run did not complete (a failed connect, a harness error);
   * `succeeded` is then false and the run is neither a goal success nor a goal
   * failure.
   */
  error?: string | null;
  /** The quality metrics' outcomes. */
  metrics?: EvalSimulationMetricScore[];
  /**
   * The conversation, with the persona's turns as `user` messages and the bot's
   * as `assistant` (the convention scenarios' judges use); the `assistant`
   * messages are the bot turns the metrics scored.
   */
  messages?: EvalDict[];
  /**
   * The conversation as a conversation file holds it, the `messages` with the
   * bot's function calls in place (see `conversation.ts`).
   */
  conversation?: EvalDict[];
  /** How many turns the persona took. */
  turns?: number;
  /** How the run ended, one of `SIMULATION_ENDINGS`. Defaults to "error". */
  endedBy?: string;
  /**
   * The persona's own `end_call` claim (`success`, `reason`) when it made one;
   * advisory, the judge decides `succeeded`.
   */
  endCall?: EvalDict | null;
  /** Wall-clock time the run took, in milliseconds. */
  durationMs?: number;
  /** Every friendly event observed, for diagnostics. */
  eventsSeen?: EvalDict[];
  /** Timestamped trace of the harness's own decisions. */
  debugLog?: string[];
  /** How sure the judge is of its goal verdict, from 0 to 1; null when it gave none. */
  confidence?: number | null;
  /** The probability of each answer to the goal question; empty when the judge gave none. */
  probabilities?: Record<string, number>;
  /** The goal the conversation was judged on, the simulation's `success` as it was worded. */
  success?: string;
}

/** Outcome of one run of a simulation. */
export class EvalSimulationResult {
  simulationName: string;
  succeeded: boolean;
  reason: string;
  error: string | null;
  metrics: EvalSimulationMetricScore[];
  messages: EvalDict[];
  conversation: EvalDict[];
  turns: number;
  endedBy: string;
  endCall: EvalDict | null;
  durationMs: number;
  eventsSeen: EvalDict[];
  debugLog: string[];
  confidence: number | null;
  probabilities: Record<string, number>;
  success: string;

  constructor(options: EvalSimulationResultOptions) {
    this.simulationName = options.simulationName;
    this.succeeded = options.succeeded;
    this.reason = options.reason ?? "";
    this.error = options.error ?? null;
    this.metrics = options.metrics ?? [];
    this.messages = options.messages ?? [];
    this.conversation = options.conversation ?? [];
    this.turns = options.turns ?? 0;
    this.endedBy = options.endedBy ?? "error";
    this.endCall = options.endCall ?? null;
    this.durationMs = options.durationMs ?? 0;
    this.eventsSeen = options.eventsSeen ?? [];
    this.debugLog = options.debugLog ?? [];
    this.confidence = options.confidence ?? null;
    this.probabilities = options.probabilities ?? {};
    this.success = options.success ?? "";
  }

  /** Whether the run completed, achieved its goal, and no metric fell short. */
  get passed(): boolean {
    return this.error === null && this.succeeded && this.metrics.every((m) => m.passed);
  }

  /** Why the run did not pass, or null: the error, the goal, or the first failed metric. */
  get failure(): string | null {
    if (this.error !== null) {
      return this.error;
    }
    if (!this.succeeded) {
      return `goal not met: ${this.reason}`;
    }
    for (const metric of this.metrics) {
      if (metric.passed) {
        continue;
      }
      if (metric.minScore === null) {
        return `${metric.name}: ${metric.reason}`;
      }
      const score = metric.score === null ? "unscored" : pyFormatFixed(metric.score, 2);
      return `${metric.name} ${score} below ${pyFormatFixed(metric.minScore, 2)}: ${metric.reason}`;
    }
    return null;
  }

  /**
   * The snake_case JSON upstream's `dataclasses.asdict` produces (fields only;
   * `passed` and `failure` are properties, which `asdict` leaves out).
   */
  toDict(): EvalDict {
    return {
      simulation_name: this.simulationName,
      succeeded: this.succeeded,
      reason: this.reason,
      error: this.error,
      metrics: this.metrics.map((m) => m.toDict()),
      messages: this.messages,
      conversation: this.conversation,
      turns: this.turns,
      ended_by: this.endedBy,
      end_call: this.endCall,
      duration_ms: this.durationMs,
      events_seen: this.eventsSeen,
      debug_log: this.debugLog,
      confidence: this.confidence,
      probabilities: { ...this.probabilities },
      success: this.success,
    };
  }

  /**
   * Rebuild from the JSON a harness worker writes back (upstream: the suite's
   * `_simulation_result_from_dict`).
   */
  static fromDict(data: EvalDict): EvalSimulationResult {
    return new EvalSimulationResult({
      simulationName: data.simulation_name as string,
      succeeded: data.succeeded as boolean,
      reason: (data.reason as string | undefined) ?? "",
      confidence: (data.confidence as number | null | undefined) ?? null,
      probabilities: (data.probabilities as Record<string, number> | undefined) ?? {},
      error: (data.error as string | null | undefined) ?? null,
      metrics: ((data.metrics as EvalDict[] | undefined) ?? []).map((m) =>
        EvalSimulationMetricScore.fromDict(m),
      ),
      messages: (data.messages as EvalDict[] | undefined) ?? [],
      conversation: (data.conversation as EvalDict[] | undefined) ?? [],
      turns: (data.turns as number | undefined) ?? 0,
      endedBy: (data.ended_by as string | undefined) ?? "error",
      endCall: (data.end_call as EvalDict | null | undefined) ?? null,
      durationMs: (data.duration_ms as number | undefined) ?? 0,
      eventsSeen: (data.events_seen as EvalDict[] | undefined) ?? [],
      debugLog: (data.debug_log as string[] | undefined) ?? [],
      success: (data.success as string | undefined) ?? "",
    });
  }
}

export interface EvalScriptTurnProgressOptions {
  /** The turn being run. */
  turnIndex: number;
  /**
   * Index of the expectation, or -1 for turn-level records (the turn header, or
   * a `send_after` that never fired).
   */
  expectationIndex: number;
  /** The expectation's event (or the user text for a turn header). */
  eventName: string;
  /** `turn` (header), `matched`, `failed`, or `timeout`. */
  status: string;
  /** Optional extra text (failure reason, user utterance, ...). */
  detail?: string;
}

/** A real-time progress record emitted while a turn runs (for verbose output). */
export class EvalScriptTurnProgress {
  turnIndex: number;
  expectationIndex: number;
  eventName: string;
  status: string;
  detail: string;

  constructor(options: EvalScriptTurnProgressOptions) {
    this.turnIndex = options.turnIndex;
    this.expectationIndex = options.expectationIndex;
    this.eventName = options.eventName;
    this.status = options.status;
    this.detail = options.detail ?? "";
  }
}

export interface EvalSimulationProgressOptions {
  /**
   * `bot` for a response the bot finished, `user` for a turn the persona spoke,
   * or `ended` once the conversation is over.
   */
  status: string;
  /** What was said; for `ended`, how the conversation ended (`SIMULATION_ENDINGS`). */
  text: string;
  /** The persona's turn count so far. */
  turn: number;
}

/** A real-time progress record emitted while a simulation runs (for verbose output). */
export class EvalSimulationProgress {
  status: string;
  text: string;
  turn: number;

  constructor(options: EvalSimulationProgressOptions) {
    this.status = options.status;
    this.text = options.text;
    this.turn = options.turn;
  }
}

/**
 * What a session's `on_progress` handlers receive: a scripted scenario's
 * per-turn records, or a simulation's conversation as it happens.
 */
export type EvalProgress = EvalScriptTurnProgress | EvalSimulationProgress;

/**
 * Timestamped, turn-tagged log of the harness's own decisions, kept as the result's `debugLog`.
 *
 * The tag is the turn the harness is processing (`[--]` before the first).
 * An event that lands while a turn waits on `send_after` is tagged with
 * that turn even though it is the previous turn's output; the `send:`
 * lines mark the boundary.
 */
export class EvalTrace {
  lines: string[] = [];
  /** Index of the turn being processed; -1 outside any turn. */
  turn = -1;
  protected _t0 = 0.0;

  /** Anchor the trace's timestamps at now (the start of the run). */
  start(): void {
    this._t0 = monotonic();
  }

  /** Append one line, stamped with the seconds since `start` and the turn. */
  log(msg: string): void {
    const t = this._t0 ? monotonic() - this._t0 : 0.0;
    const tag = this.turn >= 0 ? `t${this.turn}` : "--";
    this.lines.push(`${pyFormatFixed(t, 3).padStart(8)}  [${tag.padStart(3)}]  ${msg}`);
  }
}
