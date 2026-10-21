// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/evals/base_driver.py

/**
 * The base driver: what the user says next, and how the run is scored.
 *
 * A driver runs the conversation over the session's client and event stream
 * and assembles the result. The scripted driver plays a file's turns and
 * matches their expectations; the simulation driver lets the persona LLM hold
 * the conversation and judges the whole of it.
 */

import { pyStrRepr } from "./_pyutil.ts";
import type { EvalClient } from "./client.ts";
import type { EvalEvent, EvalEventStream } from "./events.ts";
import type { EvalJudge } from "./judge.ts";
import type { EvalAssertionFailure, EvalProgress, EvalTrace } from "./results.ts";

/** Options for {@link BaseEvalDriver}. */
export interface BaseEvalDriverOptions {
  /** The connection to the bot, for the user's sends. */
  client: EvalClient;
  /** The bot's output as events. */
  stream: EvalEventStream;
  /**
   * The judge for `eval:` assertions, or `null`; the user's turns are added
   * to its conversation so replies are judged in context.
   */
  judge: EvalJudge | null;
  /** The run's trace. */
  trace: EvalTrace;
  /** Awaited with an `EvalProgress` record as the conversation advances. */
  progress: (record: EvalProgress) => Promise<void>;
}

/** Options for {@link BaseEvalDriver.result}. */
export interface EvalDriverResultOptions {
  /**
   * The run's failures: the driver's own, plus the session's (a failed
   * connect or handshake, a harness error).
   */
  failures: EvalAssertionFailure[];
  /** Wall-clock time the run took. */
  durationMs: number;
  /** Every event observed, for diagnostics. */
  eventsSeen: EvalEvent[];
  /** The run's trace. */
  debugLog: string[];
  /** Why the run was not driven at all, or `null`. */
  skipped?: string | null;
}

/** Options for {@link BaseEvalDriver._say}. */
export interface EvalSayOptions {
  /** Optional recording to play in place of synthesizing the text. */
  audioFile?: string | null;
  /** Optional text and pauses to speak in place of the text, as `EvalScriptTurn.parts`. */
  parts?: (string | number)[] | null;
}

/**
 * Base class for the drivers: what the user says next, and how the run is scored.
 *
 * A driver sends through the client, reads the stream, and decides what
 * counts as success. Subclasses implement `run` and `result`.
 */
export abstract class BaseEvalDriver<R> {
  protected _client: EvalClient;
  protected _stream: EvalEventStream;
  protected _judge: EvalJudge | null;
  protected _trace: EvalTrace;
  protected _progress: (record: EvalProgress) => Promise<void>;

  /**
   * Initialize the driver.
   *
   * @param options See {@link BaseEvalDriverOptions}.
   */
  constructor(options: BaseEvalDriverOptions) {
    this._client = options.client;
    this._stream = options.stream;
    this._judge = options.judge;
    this._trace = options.trace;
    this._progress = options.progress;
  }

  /** Drive the conversation to its end and return the failures. */
  abstract run(): Promise<EvalAssertionFailure[]>;

  /** Close the judge, once the run has ended. */
  async close(): Promise<void> {
    if (this._judge !== null) {
      await this._judge.close();
    }
  }

  /**
   * Assemble the run's result from what the driver scored and the session saw.
   *
   * @param options See {@link EvalDriverResultOptions}.
   */
  abstract result(options: EvalDriverResultOptions): R;

  /**
   * Note a run-level failure the session raised while the driver was running.
   *
   * @param _failure The failure, scored against the trace's current turn.
   */
  recordFailure(_failure: EvalAssertionFailure): void {}

  /**
   * Send one user utterance to the bot.
   *
   * It goes out as the recording in `audioFile` when given, spoken by the user
   * TTS when the client has one, else as text. Bot output still queued from
   * before is dropped first, so it cannot be matched as the reply.
   *
   * @param text What the user says; also recorded in the judge's conversation
   *   so a later reply is judged in context (e.g. a terse "That's four"
   *   answering this question).
   * @param options.audioFile Optional recording to play in place of
   *   synthesizing `text`.
   * @param options.parts Optional text and pauses to speak in place of `text`.
   */
  protected async _say(text: string, options: EvalSayOptions = {}): Promise<void> {
    const audioFile = options.audioFile ?? null;
    const parts = options.parts ?? null;
    this._stream.dropPendingBotOutput("before send");
    const how = audioFile || (this._client.hasUserTts ? "audio" : "text");
    this._trace.log(`send: ${pyStrRepr(text)} (${how})`);
    if (audioFile !== null) {
      await this._client.play(audioFile);
    } else if (parts !== null && this._client.hasUserTts) {
      await this._client.sayWithPauses(parts);
    } else if (this._client.hasUserTts) {
      await this._client.say(text);
    } else {
      await this._client.sendText(text);
    }
    if (this._judge !== null) {
      this._judge.addUserMessage(text);
    }
    // Only what the bot says in reply to this input is matched from here on.
    this._stream.inputSent();
  }

  /**
   * Send DTMF keypresses as the user's turn.
   *
   * @param keys The keys to press, in order; recorded for the judge so the
   *   bot's reply is judged knowing what was pressed.
   */
  protected async _press(keys: string): Promise<void> {
    this._stream.dropPendingBotOutput("before send");
    this._trace.log(`send: dtmf ${pyStrRepr(keys)}`);
    await this._client.sendDtmf(keys);
    if (this._judge !== null) {
      this._judge.addUserMessage(`(DTMF keypad input: ${keys})`);
    }
    this._stream.inputSent();
  }
}
