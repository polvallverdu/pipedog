// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

import { describe, expect, test } from "bun:test";
import { time } from "@pipedog/asyncio";

import {
  BotStartedSpeakingFrame,
  BotStoppedSpeakingFrame,
  EndWorkerFrame,
  ErrorFrame,
  type Frame,
  InputAudioRawFrame,
  InterruptionFrame,
  StopWorkerFrame,
  TranscriptionFrame,
  VADUserStartedSpeakingFrame,
  VADUserStoppedSpeakingFrame,
} from "../src/frames/frames.ts";
import { Language } from "../src/transcriptions/language.ts";
import { EndingUserMuteStrategy, OpeningUserMuteStrategy } from "../src/turns/user_mute/index.ts";
import {
  BACKCHANNEL_PHRASES,
  createBackchannelMatcher,
  MinWordsUserTurnStartStrategy,
} from "../src/turns/user_start/index.ts";

function captureStarts(strategy: MinWordsUserTurnStartStrategy): { count: number } {
  const starts = { count: 0 };
  strategy.eventHandler("on_user_turn_started", async () => {
    starts.count += 1;
  });
  return starts;
}

/** Process `frame` and say whether it made the strategy report a turn start. */
async function reports(
  strategy: MinWordsUserTurnStartStrategy,
  starts: { count: number },
  frame: Frame,
): Promise<boolean> {
  const before = starts.count;
  await strategy.processFrame(frame);
  return starts.count > before;
}

function transcription(text: string, language: Language | null = null): TranscriptionFrame {
  return new TranscriptionFrame({ text, userId: "cat", timestamp: "", language });
}

describe("MinWordsUserTurnStartStrategy options", () => {
  test("by default VAD alone never starts the turn", async () => {
    const strategy = new MinWordsUserTurnStartStrategy({ minWords: 3 });
    const starts = captureStarts(strategy);

    expect(await reports(strategy, starts, new VADUserStartedSpeakingFrame())).toBe(false);
    expect(starts.count).toBe(0);
  });

  test("startOnVadWhenBotQuiet starts on VAD only while the bot is quiet", async () => {
    const strategy = new MinWordsUserTurnStartStrategy({
      minWords: 3,
      startOnVadWhenBotQuiet: true,
    });
    const starts = captureStarts(strategy);

    expect(await reports(strategy, starts, new VADUserStartedSpeakingFrame())).toBe(true);
    expect(starts.count).toBe(1);

    await strategy.processFrame(new BotStartedSpeakingFrame());
    expect(await reports(strategy, starts, new VADUserStartedSpeakingFrame())).toBe(false);
    expect(await reports(strategy, starts, transcription("yes"))).toBe(false);
    expect(starts.count).toBe(1);
    expect(await reports(strategy, starts, transcription("wait a second"))).toBe(true);
    expect(starts.count).toBe(2);

    await strategy.processFrame(new BotStoppedSpeakingFrame());
    expect(await reports(strategy, starts, new VADUserStartedSpeakingFrame())).toBe(true);
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

  test("isBackchannel: a backchannel over the bot never starts a turn", async () => {
    const strategy = new MinWordsUserTurnStartStrategy({
      minWords: 2,
      isBackchannel: createBackchannelMatcher(),
    });
    const starts = captureStarts(strategy);

    await strategy.processFrame(new BotStartedSpeakingFrame());
    expect(await reports(strategy, starts, transcription("Yes, okay."))).toBe(false);
    expect(await reports(strategy, starts, transcription("Mm-hm, right"))).toBe(false);
    expect(starts.count).toBe(0);
    expect(await reports(strategy, starts, transcription("yes, but what about Friday?"))).toBe(
      true,
    );
    expect(starts.count).toBe(1);

    // With the bot quiet, a backchannel is an answer and starts the turn.
    await strategy.processFrame(new BotStoppedSpeakingFrame());
    expect(await reports(strategy, starts, transcription("yes okay"))).toBe(true);
    expect(starts.count).toBe(2);
  });

  test("createBackchannelMatcher picks the transcript's language", () => {
    const isBackchannel = createBackchannelMatcher();
    expect(isBackchannel("Sí, vale, de acuerdo", Language.ES_ES)).toBe(true);
    expect(isBackchannel("vale", Language.EN_US)).toBe(false);
    expect(isBackchannel("vale", null)).toBe(true);
    expect(isBackchannel("no", null)).toBe(false);
    expect(isBackchannel("", null)).toBe(false);
    expect(isBackchannel("okay let's go", Language.EN)).toBe(false);

    const custom = createBackchannelMatcher({ en: [...(BACKCHANNEL_PHRASES.en ?? []), "gotcha"] });
    expect(custom("gotcha, sure", Language.EN)).toBe(true);
  });

  test("requireVadWithinSeconds: words over the bot need recent speech", async () => {
    const strategy = new MinWordsUserTurnStartStrategy({
      minWords: 2,
      requireVadWithinSeconds: 1.0,
    });
    const starts = captureStarts(strategy);

    await strategy.processFrame(new BotStartedSpeakingFrame());
    // No VAD at all: a background TV.
    expect(await reports(strategy, starts, transcription("and now the weather"))).toBe(false);
    // VAD stopped long ago.
    await strategy.processFrame(new VADUserStartedSpeakingFrame());
    await strategy.processFrame(new VADUserStoppedSpeakingFrame({ timestamp: time() - 5 }));
    expect(await reports(strategy, starts, transcription("and now the weather"))).toBe(false);
    expect(starts.count).toBe(0);

    // VAD hears the user now.
    await strategy.processFrame(new VADUserStartedSpeakingFrame());
    expect(await reports(strategy, starts, transcription("hold on please"))).toBe(true);
    expect(starts.count).toBe(1);

    // The final transcript arrives just after VAD stopped.
    await strategy.processFrame(new BotStartedSpeakingFrame());
    await strategy.processFrame(new VADUserStoppedSpeakingFrame());
    expect(await reports(strategy, starts, transcription("hold on please"))).toBe(true);
    expect(starts.count).toBe(2);

    // With the bot quiet, there is no check.
    await strategy.processFrame(new BotStoppedSpeakingFrame());
    await strategy.processFrame(new VADUserStoppedSpeakingFrame({ timestamp: time() - 5 }));
    expect(await reports(strategy, starts, transcription("hello"))).toBe(true);
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
