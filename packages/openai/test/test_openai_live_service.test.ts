// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_openai_live_service.py

/**
 * Unit tests for OpenAILiveLLMService: session configuration, event → frame
 * mapping, and the Responses-delegation function call path.
 *
 * Server events are scripted through the receive handler; outgoing client
 * events are recorded from `sendClientEvent`. The constructor does no I/O.
 *
 * Porting notes:
 * - Upstream monkeypatches `live_llm._BackendSession`. An ES module binding
 *   can't be reassigned from outside, so the backend worker module is mocked
 *   with `mock.module`, with a `_BackendSession` that builds the test's fake
 *   while a test installs one and the real session otherwise.
 * - Upstream shortens `SESSION_CLOSE_TIMEOUT_SECS` with monkeypatch; an
 *   exported `const` can't be patched, so that test waits out the real
 *   timeout.
 */

import { afterEach, expect, mock, test } from "bun:test";

import { gather, Queue, sleep } from "@pipedog/asyncio";
import { FunctionSchema } from "@pipedog/core/adapters/schemas/function_schema";
import { ToolsSchema } from "@pipedog/core/adapters/schemas/tools_schema";
import {
  ExternalFunctionCallInProgressFrame,
  FunctionCallCancelFrame,
  FunctionCallResultFrame,
  FunctionCallResultProperties,
  InputAudioRawFrame,
  InterimTranscriptionFrame,
  LLMFullResponseEndFrame,
  LLMFullResponseStartFrame,
  LLMSetToolsFrame,
  LLMTextFrame,
  ProposedUserStartedSpeakingFrame,
  ProposedUserStoppedSpeakingFrame,
  SpeechOutputAudioRawFrame,
  TranscriptionFrame,
  TTSStartedFrame,
  TTSStoppedFrame,
  TTSTextFrame,
} from "@pipedog/core/frames/frames";
import { JobError } from "@pipedog/core/pipeline/job_context";
import { LLMContext } from "@pipedog/core/processors/aggregators/llm_context";
import { FrameDirection } from "@pipedog/core/processors/frame_processor";
import { TaskManager } from "@pipedog/core/utils/asyncio/task_manager";
import { BaseObject } from "@pipedog/core/utils/base_object";
import { base64ToBytes, bytesToBase64 } from "@pipedog/core/utils/base64";
import { pyJsonDumps, pyJsonLoads } from "@pipedog/core/utils/py_json";
import * as backendModule from "@pipedog/core/workers/llm/backend_llm_worker";
import {
  BackendError,
  BackendIdle,
  BackendOutput,
  BackendToolCall,
} from "@pipedog/core/workers/llm/backend_llm_worker";

import * as events from "../src/live/events.ts";
import * as live_llm from "../src/live/llm.ts";
import { OpenAILiveLLMService } from "../src/live/llm.ts";
import { OpenAIResponsesLLMService } from "../src/responses/llm.ts";

// ---------------------------------------------------------------------------
// _BackendSession substitution (upstream: monkeypatch.setattr)
// ---------------------------------------------------------------------------

const RealBackendSession = backendModule._BackendSession;
type SessionFactory = (worker: unknown, backendName: string, options?: any) => unknown;
let backendSessionFactory: SessionFactory | null = null;

function _BackendSessionSwitch(this: unknown, worker: any, backendName: string, options?: any) {
  if (backendSessionFactory !== null) {
    return backendSessionFactory(worker, backendName, options);
  }
  return new RealBackendSession(worker, backendName, options);
}

mock.module("@pipedog/core/workers/llm/backend_llm_worker", () => ({
  ...backendModule,
  _BackendSession: _BackendSessionSwitch,
}));

afterEach(() => {
  backendSessionFactory = null;
});

// ---------------------------------------------------------------------------
// Fixtures / helpers
// ---------------------------------------------------------------------------

function _weatherTool(): FunctionSchema {
  return new FunctionSchema({
    name: "get_weather",
    description: "Get the weather.",
    properties: { location: { type: "string" } },
    required: ["location"],
  });
}

function _responsesDelegation(
  settings: Record<string, unknown> = {},
): live_llm.ResponsesDelegation {
  return new OpenAILiveLLMService.ResponsesDelegation({
    settings: new OpenAIResponsesLLMService.Settings({ model: "gpt-5.4-mini", ...settings }),
  });
}

function _makeService(
  options: { delegation?: any; settings?: any } = {},
): any /* OpenAILiveLLMService, with its protected members reachable as upstream's are */ {
  return new OpenAILiveLLMService({
    apiKey: "test-key",
    settings: options.settings ?? null,
    delegation: options.delegation ?? null,
  });
}

/** Turn gap short enough to keep tests quick, long enough to survive scheduling. */
const TEST_TURN_GAP_SECS = 0.05;

/** A service wired to a task manager, for the paths that run turn timers. */
async function _makeServiceWithTasks(
  options: { delegation?: any; settings?: any } = {},
): Promise<any> {
  const service = _makeService(options);
  // The gap is a constant in the service; shorten it here to keep tests quick.
  service._userTurn.gapSecs = service._assistantTurn.gapSecs = TEST_TURN_GAP_SECS;
  await BaseObject.prototype.setup.call(service, new TaskManager());
  return service;
}

/** Wait out the turn gap, so any open turn is closed by its timer. */
async function _letTurnsClose(_service: any): Promise<void> {
  await sleep(TEST_TURN_GAP_SECS * 3);
}

/** Minimal async-iterable websocket that yields scripted JSON strings. */
class _FakeWebSocket implements AsyncIterableIterator<string> {
  _messages: string[];

  constructor(messages: string[]) {
    this._messages = [...messages];
  }

  [Symbol.asyncIterator](): this {
    return this;
  }

  async next(): Promise<IteratorResult<string>> {
    if (this._messages.length === 0) {
      return { done: true, value: undefined };
    }
    return { done: false, value: this._messages.shift() as string };
  }

  async close(): Promise<void> {
    this._messages.length = 0;
  }
}

/** Records frames passed to a service's `pushFrame`. */
class _FrameRecorder {
  frames: [any, FrameDirection][] = [];

  call = async (frame: any, direction: FrameDirection = FrameDirection.DOWNSTREAM) => {
    this.frames.push([frame, direction]);
  };

  ofTypes(...types: any[]): any[] {
    return this.frames.filter(([f]) => types.some((t) => f instanceof t)).map(([f]) => f);
  }
}

/** Records outgoing client events (as dicts) sent via `sendClientEvent`. */
class _EventRecorder {
  events: Record<string, any>[] = [];

  call = async (event: events.ClientEvent) => {
    this.events.push(event.toPayload());
  };

  ofType(eventType: string): Record<string, any>[] {
    return this.events.filter((e) => e.type === eventType);
  }
}

/** Feed scripted server-event dicts through the receive handler. */
async function _drive(service: any, scripted: unknown[]): Promise<void> {
  service._websocket = new _FakeWebSocket(scripted.map((e) => pyJsonDumps(e)));
  await service._receiveTaskHandler();
}

function _transcriptDelta(
  role: string,
  delta: string,
  options: { startMs?: number } = {},
): Record<string, unknown> {
  const startMs = options.startMs ?? 0;
  const kind = role === "user" ? "input" : "output";
  return {
    type: `session.${kind}_transcript.delta`,
    delta,
    start_ms: startMs,
    end_ms: startMs + 200,
  };
}

function _delegationCreated(delegationId: string, target = "client"): Record<string, unknown> {
  const delegation: Record<string, unknown> = { id: delegationId, type: "delegation", target };
  if (target === "responses") {
    delegation.response_id = "resp_1";
  }
  return { type: "session.delegation.created", offset_ms: 1000, delegation };
}

function _responseEvent(
  inner: Record<string, unknown>,
  delegationId: string | null = "item_d1",
): Record<string, unknown> {
  const envelope: Record<string, unknown> = { type: "response.event", event: inner };
  if (delegationId !== null) {
    envelope.delegation_id = delegationId;
  }
  return envelope;
}

function _sessionStarted(): Record<string, unknown> {
  return {
    type: "session.started",
    session: { id: "live_123", model: "gpt-live-1" },
  };
}

/** The options a mocked `pushError` was last awaited with (upstream: `await_args.kwargs`). */
function lastKwargs(fn: ReturnType<typeof mock>): Record<string, any> {
  return (fn.mock.lastCall?.[1] as Record<string, any> | undefined) ?? {};
}

// ---------------------------------------------------------------------------
// Session configuration
// ---------------------------------------------------------------------------

test("test_initial_session_update_client_mode", async () => {
  // The first context configures instructions, voice, client delegation and initial items.
  const service = _makeService({
    settings: new OpenAILiveLLMService.Settings({ voice: "cedar" }),
  });
  const recorder = new _EventRecorder();
  service.sendClientEvent = recorder.call;

  const context = new LLMContext({
    messages: [
      { role: "system", content: "Be brief." },
      { role: "developer", content: "Greet the user." },
      { role: "user", content: [{ type: "text", text: "hi there" }] },
      { role: "assistant", content: "Hello!" },
      {
        role: "assistant",
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "get_weather", arguments: "{}" },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_1", content: '{"temp": 62}' },
    ] as any,
  });
  await service._handleContext(context);

  const starts = recorder.ofType("session.start");
  expect(starts.length).toBe(1);
  const session = starts[0]!.session;
  expect(session.model).toBe(live_llm.DEFAULT_MODEL);
  expect(session.instructions).toBe("Be brief.");
  expect(session.audio).toEqual({ output: { voice: "cedar" } });
  expect(session.delegation).toEqual({ type: "client" });
  expect(session.input).toEqual([
    {
      type: "message",
      role: "developer",
      content: [{ type: "input_text", text: "Greet the user." }],
    },
    {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "hi there" }],
    },
    {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "Hello!" }],
    },
  ]);
});

test("test_no_voice_setting_leaves_the_choice_to_the_api", async () => {
  // Without a voice, no audio config is sent and the API picks its default.
  const service = _makeService();
  const recorder = new _EventRecorder();
  service.sendClientEvent = recorder.call;

  await service._handleContext(
    new LLMContext({ messages: [{ role: "system", content: "Be brief." }] }),
  );

  const starts = recorder.ofType("session.start");
  expect(starts.length).toBe(1);
  expect("audio" in starts[0]!.session).toBe(false);
});

test("test_initial_session_update_responses_mode", async () => {
  // Responses settings map onto delegation.responses; tools/tool_choice come from the context.
  const delegation = new OpenAILiveLLMService.ResponsesDelegation({
    settings: new OpenAIResponsesLLMService.Settings({
      model: "gpt-5.4-mini",
      systemInstruction: "You are the backend.",
      reasoning: new OpenAIResponsesLLMService.ReasoningConfig({ effort: "low" }),
      maxCompletionTokens: 256,
      temperature: 0.5,
      extra: { text: { verbosity: "low" } },
    }),
    serviceTier: "priority",
  });
  const service = _makeService({ delegation });
  const recorder = new _EventRecorder();
  service.sendClientEvent = recorder.call;

  const context = new LLMContext({
    messages: [{ role: "system", content: "Be brief." }],
    tools: [_weatherTool()],
    toolChoice: { type: "function", function: { name: "get_weather" } } as any,
  });
  await service._handleContext(context);

  const starts = recorder.ofType("session.start");
  expect(starts.length).toBe(1);
  const session = starts[0]!.session;
  expect("input" in session).toBe(false);
  const responses = session.delegation.responses;
  expect(session.delegation.type).toBe("responses");
  expect(responses.model).toBe("gpt-5.4-mini");
  expect(responses.instructions).toBe("You are the backend.");
  expect(responses.reasoning).toEqual({ effort: "low" });
  expect(responses.max_output_tokens).toBe(256);
  expect(responses.service_tier).toBe("priority");
  expect(responses.text).toEqual({ verbosity: "low" });
  expect("temperature" in responses).toBe(false);
  expect(responses.tool_choice).toEqual({ type: "function", name: "get_weather" });
  expect(responses.tools.length).toBe(1);
  const tool = responses.tools[0];
  expect(tool.type).toBe("function");
  expect(tool.name).toBe("get_weather");
  expect("strict" in tool).toBe(false);
});

test("test_responses_delegation_requires_model", () => {
  expect(() =>
    _makeService({
      delegation: new OpenAILiveLLMService.ResponsesDelegation({
        settings: new OpenAIResponsesLLMService.Settings(),
      }),
    }),
  ).toThrow(/model is required/);
});

test("test_system_instruction_setting_wins_over_context_system_message", async () => {
  const service = _makeService({
    settings: new OpenAILiveLLMService.Settings({ systemInstruction: "From settings." }),
  });
  const recorder = new _EventRecorder();
  service.sendClientEvent = recorder.call;

  await service._handleContext(
    new LLMContext({ messages: [{ role: "system", content: "From context." }] }),
  );

  const starts = recorder.ofType("session.start");
  expect(starts.length).toBe(1);
  expect(starts[0]!.session.instructions).toBe("From settings.");
});

test("test_startup_history_keeps_the_most_recent_128", async () => {
  const service = _makeService();
  const recorder = new _EventRecorder();
  service.sendClientEvent = recorder.call;

  const messages = Array.from({ length: 200 }, (_, i) => ({
    role: "user" as const,
    content: `message ${i}`,
  }));
  await service._handleContext(new LLMContext({ messages }));

  const starts = recorder.ofType("session.start");
  expect(starts.length).toBe(1);
  const items = starts[0]!.session.input;
  expect(items.length).toBe(events.MAX_INPUT_ITEMS);
  expect(items[0].content[0].text).toBe("message 72");
  expect(items[items.length - 1].content[0].text).toBe("message 199");
});

test("test_later_context_frames_send_nothing_in_client_mode", async () => {
  const service = _makeService();
  const recorder = new _EventRecorder();
  service.sendClientEvent = recorder.call;

  const context = new LLMContext({ messages: [{ role: "user", content: "hi" }] });
  await service._handleContext(context);
  service._sessionStarted = true;
  context.addMessage({ role: "developer", content: "Appended by the app." } as any);
  await service._handleContext(context);

  expect(recorder.events.length).toBe(1);
});

test("test_a_set_tools_frame_sends_a_sparse_update_in_responses_mode", async () => {
  // The frame is what says the tools changed; a context frame carries no such news.
  const service = await _makeServiceWithTasks({ delegation: _responsesDelegation() });
  const recorder = new _EventRecorder();
  service.sendClientEvent = recorder.call;
  service.pushFrame = new _FrameRecorder().call;

  const context = new LLMContext({
    messages: [{ role: "user", content: "hi" }],
    tools: [_weatherTool()],
  });
  await service._handleContext(context);
  service._sessionStarted = true;

  // Same tools: nothing to send.
  await service.processFrame(
    new LLMSetToolsFrame({ tools: context.tools as any }),
    FrameDirection.DOWNSTREAM,
  );
  expect(recorder.ofType("session.update")).toEqual([]);

  // New tool set: sparse delegation update carrying only the tools. The user
  // aggregator sets them on the shared context and forwards the frame.
  const newTools = new ToolsSchema({ standardTools: [] });
  context.setTools(newTools);
  await service.processFrame(new LLMSetToolsFrame({ tools: newTools }), FrameDirection.DOWNSTREAM);

  const updates = recorder.ofType("session.update");
  expect(updates.length).toBe(1);
  expect(updates[0]!.session).toEqual({
    delegation: { type: "responses", responses: { tools: [] } },
  });
});

test("test_tools_that_change_while_the_session_starts_are_sent_once_it_has", async () => {
  // A session update has nowhere to land until the session has started.
  const service = await _makeServiceWithTasks({ delegation: _responsesDelegation() });
  const recorder = new _EventRecorder();
  service.sendClientEvent = recorder.call;
  service.pushFrame = new _FrameRecorder().call;

  const context = new LLMContext({
    messages: [{ role: "user", content: "hi" }],
    tools: [_weatherTool()],
  });
  await service._handleContext(context);

  const newTools = new ToolsSchema({ standardTools: [] });
  context.setTools(newTools);
  await service.processFrame(new LLMSetToolsFrame({ tools: newTools }), FrameDirection.DOWNSTREAM);
  expect(recorder.ofType("session.update")).toEqual([]);

  await _drive(service, [_sessionStarted()]);

  const updates = recorder.ofType("session.update");
  expect(updates.length).toBe(1);
  expect(updates[0]!.session).toEqual({
    delegation: { type: "responses", responses: { tools: [] } },
  });
});

test("test_a_failed_disconnect_still_allows_the_next_session_to_send", async () => {
  // `_disconnecting` gates every send, so it is cleared even when teardown fails.
  const service = await _makeServiceWithTasks();
  service.pushError = mock(async () => {});

  class _FailingWebSocket {
    async close(): Promise<void> {
      throw new Error("close failed");
    }
  }

  service._websocket = new _FailingWebSocket();
  await service._disconnect();

  expect(service.pushError).toHaveBeenCalledTimes(1);
  expect(service._disconnecting).toBe(false);
});

function _error(message = "boom"): Record<string, unknown> {
  return { type: "error", error: { type: "invalid_request", message } };
}

test("test_a_startup_error_is_fatal_for_every_session_not_just_the_first", async () => {
  // A reset asks for a new session, so its startup can fail in turn.
  const service = await _makeServiceWithTasks();
  service.sendClientEvent = new _EventRecorder().call;
  service.pushFrame = new _FrameRecorder().call;
  service.pushError = mock(async () => {});
  service._connect = mock(async () => {});

  const context = new LLMContext({ messages: [{ role: "user", content: "hi" }] });
  await service._handleContext(context);

  // First session: an error before it starts is a startup failure.
  await _drive(service, [_error()]);
  expect(lastKwargs(service.pushError).forceTreatAsPermanent).toBe(true);

  // It starts, and a later error is just an error.
  await _drive(service, [_sessionStarted(), _error()]);
  expect(lastKwargs(service.pushError).forceTreatAsPermanent).not.toBe(true);

  // An error while it shuts down is not a startup failure either.
  await _drive(service, [{ type: "session.closed", reason: "done" }, _error()]);
  expect(lastKwargs(service.pushError).forceTreatAsPermanent).not.toBe(true);

  // A reset asks for a second session; its startup can fail the same way.
  await service.resetConversation();
  await _drive(service, [_error()]);
  expect(lastKwargs(service.pushError).forceTreatAsPermanent).toBe(true);
});

test("test_the_opening_nudge_carries_a_null_delegation_id", async () => {
  // The append is session-wide, and the API requires the field even so.
  const service = await _makeServiceWithTasks();
  const recorder = new _EventRecorder();
  service.sendClientEvent = recorder.call;
  service.pushFrame = new _FrameRecorder().call;

  const context = new LLMContext({ messages: [{ role: "developer", content: "Greet the user." }] });
  await service._handleContext(context);
  await _drive(service, [_sessionStarted()]);

  const appends = recorder.ofType("session.commentary.append");
  expect(appends.length).toBe(1);
  expect(appends[0]!.delegation_id).toBeNull();
  expect(appends[0]!.content).toBe("Greet the user.");
});

// ---------------------------------------------------------------------------
// Audio
// ---------------------------------------------------------------------------

test("test_output_audio_delta_pushes_24khz_speech_audio_frame", async () => {
  const service = _makeService();
  const recorder = new _FrameRecorder();
  service.pushFrame = recorder.call;
  const audio = new Uint8Array(480);
  for (let i = 0; i < 480; i += 2) {
    audio[i] = 1;
    audio[i + 1] = 2;
  }

  await _drive(service, [
    {
      type: "session.output_audio.delta",
      delta: bytesToBase64(audio),
    },
  ]);

  const frames = recorder.ofTypes(SpeechOutputAudioRawFrame);
  expect(frames.length).toBe(1);
  const frame = frames[0];
  expect(frame.audio).toEqual(audio);
  expect(frame.sampleRate).toBe(24000);
  expect(frame.numChannels).toBe(1);
});

function _pattern01(bytes: number): Uint8Array {
  const out = new Uint8Array(bytes);
  for (let i = 1; i < bytes; i += 2) out[i] = 1;
  return out;
}

test("test_input_audio_is_dropped_until_session_started_and_resampled_to_24khz", async () => {
  const service = _makeService();
  const recorder = new _EventRecorder();
  service.sendClientEvent = recorder.call;
  const audio24k = _pattern01(960);

  await service._sendUserAudio(
    new InputAudioRawFrame({ audio: audio24k, sampleRate: 24000, numChannels: 1 }),
  );
  expect(recorder.events).toEqual([]);

  service._sessionStarted = true;
  await service._sendUserAudio(
    new InputAudioRawFrame({ audio: audio24k, sampleRate: 24000, numChannels: 1 }),
  );
  const appends = recorder.ofType("session.input_audio.append");
  expect(appends.length).toBe(1);
  expect(base64ToBytes(appends[0]!.audio)).toEqual(audio24k);

  // 16 kHz input is resampled to 24 kHz. The stream resampler emits in its
  // own chunk sizes with some latency, so feed 200 ms and check the total.
  for (let i = 0; i < 10; i++) {
    await service._sendUserAudio(
      new InputAudioRawFrame({ audio: _pattern01(640), sampleRate: 16000, numChannels: 1 }),
    );
  }
  const resampledLength = recorder
    .ofType("session.input_audio.append")
    .slice(1)
    .reduce((n, e) => n + base64ToBytes(e.audio).length, 0);
  expect(resampledLength).toBeGreaterThan(0);
  expect(resampledLength).toBeLessThanOrEqual(1.5 * 6400);
  expect(resampledLength % 2).toBe(0);
});

// ---------------------------------------------------------------------------
// Transcript fragments → turn frames
// ---------------------------------------------------------------------------

test("test_assistant_turn_brackets_text_with_one_response_and_tts_pair", async () => {
  const service = await _makeServiceWithTasks();
  const recorder = new _FrameRecorder();
  service.pushFrame = recorder.call;

  await _drive(service, [
    _transcriptDelta("assistant", "Hi"),
    _transcriptDelta("assistant", " there", { startMs: 200 }),
  ]);
  await _letTurnsClose(service);

  const frames = recorder.frames.map(([f]) => f);
  expect(frames.map((f) => f.constructor)).toEqual([
    LLMFullResponseStartFrame,
    TTSStartedFrame,
    LLMTextFrame,
    TTSTextFrame,
    LLMTextFrame,
    TTSTextFrame,
    TTSStoppedFrame,
    LLMFullResponseEndFrame,
  ]);
  const llmText = recorder.ofTypes(LLMTextFrame);
  expect(llmText.map((f) => f.text)).toEqual(["Hi", " there"]);
  expect(llmText.every((f) => f.appendToContext === false)).toBe(true);
  const ttsText = recorder.ofTypes(TTSTextFrame);
  expect(ttsText.map((f) => f.text)).toEqual(["Hi", " there"]);
  expect(ttsText.every((f) => f.includesInterFrameSpaces)).toBe(true);
});

test("test_user_turn_emits_proposed_speaking_frames_and_transcriptions", async () => {
  const service = await _makeServiceWithTasks();
  const recorder = new _FrameRecorder();
  service.pushFrame = recorder.call;

  await _drive(service, [
    _transcriptDelta("user", "what's"),
    _transcriptDelta("user", " the weather", { startMs: 200 }),
  ]);
  await _letTurnsClose(service);

  const started = recorder.ofTypes(ProposedUserStartedSpeakingFrame);
  const stopped = recorder.ofTypes(ProposedUserStoppedSpeakingFrame);
  // broadcast: one copy each direction
  expect(started.length === 2 && stopped.length === 2).toBe(true);

  const interim = recorder.frames.filter(([f]) => f instanceof InterimTranscriptionFrame);
  expect(interim.map(([f]) => f.text)).toEqual(["what's", "what's the weather"]);
  expect(interim.every(([, d]) => d === FrameDirection.UPSTREAM)).toBe(true);

  const finals = recorder.frames.filter(([f]) => f instanceof TranscriptionFrame);
  expect(finals.length).toBe(1);
  const [final, direction] = finals[0]!;
  expect(final.text).toBe("what's the weather");
  expect(direction).toBe(FrameDirection.UPSTREAM);

  // Transcription precedes the stop proposal.
  const types = recorder.frames.map(([f]) => f.constructor);
  expect(types.indexOf(TranscriptionFrame)).toBeLessThan(
    types.indexOf(ProposedUserStoppedSpeakingFrame),
  );
});

test("test_a_gap_ends_a_turn_and_the_next_fragment_starts_another", async () => {
  const service = await _makeServiceWithTasks();
  const recorder = new _FrameRecorder();
  service.pushFrame = recorder.call;

  await _drive(service, [_transcriptDelta("assistant", "First.")]);
  await _letTurnsClose(service);
  await _drive(service, [_transcriptDelta("assistant", "Second.", { startMs: 5000 })]);
  await _letTurnsClose(service);

  expect(recorder.ofTypes(LLMFullResponseStartFrame).length).toBe(2);
  expect(recorder.ofTypes(LLMFullResponseEndFrame).length).toBe(2);
  expect(recorder.ofTypes(TTSTextFrame).map((f) => f.text)).toEqual(["First.", "Second."]);
});

test("test_a_turn_closing_as_the_next_one_opens_keeps_its_frames_together", async () => {
  // The gap timer closes a turn from its own task, alongside the receive loop.
  const service = await _makeServiceWithTasks();
  const recorder = new _FrameRecorder();

  service.pushFrame = async (frame: any, direction: FrameDirection = FrameDirection.DOWNSTREAM) => {
    await sleep(0);
    await recorder.call(frame, direction);
  };

  await _drive(service, [_transcriptDelta("assistant", "First.")]);
  await gather(
    () => service._closeTurn("assistant"),
    () => _drive(service, [_transcriptDelta("assistant", "Second.", { startMs: 5000 })]),
  );
  await _letTurnsClose(service);

  const brackets = recorder.ofTypes(LLMFullResponseStartFrame, LLMFullResponseEndFrame);
  expect(brackets.map((f) => f.constructor)).toEqual([
    LLMFullResponseStartFrame,
    LLMFullResponseEndFrame,
    LLMFullResponseStartFrame,
    LLMFullResponseEndFrame,
  ]);
});

test("test_both_speakers_can_hold_a_turn_at_once", async () => {
  // Full duplex: the two directions are grouped independently.
  const service = await _makeServiceWithTasks();
  const recorder = new _FrameRecorder();
  service.pushFrame = recorder.call;

  await _drive(service, [
    _transcriptDelta("assistant", "Let me check"),
    _transcriptDelta("user", "actually wait"),
  ]);
  await _letTurnsClose(service);

  expect(recorder.ofTypes(TTSTextFrame).map((f) => f.text)).toEqual(["Let me check"]);
  const finals = recorder.frames.filter(([f]) => f instanceof TranscriptionFrame);
  expect(finals.length).toBe(1);
  expect(finals[0]![0].text).toBe("actually wait");
});

test("test_metadata_frame_recommends_external_turns_without_interruptions", () => {
  const service = _makeService();
  const frame = service.serviceMetadataFrame();
  expect(frame.isRealtimeService).toBe(false);
  expect(frame.userTurnStrategies).not.toBeNull();
  expect(frame.userTurnStrategies.enableInterruptions).toBe(false);
});

// ---------------------------------------------------------------------------
// Responses delegation: function calls
// ---------------------------------------------------------------------------

function _functionCallItem(callId: string, status = "completed"): Record<string, unknown> {
  return {
    type: "response.output_item.done",
    output_index: 0,
    item: {
      id: `fc_${callId}`,
      type: "function_call",
      status,
      call_id: callId,
      name: "get_weather",
      arguments: '{"location": "Seattle"}',
    },
  };
}

function _responseCreated(responseId = "resp_1"): Record<string, unknown> {
  return { type: "response.created", response: { id: responseId } };
}

function _responseCompleted(
  responseId = "resp_1",
  response: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    type: "response.completed",
    response: { id: responseId, output: [], ...response },
  };
}

test("test_completed_function_call_item_runs_the_function", async () => {
  const service = _makeService({ delegation: _responsesDelegation() });
  service._context = new LLMContext({ messages: [], tools: [_weatherTool()] });
  service.runFunctionCalls = mock(async () => {});

  await _drive(service, [
    _responseEvent(_responseCreated()),
    _responseEvent(_functionCallItem("call_1", "in_progress")),
    _responseEvent(_functionCallItem("call_1")),
  ]);

  expect(service.runFunctionCalls).toHaveBeenCalledTimes(1);
  const calls = service.runFunctionCalls.mock.calls[0][0];
  expect(calls.length).toBe(1);
  const call = calls[0];
  expect(call.toolCallId).toBe("call_1");
  expect(call.functionName).toBe("get_weather");
  expect(call.arguments).toEqual({ location: "Seattle" });
  expect(call.context).toBe(service._context);
  expect(service._openFunctionCalls.get("call_1")).toBe("item_d1");
});

test("test_function_result_is_queued_and_the_response_continued_once_all_are_in", async () => {
  const service = _makeService({ delegation: _responsesDelegation() });
  service._context = new LLMContext({ messages: [], tools: [_weatherTool()] });
  service.runFunctionCalls = mock(async () => {});
  const recorder = new _EventRecorder();
  service.sendClientEvent = recorder.call;

  await _drive(service, [
    _responseEvent(_responseCreated()),
    _responseEvent(_functionCallItem("call_1")),
    _responseEvent(_functionCallItem("call_2")),
    _responseEvent(_responseCompleted()),
  ]);

  const frame = new FunctionCallResultFrame({
    functionName: "get_weather",
    toolCallId: "call_1",
    arguments: { location: "Seattle" },
    result: { temp: 62 },
  });
  await service.pushFrame(frame, FrameDirection.UPSTREAM);
  expect(recorder.events).toEqual([]); // only the downstream broadcast copy is answered

  await service.pushFrame(frame);
  const items = recorder.ofType("response.item.create");
  expect(items.length).toBe(1);
  expect(items[0]!.item).toEqual({
    type: "function_call_output",
    call_id: "call_1",
    output: '{"temp": 62}',
  });
  // The other call is still outstanding, so the response is not continued yet.
  expect(recorder.ofType("response.create")).toEqual([]);

  await service.pushFrame(
    new FunctionCallResultFrame({
      functionName: "get_weather",
      toolCallId: "call_2",
      arguments: { location: "Boston" },
      result: { temp: 51 },
    }),
  );
  expect(recorder.ofType("response.item.create").length).toBe(2);
  expect(recorder.ofType("response.create").length).toBe(1);
});

test("test_an_envelope_without_a_delegation_id_still_correlates_its_events", async () => {
  // The wrapped Responses events do not all name their response.
  const service = _makeService({ delegation: _responsesDelegation() });
  service._context = new LLMContext({ messages: [], tools: [_weatherTool()] });
  service.runFunctionCalls = mock(async () => {});
  const recorder = new _EventRecorder();
  service.sendClientEvent = recorder.call;

  await _drive(service, [
    _responseEvent(_responseCreated(), null),
    _responseEvent(_functionCallItem("call_1"), null),
    _responseEvent(_responseCompleted(), null),
  ]);
  await service.pushFrame(
    new FunctionCallResultFrame({
      functionName: "get_weather",
      toolCallId: "call_1",
      arguments: { location: "Seattle" },
      result: { temp: 62 },
    }),
  );

  expect(recorder.ofType("response.create").length).toBe(1);
});

test("test_a_response_that_asked_for_nothing_is_not_continued", async () => {
  // An empty terminal output list is not a reason to continue a response.
  const service = _makeService({ delegation: _responsesDelegation() });
  const recorder = new _EventRecorder();
  service.sendClientEvent = recorder.call;

  await _drive(service, [_responseEvent(_responseCreated()), _responseEvent(_responseCompleted())]);

  expect(recorder.ofType("response.create")).toEqual([]);
});

test("test_backend_token_usage_is_reported_from_the_completed_response", async () => {
  const service = _makeService({ delegation: _responsesDelegation() });
  service.startLlmUsageMetrics = mock(async () => {});

  await _drive(service, [
    _responseEvent(_responseCreated()),
    _responseEvent(
      _responseCompleted("resp_1", {
        usage: {
          input_tokens: 120,
          output_tokens: 30,
          total_tokens: 150,
          input_tokens_details: { cached_tokens: 100 },
          output_tokens_details: { reasoning_tokens: 12 },
        },
      }),
    ),
  ]);

  const args = service.startLlmUsageMetrics.mock.lastCall;
  expect(args.length).toBe(1);
  const tokens = args[0];
  expect(tokens.promptTokens).toBe(120);
  expect(tokens.completionTokens).toBe(30);
  expect(tokens.totalTokens).toBe(150);
  expect(tokens.cacheReadInputTokens).toBe(100);
  expect(tokens.reasoningTokens).toBe(12);
});

test("test_intermediate_function_call_result_is_dropped", async () => {
  const service = _makeService({ delegation: _responsesDelegation() });
  const recorder = new _EventRecorder();
  service.sendClientEvent = recorder.call;
  service._openFunctionCalls.set("call_1", "item_d1");

  await service.pushFrame(
    new FunctionCallResultFrame({
      functionName: "get_weather",
      toolCallId: "call_1",
      arguments: {},
      result: { progress: "50%" },
      properties: new FunctionCallResultProperties({ isFinal: false }),
    }),
  );

  expect(recorder.events).toEqual([]);
  expect(service._openFunctionCalls.has("call_1")).toBe(true);
});

test("test_cancelled_function_call_reports_cancellation_to_the_backend", async () => {
  const service = _makeService({ delegation: _responsesDelegation() });
  const recorder = new _EventRecorder();
  service.sendClientEvent = recorder.call;
  service._openFunctionCalls.set("call_1", "item_d1");

  await service.pushFrame(
    new FunctionCallCancelFrame({ functionName: "get_weather", toolCallId: "call_1" }),
  );

  const items = recorder.ofType("response.item.create");
  expect(items.length).toBe(1);
  expect(items[0]!.item.call_id).toBe("call_1");
  expect((pyJsonLoads(items[0]!.item.output) as any).error).toContain("cancelled");
});

test("test_results_for_unknown_calls_are_ignored", async () => {
  const service = _makeService({ delegation: _responsesDelegation() });
  const recorder = new _EventRecorder();
  service.sendClientEvent = recorder.call;

  await service.pushFrame(
    new FunctionCallResultFrame({
      functionName: "other",
      toolCallId: "call_x",
      arguments: {},
      result: "ok",
    }),
  );

  expect(recorder.events).toEqual([]);
});

// ---------------------------------------------------------------------------
// Client delegation without a backend, errors, usage, close
// ---------------------------------------------------------------------------

test("test_client_delegation_without_backend_is_declined", async () => {
  const service = _makeService();
  const recorder = new _EventRecorder();
  service.sendClientEvent = recorder.call;

  await _drive(service, [_delegationCreated("item_d1")]);

  const appends = recorder.ofType("session.commentary.append");
  expect(appends.length).toBe(1);
  expect(appends[0]!.delegation_id).toBe("item_d1");
  expect(appends[0]!.content).toContain("No backend");
});

test("test_error_before_session_start_is_permanent_and_after_is_not", async () => {
  const service = _makeService();
  service.pushError = mock(async () => {});
  const error = {
    type: "error",
    error: { type: "invalid_request_error", code: "bad", message: "nope" },
  };

  await _drive(service, [error]);
  expect(lastKwargs(service.pushError).forceTreatAsPermanent).toBe(true);

  await _drive(service, [_sessionStarted(), error]);
  expect(service._sessionStarted).toBe(true);
  expect(lastKwargs(service.pushError).forceTreatAsPermanent ?? false).toBe(false);
});

test("test_unknown_and_response_events_do_not_break_the_receive_loop", async () => {
  const service = _makeService();
  service.pushFrame = new _FrameRecorder().call;

  await _drive(service, [
    { type: "some.future.event", payload: 1 },
    _responseEvent({ type: "response.output_text.delta", delta: "hi" }),
    "not json",
    _sessionStarted(),
  ]);

  expect(service._sessionStarted).toBe(true);
});

test("test_parse_server_event_unwraps_response_envelopes_and_tolerates_unknown_types", () => {
  const envelope = events.parseServerEvent(
    pyJsonDumps(_responseEvent({ type: "response.completed", response: { id: "resp_1" } })),
  ) as events.ResponseEventEnvelope;
  expect(envelope).toBeInstanceOf(events.ResponseEventEnvelope);
  expect(envelope.delegationId).toBe("item_d1");
  expect(envelope.innerType).toBe("response.completed");

  const unknown = events.parseServerEvent(pyJsonDumps({ type: "brand.new", x: 1 }));
  expect(unknown).toBeInstanceOf(events.UnknownServerEvent);
  // upstream: ValueError
  expect(() => events.parseServerEvent("[]")).toThrow(Error);
});

test("test_errors_correlate_to_the_command_that_caused_them", () => {
  const error = events.parseServerEvent(
    pyJsonDumps({
      type: "error",
      event_id: "event_error",
      error: {
        type: "invalid_request_error",
        code: "immutable_field_update",
        message: "nope",
        client_event_id: "event_update",
      },
    }),
  ) as events.ErrorEvent;
  expect(error).toBeInstanceOf(events.ErrorEvent);
  expect(error.error.clientEventId).toBe("event_update");
});

test("test_live_usage_is_reported_as_cumulative_seconds", async () => {
  // The live model bills duration, not tokens; backend tokens arrive separately.
  const service = _makeService();
  service.startLlmUsageMetrics = mock(async () => {});

  await _drive(service, [
    { type: "session.usage.updated", usage: { seconds: 12.4 } },
    {
      type: "session.usage.updated",
      usage: { seconds: 30.1 },
      context_window: { usage_ratio: 0.42 },
    },
  ]);

  expect(service.startLlmUsageMetrics).not.toHaveBeenCalled();
});

test(
  "test_close_session_waits_for_session_closed",
  async () => {
    const service = _makeService();
    const recorder = new _EventRecorder();
    service.sendClientEvent = recorder.call;
    service._websocket = {};
    service._sessionStarted = true;

    const closeFromServer = async () => {
      await sleep(0);
      await service._handleServerEvent(
        events.parseServerEvent(pyJsonDumps({ type: "session.closed", reason: "client_request" })),
      );
    };

    await gather(
      () => service._closeSession(),
      () => closeFromServer(),
    );

    expect(recorder.ofType("session.close").length).toBeGreaterThan(0);
    expect(service._sessionStarted).toBe(false);

    // Without a session.closed the wait times out and returns. (Upstream
    // shortens SESSION_CLOSE_TIMEOUT_SECS here; an exported const can't be
    // patched, so this waits out the real timeout.)
    service._sessionStarted = true;
    await service._closeSession();
    expect(recorder.ofType("session.close").length).toBe(2);
  },
  (live_llm.SESSION_CLOSE_TIMEOUT_SECS + 5) * 1000,
);

test("test_reset_conversation_starts_a_new_session_from_the_current_context", async () => {
  const service = await _makeServiceWithTasks();
  const recorder = new _EventRecorder();
  service.sendClientEvent = recorder.call;
  service._closeSession = mock(async () => {});
  service._disconnect = mock(async () => {});
  service._connect = mock(async () => {});

  const context = new LLMContext({ messages: [{ role: "user", content: "hi" }] });
  await service._handleContext(context);
  service._sessionStarted = true;

  context.setMessages([{ role: "assistant", content: "Restored history." }]);
  const frames = new _FrameRecorder();
  service.pushFrame = frames.call;
  service._assistantTurn.open = true;
  await service.resetConversation();

  // The old session is dropped, not drained, and its open assistant turn is closed.
  expect(service._closeSession).not.toHaveBeenCalled();
  expect(service._disconnect).toHaveBeenCalledTimes(1);
  expect(frames.frames.map(([f]) => f.constructor)).toEqual([
    TTSStoppedFrame,
    LLMFullResponseEndFrame,
  ]);
  expect(service._connect).toHaveBeenCalledTimes(1);
  const starts = recorder.ofType("session.start");
  expect(starts.length).toBe(2);
  expect(starts[1]!.session.input).toEqual([
    {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "Restored history." }],
    },
  ]);
  expect(service._needsSessionConfig).toBe(false);
});

// ---------------------------------------------------------------------------
// Client delegation
// ---------------------------------------------------------------------------

/** Stands in for the session with the backend: records what is sent, yields what a test feeds. */
class _FakeSession implements AsyncIterableIterator<unknown> {
  worker: unknown;
  backendName: string;
  timeoutSecs: number | null;
  requests: string[] = [];
  sendError: Error | null = null;
  closed = false;
  detached = false;
  _events: Queue<unknown> = new Queue();

  constructor(worker: unknown, backendName: string, options: { timeoutSecs?: number | null } = {}) {
    this.worker = worker;
    this.backendName = backendName;
    this.timeoutSecs = options.timeoutSecs ?? null;
  }

  /** `async with`: enter, run the block, then exit. */
  async run<R>(fn: (session: this) => Promise<R> | R): Promise<R> {
    try {
      return await fn(this);
    } finally {
      this.closed = true;
    }
  }

  [Symbol.asyncIterator](): this {
    return this;
  }

  async next(): Promise<IteratorResult<unknown>> {
    const event = await this._events.get();
    if (event === null) {
      return { done: true, value: undefined };
    }
    return { done: false, value: event };
  }

  async send(request: string): Promise<string> {
    if (this.sendError !== null) {
      throw this.sendError;
    }
    this.requests.push(request);
    return "idle";
  }

  /** Hand events to the service's consumer and let it process them. */
  async feed(...evts: unknown[]): Promise<void> {
    for (const event of evts) {
      this._events.putNowait(event);
    }
    for (let i = 0; i < 10; i++) {
      await sleep(0);
    }
  }
}

async function _clientDelegationService(
  options: { timeoutSecs?: number } = {},
): Promise<[any, _EventRecorder, _FakeSession]> {
  const timeoutSecs = options.timeoutSecs ?? 5;
  const sessions: _FakeSession[] = [];

  backendSessionFactory = (worker, backendName, opts) => {
    const session = new _FakeSession(worker, backendName, { timeoutSecs: opts?.timeoutSecs });
    sessions.push(session);
    return session;
  };
  const service = await _makeServiceWithTasks({
    delegation: new OpenAILiveLLMService.ClientDelegation({ backend: "backend", timeoutSecs }),
  });
  const recorder = new _EventRecorder();
  service.sendClientEvent = recorder.call;
  Object.defineProperty(service, "pipelineWorker", { get: () => "worker", configurable: true });
  // What setup() does once the pipeline worker exists: attach to the backend.
  service._backendSessionTask = service.createTask(
    () => service._runBackendSession(),
    "backend_session",
  );
  for (let i = 0; i < 5; i++) {
    await sleep(0);
  }
  expect(sessions.length).toBe(1);
  return [service, recorder, sessions[0]!];
}

function _clientDelegation(delegationId: string): events.DelegationMetadata {
  return new events.DelegationMetadata({ id: delegationId, target: "client" });
}

const _REPORT_LINE =
  "Act on the user's most recent request in the conversation above. If it asks for " +
  "something, tell the user the result as soon as you have it, before going on with other " +
  "work, in a message that begins with >>. If it only stops or changes work already under " +
  "way, tell them nothing: the assistant already has.";

test("test_client_delegation_sends_the_fragments_since_the_last_one", async () => {
  const [service, recorder, session] = await _clientDelegationService();

  await _drive(service, [
    _transcriptDelta("user", "what's the weather in seattle"),
    _transcriptDelta("assistant", "Let me check.", { startMs: 200 }),
  ]);
  await service._handleClientDelegation(_clientDelegation("item_d1"));

  // No task text: the delegation names none, so the backend is handed the
  // conversation rendered as a transcript and works the request out from it.
  expect(session.backendName).toBe("backend");
  expect(session.timeoutSecs).toBe(5);
  expect(session.requests).toEqual([
    "Voice conversation so far:\n" +
      "USER: what's the weather in seattle\n" +
      "ASSISTANT: Let me check.\n" +
      "\n" +
      _REPORT_LINE,
  ]);
  expect(service._transcriptFragments).toEqual([]);

  await session.feed(
    new BackendOutput({ text: "Checking the weather.", prefersSpoken: true }),
    new BackendOutput({ text: "Still looking.", isThought: true, prefersSpoken: false }),
    new BackendOutput({ text: "It's 62 and raining in Seattle.", prefersSpoken: true }),
    new BackendIdle(),
  );

  const thinking = recorder
    .ofType("session.thinking.append")
    .map((e) => [e.delegation_id, e.content]);
  const commentary = recorder
    .ofType("session.commentary.append")
    .map((e) => [e.delegation_id, e.content]);
  expect(thinking).toEqual([["item_d1", "Still looking."]]);
  expect(commentary).toEqual([
    ["item_d1", "Checking the weather."],
    ["item_d1", "It's 62 and raining in Seattle."],
  ]);
  expect(service._currentDelegation).toBeNull();
});

test("test_the_backend_reads_whole_utterances_not_fragments", async () => {
  // Frame-boundary fragments are joined back up, spacing and all.
  const [service, , session] = await _clientDelegationService();

  await _drive(service, [
    _transcriptDelta("assistant", "Hey there"),
    _transcriptDelta("assistant", "!", { startMs: 200 }),
    _transcriptDelta("user", "Get", { startMs: 400 }),
    _transcriptDelta("user", " me the", { startMs: 600 }),
    _transcriptDelta("user", " weather in", { startMs: 800 }),
    _transcriptDelta("user", " Washington", { startMs: 1000 }),
    _transcriptDelta("user", ", DC", { startMs: 1200 }),
  ]);
  await service._handleClientDelegation(_clientDelegation("item_d1"));

  expect(session.requests).toEqual([
    "Voice conversation so far:\n" +
      "ASSISTANT: Hey there!\n" +
      "USER: Get me the weather in Washington, DC\n" +
      "\n" +
      _REPORT_LINE,
  ]);
});

test("test_delegations_take_the_backend_one_at_a_time", async () => {
  // A second delegation waits until the backend has nothing left to do.
  const [service, recorder, session] = await _clientDelegationService();

  await _drive(service, [_transcriptDelta("user", "what's the weather in seattle")]);
  await service._handleClientDelegation(_clientDelegation("item_d1"));
  await _drive(service, [_transcriptDelta("user", "and in boston", { startMs: 2000 })]);
  await service._handleClientDelegation(_clientDelegation("item_d2"));

  // Only the first has been sent; the second holds the transcript it was raised on.
  expect(session.requests.length).toBe(1);
  expect(service._queuedDelegations.length).toBe(1);

  await session.feed(new BackendOutput({ text: "62 and raining." }), new BackendIdle());

  expect(session.requests.length).toBe(2);
  expect(
    session.requests[1]!.startsWith(
      "Voice conversation since the previous delegation:\nUSER: and in boston\n",
    ),
  ).toBe(true);
  expect(service._currentDelegation).not.toBeNull();
  expect(service._currentDelegation.id).toBe("item_d2");
  // Outputs from here on belong to the second delegation.
  await session.feed(new BackendOutput({ text: "Boston is 55." }), new BackendIdle());
  const commentary = recorder
    .ofType("session.commentary.append")
    .map((e) => [e.delegation_id, e.content]);
  expect(commentary).toEqual([
    ["item_d1", "62 and raining."],
    ["item_d2", "Boston is 55."],
  ]);
  expect(service._currentDelegation).toBeNull();
});

test("test_a_reset_starts_the_next_delegation_transcript_afresh", async () => {
  // A new session has no previous delegation for a transcript to run from.
  const [service, , session] = await _clientDelegationService();
  service._connect = mock(async () => {});

  await _drive(service, [_transcriptDelta("user", "what's the weather in seattle")]);
  await service._handleClientDelegation(_clientDelegation("item_d1"));
  await session.feed(new BackendIdle());

  await _drive(service, [_transcriptDelta("user", "and in boston", { startMs: 2000 })]);
  await service._handleClientDelegation(_clientDelegation("item_d2"));

  // The reset drops the delegation in progress: the backend is detached,
  // which stops its work; connecting again (mocked here) attaches again.
  await service.resetConversation();
  expect(service._currentDelegation).toBeNull();
  expect(service._backendSessionTask).toBeNull();
  expect(service._connect).toHaveBeenCalled();
  // What the real _connect does next.
  await service._attachBackend();
  for (let i = 0; i < 5; i++) {
    await sleep(0);
  }
  const newSession = service._backendSession;
  expect(newSession !== null && newSession !== session).toBe(true);

  await _drive(service, [_transcriptDelta("user", "let's start over", { startMs: 4000 })]);
  await service._handleClientDelegation(_clientDelegation("item_d3"));

  expect(session.requests[0]!.startsWith("Voice conversation so far:")).toBe(true);
  expect(session.requests[1]!.startsWith("Voice conversation since the previous delegation:")).toBe(
    true,
  );
  expect(newSession.requests[0].startsWith("Voice conversation so far:")).toBe(true);
});

test("test_client_delegation_failure_is_reported_to_the_model", async () => {
  const [service, recorder, session] = await _clientDelegationService();
  service.pushError = mock(async () => {});
  session.sendError = new JobError("timed out");

  await service._handleClientDelegation(_clientDelegation("item_d1"));

  // The model is told the work failed; the detail goes to the error instead.
  const appends = recorder.ofType("session.commentary.append");
  expect(appends.length).toBe(1);
  expect(appends[0]!.content).not.toContain("timed out");
  expect(service.pushError).toHaveBeenCalledTimes(1);
  // upstream: await_args.kwargs["error_msg"] (the first positional argument here)
  expect(service.pushError.mock.lastCall[0]).toContain("timed out");
  expect(service._currentDelegation).toBeNull();
});

test("test_a_backend_error_ends_the_delegation_and_starts_the_next", async () => {
  const [service, recorder, session] = await _clientDelegationService();
  service.pushError = mock(async () => {});

  await service._handleClientDelegation(_clientDelegation("item_d1"));
  await service._handleClientDelegation(_clientDelegation("item_d2"));
  await session.feed(new BackendError({ error: "the provider is down" }));

  const appends = recorder.ofType("session.commentary.append");
  expect(appends.length).toBe(1);
  expect(appends[0]!.delegation_id).toBe("item_d1");
  expect(appends[0]!.content).toContain("could not be completed");
  expect(service.pushError).toHaveBeenCalledTimes(1);
  expect(session.requests.length).toBe(2);
  expect(service._currentDelegation).not.toBeNull();
  expect(service._currentDelegation.id).toBe("item_d2");
});

test("test_a_delegation_the_backend_takes_too_long_on_is_abandoned", async () => {
  const [service, recorder, session] = await _clientDelegationService({ timeoutSecs: 0.05 });

  await service._handleClientDelegation(_clientDelegation("item_d1"));
  await service._handleClientDelegation(_clientDelegation("item_d2"));
  for (let i = 0; i < 100; i++) {
    const newSession = service._backendSession;
    if (session.closed && newSession !== null && newSession.requests.length > 0) {
      break;
    }
    await sleep(0.005);
  }

  // The session the work was sent on is closed, which stops the backend,
  // and the delegation that was waiting goes out on a new one.
  expect(session.closed).toBe(true);
  expect(session.requests).toEqual([session.requests[0]!]);
  const newSession = service._backendSession;
  expect(newSession !== null && newSession !== session).toBe(true);
  expect(newSession.requests.length).toBe(1);
  const appends = recorder.ofType("session.commentary.append");
  expect(appends[0]!.delegation_id).toBe("item_d1");
  expect(appends[0]!.content).toContain("could not be completed");
});

test("test_the_backends_calls_are_reported_without_a_parent", async () => {
  const [service, , session] = await _clientDelegationService();
  service.pushFrame = mock(async () => {});

  await service._handleClientDelegation(_clientDelegation("item_d1"));
  await session.feed(
    new BackendToolCall({
      phase: "in_progress",
      functionName: "get_weather",
      toolCallId: "toolu_1",
      arguments: { location: "DC" },
    }),
  );

  const pushedFrames = service.pushFrame.mock.calls.map((c: any[]) => c[0]);
  expect(pushedFrames.length).toBe(1);
  const pushed = pushedFrames[0];
  expect(pushed).toBeInstanceOf(ExternalFunctionCallInProgressFrame);
  expect([pushed.functionName, pushed.toolCallId]).toEqual(["get_weather", "toolu_1"]);
});

test("test_a_delegation_that_produced_nothing_spoken_still_answers_the_model", async () => {
  // A note is not an answer: the live model holds the conversation until it hears something.
  const [service, recorder, session] = await _clientDelegationService();

  await service._handleClientDelegation(_clientDelegation("item_d1"));
  await session.feed(new BackendOutput({ text: "Looking into it.", prefersSpoken: false }));
  await session.feed(new BackendIdle());

  const notes = recorder.ofType("session.thinking.append");
  expect(notes.length).toBe(1);
  expect(notes[0]!.content).toBe("Looking into it.");
  const answers = recorder.ofType("session.commentary.append");
  expect(answers.length).toBe(1);
  expect(answers[0]!.delegation_id).toBe("item_d1");
  expect(answers[0]!.content).toContain("without an answer");
});

test("test_long_delegation_results_are_chunked_at_sentence_boundaries", async () => {
  const [service, recorder, session] = await _clientDelegationService();

  await service._handleClientDelegation(_clientDelegation("item_d1"));
  const text = Array.from({ length: 120 }, (_, i) => `Sentence number ${i} is here.`).join(" ");
  await session.feed(new BackendOutput({ text, prefersSpoken: true }));

  const appends = recorder.ofType("session.commentary.append");
  expect(appends.length).toBeGreaterThan(1);
  for (const append of appends) {
    expect(live_llm._estimatedTokens(append.content)).toBeLessThanOrEqual(
      live_llm.MAX_CONTEXT_APPEND_TOKENS,
    );
    expect(append.content.endsWith(".")).toBe(true);
  }
  const joined = appends.map((a) => a.content).join(" ");
  expect(joined.split("Sentence number").length - 1).toBe(120);
});

test("test_chunk_text_splits_overlong_sentences_on_whitespace", () => {
  const words = Array(400).fill("word").join(" ");
  const chunks = live_llm._chunkText(words, 100);
  expect(chunks.every((c) => live_llm._estimatedTokens(c) <= 100)).toBe(true);
  expect(chunks.join(" ")).toBe(words);
  expect(live_llm._chunkText("   ", 100)).toEqual([]);
});

test("test_chunk_text_keeps_cjk_within_the_token_budget", () => {
  // CJK costs about a token per character, so the same character count buys
  // far fewer of them than Latin script does.
  const text = Array(200).fill("天気はどうですか。").join("");
  const chunks = live_llm._chunkText(text, 100);
  expect(chunks.every((c) => live_llm._estimatedTokens(c) <= 100)).toBe(true);
  expect(chunks.join("").split("天気").length - 1).toBe(200);
});
