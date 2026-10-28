// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

import { describe, expect, test } from "bun:test";

import {
  VAD_MIN_VOLUME,
  VADParams,
  volumeFromDb,
  volumeToDb,
} from "../src/audio/vad/vad_analyzer.ts";

describe("VADParams minVolumeDb", () => {
  test("maps LUFS onto the 0-1 volume calculateAudioVolume reports", () => {
    expect(volumeFromDb(-110)).toBe(0);
    expect(volumeFromDb(-10)).toBe(1);
    expect(volumeFromDb(-35)).toBeCloseTo(0.75);
    expect(volumeFromDb(-200)).toBe(0);
    expect(volumeFromDb(0)).toBe(1);
    expect(volumeToDb(VAD_MIN_VOLUME)).toBeCloseTo(-50);
  });

  test("sets minVolume, and reads back", () => {
    const params = new VADParams({ minVolumeDb: -35 });
    expect(params.minVolume).toBeCloseTo(0.75);
    expect(params.minVolumeDb).toBeCloseTo(-35);

    params.minVolumeDb = -60;
    expect(params.minVolume).toBeCloseTo(0.5);
    expect(new VADParams().minVolumeDb).toBeCloseTo(-50);
  });

  test("rejects both minVolume and minVolumeDb", () => {
    expect(() => new VADParams({ minVolume: 0.5, minVolumeDb: -35 })).toThrow(
      "set either minVolume or minVolumeDb",
    );
  });
});
