// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_nvidia_omni_llm.py

/**
 * Tests for the NVIDIA Nemotron Omni LLM service and adapter.
 *
 * Porting notes:
 * - The `omni` pytest fixture → `withOmni(fn)`, which runs the test body and
 *   then releases and cancels every turn, as the fixture's teardown does.
 * - `unittest.mock.AsyncMock` / `Mock` → `mock()` from `bun:test`; protected
 *   members are reached through an `any`-typed service, as Python reaches
 *   underscore members.
 * - `SimpleNamespace` chunks and clients → plain objects.
 * - `wave.open(...).readframes()` → `_wavFrames()`, which reads the `data`
 *   chunk of the RIFF file.
 * - The Python client takes `extra_body` as a keyword argument; the JS client
 *   receives the request body with `extra_body` already merged in (see
 *   `BaseOpenAILLMService._requestBody`), so its fields are read from the body.
 * - pydantic's `model_extra` → a field on the message object itself, which is
 *   where the JS SDK keeps unknown response fields.
 * - `pytest.mark.parametrize` → `test.each`, named with the upstream ids.
 */

import { describe, expect, mock, test } from "bun:test";
import { CancelledError, createTask, Event, Future, sleep, type Task } from "@pipedog/asyncio";
import { LLMContextConversionError } from "@pipedog/core/adapters/llm/base_llm_adapter";
import {
  CancelFrame,
  type Frame,
  InputAudioRawFrame,
  InterruptionFrame,
  LLMContextFrame,
  LLMFullResponseEndFrame,
  LLMFullResponseStartFrame,
  LLMRunFrame,
  LLMTextFrame,
  LLMThoughtEndFrame,
  LLMThoughtStartFrame,
  LLMThoughtTextFrame,
  TranscriptionFrame,
  UserStartedSpeakingFrame,
  UserStoppedSpeakingFrame,
  VADUserStartedSpeakingFrame,
  VADUserStoppedSpeakingFrame,
} from "@pipedog/core/frames/frames";
import {
  LLMContext,
  type LLMContextMessage,
  LLMSpecificMessage,
} from "@pipedog/core/processors/aggregators/llm_context";
import { FrameDirection } from "@pipedog/core/processors/frame_processor";
import { runTest, SleepFrame } from "@pipedog/core/tests/utils";
import { base64ToBytes, bytesToBase64 } from "@pipedog/core/utils/base64";
import { ErrorCategory } from "@pipedog/core/utils/errors";
import { TIMEOUT_EXCEPTIONS } from "@pipedog/core/utils/http";
import { BadRequestError } from "openai";
import {
  _audioPart,
  _TranscriptResponseExtractor,
  NvidiaOmniLLMService,
  type NvidiaOmniLLMSettingsOptions,
} from "../src/omni/llm.ts";

// Tests reach protected members, as upstream does.
type Any = any;

function _service(options: { audioInput?: boolean } & NvidiaOmniLLMSettingsOptions = {}): Any {
  const { audioInput = true, ...settings } = options;
  return new NvidiaOmniLLMService({
    baseUrl: "http://localhost:8000/v1",
    audioInput,
    settings: Object.keys(settings).length > 0 ? new NvidiaOmniLLMService.Settings(settings) : null,
  });
}

function _toolMessages(content = "sunny", toolCallId = "call_1"): Record<string, unknown>[] {
  return [
    { role: "user", content: "weather?" },
    {
      role: "assistant",
      tool_calls: [
        {
          id: toolCallId,
          type: "function",
          function: { name: "w", arguments: "{}" },
        },
      ],
    },
    { role: "tool", tool_call_id: toolCallId, content },
  ];
}

function _ctx(messages: unknown[]): LLMContext {
  return new LLMContext({ messages: messages as LLMContextMessage[] });
}

function _chunk(
  content: string | null = null,
  options: { toolCalls?: unknown; reasoningContent?: string | null } = {},
): Any {
  const delta = {
    content,
    tool_calls: options.toolCalls ?? null,
    reasoning_content: options.reasoningContent ?? null,
  };
  return { choices: [{ delta }], usage: null, model: null };
}

async function* _stream(...chunks: unknown[]): AsyncGenerator<Any> {
  for (const chunk of chunks) {
    yield chunk;
  }
}

function _bytes(value: number, length: number): Uint8Array {
  return new Uint8Array(Math.trunc(length)).fill(value);
}

function _concat(...chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((sum, c) => sum + c.length, 0));
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

function _audioFrame(audio: Uint8Array): InputAudioRawFrame {
  return new InputAudioRawFrame({ audio, sampleRate: 16000, numChannels: 1 });
}

/** Replaces the service's turn runner with turns the test releases by hand. */
class _Turns {
  started: Record<string, Any>[] = [];
  cancelled: number[] = [];
  completed: number[] = [];
  onStart: (() => Promise<void>) | null = null;
  #releases: Event[] = [];

  constructor(service: Any) {
    const runTurn = async (context: LLMContext, options: Record<string, unknown> = {}) => {
      const index = this.started.length;
      const release = new Event();
      this.started.push({ context, ...options });
      this.#releases.push(release);
      if (this.onStart) {
        await this.onStart();
      }
      try {
        await release.wait();
        this.completed.push(index);
      } catch (e) {
        if (e instanceof CancelledError) {
          this.cancelled.push(index);
        }
        throw e;
      }
    };

    const cancelTask = async (task: Task<unknown>, _timeout: number | null = null) => {
      task.cancel();
      try {
        await task;
      } catch (e) {
        if (!(e instanceof CancelledError)) throw e;
      }
    };

    service._runTurn = runTurn;
    service.createTask = (fn: () => Promise<unknown>, name?: string) => createTask(fn, name);
    service.cancelTask = cancelTask;
    service.stopAllMetrics = mock(async () => {});
  }

  release(index: number): void {
    this.#releases[index]!.set();
  }

  async waitFor(count: number): Promise<void> {
    for (let i = 0; i < 200; i++) {
      if (this.started.length >= count) {
        return;
      }
      await sleep(0.005);
    }
    throw new Error(`expected ${count} turns, got ${this.started.length}`);
  }
}

function _fillAudio(service: Any, seconds = 1.0): void {
  service._audioBuffer = [_bytes(0, service._bytesPerSecond() * seconds)];
}

/** The `omni` fixture. */
function withOmni(fn: (service: Any, turns: _Turns) => Promise<void>): () => Promise<void> {
  return async () => {
    const service = _service();
    const turns = new _Turns(service);
    try {
      await fn(service, turns);
    } finally {
      for (let index = 0; index < turns.started.length; index++) {
        turns.release(index);
      }
      await service._cancelTurns();
    }
  };
}

test(
  "test_speech_between_user_turn_frames_starts_an_audio_turn",
  withOmni(async (service, turns) => {
    service.pushFrame = mock(async () => {});
    const audio = _bytes(0, service._bytesPerSecond());

    await service.processFrame(new UserStartedSpeakingFrame(), FrameDirection.DOWNSTREAM);
    await service.processFrame(_audioFrame(audio), FrameDirection.DOWNSTREAM);
    await service.processFrame(new UserStoppedSpeakingFrame(), FrameDirection.DOWNSTREAM);

    await turns.waitFor(1);
    expect(turns.started[0]!.expectTranscript).toBe(true);
    expect(turns.started[0]!.turnParts[0].type).toBe("input_audio");
  }),
);

async function _assertQueuedBehindTheFirstTurn(turns: _Turns): Promise<void> {
  await sleep(0.01);
  expect(turns.started.length).toBe(1);
  expect(turns.cancelled).toEqual([]);

  turns.release(0);
  await turns.waitFor(2);
  expect(turns.completed).toEqual([0]);
}

test(
  "test_audio_turn_waits_for_the_turn_in_progress",
  withOmni(async (service, turns) => {
    _fillAudio(service);
    await service._startAudioTurn();
    await turns.waitFor(1);

    _fillAudio(service);
    await service._startAudioTurn();

    await _assertQueuedBehindTheFirstTurn(turns);
  }),
);

test(
  "test_text_turn_waits_for_the_turn_in_progress",
  withOmni(async (service, turns) => {
    const context = _ctx([{ role: "user", content: "hi" }]);
    await service._startTextTurn(context, { force: true });
    await turns.waitFor(1);

    await service._startTextTurn(context, { force: true });

    await _assertQueuedBehindTheFirstTurn(turns);
  }),
);

test(
  "test_context_frame_during_an_audio_turn_is_answered_after_it",
  withOmni(async (service, turns) => {
    _fillAudio(service);
    await service._startAudioTurn();
    await turns.waitFor(1);

    await service._startTextTurn(
      _ctx([{ role: "developer", content: "Mention the opening hours." }]),
    );

    await _assertQueuedBehindTheFirstTurn(turns);
  }),
);

test(
  "test_interruption_cancels_every_queued_turn",
  withOmni(async (service, turns) => {
    service.pushFrame = mock(async () => {});
    await service._startTextTurn(_ctx([{ role: "user", content: "hi" }]), { force: true });
    await turns.waitFor(1);
    await service._startTextTurn(_ctx(_toolMessages()));

    await service.processFrame(new InterruptionFrame(), FrameDirection.DOWNSTREAM);
    await sleep(0.01);

    expect(turns.cancelled).toEqual([0]);
    expect(turns.started.length).toBe(1);
  }),
);

test(
  "test_failed_turn_does_not_block_the_queue",
  withOmni(async (service, turns) => {
    const failing = new Future();
    failing.setException(new Error("boom"));
    service._turnTasks = [failing];

    await service._startTextTurn(_ctx([{ role: "user", content: "hi" }]), { force: true });
    await turns.waitFor(1);
  }),
);

test(
  "test_short_utterance_is_ignored",
  withOmni(async (service, turns) => {
    _fillAudio(service);
    await service._startAudioTurn();
    await turns.waitFor(1);

    _fillAudio(service, 0.05);
    await service._startAudioTurn();
    await sleep(0.01);

    expect(turns.started.length).toBe(1);
    expect(turns.cancelled).toEqual([]);
  }),
);

test(
  "test_utterance_before_any_context_is_answered_without_history",
  withOmni(async (service, turns) => {
    _fillAudio(service);
    await service._startAudioTurn();
    await turns.waitFor(1);

    expect(turns.started[0]!.context.getMessages()).toEqual([]);
  }),
);

test(
  "test_typed_user_turn_is_completed_with_audio_input",
  withOmni(async (service, turns) => {
    await service._startTextTurn(_ctx([{ role: "user", content: "hi" }]));
    await turns.waitFor(1);
  }),
);

test(
  "test_tool_result_is_completed_once_across_context_frames",
  withOmni(async (service, turns) => {
    const context = _ctx(_toolMessages());
    await service._startTextTurn(context);
    await turns.waitFor(1);
    turns.release(0);

    await service._startTextTurn(context);
    await sleep(0.01);

    expect(turns.started.length).toBe(1);
  }),
);

test(
  "test_follow_up_waits_for_a_running_tool",
  withOmni(async (service, turns) => {
    await service._startTextTurn(_ctx(_toolMessages("IN_PROGRESS")));
    expect(service._turnTasks.length).toBe(0);

    await service._startTextTurn(_ctx(_toolMessages()));
    await turns.waitFor(1);
  }),
);

test(
  "test_async_tool_result_replacing_its_started_message_is_completed",
  withOmni(async (service, turns) => {
    await service._startTextTurn(_ctx(_toolMessages("started")));
    await turns.waitFor(1);
    turns.release(0);

    await service._startTextTurn(_ctx(_toolMessages("sunny")));
    await turns.waitFor(2);
  }),
);

test(
  "test_developer_instruction_is_completed_with_audio_input",
  withOmni(async (service, turns) => {
    const context = _ctx([{ role: "developer", content: "Introduce yourself." }]);
    await service._startTextTurn(context);
    await turns.waitFor(1);
  }),
);

test(
  "test_answered_context_is_not_completed",
  withOmni(async (service, _turns) => {
    const context = _ctx([
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ]);
    await service._startTextTurn(context);
    expect(service._turnTasks.length).toBe(0);
  }),
);

async function _reportTranscript(service: Any, transcript: string): Promise<void> {
  service.pushFrame = mock(async () => {});
  await service._emitUserTranscript(transcript);
}

test(
  "test_context_frame_recording_a_spoken_turn_is_not_answered_again",
  withOmni(async (service, _turns) => {
    await _reportTranscript(service, "where is the tower?");
    await service._startTextTurn(_ctx([{ role: "user", content: "where is the tower?" }]));
    expect(service._turnTasks.length).toBe(0);
  }),
);

test(
  "test_later_frame_repeating_the_spoken_turn_is_answered",
  withOmni(async (service, turns) => {
    await _reportTranscript(service, "where is the tower?");
    const context = _ctx([{ role: "user", content: "where is the tower?" }]);
    await service._startTextTurn(context);

    await service._startTextTurn(context);
    await turns.waitFor(1);
  }),
);

test(
  "test_developer_message_after_a_spoken_turn_is_answered",
  withOmni(async (service, turns) => {
    await _reportTranscript(service, "where is the tower?");
    const context = _ctx([
      { role: "user", content: "where is the tower?" },
      { role: "developer", content: "Mention the opening hours." },
    ]);
    await service._startTextTurn(context);
    await turns.waitFor(1);
  }),
);

test(
  "test_late_spoken_turn_frame_and_tool_result_frame_complete_the_result_once",
  withOmni(async (service, turns) => {
    await _reportTranscript(service, "weather?");
    const context = _ctx(_toolMessages());
    await service._startTextTurn(context);
    await turns.waitFor(1);
    turns.release(0);

    await service._startTextTurn(context);
    await sleep(0.01);

    expect(turns.started.length).toBe(1);
  }),
);

test(
  "test_tool_follow_up_carries_a_spoken_turn_missing_from_the_context",
  withOmni(async (service, turns) => {
    service._lastTranscript = "what is the weather?";
    await service._startTextTurn(_ctx(_toolMessages().slice(1)));
    await turns.waitFor(1);

    expect(turns.started[0]!.turnParts).toEqual([{ type: "text", text: "what is the weather?" }]);
  }),
);

test(
  "test_tool_follow_up_waits_for_the_turn_that_requested_it",
  withOmni(async (service, turns) => {
    await service._startTextTurn(_ctx([{ role: "user", content: "hi" }]), { force: true });
    await turns.waitFor(1);

    await service._startTextTurn(_ctx(_toolMessages()));
    await sleep(0.01);
    expect(turns.started.length).toBe(1);
    expect(turns.cancelled).toEqual([]);

    turns.release(0);
    await turns.waitFor(2);
    expect(turns.completed).toEqual([0]);
  }),
);

test(
  "test_interruption_cancels_the_turn_and_drops_buffered_audio",
  withOmni(async (service, turns) => {
    service.pushFrame = mock(async () => {});
    _fillAudio(service);
    await service._startAudioTurn();
    await turns.waitFor(1);
    service._preSpeechBuffer = [_bytes(0, 320)];

    await service.processFrame(new InterruptionFrame(), FrameDirection.DOWNSTREAM);

    expect(turns.cancelled).toEqual([0]);
    expect(service._turnTasks.length).toBe(0);
    expect(service._preSpeechBuffer).toEqual([]);
    expect(service.stopAllMetrics).toHaveBeenCalled();
  }),
);

async function _speak(
  service: Any,
  options: { startTurn?: boolean; seconds?: number } = {},
): Promise<void> {
  const startTurn = options.startTurn ?? true;
  const seconds = options.seconds ?? 1.0;
  const frames: Frame[] = [new VADUserStartedSpeakingFrame()];
  if (startTurn) {
    frames.push(new UserStartedSpeakingFrame());
  }
  const audio = _bytes(0, service._bytesPerSecond() * seconds);
  frames.push(_audioFrame(audio), new VADUserStoppedSpeakingFrame());
  if (startTurn) {
    frames.push(new UserStoppedSpeakingFrame());
  }
  for (const frame of frames) {
    await service.processFrame(frame, FrameDirection.DOWNSTREAM);
  }
}

async function _speakOverTheBot(service: Any, audio: Uint8Array): Promise<void> {
  for (const frame of [
    new VADUserStartedSpeakingFrame(),
    new UserStartedSpeakingFrame(),
    new InterruptionFrame(),
    _audioFrame(audio),
    new VADUserStoppedSpeakingFrame(),
    new UserStoppedSpeakingFrame(),
  ]) {
    await service.processFrame(frame, FrameDirection.DOWNSTREAM);
  }
}

/** The frames of a WAV file, as `wave.open(...).readframes()` returns them. */
function _wavFrames(wav: Uint8Array): Uint8Array {
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  const tag = (offset: number) => String.fromCharCode(...wav.subarray(offset, offset + 4));
  let offset = 12;
  while (offset + 8 <= wav.length) {
    const size = view.getUint32(offset + 4, true);
    if (tag(offset) === "data") {
      return wav.subarray(offset + 8, offset + 8 + size);
    }
    offset += 8 + size + (size % 2);
  }
  throw new Error("no data chunk");
}

function _sentAudio(turn: Record<string, Any>): Uint8Array {
  return _wavFrames(base64ToBytes(turn.turnParts[0].input_audio.data));
}

test(
  "test_speech_interrupted_before_its_transcript_is_answered_with_the_next_utterance",
  withOmni(async (service, turns) => {
    service.pushFrame = mock(async () => {});
    const first = _bytes(1, service._bytesPerSecond());
    const second = _bytes(2, service._bytesPerSecond());
    service._audioBuffer = [first];
    await service._startAudioTurn();
    await turns.waitFor(1);

    await _speakOverTheBot(service, second);
    await turns.waitFor(2);

    expect(turns.cancelled).toEqual([0]);
    expect(_sentAudio(turns.started[1]!)).toEqual(_concat(first, second));
  }),
);

test(
  "test_transcribed_speech_is_not_answered_again_after_an_interruption",
  withOmni(async (service, turns) => {
    turns.onStart = () => _reportTranscript(service, "What's the weather?");
    const second = _bytes(2, service._bytesPerSecond());
    _fillAudio(service);
    await service._startAudioTurn();
    await turns.waitFor(1);

    await _speakOverTheBot(service, second);
    await turns.waitFor(2);

    expect(_sentAudio(turns.started[1]!)).toEqual(second);
  }),
);

test(
  "test_speech_of_a_finished_turn_is_not_answered_again",
  withOmni(async (service, turns) => {
    service.pushFrame = mock(async () => {});
    const second = _bytes(2, service._bytesPerSecond());
    _fillAudio(service);
    await service._startAudioTurn();
    await turns.waitFor(1);
    turns.release(0);
    await sleep(0.01);

    await _speakOverTheBot(service, second);
    await turns.waitFor(2);

    expect(_sentAudio(turns.started[1]!)).toEqual(second);
  }),
);

test(
  "test_speech_without_an_interruption_lets_the_reply_finish",
  withOmni(async (service, turns) => {
    service.pushFrame = mock(async () => {});
    _fillAudio(service);
    await service._startAudioTurn();
    await turns.waitFor(1);

    await _speak(service);

    await _assertQueuedBehindTheFirstTurn(turns);
  }),
);

test(
  "test_speech_that_starts_no_user_turn_is_dropped",
  withOmni(async (service, turns) => {
    service.pushFrame = mock(async () => {});
    await _speak(service, { startTurn: false, seconds: 2.0 });
    await service.processFrame(new UserStoppedSpeakingFrame(), FrameDirection.DOWNSTREAM);
    expect(service._turnTasks.length).toBe(0);

    await _speak(service);
    await turns.waitFor(1);

    const sentAudio = base64ToBytes(turns.started[0]!.turnParts[0].input_audio.data);
    expect(sentAudio.length).toBeLessThan(2 * service._bytesPerSecond());
  }),
);

test(
  "test_pre_speech_buffer_keeps_only_the_most_recent_audio",
  withOmni(async (service, _turns) => {
    const chunk = _bytes(0, Math.floor(service._bytesPerSecond() / 10));
    for (let i = 0; i < 10; i++) {
      service._handleInputAudio(_audioFrame(chunk));
    }

    const retained = (service._preSpeechBuffer as Uint8Array[]).reduce(
      (sum, c) => sum + c.length,
      0,
    );
    expect(retained).toBeLessThanOrEqual(
      service._bytesPerSecond() * service._settings.preSpeechBufferSecs,
    );
    expect(retained).toBeGreaterThan(0);
  }),
);

test(
  "test_run_frame_completes_an_answered_context",
  withOmni(async (service, turns) => {
    service._context = _ctx([
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ]);
    await service.processFrame(new LLMRunFrame(), FrameDirection.DOWNSTREAM);
    await turns.waitFor(1);
  }),
);

test(
  "test_completion_before_any_context_is_ignored",
  withOmni(async (service, _turns) => {
    await service._startTextTurn(null, { force: true });
    expect(service._turnTasks.length).toBe(0);
  }),
);

test(
  "test_context_without_a_user_turn_is_not_completed",
  withOmni(async (service, _turns) => {
    const context = _ctx([new LLMSpecificMessage({ llm: "other", message: { role: "user" } })]);
    await service._startTextTurn(context);
    expect(service._turnTasks.length).toBe(0);
  }),
);

test(
  "test_cancel_frame_cancels_the_turn_in_progress",
  withOmni(async (service, turns) => {
    _fillAudio(service);
    await service._startAudioTurn();
    await turns.waitFor(1);

    await service.cancel(new CancelFrame());

    expect(turns.cancelled).toEqual([0]);
  }),
);

test(
  "test_custom_audio_response_instruction_is_sent",
  withOmni(async (service, turns) => {
    service._settings.audioResponseInstruction = "Answer in one word.";
    _fillAudio(service);
    await service._startAudioTurn();
    await turns.waitFor(1);

    expect(turns.started[0]!.turnParts[1]).toEqual({ type: "text", text: "Answer in one word." });
  }),
);

function _badRequest(): BadRequestError {
  return new BadRequestError(400, undefined, "bad file", new Headers());
}

describe("TestTurnErrors", () => {
  const _setup = (error: unknown): [Any, Any] => {
    const service = _service();
    service.pushFrame = mock(async (_frame: Frame, _direction?: FrameDirection) => {});
    service.pushError = mock(async (_msg: string, _options?: Record<string, unknown>) => {});
    service._callEventHandler = mock(async (_name: string) => {});
    service._processContext = mock(async () => {
      throw error;
    });
    const context: Any = _ctx([{ role: "user", content: "hi" }]);
    context.removeInvalidFileMessage = mock(() => true);
    return [service, context];
  };

  const _pushedTypes = (service: Any): unknown[] =>
    service.pushFrame.mock.calls.map((call: unknown[]) => (call[0] as object).constructor);

  const _lastErrorCall = (service: Any): [string, Record<string, unknown>] =>
    service.pushError.mock.calls.at(-1);

  test("test_timeout_is_reported", async () => {
    const [service, context] = _setup(new TIMEOUT_EXCEPTIONS[0]!("timed out"));
    await service._runTurn(context);

    expect(service._callEventHandler).toHaveBeenLastCalledWith("on_completion_timeout");
    expect(_lastErrorCall(service)[0]).toBe("LLM completion timeout");
    expect(_pushedTypes(service)).toEqual([LLMFullResponseStartFrame, LLMFullResponseEndFrame]);
  });

  test("test_unconvertible_context_drops_the_invalid_file", async () => {
    const [service, context] = _setup(new LLMContextConversionError("bad media"));
    await service._runTurn(context);

    expect(context.removeInvalidFileMessage).toHaveBeenCalledTimes(1);
    expect(_lastErrorCall(service)[0].endsWith("bad media")).toBe(true);
  });

  test("test_rejected_file_is_an_application_error", async () => {
    const [service, context] = _setup(_badRequest());
    await service._runTurn(context);

    expect(context.removeInvalidFileMessage).toHaveBeenCalledTimes(1);
    expect(_lastErrorCall(service)[1].category).toBe(ErrorCategory.APPLICATION);
    expect(service._activeTurnParts).toBeNull();
  });

  test("test_audio_turn_forgets_the_previous_transcript", async () => {
    const [service, context] = _setup(_badRequest());
    service._lastTranscript = "an earlier question";
    await service._runTurn(context, { expectTranscript: true });

    expect(service._lastTranscript).toBe("");
  });
});

describe("TestStreamHandling", () => {
  const _setup = (options: { expectTranscript: boolean }): [Any, Frame[]] => {
    const service = _service();
    const frames: Frame[] = [];
    service.pushFrame = mock(async (frame: Frame) => {
      frames.push(frame);
    });
    service._resetResponseState();
    service._transcriptExtractor = options.expectTranscript
      ? new _TranscriptResponseExtractor()
      : null;
    return [service, frames];
  };

  const _drain = async (service: Any, ...chunks: unknown[]): Promise<Any[]> => {
    const out: Any[] = [];
    for await (const chunk of service._handleReasoningContent(_stream(...chunks))) {
      out.push(chunk);
      const delta = chunk.choices[0].delta;
      if (delta.content) {
        await service._pushLlmText(delta.content);
      }
    }
    return out;
  };

  const _spoken = (frames: Frame[]): string =>
    frames
      .filter((f) => f instanceof LLMTextFrame)
      .map((f) => (f as LLMTextFrame).text)
      .join("");

  const _transcripts = (frames: Frame[]): string[] =>
    frames
      .filter((f) => f instanceof TranscriptionFrame)
      .map((f) => (f as TranscriptionFrame).text);

  test("test_transcript_is_split_from_the_spoken_reply", async () => {
    const [service, frames] = _setup({ expectTranscript: true });
    await _drain(
      service,
      _chunk("<transcript>Where is the "),
      _chunk("Eiffel Tower?</transcript>"),
      _chunk("<response>It is in Paris."),
      _chunk("</response>"),
    );

    expect(_transcripts(frames)).toEqual(["Where is the Eiffel Tower?"]);
    expect(_spoken(frames)).toBe("It is in Paris.");
    expect(service._lastTranscript).toBe("Where is the Eiffel Tower?");
  });

  test("test_untagged_reply_still_reaches_tts", async () => {
    const [service, frames] = _setup({ expectTranscript: true });
    await _drain(service, _chunk("It is in Paris."));

    expect(_transcripts(frames)).toEqual([]);
    expect(_spoken(frames)).toBe("It is in Paris.");
  });

  test("test_reply_held_back_at_stream_end_is_flushed", async () => {
    const [service, frames] = _setup({ expectTranscript: true });
    await _drain(service, _chunk("<transcript>Hi</transcript><response>Hello the"), _chunk("re."));

    expect(_spoken(frames)).toBe("Hello there.");
  });

  test("test_think_tags_and_transcript_compose", async () => {
    const [service, frames] = _setup({ expectTranscript: true });
    await _drain(
      service,
      _chunk("<think>They asked for a city.</think>"),
      _chunk("<transcript>Where is it?</transcript>"),
      _chunk("<response>In Paris.</response>"),
    );

    const thought = frames
      .filter((f) => f instanceof LLMThoughtTextFrame)
      .map((f) => (f as LLMThoughtTextFrame).text)
      .join("");
    expect(thought).toBe("They asked for a city.");
    expect(frames[0]).toBeInstanceOf(LLMThoughtStartFrame);
    expect(frames.some((f) => f instanceof LLMThoughtEndFrame)).toBe(true);
    expect(_transcripts(frames)).toEqual(["Where is it?"]);
    expect(_spoken(frames)).toBe("In Paris.");
  });

  test("test_reasoning_content_stays_out_of_the_transcript", async () => {
    const [service, frames] = _setup({ expectTranscript: true });
    await _drain(
      service,
      _chunk(null, { reasoningContent: "Thinking hard." }),
      _chunk("<transcript>Hi</transcript><response>Hello.</response>"),
    );

    expect(frames[0]).toBeInstanceOf(LLMThoughtStartFrame);
    expect((frames[1] as LLMThoughtTextFrame).text).toBe("Thinking hard.");
    expect(_spoken(frames)).toBe("Hello.");
  });

  test("test_transcript_cut_off_by_an_interruption_is_not_reported", async () => {
    const [service, frames] = _setup({ expectTranscript: true });
    await service._pushLlmText("<transcript>Where is the");
    await service._finalizeReasoningState({ flushBufferedText: false });

    expect(_transcripts(frames)).toEqual([]);
  });

  test("test_plain_text_is_not_rewritten", async () => {
    const [service, frames] = _setup({ expectTranscript: false });
    const out = await _drain(service, _chunk("Hello"), _chunk(" there."));

    expect(out.map((c) => c.choices[0].delta.content)).toEqual(["Hello", " there."]);
    expect(_spoken(frames)).toBe("Hello there.");
  });
});

class _FakeStream {
  #chunks: unknown[];

  constructor(chunks: unknown[]) {
    this.#chunks = chunks;
  }

  [Symbol.asyncIterator](): AsyncIterator<Any> {
    return _stream(...this.#chunks);
  }

  async close(): Promise<void> {}
}

function _fakeClient(create: unknown): Any {
  return { chat: { completions: { create } } };
}

test("test_spoken_turn_is_transcribed_and_answered_in_a_pipeline", async () => {
  const service = _service();
  const create = mock(
    async (_body: Record<string, Any>, _options?: unknown) =>
      new _FakeStream([
        _chunk("<transcript>Where is the tower?</transcript>"),
        _chunk("<response>In Paris.</response>"),
      ]),
  );
  service._client = _fakeClient(create);
  const audio = _bytes(0, service._bytesPerSecond());

  const [downFrames, upFrames] = await runTest(service, {
    framesToSend: [
      new VADUserStartedSpeakingFrame(),
      new UserStartedSpeakingFrame(),
      _audioFrame(audio),
      // The user aggregator ends the turn after VAD stops, and
      // LLMService tracks VAD speaking state separately from Omni.
      new VADUserStoppedSpeakingFrame(),
      new UserStoppedSpeakingFrame(),
      new SleepFrame({ sleep: 0.2 }),
    ],
  });

  const spoken = downFrames
    .filter((f) => f instanceof LLMTextFrame)
    .map((f) => (f as LLMTextFrame).text)
    .join("");
  expect(spoken).toBe("In Paris.");
  expect(downFrames.some((f) => f instanceof LLMFullResponseStartFrame)).toBe(true);
  expect(downFrames.some((f) => f instanceof LLMFullResponseEndFrame)).toBe(true);
  expect(
    upFrames
      .filter((f) => f instanceof TranscriptionFrame)
      .map((f) => (f as TranscriptionFrame).text),
  ).toEqual(["Where is the tower?"]);
  const requestParts = create.mock.calls.at(-1)![0].messages.at(-1).content;
  expect(requestParts[0].type).toBe("audio_url");
});

test("test_transcript_is_pushed_upstream_and_not_written_to_the_context", async () => {
  const service = _service();
  const context = _ctx([{ role: "system", content: "You are helpful." }]);
  service._context = context;
  const pushed: [Frame, FrameDirection | undefined][] = [];
  service.pushFrame = mock(async (frame: Frame, direction?: FrameDirection) => {
    pushed.push([frame, direction]);
  });
  const extractor = new _TranscriptResponseExtractor();
  extractor.feed("<transcript>where is the tower?</transcript>");

  await service._maybePushTranscript(extractor);

  expect(context.getMessages().map((m) => (m as Record<string, unknown>).role)).toEqual(["system"]);
  const [frame, direction] = pushed.at(-1)!;
  expect(frame).toBeInstanceOf(TranscriptionFrame);
  expect((frame as TranscriptionFrame).text).toBe("where is the tower?");
  expect(direction).toBe(FrameDirection.UPSTREAM);
});

test("test_audio_input_announces_a_realtime_service", () => {
  expect(_service().serviceMetadataFrame().isRealtimeService).toBeTruthy();
  expect(_service({ audioInput: false }).serviceMetadataFrame().isRealtimeService).toBeFalsy();
});

test("test_text_llm_ignores_user_audio", async () => {
  const service = _service({ audioInput: false });
  service.pushFrame = mock(async () => {});
  await _speak(service);

  expect(service._preSpeechBuffer).toEqual([]);
  expect(service._turnTasks.length).toBe(0);
});

class _SlowStream {
  [Symbol.asyncIterator](): AsyncIterator<Any> {
    async function* chunks(): AsyncGenerator<Any> {
      await sleep(0.2);
      yield _chunk("Goodbye!");
    }
    return chunks();
  }

  async close(): Promise<void> {}
}

test.each([true, false])(
  "test_reply_requested_before_the_end_frame_is_completed[%p]",
  async (audioInput) => {
    const service = _service({ audioInput });
    service._client = _fakeClient(mock(async () => new _SlowStream()));

    const [downFrames] = await runTest(service, {
      framesToSend: [
        new LLMContextFrame({
          context: _ctx([{ role: "developer", content: "Say goodbye." }]),
        }),
      ],
    });

    expect(
      downFrames
        .filter((f) => f instanceof LLMTextFrame)
        .map((f) => (f as LLMTextFrame).text)
        .join(""),
    ).toBe("Goodbye!");
  },
);

test("test_current_turn_has_user_audio_only_during_an_audio_turn", async () => {
  const service = _service();
  expect(service.currentTurnHasUserAudio()).toBe(false);
  service._turnPartsVar.set([_audioPart(new Uint8Array(2), 16000, 1)]);
  expect(service.currentTurnHasUserAudio()).toBe(true);
});

test("test_audio_turn_is_appended_without_changing_the_context_params", () => {
  const service = _service();
  const paramsFromContext = { messages: [{ role: "user", content: "hi" }] };
  service._turnPartsVar.set([{ type: "text", text: "listen" }]);

  const params = service.buildChatCompletionParams(paramsFromContext);

  expect(params.messages.at(-1)).toEqual({
    role: "user",
    content: [{ type: "text", text: "listen" }],
  });
  expect(paramsFromContext.messages.length).toBe(1);
});

test("test_unset_token_limits_are_not_sent", () => {
  const params = _service().buildChatCompletionParams({ messages: [] });
  expect("max_tokens" in params).toBe(false);
  expect("max_completion_tokens" in params).toBe(false);
});

function _captureRequests(service: Any): Record<string, Any> {
  const sent: Record<string, Any> = {};

  const create = async (body: Record<string, Any>) => {
    Object.assign(sent, body);
    return { choices: [{ message: { content: "ok" } }] };
  };

  service._client = _fakeClient(create);
  return sent;
}

test("test_run_inference_sends_one_token_limit_and_no_audio_turn", async () => {
  const service = _service({ maxTokens: 8192 });
  service._turnPartsVar.set([{ type: "text", text: "listen" }]);
  const sent = _captureRequests(service);

  await service.runInference(_ctx([{ role: "user", content: "hi" }]), { maxTokens: 2048 });

  expect(sent.max_tokens).toBe(2048);
  expect("max_completion_tokens" in sent).toBe(false);
  expect(sent.messages).toEqual([{ role: "user", content: "hi" }]);
  expect(service._activeTurnParts).toEqual([{ type: "text", text: "listen" }]);
});

test("test_developer_messages_are_sent_as_user_messages", async () => {
  const service = _service();
  const sent = _captureRequests(service);

  await service.runInference(_ctx([{ role: "developer", content: "Introduce yourself." }]));

  expect(sent.messages).toEqual([{ role: "user", content: "Introduce yourself." }]);
});

test("test_turn_parts_are_only_sent_by_the_task_running_the_turn", async () => {
  const service = _service();
  const inTurn = new Event();
  const release = new Event();

  const turn = async () => {
    service._turnPartsVar.set([{ type: "text", text: "listen" }]);
    inTurn.set();
    await release.wait();
    return service.buildChatCompletionParams({ messages: [] }).messages;
  };

  const turnTask = createTask(() => turn());
  await inTurn.wait();
  const concurrent = service.buildChatCompletionParams({ messages: [] }).messages;
  release.set();

  expect(concurrent).toEqual([]);
  expect(await turnTask).toEqual([{ role: "user", content: [{ type: "text", text: "listen" }] }]);
});

test("test_multimodal_inference_returns_text_and_reasoning", async () => {
  const service = _service({ maxTokens: 8192 });
  const sent: Record<string, Any> = {};

  const create = async (body: Record<string, Any>) => {
    Object.assign(sent, body);
    const message = { content: " Berlin. ", reasoning_content: "Capital of Germany." };
    return { choices: [{ message, finish_reason: "stop" }] };
  };

  service._client = _fakeClient(create);

  const result = await service.runMultimodalInference(
    _ctx([{ role: "user", content: "Capital?" }]),
    { maxTokens: 256, reasoningBudget: 64 },
  );

  expect(result.text).toBe("Berlin.");
  expect(result.reasoning).toBe("Capital of Germany.");
  expect(result.finishReason).toBe("stop");
  expect(sent.max_tokens).toBe(256);
  // `extra_body` is merged into the request body (see the porting notes).
  expect(sent.reasoning_budget).toBe(64);
  expect(sent.stream).toBe(false);
});

test("test_multimodal_inference_reads_content_parts_and_extra_reasoning", async () => {
  const service = _service();
  // pydantic's `model_extra` is the message object itself in the JS SDK.
  const message = {
    content: [{ type: "text", text: "Berlin." }, { type: "image_url" }],
    reasoning: "Capital of Germany.",
  };

  const create = async () => ({ choices: [{ message, finish_reason: "stop" }] });

  service._client = _fakeClient(create);

  const result = await service.runMultimodalInference(
    _ctx([{ role: "user", content: "Capital?" }]),
  );

  expect([result.text, result.reasoning]).toEqual(["Berlin.", "Capital of Germany."]);
});

test("test_streamed_multimodal_inference_reports_deltas", async () => {
  const service = _service();

  const chunk = (
    content: string | null = null,
    reasoning: string | null = null,
    finishReason: string | null = null,
  ) => {
    const delta = { content, reasoning_content: reasoning };
    return { choices: [{ delta, finish_reason: finishReason }] };
  };

  const create = mock(async (_body: Record<string, Any>, _options?: unknown) =>
    _stream({ choices: [] }, chunk(null, "Hmm."), chunk("Ber"), chunk("lin.", null, "stop")),
  );
  service._client = _fakeClient(create);
  const textDeltas: string[] = [];
  const reasoningDeltas: string[] = [];

  const onText = async (delta: string) => {
    textDeltas.push(delta);
  };

  const onReasoning = async (delta: string) => {
    reasoningDeltas.push(delta);
  };

  const result = await service.runMultimodalInference(
    _ctx([{ role: "user", content: "Capital?" }]),
    {
      temperature: 0.2,
      stream: true,
      onTextDelta: onText,
      onReasoningDelta: onReasoning,
    },
  );

  expect(create.mock.calls.at(-1)![0].temperature).toBe(0.2);
  expect([result.text, result.reasoning, result.finishReason]).toEqual(["Berlin.", "Hmm.", "stop"]);
  expect(textDeltas).toEqual(["Ber", "lin."]);
  expect(reasoningDeltas).toEqual(["Hmm."]);
});

test("test_text_only_service_works_as_a_plain_llm_in_a_pipeline", async () => {
  const service = _service({ audioInput: false });
  const create = mock(
    async (_body: Record<string, Any>, _options?: unknown) =>
      new _FakeStream([_chunk("Hello there.")]),
  );
  service._client = _fakeClient(create);
  const audio = _bytes(0, service._bytesPerSecond());

  const [downFrames, upFrames] = await runTest(service, {
    framesToSend: [
      new UserStartedSpeakingFrame(),
      _audioFrame(audio),
      new UserStoppedSpeakingFrame(),
      new LLMContextFrame({ context: _ctx([{ role: "user", content: "hi" }]) }),
      new SleepFrame({ sleep: 0.2 }),
    ],
  });

  expect(
    downFrames
      .filter((f) => f instanceof LLMTextFrame)
      .map((f) => (f as LLMTextFrame).text)
      .join(""),
  ).toBe("Hello there.");
  expect(upFrames.some((f) => f instanceof TranscriptionFrame)).toBe(false);
  expect(create.mock.calls.length).toBe(1);
  expect(create.mock.calls.at(-1)![0].messages).toEqual([{ role: "user", content: "hi" }]);
});

test("test_subclass_can_report_transcripts_it_parses_itself", async () => {
  const reported: string[] = [];

  class Subclass extends NvidiaOmniLLMService {
    protected override async _emitUserTranscript(transcript: string): Promise<void> {
      reported.push(transcript);
      await super._emitUserTranscript(transcript);
    }
  }

  const service: Any = new Subclass({ baseUrl: "http://localhost:8000/v1" });
  service.pushFrame = mock(async () => {});
  const extractor = new _TranscriptResponseExtractor();
  extractor.feed("<transcript>hello</transcript>");

  await service._maybePushTranscript(extractor);

  expect(reported).toEqual(["hello"]);
  expect(service._lastTranscript).toBe("hello");
});

describe("TestTranscriptResponseExtractor", () => {
  const _feed = (...chunks: string[]): [_TranscriptResponseExtractor, string] => {
    const extractor = new _TranscriptResponseExtractor();
    return [extractor, chunks.map((chunk) => extractor.feed(chunk)).join("")];
  };

  test("test_tags_split_across_chunks_and_whitespace", () => {
    const [extractor, response] = _feed(
      "  ",
      "<trans",
      "cript>Hi</transcript>",
      "\n",
      "<resp",
      "onse>Hello.</response>",
      "x",
    );

    expect(extractor.transcript).toBe("Hi");
    expect(response).toBe("Hello.");
  });

  test("test_untagged_text_after_the_transcript_is_the_response", () => {
    const [extractor, response] = _feed("<transcript>Hi</transcript> Hello there.");

    expect(extractor.transcript).toBe("Hi");
    expect(response).toBe("Hello there.");
  });

  test.each(["", "<", "</trans", "</transcript"])(
    "test_unclosed_transcript_is_kept_at_stream_end[%p]",
    (tail) => {
      const [extractor, response] = _feed("<transcript>Where is the tower", tail);

      expect(extractor.finalize()).toBe("");
      expect(response).toBe("");
      expect(extractor.transcriptDone).toBe(true);
      expect(extractor.transcript).toBe("Where is the tower");
    },
  );

  test("test_angle_bracket_in_an_unclosed_transcript_is_kept", () => {
    const [extractor] = _feed("<transcript>Is 3 < 5");
    extractor.finalize();

    expect(extractor.transcript).toBe("Is 3 < 5");
  });
});

describe("TestAdapter", () => {
  const _convertedPart = async (message: LLMContextMessage): Promise<Any> => {
    const params: Any = await _service()
      .getLlmAdapter()
      .getLlmInvocationParams(_ctx([message]), { convertDeveloperToUser: false });
    return params.messages[0].content.at(-1);
  };

  test("test_input_audio_becomes_an_audio_url", async () => {
    const message: Any = { role: "user", content: [_audioPart(new Uint8Array(2), 16000, 1)] };

    const part = await _convertedPart(message);

    expect(part.type).toBe("audio_url");
    expect(part.audio_url.url.startsWith("data:audio/wav;base64,")).toBe(true);
    expect(message.content[0].type).toBe("input_audio");
  });

  test.each([
    ["audio/mpeg", "audio_url"],
    ["video/mp4", "video_url"],
    ["image/png", "image_url"],
  ])("test_media_files_use_the_part_omni_reads[%s-%s]", async (mimeType, partType) => {
    const dataUrl = `data:${mimeType};base64,${bytesToBase64(new TextEncoder().encode("media"))}`;
    const message = await LLMContext.createFileMessage({
      type: "bytes",
      format: mimeType,
      file: dataUrl,
      text: "Describe this.",
    });

    const part = await _convertedPart(message);

    expect(part).toEqual({ type: partType, [partType]: { url: dataUrl } });
  });
});
