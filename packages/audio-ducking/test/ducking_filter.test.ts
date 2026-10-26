// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

import { describe, expect, test } from "bun:test";
import { AudioDuckingFilter } from "@pipedog/audio-ducking";
import {
  BotStoppedSpeakingFrame,
  FilterEnableFrame,
  FilterUpdateSettingsFrame,
  type Frame,
  InterruptionFrame,
  type OutputAudioRawFrame,
  type StartFrame,
  TTSAudioRawFrame,
  VADUserStartedSpeakingFrame,
  VADUserStoppedSpeakingFrame,
} from "@pipedog/core/frames/frames";
import { FramePushed } from "@pipedog/core/observers/base_observer";
import { PipelineParams } from "@pipedog/core/pipeline/worker";
import type { FrameProcessor } from "@pipedog/core/processors/frame_processor";
import { FrameDirection } from "@pipedog/core/processors/frame_processor";
import { runTest, SleepFrame } from "@pipedog/core/tests/utils";
import { BaseOutputTransport } from "@pipedog/core/transports/base_output";
import { TransportParams } from "@pipedog/core/transports/base_transport";

function pcm(samples: number[]): Uint8Array {
  return new Uint8Array(new Int16Array(samples).buffer);
}

function samples(audio: Uint8Array): number[] {
  return Array.from(new Int16Array(audio.slice().buffer));
}

async function push(filter: AudioDuckingFilter, frame: Frame): Promise<void> {
  const data = new FramePushed({
    source: null as unknown as FrameProcessor,
    destination: null as unknown as FrameProcessor,
    frame,
    direction: FrameDirection.DOWNSTREAM,
    timestamp: 0,
  });
  if (filter.observer.acceptsPush(data)) await filter.observer.onPushFrame(data);
}

describe("AudioDuckingFilter", () => {
  test("passes audio through untouched when not ducked", async () => {
    const filter = new AudioDuckingFilter();
    const audio = pcm([1000, -1000]);
    expect(await filter.filter(audio)).toBe(audio);
  });

  test("ramps down over one chunk, then holds, then ramps back up", async () => {
    const filter = new AudioDuckingFilter({ duckedGain: 0.5 });
    filter.duck();
    expect(samples(await filter.filter(pcm([1000, 1000, 1000, 1000])))).toEqual([
      875, 750, 625, 500,
    ]);
    expect(samples(await filter.filter(pcm([1000, -1000])))).toEqual([500, -500]);
    filter.restore();
    expect(samples(await filter.filter(pcm([1000, 1000])))).toEqual([750, 1000]);
    const audio = pcm([1000]);
    expect(await filter.filter(audio)).toBe(audio);
  });

  test("clamps, and keeps an odd trailing byte", async () => {
    const filter = new AudioDuckingFilter({ duckedGain: 0 });
    filter.duck();
    const out = await filter.filter(new Uint8Array([0xff, 0x7f, 0x01]));
    expect(out.byteLength).toBe(3);
    expect(samples(out.subarray(0, 2))).toEqual([0]);
    expect(out[2]).toBe(1);
  });

  test("control frames change the gain and enable it", async () => {
    const filter = new AudioDuckingFilter();
    await filter.processFrame(new FilterUpdateSettingsFrame({ settings: { duckedGain: 0.25 } }));
    expect(filter.duckedGain).toBe(0.25);
    await filter.processFrame(new FilterEnableFrame({ enable: false }));
    filter.duck();
    const audio = pcm([1000]);
    expect(await filter.filter(audio)).toBe(audio);
    expect(() => new AudioDuckingFilter({ duckedGain: 2 })).toThrow(RangeError);
  });

  test("the observer ducks on the user's voice and restores", async () => {
    const filter = new AudioDuckingFilter();
    await push(filter, new VADUserStartedSpeakingFrame());
    expect(filter.ducked).toBe(true);
    await push(filter, new VADUserStoppedSpeakingFrame());
    expect(filter.ducked).toBe(false);
    for (const frame of [new InterruptionFrame(), new BotStoppedSpeakingFrame()]) {
      filter.duck();
      await push(filter, frame);
      expect(filter.ducked).toBe(false);
    }
  });
});

class RecordingOutputTransport extends BaseOutputTransport {
  written: Uint8Array[] = [];

  override async start(frame: StartFrame): Promise<void> {
    await super.start(frame);
    await this.setTransportReady(frame);
  }

  override async writeAudioFrame(frame: OutputAudioRawFrame): Promise<boolean> {
    this.written.push(frame.audio);
    return true;
  }
}

describe("AudioDuckingFilter in an output transport", () => {
  test("lowers the audio written while the user speaks", async () => {
    const ducking = new AudioDuckingFilter({ duckedGain: 0.5 });
    const transport = new RecordingOutputTransport(
      new TransportParams({ audioOutEnabled: true, audioOutFilter: ducking }),
    );
    // The transport writes 40 ms chunks: 640 samples at 16 kHz.
    const chunk = () =>
      new TTSAudioRawFrame({
        audio: pcm(new Array(640).fill(1000)),
        sampleRate: 16000,
        numChannels: 1,
      });
    await runTest(transport, {
      framesToSend: [
        chunk(),
        new SleepFrame({ sleep: 0.1 }),
        new VADUserStartedSpeakingFrame(),
        new SleepFrame({ sleep: 0.1 }),
        chunk(),
        chunk(),
        new SleepFrame({ sleep: 0.1 }),
      ],
      observers: [ducking.observer],
      pipelineParams: new PipelineParams({ audioOutSampleRate: 16000 }),
    });
    const speech = transport.written.filter((audio) => samples(audio).some((s) => s !== 0));
    expect(speech.map((audio) => samples(audio).at(-1))).toEqual([1000, 500, 500]);
    // The ramp starts where the previous chunk ended.
    expect(samples(speech[1] as Uint8Array)[0]).toBe(999);
  });
});
