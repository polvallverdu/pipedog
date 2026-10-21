// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/evals/suite.py

/**
 * Multi-bot eval suite runner.
 *
 * An `EvalManifest` lists bots to spawn and the scenarios to run against each,
 * scripted and simulated alike. An `EvalSuite` runs each bot on its own port
 * with the dev runner and drives it with the harness in a subprocess, several
 * at a time. `pipedog-eval suite` is the CLI in front of it; the release evals
 * are a manifest plus that command.
 *
 * Manifest format (YAML):
 *
 * ```yaml
 * concurrency: 4
 * repeat: 1                     # run each (bot, scenario) N times
 * runs_dir: test-runs           # logs + recordings go to <runs_dir>/<timestamp>/
 * record: false                 # record conversation audio
 * cache_dir: null               # optional
 * scenarios_dir: scenarios      # resolved relative to this manifest file
 * # {python}=the JS runtime (default the running one: bun or node), {bot}=bot path,
 * # {port}=assigned per run by the suite runner
 * spawn: "{python} {bot} --port {port}"
 * suite:
 *   - bot: examples/voice/voice-cartesia.ts
 *     scenarios: [simple_math, greeting]
 *   - bot: examples/voice/voice-groq.ts
 *     concurrency: 2                           # this bot's own cap
 *     scenarios: [simple_math, interruption]
 *   - bot: examples/vision/vision-openai.ts
 *     runner_body:
 *       path: scenarios/vision-cat.yaml        # passed to the bot as --runner-body
 *     scenarios: [vision_describe]
 *   - bot: examples/turns/filter-incomplete-turns.ts
 *     name: openai/gpt-4o-mini                 # this entry's label, the bot path by default
 *     runner_body:
 *       data: {model: gpt-4o-mini}             # written to a file for the bot
 *     scenarios: [turn_completion]
 * ```
 *
 * A `scenarios:` entry names a scenario file, and the file contributes one run
 * per scenario it holds, scripted or a simulation as each says (see
 * `EvalScenarioFile`), named `<file name>/<scenario name>`. A name resolves
 * under `scenarios_dir` with `.yaml` added and may carry a folder, as
 * `scripted/greeting`; a name ending in `.yaml` is a path relative to the
 * manifest instead. A simulation runs as many times as its `runs:` says, and
 * every run must pass.
 *
 * An optional `runner_body:` supplies runner-args data the bot would normally
 * receive in a `/start` request body (e.g. a vision bot's image path), passed
 * to it as `--runner-body`. It holds either `path:`, a YAML or JSON file
 * resolved relative to the manifest, or `data:`, the body itself as a mapping,
 * which the suite writes to a file among the run's logs. A bot given a file
 * runs with the file's directory as its working directory, so relative paths
 * inside the body (like an image) resolve next to the file.
 *
 * An entry's `name:` is its label: what the display, the `-p` filter, the
 * results records and the artifact file names use. It defaults to the `bot:`
 * path; two entries may not run the same scenario under the same label.
 *
 * `concurrency` is how many runs execute at once. The suite keeps that many
 * going, taking the next run from the first entry in manifest order that still
 * has one. An entry whose provider rate-limits sets its own `concurrency:`.
 *
 * Manifest-relative paths (`bot`/`bots_dir`, `scenarios_dir`, `runs_dir`)
 * resolve relative to the manifest file; the same values passed as CLI
 * overrides resolve against the working directory.
 *
 * `repeat` (or `--repeat`) runs every (bot, scenario) pair N times. Attempts
 * run attempt-major and carry an `EvalRun.attempt` number that joins their
 * artifact filenames, so no attempt overwrites another's logs.
 *
 * Bots are spawned with the running JS runtime (`process.execPath`, i.e. `bun`
 * or `node`) as `{python}`, on a bot script that calls `@pipedog/runner`'s
 * `main()`, which accepts upstream's runner flags (`--port`, `--runner-body`).
 * Running a `.ts` bot under node needs a node with type stripping (>= 22.6
 * with `--experimental-strip-types`, on by default from 23.6).
 */

// DIVERGENCE: upstream's deprecated `runner_body: <file>` (a bare string), the
// deprecated `EvalSuite.run(on_update=, use_cache=, default_timeout_ms=)` keyword
// arguments, and the deprecated `stop_bot`/`trigger_disconnect` session params are
// not ported. A bare-string `runner_body:` is rejected like any other bad value.

import * as nodePath from "node:path";
import {
  Future,
  gather,
  monotonic,
  rethrowIfCancelled,
  TimeoutError,
  waitFor,
} from "@pipedog/asyncio";
import { BaseObject } from "@pipedog/core/utils/base_object";
import { LOG_LEVELS, type LogRecord, logger } from "@pipedog/core/utils/logger";
import { pyJsonDumps } from "@pipedog/core/utils/py_json";
import { load as yamlLoad } from "@pipedog/core/utils/yaml";
import { contextualize, logContext } from "./_log_context.ts";
import { pyStrRepr } from "./_pyutil.ts";
import { EvalScriptResult, EvalSimulationResult } from "./results.ts";
import { EvalKind, EvalScenarioFile } from "./scenario.ts";
import type { EvalScriptScenario } from "./script.ts";
import type { EvalSessionParams } from "./session.ts";
import { EvalSimulationScenario } from "./simulation.ts";

export const DEFAULT_BASE_PORT = 7900;
export const DEFAULT_CONCURRENCY = 4;
/**
 * How long to wait for a freshly spawned bot to start listening (the harness
 * retries the connect, so this doubles as readiness waiting).
 */
export const BOT_CONNECT_TIMEOUT_S = 60.0;
/** How long to wait for a bot subprocess to exit after it is asked to terminate before killing it. */
export const BOT_STOP_TIMEOUT_S = 10.0;
/**
 * Safety net for a hung harness worker. The harness's own per-expectation
 * timeouts bound a healthy run far below this; the cap only catches a worker
 * that wedges, so it can't hold a concurrency slot forever.
 */
export const WORKER_SAFETY_TIMEOUT_S = 600.0;
/** Default spawn template; `{python}`/`{bot}`/`{port}` are substituted per run. */
export const DEFAULT_SPAWN = "{python} {bot} --port {port}";
/** What a scenario file may be named, wherever one is looked for. */
export const SCENARIO_SUFFIXES = [".yaml", ".yml"] as const;

/**
 * The harness runs three sub-pipelines in-process and tags each one's logs
 * with an `eval_pipeline` context value via `contextualize` (see harness.ts),
 * independent of which TTS/STT/LLM service is used. Anything untagged (RTVI,
 * connection, harness internals) falls through to "harness". The label is the
 * human heading used for that pipeline's section in the debug log.
 */
export const PIPELINE_LOG_LABELS: Record<string, string> = {
  speech: "user speech logs",
  transcription: "bot speech transcription logs",
  judge: "judge logs",
  persona: "persona LLM logs",
  harness: "harness logs",
};
export const PIPELINE_LOG_CATEGORIES: readonly string[] = Object.keys(PIPELINE_LOG_LABELS);

// ---------------------------------------------------------------------------
// Log context (loguru's `logger.contextualize` / `record["extra"]`)
// ---------------------------------------------------------------------------

// See _log_context.ts (re-exported here for API parity).
export { contextualize, logContext };

/** The prefixes of the captures in progress, innermost last. */
const _activeCaptures: string[] = [];

function _formatRecord(record: LogRecord): string {
  let line = `${record.time.toISOString()} | ${record.level.padEnd(8)} | ${record.message}\n`;
  if (record.error !== undefined) {
    const error = record.error;
    line += `${error instanceof Error ? (error.stack ?? String(error)) : String(error)}\n`;
  }
  return line;
}

export interface CapturePipelineLogsOptions {
  /** Human test name shown in each section heading. */
  name: string;
  /** When false, do nothing and write no file. */
  enabled: boolean;
}

/**
 * Capture the harness's logs for one run into a single `<prefix>.debug.log`.
 *
 * The logs are buffered in memory and written on exit, one section per
 * pipeline. The run is tagged with `prefix` and the sink filters on it, so
 * concurrent runs never mix. Writes nothing unless `enabled`.
 *
 * DIVERGENCE: upstream's context manager is a callback here: `fn` runs inside
 * the capture, and its result is returned.
 *
 * @param logsDir Directory the `<prefix>.debug.log` is written to.
 * @param prefix Filename stem; also the `eval_run` id the sink filters on.
 * @param options The test name and whether to capture at all.
 * @param fn The code whose logs are captured.
 */
export async function capturePipelineLogs<T>(
  logsDir: string,
  prefix: string,
  options: CapturePipelineLogsOptions,
  fn: () => T | Promise<T>,
): Promise<T> {
  if (!options.enabled) {
    return await fn();
  }

  const buffers = new Map<string, string[]>(PIPELINE_LOG_CATEGORIES.map((cat) => [cat, []]));

  const sink = (record: LogRecord): void => {
    if (LOG_LEVELS[record.level] < LOG_LEVELS.DEBUG) return;
    const extra = logContext();
    const run = "eval_run" in extra ? extra.eval_run : _activeCaptures.at(-1);
    if (run !== prefix) return;
    const cat = typeof extra.eval_pipeline === "string" ? extra.eval_pipeline : "harness";
    let buffer = buffers.get(cat);
    if (buffer === undefined) {
      buffer = [];
      buffers.set(cat, buffer);
    }
    buffer.push(_formatRecord(record));
  };

  const removeSink = logger.addSink(sink);
  _activeCaptures.push(prefix);
  try {
    return await contextualize({ eval_run: prefix }, fn);
  } finally {
    removeSink();
    const index = _activeCaptures.lastIndexOf(prefix);
    if (index >= 0) _activeCaptures.splice(index, 1);
    const sections = PIPELINE_LOG_CATEGORIES.filter((cat) => buffers.get(cat)?.length).map(
      (cat) =>
        `===== ${PIPELINE_LOG_LABELS[cat]}: ${options.name} =====\n\n${buffers.get(cat)!.join("")}`,
    );
    if (sections.length) {
      const fs = await import("node:fs/promises");
      await fs.mkdir(logsDir, { recursive: true });
      await fs.writeFile(nodePath.join(logsDir, `${prefix}.debug.log`), sections.join("\n"));
    }
  }
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

async function _exists(path: string): Promise<boolean> {
  const fs = await import("node:fs/promises");
  try {
    await fs.stat(path);
    return true;
  } catch (e) {
    rethrowIfCancelled(e);
    return false;
  }
}

/** Run `fn`, ignoring a filesystem error (`contextlib.suppress(OSError)`). */
async function _suppressOSError(fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    rethrowIfCancelled(e);
    if (!(e instanceof Error && typeof (e as { code?: unknown }).code === "string")) throw e;
  }
}

/** `type(e).__name__` of a caught value. */
export function _errorTypeName(e: unknown): string {
  if (e instanceof Error) return e.name !== "Error" ? e.name : e.constructor.name;
  return typeof e;
}

/** `str(e)` of a caught value. */
export function _errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * `json.dumps(value, indent=2)`: Python's indented output, `ensure_ascii` included.
 * Non-ASCII can only appear inside strings, so escaping it over the whole text is safe.
 */
export function _pyJsonDumpsIndent(value: unknown): string {
  return JSON.stringify(value, null, 2).replace(
    /[\u007f-\uffff]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

/** Python truthiness of a YAML value. */
function _truthy(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (value !== null && typeof value === "object") return Object.keys(value).length > 0;
  return Boolean(value);
}

/** Python's `int(value)` of a YAML value. */
function _int(value: unknown, where: string): number {
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string" && /^\s*[+-]?\d+\s*$/.test(value))
    return Number.parseInt(value, 10);
  throw new Error(`${where}: invalid literal for int(): ${pyStrRepr(String(value))}`);
}

function _isMapping(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** `Path(name).stem`. */
function _stem(name: string): string {
  const base = nodePath.basename(name);
  const ext = nodePath.extname(base);
  return ext ? base.slice(0, -ext.length) : base;
}

/** `shlex.split(s)` (POSIX mode). */
export function _shlexSplit(s: string): string[] {
  const tokens: string[] = [];
  let token = "";
  let inToken = false;
  let i = 0;
  while (i < s.length) {
    const c = s[i]!;
    if (c === "'") {
      const end = s.indexOf("'", i + 1);
      if (end < 0) throw new Error("No closing quotation");
      token += s.slice(i + 1, end);
      inToken = true;
      i = end + 1;
    } else if (c === '"') {
      i++;
      let closed = false;
      while (i < s.length) {
        const d = s[i]!;
        if (d === '"') {
          closed = true;
          i++;
          break;
        }
        if (d === "\\" && i + 1 < s.length && '"\\$`\n'.includes(s[i + 1]!)) {
          token += s[i + 1];
          i += 2;
        } else {
          token += d;
          i++;
        }
      }
      if (!closed) throw new Error("No closing quotation");
      inToken = true;
    } else if (c === "\\") {
      if (i + 1 >= s.length) throw new Error("No escaped character");
      token += s[i + 1];
      inToken = true;
      i += 2;
    } else if (/\s/.test(c)) {
      if (inToken) tokens.push(token);
      token = "";
      inToken = false;
      i++;
    } else {
      token += c;
      inToken = true;
      i++;
    }
  }
  if (inToken) tokens.push(token);
  return tokens;
}

/** `template.format(**subs)` for plain `{name}` fields and `{{`/`}}` escapes. */
export function _formatTemplate(template: string, subs: Record<string, string>): string {
  return template.replace(/\{\{|\}\}|\{([^{}]*)\}/g, (match, key: string | undefined) => {
    if (match === "{{") return "{";
    if (match === "}}") return "}";
    if (key === undefined || !(key in subs)) throw new Error(`KeyError: ${pyStrRepr(key ?? "")}`);
    return subs[key]!;
  });
}

// ---------------------------------------------------------------------------
// Subprocesses (asyncio.subprocess.Process)
// ---------------------------------------------------------------------------

export interface _ProcessSpawnOptions {
  /** Working directory, or the current one. */
  cwd?: string | null;
  /** A file to send stdout and stderr to (truncated), or inherit the parent's. */
  outputPath?: string | null;
}

/**
 * A spawned subprocess, as asyncio's `Process`: `returncode` is `null` while it
 * runs, its exit code once it exits, or minus the signal number that killed it.
 */
export class _Process {
  readonly pid: number | undefined;
  returncode: number | null = null;
  readonly #child: import("node:child_process").ChildProcess;
  readonly #exited = new Future<number>();

  private constructor(
    child: import("node:child_process").ChildProcess,
    signals: Record<string, number>,
  ) {
    this.#child = child;
    this.pid = child.pid;
    child.on("exit", (code, signal) => {
      this.returncode = code ?? -(signal ? (signals[signal] ?? 1) : 1);
      if (!this.#exited.done()) this.#exited.setResult(this.returncode);
    });
  }

  /**
   * Start `argv` (`asyncio.create_subprocess_exec`). Rejects, as Python raises,
   * when the program can't be started.
   */
  static async spawn(argv: string[], options: _ProcessSpawnOptions = {}): Promise<_Process> {
    const { spawn } = await import("node:child_process");
    const { constants } = await import("node:os");
    const fs = await import("node:fs/promises");
    const [command, ...args] = argv;
    if (command === undefined) throw new Error("empty command");
    const out = options.outputPath ? await fs.open(options.outputPath, "w") : null;
    try {
      const child = spawn(command, args, {
        cwd: options.cwd ?? undefined,
        stdio: out ? ["ignore", out.fd, out.fd] : ["ignore", "inherit", "inherit"],
      });
      const proc = new _Process(child, constants.signals as Record<string, number>);
      const started = new Future<void>();
      child.once("spawn", () => {
        if (!started.done()) started.setResult(undefined);
      });
      child.once("error", (e) => {
        if (!started.done()) started.setException(e);
      });
      await started;
      return proc;
    } finally {
      await out?.close();
    }
  }

  /** Wait for the process to exit; its return code. */
  async wait(): Promise<number> {
    return await this.#exited;
  }

  /** Ask the process to stop (SIGTERM). */
  terminate(): void {
    if (this.returncode === null) this.#child.kill("SIGTERM");
  }

  /** Kill the process (SIGKILL). */
  kill(): void {
    if (this.returncode === null) this.#child.kill("SIGKILL");
  }
}

// ---------------------------------------------------------------------------
// results.jsonl records and the worker's JSON
// ---------------------------------------------------------------------------

/**
 * Append one JSON line describing a finished run, flushed at once.
 *
 * The record carries enough to compute pass rates and group failures by kind,
 * plus paths to the artifacts. `events_seen` is included only for runs that
 * did not pass, since that is what a failure is diagnosed from.
 */
export async function _appendResult(
  resultsPath: string,
  run: EvalRun,
  stem: string,
  logsDir: string,
  recordDir: string | null,
): Promise<void> {
  const artifacts: Record<string, string> = { log: nodePath.join(logsDir, `${stem}.log`) };
  for (const [suffix, key] of [
    [".eval.log", "eval_log"],
    [".debug.log", "debug_log"],
    [".conversation.json", "conversation"],
  ] as const) {
    const path = nodePath.join(logsDir, `${stem}${suffix}`);
    if (await _exists(path)) artifacts[key] = path;
  }
  if (recordDir !== null && (await _exists(nodePath.join(recordDir, `${stem}.wav`)))) {
    artifacts.recording = nodePath.join(recordDir, `${stem}.wav`);
  }
  const record =
    run.kind === EvalKind.SIMULATION
      ? _simulationRecord(run, artifacts)
      : _scenarioRecord(run, artifacts);

  const fs = await import("node:fs/promises");
  await _suppressOSError(() => fs.appendFile(resultsPath, `${pyJsonDumps(record)}\n`));
}

/** The results.jsonl record of a scenario run. */
export function _scenarioRecord(
  run: EvalRun,
  artifacts: Record<string, string>,
): Record<string, unknown> {
  const result = run.result instanceof EvalScriptResult ? run.result : null;
  const record: Record<string, unknown> = {
    bot: run.bot,
    name: run.label,
    scenario: run.scenario,
    kind: run.kind,
    attempt: run.attempt,
    passed: Boolean(result?.passed && !result.skipped),
    skipped: result ? result.skipped : null,
    error: run.error,
    duration_ms: run.durationMs,
    failures: (result ? result.failures : []).map((f) => ({
      turn_index: f.turnIndex,
      expectation_index: f.expectationIndex,
      event_name: f.eventName,
      kind: f.kind,
      reason: f.reason,
    })),
    turns: (result ? result.turns : []).map((t) => ({
      turn_index: t.turnIndex,
      status: t.status,
      duration_ms: t.durationMs,
      expectations: t.expectations.map((e) => ({
        expectation_index: e.expectationIndex,
        event_name: e.eventName,
        passed: e.passed,
        matched: e.matched,
      })),
    })),
    artifacts,
  };
  if (result !== null && !record.passed) {
    record.events_seen = result.eventsSeen;
  }
  return record;
}

/**
 * The results.jsonl record of a simulation run: how it ended, what the judge
 * said and on what wording, each metric's score, the conversation, and for a
 * failed run the bot's events.
 */
export function _simulationRecord(
  run: EvalRun,
  artifacts: Record<string, string>,
): Record<string, unknown> {
  const result = run.result instanceof EvalSimulationResult ? run.result : null;
  const record: Record<string, unknown> = {
    bot: run.bot,
    name: run.label,
    scenario: run.scenario,
    kind: run.kind,
    attempt: run.attempt,
    success: result ? result.success : "",
    passed: Boolean(result?.passed),
    succeeded: Boolean(result?.succeeded),
    error: run.error || (result ? result.error : null),
    confidence: result ? result.confidence : null,
    probabilities: result ? result.probabilities : {},
    ended_by: result ? result.endedBy : "error",
    turns: result ? result.turns : 0,
    metrics: (result ? result.metrics : []).map((m) => ({
      name: m.name,
      criterion: m.criterion,
      score: m.score,
      passed: m.passed,
      min_score: m.minScore,
      value: m.value,
      reason: m.reason,
      failure_kind: m.failureKind,
      verdicts: m.verdicts.map((v) => ({
        turn: v.turn,
        passed: v.passed,
        verdict: v.verdict,
        confidence: v.confidence,
        probabilities: v.probabilities,
        reason: v.reason,
      })),
    })),
    reason: result ? result.reason : "",
    end_call: result ? result.endCall : null,
    duration_ms: run.durationMs,
    messages: result ? result.messages : [],
    artifacts,
  };
  if (result !== null && !record.passed) {
    record.events_seen = result.eventsSeen;
  }
  return record;
}

type Dict = Record<string, any>;

/** `dataclasses.asdict` of a run's result: the JSON a harness worker writes back. */
export function _resultToDict(result: EvalScriptResult | EvalSimulationResult): Dict {
  return result.toDict();
}

/** Rebuild an `EvalSimulationResult` from the JSON a harness worker writes back. */
export function _simulationResultFromDict(data: Dict): EvalSimulationResult {
  return EvalSimulationResult.fromDict(data);
}

/** Rebuild an `EvalScriptResult` from the JSON a harness worker writes back. */
export function _resultFromDict(data: Dict): EvalScriptResult {
  return EvalScriptResult.fromDict(data);
}

/**
 * `EvalSessionParams.model_dump()`: the params as the worker's config carries them.
 * Only the fields that are set are written; the worker fills in the defaults.
 */
export function _paramsToDict(params: EvalSessionParams | null): Dict {
  if (params === null) return {};
  return {
    connect_timeout_s: params.connectTimeoutS,
    bot_ready_timeout_s: params.botReadyTimeoutS,
    default_timeout_ms: params.defaultTimeoutMs,
    record_path: params.recordPath,
    cache_dir: params.cacheDir,
    use_cache: params.useCache,
  };
}

/** The `EvalSessionParams` options of a config's params (`EvalSessionParams.model_validate`). */
export function _paramsOptionsFromDict(data: Dict): Dict {
  const options: Dict = {};
  const keys: [string, string][] = [
    ["connect_timeout_s", "connectTimeoutS"],
    ["bot_ready_timeout_s", "botReadyTimeoutS"],
    ["default_timeout_ms", "defaultTimeoutMs"],
    ["record_path", "recordPath"],
    ["cache_dir", "cacheDir"],
    ["use_cache", "useCache"],
  ];
  for (const [key, option] of keys) {
    if (data[key] !== undefined) options[option] = data[key];
  }
  return options;
}

/**
 * A manifest entry's display name and file.
 *
 * A name with a YAML suffix is a path relative to the manifest; any other
 * names a file under `defaultDir`, folder allowed (`scripted/greeting`). The
 * display name is the bare stem either way.
 */
export function _resolveScenario(name: string, base: string, defaultDir: string): [string, string] {
  if (SCENARIO_SUFFIXES.some((suffix) => name.endsWith(suffix))) {
    return [_stem(name), nodePath.resolve(base, name)];
  }
  return [nodePath.basename(name), nodePath.resolve(defaultDir, `${name}.yaml`)];
}

// ---------------------------------------------------------------------------
// EvalRun, EvalManifest
// ---------------------------------------------------------------------------

export type EvalRunStatus = "pending" | "running" | "done";

export interface EvalRunOptions {
  bot: string;
  scenario: string;
  scenarioPath: string;
  name?: string | null;
  loaded?: EvalScriptScenario | EvalSimulationScenario | null;
  botPath?: string | null;
  botUrl?: string | null;
  runnerBodyPath?: string | null;
  runnerBody?: Record<string, unknown> | null;
  concurrency?: number | null;
  entry?: number;
  kind?: EvalKind;
  attempts?: number;
  sweep?: boolean;
  attempt?: number;
  status?: EvalRunStatus;
  stopping?: boolean;
  result?: EvalScriptResult | EvalSimulationResult | null;
  error?: string | null;
  startedAt?: number | null;
  durationMs?: number | null;
}

/**
 * Mutable per-(bot, scenario) state, updated in place so a live display can read it.
 *
 * Fields:
 * - `bot`: The manifest's `bot:` path (suite) or the bot URL (run).
 * - `name`: The manifest entry's `name:`, or `null` when it has none; `label`
 *   is what the display, the filters and the results use.
 * - `scenario`: Display name (the scenario or simulation, without `.yaml`).
 * - `scenarioPath`: Path to the scenario or simulation file.
 * - `kind`: `script` or `simulation`.
 * - `attempts`: How many times this (bot, scenario) pair runs: the manifest's
 *   `repeat`, or a simulation's own `runs`. Above 1, each attempt's artifacts
 *   carry its number.
 * - `sweep`: Whether the attempts come from a `repeat` (a measurement) rather
 *   than from a simulation's `runs` (a requirement: every attempt must pass).
 * - `botPath`: The bot to spawn (suite); `null` when connecting to `botUrl`.
 * - `botUrl`: Connect here instead of spawning (used by `pipedog-eval run`).
 * - `runnerBodyPath`: Optional `--runner-body` file for the bot's runner args.
 * - `runnerBody`: The bot's runner-args body given inline, written to a file
 *   for the bot when it is spawned.
 * - `concurrency`: How many runs of this run's entry may be in flight at once,
 *   when its manifest entry says; `null` is as many as the suite runs.
 * - `entry`: The position of the run's entry in the manifest's `suite:` list.
 * - `attempt`: 1-based attempt number when the suite repeats.
 * - `status`: `pending`, `running`, or `done`.
 * - `stopping`: True while the bot is being stopped after the run is done.
 * - `result`: The outcome, once the run is done.
 * - `error`: Spawn/connection error message, if the run failed before producing a result.
 * - `startedAt`: Monotonic start time (seconds), for the live elapsed counter.
 * - `durationMs`: Wall-clock time the run took, in milliseconds.
 * - `loaded`: The scenario, when the run was built from a loaded file; `load()`
 *   returns it, or reads the file when it is `null`.
 */
export class EvalRun {
  bot: string;
  scenario: string;
  scenarioPath: string;
  name: string | null;
  loaded: EvalScriptScenario | EvalSimulationScenario | null;
  botPath: string | null;
  botUrl: string | null;
  runnerBodyPath: string | null;
  runnerBody: Record<string, unknown> | null;
  concurrency: number | null;
  entry: number;
  kind: EvalKind;
  attempts: number;
  sweep: boolean;
  attempt: number;
  status: EvalRunStatus;
  stopping: boolean;
  result: EvalScriptResult | EvalSimulationResult | null;
  error: string | null;
  startedAt: number | null;
  durationMs: number | null;

  constructor(options: EvalRunOptions) {
    this.bot = options.bot;
    this.scenario = options.scenario;
    this.scenarioPath = options.scenarioPath;
    this.name = options.name ?? null;
    this.loaded = options.loaded ?? null;
    this.botPath = options.botPath ?? null;
    this.botUrl = options.botUrl ?? null;
    this.runnerBodyPath = options.runnerBodyPath ?? null;
    this.runnerBody = options.runnerBody ?? null;
    this.concurrency = options.concurrency ?? null;
    this.entry = options.entry ?? 0;
    this.kind = options.kind ?? EvalKind.SCRIPT;
    this.attempts = options.attempts ?? 1;
    this.sweep = options.sweep ?? false;
    this.attempt = options.attempt ?? 1;
    this.status = options.status ?? "pending";
    this.stopping = options.stopping ?? false;
    this.result = options.result ?? null;
    this.error = options.error ?? null;
    this.startedAt = options.startedAt ?? null;
    this.durationMs = options.durationMs ?? null;
  }

  /** The run's label: the entry's `name`, or its `bot` when it has none. */
  get label(): string {
    return this.name || this.bot;
  }

  /** The scenario name as a file name stem: a group entry's `/` becomes `__`. */
  get stem(): string {
    return this.scenario.replaceAll("/", "__");
  }

  /** A copy with `changes` applied (`dataclasses.replace`). */
  replace(changes: Partial<EvalRunOptions>): EvalRun {
    return new EvalRun({ ...this, ...changes });
  }

  /**
   * The run's scenario: as loaded when the run was built, else read from its file.
   *
   * @throws Error If the file is invalid, holds no scenario of this name, or doesn't exist.
   */
  async load(): Promise<EvalScriptScenario | EvalSimulationScenario> {
    let loaded = this.loaded;
    if (loaded === null) {
      const file = await EvalScenarioFile.load(this.scenarioPath);
      loaded = this.loaded = file.get(this.scenario);
    }
    return loaded;
  }
}

/** A manifest entry's `runner_body:`: a file to pass to the bot, or data to write to one. */
interface _RunnerBody {
  path: string | null;
  data: Record<string, unknown> | null;
}

/** A manifest's settings once the command line's overrides are applied. */
interface _ManifestSettings {
  botsDir: string;
  scenariosDir: string;
  runsDir: string | null;
  spawn: string;
  python: string;
  concurrency: number;
  repeat: number;
  repeatGiven: boolean;
  basePort: number;
  record: boolean;
  cacheDir: string | null;
}

export interface EvalManifestOptions {
  /** The (bot, scenario) and (bot, simulation) runs to execute. */
  runs: EvalRun[];
  /** Spawn command template (`{python}`/`{bot}`/`{port}` substituted). */
  spawn: string;
  /** Runtime used to spawn each bot (upstream's interpreter). */
  python: string;
  /** How many runs to execute at once. */
  concurrency: number;
  /** How many times to run each (bot, scenario) pair. */
  repeat: number;
  /** First port to assign; each run gets `basePort + index`. */
  basePort: number;
  /** Base for run output (a `<name>/` subdir is added), or `null`. */
  runsDir: string | null;
  /** Whether to record conversation audio. */
  record: boolean;
  /** Directory for cached synthesized user audio, or `null`. */
  cacheDir: string | null;
}

/** Overrides for `EvalManifest.load`; a value that is not `null`/`undefined` wins. */
export interface EvalManifestLoadOptions {
  /** Override for the manifest's `bots_dir` (bot paths are relative to it). */
  botsDir?: string | null;
  /** Override for the manifest's `scenarios_dir`. */
  scenariosDir?: string | null;
  /** Override for the manifest's `runs_dir` (base for run output). */
  runsDir?: string | null;
  /** Override for the spawn command template. */
  spawn?: string | null;
  /** Override for the runtime used to spawn bots. */
  python?: string | null;
  /** Override for how many runs execute at once. */
  concurrency?: number | null;
  /**
   * Override for how many times each (bot, scenario) pair runs. Set here or in
   * the manifest, it also replaces each simulation's own `runs`, a repeat of 1 included.
   */
  repeat?: number | null;
  /** Override for the first port assigned. */
  basePort?: number | null;
  /** Override for whether to record conversation audio. */
  record?: boolean | null;
  /** Override for the synthesized-audio cache directory. */
  cacheDir?: string | null;
}

/** The running JS runtime (`sys.executable`). */
function _executable(): string {
  return (globalThis as { process?: { execPath?: string } }).process?.execPath ?? "node";
}

/**
 * A parsed eval-suite manifest.
 *
 * `repeat` attempts run attempt-major rather than grouped per bot, so every bot
 * meets the same machine conditions in the same stretch of the sweep. Each run
 * gets port `basePort + index`, so the reserved range widens with `repeat`.
 */
export class EvalManifest {
  runs: EvalRun[];
  spawn: string;
  python: string;
  concurrency: number;
  repeat: number;
  basePort: number;
  runsDir: string | null;
  record: boolean;
  cacheDir: string | null;

  constructor(options: EvalManifestOptions) {
    this.runs = options.runs;
    this.spawn = options.spawn;
    this.python = options.python;
    this.concurrency = options.concurrency;
    this.repeat = options.repeat;
    this.basePort = options.basePort;
    this.runsDir = options.runsDir;
    this.record = options.record;
    this.cacheDir = options.cacheDir;
  }

  /**
   * Parse a manifest YAML into an `EvalManifest`.
   *
   * An option that is not `null` overrides the manifest's value, so the CLI
   * wins. Manifest paths resolve against the manifest's directory, overrides
   * against the working directory.
   *
   * @param path Path to the manifest YAML.
   * @param options Overrides.
   * @returns The parsed `EvalManifest`.
   */
  static async load(path: string, options: EvalManifestLoadOptions = {}): Promise<EvalManifest> {
    const fs = await import("node:fs/promises");
    const resolved = nodePath.resolve(path);
    const base = nodePath.dirname(resolved);
    const parsed = yamlLoad(await fs.readFile(resolved, "utf8"));
    const data: Dict = _truthy(parsed) ? (parsed as Dict) : {};
    const settings = EvalManifest._settings(data, base, resolved, options);
    return new EvalManifest({
      runs: await EvalManifest._runs(data, base, resolved, settings),
      spawn: settings.spawn,
      python: settings.python,
      concurrency: settings.concurrency,
      repeat: settings.repeat,
      basePort: settings.basePort,
      runsDir: settings.runsDir,
      record: settings.record,
      cacheDir: settings.cacheDir,
    });
  }

  /**
   * The manifest's settings with the overrides applied: an override wins, and
   * its paths resolve against the working directory rather than the manifest's.
   */
  static _settings(
    data: Dict,
    base: string,
    path: string,
    options: EvalManifestLoadOptions,
  ): _ManifestSettings {
    const dirValue = (override: string | null | undefined, key: string, def: string): string => {
      if (override != null) return nodePath.resolve(override);
      return nodePath.resolve(base, String(data[key] ?? def));
    };

    let runsDir: string | null;
    if (options.runsDir != null) {
      runsDir = nodePath.resolve(options.runsDir);
    } else if (_truthy(data.runs_dir)) {
      runsDir = nodePath.resolve(base, String(data.runs_dir));
    } else {
      runsDir = null;
    }
    // A repeat set anywhere, the command line or the manifest, decides every
    // run's attempts, a simulation's included, even when it is 1; absent, a
    // simulation runs as many times as its file says.
    const repeatGiven = options.repeat != null || "repeat" in data;
    const repeat = options.repeat ?? _int(data.repeat ?? 1, path);
    if (repeat < 1) {
      throw new Error(`${path}: 'repeat' must be at least 1`);
    }
    return {
      botsDir: dirValue(options.botsDir, "bots_dir", "."),
      scenariosDir: dirValue(options.scenariosDir, "scenarios_dir", "scenarios"),
      runsDir,
      spawn: options.spawn || String(data.spawn ?? DEFAULT_SPAWN),
      python: options.python || String(_truthy(data.python) ? data.python : _executable()),
      concurrency: options.concurrency ?? _int(data.concurrency ?? DEFAULT_CONCURRENCY, path),
      repeat,
      repeatGiven,
      basePort: options.basePort ?? _int(data.base_port ?? DEFAULT_BASE_PORT, path),
      record: options.record ?? _truthy(data.record ?? false),
      cacheDir: options.cacheDir ?? (data.cache_dir == null ? null : String(data.cache_dir)),
    };
  }

  /**
   * The runs the `suite:` list describes, one per bot, scenario, and attempt.
   *
   * The scenario file says which kind it is. A simulation runs as many times
   * as its file says unless a repeat makes the suite a measurement; a file
   * that fails to load still gets its run, which reports the error. Attempts
   * are attempt-major (bot A #1, bot B #1, ..., bot A #2).
   */
  static async _runs(
    data: Dict,
    base: string,
    path: string,
    settings: _ManifestSettings,
  ): Promise<EvalRun[]> {
    let runs: EvalRun[] = [];
    const suite: unknown[] = data.suite ?? [];
    for (const [entry, rawItem] of suite.entries()) {
      const item = rawItem as Dict;
      if (!_isMapping(item) || !("bot" in item)) {
        throw new Error(`${path}: suite entry #${entry} needs a 'bot:'`);
      }
      const bot = String(item.bot);
      const botPath = nodePath.resolve(settings.botsDir, bot);
      const name = item.name ?? null;
      if (name !== null && (typeof name !== "string" || !name.trim())) {
        throw new Error(`${path}: bot ${pyStrRepr(bot)} 'name:' must be a non-empty string`);
      }
      const body = EvalManifest._runnerBody(
        item.runner_body ?? null,
        base,
        `${path}: bot ${pyStrRepr(bot)}`,
      );
      const concurrency = item.concurrency ?? null;
      if (
        concurrency !== null &&
        (typeof concurrency !== "number" || !Number.isInteger(concurrency) || concurrency < 1)
      ) {
        throw new Error(`${path}: bot ${pyStrRepr(bot)} 'concurrency:' must be a positive integer`);
      }
      for (const scenario of (item.scenarios ?? []) as unknown[]) {
        const [fileName, scenarioPath] = _resolveScenario(
          String(scenario),
          base,
          settings.scenariosDir,
        );
        // A file that fails to load still gets a run, under the
        // manifest's name for it, so the failure is reported.
        let named: [string, EvalScriptScenario | EvalSimulationScenario | null][];
        try {
          const file = await EvalScenarioFile.load(scenarioPath);
          named = file.scenarios.map((one) => [one.name, one]);
        } catch (e) {
          rethrowIfCancelled(e);
          named = [[fileName, null]];
        }
        for (const [runName, one] of named) {
          let kind: EvalKind = EvalKind.SCRIPT;
          let attempts = settings.repeat;
          if (one instanceof EvalSimulationScenario) {
            kind = EvalKind.SIMULATION;
            attempts = settings.repeatGiven ? settings.repeat : one.runs;
          }
          runs.push(
            new EvalRun({
              bot,
              name,
              scenario: runName,
              loaded: one,
              botPath,
              scenarioPath,
              runnerBodyPath: body.path,
              runnerBody: body.data,
              concurrency,
              entry,
              kind,
              attempts,
              sweep: settings.repeatGiven,
            }),
          );
        }
      }
    }
    const seen = new Set<string>();
    for (const run of runs) {
      const key = JSON.stringify([run.label, run.scenario]);
      if (seen.has(key)) {
        throw new Error(
          `${path}: ${pyStrRepr(run.label)} runs ${pyStrRepr(run.scenario)} twice; give one of the ` +
            "entries a 'name:'",
        );
      }
      seen.add(key);
    }
    const most = Math.max(1, ...runs.map((run) => run.attempts));
    if (most > 1) {
      const repeated: EvalRun[] = [];
      for (let n = 1; n <= most; n++) {
        for (const run of runs) {
          if (n <= run.attempts) repeated.push(run.replace({ attempt: n }));
        }
      }
      runs = repeated;
    }
    return runs;
  }

  /** An entry's `runner_body:` as the bot gets it: a file to pass, or data the suite writes to one. */
  static _runnerBody(spec: unknown, base: string, where: string): _RunnerBody {
    if (spec === null || spec === undefined) {
      return { path: null, data: null };
    }
    const keys = _isMapping(spec) ? Object.keys(spec).sort() : null;
    if (keys === null || keys.length !== 1 || (keys[0] !== "data" && keys[0] !== "path")) {
      throw new Error(`${where} 'runner_body:' must hold one of 'path:' or 'data:'`);
    }
    const body = spec as Dict;
    if ("path" in body) {
      return { path: nodePath.resolve(base, String(body.path)), data: null };
    }
    if (!_isMapping(body.data)) {
      throw new Error(`${where} 'runner_body:' 'data:' must be a mapping`);
    }
    return { path: null, data: body.data };
  }
}

// ---------------------------------------------------------------------------
// The run queue
// ---------------------------------------------------------------------------

/** One entry's runs for one attempt: the entry, its cap, and the runs. */
export type _EntryQueue = [entry: number, cap: number | null, queue: EvalRun[]];

/**
 * The suite's runs, handed out to workers in manifest order.
 *
 * Each queue is one entry's runs for one attempt, in the order the entries
 * were given. A worker takes the next run from the first queue whose entry is
 * under its cap; when every queue with runs left is at its cap, it waits for a
 * run to finish.
 */
export class _RunQueue {
  readonly #queues: _EntryQueue[];
  readonly #inFlight = new Map<number, number>();
  // asyncio.Condition: the waiters notify_all wakes.
  #waiters: Future<void>[] = [];

  /**
   * @param queues Each entry's runs per attempt, with the entry's position and
   *   its cap on runs in flight, `null` for no cap.
   */
  constructor(queues: _EntryQueue[]) {
    this.#queues = queues;
    for (const [entry] of queues) this.#inFlight.set(entry, 0);
  }

  /** The next run to make, or `null` when none is left. */
  async take(): Promise<EvalRun | null> {
    while (this.#queues.some(([, , queue]) => queue.length > 0)) {
      const run = this.#pick();
      if (run !== null) return run;
      const waiter = new Future<void>();
      this.#waiters.push(waiter);
      try {
        await waiter;
      } finally {
        this.#waiters = this.#waiters.filter((w) => w !== waiter);
      }
    }
    return null;
  }

  /** Count the run as finished, so its entry may take another. */
  async done(run: EvalRun): Promise<void> {
    this.#inFlight.set(run.entry, (this.#inFlight.get(run.entry) ?? 0) - 1);
    for (const waiter of this.#waiters) {
      if (!waiter.done()) waiter.setResult(undefined);
    }
  }

  /** The first queued run whose entry is under its cap. */
  #pick(): EvalRun | null {
    for (const [entry, cap, queue] of this.#queues) {
      const inFlight = this.#inFlight.get(entry) ?? 0;
      if (queue.length > 0 && (cap === null || inFlight < cap)) {
        this.#inFlight.set(entry, inFlight + 1);
        return queue.shift()!;
      }
    }
    return null;
  }
}

/**
 * What one `EvalSuite.run` call sets up for every run it makes.
 *
 * - `ports`: The port assigned to each run.
 * - `logsDir`: Directory for per-run logs.
 * - `recordDir`: Directory for per-run conversation recordings, or `null`.
 * - `resultsPath`: JSONL file to append one record per finished run to, or `null`.
 * - `debug`: Whether each run saves its combined `<run>.debug.log`.
 * - `params`: How each run behaves; `null` for the defaults.
 */
export interface _SuiteRunSetup {
  ports: Map<EvalRun, number>;
  logsDir: string;
  recordDir: string | null;
  resultsPath: string | null;
  debug: boolean;
  params: EvalSessionParams | null;
}

/**
 * Where one run's artifacts go, all named by the run's prefix.
 *
 * - `prefix`: `<bot>__<scenario>`, with the attempt number when the run repeats.
 * - `log`: The bot's output.
 * - `harnessLog`: The harness worker's output, kept only when it crashed.
 * - `trace`: The harness's decision trace, `<prefix>.eval.log`.
 * - `conversation`: A simulation's conversation, `<prefix>.conversation.json`.
 * - `config`: The worker's config, the handoff in.
 * - `result`: The worker's result, the handoff out.
 * - `body`: The bot's runner-args body, written when the manifest gives it inline.
 * - `record`: The conversation recording, or `null` when not recording.
 */
export class _RunFiles {
  readonly prefix: string;
  readonly log: string;
  readonly harnessLog: string;
  readonly trace: string;
  readonly conversation: string;
  readonly config: string;
  readonly result: string;
  readonly body: string;
  readonly record: string | null;

  constructor(options: {
    prefix: string;
    log: string;
    harnessLog: string;
    trace: string;
    conversation: string;
    config: string;
    result: string;
    body: string;
    record: string | null;
  }) {
    this.prefix = options.prefix;
    this.log = options.log;
    this.harnessLog = options.harnessLog;
    this.trace = options.trace;
    this.conversation = options.conversation;
    this.config = options.config;
    this.result = options.result;
    this.body = options.body;
    this.record = options.record;
  }

  /**
   * The files of `run` under `logsDir` and `recordDir`.
   *
   * The bot is part of the prefix because one bot can run several scenarios at
   * once, and the run's name joins it when the entry has one of its own; the
   * attempt number joins it when the suite repeats, so no attempt writes over
   * another's artifacts.
   */
  static forRun(run: EvalRun, logsDir: string, recordDir: string | null): _RunFiles {
    let prefix = run.bot.replaceAll("/", "_");
    if (run.name !== null) {
      prefix += `__${run.name.replaceAll("/", "_")}`;
    }
    prefix += `__${run.stem}`;
    if (run.attempts > 1) {
      prefix += `__${String(run.attempt).padStart(3, "0")}`;
    }
    const at = (suffix: string) => nodePath.join(logsDir, `${prefix}${suffix}`);
    return new _RunFiles({
      prefix,
      log: at(".log"),
      harnessLog: at(".harness.log"),
      trace: at(".eval.log"),
      conversation: at(".conversation.json"),
      config: at(".config.json"),
      result: at(".result.json"),
      body: at(".body.json"),
      record: recordDir ? nodePath.join(recordDir, `${prefix}.wav`) : null,
    });
  }
}

/** The `_session_subprocess` module next to this one, with this module's extension (.ts in the repo, .js when built). */
function _sessionSubprocessPath(): string {
  const here = new URL(import.meta.url);
  const ext = nodePath.extname(here.pathname) || ".js";
  return decodeURIComponent(new URL(`./_session_subprocess${ext}`, here).pathname);
}

export interface EvalSuiteRunOptions {
  /** Directory for per-run conversation recordings, or `null`. */
  recordDir?: string | null;
  /**
   * JSONL file to append one record per finished run, or `null` to write none.
   * Each line is written as its run completes, so an interrupted sweep keeps
   * everything already finished.
   */
  resultsPath?: string | null;
  /** When true, save each run's combined `<run>.debug.log`. */
  debug?: boolean;
  /**
   * How each run behaves; `null` for the defaults. The suite sets what it owns
   * on each run's copy: the connect timeout, the recording, the manifest's
   * cache directory, and stopping the bot it spawned.
   */
  params?: EvalSessionParams | null;
}

/**
 * Runs the (bot, scenario) runs of an `EvalManifest`, spawning each bot.
 *
 * Each bot gets its eval transport on its own port and is driven by the
 * harness in a subprocess, several at a time up to the manifest's
 * `concurrency`. The runs are updated in place as they go, so a live display
 * can read their progress.
 *
 * Event handlers available:
 *
 * - on_update: Called with an `EvalRun` whenever that run changes status.
 *   Runs are mutated in place, so handlers run synchronously and must return
 *   promptly.
 *
 * @example
 * const manifest = await EvalManifest.load("manifest.yaml");
 * const suite = new EvalSuite(manifest);
 * suite.filter({ pattern: "voice" });
 * suite.eventHandler("on_update", (suite, run) => console.log(run.scenario, run.status));
 * await suite.run("logs");
 */
export class EvalSuite extends BaseObject {
  manifest: EvalManifest;
  runs: EvalRun[];

  /**
   * @param manifest The parsed `EvalManifest`; its runs become the suite's
   *   working set (narrowed by `filter`, executed by `run`).
   */
  constructor(manifest: EvalManifest) {
    super();

    this.manifest = manifest;
    this.runs = [...manifest.runs];

    // Synchronous: an EvalRun is mutated in place as it executes, so a handler
    // deferred to a task would read whatever the run has since become. A run
    // that fails before it spawns reaches "done" with no await in between.
    this._registerEventHandler("on_update", true);
  }

  /**
   * Keep only the runs matching a bot substring, a scenario name, and/or a kind.
   *
   * @param options.pattern Keep only runs whose name or bot path contains this substring.
   * @param options.scenario Keep only runs of this scenario: its full
   *   `<file>/<scenario>` name, or either half of it.
   * @param options.kind Keep only runs of this kind.
   * @returns The matching runs, in their original order.
   */
  filter(
    options: { pattern?: string | null; scenario?: string | null; kind?: EvalKind | null } = {},
  ): EvalRun[] {
    const { pattern, scenario, kind } = options;
    let runs = this.runs;
    if (pattern) {
      runs = runs.filter((r) => r.label.includes(pattern) || r.bot.includes(pattern));
    }
    if (scenario) {
      runs = runs.filter((r) => [r.scenario, ...r.scenario.split("/")].includes(scenario));
    }
    if (kind) {
      runs = runs.filter((r) => r.kind === kind);
    }
    this.runs = runs;
    return runs;
  }

  /**
   * Run all of the suite's runs, in place, with the manifest's concurrency.
   *
   * Each run gets its own port (`basePort + index`). `concurrency` workers each
   * take the next run and run it until none is left. Runs are taken in
   * manifest order, every entry's first attempt before any entry's second. An
   * entry with a `concurrency:` of its own never has more than that many runs
   * in flight, across its attempts.
   *
   * DIVERGENCE: upstream removes every loguru sink here to keep stdout clean for
   * the caller's display; pipedog leaves the logger alone (the CLI silences it
   * itself), so a library caller keeps its logging.
   *
   * @param logsDir Directory for per-run logs.
   */
  async run(logsDir: string, options: EvalSuiteRunOptions = {}): Promise<void> {
    const fs = await import("node:fs/promises");
    const recordDir = options.recordDir ?? null;
    const resultsPath = options.resultsPath ?? null;
    await fs.mkdir(logsDir, { recursive: true });
    if (recordDir) {
      await fs.mkdir(recordDir, { recursive: true });
    }
    if (resultsPath !== null) {
      await fs.mkdir(nodePath.dirname(resultsPath), { recursive: true });
    }
    await this._boundCpuThreads();
    const setup: _SuiteRunSetup = {
      ports: new Map(this.runs.map((run, i) => [run, this.manifest.basePort + i])),
      logsDir,
      recordDir,
      resultsPath,
      debug: options.debug ?? false,
      params: options.params ?? null,
    };
    const queue = new _RunQueue(EvalSuite._entryQueues(this.runs));
    const workers = Math.min(this.manifest.concurrency, this.runs.length);
    await gather(...Array.from({ length: workers }, () => () => this._runWorker(queue, setup)));
  }

  /** Take runs from the queue and run them, one after another, until none is left. */
  async _runWorker(queue: _RunQueue, setup: _SuiteRunSetup): Promise<void> {
    for (let run = await queue.take(); run !== null; run = await queue.take()) {
      try {
        await this._runOne(run, setup);
      } finally {
        await queue.done(run);
      }
    }
  }

  /** Spawn one bot, run its scenario against it, and record the outcome on `run`. */
  async _runOne(run: EvalRun, setup: _SuiteRunSetup): Promise<void> {
    const port = setup.ports.get(run)!;
    const files = _RunFiles.forRun(run, setup.logsDir, setup.recordDir);
    run.status = "running";
    run.startedAt = monotonic();
    await this._callEventHandler("on_update", run);
    let bot: _Process | null = null;
    let worker: _Process | null = null;
    try {
      run.error = await this._missingFile(run);
      if (run.error !== null) {
        return;
      }
      bot = await this._spawnBot(run, port, files);
      worker = await this._runHarness(run, port, files, {
        debug: setup.debug,
        params: setup.params,
      });
    } catch (e) {
      rethrowIfCancelled(e);
      // The worker reports its own failures in its result; this is a
      // problem on the suite's side (spawning, reading the result back).
      run.error = `error: ${_errorTypeName(e)}: ${_errorMessage(e)}`;
      const fs = await import("node:fs/promises");
      await _suppressOSError(() =>
        fs.writeFile(files.trace, e instanceof Error ? (e.stack ?? String(e)) : String(e)),
      );
    } finally {
      await this._finish(
        run,
        files,
        bot,
        worker,
        setup.resultsPath,
        setup.logsDir,
        setup.recordDir,
      );
    }
  }

  /**
   * One queue per entry and attempt, attempt-major then in manifest order, with
   * the entry and its cap. A queue keeps its runs in manifest order. An entry's
   * cap is its `concurrency:`, `null` when it sets none, and it covers all of
   * its attempts.
   */
  static _entryQueues(runs: EvalRun[]): _EntryQueue[] {
    const queues = new Map<string, { attempt: number; entry: number; runs: EvalRun[] }>();
    const caps = new Map<number, number | null>();
    for (const run of runs) {
      const key = `${run.attempt},${run.entry}`;
      let queue = queues.get(key);
      if (queue === undefined) {
        queue = { attempt: run.attempt, entry: run.entry, runs: [] };
        queues.set(key, queue);
      }
      queue.runs.push(run);
      caps.set(run.entry, run.concurrency);
    }
    // A stable sort on the attempt alone, as upstream's sorted(key=attempt).
    return [...queues.values()]
      .sort((a, b) => a.attempt - b.attempt)
      .map(({ entry, runs }) => [entry, caps.get(entry) ?? null, runs]);
  }

  /** Why the run cannot start, when one of its files is missing. */
  async _missingFile(run: EvalRun): Promise<string | null> {
    if (run.botPath === null || !(await _exists(run.botPath))) {
      return `bot not found: ${run.botPath === null ? "None" : run.botPath}`;
    }
    if (!(await _exists(run.scenarioPath))) {
      return `${run.kind} not found: ${run.scenarioPath}`;
    }
    if (run.runnerBodyPath !== null && !(await _exists(run.runnerBodyPath))) {
      return `body not found: ${run.runnerBodyPath}`;
    }
    return null;
  }

  /**
   * Start the bot with its eval transport on `port`, its output going to the bot log.
   *
   * A body file's directory is the bot's working directory, so relative paths
   * inside the body (an image) resolve next to the file. A body given inline
   * is written to the run's body file first.
   */
  async _spawnBot(run: EvalRun, port: number, files: _RunFiles): Promise<_Process | null> {
    if (run.botPath === null) throw new Error("the run has no bot to spawn");
    const cwd = run.runnerBodyPath ? nodePath.dirname(run.runnerBodyPath) : null;
    let bodyPath = run.runnerBodyPath;
    if (run.runnerBody !== null) {
      bodyPath = files.body;
      const fs = await import("node:fs/promises");
      await fs.writeFile(bodyPath, pyJsonDumps(run.runnerBody));
    }
    return await _Process.spawn(this._spawnArgv(run.botPath, port, bodyPath), {
      cwd,
      outputPath: files.log,
    });
  }

  /**
   * Run the harness worker for this run and read its result back onto `run`.
   *
   * The worker gets its config as a file and writes its result as one; a
   * worker that times out or exits without a result leaves `run.error`.
   *
   * DIVERGENCE: upstream runs `python -m pipecat.evals._session_subprocess`;
   * here the running runtime (`process.execPath`, with its `execArgv`) runs
   * `_session_subprocess.ts` (or `.js` when built) next to this module.
   */
  async _runHarness(
    run: EvalRun,
    port: number,
    files: _RunFiles,
    options: { debug: boolean; params: EvalSessionParams | null },
  ): Promise<_Process | null> {
    const fs = await import("node:fs/promises");
    const runParams = {
      ..._paramsToDict(options.params),
      connect_timeout_s: BOT_CONNECT_TIMEOUT_S,
      record_path: files.record,
      cache_dir: this.manifest.cacheDir,
    };
    const config = {
      scenario_path: run.scenarioPath,
      scenario_name: run.scenario,
      bot_url: `ws://localhost:${port}/ws`,
      params: runParams,
      debug: options.debug,
      logs_dir: nodePath.dirname(files.log),
      prefix: files.prefix,
      result_path: files.result,
    };
    await fs.writeFile(files.config, pyJsonDumps(config));
    await _suppressOSError(() => fs.unlink(files.result));
    const proc = (globalThis as { process?: { execArgv?: string[] } }).process;
    const worker = await _Process.spawn(
      [_executable(), ...(proc?.execArgv ?? []), _sessionSubprocessPath(), files.config],
      { outputPath: files.harnessLog },
    );
    try {
      await waitFor(() => worker.wait(), WORKER_SAFETY_TIMEOUT_S);
    } catch (e) {
      if (!(e instanceof TimeoutError)) throw e;
      worker.kill();
      await worker.wait();
      run.error = `error: harness worker timed out after ${WORKER_SAFETY_TIMEOUT_S.toFixed(0)}s`;
      return worker;
    }
    if (worker.returncode !== 0 || !(await _exists(files.result))) {
      // The worker crashed before writing a result; its stack is in the harness log.
      run.error = `error: harness worker exited ${worker.returncode} (see ${files.prefix}.harness.log)`;
      return worker;
    }
    const { pyJsonLoads } = await import("@pipedog/core/utils/py_json");
    const data = pyJsonLoads(await fs.readFile(files.result, "utf8")) as Dict;
    if (run.kind === EvalKind.SIMULATION) {
      run.result = _simulationResultFromDict(data);
    } else {
      run.result = _resultFromDict(data);
    }
    return worker;
  }

  /** Mark the run done, stop what is still running, and keep only the real artifacts. */
  async _finish(
    run: EvalRun,
    files: _RunFiles,
    bot: _Process | null,
    worker: _Process | null,
    resultsPath: string | null,
    logsDir: string,
    recordDir: string | null,
  ): Promise<void> {
    const fs = await import("node:fs/promises");
    // The duration is measured the way the live counter ticks, and excludes the teardown.
    if (run.startedAt !== null) {
      run.durationMs = Math.trunc((monotonic() - run.startedAt) * 1000);
    }
    run.status = "done";
    await this._callEventHandler("on_update", run);
    run.stopping = true;
    // A cancelled suite (Ctrl+C) may leave the worker running; it must not outlive the suite.
    if (worker !== null && worker.returncode === null) {
      worker.kill();
      await worker.wait();
    }
    if (bot !== null) {
      await EvalSuite._stopBot(bot);
    }
    run.stopping = false;
    // The worker's output is only the import banner on success; it is kept
    // when no result came back, since it then holds the stack trace.
    if (run.result !== null) {
      await _suppressOSError(() => fs.unlink(files.harnessLog));
    }
    for (const handoff of [files.config, files.result]) {
      await _suppressOSError(() => fs.unlink(handoff));
    }
    if (run.result?.debugLog.length) {
      await fs.writeFile(files.trace, `${run.result.debugLog.join("\n")}\n`);
    }
    if (run.result instanceof EvalSimulationResult) {
      await fs.writeFile(files.conversation, `${_pyJsonDumpsIndent(run.result.conversation)}\n`);
    }
    if (resultsPath !== null) {
      await _appendResult(resultsPath, run, files.prefix, logsDir, recordDir);
    }
  }

  /**
   * Cap each model's OpenMP threads to cores / concurrency, so concurrent
   * transcriptions share the cores. An explicit setting in the environment wins.
   */
  async _boundCpuThreads(): Promise<void> {
    const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
      ?.env;
    if (env === undefined || env.OMP_NUM_THREADS !== undefined) return;
    const os = await import("node:os");
    const cores = os.availableParallelism?.() ?? os.cpus().length ?? 1;
    env.OMP_NUM_THREADS = String(
      Math.max(1, Math.floor(cores / Math.max(1, this.manifest.concurrency))),
    );
  }

  /**
   * The spawn argv, with `{python}`, `{bot}`, and `{port}` substituted per
   * token so a path with spaces stays one entry.
   */
  _spawnArgv(botPath: string, port: number, runnerBodyPath: string | null = null): string[] {
    const subs = { python: this.manifest.python, bot: botPath, port: String(port) };
    const argv = _shlexSplit(this.manifest.spawn).map((tok) => _formatTemplate(tok, subs));
    if (runnerBodyPath !== null) {
      argv.push("--runner-body", runnerBodyPath);
    }
    return argv;
  }

  /**
   * Terminate the bot, and kill it if it lingers.
   *
   * The bot's session ended with the harness's connection, but the dev runner
   * serving it keeps running until it is told to stop.
   */
  static async _stopBot(proc: _Process): Promise<void> {
    if (proc.returncode !== null) {
      return;
    }
    proc.terminate();
    try {
      await waitFor(() => proc.wait(), BOT_STOP_TIMEOUT_S);
    } catch (e) {
      if (!(e instanceof TimeoutError)) throw e;
      proc.kill();
      await proc.wait();
    }
  }
}
