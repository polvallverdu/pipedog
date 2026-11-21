// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// The demo's turn detection, as `userTurnParams` builds it: Silero VAD tuned against background
// speech, and the start strategy that keeps a TV (words with no speech VAD accepted behind them),
// a backchannel or a couple of words over the bot from interrupting it. The whole pipeline, with
// real speech through Silero, runs in e2e.test.ts.

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { time } from "@pipedog/asyncio";
import {
  BotStartedSpeakingFrame,
  BotStoppedSpeakingFrame,
  type Frame,
  InterimTranscriptionFrame,
  TranscriptionFrame,
  VADUserStartedSpeakingFrame,
  VADUserStoppedSpeakingFrame,
} from "@pipedog/core/frames/frames";
import { Language } from "@pipedog/core/transcriptions/language";
import type { MinWordsUserTurnStartStrategy } from "@pipedog/core/turns/user_start/index";
import { TurnAnalyzerUserTurnStopStrategy } from "@pipedog/core/turns/user_stop/index";
import { userTurnParams } from "../src/bot.ts";
import { type Env, readConfig } from "../src/config.ts";

const model = new Uint8Array(
  readFileSync(Bun.resolveSync("@pipedog/audio-silero/silero_vad.onnx", import.meta.dir)),
);
const ai = { run: async () => ({ is_complete: true, probability: 0.9 }) };

function build(env: Partial<Env> = {}) {
  const config = readConfig(env as Env);
  const params = userTurnParams(ai, model, config.turns);
  const start = params.userTurnStrategies!.start![0] as MinWordsUserTurnStartStrategy;
  const starts = { count: 0 };
  start.eventHandler("on_user_turn_started", async () => {
    starts.count += 1;
  });
  /** Process `frame` and say whether it started the user's turn. */
  const startsTurn = async (frame: Frame) => {
    const before = starts.count;
    await start.processFrame(frame);
    return starts.count > before;
  };
  return { params, start, startsTurn };
}

const said = (text: string, language: Language | null = Language.EN) =>
  new TranscriptionFrame({ text, userId: "user", timestamp: "", language });
const saying = (text: string) =>
  new InterimTranscriptionFrame({ text, userId: "user", timestamp: "", language: Language.EN });

test("Silero is stricter than the defaults about what counts as the user speaking", () => {
  const { params } = build();
  const vad = params.vadAnalyzer!.params;
  expect(vad.confidence).toBe(0.75);
  expect(vad.startSecs).toBe(0.25);
  expect(vad.stopSecs).toBe(0.2);
  expect(vad.minVolumeDb).toBeCloseTo(-42, 5);
  // Smart Turn decides when the turn ends.
  const stop = params.userTurnStrategies!.stop!;
  expect(stop).toHaveLength(1);
  expect(stop[0]).toBeInstanceOf(TurnAnalyzerUserTurnStopStrategy);
});

test("the tuning comes from the Worker's vars", () => {
  const { params } = build({
    VAD_CONFIDENCE: "0.8",
    VAD_START_SECS: "0.3",
    VAD_MIN_VOLUME_DB: "-38",
    INTERRUPT_MIN_WORDS: "4",
  });
  const vad = params.vadAnalyzer!.params;
  expect(vad.confidence).toBe(0.8);
  expect(vad.startSecs).toBe(0.3);
  expect(vad.minVolumeDb).toBeCloseTo(-38, 5);
});

test("over the bot: a TV, a backchannel or two words don't interrupt; three heard words do", async () => {
  const { startsTurn } = build();
  await startsTurn(new BotStartedSpeakingFrame());

  // Background speech the VAD rejected (too quiet, too short): Nova-3 still transcribes it.
  expect(await startsTurn(saying("and now the weather for"))).toBe(false);
  expect(await startsTurn(said("and now the weather for the weekend"))).toBe(false);
  // VAD that stopped long ago doesn't count either.
  await startsTurn(new VADUserStartedSpeakingFrame());
  await startsTurn(new VADUserStoppedSpeakingFrame({ timestamp: time() - 5 }));
  expect(await startsTurn(said("and now the weather"))).toBe(false);

  // The user, heard by VAD: an acknowledgement, in English or Spanish, is not a turn.
  await startsTurn(new VADUserStartedSpeakingFrame());
  expect(await startsTurn(said("okay, sure"))).toBe(false);
  expect(await startsTurn(said("vale, sí", Language.ES))).toBe(false);
  // Two words aren't enough to cut the bot off.
  expect(await startsTurn(said("wait, no"))).toBe(false);
  // Three are.
  expect(await startsTurn(saying("wait, what about"))).toBe(true);
});

test("with the bot quiet, the turn starts on VAD, before any transcript", async () => {
  const { startsTurn } = build();
  await startsTurn(new BotStartedSpeakingFrame());
  await startsTurn(new BotStoppedSpeakingFrame());
  expect(await startsTurn(new VADUserStartedSpeakingFrame())).toBe(true);
});
