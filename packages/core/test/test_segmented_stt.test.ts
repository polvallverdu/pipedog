// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipecat-ts contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_segmented_stt.py

import { expect, test } from "bun:test";

import { sleep } from "@pipecat-ts/asyncio";

import {
  type Frame,
  InputAudioRawFrame,
  MetricsFrame,
  TranscriptionFrame,
  VADUserStartedSpeakingFrame,
  VADUserStoppedSpeakingFrame,
} from "../src/frames/frames.ts";
import { STTUsageMetricsData } from "../src/metrics/metrics.ts";
import { PipelineParams } from "../src/pipeline/worker.ts";
import {
  SegmentedSTTService,
  type SegmentedSTTServiceOptions,
} from "../src/services/stt_service.ts";
import { runTest } from "../src/tests/utils.ts";

const SAMPLE_RATE = 16000;

/** Equivalent of `bytes(range(0, 240)) * 4` in Python. */
function makePcm(): Uint8Array {
  const out = new Uint8Array(240 * 4);
  for (let r = 0; r < 4; r++) for (let i = 0; i < 240; i++) out[r * 240 + i] = i;
  return out;
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

// Distinct, non-zero 16-bit samples so a misread WAV header would be obvious.
const PCM = makePcm(); // 960 bytes, even length
// What the default trailingSilenceSecs (0.5 s) appends, as 16-bit mono PCM.
const DEFAULT_SILENCE = new Uint8Array(Math.trunc(SAMPLE_RATE * 0.5) * 2);

interface CapturingOptions extends SegmentedSTTServiceOptions {
  wantsWav?: boolean | null;
  transcribeSecs?: number;
}

/**
 * Build a SegmentedSTTService that captures the bytes handed to runStt().
 *
 * Defined as a factory (not a module-level class) so this concrete subclass
 * isn't picked up by the service-discovery scan in test_service_init, which
 * would try to construct it and fail on its (intentionally minimal) settings.
 *
 * @param options.wantsWav If null, inherit the base default; otherwise force
 *   the `wantsWavSegments` contract to this value.
 * @param options.transcribeSecs When set, `runStt` takes this long and then
 *   yields a `TranscriptionFrame` naming the segment ("segment 1", ...).
 */
function makeCapturingService(options: CapturingOptions = {}) {
  const { wantsWav = null, transcribeSecs = 0.0, ...kwargs } = options;

  class _CapturingSegmentedSTTService extends SegmentedSTTService {
    captured: Uint8Array[] = [];

    constructor(opts: SegmentedSTTServiceOptions) {
      super({ ...opts, sampleRate: SAMPLE_RATE });
    }

    override canGenerateMetrics(): boolean {
      return true;
    }

    async *runStt(audio: Uint8Array): AsyncGenerator<Frame | null, void, unknown> {
      this.captured.push(audio);
      if (transcribeSecs) {
        await sleep(transcribeSecs);
        yield new TranscriptionFrame({
          text: `segment ${this.captured.length}`,
          userId: "",
          timestamp: "",
        });
      }
    }
  }

  if (wantsWav !== null) {
    Object.defineProperty(_CapturingSegmentedSTTService.prototype, "wantsWavSegments", {
      get: () => wantsWav,
      configurable: true,
    });
  }

  return new _CapturingSegmentedSTTService(kwargs);
}

function segmentFrames(): Frame[] {
  return [
    new VADUserStartedSpeakingFrame(),
    new InputAudioRawFrame({ audio: PCM, sampleRate: SAMPLE_RATE, numChannels: 1 }),
    new VADUserStoppedSpeakingFrame(),
  ];
}

async function driveOneSegment(service: SegmentedSTTService): Promise<void> {
  await runTest(service, { framesToSend: segmentFrames() });
}

/** Drive one segment with usage metrics on and return the reported audio seconds. */
async function driveOneSegmentWithUsage(service: SegmentedSTTService): Promise<number> {
  const [receivedDown] = await runTest(service, {
    framesToSend: segmentFrames(),
    pipelineParams: new PipelineParams({ enableUsageMetrics: true }),
  });
  const usageData: STTUsageMetricsData[] = [];
  for (const f of receivedDown) {
    if (f instanceof MetricsFrame) {
      for (const d of f.data) {
        if (d instanceof STTUsageMetricsData) usageData.push(d);
      }
    }
  }
  expect(usageData.length).toBe(1);
  return usageData[0]!.value.audioSeconds;
}

/** Minimal equivalent of Python's `wave` reader: validate the header and return the frames. */
function wavFrames(audio: Uint8Array): Uint8Array {
  const view = new DataView(audio.buffer, audio.byteOffset, audio.byteLength);
  const ascii = (off: number, len: number) =>
    String.fromCharCode(...audio.subarray(off, off + len));
  expect(ascii(0, 4)).toBe("RIFF");
  expect(ascii(8, 4)).toBe("WAVE");
  let offset = 12;
  let fmtSeen = false;
  while (offset + 8 <= audio.length) {
    const id = ascii(offset, 4);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === "fmt ") {
      fmtSeen = true;
      expect(view.getUint16(body, true)).toBe(1); // PCM
      expect(view.getUint32(body + 4, true)).toBe(SAMPLE_RATE); // framerate
      expect(view.getUint16(body + 14, true)).toBe(16); // sampwidth == 2
      expect(view.getUint16(body + 2, true)).toBe(1); // nchannels
    } else if (id === "data") {
      expect(fmtSeen).toBe(true);
      return audio.subarray(body, body + size);
    }
    offset = body + size + (size % 2);
  }
  throw new Error("no data chunk in WAV");
}

test("test_audio_keeps_flowing_while_a_segment_is_transcribed", async () => {
  // A streaming STT never holds the audio path while a transcript is pending;
  // neither does a segmented one: audio sent after the VAD stop reaches
  // downstream before the segment's transcript does.
  const service = makeCapturingService({ transcribeSecs: 0.2, trailingSilenceSecs: 0 });
  const afterStop = Array.from(
    { length: 3 },
    () => new InputAudioRawFrame({ audio: PCM, sampleRate: SAMPLE_RATE, numChannels: 1 }),
  );

  const [receivedDown] = await runTest(service, {
    framesToSend: [...segmentFrames(), ...afterStop],
  });

  const kinds = receivedDown.map((f) => f.constructor);
  const transcriptAt = kinds.indexOf(TranscriptionFrame);
  expect(transcriptAt).toBeGreaterThanOrEqual(0);
  const audioAt = kinds.flatMap((k, i) => (k === InputAudioRawFrame ? [i] : []));
  expect(audioAt.length).toBe(4);
  expect(audioAt.every((i) => i < transcriptAt)).toBe(true);
});

test("test_segments_are_transcribed_in_order_and_flushed_on_stop", async () => {
  const service = makeCapturingService({ transcribeSecs: 0.05, trailingSilenceSecs: 0 });

  const [receivedDown] = await runTest(service, {
    framesToSend: [...segmentFrames(), ...segmentFrames(), ...segmentFrames()],
  });

  const transcripts = receivedDown
    .filter((f): f is TranscriptionFrame => f instanceof TranscriptionFrame)
    .map((f) => f.text);
  expect(transcripts).toEqual(["segment 1", "segment 2", "segment 3"]);
});

test("test_default_mode_wraps_segment_in_wav", async () => {
  const service = makeCapturingService({ trailingSilenceSecs: 0 });
  expect(service.wantsWavSegments).toBe(true);

  await driveOneSegment(service);

  expect(service.captured.length).toBe(1);
  // A valid WAV container with the right sample rate and the exact PCM payload.
  expect(wavFrames(service.captured[0]!)).toEqual(PCM);
});

test("test_passthrough_mode_preserves_exact_pcm", async () => {
  const service = makeCapturingService({ wantsWav: false, trailingSilenceSecs: 0 });
  expect(service.wantsWavSegments).toBe(false);

  await driveOneSegment(service);

  expect(service.captured.length).toBe(1);
  // Raw PCM, byte-for-byte: no WAV header prepended.
  expect(service.captured[0]).toEqual(PCM);
});

test("test_segment_emits_usage_for_raw_buffer_duration", async () => {
  // WAV mode: usage must measure the PCM audio, not the WAV container.
  const service = makeCapturingService({ trailingSilenceSecs: 0 });

  const audioSeconds = await driveOneSegmentWithUsage(service);

  expect(audioSeconds).toBeCloseTo(PCM.length / (SAMPLE_RATE * 2), 6);
});

test("test_segment_is_padded_with_trailing_silence_by_default", async () => {
  const service = makeCapturingService({ wantsWav: false });

  await driveOneSegment(service);

  expect(service.captured).toEqual([concat(PCM, DEFAULT_SILENCE)]);
});

test("test_wav_segment_includes_trailing_silence", async () => {
  const service = makeCapturingService();

  await driveOneSegment(service);

  expect(wavFrames(service.captured[0]!)).toEqual(concat(PCM, DEFAULT_SILENCE));
});

test("test_trailing_silence_is_configurable", async () => {
  const service = makeCapturingService({ wantsWav: false, trailingSilenceSecs: 0.1 });

  await driveOneSegment(service);

  expect(service.captured).toEqual([
    concat(PCM, new Uint8Array(Math.trunc(SAMPLE_RATE * 0.1) * 2)),
  ]);
});

test("test_usage_includes_trailing_silence", async () => {
  // The padding is submitted to the provider, so it counts as audio usage.
  const service = makeCapturingService();

  const audioSeconds = await driveOneSegmentWithUsage(service);

  expect(audioSeconds).toBeCloseTo((PCM.length + DEFAULT_SILENCE.length) / (SAMPLE_RATE * 2), 6);
});
