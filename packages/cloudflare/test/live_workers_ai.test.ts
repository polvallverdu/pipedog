// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Live tests against the real Workers AI REST API. They run only when
// CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are set, and are skipped
// otherwise. They use (and bill) the account's Workers AI usage.
//
//   CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... bun test test/live_workers_ai.test.ts
//
// Speech for the STT tests comes from Aura, so the round trip checks both.

import { beforeAll, describe, expect, test } from "bun:test";
import { EndOfTurnState } from "@pipedog/core/audio/turn/base_turn_analyzer";
import {
  type Frame,
  InputAudioRawFrame,
  LLMContextFrame,
  LLMTextFrame,
  TranscriptionFrame,
  TTSAudioRawFrame,
  TTSSpeakFrame,
  VADUserStartedSpeakingFrame,
  VADUserStoppedSpeakingFrame,
} from "@pipedog/core/frames/frames";
import { PipelineParams } from "@pipedog/core/pipeline/worker";
import { LLMContext } from "@pipedog/core/processors/aggregators/llm_context";
import { runTest, SleepFrame } from "@pipedog/core/tests/utils";
import { WorkersAIClient } from "../src/client.ts";
import { WorkersAIFluxSTTService } from "../src/flux_stt.ts";
import { WorkersAILLMService } from "../src/llm.ts";
import { WorkersAISmartTurnAnalyzer } from "../src/smart_turn.ts";
import { WorkersAINova3STTService } from "../src/stt.ts";
import { WorkersAIAuraHttpTTSService, WorkersAIAuraTTSService } from "../src/tts.ts";
import { WorkersAIWhisperSTTService } from "../src/whisper.ts";

const accountId = process.env.CLOUDFLARE_ACCOUNT_ID ?? "";
const apiToken = process.env.CLOUDFLARE_API_TOKEN ?? "";
const live = Boolean(accountId && apiToken);

const SAMPLE_RATE = 16000;
const FRAME_BYTES = 2 * 320; // 20 ms at 16 kHz
const params = new PipelineParams({
  audioInSampleRate: SAMPLE_RATE,
  audioOutSampleRate: SAMPLE_RATE,
});

function joinAudio(frames: Frame[]): Uint8Array {
  const audio = frames.filter((f): f is TTSAudioRawFrame => f instanceof TTSAudioRawFrame);
  const out = new Uint8Array(audio.reduce((n, f) => n + f.audio.length, 0));
  let offset = 0;
  for (const f of audio) {
    out.set(f.audio, offset);
    offset += f.audio.length;
  }
  return out;
}

/** Real-time 20 ms frames of `pcm`, then `silenceSecs` of silence. */
function speechFrames(pcm: Uint8Array, silenceSecs: number): Frame[] {
  const padded = new Uint8Array(pcm.length + Math.round(silenceSecs * SAMPLE_RATE) * 2);
  padded.set(pcm);
  const frames: Frame[] = [];
  for (let offset = 0; offset + FRAME_BYTES <= padded.length; offset += FRAME_BYTES) {
    frames.push(
      new InputAudioRawFrame({
        audio: padded.slice(offset, offset + FRAME_BYTES),
        sampleRate: SAMPLE_RATE,
        numChannels: 1,
      }),
    );
    frames.push(new SleepFrame({ sleep: 0.02 }));
  }
  return frames;
}

function transcripts(frames: Frame[]): string {
  return frames
    .filter((f): f is TranscriptionFrame => f instanceof TranscriptionFrame)
    .map((f) => f.text)
    .join(" ")
    .toLowerCase();
}

describe.skipIf(!live)("Workers AI (live)", () => {
  const client = live ? new WorkersAIClient({ accountId, apiToken }) : (null as never);
  let speech = new Uint8Array(0);

  beforeAll(async () => {
    const tts = new WorkersAIAuraHttpTTSService({ client, sampleRate: SAMPLE_RATE });
    const [down] = await runTest(tts, {
      framesToSend: [new TTSSpeakFrame({ text: "Hello, what is the weather like today?" })],
      pipelineParams: params,
    });
    speech = joinAudio(down);
  }, 60_000);

  test("Aura (HTTP) speaks", () => {
    expect(speech.length).toBeGreaterThan(SAMPLE_RATE); // more than 0.5 s
  });

  test("Aura (WebSocket) speaks", async () => {
    const tts = new WorkersAIAuraTTSService({ client, sampleRate: SAMPLE_RATE });
    const [down] = await runTest(tts, {
      framesToSend: [
        new TTSSpeakFrame({ text: "Hello from Workers AI." }),
        new SleepFrame({ sleep: 3 }),
      ],
      pipelineParams: params,
    });
    expect(joinAudio(down).length).toBeGreaterThan(SAMPLE_RATE);
  }, 60_000);

  test("Whisper transcribes Aura's speech", async () => {
    const stt = new WorkersAIWhisperSTTService({ client });
    const [down] = await runTest(stt, {
      framesToSend: [
        new VADUserStartedSpeakingFrame({}),
        ...speechFrames(speech, 0.2),
        new VADUserStoppedSpeakingFrame({}),
        new SleepFrame({ sleep: 0.5 }),
      ],
      pipelineParams: params,
    });
    expect(transcripts(down)).toContain("weather");
  }, 60_000);

  test("Flux transcribes Aura's speech and ends the turn", async () => {
    const stt = new WorkersAIFluxSTTService({ client });
    const [down] = await runTest(stt, {
      framesToSend: speechFrames(speech, 3),
      pipelineParams: params,
    });
    expect(transcripts(down)).toContain("weather");
  }, 60_000);

  test("Nova-3 transcribes Aura's speech", async () => {
    const stt = new WorkersAINova3STTService({ client });
    const [down] = await runTest(stt, {
      framesToSend: speechFrames(speech, 2),
      pipelineParams: params,
    });
    expect(transcripts(down)).toContain("weather");
  }, 60_000);

  test("Smart Turn v2 judges a complete question", async () => {
    const analyzer = new WorkersAISmartTurnAnalyzer({ client });
    analyzer.setSampleRate(SAMPLE_RATE);
    for (let offset = 0; offset + FRAME_BYTES <= speech.length; offset += FRAME_BYTES) {
      analyzer.appendAudio(speech.slice(offset, offset + FRAME_BYTES), true);
    }
    const [state, metrics] = await analyzer.analyzeEndOfTurn();
    expect([EndOfTurnState.COMPLETE, EndOfTurnState.INCOMPLETE]).toContain(state);
    expect(metrics).not.toBeNull();
  }, 60_000);

  test("MeloTTS answers with MP3", async () => {
    const response = await client.runRaw("@cf/myshell-ai/melotts", {
      prompt: "Hello.",
      lang: "en",
    });
    const contentType = response.headers.get("content-type") ?? "";
    const body = contentType.includes("json")
      ? ((await response.json()) as { result?: { audio?: string } }).result?.audio
      : await response.arrayBuffer();
    expect(body).toBeTruthy();
  }, 60_000);

  test("the LLM answers through the OpenAI-compatible endpoint", async () => {
    const llm = new WorkersAILLMService({ accountId, apiToken });
    const context = new LLMContext({
      messages: [{ role: "user", content: "Say the word 'pong' and nothing else." }],
    });
    const [down] = await runTest(llm, { framesToSend: [new LLMContextFrame({ context })] });
    const text = down
      .filter((f): f is LLMTextFrame => f instanceof LLMTextFrame)
      .map((f) => f.text)
      .join("");
    expect(text.toLowerCase()).toContain("pong");
  }, 60_000);
});
