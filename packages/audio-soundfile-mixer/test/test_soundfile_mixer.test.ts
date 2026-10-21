// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_soundfile_mixer.py
//
// Upstream writes WAV files into pytest's tmp_path with soundfile; here they are
// written into a temp directory with a small WAV writer (helpers.ts), so the
// tests go through the same path-reading code.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MixerEnableFrame, MixerUpdateSettingsFrame } from "@pipedog/core/frames/frames";
import { SoundfileMixer, type SoundfileMixerOptions } from "../src/index.ts";
import { pcm, samplesOf, wavBytes } from "./helpers.ts";

const SAMPLE_RATE = 16000;
let tmp: string;
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "soundfile-mixer-"));
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function writeWav(name: string, samples: number[], sampleRate = SAMPLE_RATE): string {
  const path = join(tmp, name);
  writeFileSync(path, wavBytes(samples, sampleRate));
  return path;
}

async function startedMixer(
  soundFiles: Record<string, string>,
  defaultSound: string,
  options: Partial<SoundfileMixerOptions> = {},
) {
  const mixer = new SoundfileMixer({ soundFiles, defaultSound, ...options });
  await mixer.start(SAMPLE_RATE);
  return mixer;
}

const sounds = (mixer: SoundfileMixer): Record<string, Int16Array> => (mixer as any)._sounds;

describe("test_soundfile_mixer", () => {
  test("test_start_loads_files_matching_sample_rate", async () => {
    const path = writeWav("a.wav", [1, 2, 3]);

    const mixer = await startedMixer({ a: path }, "a");

    expect(Object.keys(sounds(mixer))).toEqual(["a"]);
    expect(Array.from(sounds(mixer).a as Int16Array)).toEqual([1, 2, 3]);
  });

  test("test_start_skips_file_with_wrong_sample_rate", async () => {
    const path = writeWav("a8k.wav", [1, 2, 3], 8000);

    const mixer = await startedMixer({ a: path }, "a");

    expect(sounds(mixer)).toEqual({});
    // With nothing loaded, mixing passes the input through untouched.
    const audio = pcm([10, 20, 30]);
    expect(await mixer.mix(audio)).toEqual(audio);
  });

  test("test_start_ignores_missing_file", async () => {
    const mixer = await startedMixer({ a: join(tmp, "missing.wav") }, "a");

    expect(sounds(mixer)).toEqual({});
    // With nothing loaded, mixing passes the input through untouched.
    const audio = pcm([10, 20, 30]);
    expect(await mixer.mix(audio)).toEqual(audio);
  });

  test("test_mix_adds_sound_scaled_by_volume", async () => {
    const path = writeWav("a.wav", [1000, 1000, 1000]);
    const mixer = await startedMixer({ a: path }, "a", { volume: 0.5 });

    const mixed = await mixer.mix(pcm([100, 200, 300]));

    expect(samplesOf(mixed)).toEqual([600, 700, 800]);
  });

  test("test_mix_clips_to_int16_range", async () => {
    const path = writeWav("a.wav", [30000, -30000]);
    const mixer = await startedMixer({ a: path }, "a", { volume: 1.0 });

    const mixed = await mixer.mix(pcm([30000, -30000]));

    expect(samplesOf(mixed)).toEqual([32767, -32768]);
  });

  test("test_mix_consumes_sound_sequentially", async () => {
    const path = writeWav("a.wav", [1, 2, 3, 4]);
    const mixer = await startedMixer({ a: path }, "a", { volume: 1.0 });

    const first = await mixer.mix(pcm([0, 0]));
    const second = await mixer.mix(pcm([0, 0]));

    expect(samplesOf(first)).toEqual([1, 2]);
    expect(samplesOf(second)).toEqual([3, 4]);
  });

  test("test_mix_loops_when_sound_runs_out", async () => {
    const path = writeWav("a.wav", [1, 2, 3, 4]);
    const mixer = await startedMixer({ a: path }, "a", { volume: 1.0, loop: true });

    await mixer.mix(pcm([0, 0, 0]));
    const looped = await mixer.mix(pcm([0, 0, 0]));

    expect(samplesOf(looped)).toEqual([1, 2, 3]);
  });

  test("test_mix_passes_audio_through_when_not_looping", async () => {
    const path = writeWav("a.wav", [1, 2, 3, 4]);
    const mixer = await startedMixer({ a: path }, "a", { volume: 1.0, loop: false });

    await mixer.mix(pcm([0, 0, 0]));
    const audio = pcm([5, 5, 5]);

    expect(await mixer.mix(audio)).toEqual(audio);
  });

  test("test_mixer_enable_frame_toggles_mixing", async () => {
    const path = writeWav("a.wav", [1000, 1000]);
    const mixer = await startedMixer({ a: path }, "a", { volume: 1.0 });
    const audio = pcm([1, 1]);

    await mixer.processFrame(new MixerEnableFrame({ enable: false }));
    expect(await mixer.mix(audio)).toEqual(audio);

    await mixer.processFrame(new MixerEnableFrame({ enable: true }));
    expect(samplesOf(await mixer.mix(audio))).toEqual([1001, 1001]);
  });

  test("test_update_settings_changes_sound_and_restarts_it", async () => {
    const a = writeWav("a.wav", [100, 200, 300, 400]);
    const b = writeWav("b.wav", [5, 6, 7, 8]);
    const mixer = await startedMixer({ a, b }, "a", { volume: 1.0 });

    await mixer.mix(pcm([0, 0]));
    await mixer.processFrame(new MixerUpdateSettingsFrame({ settings: { sound: "b" } }));
    const mixed = await mixer.mix(pcm([0, 0]));

    // The new sound starts from its first sample, not from the previous position.
    expect(samplesOf(mixed)).toEqual([5, 6]);
  });

  test("test_update_settings_ignores_unknown_sound", async () => {
    const a = writeWav("a.wav", [100, 200, 300, 400]);
    const mixer = await startedMixer({ a }, "a", { volume: 1.0 });

    await mixer.processFrame(new MixerUpdateSettingsFrame({ settings: { sound: "nope" } }));
    const mixed = await mixer.mix(pcm([0, 0]));

    expect(samplesOf(mixed)).toEqual([100, 200]);
  });

  test("test_update_settings_changes_volume_and_loop", async () => {
    const a = writeWav("a.wav", [1000, 1000, 1000, 1000]);
    const mixer = await startedMixer({ a }, "a", { volume: 1.0, loop: true });

    await mixer.processFrame(
      new MixerUpdateSettingsFrame({ settings: { volume: 0.5, loop: false } }),
    );

    expect(samplesOf(await mixer.mix(pcm([0, 0])))).toEqual([500, 500]);
    expect(samplesOf(await mixer.mix(pcm([0, 0])))).toEqual([500, 500]);
    // The sound is exhausted and looping is off, so audio passes through.
    const audio = pcm([7, 7]);
    expect(await mixer.mix(audio)).toEqual(audio);
  });
});
