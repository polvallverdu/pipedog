// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/evals/script_session.py

/**
 * The scripted session: runs a scripted scenario against a bot.
 *
 * Porting notes: the deprecated `on_progress` callback argument (and
 * `_add_legacy_progress_callback`) and the deprecated knob keyword arguments
 * of `from_scenario` are not ported; use the `on_progress` event handler and
 * `params`. `fromScenario` is async, because building the services is.
 *
 * @example
 * for (const scenario of await EvalScenarioFile.load("scenarios/greeting.yaml")) {
 *   const session = await EvalScriptSession.fromScenario(scenario, "ws://localhost:7860/ws");
 *   const result = await session.run();
 *   if (result.passed) {
 *     console.log(scenario.name, "PASS");
 *   } else {
 *     for (const f of result.failures) console.log(`  ${f}`);
 *   }
 * }
 */

import type { STTService } from "@pipedog/core/services/stt_service";
import { contextualize } from "./_log_context.ts";
import { EvalClient, EvalClientParams } from "./client.ts";
import { EvalEventStream } from "./events.ts";
import { EvalJudge } from "./judge.ts";
import type { EvalScriptResult } from "./results.ts";
import { EvalKind } from "./scenario.ts";
import { describeConfig } from "./scenario_config.ts";
import type { EvalScriptScenario } from "./script.ts";
import { EvalScriptDriver } from "./script_driver.ts";
import { sttServiceFromConfig, ttsServiceFromConfig } from "./services.ts";
import { EvalSession, EvalSessionParams } from "./session.ts";
import type { CachingTTSService } from "./tts.ts";

/** Options for {@link EvalScriptSession}. */
export interface EvalScriptSessionOptions {
  /** How the run behaves; `null` for the defaults. */
  params?: EvalSessionParams | null;
  /** The `EvalJudge` for `eval:` assertions, or `null` if the scenario has none. */
  judge?: EvalJudge | null;
  /** The user-audio TTS, or `null` for text mode. */
  userTts?: CachingTTSService | null;
  /** The bot-audio STT for the `response` transcription, or `null` when the scenario has none. */
  botStt?: STTService | null;
}

/**
 * Runs one `EvalScriptScenario` against a bot.
 *
 * Build one with `fromScenario`, which constructs the judge, the user TTS,
 * and the STT the scenario needs, then await `run`.
 *
 * @example
 * session.eventHandler("on_progress", async (session, progress) => {
 *   console.log(progress.eventName, progress.status);
 * });
 */
export class EvalScriptSession extends EvalSession<EvalScriptResult> {
  protected _scenario: EvalScriptScenario;
  declare protected _driver: EvalScriptDriver;

  /**
   * Initialize the eval session.
   *
   * The services come pre-built, or `null` where the scenario has no use for
   * them; `fromScenario` constructs the ones a scenario needs.
   *
   * @param scenario The parsed scenario to run.
   * @param botUrl WebSocket URL of the bot's eval transport.
   * @param options See {@link EvalScriptSessionOptions}.
   */
  constructor(
    scenario: EvalScriptScenario,
    botUrl: string,
    options: EvalScriptSessionOptions = {},
  ) {
    super({ kind: EvalKind.SCRIPT, name: scenario.name, botUrl, params: options.params });
    this._scenario = scenario;
    // The bot's output as events: fed by the client's pipeline, read by the driver.
    this._stream = new EvalEventStream({ botAudio: scenario.botAudio, trace: this._trace });
    // The connection to the bot: the eval pipeline and the user's sends,
    // asking the bot for what the scenario's assertions need.
    this._client = new EvalClient(botUrl, {
      params: new EvalClientParams({
        botAudio: scenario.botAudio,
        userAudio: scenario.userAudio,
        userSpeech: scenario.userSpeech,
        captureBotAudio: scenario.wantsResponse(),
        captureBotImages: scenario.needsBotImages(),
        reportLevel: scenario.requiredReportLevel(),
        vadEvents: scenario.needsVadEvents(),
        markerEvents: scenario.needsMarkerEvents(),
        context: [...(scenario.context ?? [])],
      }),
      sessionParams: this._params,
      stream: this._stream,
      trace: this._trace,
      userTts: options.userTts ?? null,
      botStt: options.botStt ?? null,
    });
    // What the user says next and how the outcome is scored: a scenario is
    // played by the eval driver.
    this._driver = new EvalScriptDriver({
      scenario,
      defaultTimeoutMs: this._params.defaultTimeoutMs,
      client: this._client,
      stream: this._stream,
      judge: options.judge ?? null,
      trace: this._trace,
      progress: (record) => this._progress(record),
    });
  }

  /**
   * Build a ready-to-run session from a scenario, constructing the services it needs.
   *
   * Pass `judge`, `userTts`, or `botStt` to use your own. Then await `run`.
   *
   * @example
   * const session = await EvalScriptSession.fromScenario(scenario, "ws://localhost:7860/ws");
   * const result = await session.run();
   *
   * @param scenario The parsed scenario to run.
   * @param botUrl WebSocket URL of the bot's eval transport.
   * @param options `params`; `judge` (default: built from `scenario.judge` when
   *   the scenario has `eval:` assertions); `userTts` (default: built from
   *   `scenario.userSpeech` in audio mode); `botStt` (default: built from
   *   `scenario.transcriber` when the scenario asserts `response`).
   * @returns A configured session, ready for `run`.
   */
  static override async fromScenario(
    scenario: EvalScriptScenario,
    botUrl: string,
    options: EvalScriptSessionOptions = {},
  ): Promise<EvalScriptSession> {
    const params = options.params ?? new EvalSessionParams();
    let judge = options.judge ?? null;
    let userTts = options.userTts ?? null;
    let botStt = options.botStt ?? null;

    const turns = scenario.turns;
    if (judge === null && turns.some((turn) => turn.expect.some((exp) => exp.eval !== null))) {
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

    if (botStt === null && scenario.wantsResponse() && scenario.botAudio) {
      botStt = await contextualize({ eval_pipeline: "transcription" }, () =>
        sttServiceFromConfig(scenario.transcriber),
      );
    }

    return new EvalScriptSession(scenario, botUrl, { params, judge, userTts, botStt });
  }

  protected _describe(): string {
    return describeConfig(this._scenario);
  }

  protected override _skipReason(): string | null {
    // The `response` transcription needs the bot's actual audio; without audio
    // mode there's nothing to transcribe, so skip rather than fail. (Normally
    // unreachable: loading a scenario resolves `response` to llm_response in
    // text modality; this guards Scenarios built directly.)
    if (this._scenario.wantsResponse() && !this._scenario.botAudio) {
      return "asserts 'response' transcription but judge modality is text (no audio)";
    }
    return null;
  }
}
