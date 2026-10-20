// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_base_output_transport.py

/** Tests for interruption handling in `BaseOutputTransport`. */

import { describe, expect, mock, test } from "bun:test";
import { createHash } from "node:crypto";

import { Event, sleep, waitFor } from "@pipedog/asyncio";

import { BaseAudioFilter } from "../src/audio/filters/base_audio_filter.ts";
import { BaseAudioMixer } from "../src/audio/mixers/base_audio_mixer.ts";
import { SystemClock } from "../src/clocks/system_clock.ts";
import {
  BotStartedSpeakingFrame,
  BotStoppedSpeakingFrame,
  CancelFrame,
  EndFrame,
  type FilterControlFrame,
  FilterEnableFrame,
  FilterUpdateSettingsFrame,
  FunctionCallInProgressFrame,
  InterruptionFrame,
  type MixerControlFrame,
  OutputAudioRawFrame,
  StartFrame,
  TTSAudioRawFrame,
  TTSStoppedFrame,
  TTSTextFrame,
  VolumeFrame,
  VolumeGainFrame,
} from "../src/frames/frames.ts";
import type { PipelineWorker } from "../src/pipeline/worker.ts";
import { FrameDirection, FrameProcessorSetup } from "../src/processors/frame_processor.ts";
import { BaseOutputTransport } from "../src/transports/base_output.ts";
import { TransportParams } from "../src/transports/base_transport.ts";
import { TaskManager } from "../src/utils/asyncio/task_manager.ts";

// Lets tests replace methods and read protected state, as upstream does by
// assigning AsyncMock attributes and reading `_private` members.
type Patchable = any;

/** AsyncMock() */
const asyncMock = (impl: (...args: Patchable[]) => Promise<unknown> = async () => undefined) =>
  mock(impl);

/** Minimal mixer that returns the input audio unchanged. */
class _PassthroughMixer extends BaseAudioMixer {
  async start(_sampleRate: number): Promise<void> {}

  async stop(): Promise<void> {}

  async processFrame(_frame: MixerControlFrame): Promise<void> {}

  async mix(audio: Uint8Array): Promise<Uint8Array> {
    return audio;
  }
}

/** Filter that inverts every byte and records its calls in order. */
class _InvertingFilter extends BaseAudioFilter {
  sampleRate = 0;
  stops = 0;
  calls: (string | FilterControlFrame)[] = [];

  async start(sampleRate: number): Promise<void> {
    this.sampleRate = sampleRate;
  }

  async stop(): Promise<void> {
    this.stops += 1;
  }

  async processFrame(frame: FilterControlFrame): Promise<void> {
    this.calls.push(frame);
  }

  async filter(audio: Uint8Array): Promise<Uint8Array> {
    this.calls.push(_fingerprint(audio));
    return _inverted(audio);
  }
}

function _inverted(audio: Uint8Array): Uint8Array {
  return audio.map((b) => b ^ 0xff);
}

/** Name a chunk by its length and hash, so a failed comparison prints short. */
function _fingerprint(audio: Uint8Array): string {
  return `${audio.length}:${createHash("sha256").update(audio).digest("hex").slice(0, 12)}`;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/** bytes([value]) * n */
function filled(value: number, n: number): Uint8Array {
  return new Uint8Array(n).fill(value);
}

/** `b"\x01\x02" * n` */
function repeated(pattern: number[], n: number): Uint8Array {
  const out = new Uint8Array(pattern.length * n);
  for (let i = 0; i < n; i++) out.set(pattern, i * pattern.length);
  return out;
}

/** np.frombuffer(audio, dtype=np.int16) */
function int16(audio: Uint8Array): Int16Array {
  const copy = audio.slice();
  return new Int16Array(copy.buffer, 0, copy.length >> 1);
}

/** The first positional argument of each call to a mock. */
function firstArgs(m: Patchable): Patchable[] {
  return m.mock.calls.map((call: Patchable[]) => call[0]);
}

/** Wait until the clock task has pushed every timed frame it holds. */
async function _clockIdle(sender: Patchable): Promise<void> {
  while (sender._clockFrame || !sender._clockQueue.empty()) {
    await sleep(0.01);
  }
}

function _setup(): FrameProcessorSetup {
  return new FrameProcessorSetup({
    clock: new SystemClock(),
    taskManager: new TaskManager(),
    pipelineWorker: { appResources: null } as unknown as PipelineWorker,
  });
}

async function _makeTransport(
  options: {
    mixer?: BaseAudioMixer | null;
    audioOutSampleRate?: number | null;
    audioFilter?: BaseAudioFilter | null;
    audioOutVolume?: number;
  } = {},
): Promise<Patchable> {
  const params = new TransportParams({
    audioOutEnabled: true,
    audioOutMixer: options.mixer ?? null,
    audioOutFilter: options.audioFilter ?? null,
    audioOutSampleRate: options.audioOutSampleRate ?? null,
    audioOutVolume: options.audioOutVolume ?? 1.0,
  });
  const transport: Patchable = new BaseOutputTransport(params);
  transport.pushFrame = asyncMock();
  transport.writeAudioFrame = asyncMock(async () => true);

  await transport.setup(_setup());
  // Upstream passes the deprecated `StartFrame(audio_out_sample_rate=16000)`,
  // which the transport ignores (the rate comes from the setup).
  const startFrame = new StartFrame();
  await transport.processFrame(startFrame, FrameDirection.DOWNSTREAM);
  await transport.setTransportReady(startFrame);
  return transport;
}

describe("TestBaseOutputTransportInterruptions", () => {
  const makeTransport = (mixer: BaseAudioMixer | null = null) => _makeTransport({ mixer });

  test("test_uninterruptible_audio_write_finishes_after_interruption", async () => {
    const transport = await makeTransport();
    const entered = new Event();
    const release = new Event();
    const finished = new Event();

    const write = async (_frame: unknown) => {
      entered.set();
      await release.wait();
      finished.set();
      return true;
    };

    transport.writeAudioFrame.mockImplementation(write);
    try {
      const sender = transport._mediaSenders.get(null);
      const frame = new TTSAudioRawFrame({
        audio: filled(0x01, sender.audioChunkSize),
        sampleRate: sender.sampleRate,
        numChannels: 1,
      });
      frame.interruptible = false;
      await transport.processFrame(frame, FrameDirection.DOWNSTREAM);
      await waitFor(() => entered.wait(), 1);
      await transport.processFrame(new InterruptionFrame(), FrameDirection.DOWNSTREAM);
      release.set();
      await waitFor(() => finished.wait(), 1);
    } finally {
      release.set();
      await transport.cancel(new CancelFrame());
    }
  });

  test("test_interruption_preserves_waiting_and_queued_uninterruptible_text", async () => {
    for (const interruptible of [true, false]) {
      // subTest(interruptible=interruptible)
      const transport = await makeTransport();
      try {
        const sender = transport._mediaSenders.get(null);
        const now = transport.getClock().getTime();
        const first = new TTSTextFrame({ text: "first", textType: "sentence" });
        first.interruptible = interruptible;
        first.pts = now + 100_000_000;
        const kept = new TTSTextFrame({ text: "kept", textType: "sentence" });
        kept.interruptible = false;
        kept.pts = now + 120_000_000;
        const dropped = new TTSTextFrame({ text: "dropped", textType: "sentence" });
        dropped.pts = now + 130_000_000;
        for (const frame of [first, kept, dropped]) {
          await transport.processFrame(frame, FrameDirection.DOWNSTREAM);
        }
        await sleep(0.01);
        expect(sender._clockFrame).toBe(first);
        await transport.processFrame(new InterruptionFrame(), FrameDirection.DOWNSTREAM);
        await waitFor(() => _clockIdle(sender), 1);
        const delivered = firstArgs(transport.pushFrame)
          .filter((f) => f instanceof TTSTextFrame)
          .map((f) => f.text);
        expect(delivered).toEqual(interruptible ? ["kept"] : ["first", "kept"]);
      } finally {
        await transport.cancel(new CancelFrame());
      }
    }
  });

  test("test_interruption_keeps_uninterruptible_leftover_audio_and_bot_speaking", async () => {
    const transport = await makeTransport();
    try {
      const sender = transport._mediaSenders.get(null);
      const chunkSize: number = sender.audioChunkSize;

      // A chunk and a half of uninterruptible audio, then a bit of normal audio:
      // one chunk plays and the rest waits in the buffer.
      const uninterruptible = new TTSAudioRawFrame({
        audio: filled(0x01, Math.floor((chunkSize * 3) / 2)),
        sampleRate: sender.sampleRate,
        numChannels: 1,
      });
      uninterruptible.interruptible = false;
      const normal = new TTSAudioRawFrame({
        audio: filled(0x02, Math.floor(chunkSize / 4)),
        sampleRate: sender.sampleRate,
        numChannels: 1,
      });
      await transport.processFrame(uninterruptible, FrameDirection.DOWNSTREAM);
      await transport.processFrame(normal, FrameDirection.DOWNSTREAM);
      await sleep(0.05);
      expect(sender._botSpeaking).toBe(true);

      await transport.processFrame(new InterruptionFrame(), FrameDirection.DOWNSTREAM);

      // The normal audio is dropped, the uninterruptible audio is kept, and the
      // bot is still speaking.
      expect(sender._bufferedAudioBytes).toEqual(Math.floor(chunkSize / 2));
      expect(sender._botSpeaking).toBe(true);
      let pushed = firstArgs(transport.pushFrame).map((f) => f.constructor);
      expect(pushed).not.toContain(BotStoppedSpeakingFrame);

      // The uninterruptible speech ends: its leftover audio plays and the bot
      // stops speaking.
      await transport.processFrame(new TTSStoppedFrame(), FrameDirection.DOWNSTREAM);
      await sleep(0.05);

      const written = concat(...firstArgs(transport.writeAudioFrame).map((f) => f.audio));
      expect(written).toEqual(
        concat(uninterruptible.audio, new Uint8Array(Math.floor(chunkSize / 2))),
      );
      pushed = firstArgs(transport.pushFrame).map((f) => f.constructor);
      expect(pushed).toContain(BotStoppedSpeakingFrame);
    } finally {
      await transport.cancel(new CancelFrame());
    }
  });

  test("test_interruption_stops_bot_speaking_with_only_uninterruptible_control_frames", async () => {
    const transport = await makeTransport();
    const release = new Event();

    const write = async (_frame: unknown) => {
      await release.wait();
      return true;
    };

    transport.writeAudioFrame.mockImplementation(write);
    try {
      const sender = transport._mediaSenders.get(null);

      // The bot is speaking, with more audio and a function call (an
      // uninterruptible control frame) queued behind it.
      const audio = new TTSAudioRawFrame({
        audio: filled(0x01, sender.audioChunkSize * 2),
        sampleRate: sender.sampleRate,
        numChannels: 1,
      });
      await transport.processFrame(audio, FrameDirection.DOWNSTREAM);
      const functionCall = new FunctionCallInProgressFrame({
        functionName: "get_weather",
        toolCallId: "1",
        arguments: {},
      });
      await transport.processFrame(functionCall, FrameDirection.DOWNSTREAM);
      await sleep(0.01);
      expect(sender._botSpeaking).toBe(true);

      await transport.processFrame(new InterruptionFrame(), FrameDirection.DOWNSTREAM);

      // The function call is kept, but there's no audio left to play.
      expect(sender._audioQueue.hasFrame(FunctionCallInProgressFrame)).toBe(true);
      expect(sender._botSpeaking).toBe(false);
      const pushed = firstArgs(transport.pushFrame).map((f) => f.constructor);
      expect(pushed).toContain(BotStoppedSpeakingFrame);
    } finally {
      release.set();
      await transport.cancel(new CancelFrame());
    }
  });

  test("test_interruption_with_mixer_keeps_audio_task_and_mixer_output", async () => {
    const transport = await makeTransport(new _PassthroughMixer());
    try {
      const sender = transport._mediaSenders.get(null);
      const taskBefore = sender._audioTask;
      expect(taskBefore).not.toBeNull();

      // Mixer-only frames flow while the queue is empty.
      await sleep(0.1);
      expect(transport.writeAudioFrame.mock.calls.length).toBeGreaterThan(0);

      await transport.processFrame(new InterruptionFrame(), FrameDirection.DOWNSTREAM);

      // Same task object: not cancelled and not recreated.
      expect(sender._audioTask).toBe(taskBefore);
      expect(taskBefore.cancelled()).toBe(false);

      // Mixer frames keep flowing across the interruption.
      const countAfterInterruption = transport.writeAudioFrame.mock.calls.length;
      await sleep(0.1);
      expect(transport.writeAudioFrame.mock.calls.length).toBeGreaterThan(countAfterInterruption);
    } finally {
      await transport.cancel(new CancelFrame());
    }
  });

  test("test_interruption_without_mixer_keeps_audio_task", async () => {
    const transport = await makeTransport(null);
    try {
      const sender = transport._mediaSenders.get(null);
      const taskBefore = sender._audioTask;
      expect(taskBefore).not.toBeNull();

      await transport.processFrame(new InterruptionFrame(), FrameDirection.DOWNSTREAM);

      expect(sender._audioTask).toBe(taskBefore);
    } finally {
      await transport.cancel(new CancelFrame());
    }
  });

  test("test_interruption_with_mixer_still_discards_queued_bot_audio", async () => {
    const transport = await makeTransport(new _PassthroughMixer());
    try {
      const sender = transport._mediaSenders.get(null);

      // Pause the audio task by patching write_audio_frame with a slow
      // write, so the queued bot audio can't be consumed before the
      // interruption arrives.
      const writeStarted = new Event();
      const releaseWrite = new Event();

      const slowWrite = async (_frame: unknown) => {
        writeStarted.set();
        await releaseWrite.wait();
        return true;
      };

      transport.writeAudioFrame = asyncMock(slowWrite);
      await writeStarted.wait();

      // Queue bot audio (one full chunk) behind the in-flight write.
      const botAudio = new OutputAudioRawFrame({
        audio: repeated([0x01, 0x02], Math.floor(sender.audioChunkSize / 2)),
        sampleRate: sender.sampleRate,
        numChannels: 1,
      });
      await transport.processFrame(botAudio, FrameDirection.DOWNSTREAM);
      expect(sender._audioQueue.empty()).toBe(false);

      await transport.processFrame(new InterruptionFrame(), FrameDirection.DOWNSTREAM);

      // The queued bot audio was dropped by the reset.
      expect(sender._audioQueue.empty()).toBe(true);
      releaseWrite.set();
    } finally {
      await transport.cancel(new CancelFrame());
    }
  });
});

/** A chunk cut from the audio buffer keeps the `interruptible` flag of the audio it holds. */
describe("TestBaseOutputTransportChunkInterruptibility", () => {
  test("test_chunks_carry_the_flag_of_their_audio", async () => {
    const transport = await _makeTransport({ mixer: null });
    try {
      const sender = transport._mediaSenders.get(null);
      const chunkSize: number = sender.audioChunkSize;
      const half = Math.floor(chunkSize / 2);

      const frame = (audio: Uint8Array, options: { interruptible: boolean }) => {
        const f = new TTSAudioRawFrame({
          audio,
          sampleRate: sender.sampleRate,
          numChannels: 1,
          contextId: "ctx",
        });
        f.interruptible = options.interruptible;
        return f;
      };

      // One uninterruptible chunk, then a chunk that spans an uninterruptible
      // frame and a plain one, then a plain chunk.
      for (const f of [
        frame(filled(0x01, chunkSize), { interruptible: false }),
        frame(filled(0x02, half), { interruptible: false }),
        frame(filled(0x03, half), { interruptible: true }),
        frame(filled(0x04, chunkSize), { interruptible: true }),
      ]) {
        await transport.processFrame(f, FrameDirection.DOWNSTREAM);
      }
      await sleep(0.1);

      const written = firstArgs(transport.writeAudioFrame);
      expect(written.map((w) => w.interruptible)).toEqual([false, false, true]);
    } finally {
      await transport.cancel(new CancelFrame());
    }
  });
});

/**
 * Test for the trailing-partial-chunk audio buffer.
 *
 * `MediaSender` only enqueues complete `audioChunkSize` chunks (see
 * `handleAudioFrame`); whatever hasn't reached a full chunk stays buffered.
 * When `TTSStoppedFrame` arrives, that leftover audio is padded with silence
 * to a full chunk and queued for playback (see `handleTtsStopped`), instead
 * of being silently discarded.
 */
describe("TestBaseOutputTransportAudioBuffering", () => {
  test("test_tts_stopped_frame_flushes_partial_chunk_padded_with_silence", async () => {
    const transport = await _makeTransport({ mixer: null });
    try {
      const sender = transport._mediaSenders.get(null);
      const chunkSize: number = sender.audioChunkSize;

      // A full chunk: gets queued and played immediately, and marks the
      // bot as speaking so `_botStoppedSpeaking` won't just no-op.
      const fullAudio = repeated([0x01, 0x02], Math.floor(chunkSize / 2));
      const fullChunk = new TTSAudioRawFrame({
        audio: fullAudio,
        sampleRate: sender.sampleRate,
        numChannels: 1,
        contextId: "ctx1",
      });
      await transport.processFrame(fullChunk, FrameDirection.DOWNSTREAM);
      await sleep(0.1);
      expect(sender._botSpeaking).toBe(true);

      let written = concat(...firstArgs(transport.writeAudioFrame).map((f) => f.audio));
      expect(written).toEqual(fullAudio);

      // Trailing audio that doesn't fill up a whole chunk, like the last
      // bit of a TTS turn typically would.
      const partialLen = Math.floor(chunkSize / 2);
      const partialAudio = repeated([0x03, 0x04], Math.floor(partialLen / 2));
      const partialChunk = new TTSAudioRawFrame({
        audio: partialAudio,
        sampleRate: sender.sampleRate,
        numChannels: 1,
        contextId: "ctx1",
      });
      await transport.processFrame(partialChunk, FrameDirection.DOWNSTREAM);

      // It's sitting in the buffer, not yet queued for playback.
      expect(sender._bufferedAudioBytes).toEqual(partialLen);

      // TTSStoppedFrame marks the end of the turn: the leftover audio
      // should be padded with silence and flushed, not discarded.
      await transport.processFrame(
        new TTSStoppedFrame({ contextId: "ctx1" }),
        FrameDirection.DOWNSTREAM,
      );
      await sleep(0.1);

      // Everything written to the transport across both calls: the
      // first full chunk, followed by the flushed partial chunk once
      // it's been padded out to `chunkSize` with silence.
      written = concat(...firstArgs(transport.writeAudioFrame).map((f) => f.audio));
      const silencePadding = new Uint8Array(chunkSize - partialLen);
      const expected = concat(fullAudio, partialAudio, silencePadding);
      expect(written).toEqual(expected);
      // The buffer should be drained by the flush, not just cleared.
      expect(sender._bufferedAudioBytes).toEqual(0);
    } finally {
      await transport.cancel(new CancelFrame());
    }
  });

  /**
   * A turn whose entire audio never fills one chunk must still flush as the
   * frame type it was buffered from (e.g. `TTSAudioRawFrame`), so that
   * bot-speaking tracking (which dispatches on frame type) still fires for
   * it, instead of silently skipping start/stop speaking events.
   */
  test("test_tts_stopped_frame_for_short_turn_signals_bot_speaking", async () => {
    const transport = await _makeTransport({ mixer: null });
    try {
      const sender = transport._mediaSenders.get(null);
      const chunkSize: number = sender.audioChunkSize;

      // Audio shorter than a single chunk: never queued by
      // `handleAudioFrame`, only ever sitting in the buffer.
      const partialAudio = repeated([0x03, 0x04], Math.floor(chunkSize / 4));
      const partialChunk = new TTSAudioRawFrame({
        audio: partialAudio,
        sampleRate: sender.sampleRate,
        numChannels: 1,
        contextId: "ctx1",
      });
      await transport.processFrame(partialChunk, FrameDirection.DOWNSTREAM);
      expect(sender._bufferedAudioBytes).toEqual(partialAudio.length);
      expect(sender._botSpeaking).toBe(false);

      await transport.processFrame(
        new TTSStoppedFrame({ contextId: "ctx1" }),
        FrameDirection.DOWNSTREAM,
      );
      await sleep(0.1);

      // The flushed frame must be written as the buffered frame's
      // original type, not a generic `OutputAudioRawFrame`, so that bot
      // speaking tracking (which dispatches on frame type) recognizes it.
      const writtenFrame = transport.writeAudioFrame.mock.calls[0][0];
      expect(writtenFrame).toBeInstanceOf(TTSAudioRawFrame);
      const silencePadding = new Uint8Array(chunkSize - partialAudio.length);
      expect(writtenFrame.audio).toEqual(concat(partialAudio, silencePadding));

      // Bot started and stopped speaking events must have fired even
      // though no full chunk was ever queued for this turn.
      const pushedTypes = firstArgs(transport.pushFrame).map((f) => f.constructor);
      expect(pushedTypes).toContain(BotStartedSpeakingFrame);
      expect(pushedTypes).toContain(BotStoppedSpeakingFrame);
    } finally {
      await transport.cancel(new CancelFrame());
    }
  });
});

async function _makeWedgingTransport(
  writeAudioFrame: Patchable,
  options: { timeout: number },
): Promise<Patchable> {
  const params = new TransportParams({
    audioOutEnabled: true,
    audioOutEndSilenceSecs: 0,
    audioOutWriteTimeoutSecs: options.timeout,
  });
  const transport: Patchable = new BaseOutputTransport(params);
  transport.pushFrame = asyncMock();
  transport.writeAudioFrame = writeAudioFrame;

  await transport.setup(_setup());
  const startFrame = new StartFrame();
  await transport.processFrame(startFrame, FrameDirection.DOWNSTREAM);
  await transport.setTransportReady(startFrame);
  return transport;
}

function _oneSecondOfAudio(): OutputAudioRawFrame {
  // 16kHz, 16-bit mono, which the sender splits into 40ms chunks.
  return new OutputAudioRawFrame({
    audio: new Uint8Array(16000 * 2),
    sampleRate: 16000,
    numChannels: 1,
  });
}

/** A peer that stops reading blocks the write on buffers that never drain. */
describe("TestBaseOutputTransportWriteTimeout", () => {
  /** `processFrame` pushes the EndFrame only after `stop()` returns. */
  test("test_end_frame_still_reaches_downstream", async () => {
    const neverReturns = new Event();

    const wedged = async (_frame: unknown) => {
      await neverReturns.wait();
      return true;
    };

    const transport = await _makeWedgingTransport(asyncMock(wedged), { timeout: 0.5 });
    await transport.processFrame(_oneSecondOfAudio(), FrameDirection.DOWNSTREAM);
    await sleep(0.1);

    const endFrame = new EndFrame();
    await waitFor(() => transport.processFrame(endFrame, FrameDirection.DOWNSTREAM), 10.0);

    const pushed = firstArgs(transport.pushFrame);
    expect(pushed).toContain(endFrame);
  });

  /** Paying the timeout per queued frame would hang shutdown by a slower route. */
  test("test_peer_is_written_off_once", async () => {
    const neverReturns = new Event();

    const wedged = async (_frame: unknown) => {
      await neverReturns.wait();
      return true;
    };

    const write = asyncMock(wedged);
    const transport = await _makeWedgingTransport(write, { timeout: 0.3 });

    // A second of audio is 25 chunks, so a per-frame timeout would show up here.
    await transport.processFrame(_oneSecondOfAudio(), FrameDirection.DOWNSTREAM);
    await sleep(1.0);

    expect(write.mock.calls.length).toEqual(1);
    expect(transport.isUsable).toBe(false);
  });

  /** Long playout is legitimately slow; only a stalled write is written off. */
  test("test_slow_write_within_the_bound_is_not_cut_short", async () => {
    const slow = async (_frame: unknown) => {
      await sleep(0.05);
      return true;
    };

    const write = asyncMock(slow);
    const transport = await _makeWedgingTransport(write, { timeout: 1.0 });

    await transport.processFrame(_oneSecondOfAudio(), FrameDirection.DOWNSTREAM);
    await waitFor(() => transport.processFrame(new EndFrame(), FrameDirection.DOWNSTREAM), 30.0);

    // A second of audio is ~25 chunks; a written-off peer would show one
    // write, so the exact count (resampling shifts it) doesn't matter.
    expect(write.mock.calls.length).toBeGreaterThan(20);
    expect(transport.isUsable).toBe(true);
  }, 35_000);
});

/**
 * Tests for audio that has to be resampled to the transport's output rate.
 *
 * `MediaSender` resamples on arrival, ahead of the paced `_audioQueue`, so it
 * sits idle whenever TTS delivers audio in bursts. Its resampler must
 * therefore keep the audio held in its filter across those pauses, and give
 * it up only when the speech run actually ends.
 */
describe("TestBaseOutputTransportResampling", () => {
  const TTS_RATE = 16000;
  const OUT_RATE = 8000;

  const framesFrom = (audio: Uint8Array, chunkSamples: number): TTSAudioRawFrame[] => {
    const chunk = chunkSamples * 2;
    const frames: TTSAudioRawFrame[] = [];
    for (let offset = 0; offset < audio.length; offset += chunk) {
      frames.push(
        new TTSAudioRawFrame({
          audio: audio.slice(offset, offset + chunk),
          sampleRate: TTS_RATE,
          numChannels: 1,
          contextId: "ctx1",
        }),
      );
    }
    return frames;
  };

  /** Split a ramp of TTS-rate audio into frames, as a TTS service would. */
  const _ttsFrames = (sampleCount: number, chunkSamples = 640): TTSAudioRawFrame[] => {
    const audio = new Uint8Array(sampleCount * 2);
    for (let i = 0; i < sampleCount; i++) {
      const v = i % 251;
      audio[i * 2] = v & 0xff;
      audio[i * 2 + 1] = (v >> 8) & 0xff;
    }
    return framesFrom(audio, chunkSamples);
  };

  /** TTS frames holding a constant level, so leftovers are easy to spot. */
  const _constantFrames = (
    value: number,
    sampleCount: number,
    chunkSamples = 640,
  ): TTSAudioRawFrame[] => {
    const samples = new Int16Array(sampleCount).fill(value);
    return framesFrom(new Uint8Array(samples.buffer), chunkSamples);
  };

  const _written = (transport: Patchable): Uint8Array =>
    concat(...firstArgs(transport.writeAudioFrame).map((f) => f.audio));

  /**
   * A pause between TTS chunks must not cost any audio.
   *
   * The resampler runs ahead of playback, so a gap between two chunks says
   * nothing about the stream: the audio either side of it is one utterance,
   * and all of it has to reach the transport.
   */
  test("test_delivery_pause_does_not_drop_audio", async () => {
    const transport = await _makeTransport({ audioOutSampleRate: OUT_RATE });
    try {
      const sender = transport._mediaSenders.get(null);
      const inSamples = 16000;

      const frames = _ttsFrames(inSamples);
      for (const [index, frame] of frames.entries()) {
        if (index === 12) {
          // A delivery pause longer than the resampler's inactivity
          // timeout, e.g. a TTS round trip between two sentences.
          await sleep(0.3);
        }
        await transport.processFrame(frame, FrameDirection.DOWNSTREAM);
      }

      await transport.processFrame(
        new TTSStoppedFrame({ contextId: "ctx1" }),
        FrameDirection.DOWNSTREAM,
      );
      await sleep(0.2);

      // Every input sample reaches the transport, give or take the
      // silence the last partial chunk is padded with.
      const expected = Math.floor((inSamples * OUT_RATE) / TTS_RATE);
      const written = Math.floor(_written(transport).length / 2);
      expect(written).toBeGreaterThanOrEqual(expected);
      expect(written).toBeLessThan(expected + Math.floor(sender.audioChunkSize / 2));
    } finally {
      await transport.cancel(new CancelFrame());
    }
  });

  /** Audio cut short is dropped, not carried into what the bot says next. */
  test("test_interruption_does_not_replay_aborted_audio", async () => {
    const transport = await _makeTransport({ audioOutSampleRate: OUT_RATE });
    try {
      const sender = transport._mediaSenders.get(null);

      for (const frame of _constantFrames(8000, 8000)) {
        await transport.processFrame(frame, FrameDirection.DOWNSTREAM);
      }
      await sleep(0.1);
      expect(sender._botSpeaking).toBe(true);

      await transport.processFrame(new InterruptionFrame(), FrameDirection.DOWNSTREAM);
      await sleep(0.1);
      const alreadyWritten = transport.writeAudioFrame.mock.calls.length;

      // The next turn is entirely negative, so anything positive in it is
      // left over from the turn that was cut short.
      for (const frame of _constantFrames(-8000, 8000)) {
        await transport.processFrame(frame, FrameDirection.DOWNSTREAM);
      }
      await transport.processFrame(
        new TTSStoppedFrame({ contextId: "ctx1" }),
        FrameDirection.DOWNSTREAM,
      );
      await sleep(0.2);

      const after = concat(
        ...firstArgs(transport.writeAudioFrame)
          .slice(alreadyWritten)
          .map((f) => f.audio),
      );
      const samples = int16(after);
      expect(samples.length).toBeGreaterThan(0);
      expect(Math.max(...samples)).toBeLessThanOrEqual(0);
    } finally {
      await transport.cancel(new CancelFrame());
    }
  });
});

/** The output filter runs on the audio the pipeline sends, before it is written. */
describe("TestBaseOutputTransportAudioFilter", () => {
  /** One chunk of audio, every byte set to `fill`. */
  const _audio = (transport: Patchable, fill = 1): OutputAudioRawFrame => {
    const sender = transport._mediaSenders.get(null);
    return new OutputAudioRawFrame({
      audio: filled(fill, sender.audioChunkSize),
      sampleRate: sender.sampleRate,
      numChannels: 1,
    });
  };

  const _written = (transport: Patchable): string[] =>
    firstArgs(transport.writeAudioFrame).map((f) => _fingerprint(f.audio));

  test("test_transport_writes_the_filtered_audio", async () => {
    const audioFilter = new _InvertingFilter();
    const transport = await _makeTransport({ audioFilter });
    try {
      expect(audioFilter.sampleRate).toEqual(transport.sampleRate);

      const frame = _audio(transport);
      const audio = frame.audio;
      await transport.processFrame(frame, FrameDirection.DOWNSTREAM);
      await sleep(0.1);
      expect(_written(transport)).toEqual([_fingerprint(_inverted(audio))]);
    } finally {
      await transport.cleanup();
    }
    expect(audioFilter.stops).toEqual(1);
  });

  test("test_transport_skips_a_chunk_the_filter_empties", async () => {
    const audioFilter: Patchable = new _InvertingFilter();
    audioFilter.filter = asyncMock(async () => new Uint8Array(0));
    const transport = await _makeTransport({ audioFilter });
    try {
      await transport.processFrame(_audio(transport), FrameDirection.DOWNSTREAM);
      await sleep(0.1);

      expect(audioFilter.filter.mock.calls.length).toEqual(1);
      expect(_written(transport)).toEqual([]);
    } finally {
      await transport.cancel(new CancelFrame());
    }
  });

  test("test_filter_runs_before_the_mixer_and_skips_mixer_audio", async () => {
    const audioFilter = new _InvertingFilter();
    const mixer: Patchable = new _PassthroughMixer();
    mixer.mix = asyncMock(async (audio: Uint8Array) => audio);
    const transport = await _makeTransport({ mixer, audioFilter });
    try {
      const frame = _audio(transport);
      const audio = frame.audio;
      await transport.processFrame(frame, FrameDirection.DOWNSTREAM);
      await sleep(0.1);

      // The mixer mixes a silent chunk on each pass with an empty queue,
      // and the filter gets none of them.
      expect(audioFilter.calls).toEqual([_fingerprint(audio)]);
      const mixed = firstArgs(mixer.mix).map((a) => _fingerprint(a));
      expect(mixed).toContain(_fingerprint(_inverted(audio)));
    } finally {
      await transport.cancel(new CancelFrame());
    }
  });

  test("test_control_frames_reach_the_filter_in_order_with_the_audio", async () => {
    const audioFilter = new _InvertingFilter();
    const transport = await _makeTransport({ audioFilter });
    try {
      const releaseWrite = new Event();

      const heldWrite = async (_frame: unknown) => {
        await releaseWrite.wait();
        return true;
      };

      transport.writeAudioFrame = asyncMock(heldWrite);
      const [first, second, third] = [1, 2, 3].map((fill) => _audio(transport, fill)) as [
        OutputAudioRawFrame,
        OutputAudioRawFrame,
        OutputAudioRawFrame,
      ];
      const audio = [first, second, third].map((frame) => _fingerprint(frame.audio));
      const controls = [
        new FilterEnableFrame({ enable: false }),
        new FilterUpdateSettingsFrame({ settings: {} }),
      ];

      // The first chunk holds the write, so the second chunk is still
      // queued when the control frames arrive.
      await transport.processFrame(first, FrameDirection.DOWNSTREAM);
      await sleep(0.1);
      for (const frame of [second, ...controls, third]) {
        await transport.processFrame(frame, FrameDirection.DOWNSTREAM);
      }
      releaseWrite.set();
      await sleep(0.1);

      expect(audioFilter.calls).toEqual([audio[0], audio[1], ...controls, audio[2]]);
    } finally {
      await transport.cancel(new CancelFrame());
    }
  });
});

/** The output volume, and the gain on it, scale the audio that follows them. */
describe("TestBaseOutputTransportVolume", () => {
  /** One chunk of audio, every sample set to `sample`. */
  const _audio = (transport: Patchable, sample = 1000): OutputAudioRawFrame => {
    const sender = transport._mediaSenders.get(null);
    const samples = new Int16Array(Math.floor(sender.audioChunkSize / 2)).fill(sample);
    return new OutputAudioRawFrame({
      audio: new Uint8Array(samples.buffer),
      sampleRate: sender.sampleRate,
      numChannels: 1,
    });
  };

  /** The first sample of each chunk written, in order. */
  const _written = (transport: Patchable): number[] =>
    firstArgs(transport.writeAudioFrame).map((f) => int16(f.audio)[0] as number);

  test("test_transport_writes_audio_at_its_volume", async () => {
    const transport = await _makeTransport({ audioOutVolume: 0.5 });
    try {
      await transport.processFrame(_audio(transport), FrameDirection.DOWNSTREAM);
      await sleep(0.1);

      expect(_written(transport)).toEqual([500]);
    } finally {
      await transport.cancel(new CancelFrame());
    }
  });

  test("test_volume_and_gain_scale_the_audio_after_them", async () => {
    const transport = await _makeTransport();
    try {
      const frames = [
        _audio(transport),
        new VolumeFrame({ volume: 0.5 }),
        _audio(transport),
        new VolumeGainFrame({ gain: 0.5 }),
        _audio(transport),
        new VolumeGainFrame({ gain: 1.0 }),
        _audio(transport),
      ];
      for (const frame of frames) {
        await transport.processFrame(frame, FrameDirection.DOWNSTREAM);
      }
      await sleep(0.1);

      expect(_written(transport)).toEqual([1000, 500, 250, 500]);
    } finally {
      await transport.cancel(new CancelFrame());
    }
  });

  test("test_an_interruption_keeps_the_gain_frames", async () => {
    const transport = await _makeTransport();
    try {
      const releaseWrite = new Event();

      const heldWrite = async (_frame: unknown) => {
        await releaseWrite.wait();
        return true;
      };

      transport.writeAudioFrame = asyncMock(heldWrite);

      // The first chunk holds the write, so the gain frames and the quiet
      // chunk between them are still queued when the user interrupts.
      await transport.processFrame(_audio(transport), FrameDirection.DOWNSTREAM);
      await sleep(0.1);
      for (const frame of [
        new VolumeGainFrame({ gain: 0.5 }),
        _audio(transport),
        new VolumeGainFrame({ gain: 1.0 }),
      ]) {
        await transport.processFrame(frame, FrameDirection.DOWNSTREAM);
      }
      await transport.processFrame(new InterruptionFrame(), FrameDirection.DOWNSTREAM);
      releaseWrite.set();
      await transport.processFrame(_audio(transport), FrameDirection.DOWNSTREAM);
      await sleep(0.1);

      // The quiet chunk is dropped, and the audio after it plays at full
      // volume again.
      expect(_written(transport)).toEqual([1000, 1000]);
    } finally {
      await transport.cancel(new CancelFrame());
    }
  });

  test("test_a_loud_gain_clips_to_the_sample_range", async () => {
    const transport = await _makeTransport();
    try {
      for (const frame of [new VolumeGainFrame({ gain: 2.0 }), _audio(transport, 30000)]) {
        await transport.processFrame(frame, FrameDirection.DOWNSTREAM);
      }
      await sleep(0.1);

      expect(_written(transport)).toEqual([32767]);
    } finally {
      await transport.cancel(new CancelFrame());
    }
  });
});
