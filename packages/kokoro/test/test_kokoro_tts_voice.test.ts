// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_kokoro_tts_voice.py

/**
 * Tests for KokoroTTSService voice validation at construction.
 *
 * The model and voices file are replaced with stand-ins so nothing is
 * downloaded.
 *
 * Porting notes:
 * - `patch("...Kokoro")` → `mock.module()` on `kokoro_onnx.ts`, with a fake
 *   whose `load()` returns an object holding just `voices`.
 * - `patch("..._ensure_model_files")` → the model and voices paths point at
 *   existing stand-in files, so `_ensureModelFiles()` downloads nothing.
 * - DIVERGENCE: the model loads asynchronously after construction, so the
 *   unknown voice is rejected by `_loadKokoro()` (what `start()` runs), not by
 *   the constructor. A missing or blank voice is still rejected at
 *   construction.
 */

import { afterAll, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const engine = new URL("../src/kokoro_onnx.ts", import.meta.url).pathname;
const real = await import(engine);
mock.module(engine, () => ({
  ...real,
  Kokoro: {
    load: async () => ({ voices: new Map([["af_heart", {}]]) }),
  },
}));

const { KokoroTTSService } = await import("../src/tts.ts");

const dir = mkdtempSync(join(tmpdir(), "kokoro-test-"));
const modelPath = join(dir, "kokoro-v1.0.onnx");
const voicesPath = join(dir, "voices-v1.0.bin");
writeFileSync(modelPath, "stand-in");
writeFileSync(voicesPath, "stand-in");

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  mock.restore();
});

function _build(settings: Record<string, unknown>) {
  return new KokoroTTSService({
    modelPath,
    voicesPath,
    settings: new KokoroTTSService.Settings(settings),
  });
}

test("test_a_known_voice_constructs", async () => {
  const tts = _build({ voice: "af_heart" });
  await tts._loadKokoro();
  expect((tts as unknown as { _settings: { voice: string } })._settings.voice).toBe("af_heart");
});

describe("test_missing_or_blank_voice_is_rejected", () => {
  for (const [id, voice] of [
    ["none", null],
    ["blank", ""],
  ] as const) {
    test(id, () => {
      expect(() => _build({ voice })).toThrow("Kokoro TTS voice must be specified");
    });
  }
});

test("test_unknown_voice_is_rejected_at_construction", async () => {
  // DIVERGENCE: rejected when the model loads (in start()), not in the constructor.
  const tts = _build({ voice: "af_nope" });
  await expect(tts._loadKokoro()).rejects.toThrow("'af_nope' is not in the voices file");
});
