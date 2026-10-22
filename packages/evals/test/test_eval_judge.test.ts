// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/cli/test_eval_judge.py

// Tests for `pipedog-eval judge` (`pipecat eval judge`), over a judge that answers without an LLM.

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { logger } from "@pipedog/core/utils/logger";
import { evalApp } from "../src/cli.ts";
import { EvalJudge, JudgeVerdict, RunVerdicts } from "../src/judge.ts";

const SCENARIO = `name: book
persona: A caller.
goal: Book a table.
success: the bot booked a table
metrics:
  - name: politeness
    criterion: stays polite
    min_score: 1
  - measure: turns
    max_value: 10
scenarios:
  - name: available
  - name: impossible
`;

const CONVERSATION = [
  { role: "user", content: "A table at six." },
  { role: "tool_call", name: "book", arguments: { time: "6" }, cancelled: false },
  { role: "assistant", content: "Booked for six." },
];

/** Passes the goal and every turn, each with a reason, and records how it was built. */
class FakeJudge {
  static configs: Record<string, unknown>[] = [];
  botTurns = 0;
  closed = false;

  constructor(config: Record<string, unknown>) {
    FakeJudge.configs.push(config);
  }

  addUserMessage(_text: string): void {}

  addAssistantMessage(_text: string): void {
    this.botTurns += 1;
  }

  addToolCall(_text: string): void {}

  async evaluateRun(criteria: Record<string, string>, _success: string): Promise<RunVerdicts> {
    return new RunVerdicts({
      goal: new JudgeVerdict({
        verdict: "yes",
        reason: "booked",
        rawResponse: "",
        confidence: 0.8,
        probabilities: { yes: 0.8, no: 0.2 },
      }),
      turns: Object.fromEntries(
        Object.keys(criteria).map((name) => [
          name,
          Array.from(
            { length: this.botTurns },
            () =>
              new JudgeVerdict({
                verdict: "yes",
                reason: "polite",
                rawResponse: "",
                confidence: 0.9,
                probabilities: { meets: 0.9, fails: 0.1 },
              }),
          ),
        ]),
      ),
    });
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

describe("TestEvalJudge", () => {
  let base: string;
  let scenario: string;
  let conversation: string;
  let output: string;
  let stdout: string[];
  let stderr: string[];
  const writes = {
    out: process.stdout.write.bind(process.stdout),
    err: process.stderr.write.bind(process.stderr),
  };

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "pipedog-evals-judge-"));
    scenario = join(base, "book.yaml");
    writeFileSync(scenario, SCENARIO);
    conversation = join(base, "run.conversation.json");
    writeFileSync(conversation, JSON.stringify(CONVERSATION));
    output = join(base, "judged.jsonl");
    FakeJudge.configs = [];
    stdout = [];
    stderr = [];
    process.stdout.write = ((chunk: string | Uint8Array) => {
      stdout.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderr.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
  });

  afterEach(() => {
    process.stdout.write = writes.out;
    process.stderr.write = writes.err;
    rmSync(base, { recursive: true, force: true });
    // The command drops every log sink; put one back.
    logger.setSink((record) => console.log(`${record.level.padEnd(8)} | ${record.message}`));
  });

  async function judge(...args: string[]) {
    const fake = spyOn(EvalJudge, "fromConfig").mockImplementation(
      (async (config: Record<string, unknown>) => new FakeJudge(config)) as never,
    );
    let code: number;
    try {
      code = await evalApp(["judge", ...args, "-o", output]);
    } finally {
      fake.mockRestore();
    }
    const records = existsSync(output)
      ? readFileSync(output, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line))
      : [];
    return { code, output: stdout.join("") + stderr.join(""), records };
  }

  test("test_a_conversation_is_judged_with_every_verdict_explained", async () => {
    const result = await judge(scenario, "-s", "available", conversation);
    expect(result.code, result.output).toEqual(0);
    expect(FakeJudge.configs[0]?.explain_below).toEqual(Number.POSITIVE_INFINITY);
    expect(result.records.length).toEqual(1);
    const [record] = result.records;
    expect(record.conversation).toEqual(conversation);
    expect(record.scenario).toEqual("book/available");
    expect(record.success).toEqual("the bot booked a table");
    expect(record.passed).toBe(true);
    expect(record.reason).toEqual("booked");
    expect(record.confidence).toEqual(0.8);
    expect(record.probabilities).toEqual({ yes: 0.8, no: 0.2 });
    // The measured metric is left out: a conversation has nothing to measure.
    expect(record.metrics.length).toEqual(1);
    const [politeness] = record.metrics;
    expect(politeness.name).toEqual("politeness");
    expect(politeness.criterion).toEqual("stays polite");
    expect(politeness.verdicts).toEqual([
      {
        turn: 1,
        passed: true,
        verdict: "yes",
        confidence: 0.9,
        probabilities: { meets: 0.9, fails: 0.1 },
        reason: "polite",
        text: "Booked for six.",
      },
    ]);
  });

  test("test_a_file_that_cannot_be_read_is_its_own_error_and_fails_the_command", async () => {
    const broken = join(base, "broken.conversation.json");
    writeFileSync(broken, "not json");
    const result = await judge(scenario, "-s", "book/available", broken, conversation);
    expect(result.code, result.output).toEqual(1);
    const byFile = Object.fromEntries(result.records.map((r) => [basename(r.conversation), r]));
    expect(byFile["run.conversation.json"].passed).toBe(true);
    expect(byFile["broken.conversation.json"].passed).toBe(false);
    // DIVERGENCE: the error names JavaScript's SyntaxError, where Python's names JSONDecodeError.
    expect(byFile["broken.conversation.json"].error).toContain("SyntaxError");
  });

  test("test_a_file_with_several_simulations_needs_one_picked", async () => {
    for (const args of [[], ["-s", "nope"]]) {
      const result = await judge(scenario, ...args, conversation);
      expect(result.code).toEqual(2);
      expect(result.output).toContain("book/impossible");
      expect(result.records).toEqual([]);
      // The output file from an earlier iteration, if any, is not this run's.
      rmSync(output, { force: true });
    }
  });
});
