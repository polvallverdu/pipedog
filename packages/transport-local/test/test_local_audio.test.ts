// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/** The local audio transport against a fake process spawner (upstream has no tests for it). */

import { afterEach, describe, expect, test } from "bun:test";
import { createTask, sleep, type Task, waitFor } from "@pipedog/asyncio";
import {
  EndFrame,
  type Frame,
  InputAudioRawFrame,
  OutputAudioRawFrame,
} from "@pipedog/core/frames/frames";
import { Pipeline } from "@pipedog/core/pipeline/pipeline";
import { PipelineParams, PipelineWorker } from "@pipedog/core/pipeline/worker";
import { type FrameDirection, FrameProcessor } from "@pipedog/core/processors/frame_processor";
import { WorkerRunner } from "@pipedog/core/workers/runner";
import {
  detectAudioTool,
  LocalAudioBackend,
  LocalAudioToolNotFoundError,
  LocalAudioTransport,
  LocalAudioTransportParams,
  playCommand,
  recordCommand,
} from "../src/index.ts";
import { type FakeSpawner, fakeSpawner } from "./helpers.ts";

class Capture extends FrameProcessor {
  frames: Frame[] = [];
  override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
    await super.processFrame(frame, direction);
    this.frames.push(frame);
    await this.pushFrame(frame, direction);
  }
}

let cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const c of cleanups.reverse()) await c();
  cleanups = [];
});

async function run(processors: FrameProcessor[], params: Partial<PipelineParams> = {}) {
  const worker = new PipelineWorker(new Pipeline(processors), {
    cancelOnIdleTimeout: false,
    params: new PipelineParams({ audioInSampleRate: 16000, audioOutSampleRate: 16000, ...params }),
  });
  const runner = new WorkerRunner({ handleSigint: false });
  await runner.addWorkers(worker);
  const task: Task<void> = createTask(() => runner.run());
  cleanups.push(() => runner.cancel());
  return { worker, task };
}

describe("command lines", () => {
  const spec = { sampleRate: 16000, channels: 1 };
  test("sox records and plays raw PCM on the default device", () => {
    expect(recordCommand("sox", spec).join(" ")).toBe(
      "sox -q -d -t raw -r 16000 -e signed-integer -b 16 -c 1 -L -",
    );
    expect(playCommand("sox", { ...spec, channels: 2 }).join(" ")).toBe(
      "sox -q -t raw -r 16000 -e signed-integer -b 16 -c 2 -L - -d",
    );
  });

  test("sox takes a device for the platform's driver", () => {
    expect(
      recordCommand("sox", { ...spec, device: "MacBook Microphone", platform: "darwin" }),
    ).toContain("coreaudio");
    expect(playCommand("sox", { ...spec, device: "hw:1", platform: "linux" }).slice(-3)).toEqual([
      "-t",
      "alsa",
      "hw:1",
    ]);
  });

  test("ffmpeg uses AVFoundation and AudioToolbox on macOS, PulseAudio on Linux", () => {
    const rec = recordCommand("ffmpeg", { ...spec, platform: "darwin" });
    expect(rec).toContain("avfoundation");
    expect(rec).toContain(":default");
    expect(rec.slice(-7)).toEqual(["-f", "s16le", "-ar", "16000", "-ac", "1", "pipe:1"]);
    expect(playCommand("ffmpeg", { ...spec, platform: "darwin", device: 2 }).join(" ")).toContain(
      "-f audiotoolbox -audio_device_index 2 -",
    );
    expect(recordCommand("ffmpeg", { ...spec, platform: "linux" }).join(" ")).toContain(
      "-f pulse -i default",
    );
    expect(
      playCommand("ffmpeg", { ...spec, platform: "linux", device: "alsa_output.x" }).slice(-3),
    ).toEqual(["-f", "pulse", "alsa_output.x"]);
  });

  test("ffmpeg on Windows needs a capture device and cannot play", () => {
    expect(() => recordCommand("ffmpeg", { ...spec, platform: "win32" })).toThrow("DirectShow");
    expect(recordCommand("ffmpeg", { ...spec, platform: "win32", device: "Mic" })).toContain(
      "audio=Mic",
    );
    expect(() => playCommand("ffmpeg", { ...spec, platform: "win32" })).toThrow("sox");
  });
});

describe("detectAudioTool", () => {
  test("prefers sox, falls back to ffmpeg", async () => {
    expect(await detectAudioTool({ spawner: fakeSpawner(["sox", "ffmpeg"]).spawner })).toBe("sox");
    expect(await detectAudioTool({ spawner: fakeSpawner(["ffmpeg"]).spawner })).toBe("ffmpeg");
    expect(
      await detectAudioTool({ tool: "ffmpeg", spawner: fakeSpawner(["sox", "ffmpeg"]).spawner }),
    ).toBe("ffmpeg");
  });

  test("neither installed is a clear error", async () => {
    const error = await detectAudioTool({ spawner: fakeSpawner([]).spawner }).catch((e) => e);
    expect(error).toBeInstanceOf(LocalAudioToolNotFoundError);
    expect(error.message).toContain("sox or ffmpeg");
    expect(error.message).toContain("brew install sox");
    const asked = await detectAudioTool({
      tool: "sox",
      spawner: fakeSpawner(["ffmpeg"]).spawner,
    }).catch((e) => e);
    expect(asked).toBeInstanceOf(LocalAudioToolNotFoundError);
    expect(asked.message).toContain("set to use sox");
  });

  test("a tool that exits non-zero does not count", async () => {
    const spawner = async () => ({ exited: Promise.resolve(1) }) as never;
    await expect(detectAudioTool({ spawner })).rejects.toBeInstanceOf(LocalAudioToolNotFoundError);
  });

  test("the transport's setup fails with the error when nothing is installed", async () => {
    const params = new LocalAudioTransportParams({ spawner: fakeSpawner([]).spawner });
    const backend = new LocalAudioBackend(params);
    await expect(backend.resolveTool()).rejects.toBeInstanceOf(LocalAudioToolNotFoundError);
  });
});

describe("LocalAudioTransport", () => {
  function transport(
    fake: FakeSpawner,
    options: Partial<ConstructorParameters<typeof LocalAudioTransportParams>[0]> = {},
  ) {
    return new LocalAudioTransport(
      new LocalAudioTransportParams({
        audioInEnabled: true,
        audioOutEnabled: true,
        spawner: fake.spawner,
        ...options,
      }),
    );
  }

  test("input: the recorder's output becomes 20 ms InputAudioRawFrames", async () => {
    const fake = fakeSpawner(["sox"]);
    const t = transport(fake);
    const capture = new Capture();
    const { worker, task } = await run([t.input(), capture]);

    for (let i = 0; i < 100 && fake.processes.length === 0; i++) await sleep(0.02);
    const recorder = fake.processes[0];
    expect(recorder?.cmd.slice(0, 3)).toEqual(["sox", "-q", "-d"]);

    // 1500 bytes in odd pieces: two full 640-byte frames and a 220-byte remainder.
    const pcm = Uint8Array.from({ length: 1500 }, (_, i) => i % 251);
    recorder?.emit(pcm.slice(0, 301));
    recorder?.emit(pcm.slice(301, 1100));
    recorder?.emit(pcm.slice(1100));
    for (
      let i = 0;
      i < 100 && capture.frames.filter((f) => f instanceof InputAudioRawFrame).length < 2;
      i++
    ) {
      await sleep(0.02);
    }
    const audio = capture.frames.filter(
      (f): f is InputAudioRawFrame => f instanceof InputAudioRawFrame,
    );
    expect(audio).toHaveLength(2);
    expect(audio.map((f) => f.audio.length)).toEqual([640, 640]);
    expect(audio[0]?.sampleRate).toBe(16000);
    expect(audio[0]?.numChannels).toBe(1);
    expect(audio[0]?.audio).toEqual(pcm.slice(0, 640));
    expect(audio[1]?.audio).toEqual(pcm.slice(640, 1280));

    await worker.queueFrames([new EndFrame()]);
    await waitFor(() => task, 10);
    expect(recorder?.killed).toBe(true);
  });

  test("input: stereo capture asks the tool for two channels", async () => {
    const fake = fakeSpawner(["ffmpeg"]);
    const t = transport(fake, { audioInChannels: 2, inputDevice: 3, tool: "ffmpeg" });
    const { worker, task } = await run([t.input()]);
    for (let i = 0; i < 100 && fake.processes.length === 0; i++) await sleep(0.02);
    expect(fake.processes[0]?.cmd.join(" ")).toContain("-ac 2");
    await worker.queueFrames([new EndFrame()]);
    await waitFor(() => task, 10);
  });

  test("output: audio frames are written to the player's stdin, then it is stopped", async () => {
    const fake = fakeSpawner(["sox"]);
    const t = transport(fake);
    const { worker, task } = await run([t.output()]);
    const audio = Uint8Array.from({ length: 6400 }, (_, i) => (i * 7) % 255); // 200 ms
    await worker.queueFrames([
      new OutputAudioRawFrame({ audio, sampleRate: 16000, numChannels: 1 }),
      new EndFrame(),
    ]);
    await waitFor(() => task, 10);
    const player = fake.processes[0];
    expect(player?.cmd.slice(-1)).toEqual(["-d"]);
    const written = new Uint8Array((player?.written ?? []).reduce((n, c) => n + c.length, 0));
    let o = 0;
    for (const c of player?.written ?? []) {
      written.set(c, o);
      o += c.length;
    }
    expect(written.length).toBeGreaterThanOrEqual(audio.length);
    expect(written.slice(0, audio.length)).toEqual(audio);
    expect(player?.killed).toBe(true);
  });

  test("output: writes are paced to the audio's duration", async () => {
    const fake = fakeSpawner(["sox"]);
    const t = transport(fake);
    const { worker, task } = await run([t.output()]);
    const start = performance.now();
    await worker.queueFrames([
      new OutputAudioRawFrame({ audio: new Uint8Array(16000), sampleRate: 16000, numChannels: 1 }), // 0.5 s
      new EndFrame(),
    ]);
    await waitFor(() => task, 10);
    expect(performance.now() - start).toBeGreaterThan(350);
  });

  test("input and output share one tool lookup", async () => {
    const fake = fakeSpawner(["sox"]);
    const t = transport(fake);
    const { worker, task } = await run([t.input(), t.output()]);
    for (let i = 0; i < 100 && fake.processes.length < 2; i++) await sleep(0.02);
    expect(fake.processes.map((p) => p.cmd.at(-1))).toEqual(["-", "-d"]);
    await worker.queueFrames([new EndFrame()]);
    await waitFor(() => task, 10);
    expect(fake.processes.every((p) => p.killed)).toBe(true);
  });

  test("an unexpected recorder exit is reported as an error", async () => {
    const fake = fakeSpawner(["sox"]);
    const t = transport(fake);
    const errors: unknown[] = [];
    const input = t.input();
    input.eventHandler("on_error", async (_p: unknown, error: unknown) => void errors.push(error));
    const { worker, task } = await run([input]);
    for (let i = 0; i < 100 && fake.processes.length === 0; i++) await sleep(0.02);
    fake.processes[0]?.finish(1);
    for (let i = 0; i < 100 && errors.length === 0; i++) await sleep(0.02);
    expect(String((errors[0] as { error?: string })?.error ?? errors[0])).toContain(
      "exited with code 1",
    );
    await worker.queueFrames([new EndFrame()]);
    await waitFor(() => task, 10);
  });
});
