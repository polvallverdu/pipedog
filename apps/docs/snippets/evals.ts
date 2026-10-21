// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Samples for content/docs/evals.mdx. Type-checked on every docs build.

// #region bot
import { EvalTransportParams } from "@pipedog/evals/transport";
import type { RunnerArguments } from "@pipedog/runner/types";
import { createTransport } from "@pipedog/runner/utils";

const transportParams = {
  // Used when an eval harness connects to the runner's /ws and sends `eval-connect`.
  eval: () => new EvalTransportParams({ audioInEnabled: true, audioOutEnabled: true }),
};

export async function bot(runnerArgs: RunnerArguments) {
  const transport = await createTransport(runnerArgs, transportParams);
  // build and run the pipeline with transport.input() and transport.output()
  void transport;
}

// #endregion bot

// #region factories
// my_evals.ts: the services a scenario names with `factory: ./my_evals.ts.<export>`
import { OpenAILLMSettings } from "@pipedog/openai/base_llm";
import { OpenAILLMService } from "@pipedog/openai/llm";
import { OpenAISTTService } from "@pipedog/openai/stt";
import { OpenAITTSService } from "@pipedog/openai/tts";

type Config = Record<string, unknown>;

/** `judge.eval` and `simulator`: an OpenAI-compatible LLM. */
export function llm(config: Config) {
  return new OpenAILLMService({
    apiKey: process.env.OPENAI_API_KEY ?? null,
    settings: new OpenAILLMSettings({ model: String(config.model ?? "gpt-4.1-mini") }),
  });
}

/** `user.speech`: the voice the harness speaks the user's turns with. */
export function voice(_config: Config) {
  return new OpenAITTSService({ apiKey: process.env.OPENAI_API_KEY ?? null });
}

/** `judge.transcription`: transcribes the bot's speech for `response` checks. */
export function transcriber(_config: Config) {
  return new OpenAISTTService({ apiKey: process.env.OPENAI_API_KEY ?? null });
}

// #endregion factories

// #region session
import {
  EvalScenarioFile,
  EvalScriptResult,
  EvalSession,
  EvalSessionParams,
  type EvalSimulationResult,
} from "@pipedog/evals";

const file = await EvalScenarioFile.load("scenarios/capital.yaml");
for (const scenario of file) {
  const session: EvalSession<EvalScriptResult | EvalSimulationResult> =
    await EvalSession.fromScenario(scenario, "ws://localhost:7860/ws", {
      params: new EvalSessionParams({ defaultTimeoutMs: 30_000 }),
    });
  session.eventHandler("on_progress", async (_session: unknown, progress: unknown) => {
    console.log(progress);
  });
  const result = await session.run();
  console.log(scenario.name, result.passed ? "PASS" : "FAIL");
  if (result instanceof EvalScriptResult) {
    for (const failure of result.failures) console.log(`  ${failure}`);
  }
}
// #endregion session
