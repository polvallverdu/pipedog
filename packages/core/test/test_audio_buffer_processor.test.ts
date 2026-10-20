// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipecat-ts contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_audio_buffer_processor.py

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as asyncio from "@pipecat-ts/asyncio";
import { Event, sleep, waitFor } from "@pipecat-ts/asyncio";
import { SystemClock } from "../src/clocks/system_clock.ts";
import {
  AudioBufferStartRecordingFrame,
  AudioBufferStopRecordingFrame,
  BotStartedSpeakingFrame,
  BotStoppedSpeakingFrame,
  EndFrame,
  type Frame,
  InputAudioRawFrame,
  OutputAudioRawFrame,
  StartFrame,
  UserStartedSpeakingFrame,
  UserStoppedSpeakingFrame,
} from "../src/frames/frames.ts";
import { PipelineParams } from "../src/pipeline/worker.ts";
import {
  AudioBufferProcessor,
  type ByteBuffer,
  type TurnAudioData,
} from "../src/processors/audio/audio_buffer_processor.ts";
import { FrameDirection, FrameProcessorSetup } from "../src/processors/frame_processor.ts";
import { runTest, SleepFrame } from "../src/tests/utils.ts";
import { TaskManager } from "../src/utils/asyncio/task_manager.ts";
import { logger } from "../src/utils/logger.ts";

class _PassthroughResampler {
  async resample(audio: Uint8Array, _inRate: number, _outRate: number): Promise<Uint8Array> {
    return audio;
  }
}

/** The processor's protected state, as the upstream tests reach into it. */
interface _Internals {
  _userAudioBuffer: ByteBuffer;
  _botAudioBuffer: ByteBuffer;
  _lastUserBufferUpdateTime: number | null;
  _lastBotBufferUpdateTime: number | null;
  _recording: boolean;
  _inputResampler: unknown;
  _outputResampler: unknown;
}

function priv(processor: AudioBufferProcessor): _Internals {
  return processor as unknown as _Internals;
}

/** `struct.pack("<h...", ...)`: 16-bit little-endian samples. */
function pack16(...samples: number[]): Uint8Array {
  const out = new Uint8Array(samples.length * 2);
  const view = new DataView(out.buffer);
  samples.forEach((s, i) => {
    view.setInt16(i * 2, s, true);
  });
  return out;
}

function bytes(...values: number[]): Uint8Array {
  return new Uint8Array(values);
}

function zeros(n: number): Uint8Array {
  return new Uint8Array(n);
}

function repeat(chunk: Uint8Array, times: number): Uint8Array {
  const out = new Uint8Array(chunk.length * times);
  for (let i = 0; i < times; i++) out.set(chunk, i * chunk.length);
  return out;
}

/**
 * Patch the clock the processor reads (`time.monotonic()` upstream) for the
 * duration of `fn`. `setNow` changes the returned value.
 */
async function withMockedMonotonic(
  fn: (setNow: (value: number) => void) => Promise<void>,
): Promise<void> {
  let now = 0;
  const spy = spyOn(asyncio, "monotonic").mockImplementation(() => now);
  try {
    await fn((value) => {
      now = value;
    });
  } finally {
    spy.mockRestore();
  }
}

/**
 * Create a processor ready to record.
 *
 * Calls setup() and sends a StartFrame through the public processFrame path
 * so that the processor is fully initialised (task manager set, sample rate
 * configured, started flag set) without needing a full pipeline.
 *
 * When `start` is true the processor starts recording before returning; pass
 * `start: false` to leave recording off (e.g. to test frame-driven start).
 */
async function _makeProcessor(
  options: { bufferSize?: number; start?: boolean; autoStart?: boolean } = {},
): Promise<AudioBufferProcessor> {
  const bufferSize = options.bufferSize ?? 0;
  const start = options.start ?? true;
  const autoStart = options.autoStart ?? false;

  const processor = new AudioBufferProcessor({
    sampleRate: 16000,
    numChannels: 2,
    bufferSize,
    autoStartRecording: autoStart,
  });
  priv(processor)._inputResampler = new _PassthroughResampler();
  priv(processor)._outputResampler = new _PassthroughResampler();

  const taskManager = new TaskManager();
  await processor.setup(
    new FrameProcessorSetup({
      clock: new SystemClock(),
      taskManager,
      pipelineWorker: { appResources: null } as never,
    }),
  );

  await processor.processFrame(new StartFrame(), FrameDirection.DOWNSTREAM);
  if (start) {
    await processor.startRecording();
  }
  return processor;
}

/** Flush the processor and return [userTrack, botTrack] from on_track_audio_data. */
async function _captureTrackAudio(
  processor: AudioBufferProcessor,
): Promise<[Uint8Array, Uint8Array]> {
  const captured: { user?: Uint8Array; bot?: Uint8Array } = {};
  const event = new Event();

  processor.addEventHandler(
    "on_track_audio_data",
    async (_: unknown, user: Uint8Array, bot: Uint8Array, _sr: number, _nc: number) => {
      captured.user = user;
      captured.bot = bot;
      event.set();
    },
  );
  await processor.stopRecording();
  await waitFor(() => event.wait(), 1);
  return [captured.user as Uint8Array, captured.bot as Uint8Array];
}

describe("TestAudioBufferProcessor", () => {
  let processor: AudioBufferProcessor;

  beforeEach(async () => {
    processor = await _makeProcessor({ bufferSize: 4 });
  });

  afterEach(async () => {
    if (priv(processor)._recording) {
      await processor.stopRecording();
    }
    await processor.cleanup();
  });

  test("test_flush_user_audio_pads_bot_track", async () => {
    const userAudio = pack16(1000, -1000);
    const audioEvent = new Event();
    const trackEvent = new Event();
    const captured: {
      merged?: [Uint8Array, number, number];
      tracks?: [Uint8Array, Uint8Array, number, number];
    } = {};

    processor.addEventHandler(
      "on_audio_data",
      async (_: unknown, audio: Uint8Array, sampleRate: number, numChannels: number) => {
        captured.merged = [audio, sampleRate, numChannels];
        audioEvent.set();
      },
    );
    processor.addEventHandler(
      "on_track_audio_data",
      async (
        _: unknown,
        user: Uint8Array,
        bot: Uint8Array,
        sampleRate: number,
        numChannels: number,
      ) => {
        captured.tracks = [user, bot, sampleRate, numChannels];
        trackEvent.set();
      },
    );

    const frame = new InputAudioRawFrame({ audio: userAudio, sampleRate: 16000, numChannels: 1 });
    await processor.processFrame(frame, FrameDirection.DOWNSTREAM);

    await waitFor(() => audioEvent.wait(), 1);
    await waitFor(() => trackEvent.wait(), 1);

    const [mergedAudio, mergedSr, mergedChannels] = captured.merged!;
    const [userTrack, botTrack, trackSr, trackChannels] = captured.tracks!;

    expect(mergedSr).toEqual(16000);
    expect(mergedChannels).toEqual(2);
    expect(trackSr).toEqual(16000);
    expect(trackChannels).toEqual(2);
    expect(userTrack).toEqual(userAudio);
    expect(botTrack).toEqual(zeros(userAudio.length));
    expect(mergedAudio.length).toEqual(userAudio.length * 2);
    expect(mergedAudio.slice(0, 2)).toEqual(userAudio.slice(0, 2));
    expect(mergedAudio.slice(2, 4)).toEqual(bytes(0, 0));
    expect(mergedAudio.slice(4, 6)).toEqual(userAudio.slice(2, 4));
    expect(mergedAudio.slice(6, 8)).toEqual(bytes(0, 0));
    expect(priv(processor)._userAudioBuffer.length).toEqual(0);
    expect(priv(processor)._botAudioBuffer.length).toEqual(0);
  });

  test("test_flush_bot_audio_pads_user_track", async () => {
    const botAudio = pack16(-800, 400);
    const audioEvent = new Event();
    const trackEvent = new Event();
    const captured: {
      merged?: [Uint8Array, number, number];
      tracks?: [Uint8Array, Uint8Array, number, number];
    } = {};

    processor.addEventHandler(
      "on_audio_data",
      async (_: unknown, audio: Uint8Array, sampleRate: number, numChannels: number) => {
        captured.merged = [audio, sampleRate, numChannels];
        audioEvent.set();
      },
    );
    processor.addEventHandler(
      "on_track_audio_data",
      async (
        _: unknown,
        user: Uint8Array,
        bot: Uint8Array,
        sampleRate: number,
        numChannels: number,
      ) => {
        captured.tracks = [user, bot, sampleRate, numChannels];
        trackEvent.set();
      },
    );

    const frame = new OutputAudioRawFrame({ audio: botAudio, sampleRate: 16000, numChannels: 1 });
    await processor.processFrame(frame, FrameDirection.DOWNSTREAM);

    await waitFor(() => audioEvent.wait(), 1);
    await waitFor(() => trackEvent.wait(), 1);

    const [mergedAudio, mergedSr, mergedChannels] = captured.merged!;
    const [userTrack, botTrack, trackSr, trackChannels] = captured.tracks!;

    expect(mergedSr).toEqual(16000);
    expect(mergedChannels).toEqual(2);
    expect(trackSr).toEqual(16000);
    expect(trackChannels).toEqual(2);
    expect(userTrack).toEqual(zeros(botAudio.length));
    expect(botTrack).toEqual(botAudio);
    expect(mergedAudio.length).toEqual(botAudio.length * 2);
    expect(mergedAudio.slice(0, 2)).toEqual(bytes(0, 0));
    expect(mergedAudio.slice(2, 4)).toEqual(botAudio.slice(0, 2));
    expect(mergedAudio.slice(4, 6)).toEqual(bytes(0, 0));
    expect(mergedAudio.slice(6, 8)).toEqual(botAudio.slice(2, 4));
    expect(priv(processor)._userAudioBuffer.length).toEqual(0);
    expect(priv(processor)._botAudioBuffer.length).toEqual(0);
  });
});

/**
 * Tests that silence is not injected mid-utterance (fix for crackling
 * artifacts).
 *
 * Each test verifies the audio alignment in the flushed tracks to confirm
 * that silence is only added by _alignTrackBuffers at flush time (end of the
 * buffer), never injected mid-stream while the affected track is actively
 * producing audio.
 */
describe("TestSilenceInjectionGuards", () => {
  test("test_no_silence_injected_into_bot_buffer_while_bot_speaking", async () => {
    // Bot audio must appear at the start of the bot track, not after
    // mid-stream silence.
    const p = await _makeProcessor();

    const botAudio = bytes(0xaa, 0xbb, 0xcc, 0xdd);

    await p.processFrame(
      new InputAudioRawFrame({ audio: bytes(1, 2, 3, 4), sampleRate: 16000, numChannels: 1 }),
      FrameDirection.DOWNSTREAM,
    );
    await p.processFrame(new BotStartedSpeakingFrame(), FrameDirection.DOWNSTREAM);
    await p.processFrame(
      new InputAudioRawFrame({ audio: bytes(5, 6, 7, 8), sampleRate: 16000, numChannels: 1 }),
      FrameDirection.DOWNSTREAM,
    );
    await p.processFrame(
      new OutputAudioRawFrame({ audio: botAudio, sampleRate: 16000, numChannels: 1 }),
      FrameDirection.DOWNSTREAM,
    );

    const [, botTrack] = await _captureTrackAudio(p);
    await p.cleanup();

    // Audio must appear at the beginning of the bot track (not after injected silence).
    expect(botTrack.slice(0, 4)).toEqual(botAudio);
    expect(botTrack.slice(4)).toEqual(zeros(4));
  });

  test("test_no_silence_injected_into_user_buffer_while_user_speaking", async () => {
    const p = await _makeProcessor();

    const userAudio = bytes(0xaa, 0xbb, 0xcc, 0xdd);

    await p.processFrame(
      new OutputAudioRawFrame({ audio: bytes(1, 2, 3, 4), sampleRate: 16000, numChannels: 1 }),
      FrameDirection.DOWNSTREAM,
    );
    await p.processFrame(new UserStartedSpeakingFrame(), FrameDirection.DOWNSTREAM);
    await p.processFrame(
      new OutputAudioRawFrame({ audio: bytes(5, 6, 7, 8), sampleRate: 16000, numChannels: 1 }),
      FrameDirection.DOWNSTREAM,
    );
    await p.processFrame(
      new InputAudioRawFrame({ audio: userAudio, sampleRate: 16000, numChannels: 1 }),
      FrameDirection.DOWNSTREAM,
    );

    const [userTrack] = await _captureTrackAudio(p);
    await p.cleanup();

    expect(userTrack.slice(0, 4)).toEqual(userAudio);
    expect(userTrack.slice(4)).toEqual(zeros(4));
  });

  test("test_silence_resumes_into_bot_buffer_after_bot_stops_speaking", async () => {
    const p = await _makeProcessor();

    await p.processFrame(
      new InputAudioRawFrame({ audio: bytes(1, 2, 3, 4), sampleRate: 16000, numChannels: 1 }),
      FrameDirection.DOWNSTREAM,
    );
    await p.processFrame(new BotStartedSpeakingFrame(), FrameDirection.DOWNSTREAM);
    await p.processFrame(
      new InputAudioRawFrame({ audio: bytes(5, 6, 7, 8), sampleRate: 16000, numChannels: 1 }),
      FrameDirection.DOWNSTREAM,
    );
    await p.processFrame(new BotStoppedSpeakingFrame(), FrameDirection.DOWNSTREAM);
    await p.processFrame(
      new InputAudioRawFrame({
        audio: bytes(0x09, 0x0a, 0x0b, 0x0c),
        sampleRate: 16000,
        numChannels: 1,
      }),
      FrameDirection.DOWNSTREAM,
    );

    const [, botTrack] = await _captureTrackAudio(p);
    await p.cleanup();

    // The sync at step 5 targets len(user)=8, so bot must have 8 bytes of silence
    // written before user's third chunk was added.
    expect(botTrack.slice(0, 8)).toEqual(zeros(8));
  });

  test("test_silence_resumes_into_user_buffer_after_user_stops_speaking", async () => {
    const p = await _makeProcessor();

    await p.processFrame(
      new OutputAudioRawFrame({ audio: bytes(1, 2, 3, 4), sampleRate: 16000, numChannels: 1 }),
      FrameDirection.DOWNSTREAM,
    );
    await p.processFrame(new UserStartedSpeakingFrame(), FrameDirection.DOWNSTREAM);
    await p.processFrame(
      new OutputAudioRawFrame({ audio: bytes(5, 6, 7, 8), sampleRate: 16000, numChannels: 1 }),
      FrameDirection.DOWNSTREAM,
    );
    await p.processFrame(new UserStoppedSpeakingFrame(), FrameDirection.DOWNSTREAM);
    await p.processFrame(
      new OutputAudioRawFrame({
        audio: bytes(0x09, 0x0a, 0x0b, 0x0c),
        sampleRate: 16000,
        numChannels: 1,
      }),
      FrameDirection.DOWNSTREAM,
    );

    const [userTrack] = await _captureTrackAudio(p);
    await p.cleanup();

    expect(userTrack.slice(0, 8)).toEqual(zeros(8));
  });
});

// 16-bit mono at 16 kHz → 2 bytes per sample
const _BYTES_PER_SECOND = 16000 * 2;

/** Expected silence bytes for a given elapsed time and incoming frame size. */
function _silenceForGap(elapsed: number, frameBytes: number): number {
  const frameDuration = frameBytes / _BYTES_PER_SECOND;
  const gap = elapsed - frameDuration;
  if (gap <= 0.2) {
    return 0;
  }
  const n = Math.trunc(gap * _BYTES_PER_SECOND);
  return n - (n % 2); // 16-bit alignment
}

async function _sendUserFrame(
  processor: AudioBufferProcessor,
  audio: Uint8Array = bytes(1, 2, 3, 4),
): Promise<void> {
  await processor.processFrame(
    new InputAudioRawFrame({ audio, sampleRate: 16000, numChannels: 1 }),
    FrameDirection.DOWNSTREAM,
  );
}

async function _sendBotFrame(
  processor: AudioBufferProcessor,
  audio: Uint8Array = bytes(1, 2, 3, 4),
): Promise<void> {
  await processor.processFrame(
    new OutputAudioRawFrame({ audio, sampleRate: 16000, numChannels: 1 }),
    FrameDirection.DOWNSTREAM,
  );
}

/**
 * Tests for _fillBufferSilenceGap (user buffer path).
 *
 * When the microphone is muted, no InputAudioRawFrame arrives. Without gap
 * detection the next utterance is appended directly after the previous one,
 * making two utterances spoken seconds apart sound concatenated.
 *
 * These tests verify that silence proportional to the wall-clock gap is
 * inserted into the user buffer so the recorded timeline stays accurate.
 */
describe("TestMuteGapSilenceInsertion", () => {
  test("test_no_silence_when_no_prior_timestamp", async () => {
    const p = await _makeProcessor();
    priv(p)._lastUserBufferUpdateTime = null;

    const audio = bytes(1, 2, 3, 4);
    await _sendUserFrame(p, audio);

    expect(priv(p)._userAudioBuffer.length).toEqual(4);
    expect(priv(p)._userAudioBuffer.bytes()).toEqual(audio);
    await p.cleanup();
  });

  test("test_no_silence_for_gap_below_threshold", async () => {
    const p = await _makeProcessor();
    const audio = bytes(1, 2, 3, 4);

    await withMockedMonotonic(async (setNow) => {
      priv(p)._lastUserBufferUpdateTime = 0.0;
      setNow(0.1); // 100 ms later
      await _sendUserFrame(p, audio);
    });

    expect(priv(p)._userAudioBuffer.length).toEqual(4);
    expect(priv(p)._userAudioBuffer.bytes()).toEqual(audio);
    await p.cleanup();
  });

  test("test_silence_proportional_to_mute_gap", async () => {
    const p = await _makeProcessor();
    const audio = bytes(1, 2, 3, 4);

    await withMockedMonotonic(async (setNow) => {
      priv(p)._lastUserBufferUpdateTime = 0.0;
      setNow(1.0); // 1-second gap
      await _sendUserFrame(p, audio);
    });

    const expectedSilence = _silenceForGap(1.0, audio.length);
    const buffer = priv(p)._userAudioBuffer.bytes();

    expect(buffer.length).toEqual(expectedSilence + audio.length);
    // Silence prefix.
    expect(buffer.slice(0, expectedSilence)).toEqual(zeros(expectedSilence));
    // Audio at the end.
    expect(buffer.slice(-audio.length)).toEqual(audio);
    await p.cleanup();
  });

  test("test_two_utterances_separated_by_mute_have_silence_gap", async () => {
    // This is the original bug report: without the fix the second utterance
    // is appended directly after the first with no silence, making them sound
    // like one continuous utterance.
    const p = await _makeProcessor();
    const utterance = bytes(0x11, 0x22, 0x33, 0x44);

    await withMockedMonotonic(async (setNow) => {
      // Utterance 1 is already in the buffer at t=0.
      setNow(0.0);
      priv(p)._lastUserBufferUpdateTime = 0.0;
      priv(p)._userAudioBuffer.extend(utterance);

      // One second later the user unmutes and speaks utterance 2.
      setNow(1.0);
      await _sendUserFrame(p, utterance);
    });

    const buffer = priv(p)._userAudioBuffer.bytes();
    // Must be longer than both utterances back-to-back (the bug).
    expect(buffer.length).toBeGreaterThan(utterance.length * 2);
    // Utterance 1 at the start.
    expect(buffer.slice(0, utterance.length)).toEqual(utterance);
    // Utterance 2 at the end.
    expect(buffer.slice(-utterance.length)).toEqual(utterance);
    // Everything in between must be silence.
    const silenceRegion = buffer.slice(utterance.length, -utterance.length);
    expect(silenceRegion.every((b) => b === 0)).toBe(true);
    await p.cleanup();
  });

  test("test_bot_audio_during_mute_advances_timestamp_preventing_double_counting", async () => {
    // The gap fill must measure from t=1.0 (last sync by bot audio), not from
    // t=0.0 (last real user audio). Without this guard the silence would be
    // doubled (~2 s instead of ~1 s).
    const p = await _makeProcessor();
    const audio = bytes(1, 2, 3, 4);

    await withMockedMonotonic(async (setNow) => {
      // Pin timestamp at t=0 (simulates prior user audio with no frames sent).
      priv(p)._lastUserBufferUpdateTime = 0.0;

      // Bot speaks at t=1 → must advance _lastUserBufferUpdateTime to 1.0.
      setNow(1.0);
      await _sendBotFrame(p, audio);

      // User unmutes at t=2.
      setNow(2.0);
      await _sendUserFrame(p, audio);
    });

    const expectedSilence1s = _silenceForGap(2.0 - 1.0, audio.length);
    const expectedSilence2s = _silenceForGap(2.0 - 0.0, audio.length);

    const actualSilence = priv(p)._userAudioBuffer.length - audio.length;
    // Gap should be ~1 s worth of silence, not ~2 s.
    expect(Math.abs(actualSilence - expectedSilence1s)).toBeLessThanOrEqual(4);
    expect(Math.abs(actualSilence - expectedSilence2s)).toBeGreaterThan(4);
    await p.cleanup();
  });

  test("test_bot_buffer_synced_to_user_position_after_gap_fill", async () => {
    // The sync targets the user buffer length *after* the silence is inserted
    // but *before* the new user audio is appended, so both buffers share the
    // same temporal reference point.
    const p = await _makeProcessor();
    const audio = bytes(1, 2, 3, 4);

    await withMockedMonotonic(async (setNow) => {
      priv(p)._lastUserBufferUpdateTime = 0.0;
      setNow(1.0);
      await _sendUserFrame(p, audio);
    });

    const expectedSilence = _silenceForGap(1.0, audio.length);

    // Bot buffer should equal the silence that was inserted (user position
    // after silence, before the new audio frame was appended).
    expect(priv(p)._botAudioBuffer.length).toEqual(expectedSilence);
    expect(priv(p)._botAudioBuffer.bytes()).toEqual(zeros(expectedSilence));
    await p.cleanup();
  });

  test("test_reset_recording_clears_timestamp", async () => {
    const p = await _makeProcessor();
    priv(p)._lastUserBufferUpdateTime = 999.0;

    await withMockedMonotonic(async (setNow) => {
      setNow(1000.0);
      await p.stopRecording();
    });

    expect(priv(p)._lastUserBufferUpdateTime).toBeNull();
    await p.cleanup();
  });

  test("test_buffer_flush_resets_timestamp_to_flush_time", async () => {
    // This ensures that when the next user frame arrives after a flush the
    // gap is measured from the flush point, not from a stale earlier
    // timestamp.
    const audio = bytes(1, 2, 3, 4, 5, 6, 7, 8); // 8 bytes == bufferSize
    const p = await _makeProcessor({ bufferSize: audio.length });

    await withMockedMonotonic(async (setNow) => {
      setNow(5.0);
      priv(p)._lastUserBufferUpdateTime = 0.0;

      const flushed = new Event();

      p.addEventHandler("on_audio_data", async (..._args: unknown[]) => {
        flushed.set();
      });
      await _sendUserFrame(p, audio);
      // _resetPrimaryAudioBuffers is called synchronously inside
      // processFrame once bufferSize is hit, so no wait is needed — but we
      // yield to let any background tasks settle.
      await sleep(0);
    });

    // Timestamp should be set to the mocked flush time, not null.
    expect(priv(p)._lastUserBufferUpdateTime).not.toBeNull();
    expect(priv(p)._lastUserBufferUpdateTime).toEqual(5.0);
    await p.cleanup();
  });
});

/**
 * Tests for _fillBufferSilenceGap (bot buffer path).
 *
 * Mirror of TestMuteGapSilenceInsertion for the bot-audio path. When the bot
 * is briefly idle between utterances (e.g. progressive hold messages spoken
 * while a slow function call runs), no OutputAudioRawFrame arrives. Without
 * gap detection on the bot side the next utterance is appended directly after
 * the previous one, making two utterances spoken seconds apart sound
 * concatenated in the recording.
 */
describe("TestBotSilenceGapInsertion", () => {
  test("test_no_silence_when_no_prior_timestamp", async () => {
    const p = await _makeProcessor();
    priv(p)._lastBotBufferUpdateTime = null;

    const audio = bytes(1, 2, 3, 4);
    await _sendBotFrame(p, audio);

    expect(priv(p)._botAudioBuffer.length).toEqual(4);
    expect(priv(p)._botAudioBuffer.bytes()).toEqual(audio);
    await p.cleanup();
  });

  test("test_no_silence_for_gap_below_threshold", async () => {
    const p = await _makeProcessor();
    const audio = bytes(1, 2, 3, 4);

    await withMockedMonotonic(async (setNow) => {
      priv(p)._lastBotBufferUpdateTime = 0.0;
      setNow(0.1); // 100 ms later
      await _sendBotFrame(p, audio);
    });

    expect(priv(p)._botAudioBuffer.length).toEqual(4);
    expect(priv(p)._botAudioBuffer.bytes()).toEqual(audio);
    await p.cleanup();
  });

  test("test_silence_proportional_to_idle_gap", async () => {
    const p = await _makeProcessor();
    const audio = bytes(1, 2, 3, 4);

    await withMockedMonotonic(async (setNow) => {
      priv(p)._lastBotBufferUpdateTime = 0.0;
      setNow(1.0); // 1-second gap
      await _sendBotFrame(p, audio);
    });

    const expectedSilence = _silenceForGap(1.0, audio.length);
    const buffer = priv(p)._botAudioBuffer.bytes();

    expect(buffer.length).toEqual(expectedSilence + audio.length);
    // Silence prefix.
    expect(buffer.slice(0, expectedSilence)).toEqual(zeros(expectedSilence));
    // Audio at the end.
    expect(buffer.slice(-audio.length)).toEqual(audio);
    await p.cleanup();
  });

  test("test_two_utterances_separated_by_pause_have_silence_gap", async () => {
    const p = await _makeProcessor();
    const utterance = bytes(0x11, 0x22, 0x33, 0x44);

    await withMockedMonotonic(async (setNow) => {
      // Utterance 1 is already in the buffer at t=0.
      setNow(0.0);
      priv(p)._lastBotBufferUpdateTime = 0.0;
      priv(p)._botAudioBuffer.extend(utterance);

      // One second later the bot speaks utterance 2.
      setNow(1.0);
      await _sendBotFrame(p, utterance);
    });

    const buffer = priv(p)._botAudioBuffer.bytes();
    // Must be longer than both utterances back-to-back (the bug).
    expect(buffer.length).toBeGreaterThan(utterance.length * 2);
    // Utterance 1 at the start.
    expect(buffer.slice(0, utterance.length)).toEqual(utterance);
    // Utterance 2 at the end.
    expect(buffer.slice(-utterance.length)).toEqual(utterance);
    // Everything in between must be silence.
    const silenceRegion = buffer.slice(utterance.length, -utterance.length);
    expect(silenceRegion.every((b) => b === 0)).toBe(true);
    await p.cleanup();
  });

  test("test_user_audio_during_pause_advances_timestamp_preventing_double_counting", async () => {
    const p = await _makeProcessor();
    const audio = bytes(1, 2, 3, 4);
    let botLenAfterUser = 0;

    await withMockedMonotonic(async (setNow) => {
      // Pin bot timestamp at t=0 (simulates prior bot audio with no frames sent).
      priv(p)._lastBotBufferUpdateTime = 0.0;

      // User speaks at t=1 → must advance _lastBotBufferUpdateTime to 1.0.
      setNow(1.0);
      await _sendUserFrame(p, audio);

      // Snapshot the bot buffer size right after the user frame; everything
      // added after this is from the bot frame (gap fill + new audio).
      botLenAfterUser = priv(p)._botAudioBuffer.length;

      // Bot resumes at t=2.
      setNow(2.0);
      await _sendBotFrame(p, audio);
    });

    // New bytes added by the bot frame = gap fill + audio frame.
    const botFrameContribution = priv(p)._botAudioBuffer.length - botLenAfterUser;
    const gapFillBytes = botFrameContribution - audio.length;

    const expectedSilence1s = _silenceForGap(2.0 - 1.0, audio.length);
    const expectedSilence2s = _silenceForGap(2.0 - 0.0, audio.length);

    // Gap fill should reflect a 1 s gap (since user frame advanced the bot
    // timestamp), not a 2 s gap (which would happen without the advance,
    // double-counting the silence the user-sync already added).
    expect(Math.abs(gapFillBytes - expectedSilence1s)).toBeLessThanOrEqual(4);
    expect(Math.abs(gapFillBytes - expectedSilence2s)).toBeGreaterThan(4);
    await p.cleanup();
  });

  test("test_user_buffer_synced_to_bot_position_after_gap_fill", async () => {
    const p = await _makeProcessor();
    const audio = bytes(1, 2, 3, 4);

    await withMockedMonotonic(async (setNow) => {
      priv(p)._lastBotBufferUpdateTime = 0.0;
      setNow(1.0);
      await _sendBotFrame(p, audio);
    });

    const expectedSilence = _silenceForGap(1.0, audio.length);

    // User buffer should equal the silence that was inserted (bot position
    // after silence, before the new audio frame was appended).
    expect(priv(p)._userAudioBuffer.length).toEqual(expectedSilence);
    expect(priv(p)._userAudioBuffer.bytes()).toEqual(zeros(expectedSilence));
    await p.cleanup();
  });

  test("test_reset_recording_clears_bot_timestamp", async () => {
    const p = await _makeProcessor();
    priv(p)._lastBotBufferUpdateTime = 999.0;

    await withMockedMonotonic(async (setNow) => {
      setNow(1000.0);
      await p.stopRecording();
    });

    expect(priv(p)._lastBotBufferUpdateTime).toBeNull();
    await p.cleanup();
  });

  test("test_buffer_flush_resets_bot_timestamp_to_flush_time", async () => {
    const audio = bytes(1, 2, 3, 4, 5, 6, 7, 8); // 8 bytes == bufferSize
    const p = await _makeProcessor({ bufferSize: audio.length });

    await withMockedMonotonic(async (setNow) => {
      setNow(5.0);
      priv(p)._lastBotBufferUpdateTime = 0.0;

      const flushed = new Event();

      p.addEventHandler("on_audio_data", async (..._args: unknown[]) => {
        flushed.set();
      });
      await _sendBotFrame(p, audio);
      await sleep(0);
    });

    // Timestamp should be set to the mocked flush time, not null.
    expect(priv(p)._lastBotBufferUpdateTime).not.toBeNull();
    expect(priv(p)._lastBotBufferUpdateTime).toEqual(5.0);
    await p.cleanup();
  });
});

/**
 * Tests for frame-driven recording control.
 *
 * AudioBufferStartRecordingFrame / AudioBufferStopRecordingFrame let any
 * upstream processor start and stop recording from within the frame flow,
 * triggering the same startRecording() / stopRecording() methods as the
 * direct API.
 */
describe("TestRecordingControlFrames", () => {
  test("test_start_recording_frame_enables_recording", async () => {
    const p = await _makeProcessor({ start: false });
    expect(priv(p)._recording).toBe(false);

    await p.processFrame(new AudioBufferStartRecordingFrame(), FrameDirection.DOWNSTREAM);
    expect(priv(p)._recording).toBe(true);

    const audio = pack16(1000, -1000);
    await p.processFrame(
      new InputAudioRawFrame({ audio, sampleRate: 16000, numChannels: 1 }),
      FrameDirection.DOWNSTREAM,
    );

    const [userTrack] = await _captureTrackAudio(p);
    expect(userTrack).toEqual(audio);
    await p.cleanup();
  });

  test("test_audio_ignored_before_start_recording_frame", async () => {
    const p = await _makeProcessor({ start: false });

    await p.processFrame(
      new InputAudioRawFrame({ audio: bytes(1, 2, 3, 4), sampleRate: 16000, numChannels: 1 }),
      FrameDirection.DOWNSTREAM,
    );

    expect(p.hasAudio()).toBe(false);
    await p.cleanup();
  });

  test("test_stop_recording_frame_flushes_and_disables", async () => {
    const p = await _makeProcessor();

    const audio = pack16(1000, -1000);
    await p.processFrame(
      new InputAudioRawFrame({ audio, sampleRate: 16000, numChannels: 1 }),
      FrameDirection.DOWNSTREAM,
    );

    const captured: { user?: Uint8Array } = {};
    const event = new Event();

    p.addEventHandler(
      "on_track_audio_data",
      async (_: unknown, user: Uint8Array, _bot: Uint8Array, _sr: number, _nc: number) => {
        captured.user = user;
        event.set();
      },
    );
    await p.processFrame(new AudioBufferStopRecordingFrame(), FrameDirection.DOWNSTREAM);

    await waitFor(() => event.wait(), 1);
    expect(captured.user).toEqual(audio);
    expect(priv(p)._recording).toBe(false);
    expect(p.hasAudio()).toBe(false);
    await p.cleanup();
  });

  test("test_recording_control_frames_passed_downstream", async () => {
    const processor = new AudioBufferProcessor({ sampleRate: 16000, numChannels: 2 });

    await runTest(processor, {
      framesToSend: [new AudioBufferStartRecordingFrame(), new AudioBufferStopRecordingFrame()],
      expectedDownFrames: [AudioBufferStartRecordingFrame, AudioBufferStopRecordingFrame],
    });
  });
});

/**
 * Tests for the autoStartRecording constructor option.
 *
 * With autoStartRecording=true the processor starts recording as soon as it
 * handles the StartFrame, without an explicit startRecording() call or an
 * AudioBufferStartRecordingFrame.
 */
describe("TestAutoStartRecording", () => {
  test("test_auto_start_begins_recording_on_start_frame", async () => {
    const p = await _makeProcessor({ start: false, autoStart: true });
    expect(priv(p)._recording).toBe(true);

    const audio = pack16(1000, -1000);
    await p.processFrame(
      new InputAudioRawFrame({ audio, sampleRate: 16000, numChannels: 1 }),
      FrameDirection.DOWNSTREAM,
    );

    const [userTrack] = await _captureTrackAudio(p);
    expect(userTrack).toEqual(audio);
    await p.cleanup();
  });

  test("test_auto_start_disabled_by_default", async () => {
    const p = await _makeProcessor({ start: false });
    expect(priv(p)._recording).toBe(false);
    await p.cleanup();
  });

  test("test_auto_start_fires_started_event", async () => {
    const p = new AudioBufferProcessor({ sampleRate: 16000, autoStartRecording: true });

    const fired = new Event();
    p.addEventHandler("on_recording_started", (_: unknown) => fired.set());

    await runTest(p, { framesToSend: [], expectedDownFrames: [] });
    await waitFor(() => fired.wait(), 1);
  });
});

/**
 * Tests for the on_recording_started / on_recording_stopped events.
 *
 * These fire only on actual recording state transitions, decoupling the code
 * that triggers recording (a direct call or a control frame) from code that
 * wants to react to it (UI indicators, logging, etc.).
 */
describe("TestRecordingLifecycleEvents", () => {
  test("test_started_event_fires_on_start", async () => {
    const p = await _makeProcessor({ start: false });

    const fired = new Event();
    p.addEventHandler("on_recording_started", (_: unknown) => fired.set());

    await p.startRecording();
    await waitFor(() => fired.wait(), 1);
    await p.cleanup();
  });

  test("test_started_event_fires_via_frame", async () => {
    const p = await _makeProcessor({ start: false });

    const fired = new Event();
    p.addEventHandler("on_recording_started", (_: unknown) => fired.set());

    await p.processFrame(new AudioBufferStartRecordingFrame(), FrameDirection.DOWNSTREAM);
    await waitFor(() => fired.wait(), 1);
    await p.cleanup();
  });

  test("test_started_event_not_refired_when_already_recording", async () => {
    const p = await _makeProcessor(); // already recording

    const started: boolean[] = [];
    p.addEventHandler("on_recording_started", (_: unknown) => {
      started.push(true);
    });

    await p.startRecording();
    await sleep(0.05); // give any erroneously-scheduled handler a chance
    expect(started.length).toEqual(0);
    await p.cleanup();
  });

  test("test_redundant_start_preserves_buffered_audio", async () => {
    const p = await _makeProcessor(); // already recording

    await p.processFrame(
      new InputAudioRawFrame({ audio: pack16(1000, -1000), sampleRate: 16000, numChannels: 1 }),
      FrameDirection.DOWNSTREAM,
    );
    expect(p.hasAudio()).toBe(true);

    await p.startRecording();
    expect(p.hasAudio()).toBe(true);
    await p.cleanup();
  });

  test("test_stopped_event_fires_with_final_audio_already_emitted", async () => {
    const p = await _makeProcessor();

    await p.processFrame(
      new InputAudioRawFrame({ audio: pack16(1000, -1000), sampleRate: 16000, numChannels: 1 }),
      FrameDirection.DOWNSTREAM,
    );

    const audioFired = new Event();
    const stoppedFired = new Event();
    p.addEventHandler("on_audio_data", (..._args: unknown[]) => audioFired.set());
    p.addEventHandler("on_recording_stopped", (_: unknown) => stoppedFired.set());

    await p.stopRecording();

    await waitFor(() => audioFired.wait(), 1);
    await waitFor(() => stoppedFired.wait(), 1);
    // By the time stop signals, recording is off and buffers are cleared.
    expect(priv(p)._recording).toBe(false);
    expect(p.hasAudio()).toBe(false);
    await p.cleanup();
  });

  test("test_stopped_event_not_fired_when_not_recording", async () => {
    const p = await _makeProcessor({ start: false });

    const stopped: boolean[] = [];
    p.addEventHandler("on_recording_stopped", (_: unknown) => {
      stopped.push(true);
    });

    await p.processFrame(new EndFrame(), FrameDirection.DOWNSTREAM);
    await sleep(0.05);
    expect(stopped.length).toEqual(0);
    await p.cleanup();
  });
});

const TURN_SAMPLE_RATE = 16000;

// 0.1s of mono audio. Every run of speech below is one chunk, so a turn's audio
// is one chunk per run its speaker contributed.
const TURN_CHUNK = repeat(bytes(0x11, 0x00), 1600);

/** One run of user speech, paced as a real mic would deliver it. */
function _userRun(): Frame[] {
  return [
    new UserStartedSpeakingFrame(),
    new SleepFrame({ sleep: 0.05 }),
    new InputAudioRawFrame({ audio: TURN_CHUNK, sampleRate: TURN_SAMPLE_RATE, numChannels: 1 }),
    new SleepFrame({ sleep: 0.05 }),
    new UserStoppedSpeakingFrame(),
    new SleepFrame({ sleep: 0.2 }),
  ];
}

/**
 * One run of bot speech.
 *
 * Bot audio is a DataFrame and queues, while the speaking frames are
 * SystemFrames that skip the queue, so it needs time to drain before
 * BotStoppedSpeakingFrame closes the run.
 */
function _botRun(): Frame[] {
  return [
    new BotStartedSpeakingFrame(),
    new SleepFrame({ sleep: 0.05 }),
    new OutputAudioRawFrame({ audio: TURN_CHUNK, sampleRate: TURN_SAMPLE_RATE, numChannels: 1 }),
    new SleepFrame({ sleep: 0.1 }),
    new BotStoppedSpeakingFrame(),
    new SleepFrame({ sleep: 0.2 }),
  ];
}

type TurnEvent = [string, number, Uint8Array];

/** The turn audio events report each speaker once per turn. */
describe("TestTurnAudio", () => {
  /** Run frames through a recording processor, returning its turn audio events. */
  async function _turnEvents(frames: Frame[]): Promise<TurnEvent[]> {
    const processor = new AudioBufferProcessor({
      sampleRate: TURN_SAMPLE_RATE,
      numChannels: 1,
      enableTurnAudio: true,
      autoStartRecording: true,
    });
    const events: TurnEvent[] = [];

    processor.addEventHandler(
      "on_user_turn_audio",
      async (_buffer: unknown, turn: TurnAudioData) => {
        events.push(["user", turn.turnNumber, new Uint8Array(turn.audio)]);
      },
    );

    processor.addEventHandler(
      "on_bot_turn_audio",
      async (_buffer: unknown, turn: TurnAudioData) => {
        events.push(["bot", turn.turnNumber, new Uint8Array(turn.audio)]);
      },
    );

    await runTest(processor, {
      framesToSend: frames,
      pipelineParams: new PipelineParams({
        audioInSampleRate: TURN_SAMPLE_RATE,
        audioOutSampleRate: TURN_SAMPLE_RATE,
      }),
    });
    return events;
  }

  test("test_reports_each_speaker_once_for_a_turn", async () => {
    const events = await _turnEvents([..._userRun(), ..._botRun()]);

    // Turn 1 opens with the pipeline, so the first exchange lands there.
    expect(events).toEqual([
      ["user", 1, TURN_CHUNK],
      ["bot", 1, TURN_CHUNK],
    ]);
  });

  test("test_joins_several_runs_of_speech_in_a_turn", async () => {
    // The user pauses mid-thought and the bot resumes after a function call,
    // so each speaks twice within one turn.
    const events = await _turnEvents([..._userRun(), ..._userRun(), ..._botRun(), ..._botRun()]);

    expect(events).toEqual([
      ["user", 1, repeat(TURN_CHUNK, 2)],
      ["bot", 1, repeat(TURN_CHUNK, 2)],
    ]);
  });

  test("test_numbers_successive_turns", async () => {
    const events = await _turnEvents([..._userRun(), ..._botRun(), ..._userRun(), ..._botRun()]);

    expect(events).toEqual([
      ["user", 1, TURN_CHUNK],
      ["bot", 1, TURN_CHUNK],
      ["user", 2, TURN_CHUNK],
      ["bot", 2, TURN_CHUNK],
    ]);
  });

  test("test_reports_barged_in_audio_under_the_interrupted_turn", async () => {
    // The user barges in while the bot is speaking, which ends turn 1 and
    // starts turn 2 before the bot's cut-off audio is closed out.
    const events = await _turnEvents([
      ..._userRun(),
      new BotStartedSpeakingFrame(),
      new SleepFrame({ sleep: 0.05 }),
      new OutputAudioRawFrame({ audio: TURN_CHUNK, sampleRate: TURN_SAMPLE_RATE, numChannels: 1 }),
      new SleepFrame({ sleep: 0.1 }),
      new UserStartedSpeakingFrame(),
      new SleepFrame({ sleep: 0.05 }),
      new BotStoppedSpeakingFrame(),
      new SleepFrame({ sleep: 0.05 }),
      new InputAudioRawFrame({ audio: TURN_CHUNK, sampleRate: TURN_SAMPLE_RATE, numChannels: 1 }),
      new SleepFrame({ sleep: 0.05 }),
      new UserStoppedSpeakingFrame(),
      new SleepFrame({ sleep: 0.2 }),
      ..._botRun(),
    ]);

    expect(events).toEqual([
      ["user", 1, TURN_CHUNK],
      ["bot", 1, TURN_CHUNK],
      ["user", 2, TURN_CHUNK],
      ["bot", 2, TURN_CHUNK],
    ]);
  });

  test("test_silent_speaker_is_not_reported", async () => {
    // The bot greets and the user never replies, so turn 1 has no user audio.
    const events = await _turnEvents(_botRun());

    expect(events).toEqual([["bot", 1, TURN_CHUNK]]);
  });

  test("test_turn_audio_needs_turn_tracking", async () => {
    // Turn boundaries come from the tracker, so without one there is nothing
    // to report. Say so rather than going quiet.
    const processor = new AudioBufferProcessor({
      sampleRate: TURN_SAMPLE_RATE,
      numChannels: 1,
      enableTurnAudio: true,
    });
    await processor.setup(
      new FrameProcessorSetup({
        clock: new SystemClock(),
        taskManager: new TaskManager(),
        pipelineWorker: { appResources: null, turnTrackingObserver: null } as never,
      }),
    );

    const warning = spyOn(logger, "warning").mockImplementation(() => {});
    let calls: string[][];
    try {
      await processor.processFrame(new StartFrame(), FrameDirection.DOWNSTREAM);
    } finally {
      // Bun's mockRestore() clears the recorded calls, so copy them first.
      calls = warning.mock.calls.map((args) => [...args]);
      warning.mockRestore();
    }

    expect(calls.length).toEqual(1);
    // The option is spelled `enableTurnTracking` in TS (`enable_turn_tracking` upstream).
    expect(calls[0]![0]).toContain("enableTurnTracking");
    await processor.cleanup();
  });

  // Deprecated upstream API (the on_user_turn_audio_data / on_bot_turn_audio_data
  // events, superseded by on_user_turn_audio / on_bot_turn_audio) is not ported.
  test.skip("test_deprecated_events_still_report_each_run_of_speech", () => {});

  test("test_open_mic_audio_stays_out_of_the_interrupted_turn", async () => {
    // The mic keeps delivering while the bot speaks, so at a barge-in the
    // user's buffer holds the pre-roll leading into their interruption. That
    // audio belongs to the turn starting, not the one being interrupted.
    const events = await _turnEvents([
      ..._userRun(),
      new BotStartedSpeakingFrame(),
      new SleepFrame({ sleep: 0.05 }),
      new OutputAudioRawFrame({ audio: TURN_CHUNK, sampleRate: TURN_SAMPLE_RATE, numChannels: 1 }),
      new InputAudioRawFrame({ audio: TURN_CHUNK, sampleRate: TURN_SAMPLE_RATE, numChannels: 1 }),
      new SleepFrame({ sleep: 0.1 }),
      new UserStartedSpeakingFrame(),
      new SleepFrame({ sleep: 0.05 }),
      new BotStoppedSpeakingFrame(),
      new SleepFrame({ sleep: 0.05 }),
      new InputAudioRawFrame({ audio: TURN_CHUNK, sampleRate: TURN_SAMPLE_RATE, numChannels: 1 }),
      new SleepFrame({ sleep: 0.05 }),
      new UserStoppedSpeakingFrame(),
      new SleepFrame({ sleep: 0.2 }),
    ]);

    const turn1User = events.find(([who, turn]) => who === "user" && turn === 1)![2];
    expect(turn1User).toEqual(TURN_CHUNK);
  });

  test("test_reports_the_turn_in_progress_when_recording_stops", async () => {
    // Stopping the recording leaves the turn open, and ending the pipeline
    // closes it. A conversation's last turn arrives this way.
    const events = await _turnEvents([
      ..._userRun(),
      ..._botRun(),
      new AudioBufferStopRecordingFrame(),
      new SleepFrame({ sleep: 0.2 }),
    ]);

    expect(events).toEqual([
      ["user", 1, TURN_CHUNK],
      ["bot", 1, TURN_CHUNK],
    ]);
  });
});
