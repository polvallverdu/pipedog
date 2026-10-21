// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/cli/commands/eval.py

/**
 * `pipedog-eval` commands (upstream: `pipecat eval`).
 *
 * Thin CLI wrappers over the evals modules — all the load/run logic lives
 * there. Reachable as the `pipedog-eval` bin (see `__main__.ts`).
 *
 * DIVERGENCE: upstream is a typer app with a rich live dashboard. Here the
 * arguments are parsed with `node:util`'s `parseArgs`, and the dashboard is
 * plain ANSI: the same table, redrawn in place while stdout is a terminal,
 * and streamed result lines otherwise. The deprecated `run` flags
 * `--stop-bot` and `--trigger-disconnect` are not ported.
 */

import * as nodePath from "node:path";
import { parseArgs } from "node:util";
import {
  createTask,
  gather,
  gatherSettled,
  monotonic,
  rethrowIfCancelled,
  Semaphore,
  sleep,
  type Task,
} from "@pipedog/asyncio";
import { logger } from "@pipedog/core/utils/logger";
import { pyJsonDumps, pyJsonLoads } from "@pipedog/core/utils/py_json";
import {
  type EvalProgress,
  EvalScriptResult,
  type EvalScriptTurnProgress,
  EvalSimulationProgress,
  EvalSimulationResult,
} from "./results.ts";
import {
  describeConfig,
  describeSimulation,
  EvalKind,
  EvalScenarioFile,
  EvalSimulationScenario,
  isScenarioFile,
} from "./scenario.ts";
import type { EvalSessionParams } from "./session.ts";
import {
  _errorMessage,
  _errorTypeName,
  _pyJsonDumpsIndent,
  capturePipelineLogs,
  EvalManifest,
  EvalRun,
  EvalSuite,
  SCENARIO_SUFFIXES,
} from "./suite.ts";

type Dict = Record<string, any>;

// ---------------------------------------------------------------------------
// Errors and exits (typer.BadParameter / typer.Exit)
// ---------------------------------------------------------------------------

/** A bad command-line value (typer's `BadParameter`): printed with the usage, exit code 2. */
export class BadParameter extends Error {
  readonly paramHint: string | null;

  constructor(message: string, paramHint: string | null = null) {
    super(message);
    this.name = "BadParameter";
    this.paramHint = paramHint;
  }
}

// ---------------------------------------------------------------------------
// Terminal
// ---------------------------------------------------------------------------

function _stdout(): {
  isTTY?: boolean;
  columns?: number;
  rows?: number;
  write(s: string): unknown;
} {
  return process.stdout;
}

function _isTerminal(): boolean {
  return Boolean(_stdout().isTTY);
}

/** Columns of clearance to keep between a truncated detail and the terminal edge. */
const _DETAIL_RIGHT_MARGIN = 12;

function _terminalWidth(): number {
  return _stdout().columns || 80;
}

function _terminalHeight(): number {
  return _stdout().rows || 24;
}

function print(...parts: string[]): void {
  _stdout().write(`${parts.join(" ")}\n`);
}

/**
 * Collapse detail to a single line and truncate to fit the terminal.
 *
 * `usedCols` is what the line already spends on indent + badge + event name +
 * separator. The result ends well before the terminal edge.
 */
function _fitDetail(detail: string, usedCols: number): string {
  const avail = Math.max(20, _terminalWidth() - usedCols - _DETAIL_RIGHT_MARGIN);
  let oneLine = detail.split(/\s+/).filter(Boolean).join(" ");
  if (oneLine.length > avail) {
    oneLine = `${oneLine.slice(0, avail - 1).trimEnd()}…`;
  }
  return oneLine;
}

/**
 * Detail text for a resolved expectation. Matched prose (the bot's output) is
 * quoted to set it apart from failure reasons; a matched `function_call`
 * signature and failure reasons are left as-is.
 */
function _formatDetail(p: EvalScriptTurnProgress): string {
  if (p.status === "matched" && p.eventName !== "function_call") {
    return `"${p.detail}"`;
  }
  return p.detail;
}

function _supportsColor(): boolean {
  return _isTerminal();
}

function _color(text: string, code: string): string {
  if (!_supportsColor()) return text;
  return `\x1b[${code}m${text}\x1b[0m`;
}

const _green = (s: string) => _color(s, "32");
const _red = (s: string) => _color(s, "31");
const _dim = (s: string) => _color(s, "2");
const _bold = (s: string) => _color(s, "1");

/** The speakers in a simulation's conversation: the bot green, the persona cyan. */
const _SPEAKER_COLOR: Record<string, string> = { bot: "32", user: "36" };
/** How a simulation ended: the persona hanging up green, the bot yellow, a cap red. */
const _ENDING_COLOR: Record<string, string> = { end_call: "32", bot: "33" };

/**
 * Print a progress record as it arrives (verbose mode): a scripted scenario's
 * per-turn and per-expectation lines, or a simulation's conversation as it is
 * spoken and how it ended.
 */
function _printProgress(_session: unknown, p: EvalProgress): void {
  if (p instanceof EvalSimulationProgress) {
    if (p.status === "ended") {
      const ending = _color(p.text, _ENDING_COLOR[p.text] ?? "31");
      print();
      print(`      ${_dim("ended by")} ${ending} ${_dim(`after ${p.turn} persona turn(s)`)}`);
    } else {
      print(`      ${_color(`${p.status}:`, _SPEAKER_COLOR[p.status] ?? "0")} ${p.text}`);
    }
  } else if (p.status === "turn") {
    const label = p.eventName ? `"${p.eventName}"` : "(observe)";
    print(`      ${_dim(`turn ${p.turnIndex}`)} → ${label}`);
  } else {
    const badge = p.status === "matched" ? _green("✓") : _red("✗");
    let line = `        ${badge} ${p.eventName}`;
    if (p.detail) {
      const detail = _formatDetail(p);
      const used = 8 + 2 + p.eventName.length + 3; // indent + badge + name + " — "
      line += ` ${_dim(`— ${_fitDetail(detail, used)}`)}`;
    }
    print(line);
  }
}

function _fmt2(x: number): string {
  return x.toFixed(2);
}

/**
 * Print a simulation's verdict detail (verbose mode), under the conversation:
 * the judge's reason, each metric's score and reason, and the persona's own
 * claim from its `end_call`.
 */
function _printSimulationDetail(result: EvalSimulationResult): void {
  if (result.error) return;
  // A blank line sets each section apart, and one more before the verdict line.
  print();
  print(`    ${_bold("judge:")} ${result.reason}`);
  if (result.metrics.length) {
    print();
    print(`    ${_bold("metrics:")}`);
    for (const metric of result.metrics) {
      const score = (metric.passed ? _green : _red)(
        metric.score === null ? "unscored" : _fmt2(metric.score),
      );
      const bound = metric.minScore !== null ? ` (min ${_fmt2(metric.minScore)})` : "";
      const failed = metric.verdicts.filter((v) => !v.passed);
      const summary = `${metric.verdicts.length - failed.length}/${metric.verdicts.length} turns`;
      print(
        `      ${_color(`${metric.name}:`, "36")} ${score}${_dim(bound)}` +
          `${_dim(` | ${metric.verdicts.length ? summary : metric.reason}`)}`,
      );
      const botTurns = result.messages
        .filter((m: Dict) => m.role === "assistant")
        .map((m: Dict) => String(m.content));
      for (const verdict of failed) {
        const said = verdict.turn <= botTurns.length ? botTurns[verdict.turn - 1]! : "";
        print(
          `        ${_red("✗")} ${_dim(`turn ${verdict.turn}:`)} ` +
            `${_fitDetail(said, 24)} ${_dim(`— ${verdict.reason}`)}`,
        );
      }
    }
  }
  if (result.endCall !== null) {
    print();
    const claim = result.endCall.success ? _green("succeeded") : _red("gave up");
    print(`    ${_bold("persona:")} ${claim}: ${result.endCall.reason ?? ""}`);
  }
  print();
}

/** Per-scenario recording path under `recordDir`, or null when recording is off. */
function _recordPath(recordDir: string | null, scenarioName: string): string | null {
  if (!recordDir) return null;
  return nodePath.join(recordDir, `${scenarioName}.wav`);
}

/**
 * Expand directory arguments into sorted YAML scenario paths.
 *
 * Both YAML suffixes are taken, matching the scenario names a manifest
 * resolves. The fragments scenarios `!include` (which have no `name:`) are
 * left out; a file given explicitly is always taken.
 */
async function _expandScenarioPaths(paths: string[]): Promise<string[]> {
  const fs = await import("node:fs/promises");
  const expanded: string[] = [];
  for (const path of paths) {
    let isDir = false;
    try {
      isDir = (await fs.stat(path)).isDirectory();
    } catch (e) {
      rethrowIfCancelled(e);
    }
    if (!isDir) {
      expanded.push(path);
      continue;
    }
    const scenarioPaths: string[] = [];
    for (const entry of await fs.readdir(path, { withFileTypes: true })) {
      const scenarioPath = nodePath.join(path, entry.name);
      if (
        SCENARIO_SUFFIXES.includes(
          nodePath.extname(entry.name) as (typeof SCENARIO_SUFFIXES)[number],
        ) &&
        entry.isFile() &&
        (await isScenarioFile(scenarioPath))
      ) {
        scenarioPaths.push(scenarioPath);
      }
    }
    scenarioPaths.sort();
    if (!scenarioPaths.length) {
      throw new BadParameter(`No .yaml or .yml scenario files found in ${path}`);
    }
    expanded.push(...scenarioPaths);
  }
  return expanded;
}

/** `Path(path).stem`. */
function _stem(path: string): string {
  const base = nodePath.basename(path);
  const ext = nodePath.extname(base);
  return ext ? base.slice(0, -ext.length) : base;
}

/**
 * Build an EvalRun per scenario in each file, scripted or a simulation, run against `botUrl`.
 *
 * A file that fails to load becomes an EvalRun already marked done with an
 * error, so it shows in the dashboard and the final tally like any other failure.
 */
async function _buildScenarioRuns(paths: string[], botUrl: string): Promise<EvalRun[]> {
  const runs: EvalRun[] = [];
  for (const path of paths) {
    let file: EvalScenarioFile;
    try {
      file = await EvalScenarioFile.load(path);
    } catch (e) {
      rethrowIfCancelled(e);
      const run = new EvalRun({ bot: botUrl, scenario: _stem(path), scenarioPath: path, botUrl });
      run.status = "done";
      run.error = `failed to load: ${_errorMessage(e)}`;
      runs.push(run);
      continue;
    }
    for (const loaded of file) {
      const kind = loaded instanceof EvalSimulationScenario ? EvalKind.SIMULATION : EvalKind.SCRIPT;
      runs.push(
        new EvalRun({
          bot: botUrl,
          scenario: loaded.name,
          loaded,
          scenarioPath: path,
          botUrl,
          kind,
        }),
      );
    }
  }
  return runs;
}

/** The `EvalSessionParams` options a command builds its params from. */
type _ParamsOptions = Record<string, unknown>;

async function _sessionParams(options: _ParamsOptions): Promise<EvalSessionParams> {
  const { EvalSessionParams } = await import("./session.ts");
  return new EvalSessionParams(options as ConstructorParameters<typeof EvalSessionParams>[0]);
}

interface _ExecuteScenarioOptions {
  audio: boolean;
  recordDir: string;
  params: _ParamsOptions;
  logsDir: string;
  debug: boolean;
  verbose: boolean;
}

/**
 * Run one scenario, scripted or a simulation, against its `botUrl`. Updates `run` in place.
 *
 * The `eval run` counterpart to the suite's `_runOne`: it connects to a fixed
 * URL instead of spawning, always writes the decision trace
 * (`<scenario>.eval.log`), a simulation's `<scenario>.conversation.json`, and,
 * under `--debug`, the combined `<scenario>.debug.log`.
 */
async function _executeScenario(run: EvalRun, options: _ExecuteScenarioOptions): Promise<void> {
  const fs = await import("node:fs/promises");
  run.status = "running";
  run.startedAt = monotonic();
  const url = run.botUrl!; // always set by _buildScenarioRuns
  const logsDir = options.logsDir;
  try {
    const loaded = await run.load();
    const recordPath = options.audio ? _recordPath(options.recordDir, run.stem) : null;
    const { EvalSession } = await import("./session.ts");
    const params = await _sessionParams({ ...options.params, recordPath });
    run.result = await capturePipelineLogs(
      logsDir,
      run.stem,
      { name: run.scenario, enabled: options.debug },
      async () => {
        const session = await EvalSession.fromScenario(loaded, url, { params });
        if (options.verbose) {
          session.addEventHandler("on_progress", _printProgress);
          if (loaded instanceof EvalSimulationScenario) {
            print(`    ${_bold("conversation:")}`);
          }
        }
        return (await session.run()) as EvalScriptResult | EvalSimulationResult;
      },
    );
    await fs.mkdir(logsDir, { recursive: true });
    if (run.result.debugLog.length) {
      await fs.writeFile(
        nodePath.join(logsDir, `${run.stem}.eval.log`),
        `${run.result.debugLog.join("\n")}\n`,
      );
    }
    if (run.result instanceof EvalSimulationResult) {
      await fs.writeFile(
        nodePath.join(logsDir, `${run.stem}.conversation.json`),
        `${_pyJsonDumpsIndent(run.result.conversation)}\n`,
      );
    }
  } catch (e) {
    rethrowIfCancelled(e);
    // Errors raised inside the session's run() are caught there and returned
    // as a structured result; this catches the rest (the file's load, building
    // the judge/persona/speech/transcriber). Keep the exception type and stash
    // the full stack in <scenario>.eval.log, mirroring the suite's behavior.
    run.error = `error: ${_errorTypeName(e)}: ${_errorMessage(e)}`;
    try {
      await fs.mkdir(logsDir, { recursive: true });
      await fs.writeFile(
        nodePath.join(logsDir, `${run.stem}.eval.log`),
        e instanceof Error ? (e.stack ?? String(e)) : String(e),
      );
    } catch (e2) {
      rethrowIfCancelled(e2);
    }
  } finally {
    if (run.startedAt !== null) {
      run.durationMs = Math.trunc((monotonic() - run.startedAt) * 1000);
    }
    run.status = "done";
  }
}

/**
 * Run scenarios sequentially against a fixed bot, with the suite's display.
 *
 * A live dashboard in an interactive terminal; `--verbose` (per-turn lines, a
 * simulation's conversation as it happens, and its verdict detail) or a piped
 * stdout fall back to streamed result lines instead.
 */
async function _runScenariosAll(
  runs: EvalRun[],
  options: Omit<_ExecuteScenarioOptions, "verbose"> & { verbose: boolean; started: number },
): Promise<void> {
  const go = (run: EvalRun, verbose: boolean) => _executeScenario(run, { ...options, verbose });

  if (_isTerminal() && !options.verbose) {
    await new _Live(new _EvalDashboard(runs, options.started)).run(async () => {
      for (const run of runs) {
        if (run.status !== "done") {
          // skip a build-time load error
          await go(run, false);
        }
      }
    });
  } else {
    for (const run of runs) {
      if (run.status !== "done") {
        await go(run, options.verbose);
      }
      // A simulation's detail closes the conversation above it; the verdict
      // line comes last, as a scripted scenario's does after its turns.
      if (options.verbose && run.result instanceof EvalSimulationResult) {
        _printSimulationDetail(run.result);
      }
      _printEvalLine(run);
    }
  }
}

// ---------------------------------------------------------------------------
// `pipedog-eval judge` — judge saved conversations against a simulation.
// ---------------------------------------------------------------------------

/** The simulation in `path` to judge with: the one called `name`, or the file's only one. */
async function _judgedSimulation(
  path: string,
  name: string | null,
): Promise<EvalSimulationScenario> {
  let file: EvalScenarioFile;
  try {
    file = await EvalScenarioFile.load(path);
  } catch (e) {
    rethrowIfCancelled(e);
    throw new BadParameter(_errorMessage(e), "SCENARIO_PATH");
  }
  const simulations = [...file].filter(
    (s): s is EvalSimulationScenario => s instanceof EvalSimulationScenario,
  );
  const names = simulations.map((s) => s.name).join(", ") || "none";
  if (name === null && simulations.length !== 1) {
    throw new BadParameter(`pick one of the file's simulations: ${names}`, "-s");
  }
  const matches = simulations.filter(
    (s) => name === null || s.name === name || s.name === `${file.name}/${name}`,
  );
  if (!matches.length) {
    throw new BadParameter(`no simulation '${name}'; the file has: ${names}`, "-s");
  }
  return matches[0]!;
}

/**
 * Judge one conversation file, with a judge of its own that explains every verdict.
 * A file that can't be read or judged is the result's error.
 */
async function _judgeConversation(
  simulation: EvalSimulationScenario,
  path: string,
): Promise<EvalSimulationResult> {
  let messages: Dict[];
  let judgement: { goal: Dict; metrics: EvalSimulationResult["metrics"] };
  try {
    const fs = await import("node:fs/promises");
    messages = pyJsonLoads(await fs.readFile(path, "utf8")) as Dict[];
    const { EvalSimulationJudge } = await import("./simulation_judge.ts");
    judgement = (await new EvalSimulationJudge(simulation, {
      explainBelow: Number.POSITIVE_INFINITY,
    }).judge(messages as any)) as any;
  } catch (e) {
    rethrowIfCancelled(e);
    return new EvalSimulationResult({
      simulationName: simulation.name,
      succeeded: false,
      error: `error: ${_errorTypeName(e)}: ${_errorMessage(e)}`,
      success: simulation.success,
    });
  }
  const goal = judgement.goal;
  return new EvalSimulationResult({
    simulationName: simulation.name,
    succeeded: goal.verdict === "yes",
    reason: goal.reason,
    confidence: goal.confidence,
    probabilities: goal.probabilities,
    error: goal.verdict === "none" ? `judge gave no verdict on the goal: ${goal.reason}` : null,
    metrics: judgement.metrics,
    messages: messages
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map((m) => ({ role: m.role, content: m.content })),
    conversation: messages,
    turns: messages.filter((m) => m.role === "user").length,
    success: simulation.success,
  });
}

/**
 * The JSONL line of a judged conversation: the goal's verdict and every
 * metric's, each with the wording it was judged on, and each turn's with its
 * reason and what the bot said.
 */
function _judgementRecord(path: string, result: EvalSimulationResult): Dict {
  const botTurns = result.messages
    .filter((m: Dict) => m.role === "assistant")
    .map((m: Dict) => m.content);
  return {
    conversation: path,
    scenario: result.simulationName,
    success: result.success,
    passed: result.passed,
    succeeded: result.succeeded,
    error: result.error,
    confidence: result.confidence,
    probabilities: result.probabilities,
    reason: result.reason,
    metrics: result.metrics.map((m) => ({
      name: m.name,
      criterion: m.criterion,
      score: m.score,
      passed: m.passed,
      min_score: m.minScore,
      reason: m.reason,
      failure_kind: m.failureKind,
      verdicts: m.verdicts.map((v) => ({
        turn: v.turn,
        passed: v.passed,
        verdict: v.verdict,
        confidence: v.confidence,
        probabilities: v.probabilities,
        reason: v.reason,
        text: v.turn <= botTurns.length ? botTurns[v.turn - 1] : "",
      })),
    })),
  };
}

/** Print a judged conversation's verdict line and, verbose, the judge's reasons under it. */
function _printJudgement(path: string, result: EvalSimulationResult, verbose: boolean): void {
  if (result.passed) {
    print(`  ${_green("✓")} ${path}`);
  } else {
    print(`  ${_red("✗")} ${path}  ${_dim(result.failure ?? "")}`);
  }
  if (verbose) {
    _printSimulationDetail(result);
  }
}

/** Judge every conversation, `concurrency` at a time, writing each line as it is judged. */
async function _judgeAll(
  simulation: EvalSimulationScenario,
  paths: string[],
  output: string,
  concurrency: number,
  verbose: boolean,
): Promise<EvalSimulationResult[]> {
  const fs = await import("node:fs");
  const semaphore = new Semaphore(concurrency);
  const results: EvalSimulationResult[] = [];
  const fd = fs.openSync(output, "w");
  try {
    const judgeOne = async (path: string): Promise<void> => {
      const result = await semaphore.run(() => _judgeConversation(simulation, path));
      fs.writeSync(fd, `${pyJsonDumps(_judgementRecord(path, result))}\n`);
      _printJudgement(path, result, verbose);
      results.push(result);
    };
    await gather(...paths.map((path) => () => judgeOne(path)));
  } finally {
    fs.closeSync(fd);
  }
  return results;
}

// ---------------------------------------------------------------------------
// `pipedog-eval suite` — spawn the bots in a manifest and run their scenarios.
// ---------------------------------------------------------------------------

type _Verdict = "passed" | "failed" | "skipped" | "error";

const _EVAL_GLYPH: Record<_Verdict, [glyph: string, ansi: string]> = {
  passed: ["✓", "32"],
  failed: ["✗", "31"],
  skipped: ["⊘", "33"],
  error: ["✗", "31"],
};

/** Collapse a run into a display verdict. */
export function _evalVerdict(r: EvalRun): _Verdict | "pending" | "running" {
  if (r.status !== "done") return r.status; // pending | running
  if (r.error || r.result === null) return "error";
  if (r.result instanceof EvalScriptResult && r.result.skipped) return "skipped";
  if (r.result instanceof EvalSimulationResult && r.result.error) return "error";
  return r.result.passed ? "passed" : "failed";
}

/**
 * The run's detail beside its verdict, or `""`.
 *
 * A scenario: `7/10 turns` for a run that drove every turn and failed some. A
 * run that stopped at its first failure left the rest undriven, so it gets no
 * fraction; a run that passed is already said by the ✓. A simulation: how it
 * ended, e.g. `end_call`.
 */
export function _turnTally(r: EvalRun): string {
  const result = r.result;
  if (result instanceof EvalSimulationResult) return result.endedBy;
  if (result === null || !result.turns.length) return "";
  if (result.turns.some((t) => t.status === "not_run")) return "";
  const failed = result.turns.filter((t) => t.status === "failed").length;
  if (!failed) return "";
  return `${result.turns.length - failed}/${result.turns.length} turns`;
}

/** Python's `round(x, ndigits)` (banker's rounding on the decimal value, near enough). */
function _round(x: number, digits = 0): number {
  const m = 10 ** digits;
  const v = x * m;
  const r = Math.round(v);
  // Half to even, as Python rounds.
  const rounded = Math.abs(v % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
  return rounded / m;
}

/**
 * Human-friendly elapsed time, e.g. `12.3s` or `2m 04s`: tenths under a
 * minute, then minutes and seconds, deciding on the rounded value so nothing
 * ever reads `60.0s`.
 */
export function _fmtDuration(seconds: number): string {
  const tenths = _round(seconds, 1);
  if (tenths < 60) return `${tenths.toFixed(1)}s`;
  const total = Math.trunc(_round(seconds));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}m ${String(s).padStart(2, "0")}s`;
}

/** A running clock, padded to the width of `2m 04s` so what sits beside it never moves. */
function _clock(seconds: number): string {
  return _fmtDuration(seconds).padStart(6);
}

/** `23/50 (46%)` over the attempts that finished, or a placeholder if none have. */
function _passRate(passed: number, done: number): string {
  if (!done) return "—";
  return `${passed}/${done} (${Math.floor((100 * passed) / done)}%)`;
}

/** Rate colors as ANSI codes. */
const _RATE_ANSI: Record<string, string> = { green: "32", red: "31", dim: "2" };

/** Color for a pass rate: green when every finished attempt passed, red once one has not, dim before any finished. */
function _rateLevel(passed: number, done: number): "green" | "red" | "dim" {
  if (!done) return "dim";
  return passed === done ? "green" : "red";
}

/**
 * How long a row has been going: from its first attempt's start to now, or
 * to its last attempt's end. `null` before any attempt has started.
 */
function _rowSeconds(group: EvalRun[]): number | null {
  const started = group.map((r) => r.startedAt).filter((s): s is number => s !== null);
  if (!started.length) {
    const durations = group.map((r) => r.durationMs).filter((d): d is number => d !== null);
    return durations.length ? durations.reduce((a, b) => a + b, 0) / 1000 : null;
  }
  if (group.some((r) => r.status !== "done")) {
    return monotonic() - Math.min(...started);
  }
  const ended = group
    .filter((r) => r.startedAt !== null && r.durationMs !== null)
    .map((r) => r.startedAt! + r.durationMs! / 1000);
  return (ended.length ? Math.max(...ended) : monotonic()) - Math.min(...started);
}

/** Runs bucketed by (label, scenario), in first-seen order. */
function _groupedRuns(
  runs: EvalRun[],
): Map<string, { label: string; scenario: string; runs: EvalRun[] }> {
  const groups = new Map<string, { label: string; scenario: string; runs: EvalRun[] }>();
  for (const r of runs) {
    const key = JSON.stringify([r.label, r.scenario]);
    let group = groups.get(key);
    if (group === undefined) {
      group = { label: r.label, scenario: r.scenario, runs: [] };
      groups.set(key, group);
    }
    group.runs.push(r);
  }
  return groups;
}

/** A dashboard cell: its text, its ANSI style, and whether it is the spinner. */
interface _Cell {
  text: string;
  style?: string;
}

/** The "dots" spinner's frames. */
const _SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/**
 * Live table rendered every frame from the shared list of runs.
 *
 * With `grouped`, attempts of the same (bot, scenario) collapse into a single
 * row carrying a pass counter — a repeated sweep is hundreds of runs, which as
 * one row apiece would scroll the table faster than it could be read.
 *
 * DIVERGENCE: rendered as ANSI text lines (no rich).
 */
export class _EvalDashboard {
  runs: EvalRun[];
  startedAt: number;
  grouped: boolean;
  readonly #spinnerStarted = monotonic();

  constructor(runs: EvalRun[], startedAt: number, options: { grouped?: boolean } = {}) {
    this.runs = runs;
    this.startedAt = startedAt;
    this.grouped = options.grouped ?? false;
  }

  #spinner(): _Cell {
    const frame = Math.floor((monotonic() - this.#spinnerStarted) / 0.08) % _SPINNER_FRAMES.length;
    return { text: _SPINNER_FRAMES[frame]!, style: "36" };
  }

  #statusCell(r: EvalRun): _Cell {
    if (r.status === "pending") return { text: "·", style: "2" };
    if (r.status === "running") return this.#spinner();
    const [glyph, style] = _EVAL_GLYPH[_evalVerdict(r) as _Verdict];
    return { text: glyph, style };
  }

  /** The frame for a terminal of `height` lines and `width` columns, as lines. */
  render(height: number, width: number): string[] {
    if (this.grouped) return this.#renderGrouped(height, width);
    const rows = this.runs;
    const n = rows.length;
    const [start, end] = this._window(
      rows.map((r) => r.status),
      height,
    );
    const cells: _Cell[][] = [];
    for (const r of rows.slice(start, end)) {
      let detail = "";
      if (r.status === "running" && r.startedAt !== null) {
        detail = _clock(monotonic() - r.startedAt);
      } else if (r.status === "done" && r.durationMs !== null) {
        detail = `${r.durationMs}ms`;
      }
      cells.push([
        this.#statusCell(r),
        { text: r.label },
        { text: r.scenario, style: "36" },
        { text: detail, style: "2" },
      ]);
    }
    return this.#framed(_EvalDashboard._table(cells, 4, width), start, end, n);
  }

  /**
   * A grid of `cells` that fits `width` with every row on one line. The status
   * glyph and the numbers are as wide as their widest cell, and the bot and
   * scenario columns get what is left, cut with an ellipsis only when the row
   * would not fit.
   */
  static _table(cells: _Cell[][], columns: number, width: number): string[] {
    const widths = Array.from({ length: columns }, (_, i) =>
      Math.max(1, ...cells.map((row) => row[i]!.text.length)),
    );
    const fixed =
      widths.reduce((sum, w, i) => (i === 1 || i === 2 ? sum : sum + w), 0) + 2 * (columns - 1);
    const budget = Math.max(20, width - fixed - 1);
    const paths = widths[1]! + widths[2]!;
    if (paths > budget) {
      const botWidth = Math.max(10, Math.floor((budget * widths[1]!) / paths));
      const scenarioWidth = Math.max(10, budget - botWidth);
      const cut = (text: string, w: number) =>
        text.length > w ? `${text.slice(0, w - 1)}…` : text;
      for (const row of cells) {
        row[1]!.text = cut(row[1]!.text, botWidth);
        row[2]!.text = cut(row[2]!.text, scenarioWidth);
      }
      widths[1] = Math.min(widths[1]!, botWidth);
      widths[2] = Math.min(widths[2]!, scenarioWidth);
    }
    return cells.map((row) =>
      row
        .map((cell, i) => {
          const padded = i >= 3 ? cell.text.padStart(widths[i]!) : cell.text.padEnd(widths[i]!);
          return cell.style ? _color(padded, cell.style) : padded;
        })
        .join("  ")
        .trimEnd(),
    );
  }

  /**
   * The slice of rows to show, sized to the terminal and sliding with the
   * active runs, so the tally pinned below always stays on screen.
   *
   * @returns The `[start, end)` of the rows to render.
   */
  _window(statuses: string[], height: number): [number, number] {
    const n = statuses.length;
    const avail = Math.max(3, height - 3); // leave room for a blank line + the tally (+1 slack)
    if (n <= avail) return [0, n];
    // Anchor on the active frontier (the last running row, or the first
    // pending one) and keep a couple of upcoming rows in view below it.
    const running = statuses.flatMap((status, i) => (status === "running" ? [i] : []));
    const doneN = statuses.filter((status) => status === "done").length;
    const anchor = running.length ? Math.max(...running) : Math.min(doneN, n - 1);
    const body = Math.max(1, avail - 2); // 2 lines reserved for the ↑/↓ "more" markers
    let end = Math.min(n, anchor + 1 + Math.min(2, body - 1));
    const start = Math.max(0, end - body);
    end = Math.min(n, start + body);
    return [start, end];
  }

  /** The table between its scroll markers, with the tally pinned below. */
  #framed(table: string[], start: number, end: number, n: number): string[] {
    const total = this.runs.length;
    const done = this.runs.filter((r) => r.status === "done").length;
    const passed = this.runs.filter((r) => _evalVerdict(r) === "passed").length;
    // The total time ticks live next to the tally, so it doubles as the
    // "still working" signal; _finalizeEvals does not reprint this line.
    const elapsed = _fmtDuration(monotonic() - this.startedAt);
    const parts: string[] = [];
    if (start > 0) parts.push(_dim(`   ↑ ${start} more`));
    parts.push(...table);
    if (end < n) parts.push(_dim(`   ↓ ${n - end} more`));
    parts.push(
      "",
      `  ${_bold(`${passed}/${total} passed  ·  ${done}/${total} done  ·  ${elapsed}`)}`,
    );
    return parts;
  }

  /** One row per (bot, scenario), showing that pair's pass rate and pace. */
  #renderGrouped(height: number, width: number): string[] {
    const groups = [..._groupedRuns(this.runs).values()];
    const n = groups.length;
    const [start, end] = this._window(
      groups.map(({ runs: group }) =>
        group.every((r) => r.status === "done")
          ? "done"
          : group.some((r) => r.status === "running" || r.stopping)
            ? "running"
            : "pending",
      ),
      height,
    );

    // The progress columns are as wide as the widest text any row can reach,
    // "10 left" and "3/3 (100%)", from the first frame, so nothing moves.
    const leftWidth = Math.max(0, ...groups.map((g) => `${g.runs.length} left`.length));
    const rateWidth = Math.max(
      0,
      ...groups.map((g) => _passRate(g.runs.length, g.runs.length).length),
    );

    const cells: _Cell[][] = [];
    for (const { label, scenario, runs: group } of groups.slice(start, end)) {
      const done = group.filter((r) => r.status === "done");
      const [passed] = _groupOutcome(group);
      // Three states, and only the last is a verdict: spinning while a slot is
      // held, a still dot while waiting for one, and ✓/✗ once every attempt is in.
      let status: _Cell;
      if (done.length === group.length) {
        const [glyph, style] = _EVAL_GLYPH[passed === group.length ? "passed" : "failed"];
        status = { text: glyph, style };
      } else if (group.some((r) => r.status === "running" || r.stopping)) {
        status = this.#spinner();
      } else {
        status = { text: "·", style: "2" };
      }
      const remaining = group.length - done.length;
      const left = { text: remaining ? `${remaining} left`.padStart(leftWidth) : "", style: "2" };
      const rate = {
        text: _passRate(passed, group.length).padStart(rateWidth),
        style: _RATE_ANSI[_rateLevel(passed, done.length)],
      };
      const seconds = _rowSeconds(group);
      const clock = seconds === null ? "" : _clock(seconds);
      cells.push([
        status,
        { text: label },
        { text: scenario, style: "36" },
        left,
        rate,
        { text: clock, style: "2" },
      ]);
    }
    return this.#framed(_EvalDashboard._table(cells, 6, width), start, end, n);
  }
}

/**
 * Redraws a dashboard in place while `fn` runs (rich's `Live`), 12.5 times a
 * second, leaving its last frame on screen.
 */
class _Live {
  readonly #dashboard: _EvalDashboard;
  #lines = 0;

  constructor(dashboard: _EvalDashboard) {
    this.#dashboard = dashboard;
  }

  #draw(): void {
    const lines = this.#dashboard.render(_terminalHeight(), _terminalWidth());
    const up = this.#lines ? `\x1b[${this.#lines}F\x1b[0J` : "";
    _stdout().write(`${up}${lines.join("\n")}\n`);
    this.#lines = lines.length;
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    _stdout().write("\x1b[?25l");
    this.#draw();
    const refresher: Task<void> = createTask(async () => {
      for (;;) {
        await sleep(0.08);
        this.#draw();
      }
    }, "eval-dashboard");
    try {
      return await fn();
    } finally {
      refresher.cancel();
      // It only ends by being cancelled.
      await gatherSettled(refresher);
      this.#draw();
      _stdout().write("\x1b[?25h");
    }
  }
}

/** Print a single result line (non-TTY fallback, streamed as each finishes). */
function _printEvalLine(r: EvalRun, options: { showAttempt?: boolean } = {}): void {
  if (r.status !== "done") return;
  const [glyph, code] = _EVAL_GLYPH[_evalVerdict(r) as _Verdict];
  let extra = r.durationMs !== null && !r.error ? `(${r.durationMs}ms)` : (r.error ?? "");
  const tally = _turnTally(r);
  if (tally) extra = `${tally} ${extra}`;
  const scenario = options.showAttempt ? `${r.scenario} #${r.attempt}` : r.scenario;
  print(`  ${_color(glyph, code)} ${r.label} ${_color(scenario, "36")} ${_dim(extra)}`);
}

/** `1 eval` / `2 evals` — count plus its noun, pluralized with a trailing -s. */
function _plural(count: number, noun: string): string {
  return count === 1 ? `${count} ${noun}` : `${count} ${noun}s`;
}

/**
 * How many of `runs` are audio-mode, the only kind the harness records. A run
 * whose scenario fails to load counts as text.
 */
async function _audioRuns(runs: EvalRun[]): Promise<number> {
  const botAudio = new Map<string, boolean>();
  const key = (r: EvalRun) => JSON.stringify([r.scenarioPath, r.scenario]);
  for (const r of runs) {
    if (!botAudio.has(key(r))) {
      try {
        botAudio.set(key(r), Boolean((await r.load()).botAudio));
      } catch (e) {
        rethrowIfCancelled(e);
        botAudio.set(key(r), false);
      }
    }
  }
  return runs.filter((r) => botAudio.get(key(r))).length;
}

/** The `recording` settings value: whether the selected runs will produce audio. */
async function _recordingSetting(runs: EvalRun[], record: boolean): Promise<string> {
  if (!record) return "off";
  const audio = await _audioRuns(runs);
  const total = runs.length;
  if (audio === total) return "on";
  if (audio === 0) return `off ${_color("(all runs text mode)", "33")}`;
  return `on ${_color(`(${audio} of ${total} runs; text mode skipped)`, "33")}`;
}

/**
 * Print how the suite will execute: the run count, the concurrency, and
 * whether audio is being recorded. `concurrency` is `null` when the runs go
 * one at a time against a fixed bot.
 */
async function _printRunSettings(
  runs: EvalRun[],
  concurrency: number | null,
  record: boolean,
): Promise<void> {
  const total = runs.length;
  let counts = String(total);
  const attempts = [...new Set(runs.map((r) => r.attempts))].sort((a, b) => a - b);
  if (attempts.length && attempts.at(-1)! > 1) {
    const evals = _groupedRuns(runs).size;
    if (attempts.length === 1) {
      counts = `${total} (${_plural(evals, "eval")} x ${_plural(attempts[0]!, "attempt")})`;
    } else {
      counts = `${total} (${_plural(evals, "eval")}, ${attempts[0]}-${attempts.at(-1)} attempts each)`;
    }
  }
  const settings: [string, string][] = [["runs", counts]];
  if (concurrency !== null) settings.push(["concurrency", String(concurrency)]);
  settings.push(["recording", await _recordingSetting(runs, record)]);
  print("Settings:");
  for (const [label, value] of settings) {
    print(`  ${_color(label.padEnd(11), "1")} -> ${value}`);
  }
  print();
}

/**
 * Print each distinct scenario's and simulation's config once, up front, so it
 * doesn't interleave with the live display.
 */
async function _printScenarioConfigs(runs: EvalRun[]): Promise<void> {
  for (const [kind, heading] of [
    [EvalKind.SCRIPT, "Scripted scenarios:"],
    [EvalKind.SIMULATION, "Simulated scenarios:"],
  ] as const) {
    const seen = new Set<string>();
    for (const r of runs) {
      if (r.kind !== kind || seen.has(r.scenario)) continue;
      if (!seen.size) print(heading);
      seen.add(r.scenario);
      let cfg: string;
      try {
        const loaded = await r.load();
        cfg =
          loaded instanceof EvalSimulationScenario
            ? describeSimulation(loaded, { color: _isTerminal() })
            : describeConfig(loaded, { color: _isTerminal() });
      } catch (e) {
        rethrowIfCancelled(e);
        cfg = `(failed to load: ${_errorMessage(e)})`;
      }
      print(`  ${_color(`${r.scenario}:`, "1;36")}`);
      for (const line of cfg.split("\n")) {
        print(`    ${line}`);
      }
    }
    if (seen.size) print();
  }
}

/**
 * Print every failed run: what it was, and what went wrong.
 *
 * @param failed The runs that failed or errored.
 * @param total How many runs there were, for the header's denominator.
 * @param showAttempt Include each run's attempt number.
 */
function _printFailures(failed: EvalRun[], total: number, showAttempt: boolean): void {
  if (!failed.length) return;
  print();
  print(`  ${_color(`Failures (${failed.length} of ${total}):`, "1;31")}`);
  print();
  for (const r of failed) {
    const attempt = showAttempt ? ` ${_dim(`#${r.attempt}`)}` : "";
    const tally = _turnTally(r);
    let header = `  ${_red("✗")} ${r.label} ${_color(r.scenario, "36")}${attempt}`;
    if (tally && r.result instanceof EvalScriptResult) {
      header = `${header} ${_dim(`${tally} passed`)}`;
    }
    if (r.error) {
      print(`${header} ${_dim(`— ${r.error}`)}`);
    } else if (r.result instanceof EvalSimulationResult) {
      const result = r.result;
      if (result.error) {
        print(`${header} ${_dim(`— ${result.error}`)}`);
      } else {
        print(header);
        print(`      ${_red("•")} ${result.failure} ${_dim(tally)}`);
      }
    } else if (r.result !== null) {
      print(header);
      for (const f of r.result.failures) {
        const turn = f.turnIndex >= 0 ? `turn ${f.turnIndex}` : "run";
        print(`      ${_red("•")} ${turn} ${f.eventName} ${_color(f.kind, "31")} — ${f.reason}`);
      }
    }
  }
}

/**
 * A (bot, scenario) group's `[passed, completed, errored]`. Errored runs are
 * left out of the completed count: a run that crashed or never connected says
 * nothing about whether the bot did its job.
 */
function _groupOutcome(group: EvalRun[]): [number, number, number] {
  const verdicts = group.map(_evalVerdict);
  const passed = verdicts.filter((v) => v === "passed").length;
  const errored = verdicts.filter((v) => v === "error").length;
  const completed = verdicts.filter(
    (v) => v === "passed" || v === "failed" || v === "skipped",
  ).length;
  return [passed, completed, errored];
}

/**
 * Print per-(bot, scenario) pass rates and every failure. `showRates` is false
 * when the live dashboard ran: its final frame is already a rate table.
 */
function _printRepeatSummary(runs: EvalRun[], failed: EvalRun[], showRates: boolean): void {
  if (showRates) {
    print();
    print(`  ${_color("Pass rate:", "1")}`);
    const groups = [..._groupedRuns(runs).values()];
    const botW = Math.max(...groups.map((g) => g.label.length));
    const scenarioW = Math.max(...groups.map((g) => g.scenario.length));
    for (const { label, scenario, runs: group } of groups) {
      const [passed, completed, errored] = _groupOutcome(group);
      const rateText = _passRate(passed, completed).padStart(14);
      const rate = _color(rateText, _RATE_ANSI[_rateLevel(passed, completed)]!);
      const extra: string[] = [];
      if (errored) extra.push(`${errored} errored`);
      const seconds = _rowSeconds(group);
      if (seconds !== null) extra.push(_fmtDuration(seconds));
      let mark = "";
      if (!group[0]!.sweep) {
        mark = `  ${passed === group.length ? _green("✓") : _red("✗")}`;
      }
      print(
        `  ${label.padEnd(botW)}  ${_color(scenario.padEnd(scenarioW), "36")}  ${rate}${mark}  ` +
          `${_dim(extra.filter(Boolean).join(" · "))}`,
      );
    }
  }
  _printFailures(failed, runs.length, true);
}

/** Print the failed set + final tally; return the process exit code. */
function _finalizeEvals(
  runs: EvalRun[],
  runsDir: string,
  elapsedS: number,
  dashboardShown: boolean,
): number {
  const failed = runs.filter((r) => {
    const v = _evalVerdict(r);
    return v === "failed" || v === "error";
  });
  const passed = runs.filter((r) => _evalVerdict(r) === "passed").length;
  const skipped = runs.filter((r) => _evalVerdict(r) === "skipped").length;
  if (runs.some((r) => r.attempts > 1)) {
    _printRepeatSummary(runs, failed, !dashboardShown);
    print();
    if (!dashboardShown) {
      const summary = `${passed}/${runs.length} passed  ·  ${_fmtDuration(elapsedS)}`;
      print(`  ${_color(summary, failed.length ? "31" : "32")}`);
    }
    print(`  logs: ${runsDir}`);
    print(`  results: ${nodePath.join(runsDir, "results.jsonl")}`);
    print();
    // A repeated sweep measures a pass rate, so failures there are data rather
    // than a build break; a simulation's own runs are a requirement.
    return failed.some((r) => !r.sweep) ? 1 : 0;
  }
  _printFailures(failed, runs.length, false);
  print();
  // When the live dashboard ran, its last frame already shows the tally.
  if (!dashboardShown) {
    let summary = `${passed}/${runs.length} passed`;
    if (failed.length) summary += `, ${failed.length} failed`;
    if (skipped) summary += `, ${skipped} skipped`;
    summary += `  ·  ${_fmtDuration(elapsedS)}`;
    print(`  ${_color(summary, failed.length ? "31" : "32")}`);
  }
  print(`  logs: ${runsDir}`);
  print();
  return failed.length ? 1 : 0;
}

/** Run the suite with a live dashboard (TTY) or streamed lines (piped). */
async function _runSuiteAll(
  suite: EvalSuite,
  logsDir: string,
  recordDir: string | null,
  resultsPath: string | null,
  started: number,
  debug: boolean,
  params: EvalSessionParams,
): Promise<void> {
  const grouped = suite.runs.some((r) => r.attempts > 1);
  const options = { recordDir, resultsPath, debug, params };
  if (_isTerminal()) {
    const dashboard = new _EvalDashboard(suite.runs, started, { grouped });
    await new _Live(dashboard).run(() => suite.run(logsDir, options));
  } else {
    suite.addEventHandler("on_update", (_suite: unknown, run: EvalRun) =>
      _printEvalLine(run, { showAttempt: grouped }),
    );
    await suite.run(logsDir, options);
  }
}

// ---------------------------------------------------------------------------
// .env (python-dotenv's find_dotenv(usecwd=True) + load_dotenv)
// ---------------------------------------------------------------------------

/**
 * Load the nearest `.env` walking up from the working directory; variables
 * already set win.
 *
 * DIVERGENCE: a small loader in place of python-dotenv: `KEY=VALUE` lines,
 * an optional `export `, `#` comments, and single- or double-quoted values
 * (double quotes take `\n` escapes). No variable expansion.
 */
export async function _loadDotenv(cwd: string = process.cwd()): Promise<string | null> {
  const fs = await import("node:fs/promises");
  let dir = nodePath.resolve(cwd);
  for (;;) {
    const candidate = nodePath.join(dir, ".env");
    let text: string | null = null;
    try {
      if ((await fs.stat(candidate)).isFile()) text = await fs.readFile(candidate, "utf8");
    } catch (e) {
      rethrowIfCancelled(e);
    }
    if (text !== null) {
      for (const [key, value] of Object.entries(_parseDotenv(text))) {
        if (process.env[key] === undefined) process.env[key] = value;
      }
      return candidate;
    }
    const parent = nodePath.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** The variables a `.env` text sets. */
export function _parseDotenv(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const key = match[1]!;
    let value = match[2]!;
    if (value.startsWith('"')) {
      const end = value.indexOf('"', 1);
      value = (end > 0 ? value.slice(1, end) : value.slice(1))
        .replaceAll("\\n", "\n")
        .replaceAll('\\"', '"');
    } else if (value.startsWith("'")) {
      const end = value.indexOf("'", 1);
      value = end > 0 ? value.slice(1, end) : value.slice(1);
    } else {
      value = value.replace(/\s+#.*$/, "").trim();
    }
    env[key] = value;
  }
  return env;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

const PROG = "pipedog-eval";

const MAIN_HELP = `Usage: ${PROG} [OPTIONS] COMMAND [ARGS]...

  Run behavioral evals against a pipedog (or Pipecat) bot.

  Loads the nearest .env (walking up from the working directory) before any
  command runs; variables already set in the shell win.

Options:
  -h, --help  Show this message and exit.

Commands:
  run    Run one or more scenarios against an already-running bot.
  judge  Judge saved conversations against a simulation.
  suite  Spawn the bots in a manifest and run their scenarios concurrently.
`;

const RUN_HELP = `Usage: ${PROG} run [OPTIONS] SCENARIOS...

  Run one or more scenarios, scripted or simulations, against an
  already-running bot.

  A list of scenarios is treated as a one-bot suite: configs are printed up
  front, then a live dashboard (or streamed lines when piped / --verbose)
  shows each scenario's status and timing, the running tally, and the total
  time. A simulation runs once here: a success rate over several runs is the
  suite's job, since each run needs a fresh bot.

Arguments:
  SCENARIOS...              One or more scenario YAML files (scripted, or
                            simulations), or directories of them.

Options:
  --bot-url TEXT            WebSocket URL of the bot: the dev runner's /ws
                            route, or a cloud session's.
                            [default: ws://localhost:7860/ws]
  -v, --verbose             Print a line for each turn and expectation as it
                            resolves; for a simulation, the conversation as it
                            happens and the judge's reasons at the end.
  -a, --audio               Record each scenario's conversation audio
                            (audio-mode scenarios).
  --record-dir TEXT         Directory for --audio recordings:
                            <record-dir>/<scenario>.wav.  [default: recordings]
  --cache-dir TEXT          Directory for cached synthesized user audio.
  --no-cache                Disable the user-audio cache: re-synthesize every
                            turn (no reads or writes).
  -t, --timeout INTEGER     Default per-expectation timeout in seconds (for
                            expectations without their own within_ms).
                            [default: 60]
  --logs-dir TEXT           Directory for each scenario's logs:
                            <logs-dir>/<scenario>.eval.log (+ .debug.log, and
                            a simulation's .conversation.json).  [default: .]
  -d, --debug               Also save <scenario>.debug.log with the harness's
                            full per-pipeline logs.
  --bot-ready-timeout FLOAT Seconds to wait, once connected, for the bot's
                            RTVI bot-ready, which covers the bot's startup.
                            [default: 60.0]
  -h, --help                Show this message and exit.
`;

const JUDGE_HELP = `Usage: ${PROG} judge [OPTIONS] SCENARIO_PATH CONVERSATIONS...

  Judge saved conversations against a simulation's success and its criterion
  metrics.

  Each conversation gets the verdicts the simulation's own run would, with a
  reason for every one, passes included. Measured metrics are left out, since
  they come from a live run. Exits non-zero when a conversation did not pass.

Arguments:
  SCENARIO_PATH             Scenario YAML file holding the simulation.
  CONVERSATIONS...          Conversation files to judge: a run's
                            <stem>.conversation.json, or the same format saved
                            from a real call.

Options:
  -s, --scenario TEXT       The simulation to judge with when the file holds
                            several, with or without the file's name
                            (book_table/available or available).
  -o, --output PATH         JSONL file to write, one line per file.
                            [default: judged.jsonl]
  -c, --concurrency INTEGER How many conversations to judge at once.
                            [default: 4]
  -v, --verbose             Print the judge's reason and each metric's score.
  -h, --help                Show this message and exit.
`;

const SUITE_HELP = `Usage: ${PROG} suite [OPTIONS] MANIFEST_PATH

  Spawn the bots in a manifest and run their scenarios concurrently.

  Everything except the suite: list can be set in the manifest or overridden
  here (the command line wins), so a manifest can be just a suite: list. A
  scenario file is scripted or a simulation, and the file says which; a
  simulation runs as many times as its file says.

Arguments:
  MANIFEST_PATH             Manifest YAML listing bots + their scenarios
                            (scripted, or simulations).

Options:
  -p, --pattern TEXT        Only entries whose name or bot path contains this.
  -s, --scenario TEXT       Only this scenario name.
  -k, --kind [script|simulation]
                            Only scenarios of this kind.
  -n, --name TEXT           Run subdir name under runs_dir (default a
                            timestamp).
  --runs-dir PATH           Output base, overriding the manifest's runs_dir (a
                            <name>/ subdir with logs/ and recordings/ is created
                            under it; default eval-runs).
  --bots-dir PATH           Override manifest bots_dir.
  --scenarios-dir PATH      Override manifest scenarios_dir.
  -c, --concurrency INTEGER Override manifest concurrency.
  -r, --repeat INTEGER      Run each (bot, scenario) this many times, to
                            measure flakiness, and each simulation this many
                            times instead of its own runs (1 included); a
                            repeated sweep reports rates and exits 0.
  --base-port INTEGER       Override manifest base_port.
  --cache-dir TEXT          Override manifest cache_dir.
  --no-cache                Disable the user-audio cache: re-synthesize every
                            turn (no reads or writes).
  -t, --timeout INTEGER     Default per-expectation timeout in seconds (for
                            expectations without their own within_ms).
                            [default: 60]
  --spawn TEXT              Override manifest spawn template
                            ({python} {bot} --port {port}).
  --python TEXT             Override the runtime that runs each bot (default:
                            the running bun or node).
  -a, --audio               Record conversation audio.
  -d, --debug               Also save <run>.debug.log with the harness's full
                            per-pipeline logs.
  -h, --help                Show this message and exit.
`;

/** An integer option's value (`typer` INTEGER). */
function _intOption(value: string | undefined, flag: string): number | null {
  if (value === undefined) return null;
  if (!/^[+-]?\d+$/.test(value.trim())) {
    throw new BadParameter(`'${value}' is not a valid integer.`, flag);
  }
  return Number.parseInt(value, 10);
}

/** A float option's value (`typer` FLOAT). */
function _floatOption(value: string | undefined, flag: string): number | null {
  if (value === undefined) return null;
  const n = Number(value);
  if (value.trim() === "" || Number.isNaN(n)) {
    throw new BadParameter(`'${value}' is not a valid float.`, flag);
  }
  return n;
}

/** `pipedog-eval run`. */
async function _runCommand(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      "bot-url": { type: "string", default: "ws://localhost:7860/ws" },
      verbose: { type: "boolean", short: "v", default: false },
      audio: { type: "boolean", short: "a", default: false },
      "record-dir": { type: "string", default: "recordings" },
      "cache-dir": { type: "string" },
      "no-cache": { type: "boolean", default: false },
      timeout: { type: "string", short: "t" },
      "logs-dir": { type: "string", default: "." },
      debug: { type: "boolean", short: "d", default: false },
      "bot-ready-timeout": { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) {
    _stdout().write(RUN_HELP);
    return 0;
  }
  if (!positionals.length) throw new BadParameter("Missing argument 'SCENARIOS...'.");
  const timeout = _intOption(values.timeout, "-t") ?? 60;
  const botReadyTimeout = _floatOption(values["bot-ready-timeout"], "--bot-ready-timeout");

  // pipedog's own logs are captured to <scenario>.debug.log under --debug; either
  // way, silence the console sink so it can't corrupt the live display.
  logger.setSink();

  const runs = await _buildScenarioRuns(await _expandScenarioPaths(positionals), values["bot-url"]);
  await _printScenarioConfigs(runs);
  // Printed only under -a, to say which of the runs will actually record.
  if (values.audio) {
    await _printRunSettings(runs, null, values.audio);
  }

  const params: _ParamsOptions = {
    defaultTimeoutMs: timeout * 1000,
    cacheDir: values["cache-dir"] ?? null,
    useCache: !values["no-cache"],
  };
  if (botReadyTimeout !== null) params.botReadyTimeoutS = botReadyTimeout;
  const started = monotonic();
  await _runScenariosAll(runs, {
    audio: values.audio,
    recordDir: values["record-dir"],
    params,
    logsDir: values["logs-dir"],
    verbose: values.verbose,
    debug: values.debug,
    started,
  });
  const dashboardShown = _isTerminal() && !values.verbose;
  return _finalizeEvals(
    runs,
    nodePath.resolve(values["logs-dir"]),
    monotonic() - started,
    dashboardShown,
  );
}

/** `pipedog-eval judge`. */
async function _judgeCommand(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      scenario: { type: "string", short: "s" },
      output: { type: "string", short: "o", default: "judged.jsonl" },
      concurrency: { type: "string", short: "c" },
      verbose: { type: "boolean", short: "v", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) {
    _stdout().write(JUDGE_HELP);
    return 0;
  }
  const [scenarioPath, ...conversations] = positionals;
  if (scenarioPath === undefined) throw new BadParameter("Missing argument 'SCENARIO_PATH'.");
  if (!conversations.length) throw new BadParameter("Missing argument 'CONVERSATIONS...'.");
  const concurrency = _intOption(values.concurrency, "-c") ?? 4;
  logger.setSink();
  const simulation = await _judgedSimulation(scenarioPath, values.scenario ?? null);
  const results = await _judgeAll(
    simulation,
    conversations,
    values.output,
    concurrency,
    values.verbose,
  );
  const passed = results.filter((r) => r.passed).length;
  print();
  print(
    `  ${_color(`${passed}/${results.length} passed`, passed === results.length ? "32" : "31")}`,
  );
  print(`  results: ${values.output}`);
  print();
  return passed === results.length ? 0 : 1;
}

/** `datetime.now().strftime("%Y%m%d_%H%M%S")`. */
function _timestamp(now: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}_` +
    `${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`
  );
}

/** `pipedog-eval suite`. */
async function _suiteCommand(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      pattern: { type: "string", short: "p" },
      scenario: { type: "string", short: "s" },
      kind: { type: "string", short: "k" },
      name: { type: "string", short: "n" },
      "runs-dir": { type: "string" },
      "bots-dir": { type: "string" },
      "scenarios-dir": { type: "string" },
      concurrency: { type: "string", short: "c" },
      repeat: { type: "string", short: "r" },
      "base-port": { type: "string" },
      "cache-dir": { type: "string" },
      "no-cache": { type: "boolean", default: false },
      timeout: { type: "string", short: "t" },
      spawn: { type: "string" },
      python: { type: "string" },
      audio: { type: "boolean", short: "a", default: false },
      debug: { type: "boolean", short: "d", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) {
    _stdout().write(SUITE_HELP);
    return 0;
  }
  const [manifestPath] = positionals;
  if (manifestPath === undefined) throw new BadParameter("Missing argument 'MANIFEST_PATH'.");
  if (positionals.length > 1) {
    throw new BadParameter(`Got unexpected extra argument (${positionals[1]})`);
  }
  const kind = values.kind ?? null;
  if (kind !== null && kind !== EvalKind.SCRIPT && kind !== EvalKind.SIMULATION) {
    throw new BadParameter(`'${kind}' is not one of 'script', 'simulation'.`, "-k");
  }
  const timeout = _intOption(values.timeout, "-t") ?? 60;

  // Silence the console sink so it can't corrupt the live display (upstream's
  // EvalSuite.run does this itself).
  logger.setSink();

  const manifest = await EvalManifest.load(manifestPath, {
    botsDir: values["bots-dir"] ?? null,
    scenariosDir: values["scenarios-dir"] ?? null,
    runsDir: values["runs-dir"] ?? null,
    spawn: values.spawn ?? null,
    python: values.python ?? null,
    concurrency: _intOption(values.concurrency, "-c"),
    repeat: _intOption(values.repeat, "-r"),
    basePort: _intOption(values["base-port"], "--base-port"),
    record: values.audio || null,
    cacheDir: values["cache-dir"] ?? null,
  });

  const suite = new EvalSuite(manifest);
  const runs = suite.filter({
    pattern: values.pattern ?? null,
    scenario: values.scenario ?? null,
    kind: kind as EvalKind | null,
  });
  if (!runs.length) {
    print("No runs match.");
    return 1;
  }

  // A per-run subdir named by --name (default a timestamp) holds this run's logs
  // and recordings, under the (resolved) runs_dir.
  const base = manifest.runsDir ?? "eval-runs";
  const runDir = nodePath.join(base, values.name || _timestamp());
  const logsDir = nodePath.join(runDir, "logs");
  const recordDir = manifest.record ? nodePath.join(runDir, "recordings") : null;

  await _printScenarioConfigs(runs);
  await _printRunSettings(runs, manifest.concurrency, manifest.record);

  const started = monotonic();
  await _runSuiteAll(
    suite,
    logsDir,
    recordDir,
    nodePath.join(runDir, "results.jsonl"),
    started,
    values.debug,
    await _sessionParams({ defaultTimeoutMs: timeout * 1000, useCache: !values["no-cache"] }),
  );
  return _finalizeEvals(runs, runDir, monotonic() - started, _isTerminal());
}

const COMMANDS: Record<string, [run: (args: string[]) => Promise<number>, help: string]> = {
  run: [_runCommand, RUN_HELP],
  judge: [_judgeCommand, JUDGE_HELP],
  suite: [_suiteCommand, SUITE_HELP],
};

/**
 * Run the `pipedog-eval` CLI (upstream: the `eval_app` typer app).
 *
 * @param argv The arguments after the program name.
 * @returns The process's exit code.
 */
export async function evalApp(argv: string[] = process.argv.slice(2)): Promise<number> {
  const [command, ...rest] = argv;
  if (command === undefined || command === "-h" || command === "--help") {
    _stdout().write(MAIN_HELP);
    return command === undefined ? 2 : 0;
  }
  const entry = COMMANDS[command];
  if (entry === undefined) {
    process.stderr.write(`${MAIN_HELP}\nError: No such command '${command}'.\n`);
    return 2;
  }
  const [run, help] = entry;
  try {
    if (!rest.includes("-h") && !rest.includes("--help")) {
      // The harness's own services (a simulation's persona LLM, a hosted judge)
      // read their credentials from the environment, so the .env the bots load
      // for themselves is loaded here too.
      await _loadDotenv();
    }
    return await run(rest);
  } catch (e) {
    rethrowIfCancelled(e);
    const usage = help.split("\n")[0];
    if (e instanceof BadParameter) {
      const hint = e.paramHint ? ` for '${e.paramHint}'` : "";
      process.stderr.write(`${usage}\nTry '${PROG} ${command} --help' for help.\n\n`);
      process.stderr.write(`Error: Invalid value${hint}: ${e.message}\n`);
      return 2;
    }
    if (e instanceof TypeError && (e as { code?: string }).code?.startsWith("ERR_PARSE_ARGS")) {
      process.stderr.write(`${usage}\nTry '${PROG} ${command} --help' for help.\n\n`);
      process.stderr.write(`Error: ${e.message}\n`);
      return 2;
    }
    throw e;
  }
}
