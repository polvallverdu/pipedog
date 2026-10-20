// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipecat-ts contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_turn_start_vad_state.py

/**
 * Integration tests for the VAD state `TurnAnalyzerUserTurnStopStrategy` keeps.
 *
 * VAD emits `VADUserStartedSpeakingFrame` / `VADUserStoppedSpeakingFrame` only
 * on transitions, so the strategy carries that state between them. A turn can
 * start from a transcript rather than from a VAD frame — mid-utterance, or for
 * speech VAD never reported at all — and the end-of-turn decision has to hold up
 * either way.
 *
 * The tests drive real pipeline processors: a real input transport with its audio
 * filter, and the real aggregator, controller and strategies.
 */

import { describe, expect, test } from "bun:test";

import { monotonic } from "@pipecat-ts/asyncio";

import { BaseAudioFilter } from "../src/audio/filters/base_audio_filter.ts";
import {
  BaseSmartTurn,
  SmartTurnParams,
  type SmartTurnPrediction,
} from "../src/audio/turn/smart_turn/base_smart_turn.ts";
import { VADAnalyzer, VADParams, type VADState } from "../src/audio/vad/vad_analyzer.ts";
import {
  type FilterControlFrame,
  type Frame,
  InputAudioRawFrame,
  LLMContextFrame,
  STTMetadataFrame,
  type StartFrame,
  TranscriptionFrame,
} from "../src/frames/frames.ts";
import { Pipeline } from "../src/pipeline/pipeline.ts";
import { LLMContext } from "../src/processors/aggregators/llm_context.ts";
import {
  LLMUserAggregator,
  LLMUserAggregatorParams,
} from "../src/processors/aggregators/llm_response_universal.ts";
import { runTest, SleepFrame } from "../src/tests/utils.ts";
import { BaseInputTransport } from "../src/transports/base_input.ts";
import { TransportParams } from "../src/transports/base_transport.ts";
import {
  type BaseUserTurnStartStrategy,
  MinWordsUserTurnStartStrategy,
  TranscriptionUserTurnStartStrategy,
  VADUserTurnStartStrategy,
} from "../src/turns/user_start/index.ts";
import { TurnAnalyzerUserTurnStopStrategy } from "../src/turns/user_stop/index.ts";
import { UserTurnStrategies } from "../src/turns/user_turn_strategies.ts";
import { timeNowIso8601 } from "../src/utils/time.ts";

const SAMPLE_RATE = 16000;
const FRAME_MS = 20;
const FRAME_SAMPLES = (SAMPLE_RATE * FRAME_MS) / 1000;

const DEEPGRAM_TTFS_P99 = 0.35;

// Kept short so a test can show a turn ending well inside it.
const WATCHDOG_TIMEOUT = 2.0;

// Audio is fed in short runs separated by sleeps, so the pipeline stays drained
// and frame ordering doesn't depend on how fast the host happens to be. VAD is
// frame-driven, so pausing the feed does not advance it toward a stop.
const AUDIO_RUN_SECS = 0.5;
const DRAIN_SECS = 0.4;

// One continuous utterance, split by the STT endpointer into four finalized
// transcripts.
const FRAGMENTS = [
  "Yes. I am ready to get started. I have my coffee.",
  "I've got",
  "a bunch of notes around me.",
  "I've got all of my notes here.",
];

/** Input filter that leaves audio untouched. */
class PassthroughFilter extends BaseAudioFilter {
  async start(_sampleRate: number): Promise<void> {}

  async stop(): Promise<void> {}

  async processFrame(_frame: FilterControlFrame): Promise<void> {}

  async filter(audio: Uint8Array): Promise<Uint8Array> {
    return audio;
  }
}

/**
 * Input filter that attenuates everything to silence.
 *
 * Models noise cancellation that removes the speaker. With transport-side
 * transcription the service still transcribes the published track, so
 * transcripts keep arriving while the pipeline's audio goes quiet.
 */
class SuppressingFilter extends PassthroughFilter {
  override async filter(audio: Uint8Array): Promise<Uint8Array> {
    return new Uint8Array(audio.length);
  }
}

/**
 * VAD analyzer driven by frame energy instead of an ML model.
 *
 * Runs the real `VADAnalyzer` state machine; only the per-frame confidence is
 * deterministic.
 */
class EnergyVADAnalyzer extends VADAnalyzer {
  /**
   * Analyze inline rather than on the analyzer's thread-pool executor.
   *
   * A thread hop per 20 ms frame is enough to leave transcripts queued behind
   * the audio on a busy host, which changes the frame ordering these tests
   * depend on.
   */
  override async analyzeAudio(buffer: Uint8Array): Promise<VADState> {
    return this._runAnalyzer(buffer);
  }

  numFramesRequired(): number {
    return FRAME_SAMPLES;
  }

  voiceConfidence(buffer: Uint8Array): number {
    const samples = new Int16Array(
      buffer.buffer,
      buffer.byteOffset,
      Math.floor(buffer.byteLength / 2),
    );
    if (samples.length === 0) {
      return 0.0;
    }
    let sumSquares = 0;
    for (const s of samples) {
      sumSquares += s * s;
    }
    const rms = Math.sqrt(sumSquares / samples.length) / 32768.0;
    return rms > 0.05 ? 1.0 : 0.0;
  }
}

/**
 * Smart turn analyzer with a deterministic model call.
 *
 * Always predicts "incomplete", so any end-of-turn in these tests comes from
 * the analyzer's silence timeout or from the strategy, never from the model.
 */
class StubSmartTurn extends BaseSmartTurn {
  protected override async _predictEndpoint(
    _audioArray: Float32Array,
  ): Promise<SmartTurnPrediction> {
    return { prediction: 0, probability: 0.0 };
  }
}

/** Smart turn analyzer that always predicts the turn is complete. */
class CompletingSmartTurn extends BaseSmartTurn {
  protected override async _predictEndpoint(
    _audioArray: Float32Array,
  ): Promise<SmartTurnPrediction> {
    return { prediction: 1, probability: 1.0 };
  }
}

/**
 * Input transport that reports itself ready as soon as it starts.
 *
 * Concrete transports call `setTransportReady` once connected; there is no
 * connection to wait on here.
 */
class ReadyInputTransport extends BaseInputTransport {
  override async start(frame: StartFrame): Promise<void> {
    await super.start(frame);
    await this.setTransportReady(frame);
  }
}

/**
 * Deterministic seeded PRNG (mulberry32). Upstream uses
 * `np.random.default_rng(0)`; only the energy of the samples matters here.
 */
function _rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function _speechAudio(seconds: number): InputAudioRawFrame[] {
  const rng = _rng(0);
  const count = Math.floor((seconds * 1000) / FRAME_MS);
  return Array.from({ length: count }, () => {
    const samples = new Int16Array(FRAME_SAMPLES);
    for (let i = 0; i < FRAME_SAMPLES; i++) {
      // Uniform integers in [-9000, 9000), as `rng.integers(-9000, 9000)`.
      samples[i] = Math.floor(rng() * 18000) - 9000;
    }
    return new InputAudioRawFrame({
      audio: new Uint8Array(samples.buffer),
      sampleRate: SAMPLE_RATE,
      numChannels: 1,
    });
  });
}

function _silentAudio(seconds: number): InputAudioRawFrame[] {
  const count = Math.floor((seconds * 1000) / FRAME_MS);
  return Array.from(
    { length: count },
    () =>
      new InputAudioRawFrame({
        audio: new Uint8Array(FRAME_SAMPLES * 2),
        sampleRate: SAMPLE_RATE,
        numChannels: 1,
      }),
  );
}

/** A finalized transcript as a transport pushes it, bypassing the audio path. */
function _transcript(text: string): TranscriptionFrame {
  const frame = new TranscriptionFrame({
    text,
    userId: "participant",
    timestamp: timeNowIso8601(),
  });
  frame.finalized = true;
  return frame;
}

function _userMessages(context: LLMContext): unknown[] {
  return context.messages
    .filter((m) => (m as { role?: string }).role === "user")
    .map((m) => (m as { content?: unknown }).content);
}

interface RunResult {
  turnStarts: number;
  turnStops: number;
  llmCalls: number;
  userMessages: unknown[];
}

describe("TestTurnStartVADState", () => {
  async function _run(
    startStrategies: BaseUserTurnStartStrategy[],
    audioFilter: BaseAudioFilter | null = null,
  ): Promise<RunResult> {
    const context = new LLMContext();
    const aggregator = new LLMUserAggregator(context, {
      params: new LLMUserAggregatorParams({
        // min_volume is disabled so frame energy alone drives VAD.
        vadAnalyzer: new EnergyVADAnalyzer({
          params: new VADParams({ confidence: 0.7, startSecs: 0.1, stopSecs: 1.4, minVolume: 0.0 }),
        }),
        userTurnStrategies: new UserTurnStrategies({
          start: startStrategies,
          stop: [
            new TurnAnalyzerUserTurnStopStrategy({
              turnAnalyzer: new StubSmartTurn({ params: new SmartTurnParams({ stopSecs: 3.0 }) }),
            }),
          ],
        }),
        userTurnStopTimeout: 600.0,
      }),
    });

    let turnStarts = 0;
    let turnStops = 0;

    aggregator.eventHandler("on_user_turn_started", async (_agg, _strategy) => {
      turnStarts += 1;
    });

    aggregator.eventHandler("on_user_turn_stopped", async (_agg, _strategy, _message) => {
      turnStops += 1;
    });

    const transport = new ReadyInputTransport(
      new TransportParams({
        audioInEnabled: true,
        audioInFilter: audioFilter ?? new PassthroughFilter(),
      }),
    );

    // The participant talks continuously, and the transcription service
    // finalizes a fragment part way through. The utterance ends with a real
    // pause.
    //
    // Audio arrives in short runs, each followed by a sleep, so a transcript
    // is never queued behind a long run of audio frames — the interruption a
    // turn start broadcasts would discard it.
    const framesToSend: Frame[] = [
      new STTMetadataFrame({ serviceName: "DailyTransport", ttfsP99Latency: DEEPGRAM_TTFS_P99 }),
      ..._speechAudio(AUDIO_RUN_SECS),
      new SleepFrame({ sleep: DRAIN_SECS }),
    ];
    for (const fragment of FRAGMENTS) {
      framesToSend.push(
        _transcript(fragment),
        new SleepFrame({ sleep: DRAIN_SECS }),
        ..._speechAudio(AUDIO_RUN_SECS),
        new SleepFrame({ sleep: DRAIN_SECS }),
      );
    }
    framesToSend.push(..._silentAudio(2.0), new SleepFrame({ sleep: DRAIN_SECS }));

    const [receivedDown] = await runTest(new Pipeline([transport, aggregator]), {
      framesToSend,
      expectedDownFrames: null,
      sendEndFrame: true,
    });

    return {
      turnStarts,
      turnStops,
      llmCalls: receivedDown.filter((f) => f instanceof LLMContextFrame).length,
      userMessages: _userMessages(context),
    };
  }

  test("test_vad_driven_start_aggregates_the_utterance", async () => {
    // A VAD-driven turn start keeps the utterance in a single turn.
    const result = await _run([
      new VADUserTurnStartStrategy(),
      new TranscriptionUserTurnStartStrategy(),
    ]);

    expect(result.turnStarts).toEqual(1);
    expect(result.llmCalls).toEqual(1);
    expect(result.userMessages.length).toEqual(1);
    for (const fragment of FRAGMENTS) {
      expect(result.userMessages[0] as string).toContain(fragment);
    }
  }, 30_000);

  test("test_transcript_driven_start_aggregates_the_utterance", async () => {
    // A transcript-driven turn start reaches the same single turn.
    //
    // The turn starts mid-utterance, with the VAD stop still to come.
    const result = await _run([new MinWordsUserTurnStartStrategy({ minWords: 2 })]);

    expect(result.turnStarts).toEqual(1);
    expect(result.llmCalls).toEqual(1);
    expect(result.userMessages.length).toEqual(1);
    for (const fragment of FRAGMENTS) {
      expect(result.userMessages[0] as string).toContain(fragment);
    }
  }, 30_000);

  test("test_no_vad_signal_falls_back_to_a_turn_per_transcript", async () => {
    // Without any VAD signal, each transcript drives its own turn.
    //
    // An input filter that removes the speaker silences VAD while
    // transport-side transcription keeps transcribing the published track, so
    // the strategy has no VAD state to reason from and the transcript fallback
    // decides every turn.
    const result = await _run(
      [new VADUserTurnStartStrategy(), new TranscriptionUserTurnStartStrategy()],
      new SuppressingFilter(),
    );

    expect(result.llmCalls).toEqual(FRAGMENTS.length);
    expect(result.userMessages).toEqual(FRAGMENTS);
  }, 30_000);

  test("test_transcript_only_turn_after_a_vad_turn_still_completes_promptly", async () => {
    // A transcript VAD never saw still ends its turn on the STT budget.
    //
    // VAD reports only transitions, so a word too short or too quiet for VAD
    // produces a transcript with no VAD stop behind it. That turn is decided by
    // the transcript fallback, on the STT budget rather than the much longer
    // stop watchdog — including after earlier speech in the session did drive
    // VAD normally.
    const context = new LLMContext();
    const aggregator = new LLMUserAggregator(context, {
      params: new LLMUserAggregatorParams({
        vadAnalyzer: new EnergyVADAnalyzer({
          params: new VADParams({ confidence: 0.7, startSecs: 0.1, stopSecs: 0.2, minVolume: 0.0 }),
        }),
        userTurnStrategies: new UserTurnStrategies({
          start: [new VADUserTurnStartStrategy(), new TranscriptionUserTurnStartStrategy()],
          stop: [
            new TurnAnalyzerUserTurnStopStrategy({
              turnAnalyzer: new CompletingSmartTurn({
                params: new SmartTurnParams({ stopSecs: 3.0 }),
              }),
            }),
          ],
        }),
        userTurnStopTimeout: WATCHDOG_TIMEOUT,
      }),
    });
    const transport = new ReadyInputTransport(
      new TransportParams({ audioInEnabled: true, audioInFilter: new PassthroughFilter() }),
    );

    const llmCalls: number[] = [];
    const pushContextFrame = aggregator.pushContextFrame.bind(aggregator);

    aggregator.pushContextFrame = async (...args: Parameters<typeof pushContextFrame>) => {
      llmCalls.push(monotonic());
      return await pushContextFrame(...args);
    };

    const framesToSend: Frame[] = [
      new STTMetadataFrame({ serviceName: "DailyTransport", ttfsP99Latency: DEEPGRAM_TTFS_P99 }),
      // Audible speech: VAD reports a start and, after the silence, a stop.
      ..._speechAudio(1.0),
      new SleepFrame({ sleep: 0.1 }),
      _transcript("This is a normal audible sentence."),
      new SleepFrame({ sleep: 0.1 }),
      ..._silentAudio(0.6),
      new SleepFrame({ sleep: 0.6 }),
      // Too quiet for VAD, but the transcription service still hears it.
      _transcript("Okay."),
      // Long enough for both the STT budget and the stop watchdog to
      // elapse, so the assertion below shows which one released the turn.
      new SleepFrame({ sleep: WATCHDOG_TIMEOUT + 1.0 }),
    ];

    await runTest(new Pipeline([transport, aggregator]), {
      framesToSend,
      expectedDownFrames: null,
      sendEndFrame: true,
    });

    expect(llmCalls.length).toEqual(2);
    // The second turn is decided well inside the watchdog, not by it.
    expect((llmCalls[1] as number) - (llmCalls[0] as number)).toBeLessThan(WATCHDOG_TIMEOUT);
    expect(_userMessages(context)).toEqual(["This is a normal audible sentence.", "Okay."]);
  }, 30_000);
});
