// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

import { describe, expect, test } from "bun:test";

import {
  BotStartedSpeakingFrame,
  BotStoppedSpeakingFrame,
  EndWorkerFrame,
  ErrorFrame,
  InputAudioRawFrame,
  InterruptionFrame,
  StopWorkerFrame,
  TranscriptionFrame,
  VADUserStartedSpeakingFrame,
} from "../src/frames/frames.ts";
import { ProcessFrameResult } from "../src/turns/types.ts";
import { EndingUserMuteStrategy, OpeningUserMuteStrategy } from "../src/turns/user_mute/index.ts";
import { MinWordsUserTurnStartStrategy } from "../src/turns/user_start/index.ts";

function captureStarts(strategy: MinWordsUserTurnStartStrategy): { count: number } {
  const starts = { count: 0 };
  strategy.eventHandler("on_user_turn_started", async () => {
    starts.count += 1;
  });
  return starts;
}

function transcription(text: string): TranscriptionFrame {
  return new TranscriptionFrame({ text, userId: "cat", timestamp: "" });
}

describe("MinWordsUserTurnStartStrategy options", () => {
  test("by default VAD alone never starts the turn", async () => {
    const strategy = new MinWordsUserTurnStartStrategy({ minWords: 3 });
    const starts = captureStarts(strategy);

    expect(await strategy.processFrame(new VADUserStartedSpeakingFrame())).toBe(
      ProcessFrameResult.CONTINUE,
    );
    expect(starts.count).toBe(0);
  });

  test("startOnVadWhenBotQuiet starts on VAD only while the bot is quiet", async () => {
    const strategy = new MinWordsUserTurnStartStrategy({
      minWords: 3,
      startOnVadWhenBotQuiet: true,
    });
    const starts = captureStarts(strategy);

    expect(await strategy.processFrame(new VADUserStartedSpeakingFrame())).toBe(
      ProcessFrameResult.STOP,
    );
    expect(starts.count).toBe(1);

    await strategy.processFrame(new BotStartedSpeakingFrame());
    expect(await strategy.processFrame(new VADUserStartedSpeakingFrame())).toBe(
      ProcessFrameResult.CONTINUE,
    );
    expect(await strategy.processFrame(transcription("yes"))).toBe(ProcessFrameResult.CONTINUE);
    expect(starts.count).toBe(1);
    expect(await strategy.processFrame(transcription("wait a second"))).toBe(
      ProcessFrameResult.STOP,
    );
    expect(starts.count).toBe(2);

    await strategy.processFrame(new BotStoppedSpeakingFrame());
    expect(await strategy.processFrame(new VADUserStartedSpeakingFrame())).toBe(
      ProcessFrameResult.STOP,
    );
    expect(starts.count).toBe(3);
  });

  test("by default a turn start forgets the bot is speaking", async () => {
    const strategy = new MinWordsUserTurnStartStrategy({ minWords: 3 });
    const starts = captureStarts(strategy);

    await strategy.processFrame(new BotStartedSpeakingFrame());
    await strategy.handleUserTurnStarted();
    await strategy.processFrame(transcription("yes"));
    expect(starts.count).toBe(1);
  });

  test("keepBotSpeakingOnTurnStart keeps the minimum while the bot speaks", async () => {
    const strategy = new MinWordsUserTurnStartStrategy({
      minWords: 3,
      keepBotSpeakingOnTurnStart: true,
    });
    const starts = captureStarts(strategy);

    await strategy.processFrame(new BotStartedSpeakingFrame());
    await strategy.handleUserTurnStarted();
    await strategy.processFrame(transcription("yes"));
    expect(starts.count).toBe(0);

    await strategy.processFrame(new BotStoppedSpeakingFrame());
    await strategy.processFrame(transcription("yes"));
    expect(starts.count).toBe(1);
  });
});

function fakeClock(): { now: number; clock: () => number } {
  const state = { now: 0, clock: () => state.now };
  return state;
}

function inputAudio(): InputAudioRawFrame {
  return new InputAudioRawFrame({ audio: new Uint8Array(320), sampleRate: 16000, numChannels: 1 });
}

describe("TestOpeningUserMuteStrategy", () => {
  test("mutes until the first speech ends", async () => {
    const time = fakeClock();
    const strategy = new OpeningUserMuteStrategy({ maxSeconds: 3, clock: time.clock });

    expect(await strategy.processFrame(inputAudio())).toBe(true);
    expect(await strategy.processFrame(new BotStartedSpeakingFrame())).toBe(true);
    time.now = 1;
    expect(await strategy.processFrame(inputAudio())).toBe(true);
    expect(await strategy.processFrame(new BotStoppedSpeakingFrame())).toBe(false);
    expect(await strategy.processFrame(new BotStartedSpeakingFrame())).toBe(false);
    expect(await strategy.processFrame(new InterruptionFrame())).toBe(false);
  });

  test("unmutes once the first speech has played for maxSeconds", async () => {
    const time = fakeClock();
    const strategy = new OpeningUserMuteStrategy({ maxSeconds: 3, clock: time.clock });

    time.now = 10;
    expect(await strategy.processFrame(inputAudio())).toBe(true);
    time.now = 20;
    expect(await strategy.processFrame(new BotStartedSpeakingFrame())).toBe(true);
    time.now = 22.9;
    expect(await strategy.processFrame(inputAudio())).toBe(true);
    time.now = 23;
    expect(await strategy.processFrame(inputAudio())).toBe(false);
    expect(await strategy.processFrame(new BotStoppedSpeakingFrame())).toBe(false);
    expect(await strategy.processFrame(new BotStartedSpeakingFrame())).toBe(false);
  });

  test("unmutes when the first speech fails before any audio", async () => {
    const strategy = new OpeningUserMuteStrategy({ maxSeconds: 3, clock: () => 0 });

    expect(await strategy.processFrame(inputAudio())).toBe(true);
    expect(await strategy.processFrame(new ErrorFrame({ error: "TTS failed" }))).toBe(false);
  });
});

describe("TestEndingUserMuteStrategy", () => {
  test("mutes for good after an EndWorkerFrame", async () => {
    const strategy = new EndingUserMuteStrategy();

    expect(await strategy.processFrame(inputAudio())).toBe(false);
    expect(await strategy.processFrame(new EndWorkerFrame())).toBe(true);
    expect(await strategy.processFrame(new BotStoppedSpeakingFrame())).toBe(true);
    expect(await strategy.processFrame(inputAudio())).toBe(true);
  });

  test("mutes after a StopWorkerFrame", async () => {
    const strategy = new EndingUserMuteStrategy();
    expect(await strategy.processFrame(new StopWorkerFrame())).toBe(true);
  });

  test("mutes once isEnding returns true", async () => {
    let ending = false;
    const strategy = new EndingUserMuteStrategy({ isEnding: () => ending });

    expect(await strategy.processFrame(inputAudio())).toBe(false);
    ending = true;
    expect(await strategy.processFrame(inputAudio())).toBe(true);
    ending = false;
    expect(await strategy.processFrame(inputAudio())).toBe(true);
  });

  test("mutes after end()", async () => {
    const strategy = new EndingUserMuteStrategy();
    strategy.end();
    expect(await strategy.processFrame(inputAudio())).toBe(true);
  });
});
