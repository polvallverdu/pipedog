// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipecat-ts contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_user_turn_start_strategy.py

import { describe, expect, test } from "bun:test";

import {
  BotStartedSpeakingFrame,
  InterimTranscriptionFrame,
  ProposedUserStartedSpeakingFrame,
  TranscriptionFrame,
  UserStartedSpeakingFrame,
  VADUserStartedSpeakingFrame,
  VADUserStoppedSpeakingFrame,
} from "../src/frames/frames.ts";
import {
  BaseUserTurnStartStrategy,
  ExternalUserTurnStartStrategy,
  MinWordsUserTurnStartStrategy,
  TranscriptionUserTurnStartStrategy,
  type UserTurnStartedParams,
  VADUserTurnStartStrategy,
} from "../src/turns/user_start/index.ts";

function captureShouldStart(strategy: BaseUserTurnStartStrategy): { value: boolean | null } {
  const shouldStart: { value: boolean | null } = { value: null };
  strategy.eventHandler("on_user_turn_started", async (_strategy, _params) => {
    shouldStart.value = true;
  });
  return shouldStart;
}

describe("TestMinWordsInterruptionStrategy", () => {
  test("test_bot_speaking_transcriptions", async () => {
    const strategy = new MinWordsUserTurnStartStrategy({ minWords: 2 });
    const shouldStart = captureShouldStart(strategy);

    await strategy.processFrame(new BotStartedSpeakingFrame());
    await strategy.processFrame(
      new TranscriptionFrame({ text: "Hello", userId: "cat", timestamp: "" }),
    );
    expect(shouldStart.value).toBeFalsy();

    await strategy.processFrame(
      new TranscriptionFrame({ text: "Hello there!", userId: "cat", timestamp: "" }),
    );
    expect(shouldStart.value).toBeTruthy();

    // A new turn starts; the strategy re-arms.
    shouldStart.value = null;
    await strategy.handleUserTurnStarted();

    await strategy.processFrame(new BotStartedSpeakingFrame());
    await strategy.processFrame(
      new TranscriptionFrame({ text: "Hello!", userId: "cat", timestamp: "" }),
    );
    expect(shouldStart.value).toBeFalsy();

    await strategy.processFrame(
      new TranscriptionFrame({ text: "How are you?", userId: "cat", timestamp: "" }),
    );
    expect(shouldStart.value).toBeTruthy();
  });

  test("test_bot_speaking_singlw_words", async () => {
    const strategy = new MinWordsUserTurnStartStrategy({ minWords: 3 });
    const shouldStart = captureShouldStart(strategy);

    await strategy.processFrame(new BotStartedSpeakingFrame());
    await strategy.processFrame(
      new TranscriptionFrame({ text: "One", userId: "cat", timestamp: "" }),
    );
    expect(shouldStart.value).toBeFalsy();

    await strategy.processFrame(
      new TranscriptionFrame({ text: "Two", userId: "cat", timestamp: "" }),
    );
    expect(shouldStart.value).toBeFalsy();

    await strategy.processFrame(
      new TranscriptionFrame({ text: "Three", userId: "cat", timestamp: "" }),
    );
    expect(shouldStart.value).toBeFalsy();
  });

  test("test_bot_speaking_interim_transcriptions", async () => {
    const strategy = new MinWordsUserTurnStartStrategy({ minWords: 2 });
    const shouldStart = captureShouldStart(strategy);

    await strategy.processFrame(new BotStartedSpeakingFrame());
    await strategy.processFrame(
      new InterimTranscriptionFrame({ text: "Hello", userId: "cat", timestamp: "" }),
    );
    expect(shouldStart.value).toBeFalsy();

    await strategy.processFrame(new BotStartedSpeakingFrame());
    await strategy.processFrame(
      new InterimTranscriptionFrame({ text: "Hello there!", userId: "cat", timestamp: "" }),
    );
    expect(shouldStart.value).toBeTruthy();
  });

  test("test_bot_speaking_all_transcriptions", async () => {
    const strategy = new MinWordsUserTurnStartStrategy({ minWords: 2 });
    const shouldStart = captureShouldStart(strategy);

    await strategy.processFrame(new BotStartedSpeakingFrame());
    await strategy.processFrame(
      new InterimTranscriptionFrame({ text: "Hello", userId: "cat", timestamp: "" }),
    );
    expect(shouldStart.value).toBeFalsy();

    await strategy.processFrame(
      new TranscriptionFrame({ text: "Hello there!", userId: "cat", timestamp: "" }),
    );
    expect(shouldStart.value).toBeTruthy();
  });

  test("test_bot_not_speaking_transcriptions", async () => {
    const strategy = new MinWordsUserTurnStartStrategy({ minWords: 2 });
    const shouldStart = captureShouldStart(strategy);

    await strategy.processFrame(
      new TranscriptionFrame({ text: "Hello", userId: "cat", timestamp: "" }),
    );
    expect(shouldStart.value).toBeTruthy();
  });

  test("test_bot_not_speaking_interim_transcriptions", async () => {
    const strategy = new MinWordsUserTurnStartStrategy({ minWords: 2 });
    const shouldStart = captureShouldStart(strategy);

    await strategy.processFrame(
      new InterimTranscriptionFrame({ text: "Hello", userId: "cat", timestamp: "" }),
    );
    expect(shouldStart.value).toBeTruthy();
  });
});

describe("TestVADUserTurnStartStrategy", () => {
  test("test_vad_strategy", async () => {
    const strategy = new VADUserTurnStartStrategy();
    const shouldStart = captureShouldStart(strategy);

    await strategy.processFrame(new VADUserStoppedSpeakingFrame());
    expect(shouldStart.value).toBeFalsy();

    await strategy.processFrame(new VADUserStartedSpeakingFrame());
    expect(shouldStart.value).toBeTruthy();
  });
});

describe("TestTranscriptionUserTurnStartStrategy", () => {
  test("test_transcription_strategy", async () => {
    const strategy = new TranscriptionUserTurnStartStrategy();
    const shouldStart = captureShouldStart(strategy);

    await strategy.processFrame(new VADUserStartedSpeakingFrame());
    expect(shouldStart.value).toBeFalsy();

    await strategy.processFrame(
      new TranscriptionFrame({ text: "Hello!", userId: "", timestamp: "now" }),
    );
    expect(shouldStart.value).toBeTruthy();
  });
});

function captureParams(strategy: BaseUserTurnStartStrategy): UserTurnStartedParams[] {
  const captured: UserTurnStartedParams[] = [];
  strategy.eventHandler(
    "on_user_turn_started",
    async (_strategy, params: UserTurnStartedParams) => {
      captured.push(params);
    },
  );
  return captured;
}

describe("TestExternalUserTurnStartStrategy", () => {
  test("test_external_strategy", async () => {
    const strategy = new ExternalUserTurnStartStrategy();
    const captured = captureParams(strategy);

    await strategy.processFrame(new VADUserStartedSpeakingFrame());
    expect(captured.length > 0).toBe(false);

    await strategy.processFrame(new UserStartedSpeakingFrame());
    expect(captured.length > 0).toBe(true);
  });

  test("test_proposal_starts_the_turn_with_emission_enabled", async () => {
    const strategy = new ExternalUserTurnStartStrategy();
    const captured = captureParams(strategy);

    await strategy.processFrame(new ProposedUserStartedSpeakingFrame());
    expect(captured.length).toEqual(1);
    expect(captured[0]!.enableUserSpeakingFrames).toBe(true);
    expect(captured[0]!.enableInterruptions).toBe(true);
  });

  test("test_real_turn_frame_starts_the_turn_with_emission_suppressed", async () => {
    const strategy = new ExternalUserTurnStartStrategy();
    const captured = captureParams(strategy);

    await strategy.processFrame(new UserStartedSpeakingFrame());
    expect(captured.length).toEqual(1);
    expect(captured[0]!.enableUserSpeakingFrames).toBe(false);
    expect(captured[0]!.enableInterruptions).toBe(false);
  });

  // Construction settings shape the decide path; the adopt path always suppresses.
  test("test_configured_flags_apply_to_proposals_only", async () => {
    const strategy = new ExternalUserTurnStartStrategy({ enableInterruptions: false });
    const captured = captureParams(strategy);

    await strategy.processFrame(new ProposedUserStartedSpeakingFrame());
    expect(captured[0]!.enableInterruptions).toBe(false);
    expect(captured[0]!.enableUserSpeakingFrames).toBe(true);

    await strategy.processFrame(new UserStartedSpeakingFrame());
    expect(captured[1]!.enableInterruptions).toBe(false);
    expect(captured[1]!.enableUserSpeakingFrames).toBe(false);
  });
});

describe("TestBaseUserTurnStartStrategyDeprecations", () => {
  // Skipped: exercises the deprecated `enable_user_speaking_frames` constructor
  // argument, which is not ported.
  test.skip("test_enable_user_speaking_frames_warns", () => {});

  // Skipped: exercises the deprecated `enable_user_speaking_frames` constructor
  // argument, which is not ported.
  test.skip("test_enable_user_speaking_frames_applies", () => {});

  // The deprecation-warning machinery is not ported; constructing without the
  // deprecated argument must still default to emitting user speaking frames.
  test("test_omitting_enable_user_speaking_frames_is_silent", async () => {
    const strategy = new BaseUserTurnStartStrategy();
    const captured = captureParams(strategy);

    await strategy.triggerUserTurnStarted();
    expect(captured[0]!.enableUserSpeakingFrames).toBe(true);
  });
});
