// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/evals/simulation_driver.py

/** The simulation driver: lets the persona hold the conversation, then judges the whole of it. */

import { monotonic, TimeoutError } from "@pipedog/asyncio";
import { FunctionCallResultProperties } from "@pipedog/core/frames/frames";
import type { FunctionCallParams } from "@pipedog/core/services/llm_service";
import {
  BaseEvalDriver,
  type BaseEvalDriverOptions,
  type EvalDriverResultOptions,
} from "./base_driver.ts";
import { BOT_ENDED_EVENT, HARNESS_ERROR_EVENT, PERSONA_TURN_EVENT } from "./client.ts";
import { EvalConversation } from "./conversation.ts";
import type { EvalEvent } from "./events.ts";
import type { EvalPersona } from "./persona.ts";
import {
  EvalAssertionFailure,
  EvalSimulationMetricScore,
  EvalSimulationProgress,
  EvalSimulationResult,
  pyFormatFixed,
} from "./results.ts";
import { _formatG, _pyRepr, _pyStr, _pyTruthy } from "./scenario_config.ts";
import { EvalFunctionCall } from "./script.ts";
import type { EvalSimulationMetric, EvalSimulationScenario } from "./simulation.ts";
import { EvalSimulationJudge } from "./simulation_judge.ts";

type Dict = Record<string, unknown>;

// The event that reports the persona's end_call, once the reply that made the
// call has gone out to the bot.
export const END_CALL_EVENT = "end_call";
// How long the run waits, after the persona hangs up on its own last line, for
// the bot's reply to it. A flow makes its final tool calls in that turn, and a
// caller who hangs up mid-sentence is not what the simulation tests.
export const CLOSING_REPLY_WAIT_S = 15.0;

/** Python's `round(x, 3)`. */
function round3(x: number): number {
  return Math.round(x * 1000) / 1000;
}

/** Python's `==` on the JSON values a call's arguments hold. */
function pyEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === "boolean" || typeof b === "boolean") {
    if (typeof a === "number" || typeof b === "number") return Number(a) === Number(b);
    return false;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((x, i) => pyEquals(x, b[i]));
  }
  if (a !== null && b !== null && typeof a === "object" && typeof b === "object") {
    if (Array.isArray(a) || Array.isArray(b)) return false;
    const ka = Object.keys(a);
    return (
      ka.length === Object.keys(b).length &&
      ka.every((k) => Object.hasOwn(b, k) && pyEquals((a as Dict)[k], (b as Dict)[k]))
    );
  }
  return false;
}

/**
 * Whether a call the bot made is the one a `calls:` entry describes.
 *
 * Same name, and the entry's `args`, when given, all present in the call's
 * arguments with the same values.
 */
function _callMatches(spec: EvalFunctionCall, call: EvalFunctionCall): boolean {
  if (spec.name !== call.name) {
    return false;
  }
  const actual = call.args ?? {};
  return Object.entries(spec.args ?? {}).every(([key, value]) =>
    pyEquals(actual[key] ?? null, value),
  );
}

/** Options for {@link EvalSimulationDriver}. */
export interface EvalSimulationDriverOptions extends BaseEvalDriverOptions {
  /** The simulation being run. */
  simulation: EvalSimulationScenario;
  /** The simulated caller: its LLM in the pipeline, and its context. */
  persona: EvalPersona;
}

/**
 * Lets the persona LLM hold the conversation, then judges the whole of it.
 *
 * The persona answers the bot on its own inside the client's pipeline. The
 * driver reports each line as progress and watches for the end: the persona's
 * `end_call`, the bot hanging up, the turn cap, the time cap, a lull neither
 * side breaks, or a failure of the harness's own pipeline. Then one judge call
 * over the whole transcript scores every bot turn on every criterion and
 * decides the goal.
 *
 * Upstream's deprecated `transcript()` is not ported.
 */
export class EvalSimulationDriver extends BaseEvalDriver<EvalSimulationResult> {
  protected _simulation: EvalSimulationScenario;
  protected _persona: EvalPersona;
  protected _turns = 0;
  protected _endedBy: string | null = null;
  protected _durationS = 0.0;
  protected _endCall: Dict | null = null;
  protected _succeeded = false;
  protected _reason = "";
  protected _goalConfidence: number | null = null;
  protected _goalProbabilities: Record<string, number> = {};
  protected _metrics: EvalSimulationMetricScore[] = [];
  // The conversation as the events tell it, built as they arrive, and how
  // far into the stream's events the build has read.
  protected _botSaid: string;
  protected _conversation = new EvalConversation();
  protected _observed = 0;

  /**
   * Initialize the driver.
   *
   * @param options See {@link EvalSimulationDriverOptions}; `progress` is
   *   awaited with an `EvalSimulationProgress` for each line of the
   *   conversation, and once when it ends.
   */
  constructor(options: EvalSimulationDriverOptions) {
    super(options);
    this._simulation = options.simulation;
    this._persona = options.persona;
    this._botSaid = options.simulation.botAudio ? "response" : "llm_response";
  }

  /** Watch the conversation until it ends, then judge it. */
  async run(): Promise<EvalAssertionFailure[]> {
    this._persona.onEndCall((params) => this._onEndCall(params));
    const simulation = this._simulation;
    // The bot's finished response: in audio mode the harness's transcription
    // of what it said, in text mode its LLM text.
    const started = monotonic();
    const deadline = started + simulation.maxDurationS;
    // A lull is measured from the stream's last activity, which a token or a
    // spoken sentence refreshes without making an event, so a reply in
    // progress on either side is never silence, only nothing happening is.
    this._stream.touch();
    const failures: EvalAssertionFailure[] = [];
    this._trace.log(
      `persona: listening (up to ${simulation.maxTurns} turn(s), ` +
        `${_formatG(simulation.maxDurationS)}s, ${_formatG(simulation.maxSilenceS)}s of silence)`,
    );
    // Set when the persona hangs up on its own last line: the run then waits
    // for the bot's reply to it, or this long, before ending.
    let closingEnds: number | null = null;
    while (this._endedBy === null) {
      const lullEnds = this._stream.lastActivity + simulation.maxSilenceS;
      const waits = [deadline, lullEnds, ...(closingEnds !== null ? [closingEnds] : [])];
      let event: EvalEvent;
      try {
        event = await this._stream.nextAny(Math.min(...waits));
      } catch (e) {
        if (!(e instanceof TimeoutError)) throw e;
        const now = monotonic();
        if (closingEnds !== null) {
          // The persona already hung up; the bot's reply was a courtesy.
          this._trace.log("persona: no closing reply from the bot; ending the call");
          this._endedBy = "end_call";
          break;
        }
        if (now >= deadline) {
          this._endedBy = "max_duration";
          break;
        }
        if (this._stream.lastActivity + simulation.maxSilenceS > now) {
          continue;
        }
        this._endedBy = "silence";
        break;
      }
      this._observeNewEvents();
      if (event.type === END_CALL_EVENT) {
        // The bot still gets its turn if the persona hung up on its own last line.
        if (!this._conversation.userSpokeLast) {
          this._endedBy = "end_call";
        } else {
          this._trace.log("persona: hung up; waiting for the bot's closing turn");
          closingEnds = monotonic() + CLOSING_REPLY_WAIT_S;
        }
      } else if (event.type === BOT_ENDED_EVENT) {
        this._endedBy = "bot";
      } else if (event.type === HARNESS_ERROR_EVENT) {
        this._endedBy = "error";
        failures.push(this._harnessFailure((event.text as string | undefined) ?? ""));
      } else if (event.type === PERSONA_TURN_EVENT) {
        this._turns += 1;
        await this._report("user", (event.text as string | undefined) ?? "");
        // A persona that hung up on this turn has its end_call event next,
        // which leaves the bot its closing turn.
        if (this._turns >= simulation.maxTurns && this._endCall === null) {
          this._endedBy = "max_turns";
        }
      } else if (event.type === this._botSaid && _pyTruthy(event.text)) {
        await this._report("bot", event.text as string);
        if (closingEnds !== null) {
          this._endedBy = "end_call";
        }
      }
    }
    // The persona has said its last word either way: nothing the bot says
    // from here on gets an answer.
    await this._client.hangUp();
    this._durationS = round3(monotonic() - started);
    this._trace.log(`persona: ended by ${this._endedBy} after ${this._turns} turn(s)`);
    // Whatever the bot said last closes the conversation.
    this._observeNewEvents();
    this._conversation.endBotTurn();
    await this._report("ended", this._endedBy as string);
    if (failures.length > 0) {
      return failures;
    }
    return await this._judgeConversation();
  }

  /** The run's result; a run-level failure makes it an error, not a goal failure. */
  result(options: EvalDriverResultOptions): EvalSimulationResult {
    const failures = options.failures;
    const error =
      options.skipped || (failures.length > 0 ? failures.map((f) => f.reason).join("; ") : null);
    return new EvalSimulationResult({
      simulationName: this._simulation.name,
      succeeded: this._succeeded && error === null,
      reason: error || this._reason,
      confidence: this._goalConfidence,
      probabilities: this._goalProbabilities,
      error,
      metrics: this._metrics,
      messages: this.conversation(),
      conversation: this._conversation.messages,
      turns: this._turns,
      endedBy: this._endedBy || "error",
      endCall: this._endCall,
      durationMs: options.durationMs,
      eventsSeen: options.eventsSeen,
      debugLog: options.debugLog,
      success: this._simulation.success,
    });
  }

  /**
   * The conversation as the events told it, each line with the tool calls made by then.
   *
   * A bot turn is everything the bot said between two persona turns, however
   * turn detection or a function call split it; a turn in which the bot said
   * nothing is not a turn.
   */
  timeline(): Dict[] {
    const lines: Dict[] = [];
    const evidence: string[] = [];
    for (const message of this._conversation.messages) {
      if (message.role === "tool_call") {
        evidence.push(...EvalSimulationJudge.callLines(message));
      } else {
        lines.push({ role: message.role, content: message.content, evidence: [...evidence] });
      }
    }
    return lines;
  }

  /** The conversation with the persona as `user` and the bot as `assistant`, without the tool calls. */
  conversation(): Dict[] {
    return this._conversation.messages
      .filter((message) => message.role !== "tool_call")
      .map((message) => ({ role: message.role, content: message.content }));
  }

  /** The bot's function calls in order, one line each; a cancelled call is listed as cancelled. */
  toolCalls(): string[] {
    const lines: string[] = [];
    for (const message of this._conversation.messages) {
      if (message.role === "tool_call") {
        lines.push(...EvalSimulationJudge.callLines(message));
      }
    }
    return lines;
  }

  /** Emit one line of the conversation, or its end, as progress. */
  protected async _report(status: string, text: string): Promise<void> {
    await this._progress(new EvalSimulationProgress({ status, text, turn: this._turns }));
  }

  /** The failure a harness pipeline error becomes: the run's error, scored against the current turn. */
  protected _harnessFailure(text: string): EvalAssertionFailure {
    this._trace.log(`error: harness pipeline: ${text}`);
    return new EvalAssertionFailure({
      turnIndex: this._turns,
      expectationIndex: -1,
      eventName: "<harness>",
      reason: text,
      kind: "error",
    });
  }

  /** The persona's `end_call`: note its claim and end the conversation. */
  protected async _onEndCall(params: FunctionCallParams): Promise<void> {
    const args: Dict = params.arguments ?? {};
    const endCall = {
      success: _pyTruthy(Object.hasOwn(args, "success") ? args.success : false),
      reason: _pyStr(Object.hasOwn(args, "reason") ? args.reason : ""),
    };
    this._endCall = endCall;
    // The call is the persona's last word: no follow-up response.
    await params.resultCallback(
      { status: "call ended" },
      { properties: new FunctionCallResultProperties({ runLlm: false }) },
    );
    // The persona answers nothing more. The run hears of the call once the
    // reply that made it has gone out, so that reply's turn comes first.
    await this._client.hangUp();
    await this._client.reportEndCall({ type: END_CALL_EVENT, text: endCall.reason, ...endCall });
  }

  /** Read the stream's events not yet read into the conversation. */
  protected _observeNewEvents(): void {
    const events = this._stream.eventsSeen;
    while (this._observed < events.length) {
      const event = events[this._observed]!;
      this._observed += 1;
      const kind = event.type;
      const name = _pyTruthy(event.name) ? (event.name as string) : "?";
      if (kind === this._botSaid && _pyTruthy(event.text)) {
        this._conversation.addAssistantMessage(event.text as string);
      } else if (kind === PERSONA_TURN_EVENT) {
        this._conversation.addUserMessage(_pyTruthy(event.text) ? (event.text as string) : "");
      } else if (kind === "function_call") {
        this._conversation.addToolCall(name, (_pyTruthy(event.args) ? event.args : {}) as Dict);
      } else if (
        kind === "function_call_stopped" &&
        _pyTruthy(((_pyTruthy(event.args) ? event.args : {}) as Dict).cancelled)
      ) {
        this._conversation.cancelToolCall(name);
      }
    }
  }

  /**
   * Score the measured metrics, then ask the judge once about the goal and
   * every judged criterion.
   *
   * A judge that answers nothing usable about the goal is the run's error,
   * not a verdict on the bot.
   */
  protected async _judgeConversation(): Promise<EvalAssertionFailure[]> {
    const measured = new Map<string, EvalSimulationMetricScore>();
    for (const metric of this._simulation.metrics) {
      if (metric.measure !== null) {
        measured.set(metric.name, this._measure(metric));
      }
    }
    if (this._judge === null) {
      this._metrics.push(...measured.values());
      this._reason = "no judge configured";
      return [];
    }
    const judgement = await new EvalSimulationJudge(this._simulation, {
      judge: this._judge,
      trace: this._trace,
    }).judge(this._conversation.messages);
    const judged = new Map(judgement.metrics.map((metric) => [metric.name, metric]));
    this._metrics.push(
      ...this._simulation.metrics.map(
        (metric) =>
          (measured.get(metric.name) ?? judged.get(metric.name)) as EvalSimulationMetricScore,
      ),
    );
    this._succeeded = judgement.goal.verdict === "yes";
    this._reason = judgement.goal.reason;
    this._goalConfidence = judgement.goal.confidence;
    this._goalProbabilities = judgement.goal.probabilities;
    if (judgement.goal.verdict === "none") {
      this._trace.log(`judge: no verdict on the goal: ${this._reason}`);
      return [
        new EvalAssertionFailure({
          turnIndex: this._turns,
          expectationIndex: -1,
          eventName: "<judge>",
          reason: this._reason,
          kind: "judge_no_verdict",
        }),
      ];
    }
    this._trace.log(
      `judge: goal ${this._succeeded ? "achieved" : "not achieved"}: ${this._reason}`,
    );
    return [];
  }

  /** A measured metric's outcome: its value against its range, or the bot's calls against the list. */
  protected _measure(metric: EvalSimulationMetric): EvalSimulationMetricScore {
    let score: number | null;
    let value: number | null;
    let passed: boolean;
    let reason: string;
    if (metric.measure === "function_calls") {
      [value, passed, reason] = this._callsOutcome(metric);
      score = passed ? 1.0 : 0.0;
    } else {
      let described: string;
      [value, described] = this._measurement(metric.measure ?? "");
      const low = metric.minValue;
      const high = metric.maxValue;
      let bound: string;
      if (low !== null && high !== null) {
        bound = `between ${_formatG(low)} and ${_formatG(high)}`;
      } else if (high !== null) {
        bound = `at most ${_formatG(high)}`;
      } else {
        bound = `at least ${_formatG(low as number)}`;
      }
      reason = `${described}, ${bound}`;
      if (value === null) {
        score = null;
        passed = true;
      } else {
        const inside = (low === null || value >= low) && (high === null || value <= high);
        score = inside ? 1.0 : 0.0;
        passed = inside;
      }
    }
    this._trace.log(
      `measure: ${metric.name} = ${score === null ? "unscored" : pyFormatFixed(score, 2)}` +
        `${passed ? "" : " (failed)"}: ${reason}`,
    );
    return new EvalSimulationMetricScore({
      name: metric.name,
      score,
      passed,
      reason,
      value,
      failureKind: passed ? null : metric.calls === null ? "out_of_range" : "function_calls",
    });
  }

  /** A measure's value for this run, and the phrase that reports it. */
  protected _measurement(measure: string): [number | null, string] {
    if (measure === "turns") {
      return [this._turns, `${this._turns} persona turn(s)`];
    }
    if (measure === "duration") {
      return [this._durationS, `${pyFormatFixed(this._durationS, 1)} s`];
    }
    if (measure === "words") {
      const lengths = this.conversation()
        .filter((line) => line.role === "assistant")
        .map((line) => (line.content as string).split(/\s+/).filter((w) => w.length > 0).length);
      if (lengths.length === 0) {
        return [null, "no reply to measure"];
      }
      const longest = Math.max(...lengths);
      return [longest, `longest reply ${longest} words`];
    }
    if (measure === "latency") {
      const latencies = this._replyLatencies();
      if (latencies.length === 0) {
        return [null, "no reply to time"];
      }
      const slowest = Math.max(...latencies);
      const timed = this._simulation.botAudio
        ? "from the persona stopping to the first spoken sentence"
        : "to the first token";
      return [slowest, `slowest reply ${pyFormatFixed(slowest, 2)} s ${timed}`];
    }
    throw new Error(`unknown measure ${_pyRepr(measure)}`);
  }

  /**
   * Seconds from each persona turn to the bot's first word of the reply.
   *
   * In text mode, from the send to the first LLM token; in audio mode, from
   * the bot noticing the persona stop to its first spoken sentence.
   */
  protected _replyLatencies(): number[] {
    const [sent, replied] = this._simulation.botAudio
      ? ["user_stopped_speaking", "tts_response"]
      : [PERSONA_TURN_EVENT, "llm_response"];
    const latencies: number[] = [];
    let sentAt: number | null = null;
    for (const event of this._stream.eventsSeen) {
      if (event.type === sent) {
        sentAt = (event.at as number | null | undefined) ?? null;
      } else if (event.type === replied && sentAt !== null) {
        const firstWord = (
          Object.hasOwn(event, "started_at") ? event.started_at : (event.at ?? null)
        ) as number | null;
        if (firstWord !== null && firstWord !== undefined) {
          latencies.push(round3(Math.max(0.0, firstWord - sentAt)));
        }
        sentAt = null;
      }
    }
    return latencies;
  }

  /**
   * The `function_calls` measure: the count, whether the set matches, and a
   * reason naming the calls made against the list.
   */
  protected _callsOutcome(metric: EvalSimulationMetric): [number, boolean, string] {
    const made = this._callsMade();
    const expected = metric.calls ?? [];
    const missing = expected.filter((spec) => !made.some((c) => _callMatches(spec, c)));
    const unlisted = made.filter((c) => !expected.some((spec) => _callMatches(spec, c)));
    const described = made.map((c) => c.signature).join(", ") || "no calls";
    const wanted = expected.map((spec) => spec.signature).join(", ") || "none";
    return [
      made.length,
      missing.length === 0 && unlisted.length === 0,
      `${described}, expected ${wanted}`,
    ];
  }

  /** The bot's function calls in order, less the ones it cancelled. */
  protected _callsMade(): EvalFunctionCall[] {
    return this._conversation.messages
      .filter((message) => message.role === "tool_call" && !message.cancelled)
      .map(
        (message) =>
          new EvalFunctionCall({
            name: message.name as string,
            args: message.arguments as Dict,
          }),
      );
  }
}
