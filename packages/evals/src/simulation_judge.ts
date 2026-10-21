// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/evals/simulation_judge.py

/**
 * Judges a conversation against a simulation's `success` and its criterion metrics.
 *
 * The simulation driver judges a run with it when the run ends, and `pipecat
 * eval judge` judges saved conversation files with it, so a conversation gets
 * the same verdicts either way. Measured metrics are not its part: they come
 * from a live run, not from what was said.
 */

import { pyJsonDumps } from "@pipedog/core/utils/py_json";
import { EvalJudge, type JudgeVerdict } from "./judge.ts";
import {
  EvalSimulationMetricScore,
  EvalSimulationTurnVerdict,
  type EvalTrace,
  pyFormatFixed,
} from "./results.ts";
import { _pyTruthy } from "./scenario_config.ts";
import type { EvalSimulationMetric, EvalSimulationScenario } from "./simulation.ts";

type Dict = Record<string, unknown>;

/** Options for {@link EvalSimulationJudgement}. */
export interface EvalSimulationJudgementOptions {
  /** The verdict on the simulation's `success`: `yes`, `no`, or `none` when the judge gave none. */
  goal: JudgeVerdict;
  /** The criterion metrics' outcomes, in the simulation's order. */
  metrics: EvalSimulationMetricScore[];
}

/** What the judge decided about one conversation. */
export class EvalSimulationJudgement {
  goal: JudgeVerdict;
  metrics: EvalSimulationMetricScore[];

  constructor(options: EvalSimulationJudgementOptions) {
    this.goal = options.goal;
    this.metrics = options.metrics;
  }
}

/** Options for {@link EvalSimulationJudge}. */
export interface EvalSimulationJudgeOptions {
  /**
   * The judge to ask, which should not have seen any conversation yet; `null`
   * builds one for each conversation.
   */
  judge?: EvalJudge | null;
  /**
   * For the judges it builds, a `yes` less sure than this is explained too
   * (above 1, every verdict is); `null` keeps the simulation's `judge` config.
   */
  explainBelow?: number | null;
  /** The run's trace, to log each verdict in, or `null`. */
  trace?: EvalTrace | null;
}

/**
 * Judges conversations against a simulation.
 *
 * Each conversation is judged by a judge built from the simulation's `judge`
 * config, closed once the conversation is judged. A judge passed in is used
 * instead and left open for its owner to close; it keeps the conversation it
 * is told, so it judges one conversation.
 *
 * @example
 * const scenario = (await EvalScenarioFile.load("book_table.yaml")).get("book_table/available");
 * const messages = JSON.parse(await readFile("run.conversation.json", "utf8"));
 * const judgement = await new EvalSimulationJudge(scenario).judge(messages);
 */
export class EvalSimulationJudge {
  protected _simulation: EvalSimulationScenario;
  protected _judge: EvalJudge | null;
  protected _explainBelow: number | null;
  protected _trace: EvalTrace | null;

  /**
   * Initialize the simulation judge.
   *
   * @param simulation The simulation whose `success` and metrics to judge.
   * @param options.judge The judge to ask; `null` builds one for each conversation.
   * @param options.explainBelow For the judges it builds, a `yes` less sure
   *   than this is explained too; `null` keeps the simulation's `judge` config.
   * @param options.trace The run's trace, to log each verdict in, or `null`.
   */
  constructor(simulation: EvalSimulationScenario, options: EvalSimulationJudgeOptions = {}) {
    this._simulation = simulation;
    this._judge = options.judge ?? null;
    this._explainBelow = options.explainBelow ?? null;
    this._trace = options.trace ?? null;
  }

  /** A `tool_call` message as the judge reads it: the call, and a line more when it was cancelled. */
  static callLines(message: Dict): string[] {
    const name = message.name as string;
    const args = message.arguments;
    const lines = [`${name}(${_pyTruthy(args) ? pyJsonDumps(args) : ""})`];
    if (message.cancelled) {
      lines.push(`${name} was cancelled`);
    }
    return lines;
  }

  /**
   * Judge a conversation, its messages as a conversation file holds them.
   *
   * @param messages The conversation (see `conversation.ts`).
   * @returns The verdict on the goal and the criterion metrics' outcomes.
   */
  async judge(messages: Dict[]): Promise<EvalSimulationJudgement> {
    if (this._judge !== null) {
      return await this._ask(this._judge, messages);
    }
    const judge = await this._buildJudge();
    try {
      return await this._ask(judge, messages);
    } finally {
      await judge.close();
    }
  }

  /** A judge from the simulation's `judge` config. */
  protected async _buildJudge(): Promise<EvalJudge> {
    const config: Dict = { ...this._simulation.judge };
    if (this._explainBelow !== null) {
      config.explain_below = this._explainBelow;
    }
    return await EvalJudge.fromConfig(config);
  }

  /** Tell the judge the conversation and ask it about the goal and the criteria. */
  protected async _ask(judge: EvalJudge, messages: Dict[]): Promise<EvalSimulationJudgement> {
    this._tellJudge(judge, messages);
    const criteria: Record<string, string> = {};
    for (const m of this._simulation.metrics) {
      if (m.criterion) criteria[m.name] = m.criterion;
    }
    const judged = await judge.evaluateRun(criteria, this._simulation.success);
    const metrics = this._simulation.metrics
      .filter((metric) => metric.criterion)
      .map((metric) => this._score(metric, judged.turns[metric.name] ?? []));
    return new EvalSimulationJudgement({ goal: judged.goal, metrics });
  }

  /** Log a line in the run's trace, when there is one. */
  protected _log(line: string): void {
    if (this._trace !== null) {
      this._trace.log(line);
    }
  }

  /** Give the judge the conversation, each tool call where it was made. */
  protected _tellJudge(judge: EvalJudge, messages: Dict[]): void {
    const calls: string[] = [];
    for (const message of messages) {
      if (message.role === "user") {
        judge.addUserMessage(message.content as string);
      } else if (message.role === "assistant") {
        judge.addAssistantMessage(message.content as string);
      } else if (message.role === "tool_call") {
        for (const line of EvalSimulationJudge.callLines(message)) {
          judge.addToolCall(line);
          calls.push(line);
        }
      }
    }
    if (calls.length > 0) {
      this._log(`judge: the bot's tool calls: ${calls.join("; ")}`);
    }
  }

  /**
   * A metric's score over its turn verdicts: the share of turns that passed.
   *
   * A metric that fell short only on turns the judge left unanswered is judge
   * trouble, and its failure kind says so.
   */
  protected _score(
    metric: EvalSimulationMetric,
    judged: JudgeVerdict[],
  ): EvalSimulationMetricScore {
    const verdicts = judged.map(
      (verdict, i) =>
        new EvalSimulationTurnVerdict({
          turn: i + 1,
          passed: verdict.verdict === "yes",
          reason: verdict.reason,
          verdict: verdict.verdict,
          confidence: verdict.confidence,
          probabilities: verdict.probabilities,
        }),
    );
    for (const verdict of verdicts) {
      this._log(`judge: turn ${verdict.turn} ${metric.name} ${verdict.verdict}: ${verdict.reason}`);
    }
    let failureKind: string | null = null;
    let score: number | null;
    let reason: string;
    let passed: boolean;
    if (verdicts.length === 0) {
      score = null;
      reason = "no bot turn to judge";
      passed = true;
    } else {
      score = verdicts.filter((v) => v.passed).length / verdicts.length;
      const failed = verdicts.filter((v) => !v.passed);
      reason =
        failed.length === 0
          ? `all ${verdicts.length} turn(s)`
          : failed.map((v) => `turn ${v.turn}: ${v.reason}`).join("; ");
      passed = metric.minScore === null || score >= metric.minScore;
      if (!passed) {
        failureKind = failed.some((v) => v.verdict === "no") ? "judge_no" : "judge_no_verdict";
      }
    }
    this._log(
      `judge: ${metric.name} = ${score === null ? "unscored" : pyFormatFixed(score, 2)}` +
        `${passed ? "" : ` (below ${pyFormatFixed(metric.minScore as number, 2)})`}: ${reason}`,
    );
    return new EvalSimulationMetricScore({
      name: metric.name,
      score,
      passed,
      reason,
      minScore: metric.minScore,
      verdicts,
      failureKind,
      criterion: metric.criterion,
    });
  }
}
