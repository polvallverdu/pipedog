// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_empty_user_turn.py

import { describe, expect, test } from "bun:test";

import {
  BotStartedSpeakingFrame,
  BotStoppedSpeakingFrame,
  type Frame,
  FunctionCallFromLLM,
  FunctionCallsStartedFrame,
  LLMContextFrame,
  LLMFullResponseEndFrame,
  LLMFullResponseStartFrame,
  LLMRunFrame,
  LLMServiceMetadataFrame,
  TranscriptionFrame,
  TTSTextFrame,
  VADUserStartedSpeakingFrame,
  VADUserStoppedSpeakingFrame,
} from "../src/frames/frames.ts";
import { Pipeline } from "../src/pipeline/pipeline.ts";
import { LLMContext } from "../src/processors/aggregators/llm_context.ts";
import {
  LLMContextAggregatorPair,
  LLMUserAggregator,
  LLMUserAggregatorParams,
  type LLMUserAggregatorParamsOptions,
} from "../src/processors/aggregators/llm_response_universal.ts";
import { FrameDirection, FrameProcessor } from "../src/processors/frame_processor.ts";
import { runTest, SleepFrame } from "../src/tests/utils.ts";
import {
  DEFAULT_EMPTY_USER_TURN_INTERRUPTED_PROMPT,
  EmptyUserTurnConfig,
  type EmptyUserTurnConfigOptions,
} from "../src/turns/empty_user_turn.ts";
import {
  TranscriptionUserTurnStartStrategy,
  VADUserTurnStartStrategy,
} from "../src/turns/user_start/index.ts";
import { SpeechTimeoutUserTurnStopStrategy } from "../src/turns/user_stop/index.ts";
import { UserTurnStrategies } from "../src/turns/user_turn_strategies.ts";
import { TextType } from "../src/utils/text/base_text_aggregator.ts";

const USER_TURN_STOP_TIMEOUT = 0.2;
const USER_SPEECH_TIMEOUT = 0.1;

const INTERRUPTED_PROMPT = "interrupted, nothing recognized";
const IDLE_PROMPT = "idle, nothing recognized";

/** Counts the inferences requested by the user aggregator. */
class ContextFrameRecorder extends FrameProcessor {
  contextFrames = 0;

  override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
    await super.processFrame(frame, direction);
    if (frame instanceof LLMContextFrame && direction === FrameDirection.DOWNSTREAM) {
      this.contextFrames += 1;
    }
    await this.pushFrame(frame, direction);
  }
}

function _userParams(options: LLMUserAggregatorParamsOptions = {}): LLMUserAggregatorParams {
  return new LLMUserAggregatorParams({
    userTurnStrategies: new UserTurnStrategies({
      start: [new VADUserTurnStartStrategy(), new TranscriptionUserTurnStartStrategy()],
      stop: [new SpeechTimeoutUserTurnStopStrategy({ userSpeechTimeout: USER_SPEECH_TIMEOUT })],
    }),
    userTurnStopTimeout: USER_TURN_STOP_TIMEOUT,
    ...options,
  });
}

/** A user turn with voice activity and no transcript, closed by the watchdog. */
function _emptyTurn(): Frame[] {
  return [
    new VADUserStartedSpeakingFrame(),
    new VADUserStoppedSpeakingFrame(),
    new SleepFrame({ sleep: USER_TURN_STOP_TIMEOUT + 0.2 }),
  ];
}

function _transcribedTurn(text: string): Frame[] {
  return [
    new VADUserStartedSpeakingFrame(),
    new TranscriptionFrame({ text, userId: "", timestamp: "now" }),
    new VADUserStoppedSpeakingFrame(),
    new SleepFrame({ sleep: USER_SPEECH_TIMEOUT + 0.1 }),
  ];
}

/** The bot has finished speaking and is waiting for the user. */
function _botIdle(): Frame[] {
  return [new BotStoppedSpeakingFrame(), new SleepFrame()];
}

/** A requested bot response that is still being spoken. */
function _botSpeaking(): Frame[] {
  return [
    new LLMRunFrame(),
    new SleepFrame(),
    new LLMFullResponseStartFrame(),
    new BotStartedSpeakingFrame(),
    new TTSTextFrame({ text: "Where would", textType: TextType.WORD }),
    new SleepFrame(),
  ];
}

function _developerMessages(context: LLMContext): string[] {
  return (context.getMessages() as any[])
    .filter((m) => m.role === "developer")
    .map((m) => m.content);
}

// Python reads the protected `_params` directly.
function _paramsOf(user: LLMUserAggregator): LLMUserAggregatorParams {
  return (user as unknown as { _params: LLMUserAggregatorParams })._params;
}

describe("TestEmptyUserTurn", () => {
  async function _run(
    frames: Frame[],
    userParams: LLMUserAggregatorParamsOptions = {},
  ): Promise<[LLMContext, number]> {
    const context = new LLMContext();
    const [user, assistant] = new LLMContextAggregatorPair(context, {
      userParams: _userParams(userParams),
    });
    const recorder = new ContextFrameRecorder();
    await runTest(new Pipeline([user, recorder, assistant]), { framesToSend: frames });
    return [context, recorder.contextFrames];
  }

  function _config(options: EmptyUserTurnConfigOptions = {}): EmptyUserTurnConfig {
    return new EmptyUserTurnConfig({ interruptedPrompt: INTERRUPTED_PROMPT, ...options });
  }

  test("test_interrupted_while_speaking", async () => {
    const [context, inferences] = await _run([..._botSpeaking(), ..._emptyTurn()], {
      emptyUserTurn: _config(),
    });
    expect(_developerMessages(context)).toEqual([INTERRUPTED_PROMPT]);
    expect(inferences).toEqual(2);
    // The recovery comes after what the user heard of the interrupted response.
    const messages = context.getMessages();
    expect(messages[messages.length - 2]).toEqual({ role: "assistant", content: "Where would" });
  });

  test("test_interrupted_before_response_started", async () => {
    // The previous turn's response hadn't started when the user spoke:
    // nothing was heard, and the interruption cancelled it.
    const [context, inferences] = await _run(
      [..._botIdle(), ..._transcribedTurn("Tell me a story."), ..._emptyTurn()],
      { emptyUserTurn: _config() },
    );
    expect(_developerMessages(context)).toEqual([INTERRUPTED_PROMPT]);
    expect(inferences).toEqual(2);
  });

  test("test_before_bot_spoke", async () => {
    // Until the bot first finishes speaking it isn't waiting for the user,
    // e.g. its greeting may still be on the way.
    const [context] = await _run(_emptyTurn(), { emptyUserTurn: _config() });
    expect(_developerMessages(context)).toEqual([INTERRUPTED_PROMPT]);
  });

  test("test_idle_ignored_by_default", async () => {
    const [context, inferences] = await _run([..._botIdle(), ..._emptyTurn()], {
      emptyUserTurn: _config(),
    });
    expect(_developerMessages(context)).toEqual([]);
    expect(inferences).toEqual(0);
  });

  test("test_idle_prompt", async () => {
    const [context, inferences] = await _run([..._botIdle(), ..._emptyTurn()], {
      emptyUserTurn: _config({ idlePrompt: IDLE_PROMPT }),
    });
    expect(_developerMessages(context)).toEqual([IDLE_PROMPT]);
    expect(inferences).toEqual(1);
  });

  test("test_idle_after_response_finished", async () => {
    const [context] = await _run(
      [..._botSpeaking(), new LLMFullResponseEndFrame(), ..._botIdle(), ..._emptyTurn()],
      { emptyUserTurn: _config({ idlePrompt: IDLE_PROMPT }) },
    );
    expect(_developerMessages(context)).toEqual([IDLE_PROMPT]);
  });

  test("test_enabled_by_default", async () => {
    const [context, inferences] = await _run([..._botSpeaking(), ..._emptyTurn()]);
    expect(_developerMessages(context)).toEqual([DEFAULT_EMPTY_USER_TURN_INTERRUPTED_PROMPT]);
    expect(inferences).toEqual(2);
  });

  test("test_disabled", async () => {
    const [context, inferences] = await _run([..._botSpeaking(), ..._emptyTurn()], {
      emptyUserTurn: null,
    });
    expect(_developerMessages(context)).toEqual([]);
    expect(inferences).toEqual(1);
  });

  test("test_transcribed_turn_not_recovered", async () => {
    const [context, inferences] = await _run([..._botSpeaking(), ..._transcribedTurn("Hello!")], {
      emptyUserTurn: _config(),
    });
    expect(_developerMessages(context)).toEqual([]);
    expect(inferences).toEqual(2);
  });

  test("test_consecutive_recoveries_are_bounded", async () => {
    // The second empty turn interrupts the recovery's own pending response,
    // but only one recovery in a row is allowed. A transcribed turn resets
    // the count.
    const [context] = await _run(
      [
        ..._botSpeaking(),
        ..._emptyTurn(),
        ..._emptyTurn(),
        ..._transcribedTurn("Sorry, what?"),
        ..._emptyTurn(),
      ],
      { emptyUserTurn: _config() },
    );
    expect(_developerMessages(context)).toEqual([INTERRUPTED_PROMPT, INTERRUPTED_PROMPT]);
  });

  test("test_function_call_in_progress_not_recovered", async () => {
    // The function call's result will run the LLM on its own.
    const [context, inferences] = await _run(
      [
        new LLMRunFrame(),
        ..._botIdle(),
        new FunctionCallsStartedFrame({
          functionCalls: [
            new FunctionCallFromLLM({
              functionName: "get_weather",
              toolCallId: "1",
              arguments: {},
              context: null,
            }),
          ],
        }),
        new SleepFrame(),
        ..._emptyTurn(),
      ],
      { emptyUserTurn: _config() },
    );
    expect(_developerMessages(context)).toEqual([]);
    expect(inferences).toEqual(1);
  });

  test("test_without_pair", async () => {
    const context = new LLMContext();
    const user = new LLMUserAggregator(context, {
      params: _userParams({ emptyUserTurn: _config() }),
    });
    await runTest(new Pipeline([user]), {
      framesToSend: [..._botSpeaking(), ..._emptyTurn()],
    });
    expect(_developerMessages(context)).toEqual([INTERRUPTED_PROMPT]);
  });
});

describe("TestEmptyUserTurnIdle", () => {
  async function _idleFired(
    frames: Frame[],
    userParams: LLMUserAggregatorParamsOptions = {},
  ): Promise<boolean> {
    const context = new LLMContext();
    const [user, assistant] = new LLMContextAggregatorPair(context, {
      userParams: _userParams({ userIdleTimeout: 0.2, ...userParams }),
    });
    let idle = false;

    user.eventHandler("on_user_turn_idle", async (_aggregator) => {
      idle = true;
    });

    await runTest(new Pipeline([user, assistant]), {
      framesToSend: [...frames, new SleepFrame({ sleep: 0.4 })],
    });
    return idle;
  }

  test("test_idle_timer_rearmed_after_empty_turn", async () => {
    // The output transport stops the bot when the user interrupts it, while
    // the user turn is in progress, so that doesn't start the timer.
    expect(
      await _idleFired(
        [
          ..._botSpeaking(),
          new VADUserStartedSpeakingFrame(),
          new BotStoppedSpeakingFrame(),
          new VADUserStoppedSpeakingFrame(),
          new SleepFrame({ sleep: USER_TURN_STOP_TIMEOUT + 0.2 }),
        ],
        { emptyUserTurn: null },
      ),
    ).toBe(true);
  });

  test("test_idle_timer_not_rearmed_after_recovery", async () => {
    // The recovery response is on its way, so the user isn't idle yet.
    expect(await _idleFired([..._botSpeaking(), ..._emptyTurn()])).toBe(false);
  });
});

describe("TestEmptyUserTurnRealtime", () => {
  test("test_disabled_in_explicit_realtime_mode", async () => {
    const pair = new LLMContextAggregatorPair(new LLMContext(), { realtimeServiceMode: true });
    expect(_paramsOf(pair.user()).emptyUserTurn).toBeNull();
  });

  test("test_disabled_when_realtime_service_announces_itself", async () => {
    const pair = new LLMContextAggregatorPair(new LLMContext(), { userParams: _userParams() });
    await runTest(new Pipeline([pair.user(), pair.assistant()]), {
      framesToSend: [
        new LLMServiceMetadataFrame({ serviceName: "FakeRealtimeLLM", isRealtimeService: true }),
      ],
    });
    expect(_paramsOf(pair.user()).emptyUserTurn).toBeNull();
  });

  test("test_kept_for_a_non_realtime_service", async () => {
    const pair = new LLMContextAggregatorPair(new LLMContext(), { userParams: _userParams() });
    await runTest(new Pipeline([pair.user(), pair.assistant()]), {
      framesToSend: [new LLMServiceMetadataFrame({ serviceName: "FakeLLM" })],
    });
    expect(_paramsOf(pair.user()).emptyUserTurn).not.toBeNull();
  });
});
