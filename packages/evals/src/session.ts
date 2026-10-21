// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/evals/session.py

/**
 * The eval session: one conversation with a bot, driven to a result.
 *
 * A session connects to a running bot's eval transport as an RTVI client,
 * runs the handshake, lets its driver converse, tears down, and returns the
 * driver's result, a failed connect or a harness error included. The two
 * session kinds build the client and the driver for their kind of scenario;
 * `EvalSession.fromScenario` builds whichever kind a scenario is, and
 * `EvalSessionParams` is how the run behaves, whichever kind it is.
 *
 * Porting notes: the deprecated `stop_bot` / `trigger_disconnect` params, the
 * deprecated knob keyword arguments of `fromScenario` (and
 * `_params_with_deprecated_knobs`), and the deprecated `on_progress` callback
 * argument are not ported; use `params` and the `on_progress` event handler.
 * `fromScenario` is async, because building the services a scenario needs is.
 *
 * @example
 * const params = new EvalSessionParams({ defaultTimeoutMs: 30000 });
 * for (const scenario of await EvalScenarioFile.load("scenarios/greeting.yaml")) {
 *   const session = await EvalSession.fromScenario(scenario, "ws://localhost:7860/ws", { params });
 *   const result = await session.run();
 *   console.log(scenario.name, result.passed ? "PASS" : "FAIL");
 * }
 */

import { monotonic, rethrowIfCancelled, TimeoutError } from "@pipedog/asyncio";
import type { LLMService } from "@pipedog/core/services/llm_service";
import type { STTService } from "@pipedog/core/services/stt_service";
import { BaseObject } from "@pipedog/core/utils/base_object";
import { logger } from "@pipedog/core/utils/logger";
import { pyStrRepr } from "./_pyutil.ts";
import type { BaseEvalDriver } from "./base_driver.ts";
import type { EvalClient } from "./client.ts";
import type { EvalEventStream } from "./events.ts";
import type { EvalJudge } from "./judge.ts";
import { EvalAssertionFailure, type EvalProgress, EvalTrace } from "./results.ts";
import type { EvalKind } from "./scenario.ts";
import { EvalScriptScenario } from "./script.ts";
import type { EvalScriptSession } from "./script_session.ts";
import { EvalSimulationScenario } from "./simulation.ts";
import type { EvalSimulationSession } from "./simulation_session.ts";
import type { CachingTTSService } from "./tts.ts";

/**
 * Generous default so an expectation without an explicit `within_ms` waits
 * long enough for slow LLM/TTS responses (and function-call round-trips)
 * rather than failing on latency. Set `within_ms` explicitly to assert on timing.
 */
export const DEFAULT_EVENT_TIMEOUT_MS = 60000;

/**
 * A bot builds its pipeline when the harness connects, so the wait covers its
 * startup: connecting its services and loading any local models.
 */
export const DEFAULT_BOT_READY_TIMEOUT_S = 60.0;

/** Options for {@link EvalSessionParams}. */
export interface EvalSessionParamsOptions {
  /** How long to wait for the bot to accept the WS connection before giving up. */
  connectTimeoutS?: number;
  /** How long to wait, once connected, for the bot to answer the RTVI handshake with `bot-ready`. */
  botReadyTimeoutS?: number;
  /**
   * Scripted scenarios only: the latency budget for expectations without their
   * own `within_ms` (the turn's expectations share one deadline anchored at the
   * send). Defaults to 60s.
   */
  defaultTimeoutMs?: number;
  /** Where to save the conversation audio, or `null`. Only an audio-mode run records. */
  recordPath?: string | null;
  /**
   * Directory for cached synthesized user audio, or `null` for the default
   * (`<user-cache-dir>/pipecat/evals/tts`).
   */
  cacheDir?: string | null;
  /** When false, ignore cached user audio and force fresh synthesis, with no cache reads or writes. */
  useCache?: boolean;
}

/**
 * How a run behaves, whichever kind of scenario it is: timeouts, recording, caching.
 *
 * Plain configuration, so one instance serves many runs and crosses process
 * boundaries; the services a run uses are passed to the session separately.
 */
export class EvalSessionParams {
  connectTimeoutS: number;
  botReadyTimeoutS: number;
  defaultTimeoutMs: number;
  recordPath: string | null;
  cacheDir: string | null;
  useCache: boolean;

  constructor(options: EvalSessionParamsOptions = {}) {
    this.connectTimeoutS = options.connectTimeoutS ?? 5.0;
    this.botReadyTimeoutS = options.botReadyTimeoutS ?? DEFAULT_BOT_READY_TIMEOUT_S;
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_EVENT_TIMEOUT_MS;
    this.recordPath = options.recordPath ?? null;
    this.cacheDir = options.cacheDir ?? null;
    this.useCache = options.useCache ?? true;
  }
}

/** Options for {@link EvalSession}. */
export interface EvalSessionOptions {
  /** The scenario kind being run, for the trace. */
  kind: EvalKind;
  /** The scenario's or simulation's name. */
  name: string;
  /** WebSocket URL of the bot's eval transport. */
  botUrl: string;
  /** How the run behaves; `null` for the defaults. */
  params?: EvalSessionParams | null;
}

/** Options for {@link EvalSession.fromScenario}. */
export interface EvalSessionFromScenarioOptions {
  /** How the run behaves; `null` for the defaults. */
  params?: EvalSessionParams | null;
  /** Simulations only: override the persona LLM (default: built from the simulation's `simulator`). */
  personaLlm?: LLMService | null;
  /** Override the judge (default: built from the scenario's `judge` when the run needs one). */
  judge?: EvalJudge | null;
  /** Override the user-audio TTS (default: built from the scenario's `user_speech` in audio mode). */
  userTts?: CachingTTSService | null;
  /** Override the bot-audio STT (default: built from the scenario's `transcriber` when the run transcribes the bot). */
  botStt?: STTService | null;
}

/** What `Error.name` / the class name of a Node system error stands for, as Python names it. */
const _OS_ERROR_NAMES: Record<string, string> = {
  ECONNREFUSED: "ConnectionRefusedError",
  ECONNRESET: "ConnectionResetError",
  ECONNABORTED: "ConnectionAbortedError",
  EPIPE: "BrokenPipeError",
  ETIMEDOUT: "TimeoutError",
};

/**
 * Python's `except (OSError, TimeoutError)` for a connect attempt, and the
 * error's class name as Python's `e.__class__.__name__` gives it.
 *
 * DIVERGENCE: Node reports a socket error as a plain `Error` with a `code`
 * (`ECONNREFUSED`, ...); it counts as an `OSError` here, named after the
 * Python exception that code raises there.
 */
function _connectErrorName(e: unknown): string | null {
  if (e instanceof TimeoutError) {
    return "TimeoutError";
  }
  if (e instanceof Error) {
    const code = (e as Error & { code?: unknown }).code;
    if (typeof code === "string") {
      return _OS_ERROR_NAMES[code] ?? "OSError";
    }
  }
  return null;
}

/** `type(e).__name__` for an error, as the trace and the failure name it. */
function _errorTypeName(e: unknown): string {
  if (e instanceof Error) {
    return e.constructor.name;
  }
  return e === null || e === undefined ? "NoneType" : ((e as object).constructor?.name ?? typeof e);
}

/**
 * One conversation with a bot, driven to a result.
 *
 * Connect, run the handshake, let the driver converse, tear down, and turn
 * what happened, a failed connect or a harness error included, into the
 * driver's result. The subclasses, `EvalScriptSession` and
 * `EvalSimulationSession`, build the client and the driver for their kind of
 * scenario; `fromScenario` picks the one a scenario needs.
 *
 * Event handlers available:
 *
 * - on_progress: Called with an `EvalProgress` record as the conversation
 *   advances: a scripted scenario's turns and expectations as they resolve, a
 *   simulation's lines as they are spoken. Records are emitted in order, and
 *   `run` waits for every handler before it returns.
 */
export abstract class EvalSession<R> extends BaseObject {
  protected _kind: EvalKind;
  protected _sessionName: string;
  protected _botUrl: string;
  protected _params: EvalSessionParams;
  // Timestamped trace of the harness's own decisions, for diagnosing flakes.
  protected _trace: EvalTrace;
  // Built by the subclass: the bot's output as events, the connection to the
  // bot, and what drives the conversation.
  protected _stream!: EvalEventStream;
  protected _client!: EvalClient;
  protected _driver!: BaseEvalDriver<R>;

  /**
   * Initialize the session's runtime.
   *
   * @param options See {@link EvalSessionOptions}.
   */
  constructor(options: EvalSessionOptions) {
    super();
    this._kind = options.kind;
    // NOTE: upstream's `self._name` would shadow `BaseObject._name`, which the
    // TS base class uses for the object's own name; it is `_sessionName` here.
    this._sessionName = options.name;
    this._botUrl = options.botUrl;
    this._params = options.params ?? new EvalSessionParams();
    this._trace = new EvalTrace();
    this._registerEventHandler("on_progress");
  }

  /**
   * Build a ready-to-run session for a scenario of either kind.
   *
   * A scripted scenario gets an `EvalScriptSession`, a simulation an
   * `EvalSimulationSession`, each constructing the services it needs. Pass
   * `personaLlm`, `judge`, `userTts`, or `botStt` to use your own. Then await `run`.
   *
   * @example
   * const session = await EvalSession.fromScenario(scenario, "ws://localhost:7860/ws");
   * const result = await session.run();
   *
   * @param scenario The parsed scenario to run, scripted or a simulation.
   * @param botUrl WebSocket URL of the bot's eval transport.
   * @param options See {@link EvalSessionFromScenarioOptions}.
   * @returns A configured session of the scenario's kind, ready for `run`.
   * @throws Error (Python `ValueError`) If `personaLlm` is given for a scripted
   *   scenario, which has no persona.
   * @throws TypeError If `scenario` is neither kind.
   */
  // NOTE: one signature, not upstream's typing overloads per kind: the
  // subclasses' own `fromScenario` (one kind each) must stay assignable to it.
  static async fromScenario(
    scenario: EvalScriptScenario | EvalSimulationScenario,
    botUrl: string,
    options: EvalSessionFromScenarioOptions = {},
  ): Promise<EvalScriptSession | EvalSimulationSession> {
    // Imported here rather than at module level: both subclasses import this module.
    const params = options.params ?? new EvalSessionParams();
    if (scenario instanceof EvalSimulationScenario) {
      const { EvalSimulationSession } = await import("./simulation_session.ts");
      return await EvalSimulationSession.fromScenario(scenario, botUrl, {
        params,
        personaLlm: options.personaLlm ?? null,
        judge: options.judge ?? null,
        userTts: options.userTts ?? null,
        botStt: options.botStt ?? null,
      });
    } else if (scenario instanceof EvalScriptScenario) {
      if (options.personaLlm !== undefined && options.personaLlm !== null) {
        throw new Error(
          `personaLlm applies to simulations only; ${pyStrRepr(scenario.name)} is scripted`,
        );
      }
      const { EvalScriptSession } = await import("./script_session.ts");
      return await EvalScriptSession.fromScenario(scenario, botUrl, {
        params,
        judge: options.judge ?? null,
        userTts: options.userTts ?? null,
        botStt: options.botStt ?? null,
      });
    }
    const typeName =
      scenario === null || scenario === undefined
        ? "NoneType"
        : ((scenario as object).constructor?.name ?? typeof scenario);
    throw new TypeError(`expected a scripted scenario or a simulation, got <class '${typeName}'>`);
  }

  /** Connect, drive the conversation, and return the result. */
  async run(): Promise<R> {
    const started = monotonic();
    this._trace.start();
    this._trace.log(`run: ${this._kind} ${pyStrRepr(this._sessionName)} -> ${this._botUrl}`);
    // Record which speech / transcription / judge services and models were used,
    // so a saved eval.log is self-describing (no need to cross-reference config).
    const description = this._describe().replace(/\r?\n$/, "");
    for (const line of description ? description.split(/\r?\n/) : []) {
      this._trace.log(line);
    }

    // The judge is closed however the run ends, including the runs that are
    // skipped or never reach the bot.
    try {
      const skipped = this._skipReason();
      if (skipped !== null) {
        logger.warning(`Eval '${this._sessionName}': ${skipped}; skipping`);
        return this._result(started, [], skipped);
      }

      // A bot that never accepts is a clean <connect> failure.
      try {
        await this._client.waitForBot();
      } catch (e) {
        rethrowIfCancelled(e);
        const errorName = _connectErrorName(e);
        if (errorName === null) {
          throw e;
        }
        const reason = `failed to connect to ${this._botUrl}: ${errorName}`;
        return this._result(started, [this._failure("<connect>", reason, "connect_failed")]);
      }

      const failures = await this._drive();
      this._trace.log(
        `done: ${failures.length === 0 ? "PASS" : "FAIL"} (${failures.length} failure(s))`,
      );
      return this._result(started, failures);
    } finally {
      await this._driver.close();
    }
  }

  /**
   * Start the client, converse, and tear down.
   *
   * An error in the harness itself is recorded as a failure with its
   * traceback, so the run still yields a result.
   */
  protected async _drive(): Promise<EvalAssertionFailure[]> {
    await this._client.start();
    try {
      return await this._converse();
    } catch (e) {
      rethrowIfCancelled(e);
      return [this._errorFailure(e)];
    } finally {
      await this._client.stop();
      // Progress handlers run as tasks; wait them out so every record is
      // delivered before the caller has the result in hand.
      await this.cleanup();
    }
  }

  /** Run the handshake, then the driver; a bot that never says ready is a failure. */
  protected async _converse(): Promise<EvalAssertionFailure[]> {
    // The client is imported lazily, as upstream does (it is the heavy part
    // of the harness), for its error class.
    const { EvalBotUnavailableError } = await import("./client.ts");

    this._trace.log("connected");
    try {
      await this._client.handshake();
    } catch (e) {
      if (e instanceof EvalBotUnavailableError) {
        this._trace.log(`handshake: failed (${e.message})`);
        const where = e.kind === "connect_failed" ? "<connect>" : "<bot-ready>";
        return [this._failure(where, e.message, e.kind)];
      }
      if (e instanceof TimeoutError) {
        this._trace.log("handshake: failed (bot-ready not received)");
        return [this._failure("<bot-ready>", e.message, "handshake_timeout")];
      }
      throw e;
    }
    this._trace.log("handshake: ok (bot-ready)");
    return await this._driver.run();
  }

  /** Have the driver assemble the run's result. */
  protected _result(
    started: number,
    failures: EvalAssertionFailure[],
    skipped: string | null = null,
  ): R {
    return this._driver.result({
      failures,
      durationMs: Math.trunc((monotonic() - started) * 1000),
      eventsSeen: this._stream.eventsSeen,
      debugLog: this._trace.lines,
      skipped,
    });
  }

  /** The run's config summary, one line per section, for the trace. */
  protected abstract _describe(): string;

  /** Why the run can't be driven at all, or `null` to run it. */
  protected _skipReason(): string | null {
    return null;
  }

  /**
   * A failure of the run itself rather than of an expectation, scored against
   * the trace's current turn (-1 before any).
   */
  protected _failure(eventName: string, reason: string, kind: string): EvalAssertionFailure {
    return new EvalAssertionFailure({
      turnIndex: this._trace.turn,
      expectationIndex: -1,
      eventName,
      reason,
      kind,
    });
  }

  /**
   * Trace an unexpected error with its traceback and let the driver score it.
   *
   * DIVERGENCE: the traceback is the JS stack, under Python's
   * `Traceback (most recent call last):` heading.
   */
  protected _errorFailure(e: unknown): EvalAssertionFailure {
    const typeName = _errorTypeName(e);
    const message = e instanceof Error ? e.message : String(e);
    this._trace.log(`error: ${typeName}: ${message}`);
    this._trace.log("Traceback (most recent call last):");
    const stack = e instanceof Error && e.stack ? e.stack : `${typeName}: ${message}`;
    for (const line of stack.trimEnd().split(/\r?\n/)) {
      this._trace.log(line);
    }
    const failure = this._failure("<error>", `${typeName}: ${message}`, "error");
    this._driver.recordFailure(failure);
    return failure;
  }

  /** Emit a progress record to the `on_progress` handlers. */
  protected async _progress(record: EvalProgress): Promise<void> {
    await this._callEventHandler("on_progress", record);
  }
}
