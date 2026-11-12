// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/evals/matcher.py

/**
 * Matching a scenario's expectations against the bot's events.
 *
 * `ExpectationMatcher` waits on the run's `EvalEventStream` for the event an
 * expectation names and verifies it: a payload check, a judge verdict, the
 * aggregation of a reply across its segments, the any-order matching of a
 * turn's function calls, and the inverted `absent:` check.
 */

import { monotonic, TimeoutError } from "@pipedog/asyncio";
import { contextualize } from "./_log_context.ts";
import { pyRegExp, pyStrRepr } from "./_pyutil.ts";
import { EvalBotEndedError, type EvalEvent, type EvalEventStream } from "./events.ts";
import type { EvalJudge } from "./judge.ts";
import { EvalAssertionFailure, type EvalTrace } from "./results.ts";
import { _pyRepr, _pyStr, _pyTruthy } from "./scenario_config.ts";
import { type EvalExpectation, FUNCTION_CALL_EVENTS } from "./script.ts";

// How long a judge's "no" waits for more of the reply once the bot has stopped
// speaking: the transcription of its last sentence lands after the stop.
export const JUDGE_NO_GRACE_S = 2.0;

type Dict = Record<string, unknown>;

/** Python's `a or b`. */
function or<T>(value: unknown, fallback: T): unknown {
  return _pyTruthy(value) ? value : fallback;
}

/** Python's `==` on the JSON values an event's arguments hold. */
function pyEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === "boolean" || typeof b === "boolean") {
    // True == 1 in Python.
    if (typeof a === "number" || typeof b === "number") return Number(a) === Number(b);
    return false;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((x, i) => pyEquals(x, b[i]));
  }
  if (
    a !== null &&
    b !== null &&
    typeof a === "object" &&
    typeof b === "object" &&
    !Array.isArray(a) &&
    !Array.isArray(b)
  ) {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    return (
      ka.length === kb.length &&
      ka.every((k) => Object.hasOwn(b, k) && pyEquals((a as Dict)[k], (b as Dict)[k]))
    );
  }
  return false;
}

/** Whether a call event is the one a `calls:` entry names, with the arguments it gives. */
function _callMatches(event: EvalEvent, name: string | null, args: Dict | null): boolean {
  if (name !== null && (event.name ?? null) !== name) {
    return false;
  }
  if (args === null) {
    return true;
  }
  const actual = or(event.args, {}) as Dict;
  return Object.entries(args).every(([k, v]) => pyEquals(actual[k] ?? null, v));
}

/** Python's `" ".join(s.split())`. */
function squash(s: string): string {
  return s
    .split(/\s+/)
    .filter((w) => w.length > 0)
    .join(" ");
}

/** Python's `str.count` (non-overlapping). */
function countOf(haystack: string, needle: string): number {
  if (needle === "") return haystack.length + 1;
  let count = 0;
  let at = haystack.indexOf(needle);
  while (at !== -1) {
    count += 1;
    at = haystack.indexOf(needle, at + needle.length);
  }
  return count;
}

/** Options for {@link ExpectationMatcher}. */
export interface ExpectationMatcherOptions {
  /** The bot's events, consumed as expectations match. */
  stream: EvalEventStream;
  /** The judge for `eval:` assertions, or `null` when the scenario has none. */
  judge: EvalJudge | null;
  /** The run's trace, for the matcher's progress. */
  trace: EvalTrace;
}

/**
 * Matches one expectation at a time against the event stream.
 *
 * Expected events must appear in order, with unmatched events allowed in
 * between. A reply with a content check aggregates its segments and
 * re-checks on each, so an interim "Let me check" is rolled past rather
 * than taken for the answer. A turn's function calls match by name in any
 * order.
 */
export class ExpectationMatcher {
  protected _stream: EvalEventStream;
  protected _judge: EvalJudge | null;
  protected _trace: EvalTrace;
  /**
   * Text content of the most recently matched event (the bot's response, or
   * a user transcript), surfaced to verbose progress. Empty for events with
   * no text (llm_started, function_call, speaking events).
   */
  lastMatchText = "";
  // When the most recent expectation matched, so an absence check can tell
  // a reply that began after it from the rest of the one it matched.
  protected _lastMatchAt = 0.0;

  /**
   * Initialize the matcher.
   *
   * @param options.stream The bot's events, consumed as expectations match.
   * @param options.judge The judge for `eval:` assertions, or `null` when the
   *   scenario has none.
   * @param options.trace The run's trace, for the matcher's progress.
   */
  constructor(options: ExpectationMatcherOptions) {
    this._stream = options.stream;
    this._judge = options.judge;
    this._trace = options.trace;
  }

  /** Forget the previous turn's events. */
  resetTurn(): void {
    this._stream.beginTurn();
  }

  /**
   * Wait for the expected event and verify it.
   *
   * Stale bot output is not filtered here: the stream drops it on an
   * interruption and the driver before each send.
   *
   * @param expectation The expectation to match.
   * @param anchor Monotonic time the turn's budget is measured from.
   * @param budgetMs The expectation's latency budget.
   * @param turnIdx Index of the turn, for the failure record.
   * @param expIdx Index of the expectation within the turn, for the record.
   * @returns The failure, or `null` when the expectation is satisfied.
   * @throws TimeoutError When no matching event arrives at all (so the caller
   *   can report "no matching event arrived"). A response that arrives but
   *   never satisfies the content check returns a failure instead.
   * @throws EvalBotEndedError When the bot ends the call before the expectation
   *   is met. An `absent:` expectation is met instead, since the event can no
   *   longer arrive.
   */
  async match(
    expectation: EvalExpectation,
    anchor: number,
    budgetMs: number,
    turnIdx: number,
    expIdx: number,
  ): Promise<EvalAssertionFailure | null> {
    const deadline = anchor + budgetMs / 1000.0;
    this.lastMatchText = "";

    if (expectation.absent) {
      return await this._matchAbsent(expectation, deadline, budgetMs, turnIdx, expIdx);
    }
    // Where in the turn the expectation looks for its event from: only what
    // arrives from here on, or back from the start of the turn.
    const since = expectation.checkFrom === "turn_start" ? 0 : this._stream.turnPosition;
    if (expectation.aggregates) {
      return await this._matchAggregating(expectation, deadline, budgetMs, turnIdx, expIdx, since);
    }
    if ((FUNCTION_CALL_EVENTS as readonly string[]).includes(expectation.event)) {
      // A call expectation holds the set of calls the turn should make; it
      // completes only when all are found, in any order (a response
      // arriving doesn't short-circuit it).
      return await this._matchFunctionCalls(expectation, deadline, turnIdx, expIdx, since);
    }
    return await this._matchOne(expectation, deadline, turnIdx, expIdx, since);
  }

  /** Match a single event and check its payload and judge assertion. */
  protected async _matchOne(
    expectation: EvalExpectation,
    deadline: number,
    turnIdx: number,
    expIdx: number,
    since: number,
  ): Promise<EvalAssertionFailure | null> {
    this._trace.log(`match: waiting for ${pyStrRepr(expectation.event)}`);
    const event = await this._stream.nextEvent(expectation.event, deadline, { since });
    const payloadFailure = this._checkPayload(event, expectation, turnIdx, expIdx);
    if (payloadFailure) {
      return payloadFailure;
    }
    const judgeFailure = await this._checkJudge(event, expectation, turnIdx, expIdx);
    if (judgeFailure === null) {
      this.lastMatchText = this._matchSummary(event);
      this._lastMatchAt = monotonic();
    }
    return judgeFailure;
  }

  /** Accumulate reply segments until the content check passes or fails. */
  protected async _matchAggregating(
    expectation: EvalExpectation,
    deadline: number,
    budgetMs: number,
    turnIdx: number,
    expIdx: number,
    since: number,
  ): Promise<EvalAssertionFailure | null> {
    if (expectation.eval !== null && this._judge === null) {
      return this._failure(
        expectation,
        turnIdx,
        expIdx,
        "scenario uses 'eval:' but no judge could be built",
        "no_judge",
      );
    }

    const check = (
      [
        ["text_contains", expectation.textContains],
        ["eval", expectation.eval],
      ] as const
    )
      .filter(([, val]) => val !== null)
      .map(([name]) => name)
      .join("+");
    this._trace.log(`match: waiting for ${pyStrRepr(expectation.event)} (${check})`);
    let aggregate = "";
    let lastReason = "";
    let seenAny = false;
    let pending: EvalEvent | null = null;
    while (true) {
      let event: EvalEvent;
      if (pending !== null) {
        event = pending;
        pending = null;
      } else {
        try {
          event = await this._stream.nextEvent(expectation.event, deadline, { since });
        } catch (e) {
          if (!(e instanceof TimeoutError)) throw e;
          if (!seenAny) {
            throw e; // no response at all: the caller reports the missing event
          }
          return this._unsatisfied(expectation, turnIdx, expIdx, budgetMs, lastReason);
        }
      }

      seenAny = true;
      const delta = this._eventText(event);
      aggregate += delta;
      const excluded = this._textExcluded(aggregate, expectation, turnIdx, expIdx);
      if (excluded !== null) {
        return excluded;
      }
      // Feed each segment to the judge as its own assistant message, so it
      // judges the bot's reply in the conversation's context (the cumulative
      // `aggregate` is kept only for text_contains and the match summary).
      if (expectation.eval !== null && this._judge !== null) {
        this._judge.addAssistantMessage(delta);
      }
      const [status, reason] = await this._evaluateAggregate(aggregate, expectation);
      this._trace.log(`eval: ${status} (aggregate=${pyStrRepr(aggregate.trim())}) ${reason}`);
      if (status === "pass") {
        const unmatched = this._textUnmatched(aggregate, expectation, turnIdx, expIdx);
        if (unmatched !== null) {
          return unmatched;
        }
        this.lastMatchText = aggregate;
        this._lastMatchAt = monotonic();
        return null;
      }
      if (status === "fail") {
        // Only the judge can affirmatively fail an aggregate, and only
        // once the reply is complete: a "no" on a reply still being
        // spoken, or whose last sentence is still being transcribed, is
        // a "continue" that the next segment may turn into a "yes".
        pending = await this._restOfReply(expectation.event, deadline, since);
        if (pending === null) {
          return this._failure(expectation, turnIdx, expIdx, reason, "judge_no");
        }
        this._trace.log("eval: no, but the reply goes on: judging the rest");
      }
      // "continue": wait for the next segment, separated by a space so
      // sentences don't run together (e.g. "...that. The weather...").
      aggregate += " ";
      lastReason = reason;
    }
  }

  /**
   * The next segment of a reply the judge rejected, or `null` when the reply is over.
   *
   * While the bot is speaking the next segment is awaited within the turn's
   * budget; once it has stopped, only for the grace its last sentence's
   * transcription needs.
   */
  protected async _restOfReply(
    eventType: string,
    deadline: number,
    since: number,
  ): Promise<EvalEvent | null> {
    const until = this._stream.botSpeaking
      ? deadline
      : Math.min(deadline, monotonic() + JUDGE_NO_GRACE_S);
    try {
      return await this._stream.nextEvent(eventType, until, { since });
    } catch (e) {
      if (e instanceof TimeoutError || e instanceof EvalBotEndedError) return null;
      throw e;
    }
  }

  /**
   * The failure of a reply that never satisfied its check within the budget.
   *
   * With `eval:` the judge kept saying `continue`; without it the only way to
   * be unsatisfied is a missing substring.
   */
  protected _unsatisfied(
    expectation: EvalExpectation,
    turnIdx: number,
    expIdx: number,
    budgetMs: number,
    lastReason: string,
  ): EvalAssertionFailure {
    this._trace.log(`eval: timeout, not satisfied: ${lastReason}`);
    return this._failure(
      expectation,
      turnIdx,
      expIdx,
      `not satisfied within ${budgetMs}ms: ${lastReason}`,
      expectation.eval !== null ? "judge_continue" : "text_mismatch",
    );
  }

  /**
   * Pass when no event of this type arrives before the deadline; an arriving one fails at once, with its content.
   *
   * A reply reaches the stream in segments, one per pause in the bot's
   * speech, so a `response` that continues the reply an earlier expectation
   * matched is not a new one: only a response the bot began after that match
   * counts.
   */
  protected async _matchAbsent(
    expectation: EvalExpectation,
    deadline: number,
    budgetMs: number,
    turnIdx: number,
    expIdx: number,
  ): Promise<EvalAssertionFailure | null> {
    const name = pyStrRepr(expectation.event);
    this._trace.log(`match: expecting NO ${name} for ${budgetMs}ms`);
    let event: EvalEvent;
    while (true) {
      try {
        event = await this._stream.nextEvent(expectation.event, deadline);
      } catch (e) {
        if (e instanceof TimeoutError) {
          // The quiet window held: absence confirmed.
          this.lastMatchText = `no ${name} for ${budgetMs}ms`;
          return null;
        }
        if (e instanceof EvalBotEndedError) {
          this.lastMatchText = `no ${name} before the bot ended the call`;
          return null;
        }
        throw e;
      }
      if (expectation.event === "response" && !this._replyBeganAfterLastMatch()) {
        this._trace.log(
          `absent: the matched reply goes on, not a new one: ` +
            `${pyStrRepr(this._matchSummary(event))}`,
        );
        continue;
      }
      break;
    }
    return this._failure(
      expectation,
      turnIdx,
      expIdx,
      `expected no ${name} within ${budgetMs}ms, ` +
        `but one arrived: ${this._matchSummary(event)}`,
      "unexpected_event",
    );
  }

  /** Whether the bot started a reply since the most recent match, by its LLM or its speech. */
  protected _replyBeganAfterLastMatch(): boolean {
    const times = this._stream.latestEventTimes;
    const began = Math.max(times.llm_started ?? 0.0, times.bot_started_speaking ?? 0.0);
    return began > this._lastMatchAt;
  }

  /**
   * Match every call in the expectation, in any order, within the budget; else
   * a failure naming the call that was missing or whose args did not match.
   *
   * The calls are looked for from `since` on, so they may arrive in any
   * order, and a call the LLM corrects and repeats still satisfies it.
   *
   * With `eval:`, each matched call is also put to the judge, and the first
   * one it rejects fails the expectation.
   */
  protected async _matchFunctionCalls(
    expectation: EvalExpectation,
    deadline: number,
    turnIdx: number,
    expIdx: number,
    since: number,
  ): Promise<EvalAssertionFailure | null> {
    if (expectation.eval !== null && this._judge === null) {
      return this._failure(
        expectation,
        turnIdx,
        expIdx,
        "scenario uses 'eval:' but no judge could be built",
        "no_judge",
      );
    }

    const matched: string[] = [];
    for (const spec of expectation.calls ?? []) {
      const want = _pyTruthy(spec.args) ? spec.args : null;
      const specName = spec.name;
      this._trace.log(`match: waiting for ${pyStrRepr(expectation.event)} (${spec.signature})`);
      let event: EvalEvent;
      try {
        event = await this._stream.nextEvent(expectation.event, deadline, {
          since,
          accept: (ev) => _callMatches(ev, specName, want),
        });
      } catch (e) {
        if (!(e instanceof TimeoutError)) throw e;
        // A call of the right name with the wrong arguments is a different
        // failure from the call never being made, and the bot's arguments
        // are what the reader needs to see.
        const near = this._stream
          .unclaimedSince(since)
          .filter(
            (ev) => ev.type === expectation.event && (specName === null || ev.name === specName),
          )
          .map((ev) => ev.args ?? null);
        if (want !== null && near.length > 0) {
          return this._failure(
            expectation,
            turnIdx,
            expIdx,
            `no ${_pyRepr(specName)} call had args ${_pyRepr(want)} (saw ${_pyRepr(near)})`,
            "function_args_mismatch",
          );
        }
        const missing = _pyTruthy(specName) ? (specName as string) : "any function";
        const seen = matched.length > 0 ? matched.join(", ") : "none";
        return this._failure(
          expectation,
          turnIdx,
          expIdx,
          `function call ${pyStrRepr(missing)} not seen (matched: ${seen})`,
          "missing_function_call",
        );
      }
      const judgeFailure = await this._checkCallJudge(event, expectation, turnIdx, expIdx);
      if (judgeFailure) {
        return judgeFailure;
      }
      matched.push(_pyStr(event.name ?? null));
    }

    this.lastMatchText = matched.join(", ") || "function call";
    this._lastMatchAt = monotonic();
    return null;
  }

  /**
   * Put a matched call to the judge if `eval:` was set on the expectation.
   *
   * The judge is asked about the call by name and arguments, in the light of
   * the spoken conversation so far. A call is not a partial reply, so a
   * `continue` fails it like a `no`.
   */
  protected async _checkCallJudge(
    event: EvalEvent,
    expectation: EvalExpectation,
    turnIdx: number,
    expIdx: number,
  ): Promise<EvalAssertionFailure | null> {
    if (expectation.eval === null) {
      return null;
    }
    // _matchFunctionCalls fails before matching when there is no judge.
    const judge = this._judge;
    if (judge === null) throw new Error("assertion failed: judge is not set");
    const name = _pyStr(or(event.name, "?"));
    const args = or(event.args, {}) as Dict;
    const criterion = expectation.eval;
    const verdict = await contextualize({ eval_pipeline: "judge" }, () =>
      judge.evaluateCall(name, args, criterion),
    );
    this._trace.log(`eval: ${verdict.verdict} (${this._matchSummary(event)}) ${verdict.reason}`);
    if (verdict.passed) {
      return null;
    }
    return this._failure(
      expectation,
      turnIdx,
      expIdx,
      `eval ${pyStrRepr(criterion)} on ${this._matchSummary(event)}: ` +
        `judge said ${verdict.verdict} — ${verdict.reason}`,
      "judge_no",
    );
  }

  /**
   * Check the accumulated reply text: `pass`, `fail`, or `continue` for more text.
   *
   * A missing substring is `continue`; only the judge can `fail`.
   */
  protected async _evaluateAggregate(
    aggregate: string,
    expectation: EvalExpectation,
  ): Promise<[string, string]> {
    if (
      expectation.textContains !== null &&
      !this._textContains(aggregate, expectation.textContains)
    ) {
      return ["continue", `does not contain ${pyStrRepr(expectation.textContains)}`];
    }

    if (expectation.eval !== null) {
      if (!aggregate.trim()) {
        return ["continue", "no response text yet"];
      }
      // match() guarantees a judge exists before aggregating eval:.
      const judge = this._judge;
      if (judge === null) throw new Error("assertion failed: judge is not set");
      const criterion = expectation.eval;
      // The reply segments were added to the judge's conversation in the
      // aggregation loop; the judge evaluates that context, not `aggregate`.
      const verdict = await contextualize({ eval_pipeline: "judge" }, () =>
        judge.evaluate(criterion),
      );
      if (verdict.verdict === "no") {
        return ["fail", `judge said no: ${verdict.reason}`];
      }
      if (verdict.verdict === "continue") {
        return ["continue", `judge said continue: ${verdict.reason}`];
      }
      return ["pass", `judge said yes: ${verdict.reason}`];
    }

    return ["pass", ""];
  }

  /** Apply payload-level checks to a matched event. Returns the first failure or null. */
  protected _checkPayload(
    event: EvalEvent,
    expectation: EvalExpectation,
    turnIdx: number,
    expIdx: number,
  ): EvalAssertionFailure | null {
    if (expectation.textContains !== null) {
      const content = this._eventText(event);
      if (!this._textContains(content, expectation.textContains)) {
        return this._failure(
          expectation,
          turnIdx,
          expIdx,
          `text ${pyStrRepr(content)} does not contain ${pyStrRepr(expectation.textContains)}`,
          "text_mismatch",
        );
      }
    }
    const excluded = this._textExcluded(this._eventText(event), expectation, turnIdx, expIdx);
    if (excluded !== null) {
      return excluded;
    }
    const unmatched = this._textUnmatched(this._eventText(event), expectation, turnIdx, expIdx);
    if (unmatched !== null) {
      return unmatched;
    }
    if (expectation.marker !== null) {
      const kind = event.kind ?? null;
      const wanted = expectation.marker === "incomplete" ? ["short", "long"] : [expectation.marker];
      if (!wanted.includes(kind as string)) {
        return this._failure(
          expectation,
          turnIdx,
          expIdx,
          `marker ${pyStrRepr(this._eventText(event))} is ` +
            `${_pyStr(or(kind, "of no known kind"))}, expected ${expectation.marker}`,
          "marker_mismatch",
        );
      }
    }
    const problem = this._checkMarkerFormat(event, expectation);
    if (problem !== null) {
      return this._failure(expectation, turnIdx, expIdx, problem, "marker_format");
    }
    return null;
  }

  /**
   * What is wrong with the shape of the response's raw text, if anything.
   *
   * The checks read the raw text the marker event carries against every
   * marker the bot recognizes, so they see what the LLM wrote before the bot
   * held any of it back.
   */
  protected _checkMarkerFormat(event: EvalEvent, expectation: EvalExpectation): string | null {
    if (
      expectation.markerFirst === null &&
      expectation.markers === null &&
      expectation.textAfter === null
    ) {
      return null;
    }
    const raw = or(event.raw, "") as string;
    const known = or(event.markers, []) as string[];
    const found = known
      .filter((m) => raw.includes(m))
      .map((m) => [raw.indexOf(m), m] as [number, string])
      .sort((a, b) => a[0] - b[0] || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
    const count = known.reduce((n, m) => n + countOf(raw, m), 0);
    const [firstAt, first] = found.length > 0 ? found[0]! : [-1, null];
    const excerpt = pyStrRepr(raw.slice(0, 80));
    if (expectation.markers !== null && count !== expectation.markers) {
      return `raw text holds ${count} marker(s), expected ${expectation.markers}: ${excerpt}`;
    }
    if (expectation.markerFirst !== null) {
      const isFirst = first !== null && !raw.slice(0, firstAt).trim();
      if (isFirst !== expectation.markerFirst) {
        return (
          `raw text ${isFirst ? "starts" : "does not start"} with a marker, ` +
          `expected it ${expectation.markerFirst ? "to" : "not to"}: ${excerpt}`
        );
      }
    }
    if (expectation.textAfter !== null) {
      if (first === null) {
        return `raw text holds no marker to check text after: ${excerpt}`;
      }
      const hasAfter = Boolean(raw.slice(firstAt + first.length).trim());
      if (hasAfter !== expectation.textAfter) {
        return (
          `raw text has ${hasAfter ? "text" : "nothing"} after the marker, ` +
          `expected ${expectation.textAfter ? "text" : "nothing"}: ${excerpt}`
        );
      }
    }
    return null;
  }

  /** Run the judge assertion if `eval:` was set on this expectation. */
  protected async _checkJudge(
    event: EvalEvent,
    expectation: EvalExpectation,
    turnIdx: number,
    expIdx: number,
  ): Promise<EvalAssertionFailure | null> {
    if (expectation.eval === null) {
      return null;
    }

    if (this._judge === null) {
      return this._failure(
        expectation,
        turnIdx,
        expIdx,
        "scenario uses 'eval:' but no judge could be built",
        "no_judge",
      );
    }

    const content = or(event.text, event.transcript);
    if (!_pyTruthy(content)) {
      return this._failure(
        expectation,
        turnIdx,
        expIdx,
        `event has no text/transcript to judge: ${_pyRepr(event)}`,
        "no_content",
      );
    }

    this._judge.addAssistantMessage(content as string);
    const verdict = await this._judge.evaluate(expectation.eval);
    if (!verdict.passed) {
      return this._failure(
        expectation,
        turnIdx,
        expIdx,
        `eval ${pyStrRepr(expectation.eval)}: judge said no — ${verdict.reason}`,
        "judge_no",
      );
    }

    return null;
  }

  /** Build the failure record for `expectation`. */
  protected _failure(
    expectation: EvalExpectation,
    turnIdx: number,
    expIdx: number,
    reason: string,
    kind: string,
  ): EvalAssertionFailure {
    return new EvalAssertionFailure({
      turnIndex: turnIdx,
      expectationIndex: expIdx,
      eventName: expectation.event,
      reason,
      kind,
    });
  }

  /** A short label for a matched event: the call signature, or the event's text. */
  protected _matchSummary(event: EvalEvent): string {
    if (event.type === "function_call") {
      const args = or(event.args, {}) as Dict;
      const sig = Object.entries(args)
        .map(([k, v]) => `${k}=${_pyStr(v)}`)
        .join(", ");
      return `${_pyStr(or(event.name, "?"))}(${sig})`;
    }
    return this._eventText(event);
  }

  /** The text an event carries: reply events use `text`, `user_transcription` `transcript`. */
  protected _eventText(event: EvalEvent): string {
    return or(or(event.text, event.transcript), "") as string;
  }

  /** The failure for `text_excludes` when `content` holds it, else `null`. */
  protected _textExcluded(
    content: string,
    expectation: EvalExpectation,
    turnIdx: number,
    expIdx: number,
  ): EvalAssertionFailure | null {
    if (
      expectation.textExcludes === null ||
      !this._textContains(content, expectation.textExcludes)
    ) {
      return null;
    }
    return this._failure(
      expectation,
      turnIdx,
      expIdx,
      `text ${pyStrRepr(content.trim())} contains ${pyStrRepr(expectation.textExcludes)}`,
      "text_present",
    );
  }

  /** The failure for the first `text_matches` pattern `content` misses, else `null`. */
  protected _textUnmatched(
    content: string,
    expectation: EvalExpectation,
    turnIdx: number,
    expIdx: number,
  ): EvalAssertionFailure | null {
    for (const pattern of expectation.textMatches ?? []) {
      if (!pyRegExp(pattern).test(content)) {
        const shown = Array.from(content.trim()).slice(0, 200).join("");
        return this._failure(
          expectation,
          turnIdx,
          expIdx,
          `text ${pyStrRepr(shown)} does not match ${pyStrRepr(pattern)}`,
          "text_unmatched",
        );
      }
    }
    return null;
  }

  /** Whether `needle` occurs in `content`, ignoring spacing. */
  protected _textContains(content: string, needle: string): boolean {
    return squash(content).includes(squash(needle));
  }
}
