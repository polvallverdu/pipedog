// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_context_aggregators_universal.py

import { describe, expect, test } from "bun:test";

import { FunctionSchema } from "../src/adapters/schemas/function_schema.ts";
import { AdapterType, ToolsSchema } from "../src/adapters/schemas/tools_schema.ts";
import {
  AggregatedTextFrame,
  BotStartedSpeakingFrame,
  BotStoppedSpeakingFrame,
  type Frame,
  FunctionCallCancelFrame,
  FunctionCallFromLLM,
  FunctionCallInProgressFrame,
  FunctionCallResultFrame,
  FunctionCallResultProperties,
  FunctionCallsStartedFrame,
  InterimTranscriptionFrame,
  InterruptionFrame,
  LLMAssistantPushAggregationFrame,
  LLMContextAssistantTimestampFrame,
  LLMContextAssistantTurnFrame,
  LLMContextFrame,
  LLMContextUserTurnFrame,
  LLMFullResponseEndFrame,
  LLMFullResponseStartFrame,
  LLMMessagesAppendFrame,
  LLMMessagesTransformFrame,
  LLMMessagesUpdateFrame,
  LLMRunFrame,
  LLMServiceMetadataFrame,
  LLMSetToolsFrame,
  LLMTextFrame,
  LLMThoughtEndFrame,
  LLMThoughtStartFrame,
  LLMThoughtTextFrame,
  LLMUpdateSettingsFrame,
  ProposedUserStartedSpeakingFrame,
  ProposedUserStoppedSpeakingFrame,
  SpeechControlParamsFrame,
  STTMetadataFrame,
  StartFrame,
  TextFrame,
  TranscriptionFrame,
  TranslationFrame,
  TTSStartedFrame,
  TTSTextFrame,
  UserBackchannelFrame,
  UserFileRawFrame,
  UserImageRawFrame,
  UserMuteStartedFrame,
  UserStartedSpeakingFrame,
  UserStoppedSpeakingFrame,
  UserTurnInferenceCompletedFrame,
  VADUserStartedSpeakingFrame,
  VADUserStoppedSpeakingFrame,
} from "../src/frames/frames.ts";
import { Pipeline } from "../src/pipeline/pipeline.ts";
import * as asyncToolMessages from "../src/processors/aggregators/async_tool_messages.ts";
import {
  LLMContext,
  type LLMContextMessage,
  NOT_GIVEN,
} from "../src/processors/aggregators/llm_context.ts";
import {
  type AssistantBackchannelMessage,
  type AssistantThoughtMessage,
  type AssistantTurnStoppedMessage,
  LLMAssistantAggregator,
  LLMAssistantAggregatorParams,
  LLMContextAggregatorPair,
  LLMUserAggregator,
  LLMUserAggregatorParams,
  UserBackchannelMessage,
  type UserTurnMessageAddedMessage,
  type UserTurnStoppedMessage,
} from "../src/processors/aggregators/llm_response_universal.ts";
import { FrameDirection, FrameProcessor } from "../src/processors/frame_processor.ts";
import { runTest, SleepFrame } from "../src/tests/utils.ts";
import {
  FirstSpeechUserMuteStrategy,
  FunctionCallUserMuteStrategy,
  MuteUntilFirstBotCompleteUserMuteStrategy,
} from "../src/turns/user_mute/index.ts";
import {
  ExternalUserTurnStartStrategy,
  TranscriptionUserTurnStartStrategy,
  VADUserTurnStartStrategy,
} from "../src/turns/user_start/index.ts";
import {
  deferred,
  ExternalUserTurnStopStrategy,
  LLMTurnCompletionUserTurnStopStrategy,
  SpeechTimeoutUserTurnStopStrategy,
} from "../src/turns/user_stop/index.ts";
import {
  USER_TURN_COMPLETE_MARKER,
  USER_TURN_INCOMPLETE_SHORT_MARKER,
} from "../src/turns/user_turn_completion_mixin.ts";
import {
  ExternalUserTurnStrategies,
  FilterIncompleteUserTurnStrategies,
  UserTurnStrategies,
} from "../src/turns/user_turn_strategies.ts";
import { type LogRecord, logger } from "../src/utils/logger.ts";
import { TextType } from "../src/utils/text/base_text_aggregator.ts";

const USER_TURN_STOP_TIMEOUT = 0.2;
const TRANSCRIPTION_TIMEOUT = 0.1;

/** Reach into protected state, as the upstream tests do with `_attr`. */
const internals = (x: unknown): any => x;

type Msg = any;

function frameNames(frames: Frame[]): string[] {
  return frames.map((f) => f.constructor.name);
}

function countOf(names: string[], name: string): number {
  return names.filter((n) => n === name).length;
}

function transcription(text: string): TranscriptionFrame {
  return new TranscriptionFrame({ text, userId: "", timestamp: "now" });
}

function interim(text: string): InterimTranscriptionFrame {
  return new InterimTranscriptionFrame({ text, userId: "", timestamp: "now" });
}

describe("TestLLMUserAggregator", () => {
  test("test_llm_run", async () => {
    const context = new LLMContext();

    const pipeline = new Pipeline([new LLMUserAggregator(context)]);

    const framesToSend = [new LLMRunFrame()];
    const expectedDownFrames = [SpeechControlParamsFrame, LLMContextFrame];
    await runTest(pipeline, { framesToSend, expectedDownFrames });
  });

  test("test_llm_messages_append", async () => {
    const context = new LLMContext();

    const pipeline = new Pipeline([new LLMUserAggregator(context)]);

    const framesToSend = [
      new LLMMessagesAppendFrame({ messages: [{ role: "user", content: "Hi there!" }] }),
    ];
    const expectedDownFrames = [
      SpeechControlParamsFrame, // no LLMContextFrame expected, run_llm defaults to False
    ];
    await runTest(pipeline, { framesToSend, expectedDownFrames });
    expect((context.messages[0] as Msg).content).toEqual("Hi there!");
  });

  test("test_llm_messages_append_run", async () => {
    const context = new LLMContext();
    const pipeline = new Pipeline([new LLMUserAggregator(context)]);

    const framesToSend = [
      new LLMMessagesAppendFrame({
        messages: [{ role: "user", content: "Hi there!" }],
        runLlm: true,
      }),
    ];
    const expectedDownFrames = [SpeechControlParamsFrame, LLMContextFrame];
    await runTest(pipeline, { framesToSend, expectedDownFrames });
    expect((context.messages[0] as Msg).content).toEqual("Hi there!");
  });

  test("test_llm_messages_update", async () => {
    const context = new LLMContext();
    const pipeline = new Pipeline([new LLMUserAggregator(context)]);

    const framesToSend = [
      new LLMMessagesUpdateFrame({ messages: [{ role: "user", content: "Hi there!" }] }),
    ];
    const expectedDownFrames = [
      SpeechControlParamsFrame, // no LLMContextFrame expected, run_llm defaults to False
    ];
    await runTest(pipeline, { framesToSend, expectedDownFrames });
    expect((context.messages[0] as Msg).content).toEqual("Hi there!");
  });

  test("test_llm_messages_update_run", async () => {
    const context = new LLMContext();
    const pipeline = new Pipeline([new LLMUserAggregator(context)]);

    const framesToSend = [
      new LLMMessagesUpdateFrame({
        messages: [{ role: "user", content: "Hi there!" }],
        runLlm: true,
      }),
    ];
    await runTest(pipeline, { framesToSend });
    expect((context.messages[0] as Msg).content).toEqual("Hi there!");
  });

  test("test_llm_messages_update_does_not_inject_turn_completion_into_context", async () => {
    const context = new LLMContext();
    const params = new LLMUserAggregatorParams({
      userTurnStrategies: new FilterIncompleteUserTurnStrategies(),
    });
    const pipeline = new Pipeline([new LLMUserAggregator(context, { params })]);

    const newMessages = [
      { role: "system", content: "You are a helpful assistant." },
      { role: "user", content: "Hello!" },
    ] as LLMContextMessage[];
    const framesToSend = [new LLMMessagesUpdateFrame({ messages: newMessages })];
    await runTest(pipeline, { framesToSend });
    // Turn completion instructions are now set via system_instruction on the
    // LLM service, not injected into context messages.
    expect(context.messages.length).toEqual(2);
    expect((context.messages[0] as Msg).content).toEqual("You are a helpful assistant.");
    expect((context.messages[1] as Msg).content).toEqual("Hello!");
  });

  test("test_llm_messages_transform", async () => {
    const context = new LLMContext();
    // Set up initial messages
    context.setMessages([
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there!" },
      { role: "user", content: "How are you?" },
    ]);

    const pipeline = new Pipeline([new LLMUserAggregator(context)]);

    // Transform that keeps only user messages
    const keepUserMessages = (messages: LLMContextMessage[]) =>
      messages.filter((m) => (m as Msg).role === "user");

    const framesToSend = [new LLMMessagesTransformFrame({ transform: keepUserMessages })];
    const expectedDownFrames = [
      SpeechControlParamsFrame, // no LLMContextFrame expected, run_llm defaults to False
    ];
    await runTest(pipeline, { framesToSend, expectedDownFrames });
    expect(context.messages.length).toEqual(2);
    expect((context.messages[0] as Msg).content).toEqual("Hello");
    expect((context.messages[1] as Msg).content).toEqual("How are you?");
  });

  test("test_llm_messages_transform_run", async () => {
    const context = new LLMContext();
    // Set up initial messages
    context.setMessages([{ role: "user", content: "Hello" }]);

    const pipeline = new Pipeline([new LLMUserAggregator(context)]);

    // Transform that modifies the content
    const uppercaseContent = (messages: LLMContextMessage[]) =>
      messages.map((m) => ({ role: (m as Msg).role, content: (m as Msg).content.toUpperCase() }));

    const framesToSend = [
      new LLMMessagesTransformFrame({ transform: uppercaseContent, runLlm: true }),
    ];
    const expectedDownFrames = [SpeechControlParamsFrame, LLMContextFrame];
    await runTest(pipeline, { framesToSend, expectedDownFrames });
    expect((context.messages[0] as Msg).content).toEqual("HELLO");
  });

  test("test_default_user_turn_strategies", async () => {
    const context = new LLMContext();
    const userAggregator = new LLMUserAggregator(context, {
      params: new LLMUserAggregatorParams({
        userTurnStrategies: new UserTurnStrategies({
          stop: [
            new SpeechTimeoutUserTurnStopStrategy({ userSpeechTimeout: TRANSCRIPTION_TIMEOUT }),
          ],
        }),
      }),
    });

    let shouldStart: boolean | null = null;
    let shouldStop: boolean | null = null;
    let stopMessage: UserTurnStoppedMessage | null = null;

    userAggregator.eventHandler("on_user_turn_started", async (_aggregator, _strategy) => {
      shouldStart = true;
    });

    userAggregator.eventHandler(
      "on_user_turn_stopped",
      async (_aggregator, _strategy, message: UserTurnStoppedMessage) => {
        shouldStop = true;
        stopMessage = message;
      },
    );

    const pipeline = new Pipeline([userAggregator]);

    const framesToSend = [
      new VADUserStartedSpeakingFrame(),
      transcription("Hello!"),
      new SleepFrame(),
      new VADUserStoppedSpeakingFrame(),
      // Wait for user_speech_timeout to elapse
      new SleepFrame({ sleep: TRANSCRIPTION_TIMEOUT + 0.1 }),
    ];
    const expectedDownFrames = [
      VADUserStartedSpeakingFrame,
      UserStartedSpeakingFrame,
      InterruptionFrame,
      VADUserStoppedSpeakingFrame,
      LLMContextUserTurnFrame,
      LLMContextFrame,
      UserStoppedSpeakingFrame,
    ];
    const expectedUpFrames = [
      UserStartedSpeakingFrame,
      InterruptionFrame,
      LLMContextUserTurnFrame,
      UserStoppedSpeakingFrame,
    ];
    await runTest(pipeline, { framesToSend, expectedDownFrames, expectedUpFrames });
    expect(shouldStart).toBe(true);
    expect(shouldStop).toBe(true);
    expect(stopMessage!.content).toEqual("Hello!");
  });

  test("test_service_requested_turn_strategies_applied", async () => {
    // An STTMetadataFrame swaps the defaults when the user set none.
    const context = new LLMContext();
    const userAggregator = new LLMUserAggregator(context); // no user_turn_strategies

    const frame = new STTMetadataFrame({
      serviceName: "some-stt",
      ttfsP99Latency: 0.0,
      userTurnStrategies: new ExternalUserTurnStrategies(),
    });
    await runTest(new Pipeline([userAggregator]), { framesToSend: [frame] });

    const strategies = internals(userAggregator._userTurnController)._userTurnStrategies;
    expect(strategies.start.some((s: unknown) => s instanceof ExternalUserTurnStartStrategy)).toBe(
      true,
    );
    expect(strategies.stop.some((s: unknown) => s instanceof ExternalUserTurnStopStrategy)).toBe(
      true,
    );
  });

  test("test_user_strategies_override_service_request", async () => {
    // A user-provided strategy wins; the service's request is ignored.
    const existingStop = new SpeechTimeoutUserTurnStopStrategy({
      userSpeechTimeout: TRANSCRIPTION_TIMEOUT,
    });
    const context = new LLMContext();
    const userAggregator = new LLMUserAggregator(context, {
      params: new LLMUserAggregatorParams({
        userTurnStrategies: new UserTurnStrategies({ stop: [existingStop] }),
      }),
    });

    const frame = new STTMetadataFrame({
      serviceName: "some-stt",
      ttfsP99Latency: 0.0,
      userTurnStrategies: new ExternalUserTurnStrategies(),
    });
    await runTest(new Pipeline([userAggregator]), { framesToSend: [frame] });

    const strategies = internals(userAggregator._userTurnController)._userTurnStrategies;
    expect(strategies.stop).toEqual([existingStop]);
    expect(strategies.stop.some((s: unknown) => s instanceof ExternalUserTurnStopStrategy)).toBe(
      false,
    );
  });

  test("test_proposed_frames_produce_turn_frames_and_interruption", async () => {
    // A proposal leaves the decision here, so the aggregator emits.
    const context = new LLMContext();
    const userAggregator = new LLMUserAggregator(context, {
      params: new LLMUserAggregatorParams({
        userTurnStrategies: new ExternalUserTurnStrategies(),
      }),
    });

    const framesToSend = [
      new ProposedUserStartedSpeakingFrame(),
      transcription("Hello!"),
      new ProposedUserStoppedSpeakingFrame(),
      new SleepFrame({ sleep: 1.0 }),
    ];
    const expectedDownFrames = [
      UserStartedSpeakingFrame,
      InterruptionFrame,
      LLMContextUserTurnFrame,
      LLMContextFrame,
      UserStoppedSpeakingFrame,
    ];
    await runTest(new Pipeline([userAggregator]), { framesToSend, expectedDownFrames });
  });

  test("test_a_start_proposed_while_the_stop_awaits_its_transcript_extends_the_turn", async () => {
    // A service that proposes the stop before its transcript can see the user
    // resume.
    //
    // The stop strategy holds the turn while it waits on the transcript. A start
    // proposed in that window keeps the turn open, so both halves land in one
    // user message and the bot is interrupted only once.
    //
    // The hold is set far longer than the test runs, so the turn can only close
    // on the stop proposed after the final transcript.
    const context = new LLMContext();
    const userAggregator = new LLMUserAggregator(context, {
      params: new LLMUserAggregatorParams({
        userTurnStrategies: new UserTurnStrategies({
          start: [new ExternalUserTurnStartStrategy()],
          stop: [new ExternalUserTurnStopStrategy({ timeout: 60.0 })],
        }),
      }),
    });

    const framesToSend = [
      new ProposedUserStartedSpeakingFrame(),
      interim("I'd like to book a"),
      new ProposedUserStoppedSpeakingFrame(),
      transcription("I'd like to book a"),
      new ProposedUserStartedSpeakingFrame(),
      interim("table for"),
      transcription("table for two"),
      new ProposedUserStoppedSpeakingFrame(),
      new SleepFrame({ sleep: 0.3 }),
    ];
    const [receivedDown] = await runTest(new Pipeline([userAggregator]), {
      framesToSend,
      expectedDownFrames: null,
    });
    const names = frameNames(receivedDown);
    expect(countOf(names, "UserStartedSpeakingFrame")).toEqual(1);
    expect(countOf(names, "InterruptionFrame")).toEqual(1);
    expect(countOf(names, "UserStoppedSpeakingFrame")).toEqual(1);
    expect(
      context
        .getMessages()
        .filter((m) => (m as Msg).role === "user")
        .map((m) => (m as Msg).content),
    ).toEqual(["I'd like to book a table for two"]);
  });

  test("test_turn_closes_on_the_stop_signal_when_the_transcript_precedes_it", async () => {
    // A service that pushes the transcript before proposing the stop closes at
    // once.
    //
    // The aggregation timer is set far longer than the test runs, so the turn can
    // only close from the stop signal itself. That path needs the final
    // transcript to have arrived first, which holds only while
    // `ProposedUserStoppedSpeakingFrame` stays ordered against it.

    /** Stands in for an STT whose provider reports turn boundaries. */
    class TurnDetectingSTT extends FrameProcessor {
      override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
        await super.processFrame(frame, direction);
        await this.pushFrame(frame, direction);
        if (frame instanceof InterimTranscriptionFrame) {
          await this.pushFrame(transcription("Hello!"));
          await this.broadcastFrame(ProposedUserStoppedSpeakingFrame);
        }
      }
    }

    const context = new LLMContext();
    const userAggregator = new LLMUserAggregator(context, {
      params: new LLMUserAggregatorParams({
        userTurnStrategies: new ExternalUserTurnStrategies({
          stop: [new ExternalUserTurnStopStrategy({ timeout: 30.0 })],
        }),
      }),
    });

    const framesToSend = [
      new ProposedUserStartedSpeakingFrame(),
      interim("Hel"),
      new SleepFrame({ sleep: 0.3 }),
    ];
    const expectedDownFrames = [
      UserStartedSpeakingFrame,
      InterruptionFrame,
      LLMContextUserTurnFrame,
      LLMContextFrame,
      UserStoppedSpeakingFrame,
    ];
    await runTest(new Pipeline([new TurnDetectingSTT(), userAggregator]), {
      framesToSend,
      expectedDownFrames,
    });
  });

  test("test_proposed_frames_go_unresolved_while_the_user_is_muted", async () => {
    // Muting gates the proposal, so no turn is decided from it.
    const context = new LLMContext();
    const userAggregator = new LLMUserAggregator(context, {
      params: new LLMUserAggregatorParams({
        userTurnStrategies: new ExternalUserTurnStrategies(),
        userMuteStrategies: [new FirstSpeechUserMuteStrategy()],
      }),
    });

    const framesToSend = [
      // Bot is speaking, so the user is muted.
      new BotStartedSpeakingFrame(),
      new SleepFrame(),
      new ProposedUserStartedSpeakingFrame(),
      transcription("Hello!"),
      new ProposedUserStoppedSpeakingFrame(),
      new SleepFrame({ sleep: 1.0 }),
    ];
    const [receivedDown] = await runTest(new Pipeline([userAggregator]), {
      framesToSend,
      expectedDownFrames: null,
    });
    const names = frameNames(receivedDown);
    expect(names).not.toContain("UserStartedSpeakingFrame");
    expect(names).not.toContain("UserStoppedSpeakingFrame");
    expect(names).not.toContain("InterruptionFrame");
  });

  test("test_proposed_frames_are_consumed_by_the_resolver", async () => {
    // The resolver owns the proposal, so it doesn't reach a second resolver.
    const context = new LLMContext();
    const userAggregator = new LLMUserAggregator(context, {
      params: new LLMUserAggregatorParams({
        userTurnStrategies: new ExternalUserTurnStrategies(),
      }),
    });

    const [receivedDown] = await runTest(new Pipeline([userAggregator]), {
      framesToSend: [new ProposedUserStartedSpeakingFrame(), new SleepFrame({ sleep: 0.2 })],
      expectedDownFrames: null,
    });
    expect(receivedDown.some((f) => f instanceof ProposedUserStartedSpeakingFrame)).toBe(false);
  });

  test("test_real_turn_frames_are_adopted_without_re_emission", async () => {
    // The emitter already announced the turn, so the aggregator emits nothing.
    const context = new LLMContext();
    const userAggregator = new LLMUserAggregator(context, {
      params: new LLMUserAggregatorParams({
        userTurnStrategies: new ExternalUserTurnStrategies(),
      }),
    });

    const framesToSend = [
      new UserStartedSpeakingFrame(),
      transcription("Hello!"),
      new UserStoppedSpeakingFrame(),
      new SleepFrame({ sleep: 1.0 }),
    ];
    // Only the two frames we sent, passed through — no second pair, no
    // interruption.
    const expectedDownFrames = [
      UserStartedSpeakingFrame,
      UserStoppedSpeakingFrame,
      LLMContextUserTurnFrame,
      LLMContextFrame,
    ];
    await runTest(new Pipeline([userAggregator]), { framesToSend, expectedDownFrames });
  });

  test("test_pinned_non_external_strategies_ignore_proposals", async () => {
    // Proposals go unresolved when nothing consumes them; the pin drives turns.
    const context = new LLMContext();
    const userAggregator = new LLMUserAggregator(context, {
      params: new LLMUserAggregatorParams({
        userTurnStrategies: new UserTurnStrategies({
          start: [new VADUserTurnStartStrategy()],
          stop: [
            new SpeechTimeoutUserTurnStopStrategy({ userSpeechTimeout: TRANSCRIPTION_TIMEOUT }),
          ],
        }),
      }),
    });

    const framesToSend = [
      new ProposedUserStartedSpeakingFrame(),
      new VADUserStartedSpeakingFrame(),
      transcription("Hello!"),
      new ProposedUserStoppedSpeakingFrame(),
      new VADUserStoppedSpeakingFrame(),
      new SleepFrame({ sleep: 1.0 }),
    ];
    const [receivedDown] = await runTest(new Pipeline([userAggregator]), {
      framesToSend,
      expectedDownFrames: null,
    });
    const names = frameNames(receivedDown);
    expect(countOf(names, "UserStartedSpeakingFrame")).toEqual(1);
    expect(countOf(names, "UserStoppedSpeakingFrame")).toEqual(1);
  });

  test("test_warns_when_pin_discards_the_services_interruption_setting", async () => {
    // A pin that re-enables interruptions the service turned off is called out.
    const context = new LLMContext();
    const userAggregator = new LLMUserAggregator(context, {
      params: new LLMUserAggregatorParams({
        userTurnStrategies: new ExternalUserTurnStrategies(),
      }),
    });

    const frame = new STTMetadataFrame({
      serviceName: "some-stt",
      ttfsP99Latency: 0.0,
      userTurnStrategies: new ExternalUserTurnStrategies({ enableInterruptions: false }),
    });
    const sink: string[] = [];
    const levels = new Set(["WARNING", "ERROR", "CRITICAL"]);
    const removeSink = logger.addSink((record: LogRecord) => {
      if (levels.has(record.level)) sink.push(record.message);
    });
    try {
      await runTest(new Pipeline([userAggregator]), { framesToSend: [frame] });
    } finally {
      removeSink();
    }
    const value = sink.join("\n");
    expect(value).toContain("interruptions to stay off");
    expect(value).toContain("enable_interruptions=False");
  });

  test("test_user_turn_stop_timeout_no_transcription", async () => {
    const context = new LLMContext();

    const userAggregator = new LLMUserAggregator(context, {
      params: new LLMUserAggregatorParams({ userTurnStopTimeout: USER_TURN_STOP_TIMEOUT }),
    });

    let shouldStart: boolean | null = null;
    let shouldStop: boolean | null = null;
    let timeout: boolean | null = null;

    userAggregator.eventHandler("on_user_turn_started", async (_aggregator, _strategy) => {
      shouldStart = true;
    });

    userAggregator.eventHandler(
      "on_user_turn_stopped",
      async (_aggregator, _strategy, _message) => {
        shouldStop = true;
      },
    );

    userAggregator.eventHandler("on_user_turn_stop_timeout", async (_aggregator) => {
      timeout = true;
    });

    const pipeline = new Pipeline([userAggregator]);

    const framesToSend = [
      new VADUserStartedSpeakingFrame(),
      new VADUserStoppedSpeakingFrame(),
      new SleepFrame({ sleep: USER_TURN_STOP_TIMEOUT + 0.1 }),
    ];
    await runTest(pipeline, { framesToSend });

    expect(shouldStart).toBe(true);
    expect(shouldStop).toBe(true);
    expect(timeout).toBe(true);
  });

  test("test_user_turn_stop_timeout_transcription", async () => {
    const context = new LLMContext();

    const userAggregator = new LLMUserAggregator(context, {
      params: new LLMUserAggregatorParams({
        userTurnStrategies: new UserTurnStrategies({
          stop: [
            new SpeechTimeoutUserTurnStopStrategy({ userSpeechTimeout: TRANSCRIPTION_TIMEOUT }),
          ],
        }),
        userTurnStopTimeout: USER_TURN_STOP_TIMEOUT,
      }),
    });

    let shouldStart: boolean | null = null;
    let shouldStop: boolean | null = null;
    let stopMessage: UserTurnStoppedMessage | null = null;
    let timeout: boolean | null = null;

    userAggregator.eventHandler("on_user_turn_started", async (_aggregator, _strategy) => {
      shouldStart = true;
    });

    userAggregator.eventHandler(
      "on_user_turn_stopped",
      async (_aggregator, _strategy, message: UserTurnStoppedMessage) => {
        shouldStop = true;
        stopMessage = message;
      },
    );

    userAggregator.eventHandler("on_user_turn_stop_timeout", async (_aggregator) => {
      timeout = true;
    });

    const pipeline = new Pipeline([userAggregator]);

    // Transcript arrives before VAD stop, then we wait for user_speech_timeout
    const framesToSend = [
      new VADUserStartedSpeakingFrame(),
      transcription("Hello!"),
      new VADUserStoppedSpeakingFrame(),
      // Wait for user_speech_timeout (TRANSCRIPTION_TIMEOUT=0.1s) to elapse
      new SleepFrame({ sleep: TRANSCRIPTION_TIMEOUT + 0.05 }),
    ];
    await runTest(pipeline, { framesToSend });

    // The transcription strategy should kick-in before the user turn end timeout.
    expect(shouldStart).toBe(true);
    expect(shouldStop).toBe(true);
    expect(stopMessage!.content).toEqual("Hello!");
    expect(timeout).toBeFalsy();
  });

  test("test_user_mute_strategies", async () => {
    const context = new LLMContext();

    const userAggregator = new LLMUserAggregator(context, {
      params: new LLMUserAggregatorParams({
        userMuteStrategies: [new FirstSpeechUserMuteStrategy(), new FunctionCallUserMuteStrategy()],
      }),
    });

    let userTurn = false;

    userAggregator.eventHandler("on_user_turn_started", async (_aggregator, _strategy) => {
      userTurn = true;
    });

    const pipeline = new Pipeline([userAggregator]);

    const framesToSend = [
      // Bot is speaking, user should be muted.
      new BotStartedSpeakingFrame(),
      new VADUserStartedSpeakingFrame(),
      new VADUserStoppedSpeakingFrame(),
      transcription("Hello!"),
      new SleepFrame(),
      new BotStoppedSpeakingFrame(),
      // Function call is executing, user should be muted.
      new FunctionCallsStartedFrame({
        functionCalls: [
          new FunctionCallFromLLM({
            functionName: "fn_1",
            toolCallId: "1",
            arguments: {},
            context: null,
          }),
        ],
      }),
      new SleepFrame(),
      new VADUserStartedSpeakingFrame(),
      new VADUserStoppedSpeakingFrame(),
      transcription("Hello!"),
      new FunctionCallResultFrame({
        functionName: "fn_1",
        toolCallId: "1",
        arguments: {},
        result: {},
      }),
      new SleepFrame(),
    ];
    await runTest(pipeline, { framesToSend });

    // The user mute strategies should have muted the user.
    expect(userTurn).toBe(false);
  });

  test("test_pending_transcription_emitted_on_end_frame", async () => {
    // Pending user transcription should be emitted when EndFrame arrives.
    const context = new LLMContext();

    const userAggregator = new LLMUserAggregator(context);

    const stopMessages: [unknown, UserTurnStoppedMessage][] = [];

    userAggregator.eventHandler(
      "on_user_turn_stopped",
      async (_aggregator, strategy, message: UserTurnStoppedMessage) => {
        stopMessages.push([strategy, message]);
      },
    );

    const pipeline = new Pipeline([userAggregator]);

    // Start turn and send transcription, but don't trigger normal turn stop
    const framesToSend = [
      new VADUserStartedSpeakingFrame(),
      transcription("Hello!"),
      // No VADUserStoppedSpeakingFrame - turn doesn't stop normally
      // EndFrame will be sent by run_test, triggering emission
    ];
    await runTest(pipeline, { framesToSend });

    // The pending transcription should be emitted on EndFrame
    expect(stopMessages.length).toEqual(1);
    const [strategy, message] = stopMessages[0]!;
    expect(strategy).toBeNull(); // strategy is None for end/cancel
    expect(message.content).toEqual("Hello!");
  });

  test("test_start_frame_before_mute_event", async () => {
    // StartFrame must reach downstream before mute events are broadcast.
    //
    // With MuteUntilFirstBotCompleteUserMuteStrategy, the mute logic should not
    // run on control frames (StartFrame, EndFrame, CancelFrame). This ensures
    // StartFrame reaches downstream processors before UserMuteStartedFrame is
    // broadcast.
    //
    // The default TurnAnalyzerUserTurnStopStrategy broadcasts a
    // SpeechControlParamsFrame when it processes StartFrame, which gets
    // re-queued to the aggregator. That non-control frame legitimately triggers
    // the mute state change, so UserMuteStartedFrame follows StartFrame — but
    // crucially, after it.
    const context = new LLMContext();

    const userAggregator = new LLMUserAggregator(context, {
      params: new LLMUserAggregatorParams({
        userMuteStrategies: [new MuteUntilFirstBotCompleteUserMuteStrategy()],
      }),
    });

    const pipeline = new Pipeline([userAggregator]);

    // run_test internally sends StartFrame via WorkerRunner. With
    // ignore_start=False we can verify ordering: StartFrame must arrive before
    // UserMuteStartedFrame.
    await runTest(pipeline, {
      framesToSend: [],
      expectedDownFrames: [StartFrame, UserMuteStartedFrame, SpeechControlParamsFrame],
      ignoreStart: false,
    });
  });

  test("test_interim_transcription_not_pushed_downstream", async () => {
    // InterimTranscriptionFrame should be consumed and not pushed downstream.
    const context = new LLMContext();
    const pipeline = new Pipeline([new LLMUserAggregator(context)]);

    const framesToSend = [interim("Hel"), interim("Hello")];
    // The interim transcription triggers a user turn start via the default
    // TranscriptionUserTurnStartStrategy, so we expect turn-related frames but
    // NOT the InterimTranscriptionFrame itself.
    const expectedDownFrames = [
      SpeechControlParamsFrame,
      UserStartedSpeakingFrame,
      InterruptionFrame,
    ];
    const [downFrames] = await runTest(pipeline, { framesToSend, expectedDownFrames });
    expect(downFrames.some((f) => f instanceof InterimTranscriptionFrame)).toBe(false);
  });

  test("test_translation_not_pushed_downstream", async () => {
    // TranslationFrame should be consumed and not pushed downstream.
    const context = new LLMContext();
    const pipeline = new Pipeline([new LLMUserAggregator(context)]);

    const framesToSend = [
      new TranslationFrame({ text: "Hola!", userId: "", timestamp: "now", language: "es" }),
    ];
    // Only the SpeechControlParamsFrame from the default turn strategy on start
    // is expected — the translation itself is consumed.
    await runTest(pipeline, { framesToSend, expectedDownFrames: [SpeechControlParamsFrame] });
  });

  test("test_inference_triggered_event_fires_on_default_strategies", async () => {
    // Default flow fires inference-triggered before stopped, both with the same
    // strategy.
    const context = new LLMContext();
    const userAggregator = new LLMUserAggregator(context, {
      params: new LLMUserAggregatorParams({
        userTurnStrategies: new UserTurnStrategies({
          stop: [
            new SpeechTimeoutUserTurnStopStrategy({ userSpeechTimeout: TRANSCRIPTION_TIMEOUT }),
          ],
        }),
      }),
    });

    const events: string[] = [];

    userAggregator.eventHandler("on_user_turn_inference_triggered", async (_aggregator, _s) => {
      events.push("inference_triggered");
    });

    userAggregator.eventHandler(
      "on_user_turn_stopped",
      async (_aggregator, _strategy, message: UserTurnStoppedMessage) => {
        events.push(`stopped:${message.content}`);
      },
    );

    const pipeline = new Pipeline([userAggregator]);
    const framesToSend = [
      new VADUserStartedSpeakingFrame(),
      transcription("Hi!"),
      new SleepFrame(),
      new VADUserStoppedSpeakingFrame(),
      new SleepFrame({ sleep: TRANSCRIPTION_TIMEOUT + 0.1 }),
    ];
    await runTest(pipeline, { framesToSend });

    expect(events).toEqual(["inference_triggered", "stopped:Hi!"]);
  });

  // `LLMUserAggregatorParams(filter_incomplete_user_turns=...)` is deprecated
  // upstream and not ported.
  test.skip("test_filter_incomplete_user_turns_emits_deprecation_warning", () => {});

  // `LLMUserAggregatorParams(filter_incomplete_user_turns=...)` is deprecated
  // upstream and not ported.
  test.skip("test_filter_incomplete_user_turns_installs_strategy", () => {});

  test("test_llm_completion_strategy_configures_inactive_llms", async () => {
    // The startup settings update reaches every LLM behind a switcher.
    //
    // The strategy configures the LLM once, at startup, and then waits on the
    // completion frame from whichever LLM is active. An LLM that missed the
    // update would emit no markers, leaving user turns to the stop timeout.
    const userAggregator = new LLMUserAggregator(new LLMContext(), {
      params: new LLMUserAggregatorParams({
        userTurnStrategies: new UserTurnStrategies({
          stop: [
            deferred(
              new SpeechTimeoutUserTurnStopStrategy({ userSpeechTimeout: TRANSCRIPTION_TIMEOUT }),
            ),
            new LLMTurnCompletionUserTurnStopStrategy(),
          ],
        }),
      }),
    });

    const [receivedDown] = await runTest(userAggregator, { framesToSend: [] });

    const updates = receivedDown.filter(
      (f) => f instanceof LLMUpdateSettingsFrame,
    ) as LLMUpdateSettingsFrame[];
    expect(updates.length).toEqual(1);
    expect(updates[0]!.reachInactiveServices).toBe(true);
  });

  test("test_llm_completion_strategy_finalizes_on_complete_marker", async () => {
    // LLMTurnCompletionUserTurnStopStrategy finalizes only on
    // UserTurnInferenceCompletedFrame(complete).
    const gating = new LLMTurnCompletionUserTurnStopStrategy();
    const upstream = deferred(
      new SpeechTimeoutUserTurnStopStrategy({ userSpeechTimeout: TRANSCRIPTION_TIMEOUT }),
    );
    const context = new LLMContext();
    const userAggregator = new LLMUserAggregator(context, {
      params: new LLMUserAggregatorParams({
        userTurnStrategies: new UserTurnStrategies({ stop: [upstream, gating] }),
      }),
    });

    const events: string[] = [];

    userAggregator.eventHandler("on_user_turn_inference_triggered", async (_aggregator, _s) => {
      events.push("inference_triggered");
    });

    userAggregator.eventHandler("on_user_turn_stopped", async (_aggregator, _s, _message) => {
      events.push("stopped");
    });

    const pipeline = new Pipeline([userAggregator]);

    // Drive the pipeline. Inference fires after the upstream strategy's timeout.
    // Stop fires only when UserTurnInferenceCompletedFrame arrives (producer
    // absence == "not yet complete").
    const framesToSend = [
      new VADUserStartedSpeakingFrame(),
      transcription("Hi"),
      new SleepFrame(),
      new VADUserStoppedSpeakingFrame(),
      new SleepFrame({ sleep: TRANSCRIPTION_TIMEOUT + 0.1 }),
      // At this point inference_triggered should have fired but NOT stopped.
      new UserTurnInferenceCompletedFrame(),
      new SleepFrame(),
    ];
    await runTest(pipeline, { framesToSend });

    expect(events).toEqual(["inference_triggered", "stopped"]);
  });

  test("test_multiple_inferences_in_one_turn_preserve_aggregation", async () => {
    // Two inference triggers before finalization should preserve the full user
    // transcript.
    //
    // When the LLM marks the first inference incomplete (◐ / ○) and the user
    // keeps speaking, the deferred upstream strategy fires a second inference.
    // Both the public `on_user_turn_stopped` event and the conversation context
    // should reflect the full user utterance, not just the segment from the last
    // inference.
    const gating = new LLMTurnCompletionUserTurnStopStrategy();
    const upstream = deferred(
      new SpeechTimeoutUserTurnStopStrategy({ userSpeechTimeout: TRANSCRIPTION_TIMEOUT }),
    );
    const context = new LLMContext();
    const userAggregator = new LLMUserAggregator(context, {
      params: new LLMUserAggregatorParams({
        userTurnStrategies: new UserTurnStrategies({ stop: [upstream, gating] }),
      }),
    });

    let inferenceCount = 0;
    let stopMessage: UserTurnStoppedMessage | null = null;

    userAggregator.eventHandler("on_user_turn_inference_triggered", async (_aggregator, _s) => {
      inferenceCount += 1;
    });

    userAggregator.eventHandler(
      "on_user_turn_stopped",
      async (_aggregator, _strategy, message: UserTurnStoppedMessage) => {
        stopMessage = message;
      },
    );

    const pipeline = new Pipeline([userAggregator]);

    const framesToSend = [
      new VADUserStartedSpeakingFrame(),
      transcription("I'm thinking"),
      new SleepFrame(),
      new VADUserStoppedSpeakingFrame(),
      new SleepFrame({ sleep: TRANSCRIPTION_TIMEOUT + 0.1 }),
      // First inference fired here. Imagine the LLM returned ◐; the turn is not
      // yet finalized, so the user keeps talking.
      new VADUserStartedSpeakingFrame(),
      transcription("about pizza"),
      new SleepFrame(),
      new VADUserStoppedSpeakingFrame(),
      new SleepFrame({ sleep: TRANSCRIPTION_TIMEOUT + 0.1 }),
      // Second inference fired here. Now the LLM returns ● and the turn
      // finalizes via UserTurnInferenceCompletedFrame.
      new UserTurnInferenceCompletedFrame(),
      new SleepFrame(),
    ];
    await runTest(pipeline, { framesToSend });

    expect(inferenceCount).toEqual(2);
    expect(stopMessage).not.toBeNull();
    // The public event should report the full transcript, even though each
    // inference push only writes its own segment to the context.
    expect(stopMessage!.content).toEqual("I'm thinking about pizza");

    const userMessages = context.getMessages().filter((m) => (m as Msg).role === "user");
    expect(userMessages.map((m) => (m as Msg).content)).toEqual(["I'm thinking", "about pizza"]);
  });

  test("test_user_backchannel", async () => {
    const context = new LLMContext();
    const aggregator = new LLMUserAggregator(context);
    const messages: UserBackchannelMessage[] = [];

    aggregator.eventHandler(
      "on_user_backchannel",
      async (_aggregator, message: UserBackchannelMessage) => {
        messages.push(message);
      },
    );

    await runTest(aggregator, {
      framesToSend: [new UserBackchannelFrame({ text: "mhm", userId: "user", timestamp: "now" })],
      expectedDownFrames: [SpeechControlParamsFrame, UserBackchannelFrame],
    });

    expect(messages).toEqual([
      new UserBackchannelMessage({ content: "mhm", timestamp: "now", userId: "user" }),
    ]);
    expect(context.messages).toEqual([]);
  });

  test("test_user_backchannel_is_suppressed_while_the_user_is_muted", async () => {
    const userAggregator = new LLMUserAggregator(new LLMContext(), {
      params: new LLMUserAggregatorParams({
        userMuteStrategies: [new FirstSpeechUserMuteStrategy()],
      }),
    });
    const messages: UserBackchannelMessage[] = [];

    userAggregator.eventHandler(
      "on_user_backchannel",
      async (_aggregator, message: UserBackchannelMessage) => {
        messages.push(message);
      },
    );

    const [receivedDown] = await runTest(userAggregator, {
      framesToSend: [
        // Bot is speaking, so the user is muted.
        new BotStartedSpeakingFrame(),
        new SleepFrame(),
        new UserBackchannelFrame({ text: "mhm", userId: "user", timestamp: "now" }),
      ],
      expectedDownFrames: null,
    });

    expect(receivedDown.some((f) => f instanceof UserBackchannelFrame)).toBe(false);
    expect(messages).toEqual([]);
  });
});

function makeTextFrame(text: string, includesSpaces = true): TextFrame {
  const frame = new TextFrame({ text });
  frame.includesInterFrameSpaces = includesSpaces;
  return frame;
}

function trackTurns(aggregator: LLMAssistantAggregator): {
  startCount: () => number;
  stopMessages: AssistantTurnStoppedMessage[];
} {
  let startCount = 0;
  const stopMessages: AssistantTurnStoppedMessage[] = [];
  aggregator.eventHandler("on_assistant_turn_started", async (_aggregator) => {
    startCount += 1;
  });
  aggregator.eventHandler(
    "on_assistant_turn_stopped",
    async (_aggregator, message: AssistantTurnStoppedMessage) => {
      stopMessages.push(message);
    },
  );
  return { startCount: () => startCount, stopMessages };
}

function inProgress(
  options: Partial<ConstructorParameters<typeof FunctionCallInProgressFrame>[0]> = {},
): FunctionCallInProgressFrame {
  return new FunctionCallInProgressFrame({
    functionName: "lookup",
    toolCallId: "1",
    arguments: {},
    cancelOnInterruption: false,
    ...options,
  });
}

function lookupResult(
  options: Partial<ConstructorParameters<typeof FunctionCallResultFrame>[0]> = {},
): FunctionCallResultFrame {
  return new FunctionCallResultFrame({
    functionName: "lookup",
    toolCallId: "1",
    arguments: {},
    result: { answer: 42 },
    runLlm: false,
    ...options,
  });
}

function parseAll(context: LLMContext) {
  return context.messages.map((m) => asyncToolMessages.parseMessage(m as Msg));
}

describe("TestLLMAssistantAggregator", () => {
  test("test_empty", async () => {
    const context = new LLMContext();

    const aggregator = new LLMAssistantAggregator(context);

    const { startCount, stopMessages } = trackTurns(aggregator);

    const framesToSend = [new LLMFullResponseStartFrame(), new LLMFullResponseEndFrame()];
    await runTest(aggregator, { framesToSend });
    expect(startCount() > 0).toBe(true);
    expect(stopMessages.length > 0).toBe(true);
    const stopMessage = stopMessages.at(-1)!;
    expect(stopMessage).not.toBeNull();
    expect(stopMessage.interrupted).toBe(false);
    expect(stopMessage.content).toEqual("");
  });

  test("test_simple", async () => {
    const context = new LLMContext();

    const aggregator = new LLMAssistantAggregator(context);

    const { startCount, stopMessages } = trackTurns(aggregator);

    const framesToSend = [
      new LLMFullResponseStartFrame(),
      new LLMTextFrame({ text: "Hello from Pipecat!" }),
      new LLMFullResponseEndFrame(),
    ];
    const expectedDownFrames = [
      LLMContextFrame,
      LLMContextAssistantTimestampFrame,
      LLMContextAssistantTurnFrame,
    ];
    await runTest(aggregator, { framesToSend, expectedDownFrames });
    expect(startCount() > 0).toBe(true);
    expect(stopMessages.length > 0).toBe(true);
    expect(stopMessages.at(-1)!.interrupted).toBe(false);
    expect(stopMessages.at(-1)!.content).toEqual("Hello from Pipecat!");
  });

  test("test_multiple", async () => {
    const context = new LLMContext();

    const aggregator = new LLMAssistantAggregator(context);

    const { startCount, stopMessages } = trackTurns(aggregator);

    const framesToSend = [
      new LLMFullResponseStartFrame(),
      new LLMTextFrame({ text: "Hello " }),
      new LLMTextFrame({ text: "from " }),
      new LLMTextFrame({ text: "Pipecat!" }),
      new LLMFullResponseEndFrame(),
    ];
    const expectedDownFrames = [
      LLMContextFrame,
      LLMContextAssistantTimestampFrame,
      LLMContextAssistantTurnFrame,
    ];
    await runTest(aggregator, { framesToSend, expectedDownFrames });
    expect(startCount() > 0).toBe(true);
    expect(stopMessages.length > 0).toBe(true);
    expect(stopMessages.at(-1)!.interrupted).toBe(false);
    expect(stopMessages.at(-1)!.content).toEqual("Hello from Pipecat!");
  });

  test("test_multiple_text_with_spaces", async () => {
    const context = new LLMContext();
    const aggregator = new LLMAssistantAggregator(context);

    const framesToSend = [
      new LLMFullResponseStartFrame(),
      makeTextFrame("Hello "),
      makeTextFrame("Pipecat. "),
      makeTextFrame("How are "),
      makeTextFrame("you?"),
      new LLMFullResponseEndFrame(),
    ];
    const expectedDownFrames = [
      LLMContextFrame,
      LLMContextAssistantTimestampFrame,
      LLMContextAssistantTurnFrame,
    ];
    await runTest(aggregator, { framesToSend, expectedDownFrames });
    expect((context.messages[0] as Msg).content).toEqual("Hello Pipecat. How are you?");
  });

  test("test_multiple_text_stripped", async () => {
    const context = new LLMContext();
    const aggregator = new LLMAssistantAggregator(context);
    const framesToSend = [
      new LLMFullResponseStartFrame(),
      new TextFrame({ text: "Hello" }),
      new TextFrame({ text: "Pipecat." }),
      new TextFrame({ text: "How are" }),
      new TextFrame({ text: "you?" }),
      new LLMFullResponseEndFrame(),
    ];
    const expectedDownFrames = [
      LLMContextFrame,
      LLMContextAssistantTimestampFrame,
      LLMContextAssistantTurnFrame,
    ];
    await runTest(aggregator, { framesToSend, expectedDownFrames });
    expect((context.messages[0] as Msg).content).toEqual("Hello Pipecat. How are you?");
  });

  test("test_multiple_text_mixed_spaces", async () => {
    const context = new LLMContext();
    const aggregator = new LLMAssistantAggregator(context);

    const framesToSend = [
      new LLMFullResponseStartFrame(),
      makeTextFrame("Hello ", true),
      makeTextFrame("Pipecat. ", true),
      makeTextFrame("Here's some", true),
      // Validates ending includes_inter_frame_spaces run with no space
      makeTextFrame(" code:", true),
      makeTextFrame("```python\nprint('Hello, World!')\n```", false),
      makeTextFrame("```javascript\nconsole.log('Hello, World!');\n```", false),
      // Validates starting includes_inter_frame_spaces run with a space and ending it with no space
      makeTextFrame(" And some more: ", true),
      makeTextFrame("```html\n<div>Hello, World!</div>\n```", false),
      // Validates starting includes_inter_frame_spaces run with no space
      makeTextFrame("Hope that ", true),
      makeTextFrame("helps!", true),
      new LLMFullResponseEndFrame(),
    ];
    const expectedDownFrames = [
      LLMContextFrame,
      LLMContextAssistantTimestampFrame,
      LLMContextAssistantTurnFrame,
    ];
    await runTest(aggregator, { framesToSend, expectedDownFrames });
    expect((context.messages[0] as Msg).content).toEqual(
      "Hello Pipecat. Here's some code: " +
        "```python\nprint('Hello, World!')\n``` " +
        "```javascript\nconsole.log('Hello, World!');\n``` " +
        "And some more: " +
        "```html\n<div>Hello, World!</div>\n``` " +
        "Hope that helps!",
    );
  });

  test("test_multiple_responses", async () => {
    const context = new LLMContext();
    const aggregator = new LLMAssistantAggregator(context);

    const framesToSend = [
      new LLMFullResponseStartFrame(),
      makeTextFrame("Hello "),
      makeTextFrame("Pipecat."),
      new LLMFullResponseEndFrame(),
      new LLMFullResponseStartFrame(),
      makeTextFrame("How are "),
      makeTextFrame("you?"),
      new LLMFullResponseEndFrame(),
    ];
    const expectedDownFrames = [
      LLMContextFrame,
      LLMContextAssistantTimestampFrame,
      LLMContextAssistantTurnFrame,
      LLMContextFrame,
      LLMContextAssistantTimestampFrame,
      LLMContextAssistantTurnFrame,
    ];
    await runTest(aggregator, { framesToSend, expectedDownFrames });
    expect((context.messages[0] as Msg).content).toEqual("Hello Pipecat.");
    expect((context.messages[1] as Msg).content).toEqual("How are you?");
  });

  test("test_multiple_responses_interruption", async () => {
    const context = new LLMContext();
    const aggregator = new LLMAssistantAggregator(context);

    const framesToSend = [
      new LLMFullResponseStartFrame(),
      makeTextFrame("Hello "),
      makeTextFrame("Pipecat."),
      new LLMFullResponseEndFrame(),
      new SleepFrame({ sleep: 0.15 }),
      new InterruptionFrame(),
      new LLMFullResponseStartFrame(),
      makeTextFrame("How are "),
      makeTextFrame("you?"),
      new LLMFullResponseEndFrame(),
    ];
    const expectedDownFrames = [
      LLMContextFrame,
      LLMContextAssistantTimestampFrame,
      LLMContextAssistantTurnFrame,
      InterruptionFrame,
      LLMContextFrame,
      LLMContextAssistantTimestampFrame,
      LLMContextAssistantTurnFrame,
    ];
    await runTest(aggregator, { framesToSend, expectedDownFrames });
    expect((context.messages[0] as Msg).content).toEqual("Hello Pipecat.");
    expect((context.messages[1] as Msg).content).toEqual("How are you?");
  });

  test("test_interruption", async () => {
    const context = new LLMContext();

    const aggregator = new LLMAssistantAggregator(context);

    const { startCount, stopMessages } = trackTurns(aggregator);

    const framesToSend = [
      new LLMFullResponseStartFrame(),
      new LLMTextFrame({ text: "Hello " }),
      new SleepFrame(),
      new InterruptionFrame(),
      new LLMFullResponseStartFrame(),
      new LLMTextFrame({ text: "Hello " }),
      new LLMTextFrame({ text: "there!" }),
      new LLMFullResponseEndFrame(),
    ];
    const expectedDownFrames = [
      LLMContextFrame,
      LLMContextAssistantTimestampFrame,
      LLMContextAssistantTurnFrame,
      InterruptionFrame,
      LLMContextFrame,
      LLMContextAssistantTimestampFrame,
      LLMContextAssistantTurnFrame,
    ];
    await runTest(aggregator, { framesToSend, expectedDownFrames });
    expect(startCount()).toEqual(2);
    expect(stopMessages.length).toEqual(2);
    expect(stopMessages[0]!.interrupted).toBe(true);
    expect(stopMessages[0]!.content).toEqual("Hello");
    expect(stopMessages[1]!.interrupted).toBe(false);
    expect(stopMessages[1]!.content).toEqual("Hello there!");
  });

  test("test_function_call", async () => {
    const context = new LLMContext();
    const aggregator = new LLMAssistantAggregator(context);
    const framesToSend = [
      new FunctionCallInProgressFrame({
        functionName: "get_weather",
        toolCallId: "1",
        arguments: { location: "Los Angeles" },
        cancelOnInterruption: true,
      }),
      new SleepFrame(),
      new FunctionCallResultFrame({
        functionName: "get_weather",
        toolCallId: "1",
        arguments: { location: "Los Angeles" },
        result: { conditions: "Sunny" },
      }),
    ];
    await runTest(aggregator, { framesToSend, expectedDownFrames: [] });
    expect(JSON.parse((context.messages.at(-1) as Msg).content)).toEqual({ conditions: "Sunny" });
  });

  test("test_function_call_cancel", async () => {
    const context = new LLMContext();
    const aggregator = new LLMAssistantAggregator(context);
    const framesToSend = [
      new FunctionCallInProgressFrame({
        functionName: "get_weather",
        toolCallId: "1",
        arguments: { location: "Los Angeles" },
        cancelOnInterruption: true,
      }),
      new SleepFrame(),
      new FunctionCallCancelFrame({ functionName: "get_weather", toolCallId: "1" }),
    ];
    await runTest(aggregator, { framesToSend, expectedDownFrames: [] });
    expect((context.messages.at(-1) as Msg).content).toEqual("CANCELLED");
    expect(aggregator.hasFunctionCallsInProgress).toBe(false);
  });

  test("test_fast_async_function_call_settles_in_place", async () => {
    // An async call whose result lands before anything else settles like a sync
    // one.
    const context = new LLMContext();
    const aggregator = new LLMAssistantAggregator(context);
    const framesToSend = [
      new FunctionCallInProgressFrame({
        functionName: "book_table",
        toolCallId: "1",
        arguments: { size: 2 },
        cancelOnInterruption: false,
      }),
      new SleepFrame(),
      new FunctionCallResultFrame({
        functionName: "book_table",
        toolCallId: "1",
        arguments: { size: 2 },
        result: { status: "booked" },
        runLlm: false,
      }),
    ];
    await runTest(aggregator, { framesToSend, expectedDownFrames: [] });
    const toolMessages = context.messages.filter((m) => (m as Msg).role === "tool") as Msg[];
    expect(toolMessages.length).toEqual(1);
    expect(toolMessages[0].tool_call_id).toEqual("1");
    expect(toolMessages[0].content).toEqual('{"status": "booked"}');
    expect(parseAll(context).every((p) => p === null)).toBe(true);
    expect(aggregator.hasFunctionCallsInProgress).toBe(false);
  });

  test("test_parallel_fast_async_function_calls_settle_in_place", async () => {
    // Sibling placeholders and results are protocol bookkeeping, not the
    // conversation moving on.
    const context = new LLMContext();
    const aggregator = new LLMAssistantAggregator(context);

    const start = (toolCallId: string) =>
      new FunctionCallInProgressFrame({
        functionName: "lookup",
        toolCallId,
        arguments: {},
        cancelOnInterruption: false,
        groupId: "batch",
      });

    const result = (toolCallId: string) =>
      new FunctionCallResultFrame({
        functionName: "lookup",
        toolCallId,
        arguments: {},
        result: { answer: toolCallId },
        runLlm: false,
      });

    const framesToSend = [
      start("1"),
      start("2"),
      new SleepFrame(),
      result("1"),
      new SleepFrame(),
      result("2"),
    ];
    await runTest(aggregator, { framesToSend, expectedDownFrames: [] });
    const toolMessages = context.messages.filter((m) => (m as Msg).role === "tool") as Msg[];
    expect(toolMessages.map((m) => m.content)).toEqual(['{"answer": "1"}', '{"answer": "2"}']);
    expect(parseAll(context).every((p) => p === null)).toBe(true);
  });

  test("test_result_during_model_response_settles_in_place", async () => {
    // A response in flight has left nothing in the context yet, so the context
    // cannot see it.
    const context = new LLMContext();
    const aggregator = new LLMAssistantAggregator(context);
    const framesToSend = [
      inProgress(),
      new SleepFrame(),
      new LLMFullResponseStartFrame(),
      new SleepFrame(),
      lookupResult(),
      new SleepFrame(),
      new LLMFullResponseEndFrame(),
    ];
    await runTest(aggregator, { framesToSend });
    const toolMessages = context.messages.filter((m) => (m as Msg).role === "tool") as Msg[];
    expect(toolMessages[0].content).toEqual('{"answer": 42}');
    expect(parseAll(context).every((p) => p === null)).toBe(true);
  });

  test("test_async_function_call_after_spoken_filler_settles_in_place", async () => {
    // Filler spoken with a TTSSpeakFrame while the call runs does not defer it.
    const context = new LLMContext();
    const aggregator = new LLMAssistantAggregator(context);
    const framesToSend = [
      inProgress(),
      new SleepFrame(),
      new TTSStartedFrame({ appendToContext: true }),
      new TTSTextFrame({ text: "Let me check on that.", textType: TextType.SENTENCE }),
      new LLMAssistantPushAggregationFrame(),
      new SleepFrame(),
      lookupResult(),
    ];
    await runTest(aggregator, { framesToSend });
    const toolMessages = context.messages.filter((m) => (m as Msg).role === "tool") as Msg[];
    expect(toolMessages[0].content).toEqual('{"answer": 42}');
    expect(parseAll(context).every((p) => p === null)).toBe(true);
    expect(context.messages.at(-1)).toEqual({
      role: "assistant",
      content: "Let me check on that.",
    } as Msg);
  });

  test("test_async_function_call_after_user_message_is_deferred", async () => {
    const context = new LLMContext();
    const aggregator = new LLMAssistantAggregator(context);
    const framesToSend = [
      inProgress(),
      new SleepFrame(),
      new LLMMessagesAppendFrame({ messages: [{ role: "user", content: "Any news?" }] }),
      new SleepFrame(),
      lookupResult(),
    ];
    await runTest(aggregator, { framesToSend, expectedDownFrames: [] });
    const payload = asyncToolMessages.parseMessage(context.messages.at(-1) as Msg);
    expect(payload !== null && payload.kind === "final").toBe(true);
    expect(payload!.toolCallId).toEqual("1");
  });

  test("test_async_function_call_after_model_response_settles_in_place", async () => {
    // Assistant text with no user turn since the placeholder does not defer the
    // call.
    const context = new LLMContext();
    const aggregator = new LLMAssistantAggregator(context);
    const framesToSend = [
      inProgress(),
      new SleepFrame(),
      new LLMFullResponseStartFrame(),
      new LLMTextFrame({ text: "Still looking." }),
      new LLMFullResponseEndFrame(),
      new SleepFrame(),
      lookupResult(),
    ];
    await runTest(aggregator, { framesToSend });
    const toolMessages = context.messages.filter((m) => (m as Msg).role === "tool") as Msg[];
    expect(toolMessages[0].content).toEqual('{"answer": 42}');
    expect(parseAll(context).every((p) => p === null)).toBe(true);
  });

  test("test_async_function_call_after_developer_message_is_deferred", async () => {
    const context = new LLMContext();
    const aggregator = new LLMAssistantAggregator(context);
    const framesToSend = [
      inProgress(),
      new SleepFrame(),
      new LLMMessagesAppendFrame({
        messages: [{ role: "developer", content: "Now help with billing." } as Msg],
      }),
      new SleepFrame(),
      lookupResult(),
    ];
    await runTest(aggregator, { framesToSend, expectedDownFrames: [] });
    const payload = asyncToolMessages.parseMessage(context.messages.at(-1) as Msg);
    expect(payload !== null && payload.kind === "final").toBe(true);
  });

  test("test_async_function_call_after_context_rebuild_is_deferred", async () => {
    // A placeholder the context no longer holds cannot take the result in place.
    const context = new LLMContext();
    const aggregator = new LLMAssistantAggregator(context);
    const framesToSend = [
      inProgress(),
      new SleepFrame(),
      new LLMMessagesUpdateFrame({
        messages: [{ role: "developer", content: "Fresh start." } as Msg],
      }),
      new SleepFrame(),
      lookupResult(),
    ];
    await runTest(aggregator, { framesToSend, expectedDownFrames: [] });
    const payload = asyncToolMessages.parseMessage(context.messages.at(-1) as Msg);
    expect(payload !== null && payload.kind === "final").toBe(true);
    expect(payload!.toolCallId).toEqual("1");
  });

  test("test_intermediate_update_keeps_the_call_deferred", async () => {
    const context = new LLMContext();
    const aggregator = new LLMAssistantAggregator(context);
    const framesToSend = [
      inProgress(),
      new SleepFrame(),
      lookupResult({
        result: { progress: "halfway" },
        properties: new FunctionCallResultProperties({ isFinal: false }),
      }),
      new SleepFrame(),
      lookupResult(),
    ];
    await runTest(aggregator, { framesToSend, expectedDownFrames: [] });
    const kinds = parseAll(context)
      .filter((p) => p)
      .map((p) => p!.kind);
    expect(kinds).toEqual(["started", "intermediate", "final"]);
  });

  test("test_async_function_call_cancel", async () => {
    // A cancelled async call settles on the same channel its results use.
    const context = new LLMContext();
    const aggregator = new LLMAssistantAggregator(context);
    const framesToSend = [
      new FunctionCallInProgressFrame({
        functionName: "get_weather",
        toolCallId: "1",
        arguments: { location: "Los Angeles" },
        cancelOnInterruption: false,
      }),
      new SleepFrame(),
      new FunctionCallCancelFrame({ functionName: "get_weather", toolCallId: "1" }),
    ];
    await runTest(aggregator, { framesToSend, expectedDownFrames: [] });
    const payload = asyncToolMessages.parseMessage(context.messages.at(-1) as Msg);
    expect(payload).not.toBeNull();
    expect(payload!.kind).toEqual("final");
    expect(payload!.toolCallId).toEqual("1");
    expect(payload!.result!.startsWith("CANCELLED")).toBe(true);
    expect(aggregator.hasFunctionCallsInProgress).toBe(false);
  });

  test("test_run_survives_a_later_result_that_does_not_ask_to_run", async () => {
    // A burst runs inference once, even when its last result doesn't ask for it.
    const context = new LLMContext();
    const aggregator = new LLMAssistantAggregator(context);
    const framesToSend = [
      inProgress(),
      new SleepFrame(),
      // Queued together, so the first result's push is held for the second.
      new FunctionCallResultFrame({
        functionName: "lookup",
        toolCallId: "1",
        arguments: {},
        result: { progress: "on it" },
        properties: new FunctionCallResultProperties({ isFinal: false, runLlm: true }),
      }),
      new FunctionCallResultFrame({
        functionName: "lookup",
        toolCallId: "1",
        arguments: {},
        result: { progress: "still on it" },
        properties: new FunctionCallResultProperties({ isFinal: false, runLlm: false }),
      }),
    ];
    await runTest(aggregator, {
      framesToSend,
      expectedDownFrames: [],
      expectedUpFrames: [LLMContextFrame],
    });
  });

  test("test_an_append_asking_to_run_waits_for_the_bot_to_stop_speaking", async () => {
    // Run mid-sentence, the model would answer a context that lacks its answer
    // in progress.
    const context = new LLMContext();
    let aggregator = new LLMAssistantAggregator(context);
    const message = { role: "developer", content: "Backend: It's 62 and raining." } as Msg;
    await runTest(aggregator, {
      framesToSend: [
        new BotStartedSpeakingFrame(),
        new LLMMessagesAppendFrame({ messages: [message], runLlm: true }),
        new SleepFrame(),
      ],
      expectedDownFrames: [BotStartedSpeakingFrame],
      expectedUpFrames: [],
    });
    expect(context.getMessages()).toEqual([message]);

    aggregator = new LLMAssistantAggregator(new LLMContext());
    await runTest(aggregator, {
      framesToSend: [
        new BotStartedSpeakingFrame(),
        new LLMMessagesAppendFrame({ messages: [message], runLlm: true }),
        new SleepFrame(),
        new BotStoppedSpeakingFrame(),
      ],
      expectedDownFrames: [BotStartedSpeakingFrame, BotStoppedSpeakingFrame],
      expectedUpFrames: [LLMContextFrame],
    });
  });

  test("test_an_append_asking_to_run_while_the_user_speaks_is_settled_by_the_turns_run", async () => {
    // The run the user's turn brings sees the context as it stands, so nothing
    // is owed after it.
    const context = new LLMContext();
    const aggregator = new LLMAssistantAggregator(context);
    await runTest(aggregator, {
      framesToSend: [
        new UserStartedSpeakingFrame(),
        new LLMMessagesAppendFrame({
          messages: [{ role: "developer", content: "Backend: Done." } as Msg],
          runLlm: true,
        }),
        new SleepFrame(),
        new UserStoppedSpeakingFrame(),
        new LLMFullResponseStartFrame(),
        new LLMFullResponseEndFrame(),
        new LLMMessagesAppendFrame({
          messages: [{ role: "developer", content: "Backend (thinking): ..." } as Msg],
          runLlm: false,
        }),
        new SleepFrame(),
      ],
      // An empty response is not passed on; what matters is that no context
      // frame goes upstream after the run has started.
      expectedDownFrames: [UserStartedSpeakingFrame, UserStoppedSpeakingFrame],
      expectedUpFrames: [],
    });
    expect(context.getMessages().length).toEqual(2);
  });

  test("test_an_append_owed_through_an_empty_user_turn_is_pushed_on_the_next_arrival", async () => {
    // A turn with nothing in it brings no run, so the push is still owed.
    const context = new LLMContext();
    const aggregator = new LLMAssistantAggregator(context);
    await runTest(aggregator, {
      framesToSend: [
        new UserStartedSpeakingFrame(),
        new LLMMessagesAppendFrame({
          messages: [{ role: "developer", content: "Backend: Done." } as Msg],
          runLlm: true,
        }),
        new SleepFrame(),
        new UserStoppedSpeakingFrame(),
        new LLMMessagesAppendFrame({
          messages: [{ role: "developer", content: "Backend (thinking): ..." } as Msg],
          runLlm: false,
        }),
        new SleepFrame(),
      ],
      expectedDownFrames: [UserStartedSpeakingFrame, UserStoppedSpeakingFrame],
      expectedUpFrames: [LLMContextFrame],
    });
    expect(context.getMessages().length).toEqual(2);
  });

  // DIVERGENCE: scheduling, not behavior. Upstream, `await queue_frame()` and
  // `await queue.get()` on a non-empty queue do not suspend, so the three
  // appends travel the pipeline as one batch and the aggregator sees the later
  // ones queued (`hasQueuedFrame(LLMMessagesAppendFrame)`) when it handles the
  // first. Under the JS microtask emulation (@pipedog/asyncio) every await is
  // at least one microtick, so the frames arrive as a pipelined stream and each
  // append is handled with nothing queued behind it: the first two each push a
  // context frame. Same code path as upstream (`_maybePushContext`); only the
  // interleaving differs.
  test.skip("test_appends_queued_together_run_inference_once", async () => {
    // A burst of messages is one run, whatever the last one asks.
    const aggregator = new LLMAssistantAggregator(new LLMContext());
    await runTest(aggregator, {
      framesToSend: [
        new SleepFrame(),
        new LLMMessagesAppendFrame({
          messages: [{ role: "developer", content: "Backend: One." } as Msg],
          runLlm: true,
        }),
        new LLMMessagesAppendFrame({
          messages: [{ role: "developer", content: "Backend: Two." } as Msg],
          runLlm: true,
        }),
        new LLMMessagesAppendFrame({
          messages: [{ role: "developer", content: "Backend (thinking): Three." } as Msg],
          runLlm: false,
        }),
      ],
      expectedDownFrames: [],
      expectedUpFrames: [LLMContextFrame],
    });
  });

  test("test_function_call_cancel_run_llm", async () => {
    // A cancellation asking for inference pushes the context upstream.
    const context = new LLMContext();
    const aggregator = new LLMAssistantAggregator(context);
    const framesToSend = [
      new FunctionCallInProgressFrame({
        functionName: "get_weather",
        toolCallId: "1",
        arguments: { location: "Los Angeles" },
        cancelOnInterruption: false,
      }),
      new SleepFrame(),
      new FunctionCallCancelFrame({ functionName: "get_weather", toolCallId: "1", runLlm: true }),
    ];
    await runTest(aggregator, {
      framesToSend,
      expectedDownFrames: [],
      expectedUpFrames: [LLMContextFrame],
    });
  });

  test("test_function_call_cancel_run_llm_while_user_speaking", async () => {
    // Inference waits for the user to finish rather than talking over them.
    const context = new LLMContext();
    const aggregator = new LLMAssistantAggregator(context);
    const framesToSend = [
      new FunctionCallInProgressFrame({
        functionName: "get_weather",
        toolCallId: "1",
        arguments: { location: "Los Angeles" },
        cancelOnInterruption: false,
      }),
      new UserStartedSpeakingFrame(),
      new SleepFrame(),
      new FunctionCallCancelFrame({ functionName: "get_weather", toolCallId: "1", runLlm: true }),
    ];
    await runTest(aggregator, {
      framesToSend,
      expectedDownFrames: [UserStartedSpeakingFrame],
      expectedUpFrames: [],
    });
  });

  test("test_function_call_cancel_run_llm_waits_for_group", async () => {
    // Inference runs once, on whichever call in the group settles last.
    const context = new LLMContext();
    const aggregator = new LLMAssistantAggregator(context);
    const framesToSend = [
      new FunctionCallInProgressFrame({
        functionName: "get_weather",
        toolCallId: "1",
        arguments: { location: "Los Angeles" },
        cancelOnInterruption: false,
        groupId: "group-1",
      }),
      new FunctionCallInProgressFrame({
        functionName: "get_restaurant",
        toolCallId: "2",
        arguments: { location: "Los Angeles" },
        cancelOnInterruption: true,
        groupId: "group-1",
      }),
      new SleepFrame(),
      // The first call times out while its sibling is still running, so it
      // settles in the context without triggering inference.
      new FunctionCallCancelFrame({ functionName: "get_weather", toolCallId: "1", runLlm: true }),
      new SleepFrame(),
      new FunctionCallResultFrame({
        functionName: "get_restaurant",
        toolCallId: "2",
        arguments: { location: "Los Angeles" },
        result: { name: "Pasta Place" },
      }),
    ];
    await runTest(aggregator, {
      framesToSend,
      expectedDownFrames: [],
      expectedUpFrames: [LLMContextFrame],
    });
    expect(aggregator.hasFunctionCallsInProgress).toBe(false);
  });

  test("test_function_call_on_context_updated", async () => {
    let contextUpdated = false;

    const onContextUpdated = async () => {
      contextUpdated = true;
    };

    const context = new LLMContext();
    const aggregator = new LLMAssistantAggregator(context);
    const framesToSend = [
      new FunctionCallInProgressFrame({
        functionName: "get_weather",
        toolCallId: "1",
        arguments: { location: "Los Angeles" },
        cancelOnInterruption: true,
      }),
      new SleepFrame(),
      new FunctionCallResultFrame({
        functionName: "get_weather",
        toolCallId: "1",
        arguments: { location: "Los Angeles" },
        result: { conditions: "Sunny" },
        properties: new FunctionCallResultProperties({ onContextUpdated }),
      }),
      new SleepFrame(),
    ];
    await runTest(aggregator, { framesToSend, expectedDownFrames: [] });
    expect(JSON.parse((context.messages.at(-1) as Msg).content)).toEqual({ conditions: "Sunny" });
    expect(contextUpdated).toBe(true);
  });

  test("test_thought", async () => {
    const context = new LLMContext();

    const aggregator = new LLMAssistantAggregator(context);

    let thoughtMessage: AssistantThoughtMessage | null = null;

    aggregator.eventHandler(
      "on_assistant_thought",
      async (_aggregator, message: AssistantThoughtMessage) => {
        thoughtMessage = message;
      },
    );

    const framesToSend = [
      new LLMFullResponseStartFrame(),
      new LLMThoughtStartFrame(),
      new LLMThoughtTextFrame({ text: "I'm thinking!" }),
      new LLMThoughtEndFrame(),
      new LLMFullResponseEndFrame(),
    ];
    await runTest(aggregator, { framesToSend });
    expect(thoughtMessage!.content).toEqual("I'm thinking!");
  });

  test("test_backchannel", async () => {
    const context = new LLMContext();
    const aggregator = new LLMAssistantAggregator(context);
    const messages: AssistantBackchannelMessage[] = [];

    aggregator.eventHandler(
      "on_assistant_backchannel",
      async (_aggregator, message: AssistantBackchannelMessage) => {
        messages.push(message);
      },
    );

    // The frames a TTS service pushes for a BotBackchannelFrame, and then for a
    // sentence of a reply.
    const backchannel = new AggregatedTextFrame({
      text: "Mm-hmm.",
      textType: TextType.BACKCHANNEL,
    });
    backchannel.willBeSpoken = true;
    backchannel.appendToContext = false;
    const spoken = new TTSTextFrame({
      text: "Mm-hmm.",
      textType: TextType.BACKCHANNEL,
      segmentId: backchannel.id,
    });
    spoken.appendToContext = false;
    const sentence = new AggregatedTextFrame({ text: "Sounds fun.", textType: TextType.SENTENCE });
    sentence.willBeSpoken = true;
    sentence.appendToContext = false;
    await runTest(aggregator, { framesToSend: [backchannel, spoken, sentence] });

    expect(messages.map((m) => m.content)).toEqual(["Mm-hmm."]);
    expect(context.messages).toEqual([]);
  });

  test("test_pending_text_emitted_on_end_frame", async () => {
    // Pending assistant text should be emitted when EndFrame arrives.
    const context = new LLMContext();

    const aggregator = new LLMAssistantAggregator(context);

    const { stopMessages } = trackTurns(aggregator);

    // Start response and send text, but don't send LLMFullResponseEndFrame
    const framesToSend = [
      new LLMFullResponseStartFrame(),
      new LLMTextFrame({ text: "Hello from Pipecat!" }),
      // No LLMFullResponseEndFrame - response doesn't end normally
      // EndFrame will be sent by run_test, triggering emission
    ];
    await runTest(aggregator, { framesToSend });

    // The pending text should be emitted on EndFrame
    expect(stopMessages.length).toEqual(1);
    expect(stopMessages[0]!.content).toEqual("Hello from Pipecat!");
  });

  test("test_tts_speak_fires_turn_started_and_stopped", async () => {
    // A TTSSpeakFrame(append_to_context=True) utterance must fire both turn
    // events.
    //
    // Mirrors the TTSSpeakFrame greeting flow with a word-timestamp TTS service:
    // a TTSStartedFrame opens the turn (no surrounding
    // LLMFullResponseStartFrame), word-level TTSTextFrames accumulate, then the
    // TTS service emits LLMAssistantPushAggregationFrame to commit them and stop
    // the turn.
    const context = new LLMContext();
    const aggregator = new LLMAssistantAggregator(context);

    const { startCount, stopMessages } = trackTurns(aggregator);

    const framesToSend = [
      new TTSStartedFrame({ appendToContext: true }),
      new TTSTextFrame({ text: "Hello,", textType: TextType.WORD }),
      new TTSTextFrame({ text: "how", textType: TextType.WORD }),
      new TTSTextFrame({ text: "can I help?", textType: TextType.WORD }),
      new LLMAssistantPushAggregationFrame(),
    ];
    const expectedDownFrames = [
      TTSStartedFrame,
      LLMContextFrame,
      LLMContextAssistantTimestampFrame,
      LLMContextAssistantTurnFrame,
    ];
    await runTest(aggregator, { framesToSend, expectedDownFrames });
    expect(startCount()).toEqual(1);
    expect(stopMessages.length).toEqual(1);
    expect(stopMessages[0]!.interrupted).toBe(false);
    expect(stopMessages[0]!.content).toEqual("Hello, how can I help?");
    expect(context.messages.at(-1)).toEqual({
      role: "assistant",
      content: "Hello, how can I help?",
    } as Msg);
  });

  test("test_tts_speak_interruption_records_partial_text", async () => {
    // Interrupting a TTSSpeakFrame utterance records the partially-spoken text.
    //
    // The TTSStartedFrame opens the turn, so a mid-utterance interruption finds
    // an open turn: the words spoken so far are written to context and
    // on_assistant_turn_stopped fires with interrupted=True. (No
    // LLMAssistantPushAggregationFrame arrives — the interruption cancels the
    // utterance before the TTS service commits it.)
    const context = new LLMContext();
    const aggregator = new LLMAssistantAggregator(context);

    const { startCount, stopMessages } = trackTurns(aggregator);

    const framesToSend = [
      new TTSStartedFrame({ appendToContext: true }),
      new TTSTextFrame({ text: "Let me", textType: TextType.WORD }),
      new TTSTextFrame({ text: "check on", textType: TextType.WORD }),
      new SleepFrame(),
      new InterruptionFrame(),
    ];
    const expectedDownFrames = [
      TTSStartedFrame,
      LLMContextFrame,
      LLMContextAssistantTimestampFrame,
      LLMContextAssistantTurnFrame,
      InterruptionFrame,
    ];
    await runTest(aggregator, { framesToSend, expectedDownFrames });
    expect(startCount()).toEqual(1);
    expect(stopMessages.length).toEqual(1);
    expect(stopMessages[0]!.interrupted).toBe(true);
    expect(stopMessages[0]!.content).toEqual("Let me check on");
    expect(context.messages.at(-1)).toEqual({
      role: "assistant",
      content: "Let me check on",
    } as Msg);
  });

  test("test_tts_started_append_to_context_false_does_not_open_turn", async () => {
    // A TTSStartedFrame(append_to_context=False) utterance must not open a turn.
    //
    // When the spoken text won't be written to context, neither
    // on_assistant_turn_started nor on_assistant_turn_stopped should fire, and a
    // following interruption must find no open turn.
    const context = new LLMContext();
    const aggregator = new LLMAssistantAggregator(context);

    const { startCount, stopMessages } = trackTurns(aggregator);

    const framesToSend = [
      new TTSStartedFrame({ appendToContext: false }),
      new TTSTextFrame({ text: "off the record", textType: TextType.WORD }),
      new SleepFrame(),
      new InterruptionFrame(),
    ];
    const expectedDownFrames = [TTSStartedFrame, InterruptionFrame];
    await runTest(aggregator, { framesToSend, expectedDownFrames });
    expect(startCount()).toEqual(0);
    expect(stopMessages.length).toEqual(0);
    expect(context.messages.length).toEqual(0);
  });

  test("test_tts_started_does_not_double_open_during_llm_response", async () => {
    // A TTSStartedFrame during an LLM response must not re-open the turn.
    //
    // LLMFullResponseStartFrame is the earlier signal and already opened the
    // turn, so the response's TTSStartedFrame is a no-op:
    // on_assistant_turn_started fires exactly once.
    const context = new LLMContext();
    const aggregator = new LLMAssistantAggregator(context);

    const { startCount, stopMessages } = trackTurns(aggregator);

    const framesToSend = [
      new LLMFullResponseStartFrame(),
      new TTSStartedFrame({ appendToContext: true }),
      new TTSTextFrame({ text: "Hello!", textType: TextType.WORD }),
      new LLMFullResponseEndFrame(),
    ];
    await runTest(aggregator, { framesToSend });
    expect(startCount()).toEqual(1);
    expect(stopMessages.length).toEqual(1);
    expect(stopMessages[0]!.content).toEqual("Hello!");
  });

  test("test_push_aggregation_does_not_double_fire_in_llm_response", async () => {
    // LLMAssistantPushAggregationFrame mid-response must not double-fire turn
    // events.
    //
    // Inside an LLMFullResponseStart/End cycle, a stray
    // LLMAssistantPushAggregationFrame should flush whatever is buffered and
    // consume the active turn (firing exactly one stopped event). The closing
    // LLMFullResponseEndFrame then has no pending turn to stop.
    const context = new LLMContext();
    const aggregator = new LLMAssistantAggregator(context);

    const { startCount, stopMessages } = trackTurns(aggregator);

    const framesToSend = [
      new LLMFullResponseStartFrame(),
      new LLMTextFrame({ text: "Hello!" }),
      new LLMAssistantPushAggregationFrame(),
      new LLMFullResponseEndFrame(),
    ];
    await runTest(aggregator, { framesToSend });
    expect(startCount()).toEqual(1);
    expect(stopMessages.length).toEqual(1);
    expect(stopMessages[0]!.content).toEqual("Hello!");
  });

  test("test_turn_completion_markers_stripped_from_transcript", async () => {
    // Turn completion markers should be stripped from assistant transcript.
    const context = new LLMContext();
    const aggregator = new LLMAssistantAggregator(context);

    const stopMessages: AssistantTurnStoppedMessage[] = [];

    aggregator.eventHandler(
      "on_assistant_turn_stopped",
      async (_aggregator, message: AssistantTurnStoppedMessage) => {
        stopMessages.push(message);
      },
    );

    // Send text with a turn completion marker
    let framesToSend: Frame[] = [
      new LLMFullResponseStartFrame(),
      new LLMTextFrame({ text: `${USER_TURN_COMPLETE_MARKER} Hello from Pipecat!` }),
      new LLMFullResponseEndFrame(),
    ];
    await runTest(aggregator, { framesToSend });

    // The marker should be stripped from the transcript
    expect(stopMessages.length).toEqual(1);
    expect(stopMessages[0]!.content).toEqual("Hello from Pipecat!");

    // Test incomplete markers are also stripped
    stopMessages.length = 0;
    const context2 = new LLMContext();
    const aggregator2 = new LLMAssistantAggregator(context2);

    aggregator2.eventHandler(
      "on_assistant_turn_stopped",
      async (_aggregator, message: AssistantTurnStoppedMessage) => {
        stopMessages.push(message);
      },
    );

    framesToSend = [
      new LLMFullResponseStartFrame(),
      new LLMTextFrame({ text: USER_TURN_INCOMPLETE_SHORT_MARKER }),
      new LLMFullResponseEndFrame(),
    ];
    await runTest(aggregator2, { framesToSend });

    // The incomplete marker should be stripped (resulting in empty content)
    expect(stopMessages.length).toEqual(1);
    expect(stopMessages[0]!.content).toEqual("");
  });

  test("test_llm_run", async () => {
    const context = new LLMContext();
    const aggregator = new LLMAssistantAggregator(context);

    await runTest(aggregator, {
      framesToSend: [new LLMRunFrame()],
      framesToSendDirection: FrameDirection.UPSTREAM,
      expectedUpFrames: [LLMContextFrame],
    });
  });

  test("test_llm_messages_append", async () => {
    const context = new LLMContext();
    const aggregator = new LLMAssistantAggregator(context);

    await runTest(aggregator, {
      framesToSend: [
        new LLMMessagesAppendFrame({ messages: [{ role: "user", content: "Hi there!" }] }),
      ],
      framesToSendDirection: FrameDirection.UPSTREAM,
      expectedUpFrames: [], // no LLMContextFrame expected, run_llm defaults to False
    });
    expect((context.messages[0] as Msg).content).toEqual("Hi there!");
  });

  test("test_llm_messages_append_run", async () => {
    const context = new LLMContext();
    const aggregator = new LLMAssistantAggregator(context);

    await runTest(aggregator, {
      framesToSend: [
        new LLMMessagesAppendFrame({
          messages: [{ role: "user", content: "Hi there!" }],
          runLlm: true,
        }),
      ],
      framesToSendDirection: FrameDirection.UPSTREAM,
      expectedUpFrames: [LLMContextFrame],
    });
    expect((context.messages[0] as Msg).content).toEqual("Hi there!");
  });

  test("test_user_file_frame_run_llm_false_does_not_run", async () => {
    const context = new LLMContext();
    const aggregator = new LLMAssistantAggregator(context);

    await runTest(aggregator, {
      framesToSend: [
        new UserFileRawFrame({
          file: "data:application/pdf;base64,abc123",
          type: "bytes",
          filename: "doc.pdf",
          format: "application/pdf",
          appendToContext: true,
          runLlm: false,
        }),
      ],
      framesToSendDirection: FrameDirection.UPSTREAM,
      expectedUpFrames: [], // no LLMContextFrame expected, run_llm=False
    });
    expect(context.messages.length).toEqual(1);
  });

  test("test_user_file_frame_run_llm_default_runs", async () => {
    const context = new LLMContext();
    const aggregator = new LLMAssistantAggregator(context);

    await runTest(aggregator, {
      framesToSend: [
        new UserFileRawFrame({
          file: "data:application/pdf;base64,abc123",
          type: "bytes",
          filename: "doc.pdf",
          format: "application/pdf",
          appendToContext: true,
        }),
      ],
      framesToSendDirection: FrameDirection.UPSTREAM,
      expectedUpFrames: [LLMContextFrame],
    });
    expect(context.messages.length).toEqual(1);
  });

  test("test_user_file_frame_lands_after_in_progress_assistant_text", async () => {
    // A file arriving mid-reply commits the partial assistant text first.
    //
    // The order matters beyond chronology: remove_invalid_file_message() only
    // considers messages after the last assistant message, so a file written
    // before a later-committed assistant message could never be cleaned up if
    // the provider rejects it.
    const context = new LLMContext();
    const aggregator = new LLMAssistantAggregator(context);

    await runTest(aggregator, {
      framesToSend: [
        new LLMFullResponseStartFrame(),
        new LLMTextFrame({ text: "I was saying..." }),
        // The file frame is a SystemFrame and would jump the priority queue; the
        // sleep lets the text land first, as it would have in a real mid-reply
        // arrival.
        new SleepFrame(),
        new UserFileRawFrame({
          file: "data:application/pdf;base64,abc123",
          type: "bytes",
          filename: "doc.pdf",
          format: "application/pdf",
          appendToContext: true,
          runLlm: false,
        }),
      ],
    });

    const roles = context.messages.map((m) => (m as Msg).role);
    expect(roles).toEqual(["assistant", "user"]);
    expect((context.messages[0] as Msg).content).toEqual("I was saying...");
    expect((context.messages[1] as Msg).content[0].type).toEqual("file_base64");
  });

  test("test_mid_turn_flush_pushes_no_frames", async () => {
    // Committing held text ahead of a file message is context-only: the turn's
    // context and timestamp frames belong to its real end, not to the flush.
    const context = new LLMContext();
    const aggregator = new LLMAssistantAggregator(context);

    const [receivedDown] = await runTest(aggregator, {
      framesToSend: [
        new LLMFullResponseStartFrame(),
        new LLMTextFrame({ text: "I was saying..." }),
        new SleepFrame(),
        new UserFileRawFrame({
          file: "data:application/pdf;base64,abc123",
          type: "bytes",
          filename: "doc.pdf",
          format: "application/pdf",
          appendToContext: true,
          runLlm: false,
        }),
      ],
    });

    expect(
      receivedDown.some(
        (f) => f instanceof LLMContextFrame || f instanceof LLMContextAssistantTimestampFrame,
      ),
    ).toBe(false);
  });

  test("test_user_image_frame_run_llm_false_does_not_run", async () => {
    const context = new LLMContext();
    const aggregator = new LLMAssistantAggregator(context);

    await runTest(aggregator, {
      framesToSend: [
        new UserImageRawFrame({
          image: new Uint8Array(3),
          size: [1, 1],
          format: "RGB",
          appendToContext: true,
          runLlm: false,
        }),
      ],
      framesToSendDirection: FrameDirection.UPSTREAM,
      expectedUpFrames: [], // no LLMContextFrame expected, run_llm=False
    });
    expect(context.messages.length).toEqual(1);
  });

  test("test_user_image_frame_run_llm_default_runs", async () => {
    const context = new LLMContext();
    const aggregator = new LLMAssistantAggregator(context);

    await runTest(aggregator, {
      framesToSend: [
        new UserImageRawFrame({
          image: new Uint8Array(3),
          size: [1, 1],
          format: "RGB",
          appendToContext: true,
        }),
      ],
      framesToSendDirection: FrameDirection.UPSTREAM,
      expectedUpFrames: [LLMContextFrame],
    });
    expect(context.messages.length).toEqual(1);
  });

  test("test_llm_messages_update", async () => {
    const context = new LLMContext();
    const aggregator = new LLMAssistantAggregator(context);

    await runTest(aggregator, {
      framesToSend: [
        new LLMMessagesUpdateFrame({ messages: [{ role: "user", content: "Hi there!" }] }),
      ],
      framesToSendDirection: FrameDirection.UPSTREAM,
      expectedUpFrames: [], // no LLMContextFrame expected, run_llm defaults to False
    });
    expect((context.messages[0] as Msg).content).toEqual("Hi there!");
  });

  test("test_llm_messages_update_run", async () => {
    const context = new LLMContext();
    const aggregator = new LLMAssistantAggregator(context);

    await runTest(aggregator, {
      framesToSend: [
        new LLMMessagesUpdateFrame({
          messages: [{ role: "user", content: "Hi there!" }],
          runLlm: true,
        }),
      ],
      framesToSendDirection: FrameDirection.UPSTREAM,
    });
    expect((context.messages[0] as Msg).content).toEqual("Hi there!");
  });

  test("test_llm_messages_transform", async () => {
    const context = new LLMContext();
    context.setMessages([
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there!" },
      { role: "user", content: "How are you?" },
    ]);

    const aggregator = new LLMAssistantAggregator(context);

    // Transform that keeps only user messages
    const keepUserMessages = (messages: LLMContextMessage[]) =>
      messages.filter((m) => (m as Msg).role === "user");

    await runTest(aggregator, {
      framesToSend: [new LLMMessagesTransformFrame({ transform: keepUserMessages })],
      framesToSendDirection: FrameDirection.UPSTREAM,
      expectedUpFrames: [], // no LLMContextFrame expected, run_llm defaults to False
    });
    expect(context.messages.length).toEqual(2);
    expect((context.messages[0] as Msg).content).toEqual("Hello");
    expect((context.messages[1] as Msg).content).toEqual("How are you?");
  });

  test("test_llm_messages_transform_run", async () => {
    const context = new LLMContext();
    context.setMessages([{ role: "user", content: "Hello" }]);

    const aggregator = new LLMAssistantAggregator(context);

    // Transform that modifies the content
    const uppercaseContent = (messages: LLMContextMessage[]) =>
      messages.map((m) => ({ role: (m as Msg).role, content: (m as Msg).content.toUpperCase() }));

    await runTest(aggregator, {
      framesToSend: [new LLMMessagesTransformFrame({ transform: uppercaseContent, runLlm: true })],
      framesToSendDirection: FrameDirection.UPSTREAM,
      expectedUpFrames: [LLMContextFrame],
    });
    expect((context.messages[0] as Msg).content).toEqual("HELLO");
  });

  async function runProposalsThroughAssistant(
    assistant: LLMAssistantAggregator,
  ): Promise<string[]> {
    const [receivedDown] = await runTest(new Pipeline([assistant]), {
      framesToSend: [
        new ProposedUserStartedSpeakingFrame(),
        new ProposedUserStoppedSpeakingFrame(),
        new SleepFrame({ sleep: 0.2 }),
      ],
      expectedDownFrames: null,
    });
    return frameNames(receivedDown);
  }

  test("test_proposed_frames_are_consumed_when_the_user_half_resolves_them", async () => {
    // A service between the halves broadcasts a copy this way; it stops here.
    const pair = new LLMContextAggregatorPair(new LLMContext(), {
      userParams: new LLMUserAggregatorParams({
        userTurnStrategies: new ExternalUserTurnStrategies(),
      }),
    });

    const names = await runProposalsThroughAssistant(pair.assistant());
    expect(names).not.toContain("ProposedUserStartedSpeakingFrame");
    expect(names).not.toContain("ProposedUserStoppedSpeakingFrame");
  });

  test("test_proposed_frames_pass_through_when_the_user_half_ignores_them", async () => {
    // Nothing resolved the proposal, so a resolver further along still can.
    const pair = new LLMContextAggregatorPair(new LLMContext(), {
      userParams: new LLMUserAggregatorParams({
        userTurnStrategies: new UserTurnStrategies({
          start: [new VADUserTurnStartStrategy()],
          stop: [
            new SpeechTimeoutUserTurnStopStrategy({ userSpeechTimeout: TRANSCRIPTION_TIMEOUT }),
          ],
        }),
      }),
    });

    const names = await runProposalsThroughAssistant(pair.assistant());
    expect(names).toContain("ProposedUserStartedSpeakingFrame");
    expect(names).toContain("ProposedUserStoppedSpeakingFrame");
  });

  test("test_proposed_frames_pass_through_without_a_paired_user_half", async () => {
    // With no user half to have resolved them, the proposals travel on.
    const names = await runProposalsThroughAssistant(new LLMAssistantAggregator(new LLMContext()));
    expect(names).toContain("ProposedUserStartedSpeakingFrame");
    expect(names).toContain("ProposedUserStoppedSpeakingFrame");
  });
});

function _functionSchema(name: string): FunctionSchema {
  return new FunctionSchema({ name, description: "", properties: {}, required: [] });
}

function _tools(...names: string[]): ToolsSchema {
  return new ToolsSchema({ standardTools: names.map((n) => _functionSchema(n)) });
}

function _developerMessages(context: LLMContext): string[] {
  return (context.messages as Msg[])
    .filter((m) => typeof m === "object" && m !== null && m.role === "developer")
    .map((m) => m.content);
}

/**
 * Coverage for the opt-in `add_tool_change_messages` feature.
 *
 * The feature appends a developer-role message to the context whenever
 * `LLMSetToolsFrame` changes the set of advertised standard tools.
 */
describe("TestToolChangeMessages", () => {
  async function sendSetToolsToUserAggregator(
    aggregator: LLMUserAggregator,
    tools: ConstructorParameters<typeof LLMSetToolsFrame>[0]["tools"],
  ): Promise<void> {
    // User aggregator forwards LLMSetToolsFrame downstream, so we expect the
    // SpeechControlParamsFrame (emitted on StartFrame) and the forwarded
    // LLMSetToolsFrame.
    await runTest(aggregator, {
      framesToSend: [new LLMSetToolsFrame({ tools })],
      expectedDownFrames: [SpeechControlParamsFrame, LLMSetToolsFrame],
    });
  }

  test("test_default_off_adds_no_message", async () => {
    const context = new LLMContext({ tools: _tools("a") });
    const aggregator = new LLMUserAggregator(context);
    await sendSetToolsToUserAggregator(aggregator, _tools("a", "b"));
    expect(_developerMessages(context)).toEqual([]);
  });

  test("test_user_aggregator_announces_additions", async () => {
    const context = new LLMContext({ tools: _tools("a") });
    const aggregator = new LLMUserAggregator(context, {
      params: new LLMUserAggregatorParams({ addToolChangeMessages: true }),
    });
    await sendSetToolsToUserAggregator(aggregator, _tools("a", "b", "c"));
    const msgs = _developerMessages(context);
    expect(msgs.length).toEqual(1);
    expect(msgs[0]).toContain("just been added");
    expect(msgs[0]).toContain("`b`");
    expect(msgs[0]).toContain("`c`");
    expect(msgs[0]).not.toContain("removed");
    // Sorted, stable order
    expect(msgs[0]!.indexOf("`b`")).toBeLessThan(msgs[0]!.indexOf("`c`"));
  });

  test("test_user_aggregator_announces_removals", async () => {
    const context = new LLMContext({ tools: _tools("a", "b", "c") });
    const aggregator = new LLMUserAggregator(context, {
      params: new LLMUserAggregatorParams({ addToolChangeMessages: true }),
    });
    await sendSetToolsToUserAggregator(aggregator, _tools("a"));
    const msgs = _developerMessages(context);
    expect(msgs.length).toEqual(1);
    expect(msgs[0]).toContain("just been removed");
    expect(msgs[0]).toContain("`b`");
    expect(msgs[0]).toContain("`c`");
    expect(msgs[0]).not.toContain("just been added");
  });

  test("test_user_aggregator_combined_add_and_remove", async () => {
    const context = new LLMContext({ tools: _tools("a", "b") });
    const aggregator = new LLMUserAggregator(context, {
      params: new LLMUserAggregatorParams({ addToolChangeMessages: true }),
    });
    await sendSetToolsToUserAggregator(aggregator, _tools("b", "c"));
    const msgs = _developerMessages(context);
    expect(msgs.length).toEqual(1);
    expect(msgs[0]).toContain("just been added");
    expect(msgs[0]).toContain("`c`");
    expect(msgs[0]).toContain("just been removed");
    expect(msgs[0]).toContain("`a`");
    // Activation phrase appears before deactivation phrase.
    expect(msgs[0]!.indexOf("just been added")).toBeLessThan(msgs[0]!.indexOf("just been removed"));
  });

  test("test_no_message_when_diff_is_empty", async () => {
    const context = new LLMContext({ tools: _tools("a", "b") });
    const aggregator = new LLMUserAggregator(context, {
      params: new LLMUserAggregatorParams({ addToolChangeMessages: true }),
    });
    await sendSetToolsToUserAggregator(aggregator, _tools("a", "b"));
    expect(_developerMessages(context)).toEqual([]);
  });

  test("test_set_tools_to_not_given_lists_all_as_removed", async () => {
    const context = new LLMContext({ tools: _tools("a", "b") });
    const aggregator = new LLMUserAggregator(context, {
      params: new LLMUserAggregatorParams({ addToolChangeMessages: true }),
    });
    await sendSetToolsToUserAggregator(aggregator, NOT_GIVEN);
    const msgs = _developerMessages(context);
    expect(msgs.length).toEqual(1);
    expect(msgs[0]).toContain("just been removed");
    expect(msgs[0]).toContain("`a`");
    expect(msgs[0]).toContain("`b`");
  });

  test("test_set_tools_from_not_given_lists_all_as_added", async () => {
    const context = new LLMContext(); // tools default to NOT_GIVEN
    const aggregator = new LLMUserAggregator(context, {
      params: new LLMUserAggregatorParams({ addToolChangeMessages: true }),
    });
    await sendSetToolsToUserAggregator(aggregator, _tools("x", "y"));
    const msgs = _developerMessages(context);
    expect(msgs.length).toEqual(1);
    expect(msgs[0]).toContain("just been added");
    expect(msgs[0]).toContain("`x`");
    expect(msgs[0]).toContain("`y`");
  });

  test("test_set_tools_accepts_plain_list", async () => {
    // Regression: a bare list (e.g. direct functions / FunctionSchema objects,
    // not wrapped in a ToolsSchema) must be normalized rather than raise
    // "'list' object has no attribute 'standard_tools'". Mirrors re-adding a
    // tool via LLMSetToolsFrame(tools=[...]) after it was removed.
    const context = new LLMContext(); // tools default to NOT_GIVEN
    const aggregator = new LLMUserAggregator(context, {
      params: new LLMUserAggregatorParams({ addToolChangeMessages: true }),
    });
    await sendSetToolsToUserAggregator(aggregator, [_functionSchema("b")]);
    const msgs = _developerMessages(context);
    expect(msgs.length).toEqual(1);
    expect(msgs[0]).toContain("just been added");
    expect(msgs[0]).toContain("`b`");
    // The bare list was normalized into a ToolsSchema in the context.
    expect(new Set((context.tools as ToolsSchema).standardTools.map((s) => s.name))).toEqual(
      new Set(["b"]),
    );
  });

  test("test_custom_tools_only_change_no_message", async () => {
    // Standard tools identical; only custom tools differ → no announcement.
    const context = new LLMContext({
      tools: new ToolsSchema({
        standardTools: [_functionSchema("a")],
        customTools: { [AdapterType.OPENAI]: [{ type: "web_search" }] },
      }),
    });
    const aggregator = new LLMUserAggregator(context, {
      params: new LLMUserAggregatorParams({ addToolChangeMessages: true }),
    });
    const newTools = new ToolsSchema({
      standardTools: [_functionSchema("a")],
      customTools: { [AdapterType.OPENAI]: [{ type: "file_search" }] },
    });
    await sendSetToolsToUserAggregator(aggregator, newTools);
    expect(_developerMessages(context)).toEqual([]);
  });

  test("test_pipeline_with_both_aggregators_announces_once", async () => {
    // User agg runs first; assistant agg sees no diff and stays silent.
    const context = new LLMContext({ tools: _tools("a") });
    const [user, assistant] = new LLMContextAggregatorPair(context, {
      addToolChangeMessages: true,
    });
    const pipeline = new Pipeline([user!, assistant!]);
    // The user aggregator forwards LLMSetToolsFrame downstream; the assistant
    // aggregator consumes it (does not forward).
    await runTest(pipeline, {
      framesToSend: [new LLMSetToolsFrame({ tools: _tools("a", "b") })],
      expectedDownFrames: [SpeechControlParamsFrame],
    });
    const msgs = _developerMessages(context);
    expect(msgs.length, `expected exactly one announcement, got ${msgs}`).toEqual(1);
    expect(msgs[0]).toContain("`b`");
  });

  test("test_assistant_aggregator_announces_when_handled_first", async () => {
    // Order-independence: an upstream LLMSetToolsFrame hits the assistant
    // aggregator first (before being consumed). It should announce, and the user
    // aggregator (which never sees it) shouldn't matter for correctness.
    const context = new LLMContext({ tools: _tools("a") });
    const assistant = new LLMAssistantAggregator(context, {
      params: new LLMAssistantAggregatorParams({ addToolChangeMessages: true }),
    });
    // Send the frame upstream so the assistant aggregator processes it.
    await runTest(assistant, {
      framesToSend: [new LLMSetToolsFrame({ tools: _tools("a", "b") })],
      framesToSendDirection: FrameDirection.UPSTREAM,
      expectedUpFrames: [],
    });
    const msgs = _developerMessages(context);
    expect(msgs.length).toEqual(1);
    expect(msgs[0]).toContain("`b`");
  });

  test("test_pair_propagates_flag_to_both", async () => {
    const context = new LLMContext();
    const pair = new LLMContextAggregatorPair(context, { addToolChangeMessages: true });
    expect(internals(pair.user())._addToolChangeMessages).toBe(true);
    expect(internals(pair.assistant())._addToolChangeMessages).toBe(true);
  });

  test("test_pair_arg_overrides_per_params_settings", async () => {
    const context = new LLMContext();
    const pair = new LLMContextAggregatorPair(context, {
      userParams: new LLMUserAggregatorParams({ addToolChangeMessages: false }),
      assistantParams: new LLMAssistantAggregatorParams({ addToolChangeMessages: false }),
      addToolChangeMessages: true,
    });
    expect(internals(pair.user())._addToolChangeMessages).toBe(true);
    expect(internals(pair.assistant())._addToolChangeMessages).toBe(true);
  });

  test("test_pair_default_respects_per_params", async () => {
    const context = new LLMContext();
    const pair = new LLMContextAggregatorPair(context, {
      userParams: new LLMUserAggregatorParams({ addToolChangeMessages: true }),
      assistantParams: new LLMAssistantAggregatorParams({ addToolChangeMessages: false }),
    });
    expect(internals(pair.user())._addToolChangeMessages).toBe(true);
    expect(internals(pair.assistant())._addToolChangeMessages).toBe(false);
  });
});

/** End-to-end tests for the trailing-write realtime mode. */
describe("TestRealtimeServiceModeAggregator", () => {
  function buildPair(
    options: {
      realtimeServiceMode?: boolean | null;
      userParams?: LLMUserAggregatorParams | null;
    } = {},
  ): [LLMContext, LLMContextAggregatorPair] {
    const context = new LLMContext();
    const pair = new LLMContextAggregatorPair(context, {
      userParams: options.userParams ?? null,
      realtimeServiceMode: options.realtimeServiceMode ?? null,
    });
    return [context, pair];
  }

  function hasWaitForTranscript(s: unknown): s is { waitForTranscript: boolean } {
    return typeof s === "object" && s !== null && "waitForTranscript" in s;
  }

  test("test_pair_propagates_realtime_mode_to_halves", async () => {
    const [, pair] = buildPair({ realtimeServiceMode: true });
    // Realtime mode is one-way: the assistant holds the back-ref so it can flush
    // the user on LLMFullResponseStartFrame. The user has no back-ref — the
    // assistant writes its own message on LLMFullResponseEndFrame, so it doesn't
    // need to call back.
    expect(internals(pair.assistant())._pairedUserAggregator).toBe(pair.user());
    expect(internals(pair.user())._realtimeServiceMode).toBe(true);
    expect(internals(pair.assistant())._realtimeServiceMode).toBe(true);
  });

  test("test_pair_defaults_to_auto_mode", async () => {
    // Default: realtime_service_mode is auto-configured (None), and the
    // assistant→user back-reference is always wired so it's ready if a realtime
    // service later auto-enables the mode.
    const [, pair] = buildPair();
    expect(internals(pair.assistant())._pairedUserAggregator).toBe(pair.user());
    expect(internals(pair.user())._realtimeServiceMode).toBeNull();
    expect(internals(pair.assistant())._realtimeServiceMode).toBeNull();
  });

  test("test_realtime_strategy_mutations_with_defaults", async () => {
    // With realtime_service_mode explicitly enabled, the init-time mutations
    // apply (drop the transcription start strategy, flip wait_for_transcript on
    // default stops). No metadata frame has arrived, so no service-recommended
    // external strategies are installed.
    const [, pair] = buildPair({ realtimeServiceMode: true });
    const strategies = internals(pair.user()._userTurnController)._userTurnStrategies;
    for (const s of strategies.start) {
      expect(s).not.toBeInstanceOf(TranscriptionUserTurnStartStrategy);
    }
    // Default VAD start strategy is preserved; no External strategies installed
    // yet.
    expect(strategies.start.some((s: unknown) => s instanceof VADUserTurnStartStrategy)).toBe(true);
    expect(strategies.start.some((s: unknown) => s instanceof ExternalUserTurnStartStrategy)).toBe(
      false,
    );
    expect(strategies.stop.some((s: unknown) => s instanceof ExternalUserTurnStopStrategy)).toBe(
      false,
    );
    for (const s of strategies.stop) {
      if (hasWaitForTranscript(s)) {
        expect(s.waitForTranscript).toBe(false);
      }
    }
  });

  test("test_realtime_metadata_applies_recommended_external_strategies", async () => {
    // A realtime service recommending ExternalUserTurnStrategies (and no custom
    // user strategies) installs them, then realtime mode mutates them
    // (wait_for_transcript=False).
    const [, pair] = buildPair({ realtimeServiceMode: true });
    const framesToSend = [
      new LLMServiceMetadataFrame({
        serviceName: "FakeRealtimeLLM",
        isRealtimeService: true,
        userTurnStrategies: new ExternalUserTurnStrategies(),
      }),
    ];
    await runTest(new Pipeline([pair.user(), pair.assistant()]), { framesToSend });
    const strategies = internals(pair.user()._userTurnController)._userTurnStrategies;
    expect(strategies.start.length).toEqual(1);
    expect(strategies.start[0]).toBeInstanceOf(ExternalUserTurnStartStrategy);
    expect(strategies.stop.length).toEqual(1);
    expect(strategies.stop[0]).toBeInstanceOf(ExternalUserTurnStopStrategy);
    // Realtime-mode mutation is applied to the recommended stop strategy.
    expect(strategies.stop[0].waitForTranscript).toBe(false);
  });

  test("test_realtime_metadata_keeps_defaults_when_service_recommends_nothing", async () => {
    // A realtime service that recommends no strategies (e.g. one that doesn't
    // emit its own turn frames) keeps the default strategies so locally-driven
    // turns (e.g. local VAD) can fire on_user_turn_* events.
    const [, pair] = buildPair({ realtimeServiceMode: true });
    const framesToSend = [
      new LLMServiceMetadataFrame({ serviceName: "FakeRealtimeLLM", isRealtimeService: true }),
    ];
    await runTest(new Pipeline([pair.user(), pair.assistant()]), { framesToSend });
    const strategies = internals(pair.user()._userTurnController)._userTurnStrategies;
    expect(strategies.start.some((s: unknown) => s instanceof ExternalUserTurnStartStrategy)).toBe(
      false,
    );
    expect(strategies.stop.some((s: unknown) => s instanceof ExternalUserTurnStopStrategy)).toBe(
      false,
    );
    expect(strategies.start.some((s: unknown) => s instanceof VADUserTurnStartStrategy)).toBe(true);
  });

  test("test_realtime_metadata_keeps_custom_strategies", async () => {
    // Custom user_turn_strategies opts out of the recommendation — explicit user
    // choice wins, regardless of what the service recommends.
    const custom = new UserTurnStrategies({
      start: [new VADUserTurnStartStrategy()],
      stop: [new SpeechTimeoutUserTurnStopStrategy()],
    });
    const [, pair] = buildPair({
      realtimeServiceMode: true,
      userParams: new LLMUserAggregatorParams({ userTurnStrategies: custom }),
    });
    const framesToSend = [
      new LLMServiceMetadataFrame({
        serviceName: "FakeRealtimeLLM",
        isRealtimeService: true,
        userTurnStrategies: new ExternalUserTurnStrategies(),
      }),
    ];
    await runTest(new Pipeline([pair.user(), pair.assistant()]), { framesToSend });
    const strategies = internals(pair.user()._userTurnController)._userTurnStrategies;
    expect(strategies.start.some((s: unknown) => s instanceof ExternalUserTurnStartStrategy)).toBe(
      false,
    );
    expect(strategies.stop.some((s: unknown) => s instanceof ExternalUserTurnStopStrategy)).toBe(
      false,
    );
    expect(strategies.start.some((s: unknown) => s instanceof VADUserTurnStartStrategy)).toBe(true);
  });

  test("test_trailing_write_user_then_assistant_then_user", async () => {
    const [, pair] = buildPair({ realtimeServiceMode: true });
    const [user, assistant] = [pair.user(), pair.assistant()];

    const userMsgAdded: UserTurnMessageAddedMessage[] = [];
    const assistantMsgStopped: AssistantTurnStoppedMessage[] = [];

    user.eventHandler(
      "on_user_turn_message_added",
      async (_a, msg: UserTurnMessageAddedMessage) => {
        userMsgAdded.push(msg);
      },
    );

    assistant.eventHandler(
      "on_assistant_turn_stopped",
      async (_a, msg: AssistantTurnStoppedMessage) => {
        assistantMsgStopped.push(msg);
      },
    );

    const context = user.context;

    // Sequence: user transcript, assistant response starts (flushes user),
    // assistant response ends (writes assistant), new user transcript, EndFrame
    // flushes the new user message.
    const framesToSend = [
      transcription("Hello!"),
      new SleepFrame(),
      new LLMFullResponseStartFrame(),
      new LLMTextFrame({ text: "Hi " }),
      new LLMTextFrame({ text: "there!" }),
      new LLMFullResponseEndFrame(),
      new SleepFrame(),
      transcription("How are you?"),
      new SleepFrame(),
    ];
    await runTest(new Pipeline([user, assistant]), { framesToSend });

    // Context should contain: user("Hello!"), assistant("Hi there!"),
    // user("How are you?").
    const messages = context.getMessages() as Msg[];
    const rolesContents = messages.map((m) => [m.role, m.content]);
    expect(rolesContents).toEqual([
      ["user", "Hello!"],
      ["assistant", "Hi there!"],
      ["user", "How are you?"],
    ]);
    expect(userMsgAdded.map((m) => m.content)).toEqual(["Hello!", "How are you?"]);
    expect(assistantMsgStopped.map((m) => m.content)).toEqual(["Hi there!"]);
    for (const msg of assistantMsgStopped) {
      expect(msg.interrupted).toBe(false);
    }
  });

  // DIVERGENCE: scheduling, not behavior. The user message is not written when
  // the assistant starts: the realtime handoff flush waits DEFAULT_TTFS_P99
  // (1 s), so upstream it is written by the user half's EndFrame (`_stop`). The
  // run_test EndFrame is queued right behind the InterruptionFrame; under
  // asyncio the assistant's interruption handling (cancelling and re-creating
  // its process task) takes event-loop iterations, during which the user half
  // processes EndFrame, so "Hi!" lands first. Under the JS microtask emulation
  // (@pipedog/asyncio) the assistant handles the interruption first and
  // writes "Hello" before the user half reaches EndFrame. Same code paths as
  // upstream; only the interleaving differs.
  test.skip("test_interruption_writes_assistant_immediately", async () => {
    const [, pair] = buildPair({ realtimeServiceMode: true });
    const [user, assistant] = [pair.user(), pair.assistant()];

    const assistantMessages: AssistantTurnStoppedMessage[] = [];

    assistant.eventHandler(
      "on_assistant_turn_stopped",
      async (_a, msg: AssistantTurnStoppedMessage) => {
        assistantMessages.push(msg);
      },
    );

    const context = user.context;

    const framesToSend = [
      transcription("Hi!"),
      new LLMFullResponseStartFrame(),
      new LLMTextFrame({ text: "Hello " }),
      new SleepFrame(),
      new InterruptionFrame(),
    ];
    await runTest(new Pipeline([user, assistant]), { framesToSend });

    const rolesContents = (context.getMessages() as Msg[]).map((m) => [m.role, m.content]);
    // User message written when assistant started; assistant message written
    // immediately on interruption with interrupted=True.
    expect(rolesContents).toEqual([
      ["user", "Hi!"],
      ["assistant", "Hello"],
    ]);
    expect(assistantMessages.length).toEqual(1);
    expect(assistantMessages[0]!.interrupted).toBe(true);
  });

  test("test_user_turn_stopped_in_realtime_mode_has_none_content", async () => {
    // When VAD turn frames fire in realtime mode, the user-turn-stop message
    // carries content=None — the message isn't finalized yet.
    const [, pair] = buildPair({
      realtimeServiceMode: true,
      userParams: new LLMUserAggregatorParams({
        userTurnStrategies: new UserTurnStrategies({
          stop: [
            new SpeechTimeoutUserTurnStopStrategy({ userSpeechTimeout: TRANSCRIPTION_TIMEOUT }),
          ],
        }),
        userTurnStopTimeout: USER_TURN_STOP_TIMEOUT,
      }),
    });
    const [user, assistant] = [pair.user(), pair.assistant()];

    const stopMessages: UserTurnStoppedMessage[] = [];

    user.eventHandler("on_user_turn_stopped", async (_a, _s, msg: UserTurnStoppedMessage) => {
      stopMessages.push(msg);
    });

    const framesToSend = [
      new VADUserStartedSpeakingFrame(),
      transcription("hey"),
      new VADUserStoppedSpeakingFrame(),
      new SleepFrame({ sleep: TRANSCRIPTION_TIMEOUT + 0.05 }),
    ];
    await runTest(new Pipeline([user, assistant]), { framesToSend });
    expect(stopMessages.length).toEqual(1);
    expect(stopMessages[0]!.content).toBeNull();
  });

  test("test_realtime_metadata_auto_enables_mode_when_unset", async () => {
    // Default (auto) pair: a realtime service announcing itself flips both
    // halves into realtime mode with no manual opt-in, and mutates the default
    // strategies for realtime use.
    const [, pair] = buildPair();
    const user = pair.user();

    const framesToSend = [
      new LLMServiceMetadataFrame({ serviceName: "FakeRealtimeLLM", isRealtimeService: true }),
    ];
    await runTest(new Pipeline([pair.user(), pair.assistant()]), { framesToSend });
    expect(internals(user)._realtimeServiceMode).toBe(true);
    expect(internals(pair.assistant())._realtimeServiceMode).toBe(true);
    expect(internals(user)._realtimeMetadataHandled).toBe(true);
    const strategies = internals(user._userTurnController)._userTurnStrategies;
    for (const s of strategies.start) {
      expect(s).not.toBeInstanceOf(TranscriptionUserTurnStartStrategy);
    }
    for (const s of strategies.stop) {
      if (hasWaitForTranscript(s)) {
        expect(s.waitForTranscript).toBe(false);
      }
    }
  });

  test("test_realtime_metadata_handled_when_explicitly_enabled", async () => {
    // With realtime mode explicitly enabled, the metadata frame is processed and
    // the one-shot guard is set.
    const [, pair] = buildPair({ realtimeServiceMode: true });
    const user = pair.user();

    const framesToSend = [
      new LLMServiceMetadataFrame({ serviceName: "FakeRealtimeLLM", isRealtimeService: true }),
    ];
    await runTest(new Pipeline([pair.user(), pair.assistant()]), { framesToSend });
    expect(internals(user)._realtimeMetadataHandled).toBe(true);
  });

  test("test_external_recommendation_applies_with_realtime_mode_disabled", async () => {
    // The external-strategy recommendation is decoupled from
    // realtime_service_mode: a service recommending ExternalUserTurnStrategies
    // gets them applied even when realtime mode is explicitly disabled. They are
    // NOT realtime-mutated (wait_for_transcript keeps its default), since
    // realtime mode is off.
    const [, pair] = buildPair({ realtimeServiceMode: false });
    const framesToSend = [
      new LLMServiceMetadataFrame({
        serviceName: "FakeRealtimeLLM",
        isRealtimeService: true,
        userTurnStrategies: new ExternalUserTurnStrategies(),
      }),
    ];
    await runTest(new Pipeline([pair.user(), pair.assistant()]), { framesToSend });
    expect(internals(pair.user())._realtimeServiceMode).toBe(false);
    const strategies = internals(pair.user()._userTurnController)._userTurnStrategies;
    expect(strategies.start[0]).toBeInstanceOf(ExternalUserTurnStartStrategy);
    expect(strategies.stop[0]).toBeInstanceOf(ExternalUserTurnStopStrategy);
    // Not realtime-mutated: wait_for_transcript keeps its default (True).
    expect(strategies.stop[0].waitForTranscript).toBe(true);
  });

  test("test_realtime_metadata_reapplies_mutation_on_rebroadcast", async () => {
    // Regression: a second metadata broadcast (e.g. a ServiceSwitcher switch)
    // re-adopts a fresh recommendation, so the realtime mutation must re-run.
    // The one-shot guard governs only auto-enable/logging, not strategy install.
    // (No-double-registration is covered at the controller level in
    // test_user_turn_controller, since handlers are torn down at session end.)
    const [, pair] = buildPair({ realtimeServiceMode: true });
    const framesToSend = [
      new LLMServiceMetadataFrame({
        serviceName: "FakeRealtimeLLM",
        isRealtimeService: true,
        userTurnStrategies: new ExternalUserTurnStrategies(),
      }),
      new LLMServiceMetadataFrame({
        serviceName: "FakeRealtimeLLM",
        isRealtimeService: true,
        userTurnStrategies: new ExternalUserTurnStrategies(),
      }),
    ];
    await runTest(new Pipeline([pair.user(), pair.assistant()]), { framesToSend });
    const strategies = pair.user()._userTurnController.userTurnStrategies;
    expect(strategies.stop[0]).toBeInstanceOf(ExternalUserTurnStopStrategy);
    // Mutation re-applied after the second broadcast (not skipped by the guard).
    expect((strategies.stop[0] as ExternalUserTurnStopStrategy).waitForTranscript).toBe(false);
  });

  test("test_realtime_mode_requires_paired_user_aggregator", async () => {
    // Realtime mode needs the assistant's back-reference to the user half to
    // flush user messages. Constructing the assistant directly (bypassing the
    // pair) leaves it unpaired; the same check runs at StartFrame for an
    // explicit mode and at the auto-enable flip. (Called directly so the error
    // isn't swallowed by the pipeline's exception handler.)
    const context = new LLMContext();
    const assistant = new LLMAssistantAggregator(context, { _realtimeServiceMode: true });
    expect(() => internals(assistant)._requirePairedUserAggregator()).toThrow(Error);
  });
});
