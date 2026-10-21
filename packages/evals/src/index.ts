// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/**
 * `@pipedog/evals`: the main public API, re-exported for convenience.
 *
 * pipedog addition: upstream's `pipecat/evals/__init__.py` is empty, and every
 * module stays importable at its own path (`@pipedog/evals/session`, ...).
 *
 * The suite (`EvalSuite`, `EvalManifest`, `EvalRun`) is left out: `suite.ts`
 * imports `node:path` at module level, so it would make this entry Node-only.
 * Import it from `@pipedog/evals/suite`. The modules re-exported here import
 * only `node:async_hooks` (through the log context, as `@pipedog/asyncio`
 * does); file, socket and process work is imported lazily where it is used.
 */

export { EvalJudge, JudgeVerdict, RunVerdicts } from "./judge.ts";
export {
  EvalAssertionFailure,
  EvalExpectationResult,
  type EvalProgress,
  EvalScriptResult,
  EvalScriptTurnProgress,
  EvalScriptTurnResult,
  EvalSimulationMetricScore,
  EvalSimulationProgress,
  EvalSimulationResult,
  EvalSimulationTurnVerdict,
} from "./results.ts";
export { EvalKind, type EvalLoadedScenario, EvalScenarioFile } from "./scenario.ts";
export {
  EvalExpectation,
  EvalFunctionCall,
  EvalScriptScenario,
  EvalScriptTurn,
  EvalSendAfter,
} from "./script.ts";
export { EvalScriptSession } from "./script_session.ts";
export {
  DEFAULT_BOT_READY_TIMEOUT_S,
  DEFAULT_EVENT_TIMEOUT_MS,
  EvalSession,
  EvalSessionParams,
} from "./session.ts";
export { EvalSimulationMetric, EvalSimulationScenario } from "./simulation.ts";
export { EvalSimulationSession } from "./simulation_session.ts";
