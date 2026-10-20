// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_backend_llm_worker.py

/**
 * Unit tests for BackendLLMWorker and _BackendSession.
 *
 * A scripted LLM service stands in for the backend model: each LLMContextFrame
 * plays the next scripted response (text and/or function calls), so the tests
 * exercise the real aggregators, tool loop and job plumbing under a
 * WorkerRunner, driven through a _BackendSession as a frontend drives them.
 */

import { expect, test } from "bun:test";

import { Event, gather, sleep, waitFor } from "@pipedog/asyncio";

import { toolOptions } from "../src/adapters/schemas/direct_function.ts";
import type { BusJobRequestMessage } from "../src/bus/messages.ts";
import {
  type Frame,
  FunctionCallFromLLM,
  LLMContextFrame,
  LLMFullResponseEndFrame,
  LLMFullResponseStartFrame,
  LLMTextFrame,
  LLMThoughtEndFrame,
  LLMThoughtStartFrame,
  LLMThoughtTextFrame,
} from "../src/frames/frames.ts";
import { JobError } from "../src/pipeline/job_context.ts";
import { job } from "../src/pipeline/job_decorator.ts";
import {
  LLMContext,
  type LLMContextMessage,
  LLMSpecificMessage,
} from "../src/processors/aggregators/llm_context.ts";
import type { FrameDirection } from "../src/processors/frame_processor.ts";
import { type FunctionCallParams, LLMService } from "../src/services/llm_service.ts";
import { LLMSettings } from "../src/services/settings.ts";
import { BaseWorker } from "../src/workers/base_worker.ts";
import {
  _BackendSession,
  _renderExplicitRequest,
  _renderTranscriptRequest,
  _splitSpoken,
  BACKEND_PAIRING_INSTRUCTION,
  BackendError,
  BackendIdle,
  BackendOutput,
  type BackendOutputTransform,
  BackendToolCall,
  SPOKEN_MARK,
} from "../src/workers/llm/backend_llm_worker.ts";
import { BackendLLMWorker } from "../src/workers/llm/index.ts";
import { WorkerRunner } from "../src/workers/runner.ts";

type Any = any;

type ScriptStep =
  | ["text", string]
  | ["thought", string]
  | ["error", string]
  | ["call", string, string, Record<string, unknown>];

/**
 * Plays one scripted response per LLMContextFrame.
 *
 * A script step is `["text", str]`, `["thought", str]`, `["error", str]` or
 * `["call", name, callId, args]`. `settleSecs` holds the response open after
 * issuing its calls so a fast tool can return before the response ends.
 */
class _ScriptedLLM extends LLMService {
  #runs: ScriptStep[][];
  #settleSecs: number;
  contextsSeen: LLMContextMessage[][] = [];

  constructor(runs: ScriptStep[][], options: { settleSecs?: number } = {}) {
    super({
      settings: new LLMSettings({
        model: "scripted",
        systemInstruction: null,
        temperature: null,
        maxTokens: null,
        topP: null,
        topK: null,
        frequencyPenalty: null,
        presencePenalty: null,
        seed: null,
        filterIncompleteUserTurns: false,
        userTurnCompletionConfig: null,
      }),
    });
    this.#runs = [...runs];
    this.#settleSecs = options.settleSecs ?? 0.0;
  }

  override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
    await super.processFrame(frame, direction);
    if (!(frame instanceof LLMContextFrame)) {
      await this.pushFrame(frame, direction);
      return;
    }

    this.contextsSeen.push([...frame.context.getMessages()]);
    const steps = this.#runs.length > 0 ? (this.#runs.shift() as ScriptStep[]) : [];
    await this.pushFrame(new LLMFullResponseStartFrame());
    const calls: FunctionCallFromLLM[] = [];
    for (const step of steps) {
      if (step[0] === "text") {
        await this.pushFrame(new LLMTextFrame({ text: step[1] }));
      } else if (step[0] === "thought") {
        await this.pushFrame(new LLMThoughtStartFrame());
        await this.pushFrame(new LLMThoughtTextFrame({ text: step[1] }));
        await this.pushFrame(new LLMThoughtEndFrame());
      } else if (step[0] === "error") {
        await this.pushError(step[1]);
      } else {
        const [, name, callId, args] = step;
        calls.push(
          new FunctionCallFromLLM({
            context: frame.context,
            toolCallId: callId,
            functionName: name,
            arguments: args,
          }),
        );
      }
    }
    if (calls.length > 0) {
      await this.runFunctionCalls(calls);
      if (this.#settleSecs) {
        await sleep(this.#settleSecs);
      }
    }
    await this.pushFrame(new LLMFullResponseEndFrame());
  }
}

/** The settings of a scripted LLM, typed (Python reads them directly). */
function settingsOf(llm: LLMService): LLMSettings {
  return llm.settings as LLMSettings;
}

/**
 * Get the weather.
 *
 * @param location The city.
 */
async function get_weather(params: FunctionCallParams, location: string): Promise<void> {
  void location;
  await params.resultCallback({ temp: 62, conditions: "rain" });
}
Object.assign(get_weather, {
  description: "Get the weather.",
  parameters: { location: { type: "string", description: "The city." } },
});

/**
 * Check a flight's status.
 *
 * @param flight_number The flight number.
 */
async function check_flight_status(
  params: FunctionCallParams,
  flight_number: string,
): Promise<void> {
  void flight_number;
  await params.resultCallback({ status: "delayed", departure_time: "14:30" });
}
Object.assign(check_flight_status, {
  description: "Check a flight's status.",
  parameters: { flight_number: { type: "string", description: "The flight number." } },
});

/** Fail. */
async function raise_an_error(params: FunctionCallParams): Promise<void> {
  void params;
  throw new Error("the tool broke");
}
Object.assign(raise_an_error, { description: "Fail." });

/**
 * Book a taxi.
 *
 * @param time The time to book it for.
 */
async function book_taxi(params: FunctionCallParams, time: string): Promise<void> {
  void time;
  await params.resultCallback({ status: "done" });
}
Object.assign(book_taxi, {
  description: "Book a taxi.",
  parameters: { time: { type: "string", description: "The time to book it for." } },
});

/** `dataclasses.replace(output, text=...)`. */
function replaceText(output: BackendOutput, text: string): BackendOutput {
  return new BackendOutput({
    text,
    isThought: output.isThought,
    prefersSpoken: output.prefersSpoken,
  });
}

/** `pytest.raises(E, match=pattern)` around an awaited call. */
async function expectRaises(
  fn: () => Promise<unknown>,
  errorClass: new (...args: Any[]) => Error,
  pattern: RegExp,
): Promise<void> {
  let caught: unknown = null;
  try {
    await fn();
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(errorClass);
  expect((caught as Error).message).toMatch(pattern);
}

test("test_render_transcript_request_is_the_instruction_alone_when_nothing_was_said", () => {
  expect(_renderTranscriptRequest([], { instruction: "Do it" })).toBe("Do it");
});

test("test_a_mark_on_a_later_line_is_not_spoken_as_text", () => {
  const [note, spoken] = _splitSpoken("Found it.\n\n>> The test is fixed.\n>> All 42 pass.");
  expect([note, spoken]).toEqual(["Found it.", "The test is fixed.\nAll 42 pass."]);
});

test("test_render_explicit_request_puts_the_instruction_after_the_request", () => {
  expect(_renderExplicitRequest("Book a taxi", { instruction: "Do it" })).toBe(
    "Book a taxi\n\nDo it",
  );
});

test("test_render_transcript_request_points_the_backend_at_the_conversation", () => {
  const rendered = _renderTranscriptRequest([{ role: "user", content: "what's the weather" }]);
  expect(rendered).toBe(
    "Voice conversation so far:\n" +
      "USER: what's the weather\n" +
      "\n" +
      "Act on the user's most recent request in the conversation above. If it asks for something, tell the user the result as soon as you have it, before going on with other work, in a message that begins with >>. If it only stops or changes work already under way, tell them nothing: the assistant already has.",
  );
});

test("test_a_payload_names_its_type", () => {
  expect(new BackendOutput({ text: "hello" }).toPayload().type).toBe("output");
  expect(
    new BackendToolCall({ phase: "started", functionName: "f", toolCallId: "c1" }).toPayload().type,
  ).toBe("tool_call");
});

test("test_a_tool_call_phase_survives_the_payload_round_trip", () => {
  const call = new BackendToolCall({
    phase: "result",
    functionName: "get_weather",
    toolCallId: "c1",
    arguments: { a: 1 },
    result: { t: 62 },
  });
  expect(BackendToolCall.fromPayload(call.toPayload())).toEqual(call);
});

// A sender that predates a flag should not decide its value.
test("test_a_payload_leaves_the_flags_it_omits_at_their_defaults", () => {
  expect(BackendOutput.fromPayload({ text: "hello" })).toEqual(
    new BackendOutput({ text: "hello" }),
  );
});

// Flags cross a bus, so what arrives may not be a bool.
test("test_a_payload_coerces_the_flags_it_carries", () => {
  const rebuilt = BackendOutput.fromPayload({ text: "hello", is_thought: 1, prefers_spoken: 0 });
  expect([rebuilt.isThought, rebuilt.prefersSpoken]).toEqual([true, false]);
});

// A frontend can pass its context slice as-is; only spoken text survives.
test("test_render_transcript_request_flattens_what_a_transcript_can_hold", () => {
  const rendered = _renderTranscriptRequest([
    { role: "system", content: "You are helpful." },
    { role: "user", content: [{ type: "text", text: "what is this" }] },
    {
      role: "assistant",
      content: "Let me look.",
      tool_calls: [
        {
          id: "call_1",
          type: "function",
          function: { name: "look", arguments: "{}" },
        },
      ],
    },
    { role: "tool", tool_call_id: "call_1", content: '{"seen": true}' },
    new LLMSpecificMessage({ llm: "anthropic", message: { type: "thought", text: "hmm" } }),
  ] as LLMContextMessage[]);
  expect(rendered).toBe(
    "Voice conversation so far:\n" +
      "USER: what is this\n" +
      "ASSISTANT: Let me look.\n" +
      "\n" +
      "Act on the user's most recent request in the conversation above. If it asks for something, tell the user the result as soon as you have it, before going on with other work, in a message that begins with >>. If it only stops or changes work already under way, tell them nothing: the assistant already has.",
  );
});

// ---------------------------------------------------------------------------
// The attached contract
// ---------------------------------------------------------------------------

/** A backend and a requester under one runner, not yet running. */
function _attachedBackend(
  llm: _ScriptedLLM,
  options: { tools?: Any[] | null; transformOutput?: BackendOutputTransform | null } = {},
): [BackendLLMWorker, BaseWorker, WorkerRunner] {
  const backend = new BackendLLMWorker({
    llm,
    name: "backend",
    context: new LLMContext({
      messages: [{ role: "system", content: "You are the backend." }],
      tools: options.tools ?? [get_weather],
    }),
    transformOutput: options.transformOutput ?? null,
  });
  const requester = new BaseWorker({ name: "requester" });
  const runner = new WorkerRunner({ handleSigint: false });
  return [backend, requester, runner];
}

/** Run the runner and `body` together, cancelling the runner when the body is done. */
async function _drive(
  runner: WorkerRunner,
  requester: BaseWorker,
  backend: BackendLLMWorker,
  body: () => Promise<void>,
): Promise<void> {
  await runner.addWorkers(requester, backend);

  const runBody = async () => {
    try {
      await body();
    } finally {
      await runner.cancel();
    }
  };

  await waitFor(
    () =>
      gather(
        () => runner.run(),
        () => runBody(),
      ),
    15,
  );
}

/** Collect the session's events up to and including the next idle. */
async function _untilIdle(session: _BackendSession): Promise<unknown[]> {
  const events: unknown[] = [];
  for await (const event of session) {
    events.push(event);
    if (event instanceof BackendIdle) {
      break;
    }
  }
  return events;
}

function outputsOf(events: unknown[]): BackendOutput[] {
  return events.filter((e): e is BackendOutput => e instanceof BackendOutput);
}

function callsOf(events: unknown[]): BackendToolCall[] {
  return events.filter((e): e is BackendToolCall => e instanceof BackendToolCall);
}

function contentsOf(messages: LLMContextMessage[]): unknown[] {
  return messages.map((m) => (m as Any).content);
}

test("test_an_attached_frontend_hears_the_backend_work_a_request_through", async () => {
  const llm = new _ScriptedLLM([
    [
      ["text", "Let me check."],
      ["call", "get_weather", "call_1", { location: "Seattle" }],
    ],
    [["text", ">> It's 62 and raining in Seattle."]],
  ]);
  const [backend, requester, runner] = _attachedBackend(llm);
  const events: unknown[] = [];
  const statuses: string[] = [];

  const body = async () => {
    await new _BackendSession(requester, "backend").run(async (session) => {
      statuses.push(await session.send("what's the weather in seattle"));
      events.push(...(await _untilIdle(session)));
      expect(session.capabilities).toEqual({ steering: true, progress: true });
    });
  };

  await _drive(runner, requester, backend, body);

  expect(statuses).toEqual(["idle"]);
  // A message the model begins with the mark is for the user, and arrives
  // without it; anything else it writes is notes on the work.
  expect(outputsOf(events)).toEqual([
    new BackendOutput({ text: "Let me check.", prefersSpoken: false }),
    new BackendOutput({ text: "It's 62 and raining in Seattle.", prefersSpoken: true }),
  ]);
  expect(callsOf(events).map((c) => [c.phase, c.functionName])).toEqual([
    ["started", "get_weather"],
    ["in_progress", "get_weather"],
    ["result", "get_weather"],
  ]);
  expect(events[events.length - 1]).toBeInstanceOf(BackendIdle);
  const first = llm.contextsSeen[0] as LLMContextMessage[];
  expect(first[first.length - 1]).toEqual({
    role: "user",
    content: "what's the weather in seattle",
  });
  expect(backend.working).toBe(false);
});

// No run of its own: the run that follows the current step sees the request beside the result.
test("test_a_message_sent_while_the_model_runs_is_taken_up_by_the_next_run", async () => {
  const lookupStarted = new Event();
  const lookupMayFinish = new Event();

  /** Look something up, slowly. */
  async function slow_lookup(params: FunctionCallParams): Promise<void> {
    lookupStarted.set();
    await lookupMayFinish.wait();
    await params.resultCallback({ found: true });
  }
  Object.assign(slow_lookup, { description: "Look something up, slowly." });

  // The response stays open for a while after issuing its call, so the second
  // message arrives while the model is still busy with the first.
  const llm = new _ScriptedLLM(
    [[["call", "slow_lookup", "call_1", {}]], [["text", ">> Done with both."]]],
    { settleSecs: 1.0 },
  );
  const [backend, requester, runner] = _attachedBackend(llm, { tools: [slow_lookup] });
  const statuses: string[] = [];
  const events: unknown[] = [];

  const body = async () => {
    await new _BackendSession(requester, "backend").run(async (session) => {
      statuses.push(await session.send("First"));
      await waitFor(() => lookupStarted.wait(), 5);
      statuses.push(await session.send("Second"));
      lookupMayFinish.set();
      events.push(...(await _untilIdle(session)));
    });
  };

  await _drive(runner, requester, backend, body);

  expect(statuses).toEqual(["idle", "working"]);
  expect(llm.contextsSeen.length).toBe(2);
  const users = (llm.contextsSeen[1] as LLMContextMessage[])
    .filter((m) => (m as Any).role === "user")
    .map((m) => (m as Any).content);
  expect(users).toEqual(["First", "Second"]);
  expect(outputsOf(events).map((e) => e.text)).toEqual(["Done with both."]);
});

// The context lacks the call's result until it returns, so the request rides the run it brings.
test("test_a_message_sent_while_a_synchronous_tool_is_in_flight_waits_for_its_result", async () => {
  const lookupStarted = new Event();
  const lookupMayFinish = new Event();

  /** Look something up, slowly. */
  async function slow_lookup(params: FunctionCallParams): Promise<void> {
    lookupStarted.set();
    await lookupMayFinish.wait();
    await params.resultCallback({ found: true });
  }
  Object.assign(slow_lookup, { description: "Look something up, slowly." });

  const llm = new _ScriptedLLM([
    [["call", "slow_lookup", "call_1", {}]],
    [["text", ">> The lookup is done, and on to the second thing."]],
  ]);
  const [backend, requester, runner] = _attachedBackend(llm, { tools: [slow_lookup] });
  const events: unknown[] = [];

  const body = async () => {
    await new _BackendSession(requester, "backend").run(async (session) => {
      await session.send("First");
      await waitFor(() => lookupStarted.wait(), 5);
      expect(await session.send("Second")).toBe("working");
      await sleep(0.2);
      expect(llm.contextsSeen.length).toBe(1);
      lookupMayFinish.set();
      events.push(...(await _untilIdle(session)));
    });
  };

  await _drive(runner, requester, backend, body);

  expect(outputsOf(events).map((e) => e.text)).toEqual([
    "The lookup is done, and on to the second thing.",
  ]);
  // One run for both: the result and the request were in view together.
  expect(llm.contextsSeen.length).toBe(2);
  const contents = contentsOf(llm.contextsSeen[1] as LLMContextMessage[]);
  expect(contents).toContain("Second");
  expect(contents.some((c) => typeof c === "string" && c.includes("found"))).toBe(true);
});

// The model is idle and the call has its placeholder, so the request does not wait.
test("test_a_message_sent_while_only_an_asynchronous_tool_is_in_flight_runs_at_once", async () => {
  const lookupStarted = new Event();
  const lookupMayFinish = new Event();

  /** Look something up, slowly. */
  const slow_lookup = toolOptions({ cancelOnInterruption: false })(async function slow_lookup(
    params: FunctionCallParams,
  ): Promise<void> {
    lookupStarted.set();
    await lookupMayFinish.wait();
    await params.resultCallback({ found: true });
  });
  Object.assign(slow_lookup, { description: "Look something up, slowly." });

  const llm = new _ScriptedLLM([
    [["call", "slow_lookup", "call_1", {}]],
    [["text", ">> On the second thing now."]],
    [["text", ">> And the lookup is done."]],
  ]);
  const [backend, requester, runner] = _attachedBackend(llm, { tools: [slow_lookup] });
  const events: unknown[] = [];

  const body = async () => {
    await new _BackendSession(requester, "backend").run(async (session) => {
      await session.send("First");
      await waitFor(() => lookupStarted.wait(), 5);
      expect(await session.send("Second")).toBe("working");
      for await (const event of session) {
        events.push(event);
        if (event instanceof BackendOutput) {
          break;
        }
      }
      lookupMayFinish.set();
      events.push(...(await _untilIdle(session)));
    });
  };

  await _drive(runner, requester, backend, body);

  // The second request ran before the lookup returned, on a context that
  // still had the call in progress.
  expect(outputsOf(events).map((e) => e.text)).toEqual([
    "On the second thing now.",
    "And the lookup is done.",
  ]);
  expect(llm.contextsSeen.length).toBe(3);
  expect(contentsOf(llm.contextsSeen[1] as LLMContextMessage[])).toContain("Second");
});

test("test_closing_the_session_stops_the_backend_and_the_next_session_starts_clean", async () => {
  const started = new Event();

  /** Look something up, slowly. */
  async function slow_lookup(params: FunctionCallParams): Promise<void> {
    started.set();
    await sleep(30);
    await params.resultCallback({ never: "reached" });
  }
  Object.assign(slow_lookup, { description: "Look something up, slowly." });

  const llm = new _ScriptedLLM([
    [["call", "slow_lookup", "call_1", {}]],
    [["text", ">> Second time round."]],
  ]);
  const [backend, requester, runner] = _attachedBackend(llm, { tools: [slow_lookup] });
  const second: unknown[] = [];

  const body = async () => {
    await new _BackendSession(requester, "backend").run(async (session) => {
      await session.send("First");
      await waitFor(() => started.wait(), 5);
    });
    for (let i = 0; i < 50; i++) {
      if ((backend as Any)._attached === null && !backend.working) {
        break;
      }
      await sleep(0.1);
    }
    expect((backend as Any)._attached).toBeNull();
    await new _BackendSession(requester, "backend").run(async (session) => {
      await session.send("Second");
      second.push(...(await _untilIdle(session)));
    });
  };

  await _drive(runner, requester, backend, body);

  expect(outputsOf(second).map((e) => e.text)).toEqual(["Second time round."]);
});

// The cancellations a detach brings must not run the model on the request they settle.
test("test_detaching_lets_go_of_a_request_held_for_a_call_in_flight", async () => {
  const lookupStarted = new Event();

  /** Look something up, slowly. */
  async function slow_lookup(params: FunctionCallParams): Promise<void> {
    lookupStarted.set();
    await sleep(30);
    await params.resultCallback({ found: true });
  }
  Object.assign(slow_lookup, { description: "Look something up, slowly." });

  const llm = new _ScriptedLLM([
    [["call", "slow_lookup", "call_1", {}]],
    [["text", ">> Never ran."]],
  ]);
  const [backend, requester, runner] = _attachedBackend(llm, { tools: [slow_lookup] });

  const body = async () => {
    await new _BackendSession(requester, "backend").run(async (session) => {
      await session.send("First");
      await waitFor(() => lookupStarted.wait(), 5);
      // Held for the synchronous call in flight.
      expect(await session.send("Second")).toBe("working");
    });
    // Detached: the call is cancelled, and the held request goes with it.
    await sleep(0.5);
    expect(backend.working).toBe(false);
    expect(llm.contextsSeen.length).toBe(1);
  };

  await _drive(runner, requester, backend, body);
});

test("test_a_second_frontend_cannot_attach_and_a_message_needs_an_attached_frontend", async () => {
  const llm = new _ScriptedLLM([[["text", ">> Hello."]]]);
  const [backend, requester, runner] = _attachedBackend(llm);
  const other = new BaseWorker({ name: "other" });

  const body = async () => {
    await expectRaises(
      () => new _BackendSession(requester, "backend").send("Anyone there?"),
      JobError,
      /no frontend is attached/,
    );
    await new _BackendSession(requester, "backend").run(async (session) => {
      await session.send("Hello");
      await _untilIdle(session);
      await new _BackendSession(other, "backend").run(async (second) => {
        await expectRaises(() => second.next(), JobError, /already attached/);
      });
    });
  };

  await runner.addWorkers(other);
  await _drive(runner, requester, backend, body);
});

test("test_a_backend_error_reaches_the_frontend_and_the_stream_goes_on", async () => {
  const llm = new _ScriptedLLM([[["error", "the provider is down"]], [["text", ">> Back again."]]]);
  const [backend, requester, runner] = _attachedBackend(llm);
  const events: unknown[] = [];

  const body = async () => {
    await new _BackendSession(requester, "backend").run(async (session) => {
      await session.send("First");
      for await (const event of session) {
        events.push(event);
        if (event instanceof BackendError) {
          break;
        }
      }
      await session.send("Second");
      events.push(...(await _untilIdle(session)));
    });
  };

  await _drive(runner, requester, backend, body);

  // The empty turn ends, and so goes idle, before the error frame reaches the worker.
  expect(events).toContainEqual(new BackendError({ error: "the provider is down" }));
  expect(outputsOf(events).map((e) => e.text)).toEqual(["Back again."]);
});

test("test_an_attached_frontend_hears_thoughts_and_the_apps_own_outputs", async () => {
  const llm = new _ScriptedLLM([
    [
      ["thought", "Check the weather first."],
      ["call", "report", "call_1", { text: "Halfway there." }],
    ],
    [["text", ">> Done."]],
  ]);

  let backend: BackendLLMWorker;

  /**
   * Tell the user something.
   *
   * @param text What to tell them.
   */
  async function report(params: FunctionCallParams, text: string): Promise<void> {
    await backend.sendOutput(new BackendOutput({ text }));
    await backend.sendOutput(new BackendOutput({ text: "shaped" }), {
      applyTransformOutput: true,
    });
    await params.resultCallback("told");
  }
  Object.assign(report, {
    description: "Tell the user something.",
    parameters: { text: { type: "string", description: "What to tell them." } },
  });

  const shout = async (output: BackendOutput): Promise<BackendOutput | null> => {
    if (output.isThought) {
      return null;
    }
    return replaceText(output, output.text.toUpperCase());
  };

  const [b, requester, runner] = _attachedBackend(llm, { tools: [report], transformOutput: shout });
  backend = b;
  const events: unknown[] = [];

  const body = async () => {
    await new _BackendSession(requester, "backend").run(async (session) => {
      await session.send("Do it");
      events.push(...(await _untilIdle(session)));
    });
  };

  await _drive(runner, requester, backend, body);

  // The thought was dropped by the transform; the app's outputs pass it unless asked.
  expect(outputsOf(events).map((e) => [e.text, e.isThought, e.prefersSpoken])).toEqual([
    ["Halfway there.", false, true],
    ["SHAPED", false, true],
    ["DONE.", false, true],
  ]);
});

// A backend speaking the contract may send update types the session does not know.
test("test_the_session_ignores_stream_updates_it_does_not_know", async () => {
  class _ContractBackend extends BaseWorker {
    async attachFrontend(message: BusJobRequestMessage): Promise<void> {
      await this.sendJobUpdate(message.jobId, { type: "progress", percent: 50 });
      await this.sendJobUpdate(message.jobId, new BackendOutput({ text: "Done." }).toPayload());
      await this.sendJobUpdate(message.jobId, { type: "idle" });
      await new Event().wait();
    }

    static {
      job({ name: "attach" })(_ContractBackend.prototype.attachFrontend);
    }
  }

  const requester = new BaseWorker({ name: "requester" });
  const runner = new WorkerRunner({ handleSigint: false });
  await runner.addWorkers(requester, new _ContractBackend({ name: "backend" }));
  const events: unknown[] = [];

  const body = async () => {
    try {
      await new _BackendSession(requester, "backend").run(async (session) => {
        events.push(...(await _untilIdle(session)));
      });
    } finally {
      await runner.cancel();
    }
  };

  await waitFor(
    () =>
      gather(
        () => runner.run(),
        () => body(),
      ),
    15,
  );
  expect(events).toEqual([new BackendOutput({ text: "Done." }), new BackendIdle()]);
});

test("test_transform_output_shapes_what_the_model_writes", async () => {
  const llm = new _ScriptedLLM([
    [
      ["text", ">> Checking."],
      ["call", "get_weather", "call_1", { location: "Seattle" }],
    ],
    [
      ["thought", "Keep it short."],
      ["text", "Internal note."],
    ],
    [["text", ""]],
  ]);

  const transformOutput = async (output: BackendOutput): Promise<BackendOutput | null> => {
    if (output.isThought) {
      return null;
    }
    if (output.prefersSpoken) {
      return replaceText(output, output.text.toUpperCase());
    }
    return replaceText(output, "");
  };

  const [backend, requester, runner] = _attachedBackend(llm, { transformOutput });
  const events: unknown[] = [];

  const body = async () => {
    await new _BackendSession(requester, "backend").run(async (session) => {
      await session.send("Do it");
      events.push(...(await _untilIdle(session)));
    });
  };

  await _drive(runner, requester, backend, body);

  // The transform sees each output after the mark rule (flag set, mark
  // stripped): the thought was dropped, the spoken output reshaped, and an
  // emptied note still sent.
  expect(outputsOf(events).map((e) => [e.text, e.prefersSpoken])).toEqual([
    ["CHECKING.", true],
    ["", false],
  ]);
});

test("test_a_marked_message_beside_tool_calls_is_spoken_and_the_calls_still_run", async () => {
  const llm = new _ScriptedLLM([
    [
      ["text", ">> Your flight is delayed, so I'm booking you a taxi."],
      ["call", "book_taxi", "call_1", { time: "12:30" }],
    ],
    [["text", ">> Taxi booked for 12:30."]],
  ]);
  const [backend, requester, runner] = _attachedBackend(llm, { tools: [book_taxi] });
  const events: unknown[] = [];

  const body = async () => {
    await new _BackendSession(requester, "backend").run(async (session) => {
      await session.send("Check my flight and book a taxi");
      events.push(...(await _untilIdle(session)));
    });
  };

  await _drive(runner, requester, backend, body);

  // The mark decides, not whether the turn made calls: a result can ride the
  // turn that starts the next step.
  expect(outputsOf(events).map((e) => [e.text, e.prefersSpoken])).toEqual([
    ["Your flight is delayed, so I'm booking you a taxi.", true],
    ["Taxi booked for 12:30.", true],
  ]);
  expect(new Set(callsOf(events).map((e) => e.functionName))).toEqual(new Set(["book_taxi"]));
  expect(llm.contextsSeen.length).toBe(2);
  expect(events[events.length - 1]).toBeInstanceOf(BackendIdle);
  // The model's own context keeps the message as written, mark and all.
  const assistant = (llm.contextsSeen[1] as LLMContextMessage[]).filter(
    (m) => (m as Any).role === "assistant",
  );
  expect(
    assistant.some((m) => String((m as Any).content).includes(">> Your flight is delayed")),
  ).toBe(true);
});

test("test_a_mark_partway_through_a_message_splits_it_into_a_note_and_a_result", async () => {
  const llm = new _ScriptedLLM([
    [
      [
        "text",
        "Found the issue: a fixed backoff. Fixing it next.\n\n" +
          ">> The runbook says to check the status page first.",
      ],
      ["call", "book_taxi", "call_1", { time: "12:30" }],
    ],
    [["text", ">> Fixed, and the tests pass."]],
  ]);
  const [backend, requester, runner] = _attachedBackend(llm, { tools: [book_taxi] });
  const events: unknown[] = [];

  const body = async () => {
    await new _BackendSession(requester, "backend").run(async (session) => {
      await session.send("Fix the test and look up the runbook");
      events.push(...(await _untilIdle(session)));
    });
  };

  await _drive(runner, requester, backend, body);

  // What precedes the marked line is a note; from the mark on is spoken.
  expect(outputsOf(events).map((e) => [e.text, e.prefersSpoken])).toEqual([
    ["Found the issue: a fixed backoff. Fixing it next.", false],
    ["The runbook says to check the status page first.", true],
    ["Fixed, and the tests pass.", true],
  ]);
});

// A message that stops the work gets no spoken reply: the model writes notes, or nothing.
test("test_an_unmarked_message_is_a_note_and_a_thought_is_never_spoken", async () => {
  const lookupStarted = new Event();

  /** Look something up, slowly. */
  const slow_lookup = toolOptions({ cancelOnInterruption: false, cancellableByLlm: true })(
    async function slow_lookup(params: FunctionCallParams): Promise<void> {
      lookupStarted.set();
      await sleep(30);
      await params.resultCallback({ found: true });
    },
  );
  Object.assign(slow_lookup, { description: "Look something up, slowly." });

  const llm = new _ScriptedLLM([
    [
      ["thought", ">> Look it up first."],
      ["call", "slow_lookup", "call_1", {}],
    ],
    [
      ["text", "Stopping the lookup."],
      ["call", "cancel_slow_lookup", "call_c", {}],
    ],
    // The cancellation's result brings one more run.
    [["text", "Nothing left to do."]],
  ]);
  const [backend, requester, runner] = _attachedBackend(llm, { tools: [slow_lookup] });
  const events: unknown[] = [];

  const body = async () => {
    await new _BackendSession(requester, "backend").run(async (session) => {
      await session.send("Look it up");
      await waitFor(() => lookupStarted.wait(), 5);
      expect(await session.send("Never mind")).toBe("working");
      events.push(...(await _untilIdle(session)));
    });
  };

  await _drive(runner, requester, backend, body);

  // A thought stays a note whatever it begins with, and keeps its text as is.
  expect(outputsOf(events).map((e) => [e.text, e.isThought, e.prefersSpoken])).toEqual([
    [">> Look it up first.", true, false],
    ["Stopping the lookup.", false, false],
    ["Nothing left to do.", false, false],
  ]);
  const phases = callsOf(events).map((e) => [e.functionName, e.phase]);
  expect(phases).toContainEqual(["slow_lookup", "cancelled"]);
  expect(events[events.length - 1]).toBeInstanceOf(BackendIdle);
  expect(llm.contextsSeen.length).toBe(3);
});

test("test_the_model_is_told_how_what_it_writes_reaches_the_user", () => {
  const llm = new _ScriptedLLM([]);
  new BackendLLMWorker({ llm });

  const told = ((llm as Any)._settings.systemInstruction as string | null) || "";
  expect(told).toContain(BACKEND_PAIRING_INSTRUCTION);
  expect(BACKEND_PAIRING_INSTRUCTION).toContain(SPOKEN_MARK);
});

test("test_the_llm_runs_at_its_providers_default_thinking", () => {
  const llm = new _ScriptedLLM([]);
  expect(settingsOf(llm).useProviderThinkingDefault).toBe(false);

  new BackendLLMWorker({ llm });

  expect(settingsOf(llm).useProviderThinkingDefault).toBe(true);
});

test("test_an_llm_that_declines_the_backend_role_is_refused", () => {
  const llm = new _ScriptedLLM([]);
  llm.llmWithBackendRoleObjection = (role) => `cannot be the ${role}`;

  expect(() => new BackendLLMWorker({ llm })).toThrow(/cannot be the backend/);
  expect(settingsOf(llm).useProviderThinkingDefault).toBe(false);
});

test("test_an_app_can_replace_the_backends_pairing_instruction", () => {
  const llm = new _ScriptedLLM([]);
  new BackendLLMWorker({
    llm,
    pairingInstruction: "Begin what the user should hear with >>.",
  });

  const told = ((llm as Any)._settings.systemInstruction as string | null) || "";
  expect(told).toContain("Begin what the user should hear with >>.");
  expect(told).not.toContain(BACKEND_PAIRING_INSTRUCTION);
});

test("test_a_tool_handler_that_raises_leaves_the_backend_working", async () => {
  const llm = new _ScriptedLLM([
    [["call", "raise_an_error", "call_1", {}]],
    [["text", ">> That did not work, sorry."]],
  ]);
  const [backend, requester, runner] = _attachedBackend(llm, { tools: [raise_an_error] });
  const events: unknown[] = [];

  const body = async () => {
    await new _BackendSession(requester, "backend").run(async (session) => {
      await session.send("Do it");
      events.push(...(await _untilIdle(session)));
    });
  };

  await _drive(runner, requester, backend, body);

  expect(events.some((e) => e instanceof BackendError)).toBe(false);
  expect(outputsOf(events).map((e) => e.text)).toEqual(["That did not work, sorry."]);
});

test("test_a_chained_request_reports_at_each_step_and_idles_at_the_end", async () => {
  const llm = new _ScriptedLLM([
    [
      ["thought", "Check the flight first."],
      ["call", "check_flight_status", "call_1", { flight_number: "AA100" }],
    ],
    [
      ["text", "It's delayed, so I'm booking a taxi for 12:30."],
      ["call", "book_taxi", "call_2", { time: "12:30" }],
    ],
    [["text", ">> Taxi booked for 12:30."]],
  ]);
  const [backend, requester, runner] = _attachedBackend(llm, {
    tools: [check_flight_status, book_taxi],
  });
  const events: unknown[] = [];

  const body = async () => {
    await new _BackendSession(requester, "backend").run(async (session) => {
      await session.send("Get me to the airport");
      events.push(...(await _untilIdle(session)));
    });
  };

  await _drive(runner, requester, backend, body);

  expect(llm.contextsSeen.length).toBe(3);
  expect(outputsOf(events).map((e) => [e.text, e.isThought])).toEqual([
    ["Check the flight first.", true],
    ["It's delayed, so I'm booking a taxi for 12:30.", false],
    ["Taxi booked for 12:30.", false],
  ]);
  expect(events[events.length - 1]).toBeInstanceOf(BackendIdle);
  expect(events.filter((e) => e instanceof BackendIdle).length).toBe(1);
});
