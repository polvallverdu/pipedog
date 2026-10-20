// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_user_turn_processor.py

import { describe, expect, test } from "bun:test";

import {
  InterruptionFrame,
  ProposedUserStartedSpeakingFrame,
  ProposedUserStoppedSpeakingFrame,
  TranscriptionFrame,
  UserStartedSpeakingFrame,
  UserStoppedSpeakingFrame,
  VADUserStartedSpeakingFrame,
  VADUserStoppedSpeakingFrame,
} from "../src/frames/frames.ts";
import { Pipeline } from "../src/pipeline/pipeline.ts";
import { LLMContext } from "../src/processors/aggregators/llm_context.ts";
import {
  LLMUserAggregator,
  LLMUserAggregatorParams,
} from "../src/processors/aggregators/llm_response_universal.ts";
import { runTest, SleepFrame } from "../src/tests/utils.ts";
import { SpeechTimeoutUserTurnStopStrategy } from "../src/turns/user_stop/index.ts";
import { UserTurnProcessor } from "../src/turns/user_turn_processor.ts";
import {
  ExternalUserTurnStrategies,
  UserTurnStrategies,
} from "../src/turns/user_turn_strategies.ts";

const USER_TURN_STOP_TIMEOUT = 0.2;
const TRANSCRIPTION_TIMEOUT = 0.1;

describe("TestUserTurnProcessor", () => {
  test("test_default_user_turn_strategies", async () => {
    const userTurnProcessor = new UserTurnProcessor({
      userTurnStrategies: new UserTurnStrategies({
        stop: [new SpeechTimeoutUserTurnStopStrategy({ userSpeechTimeout: TRANSCRIPTION_TIMEOUT })],
      }),
    });

    let shouldStart: boolean | null = null;
    let shouldStop: boolean | null = null;

    userTurnProcessor.eventHandler("on_user_turn_started", async (_processor, _strategy) => {
      shouldStart = true;
    });

    userTurnProcessor.eventHandler("on_user_turn_stopped", async (_processor, _strategy) => {
      shouldStop = true;
    });

    const pipeline = new Pipeline([userTurnProcessor]);

    const framesToSend = [
      new VADUserStartedSpeakingFrame(),
      new TranscriptionFrame({ text: "Hello!", userId: "", timestamp: "now" }),
      new SleepFrame(),
      new VADUserStoppedSpeakingFrame(),
      // Wait for user_speech_timeout to elapse
      new SleepFrame({ sleep: TRANSCRIPTION_TIMEOUT + 0.1 }),
    ];
    const expectedDownFrames = [
      VADUserStartedSpeakingFrame,
      UserStartedSpeakingFrame,
      InterruptionFrame,
      TranscriptionFrame,
      VADUserStoppedSpeakingFrame,
      UserStoppedSpeakingFrame,
    ];
    await runTest(pipeline, { framesToSend, expectedDownFrames });
    expect(shouldStart).toBe(true);
    expect(shouldStop).toBe(true);
  });

  test("test_user_turn_stop_timeout_no_transcription", async () => {
    const userTurnProcessor = new UserTurnProcessor({
      userTurnStrategies: new UserTurnStrategies(),
      userTurnStopTimeout: USER_TURN_STOP_TIMEOUT,
    });

    let shouldStart: boolean | null = null;
    let shouldStop: boolean | null = null;
    let timeout: boolean | null = null;

    userTurnProcessor.eventHandler("on_user_turn_started", async (_processor, _strategy) => {
      shouldStart = true;
    });

    userTurnProcessor.eventHandler("on_user_turn_stopped", async (_processor, _strategy) => {
      shouldStop = true;
    });

    userTurnProcessor.eventHandler("on_user_turn_stop_timeout", async (_processor) => {
      timeout = true;
    });

    const pipeline = new Pipeline([userTurnProcessor]);

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
    const userTurnProcessor = new UserTurnProcessor({
      userTurnStrategies: new UserTurnStrategies({
        stop: [new SpeechTimeoutUserTurnStopStrategy({ userSpeechTimeout: TRANSCRIPTION_TIMEOUT })],
      }),
      userTurnStopTimeout: USER_TURN_STOP_TIMEOUT,
    });

    let shouldStart: boolean | null = null;
    let shouldStop: boolean | null = null;
    let timeout: boolean | null = null;

    userTurnProcessor.eventHandler("on_user_turn_started", async (_processor, _strategy) => {
      shouldStart = true;
    });

    userTurnProcessor.eventHandler("on_user_turn_stopped", async (_processor, _strategy) => {
      shouldStop = true;
    });

    userTurnProcessor.eventHandler("on_user_turn_stop_timeout", async (_processor) => {
      timeout = true;
    });

    const pipeline = new Pipeline([userTurnProcessor]);

    // Transcript arrives before VAD stop, then we wait for user_speech_timeout
    const framesToSend = [
      new VADUserStartedSpeakingFrame(),
      new TranscriptionFrame({ text: "Hello!", userId: "", timestamp: "now" }),
      new VADUserStoppedSpeakingFrame(),
      // Wait for user_speech_timeout (TRANSCRIPTION_TIMEOUT=0.1s) to elapse
      new SleepFrame({ sleep: TRANSCRIPTION_TIMEOUT + 0.05 }),
    ];
    await runTest(pipeline, { framesToSend });

    // The transcription strategy should kick-in before the user turn end timeout.
    expect(shouldStart).toBe(true);
    expect(shouldStop).toBe(true);
    // assertFalse(None) passes in Python: the handler must not have fired.
    expect(timeout).toBeFalsy();
  });

  test("test_proposal_is_resolved_once_with_an_aggregator_downstream", async () => {
    // Two resolvers in one pipeline must not decide the same turn twice.
    //
    // The processor resolves the proposal and consumes it, so the aggregator
    // downstream sees only the turn frames it emitted and adopts them.
    const userTurnProcessor = new UserTurnProcessor({
      userTurnStrategies: new ExternalUserTurnStrategies(),
    });
    const userAggregator = new LLMUserAggregator(new LLMContext(), {
      params: new LLMUserAggregatorParams({ userTurnStrategies: new ExternalUserTurnStrategies() }),
    });

    const framesToSend = [
      new ProposedUserStartedSpeakingFrame(),
      new TranscriptionFrame({ text: "Hello!", userId: "", timestamp: "now" }),
      new ProposedUserStoppedSpeakingFrame(),
      new SleepFrame({ sleep: 1.0 }),
    ];
    const [receivedDown] = await runTest(new Pipeline([userTurnProcessor, userAggregator]), {
      framesToSend,
      expectedDownFrames: null,
    });

    const names = receivedDown.map((f) => f.constructor.name);
    const count = (name: string) => names.filter((n) => n === name).length;
    expect(count("UserStartedSpeakingFrame")).toEqual(1);
    expect(count("UserStoppedSpeakingFrame")).toEqual(1);
    expect(count("InterruptionFrame")).toEqual(1);
    expect(count("ProposedUserStartedSpeakingFrame")).toEqual(0);
    expect(count("ProposedUserStoppedSpeakingFrame")).toEqual(0);
  });
});
