// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/evals/simulation.py

/**
 * Simulated scenario file format for Pipecat behavioral evaluations.
 *
 * A simulation describes a caller rather than a script: who they are, what
 * they want, and how the outcome is judged. A persona LLM holds the
 * conversation with the bot on its own. A scenario with a `persona:` is a
 * simulation; it lives in a scenario file's `scenarios:` list
 * (`scenario.ts`) and a manifest lists the file like any other. Example:
 *
 * ```yaml
 * name: capital_curious
 * judge: !include judge_text.yaml
 * scenarios:
 *   - name: capital_curious
 *     persona: |
 *       A curious, polite traveler who asks one thing at a time.
 *     goal: "Find out what the capital of Germany is, then say goodbye."
 *     success: "the bot told the caller that the capital of Germany is Berlin"
 *     metrics:
 *       - name: politeness
 *         criterion: "the bot stayed courteous throughout"
 *         min_score: 1
 *     max_turns: 10
 * ```
 *
 * Fields:
 *
 * - `persona`, `goal`: the caller's character and what they are trying to
 *   accomplish; both go into the persona LLM's instructions (see `persona.ts`).
 * - `simulator`: the persona LLM: `service` (`ollama`) or a `factory`,
 *   `model`, and the optional `endpoint` / `extra` the judge config also
 *   takes. Omitted, the persona runs on the same local Ollama model as the
 *   default judge. The model must support function calling: the persona ends
 *   the call by calling its `end_call` tool.
 * - `user`, `judge`: the blocks scenarios use (see `script.ts`):
 *   `user.modality` and `user.speech` decide whether the persona's turns
 *   reach the bot as synthesized speech or as text; `judge.modality`,
 *   `judge.transcription` and `judge.eval` decide whether the bot speaks and
 *   which LLM judges the outcome. Audio modality needs a `user.speech` block,
 *   since every persona turn is synthesized.
 * - `success`: what counts as the bot having done its job, judged over the
 *   whole conversation; prose, as long as it needs to be. It is the bot's side
 *   of the `goal`: usually that the caller got what they asked for, but where
 *   the right outcome is to refuse, to qualify, or to escalate, it says so. The
 *   run succeeded if the judge says yes. The judge sees the bot's tool calls
 *   (name and arguments), not their results. Whether the bot made a call at
 *   all is a `function_calls` metric, no judge needed; if a reply must match
 *   backend data, write the expected value into the criterion ("the reply says
 *   the appointment is on Tuesday September fifteenth") and keep the mocks
 *   deterministic so it stays true across runs.
 * - `metrics`: judged quality criteria, each with `name`, `criterion`, and an
 *   optional `min_score` in 0..1. A criterion says what every reply of the bot
 *   should be; the judge decides it for each bot turn, in the light of the
 *   conversation before it and the tool calls the bot had made by then, with a
 *   yes or a no, never a partial score. The metric's score is the share of
 *   turns that got a yes: 0.80 is four replies in five. A turn the judge leaves
 *   out counts as a no, recorded as a verdict of `none` so a sweep can tell
 *   judge trouble from bot trouble, and a run with no bot turn has no score and
 *   passes. A metric with a `min_score` fails the run when its score is below
 *   it; one without is reported and never fails anything. Something the bot
 *   must do once, read the order back, belongs in `success`, not here.
 *
 *   A metric can measure instead of judge: `measure` names one of
 *   `SIMULATION_MEASURES` and `min_value` / `max_value` (at least one)
 *   bound it; the `name` defaults to the measure. The harness computes the
 *   value from the run, no judge involved, and the metric scores 1 inside the
 *   range and 0 outside, which fails the run. `turns` is the persona's
 *   turns, `duration` the conversation's seconds from its first line to the
 *   hang-up, `words` the longest bot reply in words, and `latency` the slowest
 *   reply in seconds: from the persona's send to the reply's first token in
 *   text mode, from the bot noticing the persona stop to its first spoken
 *   sentence in audio mode, which a failure's reason spells out, since the two
 *   are not comparable. The per-reply measures bound every reply.
 *   `function_calls` takes a `calls:` list instead of a range: the calls the
 *   bot should make, each a name or a `name` with `args` (a subset of the
 *   call's arguments), in any order. Every listed call must have happened and
 *   any call not listed fails it, so `calls: []` says the bot must call
 *   nothing, the check for a caller who should be turned down. A call the bot
 *   cancelled did not happen.
 * - `max_turns`, `max_duration_s`, `max_silence_s`: backstops on the
 *   persona's turns (default 20), on the run's wall clock (default 300 s), and
 *   on a lull in which neither side does anything (default 30 s), so a bot that
 *   never greets, or stops answering, ends the run as `silence` instead of
 *   running out the clock. A run they end has not succeeded. A failure of the
 *   harness's own pipeline, the persona LLM first among them, ends the run at
 *   once as an error.
 * - `runs`: how many times the suite runs the simulation (default 1). Every
 *   run must pass: a persona does not say the same thing twice, so one run is
 *   an anecdote and three are a check.
 *
 * Porting notes: the deprecated `EvalSimulationScenario.load` and the
 * `trigger_disconnect:` key / field are not ported.
 */

import {
  _CFG_EVAL,
  _CFG_LIMIT,
  type _ConfigLine,
  type _ConfigSegment,
  _configLines,
  _DEFAULT_JUDGE,
  _formatG,
  _get,
  _has,
  _isDict,
  _judgeSegments,
  _llmIdentity,
  _parseJudgeBlock,
  _parseUserBlock,
  _pyRepr,
  _pyTruthy,
  _userSegments,
  type EvalConfigured,
} from "./scenario_config.ts";
import { EvalFunctionCall } from "./script.ts";
import type { ServiceConfig } from "./services.ts";

export const DEFAULT_MAX_TURNS = 20;
export const DEFAULT_MAX_DURATION_S = 300.0;
export const DEFAULT_MAX_SILENCE_S = 30.0;

/** What a measured metric can measure, computed by the harness from the run. */
export const SIMULATION_MEASURES = [
  "turns",
  "duration",
  "words",
  "latency",
  "function_calls",
] as const;

export interface EvalSimulationMetricOptions {
  name: string;
  criterion?: string | null;
  minScore?: number | null;
  measure?: string | null;
  minValue?: number | null;
  maxValue?: number | null;
  calls?: EvalFunctionCall[] | null;
}

/** A quality metric: a judged criterion, or a measure with a range or a call list. */
export class EvalSimulationMetric {
  /** The metric's name in the results. */
  name: string;
  /** What the judge decides on each bot turn; `null` for a measured metric. */
  criterion: string | null;
  /**
   * The share of the bot's turns the judge must answer yes for, in 0..1, below
   * which a judged metric fails the run; `null` reports the score without
   * gating.
   */
  minScore: number | null;
  /** One of `SIMULATION_MEASURES`; `null` for a judged metric. */
  measure: string | null;
  /** The measured value's lower bound, inclusive, or `null`. */
  minValue: number | null;
  /** The measured value's upper bound, inclusive, or `null`. */
  maxValue: number | null;
  /**
   * For `function_calls`, the calls the bot should make: each a name, or a
   * name with `args` as a subset of the call's arguments; an empty list means
   * none. `null` for every other metric.
   */
  calls: EvalFunctionCall[] | null;

  constructor(options: EvalSimulationMetricOptions) {
    this.name = options.name;
    this.criterion = options.criterion ?? null;
    this.minScore = options.minScore ?? null;
    this.measure = options.measure ?? null;
    this.minValue = options.minValue ?? null;
    this.maxValue = options.maxValue ?? null;
    this.calls = options.calls ?? null;
  }
}

export interface EvalSimulationScenarioOptions {
  name: string;
  persona: string;
  goal: string;
  success: string;
  simulator?: ServiceConfig;
  metrics?: EvalSimulationMetric[];
  judge?: ServiceConfig;
  botAudio?: boolean;
  transcriber?: ServiceConfig | null;
  userAudio?: boolean;
  userSpeech?: ServiceConfig | null;
  maxTurns?: number;
  maxDurationS?: number;
  maxSilenceS?: number;
  runs?: number;
  sourcePath?: string | null;
}

/** A parsed simulation. */
export class EvalSimulationScenario implements EvalConfigured {
  /** The simulation name (from `name:`). */
  name: string;
  /** Who the caller is, as free text for the persona LLM. */
  persona: string;
  /** What the caller wants from the call. */
  goal: string;
  /** What counts as the bot having done its job, for the judge. */
  success: string;
  /**
   * The persona LLM config (`service`, `model`, optional `endpoint` /
   * `extra`), the same shape as `judge.eval`; empty for the default local
   * model.
   */
  simulator: ServiceConfig;
  /** The judged quality criteria. */
  metrics: EvalSimulationMetric[];
  /** Judge LLM config, as for a scenario. */
  judge: ServiceConfig;
  /** Whether the bot speaks (`judge.modality: audio`). */
  botAudio: boolean;
  /** STT config for the bot's audio in audio modality, else `null`. */
  transcriber: ServiceConfig | null;
  /** Whether the persona's turns reach the bot as speech (`user.modality: audio`). */
  userAudio: boolean;
  /** TTS config the persona's turns are synthesized with in audio modality, else `null`. */
  userSpeech: ServiceConfig | null;
  /** Cap on the persona's turns. */
  maxTurns: number;
  /** Cap on the run's wall clock, in seconds. */
  maxDurationS: number;
  /** Cap on a lull with no event from either side, in seconds. */
  maxSilenceS: number;
  /** How many times the suite runs the simulation; every run must pass. */
  runs: number;
  /** Path the simulation was loaded from, for error messages. */
  sourcePath: string | null;

  constructor(options: EvalSimulationScenarioOptions) {
    this.name = options.name;
    this.persona = options.persona;
    this.goal = options.goal;
    this.success = options.success;
    this.simulator = options.simulator ?? {};
    this.metrics = options.metrics ?? [];
    this.judge = options.judge ?? { ..._DEFAULT_JUDGE };
    this.botAudio = options.botAudio ?? false;
    this.transcriber = options.transcriber ?? null;
    this.userAudio = options.userAudio ?? false;
    this.userSpeech = options.userSpeech ?? null;
    this.maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS;
    this.maxDurationS = options.maxDurationS ?? DEFAULT_MAX_DURATION_S;
    this.maxSilenceS = options.maxSilenceS ?? DEFAULT_MAX_SILENCE_S;
    this.runs = options.runs ?? 1;
    this.sourcePath = options.sourcePath ?? null;
  }
}

/**
 * Parse a simulation's mapping, as read from `path`.
 *
 * @param data The simulation's top-level mapping.
 * @param path The file it came from, for error messages.
 * @returns The parsed simulation.
 * @throws Error If the mapping is invalid (upstream: ValueError).
 */
export function _parseSimulation(
  data: Record<string, unknown>,
  path: string,
): EvalSimulationScenario {
  const text = (key: string): string => {
    const value = _get(data, key);
    if (!_pyTruthy(value) || typeof value !== "string" || !value.trim()) {
      throw new Error(`${path}: missing or invalid '${key}:' field (a non-empty string)`);
    }
    return value.trim();
  };

  const rawSimulator = _get(data, "simulator");
  const simulator = _pyTruthy(rawSimulator) ? rawSimulator : {};
  if (!_isDict(simulator)) {
    throw new Error(`${path}: 'simulator:' must be a mapping naming the persona LLM`);
  }

  const [userAudio, userSpeech] = _parseUserBlock(_get(data, "user"), path);
  if (userAudio && userSpeech === null) {
    throw new Error(
      `${path}: 'user.modality: audio' requires a 'user.speech:' block ` +
        "(TTS service + voice) to synthesize the persona's turns",
    );
  }
  const [botAudio, transcriber, judge] = _parseJudgeBlock(_get(data, "judge"), path);

  // Argument order follows upstream's keyword arguments, so the first invalid
  // field reported is the same.
  const name = text("name");
  const persona = text("persona");
  const goal = text("goal");
  const success = text("success");
  const metrics = _parseMetrics(_get(data, "metrics"), path);
  const maxTurns = _positiveInt(data, "max_turns", DEFAULT_MAX_TURNS, path);
  const maxDurationS = _positiveNumber(data, "max_duration_s", DEFAULT_MAX_DURATION_S, path);
  const maxSilenceS = _positiveNumber(data, "max_silence_s", DEFAULT_MAX_SILENCE_S, path);
  const runs = _positiveInt(data, "runs", 1, path);

  return new EvalSimulationScenario({
    name,
    persona,
    goal,
    simulator,
    success,
    metrics,
    judge,
    botAudio,
    transcriber,
    userAudio,
    userSpeech,
    maxTurns,
    maxDurationS,
    maxSilenceS,
    runs,
    sourcePath: path,
  });
}

function isNumber(value: unknown): value is number {
  return typeof value === "number";
}

/** Parse the `metrics:` list. */
function _parseMetrics(raw: unknown, path: string): EvalSimulationMetric[] {
  if (raw === null) return [];
  if (!Array.isArray(raw)) throw new Error(`${path}: 'metrics:' must be a list`);
  const metrics: EvalSimulationMetric[] = [];
  raw.forEach((item, idx) => {
    if (!_isDict(item)) throw new Error(`${path}: metric #${idx} must be a mapping`);
    const criterion = _get(item, "criterion");
    const measure = _get(item, "measure");
    if ((criterion === null) === (measure === null)) {
      throw new Error(
        `${path}: metric #${idx} is judged ('criterion:') or measured ('measure:'), ` +
          "one of the two",
      );
    }
    const name = _get(item, "name", measure);
    if (!_pyTruthy(name) || typeof name !== "string") {
      throw new Error(`${path}: metric #${idx} needs a 'name:'`);
    }
    if (metrics.some((m) => m.name === name)) {
      throw new Error(`${path}: metric ${_pyRepr(name)} is listed twice`);
    }
    if (measure !== null) {
      metrics.push(_parseMeasure(item, name, measure, path));
      return;
    }
    if (!_pyTruthy(criterion) || typeof criterion !== "string") {
      throw new Error(`${path}: metric ${_pyRepr(name)} needs a 'criterion:' for the judge`);
    }
    const minScore = _get(item, "min_score");
    if (minScore !== null && (!isNumber(minScore) || !(0 <= minScore && minScore <= 1))) {
      throw new Error(`${path}: metric ${_pyRepr(name)} 'min_score:' must be a number in 0..1`);
    }
    metrics.push(
      new EvalSimulationMetric({ name, criterion, minScore: minScore as number | null }),
    );
  });
  return metrics;
}

/** Parse a measured metric: a known measure and at least one bound. */
function _parseMeasure(
  item: Record<string, unknown>,
  name: string,
  measure: unknown,
  path: string,
): EvalSimulationMetric {
  if (!(SIMULATION_MEASURES as readonly unknown[]).includes(measure)) {
    throw new Error(
      `${path}: metric ${_pyRepr(name)} 'measure:' must be one of ${SIMULATION_MEASURES.join(", ")}`,
    );
  }
  if (_has(item, "min_score")) {
    throw new Error(
      `${path}: metric ${_pyRepr(name)} is measured; it takes a range, not 'min_score:'`,
    );
  }
  if (measure === "function_calls") return _parseCallsMeasure(item, name, path);
  if (_has(item, "calls")) {
    throw new Error(
      `${path}: metric ${_pyRepr(name)} takes a range; 'calls:' belongs to 'measure: function_calls'`,
    );
  }
  const bounds: { min_value: number | null; max_value: number | null } = {
    min_value: null,
    max_value: null,
  };
  for (const key of ["min_value", "max_value"] as const) {
    const value = _get(item, key);
    if (value !== null && !isNumber(value)) {
      throw new Error(`${path}: metric ${_pyRepr(name)} '${key}:' must be a number`);
    }
    bounds[key] = value as number | null;
  }
  if (bounds.min_value === null && bounds.max_value === null) {
    throw new Error(`${path}: metric ${_pyRepr(name)} needs a 'min_value:' or a 'max_value:'`);
  }
  return new EvalSimulationMetric({
    name,
    measure: measure as string,
    minValue: bounds.min_value,
    maxValue: bounds.max_value,
  });
}

/** Parse a `function_calls` metric: the list of calls the bot should make. */
function _parseCallsMeasure(
  item: Record<string, unknown>,
  name: string,
  path: string,
): EvalSimulationMetric {
  if (_has(item, "min_value") || _has(item, "max_value")) {
    throw new Error(
      `${path}: metric ${_pyRepr(name)} compares the bot's calls with 'calls:', not a range`,
    );
  }
  const raw = _get(item, "calls");
  if (!Array.isArray(raw)) {
    throw new Error(
      `${path}: metric ${_pyRepr(name)} needs a 'calls:' list, the calls the bot should make ` +
        "([] for none)",
    );
  }
  const calls: EvalFunctionCall[] = [];
  raw.forEach((entry, idx) => {
    if (typeof entry === "string" && entry) {
      calls.push(new EvalFunctionCall({ name: entry }));
      return;
    }
    if (_isDict(entry) && typeof entry.name === "string" && entry.name) {
      const args = _get(entry, "args");
      if (args !== null && !_isDict(args)) {
        throw new Error(
          `${path}: metric ${_pyRepr(name)} 'calls:' entry #${idx} 'args:' must be a mapping`,
        );
      }
      calls.push(new EvalFunctionCall({ name: entry.name, args }));
      return;
    }
    throw new Error(
      `${path}: metric ${_pyRepr(name)} 'calls:' entry #${idx} must be a name or a mapping with 'name:'`,
    );
  });
  return new EvalSimulationMetric({ name, measure: "function_calls", calls });
}

function _positiveInt(
  data: Record<string, unknown>,
  key: string,
  fallback: number,
  path: string,
): number {
  const value = _get(data, key, fallback);
  // DIVERGENCE: JS numbers carry no int/float distinction, so an integral float
  // (`max_turns: 10.0`) is accepted where upstream rejects it.
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error(`${path}: '${key}:' must be a positive integer`);
  }
  return value;
}

function _positiveNumber(
  data: Record<string, unknown>,
  key: string,
  fallback: number,
  path: string,
): number {
  const value = _get(data, key, fallback);
  if (typeof value !== "number" || !(value > 0)) {
    throw new Error(`${path}: '${key}:' must be a positive number`);
  }
  return value;
}

export interface DescribeSimulationOptions {
  /** When true, ANSI-color the keywords as `describeConfig` does. */
  color?: boolean;
}

/**
 * Three-line summary of a simulation's user config, judge config, and goal, for pre-run logs.
 *
 * The lines of `describeConfig`, the `user` line also naming the persona LLM
 * that plays the user and the run's caps, then the caller's goal, e.g.:
 *
 * ```
 * user  -> modality: text | persona: ollama/gemma4:12b | max_turns: 8 | max_duration_s: 120 | max_silence_s: 30
 * judge -> modality: text | eval: ollama/gemma4:12b
 * goal  -> Book a table for two at 6 PM, then end the call.
 * ```
 *
 * @param simulation The parsed simulation to summarize.
 * @param options `color`: ANSI-color the keywords.
 * @returns The summary, one line per section.
 */
export function describeSimulation(
  simulation: EvalSimulationScenario,
  options: DescribeSimulationOptions = {},
): string {
  const user: _ConfigSegment[] = [
    ..._userSegments(simulation),
    ["persona", _llmIdentity(simulation.simulator), _CFG_EVAL],
    ["max_turns", String(simulation.maxTurns), _CFG_LIMIT],
    ["max_duration_s", _formatG(simulation.maxDurationS), _CFG_LIMIT],
    ["max_silence_s", _formatG(simulation.maxSilenceS), _CFG_LIMIT],
  ];
  const goal = simulation.goal.split(/\s+/).filter(Boolean).join(" ");
  const lines: _ConfigLine[] = [
    ["user", user],
    ["judge", _judgeSegments(simulation)],
    ["goal", goal],
  ];
  return _configLines(lines, { color: options.color ?? false });
}
