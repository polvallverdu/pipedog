// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Evals end to end: a runner bot (test/e2e/bot.ts, on test-mocks' OpenAI mock)
// served by @pipedog/runner's main(), and a scripted scenario run against its
// /ws route. The harness connects as an RTVI client and sends `eval-connect`;
// the runner's createTransport builds the eval transport from it. The scenario
// waits for the bot's greeting, asks the scripted question in text modality,
// and checks the reply with `text_contains` and with a fake judge named by the
// scenario's `judge.eval.factory` (test/e2e/judge.ts). Then the same scenario
// file runs through the `pipedog-eval run` CLI in a child process.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type MockOpenAI, startMockOpenAI } from "../../../examples/test-mocks/src/mock_openai.ts";
import { ANSWER, SCRIPTED_QUESTION } from "../../../examples/test-mocks/src/mock_provider.ts";
import { main, RunnerApp } from "../../runner/src/run.ts";
import type { RunnerServer } from "../../runner/src/serve.ts";
import type { EvalScriptResult } from "../src/results.ts";
import { EvalScenarioFile } from "../src/scenario.ts";
import { EvalSession } from "../src/session.ts";
import { bot } from "./e2e/bot.ts";
import { asked } from "./e2e/judge.ts";

const JUDGE = join(import.meta.dir, "e2e", "judge.ts");

function scenarioYaml(): string {
  return `name: capital
judge:
  eval:
    factory: ${JUDGE}.judge
    explainer: false
scenarios:
  - name: capital_question
    turns:
      - expect:
          - event: response
            eval: "the bot greets the user"
      - user: ${JSON.stringify(SCRIPTED_QUESTION)}
        expect:
          - event: response
            text_contains: Berlin
            eval: 'the reply names "Berlin" as the capital'
  - name: wrong_capital
    turns:
      - expect:
          - event: response
      - user: ${JSON.stringify(SCRIPTED_QUESTION)}
        expect:
          - event: response
            eval: 'the reply names "Paris" as the capital'
`;
}

let openai: MockOpenAI;
let server: RunnerServer;
let dir: string;
let scenarioPath: string;
let botUrl: string;
const savedBaseUrl = process.env.OPENAI_BASE_URL;

beforeAll(async () => {
  openai = startMockOpenAI();
  process.env.OPENAI_BASE_URL = openai.baseUrl;
  const started = await main({
    argv: ["--host", "127.0.0.1", "--port", "0"],
    bot,
    app: new RunnerApp(),
    handleSignals: false,
  });
  if (!started) throw new Error("the runner did not start");
  server = started;
  botUrl = `ws://127.0.0.1:${server.port}/ws`;
  dir = await mkdtemp(join(tmpdir(), "pipedog-evals-e2e-"));
  scenarioPath = join(dir, "capital.yaml");
  await writeFile(scenarioPath, scenarioYaml());
});

afterAll(async () => {
  await server?.close();
  openai?.stop();
  if (savedBaseUrl === undefined) delete process.env.OPENAI_BASE_URL;
  else process.env.OPENAI_BASE_URL = savedBaseUrl;
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe("evals against a runner bot", () => {
  test("a scripted scenario passes: greeting, then the answer, judged", async () => {
    const file = await EvalScenarioFile.load(scenarioPath);
    const before = asked.length;
    const session = await EvalSession.fromScenario(file.get("capital/capital_question"), botUrl);
    const result = (await session.run()) as EvalScriptResult;

    expect(result.failures).toEqual([]);
    expect(result.passed).toBe(true);
    expect(result.turns.map((t) => t.status)).toEqual(["passed", "passed"]);
    // The bot answered the scripted question through the mock chat API...
    expect(openai.asked).toContain(SCRIPTED_QUESTION);
    // ... and the judge saw that answer as the latest reply.
    const replies = asked.slice(before).map((a) => String(a.state.latest_bot_reply ?? ""));
    expect(replies.some((r) => r.includes(ANSWER))).toBe(true);
  }, 60_000);

  test("a criterion the reply misses fails its turn", async () => {
    const file = await EvalScenarioFile.load(scenarioPath);
    const session = await EvalSession.fromScenario(file.get("capital/wrong_capital"), botUrl);
    const result = (await session.run()) as EvalScriptResult;

    expect(result.passed).toBe(false);
    expect(result.turns.map((t) => t.status)).toEqual(["passed", "failed"]);
    expect(result.failures.length).toBeGreaterThan(0);
  }, 60_000);

  test("pipedog-eval run drives the same scenario from the command line", async () => {
    const proc = Bun.spawn(
      [
        process.execPath,
        join(import.meta.dir, "..", "src", "__main__.ts"),
        "run",
        scenarioPath,
        "--bot-url",
        botUrl,
        "--logs-dir",
        join(dir, "logs"),
      ],
      { cwd: dir, stdout: "pipe", stderr: "pipe", env: { ...process.env, NO_COLOR: "1" } },
    );
    const [out, err] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const code = await proc.exited;
    const output = `${out}\n${err}`;
    if (process.env.EVALS_E2E_DEBUG) console.log(output);
    // One scenario passes and one fails, so the run fails as a whole.
    expect(code).toBe(1);
    expect(output).toContain("capital_question");
    expect(output).toContain("wrong_capital");
  }, 120_000);
});
