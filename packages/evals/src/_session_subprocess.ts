// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/evals/_session_subprocess.py

/**
 * Runs one scenario, scripted or simulated, in its own process.
 *
 * The suite spawns one of these per run so each harness loads its audio
 * models on its own event loop; in one shared process those loads would stall
 * the loop that paces every other run's audio.
 *
 * Invoked as `<bun|node> _session_subprocess.ts <config.json>` (upstream:
 * `python -m pipecat.evals._session_subprocess <config.json>`). The config
 * carries the scenario path, the bot URL, and the run's params; the result is
 * written back as JSON to the `result_path` it names.
 *
 * Importing this module has no side effects: `main()` runs only when the file
 * is the process's entry point.
 */

import { rethrowIfCancelled } from "@pipedog/asyncio";
import { logger } from "@pipedog/core/utils/logger";
import { pyJsonDumps, pyJsonLoads } from "@pipedog/core/utils/py_json";
import type { EvalScriptResult, EvalSimulationResult } from "./results.ts";
import { EvalScenarioFile } from "./scenario.ts";
import { _paramsOptionsFromDict, capturePipelineLogs } from "./suite.ts";

type Dict = Record<string, any>;

/** Build and run the session for the scenario named in `config`, whichever kind it is. */
async function _run(config: Dict): Promise<EvalScriptResult | EvalSimulationResult> {
  const { EvalSession, EvalSessionParams } = await import("./session.ts");
  const loaded = (await EvalScenarioFile.load(config.scenario_path)).get(config.scenario_name);
  const params = new EvalSessionParams(_paramsOptionsFromDict(config.params ?? {}));
  const session = await EvalSession.fromScenario(loaded, config.bot_url, { params });
  return (await session.run()) as EvalScriptResult | EvalSimulationResult;
}

/**
 * Run one scenario from a config file and write its result as JSON.
 *
 * @param argv The arguments after the script: the config file's path.
 * @returns The process's exit code.
 */
export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const fs = await import("node:fs/promises");
  const configPath = argv[0];
  if (configPath === undefined) {
    process.stderr.write("usage: _session_subprocess <config.json>\n");
    return 2;
  }
  const config = pyJsonLoads(await fs.readFile(configPath, "utf8")) as Dict;
  // No console sink: the worker's stdout/stderr is captured to a log file by the
  // suite, and the result comes back through the result file, not stdout.
  logger.setSink();

  // capturePipelineLogs writes <prefix>.debug.log (only under debug) from the
  // harness's per-pipeline log output -- now in this worker process.
  const result = await capturePipelineLogs(
    config.logs_dir,
    config.prefix,
    { name: config.scenario_name, enabled: Boolean(config.debug) },
    () => _run(config),
  );

  await fs.writeFile(config.result_path, pyJsonDumps(result.toDict()));
  return 0;
}

/** Whether this module is the process's entry point (`if __name__ == "__main__":`). */
async function _isMain(): Promise<boolean> {
  const entry = (globalThis as { process?: { argv?: string[] } }).process?.argv?.[1];
  if (!entry) return false;
  try {
    const { realpathSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch (e) {
    rethrowIfCancelled(e);
    return false;
  }
}

if (await _isMain()) {
  process.exitCode = await main();
}
