// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/evals/scenario.py

/**
 * Scenario files for Pipecat behavioral evaluations, of either kind.
 *
 * A scenario describes one conversation to hold with a bot and how to judge it.
 * A file holds one or more of them under `scenarios:`, each with a `name:`,
 * and a scenario's keys say which kind it is:
 *
 * - `turns:`: a *scripted* scenario: the user's turns are written out, each
 *   with the events expected back from the bot (`script.ts`).
 * - `persona:`: a *simulated* scenario, a simulation for short: an LLM plays a
 *   caller with a goal, and a judge reads the whole conversation
 *   (`simulation.ts`).
 *
 * Both carry the same `user:` and `judge:` blocks (`scenario_config.ts`). A
 * file is read by a `SafeLoader` that resolves only plain-decimal integers, so
 * a DTMF `012` keeps its digits, with an `!include <path>` tag that splices in
 * another YAML file relative to the including one, so files can share their
 * `user:` and `judge:` blocks.
 *
 * Any key a scenario can have may also sit at the top of the file. There it is
 * the default for every scenario in the file. A scenario that sets the same key
 * replaces the whole value; nothing is merged, so a `context:` is written out in
 * full, never added to. A scenario is named `<file name>/<scenario name>`.
 *
 * Most files hold one scenario. A file holds several when they test one behavior
 * through many short conversations:
 *
 * ```yaml
 * name: turn_completion
 * judge: !include ../judge_text.yaml
 * context:
 *   - role: system
 *     content: "You are a travel assistant."
 *
 * scenarios:
 *   - name: short_answer
 *     turns:
 *       - user: "Japan."
 *         expect:
 *           - event: response
 *   - name: with_history
 *     context:                      # replaces the file's context
 *       - role: system
 *         content: "You are a travel assistant."
 *       - role: assistant
 *         content: "Where would you go?"
 *     turns:
 *       - user: "Japan."
 *         expect:
 *           - event: response
 * ```
 *
 * `turns:` and `persona:` may sit at the top too. That is for a file whose
 * scenarios hold the same conversation and differ in one thing only. Two common
 * shapes:
 *
 * The same turns, judged differently. The turns are written once, and each
 * scenario names its own judge or modality, so every judge sees exactly the same
 * conversation:
 *
 * ```yaml
 * name: interruption
 * turns:
 *   - user: "Tell me a long story about Paris."
 *     expect:
 *       - event: llm_started
 *   - user: "Actually, what's the capital of Japan?"
 *     send_after: {event: llm_started, delay_ms: 2000}
 *     expect:
 *       - event: bot_interrupted
 *       - event: response
 *         eval: "says Tokyo instead of continuing the story"
 *
 * scenarios:
 *   - name: text
 *     judge: !include ../judge_text.yaml
 *   - name: audio
 *     user: !include ../user_audio.yaml
 *     judge: !include ../judge_audio.yaml
 * ```
 *
 * The same caller, with different goals. The persona and what counts as success
 * are written once, and each scenario gives the caller a different errand:
 *
 * ```yaml
 * name: diner
 * persona: "Jamie, calling a restaurant. Friendly and to the point."
 * success: "the bot did what the caller asked and confirmed it"
 *
 * scenarios:
 *   - name: book
 *     goal: "Book a table for two at 6 PM tonight, then end the call."
 *   - name: cancel
 *     goal: "Cancel tonight's booking under the name Jamie, then end the call."
 * ```
 *
 * The scenarios of a file are independent: each runs on its own, against its
 * own bot.
 *
 * This module gathers the public names of both kinds, `EvalScenarioFile`
 * loads a file as the scenarios it holds, and `isScenarioFile` tells a
 * scenario from a fragment it includes.
 *
 * Porting notes: the deprecated flat file shape (a scenario's own keys at the
 * top level and no `scenarios:` list) is not ported: such a file is rejected
 * as having no `scenarios:` list. The deprecated `load_scenario_file`,
 * `EvalScenario` and `EvalTurn` are not ported either. Loading reads files, so
 * `EvalScenarioFile.load`, `isScenarioFile` and `_loadMapping` are async; they
 * import `node:fs` lazily, so importing this module stays runtime-agnostic.
 */

import { rethrowIfCancelled } from "@pipedog/asyncio";
import { addImplicitResolver, includeLoader, load, SafeLoader } from "@pipedog/core/utils/yaml";
import { _get, _isDict, _pyRepr, _pyTruthy } from "./scenario_config.ts";
import { _parseScript, type EvalScriptScenario } from "./script.ts";
import { _parseSimulation, type EvalSimulationScenario } from "./simulation.ts";

export {
  describeConfig,
  type EvalConfigured,
} from "./scenario_config.ts";
export {
  EvalExpectation,
  EvalFunctionCall,
  EvalScriptScenario,
  EvalScriptTurn,
  EvalSendAfter,
  FUNCTION_CALL_EVENTS,
  JUDGEABLE_EVENTS,
} from "./script.ts";
export {
  describeSimulation,
  EvalSimulationMetric,
  EvalSimulationScenario,
} from "./simulation.ts";

const INT_TAG = "tag:yaml.org,2002:int";

/**
 * A SafeLoader that reads only plain decimal numbers as ints.
 *
 * YAML 1.1 would read `010` as octal and `0x10` as hex, which rewrites a
 * DTMF sequence before the scenario sees it. With those resolvers dropped,
 * `dtmf: 123` still loads as an int and `dtmf: 012` stays a string.
 */
class _ScenarioLoader extends SafeLoader {}

// Strip the inherited int resolvers (which match octal/hex/binary/sexagesimal)
// and register a decimal-only replacement. Underscores stay allowed to match
// YAML's grouping syntax (e.g. `1_000`); a leading zero (`012`) no longer
// matches, so such tokens load as strings.
_ScenarioLoader.yamlImplicitResolvers = new Map(
  [...SafeLoader.yamlImplicitResolvers].map(([ch, resolvers]) => [
    ch,
    resolvers.filter(([tag]) => tag !== INT_TAG),
  ]),
);
addImplicitResolver(INT_TAG, /^[-+]?(?:0|[1-9][0-9_]*)$/, [..."-+0123456789"], {
  Loader: _ScenarioLoader,
});

/** The two kinds of scenario, as a run, a session, and a results record name them. */
export const EvalKind = {
  SCRIPT: "script",
  SIMULATION: "simulation",
} as const;
export type EvalKind = (typeof EvalKind)[keyof typeof EvalKind];

export type EvalLoadedScenario = EvalScriptScenario | EvalSimulationScenario;

export interface EvalScenarioFileOptions {
  name: string;
  path: string;
  scenarios: EvalLoadedScenario[];
}

/**
 * A scenario file: what it is called, where it is, and the scenarios it holds.
 *
 * Manifests and `pipedog-eval run` load files through `load`, so the two kinds
 * of scenario mix in one list. `file.get(name)` picks a scenario by its
 * `<file name>/<scenario name>`.
 */
export class EvalScenarioFile implements Iterable<EvalLoadedScenario> {
  /** The file's `name:`. */
  name: string;
  /** The file it was read from. */
  path: string;
  /** The scenarios it holds, in file order. */
  scenarios: EvalLoadedScenario[];

  constructor(options: EvalScenarioFileOptions) {
    this.name = options.name;
    this.path = options.path;
    this.scenarios = options.scenarios;
  }

  /**
   * Read a scenario file, parsing each scenario as whichever kind it is.
   *
   * @param path Path to a scenario YAML file.
   * @returns The loaded file.
   * @throws Error If the file is malformed, or a scenario is neither kind,
   *   claims to be both, or is invalid for its kind (upstream: ValueError); or
   *   the path doesn't exist (`ENOENT`, upstream: FileNotFoundError).
   */
  static async load(path: string): Promise<EvalScenarioFile> {
    const data = await _loadMapping(path);
    const name = _get(data, "name");
    if (!_pyTruthy(name) || typeof name !== "string") {
      throw new Error(`${path}: missing or invalid 'name:' field`);
    }

    // DIVERGENCE: upstream still loads a file without `scenarios:` (the flat
    // shape, deprecated since 1.11.0) as its one scenario; it is not ported,
    // so such a file fails here.
    const entries = _get(data, "scenarios");
    if (!Array.isArray(entries) || !entries.length) {
      throw new Error(`${path}: 'scenarios:' must be a non-empty list`);
    }
    const defaults = Object.fromEntries(
      Object.entries(data).filter(([key]) => key !== "scenarios"),
    );

    const scenarios: EvalLoadedScenario[] = [];
    for (const [idx, entry] of entries.entries()) {
      if (!_isDict(entry)) throw new Error(`${path}: scenario #${idx} must be a mapping`);
      if (Object.hasOwn(entry, "scenarios")) {
        throw new Error(`${path}: scenario #${idx} cannot hold a 'scenarios:' list of its own`);
      }
      const entryName = _get(entry, "name");
      if (!_pyTruthy(entryName) || typeof entryName !== "string") {
        throw new Error(`${path}: scenario #${idx} needs a 'name:'`);
      }
      const merged = { ...defaults, ...entry, name: `${name}/${entryName}` };
      scenarios.push(await _scenarioFromMapping(merged, path));
    }

    const names = scenarios.map((scenario) => scenario.name);
    const duplicates = [...new Set(names.filter((n, i) => names.indexOf(n) !== i))].sort();
    if (duplicates.length) {
      throw new Error(`${path}: duplicate scenario names: ${duplicates.join(", ")}`);
    }
    return new EvalScenarioFile({ name, path, scenarios });
  }

  /**
   * The scenario called `name` (Python's `file[name]`).
   *
   * @throws Error If the file holds no scenario of that name (upstream: KeyError).
   */
  get(name: string): EvalLoadedScenario {
    for (const scenario of this.scenarios) {
      if (scenario.name === name) return scenario;
    }
    const names = this.scenarios.map((scenario) => scenario.name).join(", ");
    throw new Error(`${this.path}: no scenario called ${_pyRepr(name)} (has ${names})`);
  }

  /** Iterate over the scenarios, in file order. */
  [Symbol.iterator](): Iterator<EvalLoadedScenario> {
    return this.scenarios[Symbol.iterator]();
  }

  /** How many scenarios the file holds (Python's `len(file)`). */
  get length(): number {
    return this.scenarios.length;
  }
}

/**
 * Load a scenario file's top-level mapping, resolving `!include` tags relative to the file.
 *
 * @throws Error If the top level is not a mapping (upstream: ValueError).
 */
export async function _loadMapping(path: string): Promise<Record<string, unknown>> {
  const { readFile } = await import("node:fs/promises");
  const { readFileSync } = await import("node:fs");
  const { dirname } = await import("node:path");
  const text = await readFile(path, "utf8");
  const data = load(
    text,
    includeLoader(dirname(path), {
      base: _ScenarioLoader,
      readFile: (p) => readFileSync(p, "utf8"),
    }),
  );
  if (!_isDict(data)) throw new Error(`${path}: top level must be a mapping`);
  return data;
}

/** Parse one scenario's mapping as a simulation (`persona:`) or a script (`turns:`). */
async function _scenarioFromMapping(
  data: Record<string, unknown>,
  path: string,
): Promise<EvalLoadedScenario> {
  const hasPersona = Object.hasOwn(data, "persona");
  const hasTurns = Object.hasOwn(data, "turns");
  if (hasPersona && hasTurns) {
    throw new Error(
      `${path}: a scenario is scripted ('turns:') or a simulation ('persona:'), not both`,
    );
  }
  if (hasPersona) return _parseSimulation(data, path);
  if (hasTurns) return await _parseScript(data, path);
  throw new Error(`${path}: a scenario needs 'turns:' (scripted) or 'persona:' (a simulation)`);
}

/**
 * Whether a YAML file is a scenario of either kind, rather than a fragment one includes.
 *
 * Every scenario has a `name:`; an included fragment has none. A file that
 * does not parse counts as a scenario, so loading it reports the error
 * instead of a directory run skipping it silently.
 *
 * @param path Path to a YAML file.
 * @returns True unless the file parses to a mapping without a `name`.
 */
export async function isScenarioFile(path: string): Promise<boolean> {
  try {
    return Object.hasOwn(await _loadMapping(path), "name");
  } catch (e) {
    // Upstream catches ValueError, OSError and YAMLError: everything loading can raise.
    rethrowIfCancelled(e);
    return true;
  }
}
