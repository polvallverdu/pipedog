// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// The demo's turn detection, as `userTurnParams` builds it for both modes: Silero VAD tuned against
// background speech, and the start strategy that keeps a TV (words with no speech VAD accepted
// behind them), a backchannel or a couple of words over the bot from interrupting it, and says so
// (the page's "ignored" chip). Then the strip's other events, from `PipelineEventsObserver`. The
// whole pipeline, with real speech through Silero, runs in e2e.test.ts.

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { time } from "@pipedog/asyncio";
import {
  BotStartedSpeakingFrame,
  BotStoppedSpeakingFrame,
  type Frame,
  InterimTranscriptionFrame,
  TranscriptionFrame,
  UserStartedSpeakingFrame,
  UserStoppedSpeakingFrame,
  VADUserStartedSpeakingFrame,
  VADUserStoppedSpeakingFrame,
} from "@pipedog/core/frames/frames";
import type { FramePushed } from "@pipedog/core/observers/base_observer";
import { FrameDirection } from "@pipedog/core/processors/frame_processor";
import { Language } from "@pipedog/core/transcriptions/language";
import {
  ExternalUserTurnStopStrategy,
  TurnAnalyzerUserTurnStopStrategy,
} from "@pipedog/core/turns/user_stop/index";
import { systemPrompt, userTurnParams } from "../src/bot.ts";
import { type Env, parseSttMode, readConfig, type SttMode } from "../src/config.ts";
import {
  type DemoMinWordsUserTurnStartStrategy,
  type IgnoredSpeech,
  type PipelineEvent,
  PipelineEventsObserver,
} from "../src/turn_events.ts";

const model = new Uint8Array(
  readFileSync(Bun.resolveSync("@pipedog/audio-silero/silero_vad.onnx", import.meta.dir)),
);
const ai = { run: async () => ({ is_complete: true, probability: 0.9 }) };

function build(env: Partial<Env> = {}, stt: SttMode = "nova3") {
  const config = readConfig(env as Env);
  const ignored: IgnoredSpeech[] = [];
  const params = userTurnParams(ai, model, config.turns, stt, async (i) => {
    ignored.push(i);
  });
  const start = params.userTurnStrategies!.start![0] as DemoMinWordsUserTurnStartStrategy;
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
  return { params, start, startsTurn, ignored };
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

test("Flux decides the end of the turn itself; the start is gated the same way", () => {
  const { params } = build({}, "flux");
  const stop = params.userTurnStrategies!.stop!;
  expect(stop).toHaveLength(1);
  expect(stop[0]).toBeInstanceOf(ExternalUserTurnStopStrategy);
  // No start strategy resolves Flux's proposed starts: Flux hearing a TV doesn't open a turn.
  for (const s of params.userTurnStrategies!.start!) {
    expect(s.resolvesProposedTurnStartFrames).toBe(false);
  }
  expect(params.vadAnalyzer).toBeDefined();
});

test("the mode: anything but nova3 is Flux, and the prompt describes the one in use", () => {
  expect(parseSttMode("nova3")).toBe("nova3");
  for (const other of ["flux", "", "NOVA3", "whisper", undefined, null, 3, {}]) {
    expect(parseSttMode(other)).toBe("flux");
  }
  expect(systemPrompt("flux")).toContain("Deepgram Flux");
  expect(systemPrompt("flux")).not.toContain("Nova-3");
  expect(systemPrompt("nova3")).toContain("Nova-3");
  expect(systemPrompt("nova3")).toContain("Spanish");
  for (const stt of ["flux", "nova3"] as const) expect(systemPrompt(stt)).not.toMatch(/\{\w+\}/);
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
  const { startsTurn, ignored } = build();
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

  // Each was reported once, with why (the interim and the final of the TV are one report).
  expect(ignored.map((i) => i.reason)).toEqual(["background", "backchannel", "too_few_words"]);
  expect(ignored[0]!.text).toBe("and now the weather for");
  expect(ignored[1]!.text).toBe("okay, sure");
});

test("over the bot, a first word before VAD confirms the speech is too few words, not background", async () => {
  const { startsTurn, ignored } = build({}, "flux");
  await startsTurn(new BotStartedSpeakingFrame());
  expect(await startsTurn(saying("What"))).toBe(false);
  expect(ignored.map((i) => i.reason)).toEqual(["too_few_words"]);
});

test("with the bot quiet, nothing is reported as ignored", async () => {
  const { startsTurn, ignored } = build({}, "flux");
  expect(await startsTurn(said("hello there"))).toBe(true);
  expect(ignored).toEqual([]);
});

test("with the bot quiet, the turn starts on VAD, before any transcript", async () => {
  const { startsTurn } = build();
  await startsTurn(new BotStartedSpeakingFrame());
  await startsTurn(new BotStoppedSpeakingFrame());
  expect(await startsTurn(new VADUserStartedSpeakingFrame())).toBe(true);
});

test("the strip's events: VAD, the turn decision, interruptions", async () => {
  const events: PipelineEvent[] = [];
  const observer = new PipelineEventsObserver("Flux", async (e) => {
    events.push(e);
  });
  const push = (frame: Frame) =>
    observer.onPushFrame({
      source: null,
      destination: null,
      frame,
      direction: FrameDirection.DOWNSTREAM,
      timestamp: 0,
    } as unknown as FramePushed);

  await push(new VADUserStartedSpeakingFrame());
  await push(new UserStartedSpeakingFrame());
  // VAD reports the stop 0.2 s after the speech ended; the turn ends 0.3 s after that.
  await push(new VADUserStoppedSpeakingFrame({ stopSecs: 0.2, timestamp: time() - 0.3 }));
  await push(new UserStoppedSpeakingFrame());
  expect(events.slice(0, 2)).toEqual([
    { type: "vad", speaking: true },
    { type: "vad", speaking: false },
  ]);
  const decided = events[2] as Extract<PipelineEvent, { type: "turn-decided" }>;
  expect(decided.type).toBe("turn-decided");
  expect(decided.by).toBe("Flux");
  expect(decided.ms).toBeGreaterThanOrEqual(490);
  expect(decided.ms).toBeLessThan(1500);
  // No interruption: the bot wasn't speaking.
  expect(events.some((e) => e.type === "interrupted")).toBe(false);

  // A turn that starts while the bot speaks is an interruption.
  await push(new BotStartedSpeakingFrame());
  await push(new UserStartedSpeakingFrame());
  expect(events.at(-1)).toEqual({ type: "interrupted" });
  await push(new BotStoppedSpeakingFrame());
  await push(new UserStartedSpeakingFrame());
  expect(events.filter((e) => e.type === "interrupted")).toHaveLength(1);
});
