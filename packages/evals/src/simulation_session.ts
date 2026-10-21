// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/evals/simulation_session.py

/**
 * The simulation session: runs a simulated scenario against a bot.
 *
 * Porting note: the deprecated `trigger_disconnect` scenario field is not
 * ported. `fromScenario` is async, because building the services is.
 *
 * @example
 * for (const scenario of await EvalScenarioFile.load("scenarios/simulated/curious_caller.yaml")) {
 *   const session = await EvalSimulationSession.fromScenario(scenario, "ws://localhost:7860/ws");
 *   const run = await session.run();
 *   console.log(`${run.succeeded ? "succeeded" : "failed"}: ${run.reason}`);
 * }
 */

import type { LLMService } from "@pipedog/core/services/llm_service";
import type { STTService } from "@pipedog/core/services/stt_service";
import { contextualize } from "./_log_context.ts";
import { EvalClient, EvalClientParams } from "./client.ts";
import { EvalEventStream } from "./events.ts";
import { EvalJudge } from "./judge.ts";
import { EvalPersona } from "./persona.ts";
import type { EvalSimulationResult } from "./results.ts";
import { EvalKind } from "./scenario.ts";
import { llmServiceFromConfig, sttServiceFromConfig, ttsServiceFromConfig } from "./services.ts";
import { EvalSession, EvalSessionParams } from "./session.ts";
import { describeSimulation, type EvalSimulationScenario } from "./simulation.ts";
import { EvalSimulationDriver } from "./simulation_driver.ts";
import type { CachingTTSService } from "./tts.ts";

/** Options for {@link EvalSimulationSession}. */
export interface EvalSimulationSessionOptions {
  /** How the run behaves; `null` for the defaults. */
  params?: EvalSessionParams | null;
  /** The persona LLM service, run inside the eval pipeline. */
  personaLlm: LLMService;
  /** The judge for the goal and the quality criteria, or `null` (the run then reports no verdict). */
  judge: EvalJudge | null;
  /** The user-audio TTS, or `null` for text mode. */
  userTts?: CachingTTSService | null;
  /** The bot-audio STT, or `null` in text mode. */
  botStt?: STTService | null;
}

/** Options for {@link EvalSimulationSession.fromScenario}. */
export interface EvalSimulationSessionFromScenarioOptions {
  /** How the run behaves; `null` for the defaults. */
  params?: EvalSessionParams | null;
  /** Override the persona LLM (default: built from `simulation.simulator`). */
  personaLlm?: LLMService | null;
  /** Override the judge (default: built from `simulation.judge`). */
  judge?: EvalJudge | null;
  /** Override the user-audio TTS (default: built from `simulation.userSpeech` in audio mode). */
  userTts?: CachingTTSService | null;
  /** Override the bot-audio STT (default: built from `simulation.transcriber` in audio mode). */
  botStt?: STTService | null;
}

/**
 * Runs one `EvalSimulationScenario` against a bot.
 *
 * The persona LLM answers the bot on its own inside the client's pipeline,
 * and the judge decides the goal and the criteria at the end. Build one with
 * `fromScenario`, which constructs the persona LLM, the judge, and in audio
 * mode the user TTS and the STT, then await `run`.
 */
export class EvalSimulationSession extends EvalSession<EvalSimulationResult> {
  protected _scenario: EvalSimulationScenario;
  declare protected _driver: EvalSimulationDriver;

  /**
   * Initialize the simulation session.
   *
   * @param scenario The parsed simulation to run.
   * @param botUrl WebSocket URL of the bot's eval transport.
   * @param options See {@link EvalSimulationSessionOptions}.
   */
  constructor(
    scenario: EvalSimulationScenario,
    botUrl: string,
    options: EvalSimulationSessionOptions,
  ) {
    super({ kind: EvalKind.SIMULATION, name: scenario.name, botUrl, params: options.params });
    this._scenario = scenario;
    const persona = new EvalPersona(scenario.persona, scenario.goal, options.personaLlm);
    this._stream = new EvalEventStream({ botAudio: scenario.botAudio, trace: this._trace });
    // The persona hears the bot, and the judge sees its tool calls.
    this._client = new EvalClient(botUrl, {
      params: new EvalClientParams({
        botAudio: scenario.botAudio,
        userAudio: scenario.userAudio,
        userSpeech: scenario.userSpeech,
        captureBotAudio: scenario.botAudio,
        // The bot's function calls, with their arguments, are the judge's
        // evidence of what the bot actually did.
        reportLevel: "full",
      }),
      sessionParams: this._params,
      stream: this._stream,
      trace: this._trace,
      persona,
      userTts: options.userTts ?? null,
      botStt: options.botStt ?? null,
    });
    this._driver = new EvalSimulationDriver({
      simulation: scenario,
      persona,
      client: this._client,
      stream: this._stream,
      judge: options.judge,
      trace: this._trace,
      progress: (record) => this._progress(record),
    });
  }

  /**
   * Build a ready-to-run session from a scenario, constructing the services it needs.
   *
   * Pass `personaLlm`, `judge`, `userTts`, or `botStt` to use your own.
   *
   * @param scenario The parsed simulation to run.
   * @param botUrl WebSocket URL of the bot's eval transport.
   * @param options See {@link EvalSimulationSessionFromScenarioOptions}.
   * @returns A configured session, ready for `run`.
   */
  static override async fromScenario(
    scenario: EvalSimulationScenario,
    botUrl: string,
    options: EvalSimulationSessionFromScenarioOptions = {},
  ): Promise<EvalSimulationSession> {
    const params = options.params ?? new EvalSessionParams();
    let personaLlm = options.personaLlm ?? null;
    let judge = options.judge ?? null;
    let userTts = options.userTts ?? null;
    let botStt = options.botStt ?? null;
    if (personaLlm === null) {
      personaLlm = await contextualize({ eval_pipeline: "persona" }, () =>
        llmServiceFromConfig(scenario.simulator, { where: "simulator" }),
      );
    }
    if (judge === null) {
      judge = await contextualize({ eval_pipeline: "judge" }, () =>
        EvalJudge.fromConfig(scenario.judge),
      );
    }
    if (userTts === null && scenario.userSpeech !== null) {
      const userSpeech = scenario.userSpeech;
      userTts = await contextualize({ eval_pipeline: "speech" }, () =>
        ttsServiceFromConfig(userSpeech, { cacheDir: params.cacheDir, useCache: params.useCache }),
      );
    }
    if (botStt === null && scenario.botAudio) {
      botStt = await contextualize({ eval_pipeline: "transcription" }, () =>
        sttServiceFromConfig(scenario.transcriber),
      );
    }
    return new EvalSimulationSession(scenario, botUrl, {
      params,
      personaLlm,
      judge,
      userTts,
      botStt,
    });
  }

  protected _describe(): string {
    return describeSimulation(this._scenario);
  }
}
