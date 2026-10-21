// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/evals/script_driver.py

/** The scripted driver: plays a scenario's turns and matches each turn's expectations. */

import { monotonic, sleep, TimeoutError } from "@pipedog/asyncio";
import { pyStrRepr } from "./_pyutil.ts";
import {
  BaseEvalDriver,
  type BaseEvalDriverOptions,
  type EvalDriverResultOptions,
} from "./base_driver.ts";
import { EvalBotEndedError } from "./events.ts";
import { ExpectationMatcher } from "./matcher.ts";
import {
  EvalAssertionFailure,
  EvalExpectationResult,
  EvalScriptResult,
  EvalScriptTurnProgress,
  EvalScriptTurnResult,
} from "./results.ts";
import { _formatG } from "./scenario_config.ts";
import type {
  EvalExpectation,
  EvalScriptScenario,
  EvalScriptTurn,
  EvalSendAfter,
} from "./script.ts";

export const SEND_AFTER_MAX_WAIT_S = 30.0;
// How long a turn waits for the bot to finish speaking before it is sent. A
// reply is still spoken after its first sentence satisfied the previous turn;
// a turn sent over it would have that tail transcribed as its own reply, or
// discarded together with the answer that followed it in the same breath.
export const BOT_QUIET_MAX_WAIT_S = 30.0;
export const SEND_AFTER_POLL_S = 0.01;

/** Options for {@link EvalScriptDriver}. */
export interface EvalScriptDriverOptions extends BaseEvalDriverOptions {
  /** The scenario whose turns to play. */
  scenario: EvalScriptScenario;
  /** Latency budget for expectations without their own `within_ms`. */
  defaultTimeoutMs: number;
}

/**
 * Plays a scenario's turns in order and matches each turn's expectations.
 *
 * A failed turn ends the scenario by default, since the conversation is in an
 * unknown state from there on; `stop_on_failure: false` drives every turn
 * regardless.
 */
export class EvalScriptDriver extends BaseEvalDriver<EvalScriptResult> {
  protected _scenario: EvalScriptScenario;
  protected _defaultTimeoutMs: number;
  protected _matcher: ExpectationMatcher;
  /**
   * One record per turn, filled in as the driver runs. They start as not_run
   * and stay that way on every path that ends the run early, so the result
   * always says which turns were actually scored.
   */
  turns: EvalScriptTurnResult[];

  /**
   * Initialize the driver.
   *
   * @param options See {@link EvalScriptDriverOptions}.
   */
  constructor(options: EvalScriptDriverOptions) {
    super(options);
    this._scenario = options.scenario;
    this._defaultTimeoutMs = options.defaultTimeoutMs;
    this._matcher = new ExpectationMatcher({
      stream: options.stream,
      judge: options.judge,
      trace: options.trace,
    });
    this.turns = options.scenario.turns.map((_t, i) => new EvalScriptTurnResult({ turnIndex: i }));
  }

  /** Drive the scenario's turns in order, filling in their records. */
  async run(): Promise<EvalAssertionFailure[]> {
    const failures: EvalAssertionFailure[] = [];
    for (const [turnIdx, turn] of this._scenario.turns.entries()) {
      this._trace.turn = turnIdx;
      this._trace.log(`--- turn ${turnIdx}: ${turn.user === null ? "None" : pyStrRepr(turn.user)}`);
      const turnStarted = monotonic();
      const turnFailures = await this._runTurn(turn, turnIdx);
      const record = this.turns[turnIdx]!;
      record.status = turnFailures.length > 0 ? "failed" : "passed";
      record.failures = turnFailures;
      record.durationMs = Math.trunc((monotonic() - turnStarted) * 1000);
      failures.push(...turnFailures);
      if (turnFailures.length > 0) {
        // By default a failed turn ends the scenario: it leaves the
        // conversation in an unknown state, so running the rest just burns
        // another timeout per turn (e.g. a broken greeting turn shouldn't
        // cost the full budget here and again on the question). A scenario
        // whose turns are scored independently sets stop_on_failure: false
        // and drives all of them.
        if (this._scenario.stopOnFailure) {
          this._trace.log(`turn ${turnIdx} failed; stopping scenario (stop_on_failure)`);
          break;
        }
        this._trace.log(`turn ${turnIdx} failed; continuing (stop_on_failure: false)`);
      }
    }
    return failures;
  }

  /** The scenario's result: passed only if nothing failed and nothing was skipped. */
  result(options: EvalDriverResultOptions): EvalScriptResult {
    const skipped = options.skipped ?? null;
    return new EvalScriptResult({
      scenarioName: this._scenario.name,
      passed: options.failures.length === 0 && skipped === null,
      failures: options.failures,
      turns: this.turns,
      durationMs: options.durationMs,
      eventsSeen: options.eventsSeen,
      debugLog: options.debugLog,
      skipped,
    });
  }

  /**
   * Score a run-level failure against the turn it interrupted, if any.
   *
   * Before any turn started (a sub-pipeline that never came up) the failure's
   * turn is -1 and every turn stays not_run.
   */
  override recordFailure(failure: EvalAssertionFailure): void {
    if (failure.turnIndex >= 0 && failure.turnIndex < this.turns.length) {
      const record = this.turns[failure.turnIndex]!;
      record.status = "failed";
      record.failures.push(failure);
    }
  }

  /** Drive one turn: honor `send_after`, send the input, match the expectations. */
  protected async _runTurn(turn: EvalScriptTurn, turnIdx: number): Promise<EvalAssertionFailure[]> {
    // An expectation may look back to the start of its turn, never further.
    this._matcher.resetTurn();

    if (turn.sendAfter !== null) {
      const failure = await this._awaitSendAfter(turn.sendAfter, turnIdx);
      if (failure !== null) {
        return [failure];
      }
    } else if (turn.user !== null || turn.dtmf !== null) {
      // A caller waits for the bot to finish; a turn that means to talk
      // over it says so with `send_after`.
      await this._awaitBotQuiet();
    } else if (turnIdx > 0) {
      await this._awaitPreviousReply();
    }

    await this._sendTurn(turn);
    await this._progress(
      new EvalScriptTurnProgress({
        turnIndex: turnIdx,
        expectationIndex: -1,
        eventName: turn.user || turn.dtmf || "",
        status: "turn",
      }),
    );
    return await this._matchExpectations(turn, turnIdx);
  }

  /**
   * Hold the send while the bot is speaking, and until its speech is
   * transcribed, up to `BOT_QUIET_MAX_WAIT_S`.
   *
   * What the bot said before the send belongs to the turn before, so the send
   * waits for the last of it to be transcribed and closed into a turn: a
   * transcript can land seconds after its audio, and one landing after the
   * send would otherwise be taken for the reply.
   */
  protected async _awaitBotQuiet(): Promise<void> {
    if (this._stream.botSpeaking) {
      this._trace.log("send: waiting for the bot to finish speaking");
      if (!(await this._stream.waitBotQuiet(BOT_QUIET_MAX_WAIT_S))) {
        this._trace.log(
          `send: bot still speaking after ${_formatG(BOT_QUIET_MAX_WAIT_S)}s, sending`,
        );
        return;
      }
    }
    if (this._stream.botTranscribed) {
      return;
    }
    this._trace.log("send: waiting for the bot's speech to be transcribed");
    if (!(await this._stream.waitBotTranscribed(BOT_QUIET_MAX_WAIT_S))) {
      this._trace.log(
        `send: bot speech still being transcribed after ${_formatG(BOT_QUIET_MAX_WAIT_S)}s ` +
          `(${this._stream.botSpeechOutstanding}), sending`,
      );
    }
  }

  /**
   * Let a reply the bot is still speaking, or that is still being transcribed,
   * end before an observing turn starts.
   *
   * A turn that sends nothing waits for what the bot says next, so what the
   * bot is still saying belongs to the turn before it, however late its
   * transcription lands. The first turn keeps the bot's greeting.
   */
  protected async _awaitPreviousReply(): Promise<void> {
    if (!this._stream.botSpeaking && this._stream.botTranscribed) {
      return;
    }
    this._trace.log("observe: waiting for the bot to finish the previous reply");
    await this._stream.waitBotQuiet(BOT_QUIET_MAX_WAIT_S);
    await this._stream.waitBotTranscribed(BOT_QUIET_MAX_WAIT_S);
    this._stream.dropPendingBotOutput("the previous reply");
    this._stream.observingBoundary();
  }

  /** Hold the turn's send until its `send_after` fires; a failure if it never does. */
  protected async _awaitSendAfter(
    sendAfter: EvalSendAfter,
    turnIdx: number,
  ): Promise<EvalAssertionFailure | null> {
    try {
      await this._waitSendAfter(sendAfter);
    } catch (e) {
      if (e instanceof TimeoutError) {
        const reason = `send_after never fired: ${e.message}`;
        return await this._sendAfterFailure(sendAfter, turnIdx, reason);
      }
      if (e instanceof EvalBotEndedError) {
        const reason = `the bot ended the call before ${
          sendAfter.event === null ? "None" : pyStrRepr(sendAfter.event)
        } fired`;
        return await this._sendAfterFailure(sendAfter, turnIdx, reason, "bot_ended");
      }
      throw e;
    }
    return null;
  }

  /** Record a turn whose `send_after` never fired, and return its failure. */
  protected async _sendAfterFailure(
    sendAfter: EvalSendAfter,
    turnIdx: number,
    reason: string,
    kind = "send_after_timeout",
  ): Promise<EvalAssertionFailure> {
    // Only the event-anchored wait can fail; the pure-delay form just
    // sleeps. So event is never null here, but fall back for typing.
    const eventName = sendAfter.event || "send_after";
    this._trace.log(`FAIL: ${eventName}: ${reason}`);
    const status = kind === "send_after_timeout" ? "timeout" : "failed";
    await this._progress(
      new EvalScriptTurnProgress({
        turnIndex: turnIdx,
        expectationIndex: -1,
        eventName,
        status,
        detail: reason,
      }),
    );
    return new EvalAssertionFailure({
      turnIndex: turnIdx,
      expectationIndex: -1,
      eventName,
      reason,
      kind,
    });
  }

  /**
   * Wait until `sendAfter.event` has been seen and `delayMs` more have passed.
   *
   * With no event it is a plain delay from the previous turn's send.
   *
   * @throws TimeoutError If the event never arrives.
   * @throws EvalBotEndedError If the bot ends the call before the event arrives.
   */
  protected async _waitSendAfter(sendAfter: EvalSendAfter): Promise<void> {
    const targetDelayS = sendAfter.delayMs / 1000.0;

    if (sendAfter.event === null) {
      this._trace.log(`send_after: waiting ${sendAfter.delayMs}ms`);
      await sleep(targetDelayS);
      return;
    }

    const deadline = monotonic() + SEND_AFTER_MAX_WAIT_S;
    this._trace.log(
      `send_after: waiting for ${pyStrRepr(sendAfter.event)} + ${sendAfter.delayMs}ms`,
    );

    while (true) {
      const seenAt = this._stream.latestEventTimes[sendAfter.event];
      if (seenAt !== undefined) {
        const waitS = Math.max(0.0, seenAt + targetDelayS - monotonic());
        await sleep(waitS);
        return;
      }

      if (this._stream.botHasEnded) {
        throw new EvalBotEndedError();
      }

      if (monotonic() >= deadline) {
        throw new TimeoutError(
          `event ${pyStrRepr(sendAfter.event)} not seen within ` +
            `${Math.trunc(SEND_AFTER_MAX_WAIT_S * 1000)}ms`,
        );
      }

      await sleep(SEND_AFTER_POLL_S);
    }
  }

  /**
   * Send the turn's input: its image, if any, then its utterance or keypresses.
   *
   * A turn that sends nothing only observes, so the bot's pending output is
   * kept for it.
   */
  protected async _sendTurn(turn: EvalScriptTurn): Promise<void> {
    // Register the turn's image before the user input, so the bot can serve
    // it when it requests a user image during the turn.
    if (turn.image !== null) {
      await this._client.sendImage(turn.image);
    }
    if (turn.user !== null) {
      await this._say(turn.user, { audioFile: turn.audio, parts: turn.parts });
    } else if (turn.dtmf !== null) {
      await this._press(turn.dtmf);
    }
  }

  /**
   * Match the turn's expectations in order, all within one deadline anchored at the send.
   *
   * A stalled turn then fails within a single `within_ms` budget rather than
   * one budget per expectation, and a turn whose bot ended the call fails at
   * once.
   */
  protected async _matchExpectations(
    turn: EvalScriptTurn,
    turnIdx: number,
  ): Promise<EvalAssertionFailure[]> {
    const failures: EvalAssertionFailure[] = [];
    const resolved = this.turns[turnIdx]!.expectations;
    const anchor = monotonic();
    for (const [expIdx, expectation] of turn.expect.entries()) {
      const budgetMs = expectation.withinMs || this._defaultTimeoutMs;
      let failure: EvalAssertionFailure | null;
      try {
        failure = await this._matcher.match(expectation, anchor, budgetMs, turnIdx, expIdx);
      } catch (e) {
        if (e instanceof TimeoutError) {
          const reason = `no matching ${pyStrRepr(expectation.event)} event arrived within ${budgetMs}ms`;
          failures.push(await this._unmatched(turnIdx, expIdx, expectation, reason));
          break;
        }
        if (e instanceof EvalBotEndedError) {
          const reason = `the bot ended the call before a matching ${pyStrRepr(expectation.event)} event`;
          failures.push(await this._unmatched(turnIdx, expIdx, expectation, reason, "bot_ended"));
          break;
        }
        throw e;
      }

      if (failure) {
        failures.push(failure);
        resolved.push(
          new EvalExpectationResult({
            expectationIndex: expIdx,
            eventName: expectation.event,
            passed: false,
          }),
        );
        this._trace.log(`FAIL: ${expectation.event}: ${failure.reason}`);
        await this._progress(
          new EvalScriptTurnProgress({
            turnIndex: turnIdx,
            expectationIndex: expIdx,
            eventName: expectation.event,
            status: "failed",
            detail: failure.reason,
          }),
        );
      } else {
        const matched = this._matcher.lastMatchText;
        resolved.push(
          new EvalExpectationResult({
            expectationIndex: expIdx,
            eventName: expectation.event,
            passed: true,
            matched,
          }),
        );
        await this._progress(
          new EvalScriptTurnProgress({
            turnIndex: turnIdx,
            expectationIndex: expIdx,
            eventName: expectation.event,
            status: "matched",
            detail: matched,
          }),
        );
      }
    }
    return failures;
  }

  /** Record an expectation whose event never arrived, and return its failure. */
  protected async _unmatched(
    turnIdx: number,
    expIdx: number,
    expectation: EvalExpectation,
    reason: string,
    kind = "timeout",
  ): Promise<EvalAssertionFailure> {
    this.turns[turnIdx]!.expectations.push(
      new EvalExpectationResult({
        expectationIndex: expIdx,
        eventName: expectation.event,
        passed: false,
      }),
    );
    this._trace.log(`FAIL: ${expectation.event}: ${reason}`);
    const status = kind === "timeout" ? "timeout" : "failed";
    await this._progress(
      new EvalScriptTurnProgress({
        turnIndex: turnIdx,
        expectationIndex: expIdx,
        eventName: expectation.event,
        status,
        detail: reason,
      }),
    );
    return new EvalAssertionFailure({
      turnIndex: turnIdx,
      expectationIndex: expIdx,
      eventName: expectation.event,
      reason,
      kind,
    });
  }
}
