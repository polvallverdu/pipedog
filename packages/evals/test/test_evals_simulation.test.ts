// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_evals_simulation.py

/** Tests for the simulation file format and the persona. */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTask, monotonic, sleep } from "@pipedog/asyncio";
import {
  type Frame,
  type FunctionCallResultProperties,
  LLMFullResponseEndFrame,
  LLMFullResponseStartFrame,
  LLMTextFrame,
  TextType,
  TTSTextFrame,
} from "@pipedog/core/frames/frames";
import type { PipelineWorker } from "@pipedog/core/pipeline/worker";
import { LLMContext } from "@pipedog/core/processors/aggregators/llm_context";
import { FrameDirection, FrameProcessor } from "@pipedog/core/processors/frame_processor";
import { FunctionCallParams, type LLMService } from "@pipedog/core/services/llm_service";
import {
  _PersonaTurnRelay,
  BOT_ENDED_EVENT,
  type EvalClient,
  HARNESS_ERROR_EVENT,
  PERSONA_TURN_EVENT,
} from "../src/client.ts";
import { type EvalEvent, EvalEventStream } from "../src/events.ts";
import { type EvalJudge, JudgeVerdict, RunVerdicts } from "../src/judge.ts";
import { END_CALL_FUNCTION, EvalPersona } from "../src/persona.ts";
import {
  EvalAssertionFailure,
  type EvalProgress,
  type EvalSimulationProgress,
  EvalSimulationResult,
  EvalTrace,
} from "../src/results.ts";
import {
  _loadMapping,
  describeSimulation,
  EvalScenarioFile,
  EvalScriptScenario,
  EvalSimulationMetric,
  EvalSimulationScenario,
} from "../src/scenario.ts";
import { EvalFunctionCall } from "../src/script.ts";
import { _parseSimulation } from "../src/simulation.ts";
import { END_CALL_EVENT, EvalSimulationDriver } from "../src/simulation_driver.ts";

// A simulation's own mapping, as EvalSimulationScenario parses it.
const MINIMAL = `
name: capital_curious
persona: "A curious traveler."
goal: "Learn the capital of Germany."
simulator: {service: openai, model: gpt-4o-mini}
success: "the bot said the capital of Germany is Berlin"
`;

// The same simulation as a scenario file holds it.
const MINIMAL_FILE = `
name: capital_curious
simulator: {service: openai, model: gpt-4o-mini}
scenarios:
  - name: capital_curious
    persona: "A curious traveler."
    goal: "Learn the capital of Germany."
    success: "the bot said the capital of Germany is Berlin"
`;

function _write(yamlText: string): string {
  const path = join(mkdtempSync(join(tmpdir(), "evals-simulation-")), "simulation.yaml");
  writeFileSync(path, yamlText, "utf8");
  return path;
}

/** Parse a file holding one simulation's own keys at its top level. */
async function _loadSimulation(path: string): Promise<EvalSimulationScenario> {
  return _parseSimulation(await _loadMapping(path), path);
}

/** The error an async call rejects with. */
async function rejection(fn: () => Promise<unknown>): Promise<Error> {
  try {
    await fn();
  } catch (e) {
    return e as Error;
  }
  throw new Error("expected a rejection");
}

describe("TestSimulationLoader", () => {
  test("test_minimal_has_defaults", async () => {
    const s = await _loadSimulation(_write(MINIMAL));
    expect(s.name).toBe("capital_curious");
    expect(s.persona).toBe("A curious traveler.");
    expect(s.goal).toBe("Learn the capital of Germany.");
    expect(s.simulator).toEqual({ service: "openai", model: "gpt-4o-mini" });
    expect(s.success).toBe("the bot said the capital of Germany is Berlin");
    expect(s.metrics).toEqual([]);
    expect(s.botAudio).toBe(false);
    expect(s.userAudio).toBe(false);
    expect(s.maxTurns).toBe(20);
    expect(s.maxDurationS).toBe(300.0);
    expect(s.runs).toBe(1);
    expect(s.judge.service).toBe("ollama");
  });

  test("test_metrics_and_caps", async () => {
    const s = await _loadSimulation(
      _write(
        `${MINIMAL}
metrics:
  - name: politeness
    criterion: "stayed courteous"
  - {name: accuracy, criterion: "no invented facts", min_score: 0.8}
max_turns: 5
max_duration_s: 42
runs: 3
`,
      ),
    );
    expect(s.metrics.map((m) => m.name)).toEqual(["politeness", "accuracy"]);
    expect(s.metrics.map((m) => m.minScore)).toEqual([null, 0.8]);
    expect(s.maxTurns).toBe(5);
    expect(s.maxDurationS).toBe(42.0);
    expect(s.runs).toBe(3);
  });

  test("test_a_measured_metric_takes_a_measure_and_a_range", async () => {
    const s = await _loadSimulation(
      _write(
        `${MINIMAL}
metrics:
  - measure: latency
    max_value: 2
  - name: quick
    measure: turns
    min_value: 1
    max_value: 6
`,
      ),
    );
    const [latency, quick] = s.metrics;
    expect([latency!.name, latency!.measure, latency!.maxValue]).toEqual([
      "latency",
      "latency",
      2.0,
    ]);
    expect(latency!.criterion).toBeNull();
    expect([quick!.measure, quick!.minValue, quick!.maxValue]).toEqual(["turns", 1.0, 6.0]);
    for (const [bad, message] of [
      ["  - measure: mood\n    max_value: 1\n", "must be one of"],
      ["  - measure: turns\n", "needs a 'min_value:' or a 'max_value:'"],
      ["  - measure: turns\n    max_value: 3\n    min_score: 1\n", "takes a range"],
      [
        "  - name: both\n    criterion: x\n    measure: turns\n    max_value: 3\n",
        "one of the two",
      ],
    ] as const) {
      const error = await rejection(() => _loadSimulation(_write(`${MINIMAL}metrics:\n${bad}`)));
      expect(error.message).toContain(message);
    }
  });

  test("test_min_score_is_a_share_and_names_are_unique", async () => {
    let error = await rejection(() =>
      _loadSimulation(_write(`${MINIMAL}metrics:\n  - {name: a, criterion: x, min_score: 2}\n`)),
    );
    expect(error.message).toContain("0..1");
    error = await rejection(() =>
      _loadSimulation(
        _write(`${MINIMAL}metrics:\n  - {name: a, criterion: x}\n  - {name: a, criterion: y}\n`),
      ),
    );
    expect(error.message).toContain("twice");
  });

  test("test_audio_modalities", async () => {
    const s = await _loadSimulation(
      _write(
        `${MINIMAL}
user:
  modality: audio
  speech: {service: kokoro, voice: af_heart}
judge:
  modality: audio
  transcription: {service: moonshine}
`,
      ),
    );
    expect(s.userAudio).toBe(true);
    expect(s.userSpeech).toEqual({ service: "kokoro", voice: "af_heart" });
    expect(s.botAudio).toBe(true);
    expect(s.transcriber).toEqual({ service: "moonshine" });
  });

  test("test_user_audio_requires_speech", async () => {
    const error = await rejection(() =>
      _loadSimulation(_write(`${MINIMAL}user: {modality: audio}\n`)),
    );
    expect(error.message).toContain("user.speech");
  });

  test("test_required_fields", async () => {
    for (const missing of ["persona", "goal", "success"]) {
      const text = MINIMAL.split("\n")
        .filter((line) => !line.startsWith(missing))
        .join("\n");
      const error = await rejection(() => _loadSimulation(_write(text)));
      expect(error.message).toContain(missing);
    }
  });

  test("test_a_function_calls_measure_takes_the_calls_the_bot_should_make", async () => {
    const s = await _loadSimulation(
      _write(
        `${MINIMAL}
metrics:
  - measure: function_calls
    calls:
      - book_table
      - name: send_confirmation
        args: { channel: sms }
  - name: hands_off
    measure: function_calls
    calls: []
`,
      ),
    );
    const [booked, handsOff] = s.metrics;
    expect(booked!.name).toBe("function_calls");
    expect((booked!.calls ?? []).map((c) => [c.name, c.args])).toEqual([
      ["book_table", null],
      ["send_confirmation", { channel: "sms" }],
    ]);
    expect([handsOff!.measure, handsOff!.calls]).toEqual(["function_calls", []]);
    for (const [bad, message] of [
      ["  - measure: function_calls\n", "needs a 'calls:' list"],
      ["  - measure: function_calls\n    calls: [book_table]\n    max_value: 1\n", "not a range"],
      ["  - measure: function_calls\n    calls: [{args: {a: 1}}]\n", "entry #0 must be a name"],
      ["  - measure: turns\n    max_value: 3\n    calls: []\n", "'calls:' belongs to"],
    ] as const) {
      const error = await rejection(() => _loadSimulation(_write(`${MINIMAL}metrics:\n${bad}`)));
      expect(error.message).toMatch(new RegExp(message));
    }
  });

  test("test_metric_needs_a_criterion", async () => {
    const error = await rejection(() =>
      _loadSimulation(_write(`${MINIMAL}metrics: [{name: politeness}]\n`)),
    );
    expect(error.message).toContain("criterion");
  });

  test("test_caps_must_be_positive", async () => {
    await expect(_loadSimulation(_write(`${MINIMAL}max_turns: 0\n`))).rejects.toThrow();
    await expect(_loadSimulation(_write(`${MINIMAL}max_duration_s: -1\n`))).rejects.toThrow();
  });

  test("test_describe", async () => {
    const text = describeSimulation(await _loadSimulation(_write(MINIMAL)));
    expect(text).toContain(
      "user  -> modality: text | persona: openai/gpt-4o-mini | max_turns: 20 | " +
        "max_duration_s: 300",
    );
    expect(text).toContain("judge -> modality: text | eval: ollama/");
    expect(text).toContain("goal  -> Learn the capital of Germany.");
    expect(text.split("\n").length).toBe(3);
  });
});

describe("TestLoadScenarios", () => {
  test("test_a_persona_makes_a_simulation", async () => {
    const [loaded, ...rest] = [...(await EvalScenarioFile.load(_write(MINIMAL_FILE)))];
    expect(rest).toEqual([]);
    expect(loaded).toBeInstanceOf(EvalSimulationScenario);
  });

  test("test_turns_make_a_scripted_scenario", async () => {
    const [loaded, ...rest] = [
      ...(await EvalScenarioFile.load(
        _write("name: greet\nscenarios: [{name: greet, turns: []}]\n"),
      )),
    ];
    expect(rest).toEqual([]);
    expect(loaded).toBeInstanceOf(EvalScriptScenario);
  });

  test("test_a_scenario_is_one_kind_or_the_other", async () => {
    let error = await rejection(() =>
      EvalScenarioFile.load(_write("name: nothing\nscenarios: [{name: nothing}]\n")),
    );
    expect(error.message).toContain("'turns:'");
    expect(error.message).toContain("'persona:'");
    error = await rejection(() => EvalScenarioFile.load(_write(`${MINIMAL_FILE}    turns: []\n`)));
    expect(error.message).toContain("not both");
  });
});

class _FakePersonaLLM {
  handlers: Record<string, (params: FunctionCallParams) => Promise<void>> = {};

  registerFunction(name: string, handler: (params: FunctionCallParams) => Promise<void>): void {
    this.handlers[name] = handler;
  }
}

function asLLM(llm: _FakePersonaLLM): LLMService {
  return llm as unknown as LLMService;
}

describe("TestPersona", () => {
  test("test_instruction_llm_and_context", () => {
    const llm = new _FakePersonaLLM();
    const persona = new EvalPersona(
      "A curious traveler.",
      "Learn the capital of Germany.",
      asLLM(llm),
    );
    expect(persona.instruction).toContain("A curious traveler.");
    expect(persona.instruction).toContain("Learn the capital of Germany.");
    expect(persona.instruction).toContain(END_CALL_FUNCTION);
    expect(persona.llm).toBe(asLLM(llm));
    const context = persona.context;
    expect(context.getMessages()).toEqual([]);
    const tools = context.tools;
    expect(tools).not.toBeNull();
    expect(
      (tools as { standardTools: { name: string }[] }).standardTools.map((t) => t.name),
    ).toEqual([END_CALL_FUNCTION]);
  });
});

describe("TestSimulationRunResult", () => {
  test("test_passed_needs_success_and_no_error", () => {
    expect(new EvalSimulationResult({ simulationName: "s", succeeded: true }).passed).toBe(true);
    expect(new EvalSimulationResult({ simulationName: "s", succeeded: false }).passed).toBe(false);
    expect(
      new EvalSimulationResult({ simulationName: "s", succeeded: true, error: "boom" }).passed,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The simulation driver, over fakes.
// ---------------------------------------------------------------------------

/**
 * Answers the judge's one run question from a script and records what it saw.
 *
 * `verdicts` feed the goal in order; `turnVerdicts` are one dict per bot turn,
 * a metric left out of a dict passing that turn.
 */
class _FakeConversationJudge {
  verdicts: string[];
  turnVerdicts: Record<string, string>[];
  transcript: { role: string; content: string }[] = [];
  criteria: string[] = [];
  runCriteria: Record<string, string> = {};

  constructor(verdicts: string[], turnVerdicts: Record<string, string>[] | null = null) {
    this.verdicts = [...verdicts];
    this.turnVerdicts = [...(turnVerdicts ?? [])];
  }

  async close(): Promise<void> {}

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
    this.criteria.push(success);
    this.runCriteria = { ...criteria };
    const turns = this.transcript.filter((e) => e.role === "assistant").length;
    const verdict = this.verdicts.shift();
    if (verdict === undefined) throw new Error("pop from empty list");
    const goal = new JudgeVerdict({ verdict, reason: `because ${success}`, rawResponse: "" });
    const byName: Record<string, JudgeVerdict[]> = {};
    for (const [name, criterion] of Object.entries(criteria)) {
      byName[name] = [];
      for (let index = 0; index < turns; index++) {
        const scripted = index < this.turnVerdicts.length ? this.turnVerdicts[index]! : {};
        byName[name].push(
          new JudgeVerdict({
            verdict: scripted[name] ?? "yes",
            reason: `because ${criterion}`,
            rawResponse: "",
          }),
        );
      }
    }
    return new RunVerdicts({ goal, turns: byName });
  }
}

/** Takes what the processor before it pushes, without a running pipeline. */
class _Discard extends FrameProcessor {
  override async queueFrame(
    _frame: Frame,
    _direction: FrameDirection = FrameDirection.DOWNSTREAM,
  ): Promise<void> {}
}

class _FakeClient {
  hungUp = false;
  protected _stream: EvalEventStream;

  constructor(stream: EvalEventStream) {
    this._stream = stream;
  }

  async hangUp(): Promise<void> {
    this.hungUp = true;
  }

  async reportEndCall(event: EvalEvent): Promise<void> {
    await this._stream.append(event);
  }
}

function _simulation(
  overrides: Partial<ConstructorParameters<typeof EvalSimulationScenario>[0]> = {},
): EvalSimulationScenario {
  return new EvalSimulationScenario({
    name: "capital",
    persona: "A traveler.",
    goal: "Learn the capital of Germany.",
    simulator: { service: "openai" },
    success: "the bot said Berlin",
    maxTurns: 10,
    maxDurationS: 5.0,
    ...overrides,
  });
}

function _driver(
  simulation: EvalSimulationScenario,
  judge: _FakeConversationJudge,
  progressRecords: EvalProgress[] | null = null,
): [EvalSimulationDriver, EvalEventStream, _FakePersonaLLM, _FakeClient] {
  const trace = new EvalTrace();
  const stream = new EvalEventStream({ botAudio: simulation.botAudio, trace });
  const llm = new _FakePersonaLLM();
  const client = new _FakeClient(stream);

  const progress = async (record: EvalProgress): Promise<void> => {
    if (progressRecords !== null) {
      progressRecords.push(record);
    }
  };

  const driver = new EvalSimulationDriver({
    simulation,
    persona: new EvalPersona(simulation.persona, simulation.goal, asLLM(llm)),
    client: client as unknown as EvalClient,
    stream,
    judge: judge as unknown as EvalJudge,
    trace,
    progress,
  });
  return [driver, stream, llm, client];
}

type Result = [unknown, FunctionCallResultProperties | null | undefined];

/** Invoke the registered end_call the way the LLM service would. */
async function _endCall(llm: _FakePersonaLLM, args: Record<string, unknown>): Promise<Result[]> {
  const results: Result[] = [];

  const resultCallback = async (
    result: unknown,
    options?: { properties?: FunctionCallResultProperties | null },
  ): Promise<void> => {
    results.push([result, options?.properties]);
  };

  const params = new FunctionCallParams({
    functionName: "end_call",
    toolCallId: "c1",
    arguments: args,
    llm: asLLM(llm),
    pipelineWorker: {} as PipelineWorker,
    context: new LLMContext(),
    resultCallback,
  });
  await llm.handlers.end_call!(params);
  return results;
}

/** Run the driver while `conversation` plays the other side, as the upstream tests do. */
async function runWith(
  driver: EvalSimulationDriver,
  conversation: () => Promise<void>,
): Promise<EvalAssertionFailure[]> {
  const task = createTask(conversation);
  const failures = await driver.run();
  await task;
  return failures;
}

function resultOf(driver: EvalSimulationDriver, stream?: EvalEventStream): EvalSimulationResult {
  return driver.result({
    failures: [],
    durationMs: 10,
    eventsSeen: stream ? stream.eventsSeen : [],
    debugLog: [],
  });
}

function simProgress(records: EvalProgress[]): [string, string, number][] {
  return (records as EvalSimulationProgress[]).map((r) => [r.status, r.text, r.turn]);
}

describe("TestSimulationDriver", () => {
  test("test_end_call_ends_the_run_and_the_judge_sees_the_swapped_conversation", async () => {
    // The second bot turn is short but the judge finds it curt.
    const judge = new _FakeConversationJudge(["yes"], [{}, { brevity: "no" }]);
    const metrics = [
      new EvalSimulationMetric({ name: "politeness", criterion: "stayed polite", minScore: 1.0 }),
      new EvalSimulationMetric({ name: "brevity", criterion: "kept it short" }),
    ];
    const [driver, stream, llm, client] = _driver(_simulation({ metrics }), judge);

    const failures = await runWith(driver, async () => {
      await stream.append({ type: "llm_response", text: "Hi! How can I help?" });
      await stream.append({ type: PERSONA_TURN_EVENT, text: "What is the capital of Germany?" });
      await stream.append({ type: "llm_response", text: "Berlin." });
      await stream.append({ type: PERSONA_TURN_EVENT, text: "Thanks!" });
      const results = await _endCall(llm, { success: true, reason: "I got my answer" });
      expect(results[0]![0]).toEqual({ status: "call ended" });
      expect(results[0]![1]!.runLlm).toBe(false);
      // The bot's reply to the persona's last line closes the conversation.
      await stream.append({ type: "llm_response", text: "You're welcome!" });
    });

    expect(failures).toEqual([]);
    expect(client.hungUp).toBe(true);
    // One judge call saw the whole conversation, the criteria, and the goal.
    expect(judge.transcript).toEqual([
      { role: "assistant", content: "Hi! How can I help?" },
      { role: "user", content: "What is the capital of Germany?" },
      { role: "assistant", content: "Berlin." },
      { role: "user", content: "Thanks!" },
      { role: "assistant", content: "You're welcome!" },
    ]);
    expect(judge.runCriteria).toEqual({ politeness: "stayed polite", brevity: "kept it short" });
    expect(judge.criteria).toEqual(["the bot said Berlin"]);

    const result = resultOf(driver, stream);
    expect(result.succeeded).toBe(true);
    expect(result.passed).toBe(true);
    expect(result.reason).toBe("because the bot said Berlin");
    expect(result.success).toBe("the bot said Berlin");
    expect(result.endedBy).toBe("end_call");
    expect(result.turns).toBe(2);
    expect(result.endCall).toEqual({ success: true, reason: "I got my answer" });
    expect(result.metrics.map((m) => m.score)).toEqual([1.0, 2 / 3]);
    // brevity scored 0.5 but gates nothing, so the run still passes.
    expect(result.metrics.map((m) => m.passed)).toEqual([true, true]);
    expect(result.metrics[0]!.reason).toBe("all 3 turn(s)");
    expect(result.metrics[0]!.criterion).toBe("stayed polite");
    expect(result.metrics[1]!.reason).toBe("turn 2: because kept it short");
    expect(result.metrics[1]!.verdicts.filter((v) => !v.passed).map((v) => v.turn)).toEqual([2]);
    expect(result.failure).toBeNull();
    expect(result.messages).toEqual(judge.transcript);
    expect(stream.eventsSeen.map((e) => e.type)).toContain(END_CALL_EVENT);
  });

  test("test_a_metric_below_its_min_score_fails_the_run", async () => {
    const judge = new _FakeConversationJudge(["yes"], [{ politeness: "no" }]);
    const metrics = [
      new EvalSimulationMetric({ name: "politeness", criterion: "stayed polite", minScore: 1.0 }),
    ];
    const records: EvalProgress[] = [];
    const [driver, stream, llm] = _driver(_simulation({ metrics }), judge, records);

    await runWith(driver, async () => {
      await stream.append({ type: "llm_response", text: "What do you want." });
      await stream.append({ type: PERSONA_TURN_EVENT, text: "The capital of Germany?" });
      await _endCall(llm, { success: true, reason: "rude but answered" });
      await stream.append({ type: "llm_response", text: "Berlin. Anything else." });
    });
    const result = resultOf(driver, stream);
    expect(result.succeeded).toBe(true);
    expect(result.passed).toBe(false);
    expect(result.failure).toBe("politeness 0.50 below 1.00: turn 1: because stayed polite");
    expect(simProgress(records).filter(([status]) => status !== "bot")).toEqual([
      ["user", "The capital of Germany?", 1],
      ["ended", "end_call", 1],
    ]);
  });

  test("test_measures_come_from_the_run_and_a_value_out_of_range_fails_it", async () => {
    const metrics = [
      new EvalSimulationMetric({ name: "latency", measure: "latency", maxValue: 1.0 }),
      new EvalSimulationMetric({ name: "words", measure: "words", maxValue: 3 }),
      new EvalSimulationMetric({ name: "turns", measure: "turns", maxValue: 5 }),
      new EvalSimulationMetric({ name: "duration", measure: "duration", minValue: 0 }),
    ];
    const [driver, stream, llm] = _driver(
      _simulation({ metrics }),
      new _FakeConversationJudge(["yes"]),
    );

    await runWith(driver, async () => {
      // Times are seconds on the stream's clock; a reply's first token is started_at.
      await stream.append({ type: "llm_response", text: "Hi there", at: 0.5, started_at: 0.2 });
      await stream.append({ type: PERSONA_TURN_EVENT, text: "Capital of Germany?", at: 1.0 });
      await stream.append({ type: "bot_interrupted", at: 1.1 });
      await stream.append({
        type: "llm_response",
        text: "It is Berlin, of course.",
        at: 3.0,
        started_at: 2.4,
      });
      await stream.append({ type: PERSONA_TURN_EVENT, text: "Thanks", at: 3.5 });
      await stream.append({ type: "llm_response", text: "Bye!", at: 3.9, started_at: 3.8 });
      await _endCall(llm, { success: true, reason: "done" });
    });
    const result = resultOf(driver, stream);
    const byName = Object.fromEntries(result.metrics.map((m) => [m.name, m]));
    // The slowest reply took 1.4 s, over the 1 s bound; the greeting had no send before it.
    expect([byName.latency!.value, byName.latency!.passed]).toEqual([1.4, false]);
    expect(byName.latency!.reason).toBe("slowest reply 1.40 s to the first token, at most 1");
    expect([byName.words!.value, byName.words!.passed]).toEqual([5.0, false]);
    expect([byName.turns!.value, byName.turns!.passed]).toEqual([2.0, true]);
    expect(byName.duration!.passed).toBe(true);
    expect(result.succeeded).toBe(true);
    expect(result.passed).toBe(false);
    expect(result.failure).toBe("latency: slowest reply 1.40 s to the first token, at most 1");
  });

  test("test_function_calls_are_checked_against_the_list_the_bot_should_make", async () => {
    const metrics = [
      new EvalSimulationMetric({
        name: "booking",
        measure: "function_calls",
        calls: [new EvalFunctionCall({ name: "book_table", args: { party_size: 2 } })],
      }),
      new EvalSimulationMetric({ name: "hands_off", measure: "function_calls", calls: [] }),
      new EvalSimulationMetric({
        name: "lookup",
        measure: "function_calls",
        calls: [
          new EvalFunctionCall({ name: "check_availability" }),
          new EvalFunctionCall({ name: "book_table" }),
        ],
      }),
    ];
    const [driver, stream, llm] = _driver(
      _simulation({ metrics }),
      new _FakeConversationJudge(["yes"]),
    );

    await runWith(driver, async () => {
      await stream.append({ type: "llm_response", text: "Hello!" });
      await stream.append({ type: PERSONA_TURN_EVENT, text: "A table for two at six." });
      await stream.append({
        type: "function_call",
        name: "check_availability",
        args: { time: "6" },
      });
      // A cancelled call did not happen.
      await stream.append({ type: "function_call", name: "send_confirmation", args: {} });
      await stream.append({
        type: "function_call_stopped",
        name: "send_confirmation",
        args: { tool_call_id: "1", cancelled: true },
      });
      await stream.append({
        type: "function_call",
        name: "book_table",
        args: { party_size: 2, time: "6" },
      });
      await stream.append({ type: "llm_response", text: "Booked." });
      await _endCall(llm, { success: true, reason: "booked" });
    });
    const result = resultOf(driver, stream);
    const byName = Object.fromEntries(result.metrics.map((m) => [m.name, m]));
    const made = "check_availability(time='6'), book_table(party_size=2, time='6')";
    // The list is the whole set: the lookup is not on the booking list, so it fails.
    expect([byName.booking!.value, byName.booking!.passed]).toEqual([2.0, false]);
    expect(byName.booking!.reason).toBe(`${made}, expected book_table(party_size=2)`);
    expect(byName.hands_off!.passed).toBe(false);
    expect(byName.hands_off!.reason).toBe(`${made}, expected none`);
    // Names alone match, in any order, and the cancelled call is not counted.
    expect(byName.lookup!.passed).toBe(true);
    expect(byName.lookup!.reason).toBe(`${made}, expected check_availability, book_table`);
    expect(result.failure).toBe(`booking: ${made}, expected book_table(party_size=2)`);
  });

  test("test_a_bot_that_should_call_nothing_passes_when_it_calls_nothing", async () => {
    const metrics = [
      new EvalSimulationMetric({ name: "hands_off", measure: "function_calls", calls: [] }),
    ];
    const [driver, stream, llm] = _driver(
      _simulation({ metrics }),
      new _FakeConversationJudge(["yes"]),
    );

    await runWith(driver, async () => {
      await stream.append({ type: "llm_response", text: "I can't do that for you." });
      await _endCall(llm, { success: true, reason: "turned down" });
    });
    const result = resultOf(driver, stream);
    const [handsOff, ...rest] = result.metrics;
    expect(rest).toEqual([]);
    expect([handsOff!.value, handsOff!.passed, handsOff!.reason]).toEqual([
      0.0,
      true,
      "no calls, expected none",
    ]);
    expect(result.passed).toBe(true);
  });

  test("test_a_bot_turn_is_what_it_said_between_persona_turns_with_the_calls_by_then", async () => {
    const judge = new _FakeConversationJudge(["yes"]);
    const metrics = [
      new EvalSimulationMetric({ name: "honesty", criterion: "claims only what a call backs" }),
    ];
    const [driver, stream, llm] = _driver(_simulation({ metrics }), judge);

    await runWith(driver, async () => {
      await stream.append({ type: "llm_response", text: "Hello!" });
      await stream.append({ type: PERSONA_TURN_EVENT, text: "A table at six, please." });
      // A function call splits the reply in two; both halves are one turn,
      // and the call is that turn's evidence, not the greeting's.
      await stream.append({ type: "llm_response", text: "Let me check." });
      await stream.append({
        type: "function_call",
        name: "check_availability",
        args: { time: "6" },
      });
      await stream.append({ type: "llm_response", text: "Six is free, booked." });
      await stream.append({ type: PERSONA_TURN_EVENT, text: "" });
      await _endCall(llm, { success: true, reason: "booked" });
    });
    // The call sits in the transcript where it happened, before the turn it split.
    expect(judge.transcript).toEqual([
      { role: "assistant", content: "Hello!" },
      { role: "user", content: "A table at six, please." },
      { role: "tool", content: 'check_availability({"time": "6"})' },
      { role: "assistant", content: "Let me check. Six is free, booked." },
    ]);
    const result = resultOf(driver, stream);
    expect(result.messages).toEqual([
      { role: "assistant", content: "Hello!" },
      { role: "user", content: "A table at six, please." },
      { role: "assistant", content: "Let me check. Six is free, booked." },
    ]);
    // The conversation file has the call in place too.
    expect(result.conversation).toEqual([
      { role: "assistant", content: "Hello!" },
      { role: "user", content: "A table at six, please." },
      {
        role: "tool_call",
        name: "check_availability",
        arguments: { time: "6" },
        cancelled: false,
      },
      { role: "assistant", content: "Let me check. Six is free, booked." },
    ]);
  });

  test("test_the_conversation_is_reported_as_it_happens", async () => {
    const records: EvalProgress[] = [];
    const [driver, stream, llm] = _driver(
      _simulation(),
      new _FakeConversationJudge(["yes"]),
      records,
    );

    await runWith(driver, async () => {
      await stream.append({ type: "llm_response", text: "Hi! How can I help?" });
      await stream.append({ type: PERSONA_TURN_EVENT, text: "What is the capital?" });
      await stream.append({ type: "llm_response", text: "Berlin." });
      // A response without text (a function call's own) is not a line.
      await stream.append({ type: "llm_response", text: "" });
      await _endCall(llm, { success: true, reason: "done" });
    });

    expect(simProgress(records)).toEqual([
      ["bot", "Hi! How can I help?", 0],
      ["user", "What is the capital?", 1],
      ["bot", "Berlin.", 1],
      ["ended", "end_call", 1],
    ]);
  });

  test("test_bot_turn_cap_ends_the_run", async () => {
    const [driver, stream] = _driver(
      _simulation({ maxTurns: 2 }),
      new _FakeConversationJudge(["no"]),
    );

    await runWith(driver, async () => {
      for (const text of ["one", "two", "three"]) {
        await stream.append({ type: "llm_response", text });
        await stream.append({ type: PERSONA_TURN_EVENT });
      }
    });
    const result = driver.result({ failures: [], durationMs: 0, eventsSeen: [], debugLog: [] });
    expect(result.endedBy).toBe("max_turns");
    expect(result.turns).toBe(2);
    expect(result.succeeded).toBe(false);
  });

  test("test_the_bot_hanging_up_ends_the_run", async () => {
    const judge = new _FakeConversationJudge(["yes"]);
    const [driver, stream, , client] = _driver(_simulation(), judge);

    await runWith(driver, async () => {
      await stream.append({ type: "llm_response", text: "Bye!" });
      await stream.append({ type: BOT_ENDED_EVENT });
    });
    const result = driver.result({ failures: [], durationMs: 0, eventsSeen: [], debugLog: [] });
    expect(result.endedBy).toBe("bot");
    expect(client.hungUp).toBe(true);
  });

  test("test_the_bots_tool_calls_are_the_judges_evidence", async () => {
    const judge = new _FakeConversationJudge(["yes"]);
    const [driver, stream, llm] = _driver(_simulation(), judge);

    await runWith(driver, async () => {
      await stream.append({
        type: "function_call",
        name: "check_availability",
        args: { time: "6:00 PM" },
      });
      await stream.append({
        type: "function_call_stopped",
        name: "check_availability",
        args: { cancelled: false },
      });
      await stream.append({ type: "function_call", name: "end_conversation", args: {} });
      await stream.append({
        type: "function_call_stopped",
        name: "end_conversation",
        args: { cancelled: true },
      });
      await _endCall(llm, { success: true, reason: "booked" });
    });
    const calls = [
      'check_availability({"time": "6:00 PM"})',
      "end_conversation()",
      "end_conversation was cancelled",
    ];
    expect(judge.transcript.filter((e) => e.role === "tool").map((e) => e.content)).toEqual(calls);
    // Upstream also checks the deprecated `EvalSimulationDriver.transcript()` here (with
    // its DeprecationWarning); it is not ported, so those two assertions are left out.
    const result = driver.result({ failures: [], durationMs: 0, eventsSeen: [], debugLog: [] });
    expect(result.conversation.map((m) => [m.name, m.cancelled])).toEqual([
      ["check_availability", false],
      ["end_conversation", true],
    ]);
  });

  test("test_wall_clock_cap_ends_the_run", async () => {
    const [driver] = _driver(
      _simulation({ maxDurationS: 0.05 }),
      new _FakeConversationJudge(["no"]),
    );
    await driver.run();
    const result = driver.result({ failures: [], durationMs: 0, eventsSeen: [], debugLog: [] });
    expect(result.endedBy).toBe("max_duration");
  });

  test("test_only_persona_turns_count", async () => {
    const [driver, stream, llm] = _driver(_simulation(), new _FakeConversationJudge(["yes"]));

    await runWith(driver, async () => {
      await stream.append({ type: "llm_response", text: "the bot's turn" });
      await stream.append({ type: "response", text: "its transcription" });
      await stream.append({ type: PERSONA_TURN_EVENT });
      await _endCall(llm, { success: true, reason: "done" });
    });
    const result = driver.result({ failures: [], durationMs: 0, eventsSeen: [], debugLog: [] });
    expect(result.turns).toBe(1);
  });

  test("test_a_run_level_failure_is_an_error_not_a_goal_failure", () => {
    const [driver] = _driver(_simulation(), new _FakeConversationJudge([]));
    const failure = new EvalAssertionFailure({
      turnIndex: -1,
      expectationIndex: -1,
      eventName: "<connect>",
      reason: "refused",
      kind: "connect_failed",
    });
    const result = driver.result({
      failures: [failure],
      durationMs: 0,
      eventsSeen: [],
      debugLog: [],
    });
    expect(result.error).toBe("refused");
    expect(result.succeeded).toBe(false);
    expect(result.passed).toBe(false);
    expect(result.endedBy).toBe("error");
    expect(result.reason).toBe("refused");
  });
});

/** A persona that hangs up on its own last line leaves the bot its reply to it. */
describe("TestClosingTurn", () => {
  /** Run a conversation whose last persona line ends with end_call, made while the line is spoken. */
  async function _hangUpWhileSpeaking(
    simulation: EvalSimulationScenario,
  ): Promise<[EvalSimulationResult, _FakeConversationJudge]> {
    // In audio mode the persona calls end_call before the user TTS has
    // spoken the line the call came with.
    const judge = new _FakeConversationJudge(["yes"]);
    const [driver, stream, llm, client] = _driver(simulation, judge);
    const relay = new _PersonaTurnRelay(() => ({}), new EvalTrace(), stream);
    relay.link(new _Discard());
    client.reportEndCall = (event) => relay.endCall(event);

    await runWith(driver, async () => {
      await stream.append({ type: "response", text: "Anything else?" });
      await relay.processFrame(new LLMFullResponseStartFrame(), FrameDirection.DOWNSTREAM);
      await _endCall(llm, { success: true, reason: "done" });
      expect(client.hungUp).toBe(true);
      // Speaking the line takes a while.
      await sleep(0.1);
      for (const frame of [
        new TTSTextFrame({ text: "No, goodbye!", textType: TextType.SENTENCE }),
        new LLMFullResponseEndFrame(),
      ]) {
        await relay.processFrame(frame, FrameDirection.DOWNSTREAM);
      }
      await sleep(0.1);
      await stream.append({ type: "response", text: "Goodbye!" });
    });
    const result = driver.result({ failures: [], durationMs: 0, eventsSeen: [], debugLog: [] });
    return [result, judge];
  }

  test("test_the_bots_reply_to_the_last_line_closes_the_run", async () => {
    const [driver, stream, llm, client] = _driver(
      _simulation(),
      new _FakeConversationJudge(["yes"]),
    );

    await runWith(driver, async () => {
      await stream.append({ type: "llm_response", text: "Is that all correct?" });
      await stream.append({ type: PERSONA_TURN_EVENT, text: "Yes, all correct." });
      await _endCall(llm, { success: true, reason: "done" });
      await sleep(0.1);
      // The persona is silent by now, and the bot's reply still counts.
      expect(client.hungUp).toBe(true);
      await stream.append({ type: "llm_response", text: "Great, you're all set." });
    });
    const result = driver.result({ failures: [], durationMs: 0, eventsSeen: [], debugLog: [] });
    expect(result.endedBy).toBe("end_call");
    expect(result.messages[result.messages.length - 1]).toEqual({
      role: "assistant",
      content: "Great, you're all set.",
    });
  });

  test("test_a_hang_up_while_the_last_line_is_spoken_waits_for_the_bots_reply", async () => {
    const [result, judge] = await _hangUpWhileSpeaking(_simulation({ botAudio: true }));
    expect(result.endedBy).toBe("end_call");
    // The judge read the persona's last line and the bot's reply to it.
    expect(judge.transcript.slice(-2)).toEqual([
      { role: "user", content: "No, goodbye!" },
      { role: "assistant", content: "Goodbye!" },
    ]);
  });

  test("test_a_hang_up_on_the_last_allowed_turn_waits_for_the_bots_reply", async () => {
    const [result] = await _hangUpWhileSpeaking(_simulation({ botAudio: true, maxTurns: 1 }));
    expect(result.endedBy).toBe("end_call");
    expect(result.messages[result.messages.length - 1]).toEqual({
      role: "assistant",
      content: "Goodbye!",
    });
  });

  test("test_a_hang_up_with_no_reply_coming_still_ends_as_end_call", async () => {
    const [driver, stream, llm] = _driver(
      _simulation({ maxDurationS: 0.3 }),
      new _FakeConversationJudge(["yes"]),
    );

    await runWith(driver, async () => {
      await stream.append({ type: "llm_response", text: "Is that all correct?" });
      await stream.append({ type: PERSONA_TURN_EVENT, text: "Yes, bye." });
      await _endCall(llm, { success: true, reason: "done" });
    });
    const result = driver.result({ failures: [], durationMs: 0, eventsSeen: [], debugLog: [] });
    expect(result.endedBy).toBe("end_call");
    expect(result.messages[result.messages.length - 1]).toEqual({
      role: "user",
      content: "Yes, bye.",
    });
  });

  test("test_a_hang_up_on_the_bots_line_ends_at_once", async () => {
    const [driver, stream, llm] = _driver(_simulation(), new _FakeConversationJudge(["yes"]));

    const started = monotonic();
    await runWith(driver, async () => {
      await stream.append({ type: "llm_response", text: "Hello?" });
      await stream.append({ type: PERSONA_TURN_EVENT, text: "Wrong number." });
      await stream.append({ type: "llm_response", text: "No problem, goodbye." });
      await _endCall(llm, { success: false, reason: "wrong number" });
    });
    expect(monotonic() - started).toBeLessThan(1.0);
    const result = driver.result({ failures: [], durationMs: 0, eventsSeen: [], debugLog: [] });
    expect(result.endedBy).toBe("end_call");
  });
});

/** A lull, a harness failure, or a judge with no verdict ends the run without waiting out the caps. */
describe("TestSimulationEarlyEndings", () => {
  test("test_a_lull_ends_the_run_as_silence", async () => {
    const [driver] = _driver(
      _simulation({ maxSilenceS: 0.05, maxDurationS: 5.0 }),
      new _FakeConversationJudge(["no"]),
    );
    await driver.run();
    const result = driver.result({ failures: [], durationMs: 0, eventsSeen: [], debugLog: [] });
    expect(result.endedBy).toBe("silence");
    expect(result.passed).toBe(false);
  });

  test("test_activity_keeps_a_lull_from_ending_the_run", async () => {
    const [driver, stream, llm] = _driver(
      _simulation({ maxSilenceS: 0.2, maxDurationS: 5.0 }),
      new _FakeConversationJudge(["yes"]),
    );

    await runWith(driver, async () => {
      // Activity spaced inside the lull cap, spanning more than the cap:
      // an event, then frames that only buffer toward one.
      await sleep(0.1);
      await stream.append({ type: "llm_started" });
      for (let i = 0; i < 3; i++) {
        await sleep(0.1);
        stream.frameToEvent(new LLMTextFrame({ text: "token " }));
      }
      await _endCall(llm, { success: true, reason: "done" });
    });
    const result = driver.result({ failures: [], durationMs: 0, eventsSeen: [], debugLog: [] });
    expect(result.endedBy).toBe("end_call");
  });

  test("test_a_harness_pipeline_error_is_the_runs_error", async () => {
    const [driver, stream, , client] = _driver(_simulation(), new _FakeConversationJudge(["yes"]));

    const failures = await runWith(driver, async () => {
      await stream.append({ type: HARNESS_ERROR_EVENT, text: "OLLamaLLMService: 400" });
    });
    expect(failures.map((f) => [f.kind, f.reason])).toEqual([["error", "OLLamaLLMService: 400"]]);
    expect(client.hungUp).toBe(true);
    const result = driver.result({ failures, durationMs: 0, eventsSeen: [], debugLog: [] });
    expect([result.endedBy, result.error]).toEqual(["error", "OLLamaLLMService: 400"]);
    expect(result.passed).toBe(false);
  });

  test("test_a_judge_with_no_goal_verdict_is_the_runs_error", async () => {
    const [driver, stream, llm] = _driver(_simulation(), new _FakeConversationJudge(["none"]));

    const failures = await runWith(driver, async () => {
      await stream.append({ type: "llm_response", text: "Berlin." });
      await _endCall(llm, { success: true, reason: "done" });
    });
    expect(failures.map((f) => f.kind)).toEqual(["judge_no_verdict"]);
    const result = driver.result({ failures, durationMs: 0, eventsSeen: [], debugLog: [] });
    expect(result.endedBy).toBe("end_call");
    expect(result.succeeded).toBe(false);
    expect(result.error ?? "").toContain("because");
  });
});

/** A failed metric's failure kind says whether the judge rejected a turn or left it unanswered. */
describe("TestSimulationMetricKinds", () => {
  async function _score(turnVerdicts: Record<string, string>[]) {
    const metrics = [
      new EvalSimulationMetric({ name: "brevity", criterion: "short", minScore: 1.0 }),
    ];
    const [driver, stream, llm] = _driver(
      _simulation({ metrics }),
      new _FakeConversationJudge(["yes"], turnVerdicts),
    );

    await runWith(driver, async () => {
      await stream.append({ type: "llm_response", text: "one" });
      await stream.append({ type: PERSONA_TURN_EVENT, text: "and?" });
      await stream.append({ type: "llm_response", text: "two" });
      await _endCall(llm, { success: true, reason: "done" });
    });
    const result = driver.result({ failures: [], durationMs: 0, eventsSeen: [], debugLog: [] });
    return result.metrics[0]!;
  }

  test("test_a_rejected_turn_is_judge_no", async () => {
    const metric = await _score([{}, { brevity: "no" }]);
    expect([metric.passed, metric.failureKind]).toEqual([false, "judge_no"]);
    expect(metric.verdicts.map((v) => v.verdict)).toEqual(["yes", "no"]);
  });

  test("test_an_unanswered_turn_alone_is_judge_no_verdict", async () => {
    const metric = await _score([{}, { brevity: "none" }]);
    expect([metric.passed, metric.failureKind]).toEqual([false, "judge_no_verdict"]);
    expect(metric.verdicts.map((v) => v.verdict)).toEqual(["yes", "none"]);
  });

  test("test_a_passing_metric_has_no_kind", async () => {
    const metric = await _score([{}, {}]);
    expect([metric.passed, metric.failureKind]).toEqual([true, null]);
  });
});

describe("TestSimulatorDefault", () => {
  test("test_simulator_is_optional_and_describes_as_the_default_judge_model", async () => {
    const text = MINIMAL.split("\n")
      .filter((line) => !line.startsWith("simulator"))
      .join("\n");
    const s = await _loadSimulation(_write(text));
    expect(s.simulator).toEqual({});
    expect(s.maxSilenceS).toBe(30.0);
    const described = describeSimulation(s);
    expect(described).toContain("persona: ollama/gemma4:12b");
    expect(described).toContain("max_silence_s: 30");
  });

  test("test_a_partial_simulator_keeps_its_own_values", async () => {
    const s = await _loadSimulation(_write(`${MINIMAL}max_silence_s: 7\n`));
    expect(s.maxSilenceS).toBe(7.0);
    expect(describeSimulation(s)).toContain("persona: openai/gpt-4o-mini");
  });

  // Skipped: it exercises `service: openai`, a deprecated service name (only
  // `ollama` and `factory` are supported), so the `openai/<default model>`
  // summary it asserts is deprecated-only behaviour, not ported.
  test.skip("test_the_summary_names_what_the_block_builds", async () => {
    // A service without a model shows the model the builder defaults to; a
    // factory is named as such, since the summary cannot know what it builds.
    const without = MINIMAL.split("\n")
      .filter((l) => !l.startsWith("simulator"))
      .join("\n");
    const openai = await _loadSimulation(_write(`${without}\nsimulator: {service: openai}\n`));
    expect(describeSimulation(openai)).toContain("persona: openai/gpt-4o");
    const factory = await _loadSimulation(
      _write(`${without}\nsimulator: {factory: my_evals.persona}\n`),
    );
    expect(describeSimulation(factory)).toContain("persona: factory:my_evals.persona");
    const judged = await _loadSimulation(
      _write(`${MINIMAL}judge: {eval: {factory: my_evals.judge}}\n`),
    );
    expect(describeSimulation(judged)).toContain("eval: factory:my_evals.judge");
  });
});
