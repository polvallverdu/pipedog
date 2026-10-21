// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// LocalSmartTurnAnalyzerV3 without an injected session: it loads
// @pipedog/audio-smart-turn when that package is installed, and otherwise ends
// turns on the VAD's silence instead of failing.

import { describe, expect, test } from "bun:test";
import { LocalSmartTurnAnalyzerV3 } from "../src/audio/turn/smart_turn/local_smart_turn_v3.ts";
import { type LogRecord, logger } from "../src/utils/logger.ts";

type Internals = {
  _session: Promise<unknown>;
  _predictEndpoint(audio: Float32Array): Promise<{ prediction: number; probability: number }>;
};

describe("LocalSmartTurnAnalyzerV3 default session", () => {
  test("loads the model from @pipedog/audio-smart-turn when it's installed", async () => {
    const analyzer = new LocalSmartTurnAnalyzerV3() as unknown as Internals;
    expect(await analyzer._session).not.toBeNull();
    const result = await analyzer._predictEndpoint(new Float32Array(16000));
    expect(result.probability).toBeGreaterThanOrEqual(0);
    expect(result.probability).toBeLessThanOrEqual(1);
  }, 30_000);

  test("falls back to ending turns on VAD silence, with one warning, when it can't load", async () => {
    const warnings: string[] = [];
    const remove = logger.addSink((record: LogRecord) => {
      if (record.level === "WARNING") warnings.push(record.message);
    });
    try {
      const a = new LocalSmartTurnAnalyzerV3({
        smartTurnModelPath: "/nonexistent/smart-turn.onnx",
      }) as unknown as Internals;
      const b = new LocalSmartTurnAnalyzerV3({
        smartTurnModelPath: "/nonexistent/smart-turn.onnx",
      }) as unknown as Internals;
      expect(await a._session).toBeNull();
      expect(await b._session).toBeNull();
      expect(await a._predictEndpoint(new Float32Array(16000))).toEqual({
        prediction: 1,
        probability: 1,
      });
      expect(warnings.filter((w) => w.includes("Smart Turn is unavailable")).length).toBe(1);
    } finally {
      remove();
    }
  });

  test("an explicit createSession that fails still fails", async () => {
    const analyzer = new LocalSmartTurnAnalyzerV3({
      createSession: async () => {
        throw new Error("no runtime here");
      },
    }) as unknown as Internals;
    await expect(analyzer._session).rejects.toThrow("no runtime here");
  });
});
