// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_evals_simulation_judge.py

import { describe, expect, spyOn, test } from "bun:test";
import { EvalJudge, JudgeVerdict, RunVerdicts } from "../src/judge.ts";
import { EvalTrace } from "../src/results.ts";
import { EvalSimulationMetric, EvalSimulationScenario } from "../src/simulation.ts";
import { EvalSimulationJudge } from "../src/simulation_judge.ts";

/** Records the conversation it is told, and passes every turn but the ones in `failing`. */
class _FakeJudge {
  goal: string;
  failing: number[];
  transcript: { role: string; content: string }[] = [];
  criteria: Record<string, string> = {};
  closed = false;

  constructor(goal = "yes", failing: number[] = []) {
    this.goal = goal;
    this.failing = failing;
  }

  addUserMessage(text: string): void {
    this.transcript.push({ role: "user", content: text });
  }

  addAssistantMessage(text: string): void {
    this.transcript.push({ role: "assistant", content: text });
  }

  addToolCall(text: string): void {
    this.transcript.push({ role: "tool", content: text });
  }

  async evaluateRun(criteria: Record<string, string>, success: string): Promise<RunVerdicts> {
    this.criteria = { ...criteria };
    const turns = this.transcript.filter((e) => e.role === "assistant").length;
    const byName: Record<string, JudgeVerdict[]> = {};
    for (const name of Object.keys(criteria)) {
      byName[name] = [];
      for (let turn = 1; turn <= turns; turn++) {
        byName[name].push(
          new JudgeVerdict({
            verdict: this.failing.includes(turn) ? "no" : "yes",
            reason: `turn ${turn} ${name}`,
            rawResponse: "",
          }),
        );
      }
    }
    return new RunVerdicts({
      goal: new JudgeVerdict({ verdict: this.goal, reason: `because ${success}`, rawResponse: "" }),
      turns: byName,
    });
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

function asJudge(judge: _FakeJudge): EvalJudge {
  return judge as unknown as EvalJudge;
}

function _simulation(metrics: EvalSimulationMetric[]): EvalSimulationScenario {
  return new EvalSimulationScenario({
    name: "book/available",
    persona: "A caller.",
    goal: "Book a table.",
    success: "the bot booked a table",
    metrics,
  });
}

const MESSAGES = [
  { role: "user", content: "A table at six." },
  { role: "tool_call", name: "check", arguments: { time: "6" }, cancelled: false },
  { role: "tool_call", name: "book", arguments: {}, cancelled: true },
  { role: "assistant", content: "Six is free." },
  { role: "user", content: "Thanks." },
  { role: "assistant", content: "Bye." },
];

describe("TestSimulationJudge", () => {
  test("test_the_judge_reads_the_conversation_with_each_call_in_place", async () => {
    const judge = new _FakeJudge();
    await new EvalSimulationJudge(_simulation([]), { judge: asJudge(judge) }).judge(MESSAGES);
    expect(judge.transcript).toEqual([
      { role: "user", content: "A table at six." },
      { role: "tool", content: 'check({"time": "6"})' },
      { role: "tool", content: "book()" },
      { role: "tool", content: "book was cancelled" },
      { role: "assistant", content: "Six is free." },
      { role: "user", content: "Thanks." },
      { role: "assistant", content: "Bye." },
    ]);
    // A judge passed in is its owner's to close.
    expect(judge.closed).toBe(false);
  });

  test("test_without_a_judge_each_conversation_gets_one_built_and_closed", async () => {
    const configs: Record<string, unknown>[] = [];
    const built: _FakeJudge[] = [];

    const spy = spyOn(EvalJudge, "fromConfig").mockImplementation(async (config) => {
      configs.push(config as Record<string, unknown>);
      built.push(new _FakeJudge());
      return asJudge(built[built.length - 1]!);
    });
    const simulation = _simulation([
      new EvalSimulationMetric({ name: "politeness", criterion: "stays polite" }),
    ]);
    const simulationJudge = new EvalSimulationJudge(simulation, { explainBelow: 2 });
    let judgement: Awaited<ReturnType<EvalSimulationJudge["judge"]>>;
    try {
      await simulationJudge.judge(MESSAGES);
      judgement = await simulationJudge.judge(MESSAGES);
    } finally {
      spy.mockRestore();
    }
    expect(configs).toEqual([
      { ...simulation.judge, explain_below: 2 },
      { ...simulation.judge, explain_below: 2 },
    ]);
    expect(built.map((judge) => judge.closed)).toEqual([true, true]);
    expect(built[1]!.transcript.length).toBe(7);
    expect(judgement.metrics[0]!.score).toBe(1.0);
  });

  test("test_the_goal_and_the_criterion_metrics_are_judged_and_the_measures_left_out", async () => {
    const metrics = [
      new EvalSimulationMetric({ name: "politeness", criterion: "stays polite", minScore: 1.0 }),
      new EvalSimulationMetric({ name: "turns", measure: "turns", maxValue: 10 }),
      new EvalSimulationMetric({ name: "brevity", criterion: "keeps it short" }),
    ];
    const judge = new _FakeJudge("yes", [2]);
    const trace = new EvalTrace();
    const judgement = await new EvalSimulationJudge(_simulation(metrics), {
      judge: asJudge(judge),
      trace,
    }).judge(MESSAGES);
    expect(judge.criteria).toEqual({ politeness: "stays polite", brevity: "keeps it short" });
    expect([judgement.goal.verdict, judgement.goal.reason]).toEqual([
      "yes",
      "because the bot booked a table",
    ]);
    const [politeness, brevity] = judgement.metrics;
    expect([politeness!.name, politeness!.score, politeness!.passed]).toEqual([
      "politeness",
      0.5,
      false,
    ]);
    expect(politeness!.failureKind).toBe("judge_no");
    expect(politeness!.reason).toBe("turn 2: turn 2 politeness");
    expect(politeness!.criterion).toBe("stays polite");
    // Without a min_score, a metric reports and fails nothing.
    expect([brevity!.score, brevity!.passed]).toEqual([0.5, true]);
    expect(trace.lines.join("\n")).toContain(
      "judge: politeness = 0.50 (below 1.00): turn 2: turn 2 politeness",
    );
  });
});
