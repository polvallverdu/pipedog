// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipecat-ts contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_krisp_ip_user_turn_start_strategy.py

import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { KrispVivaSDKManager } from "../src/audio/krisp_instance.ts";
import {
  BotStartedSpeakingFrame,
  BotStoppedSpeakingFrame,
  InputAudioRawFrame,
  TranscriptionFrame,
  VADUserStartedSpeakingFrame,
  VADUserStoppedSpeakingFrame,
} from "../src/frames/frames.ts";
import { ProcessFrameResult } from "../src/turns/types.ts";
import {
  type KrispIpSession,
  KrispVivaIPUserTurnStartStrategy,
  type KrispVivaIPUserTurnStartStrategyOptions,
} from "../src/turns/user_start/krisp_viva_ip_user_turn_start_strategy.ts";

// Upstream mocks the `krisp_audio` module and patches `krisp_audio.IpFloat.create`
// to return a mock session. The TS port isolates SDK session creation in
// `_createIpSession()`, so the mock is installed by overriding that hook.
const mockIpFloat = {
  create: mock((_sampleRate: number): KrispIpSession => mockIpSession),
};
let mockIpSession: { process: ReturnType<typeof mock<KrispIpSession["process"]>> };

class MockedKrispVivaIPUserTurnStartStrategy extends KrispVivaIPUserTurnStartStrategy {
  protected override _createIpSession(sampleRate: number): KrispIpSession {
    return mockIpFloat.create(sampleRate);
  }
}

// Internal state, accessed as upstream does.
type StrategyInternals = {
  _audioBuffer: Uint8Array;
  _speechActive: boolean;
  _decisionMade: boolean;
  _ipSession: KrispIpSession | null;
  _sdkAcquired: boolean;
  _modelPath: string;
};
const internals = (s: KrispVivaIPUserTurnStartStrategy) => s as unknown as StrategyInternals;

function _int16Silence(numSamples: number): Uint8Array {
  return new Uint8Array(numSamples * 2);
}

describe("TestKrispVivaIPUserTurnStartStrategy", () => {
  let tempDir: string;
  let modelPath: string;
  let mockSdkManager: {
    acquire: ReturnType<typeof spyOn>;
    release: ReturnType<typeof spyOn>;
  };

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "krisp-ip-"));
    modelPath = join(tempDir, "model.kef");
    writeFileSync(modelPath, "dummy");

    mockIpSession = { process: mock((_frame: Float32Array, _speechActive: boolean) => 0) };
    mockIpFloat.create.mockReset();
    mockIpFloat.create.mockImplementation((_sampleRate: number) => mockIpSession);

    mockSdkManager = {
      acquire: spyOn(KrispVivaSDKManager, "acquire").mockImplementation(() => {}),
      release: spyOn(KrispVivaSDKManager, "release").mockImplementation(() => {}),
    };
  });

  afterEach(() => {
    mockSdkManager.acquire.mockRestore();
    mockSdkManager.release.mockRestore();
    rmSync(tempDir, { recursive: true, force: true });
  });

  function _makeStrategy(
    options: { threshold?: number; frameDurationMs?: number } = {},
  ): MockedKrispVivaIPUserTurnStartStrategy {
    return new MockedKrispVivaIPUserTurnStartStrategy({
      modelPath,
      threshold: options.threshold ?? 0.5,
      frameDurationMs: options.frameDurationMs ?? 20,
      apiKey: "test-key",
    });
  }

  function _audioFrame(
    options: { sampleRate?: number; frameDurationMs?: number; numSamples?: number | null } = {},
  ): InputAudioRawFrame {
    const sampleRate = options.sampleRate ?? 16000;
    const frameDurationMs = options.frameDurationMs ?? 20;
    const samples =
      options.numSamples != null
        ? options.numSamples
        : Math.trunc((sampleRate * frameDurationMs) / 1000);
    return new InputAudioRawFrame({
      audio: _int16Silence(samples),
      sampleRate,
      numChannels: 1,
    });
  }

  test("test_interruption_detected_emits_turn_and_stop", async () => {
    mockIpSession.process = mock(() => 0.87);

    const strategy = _makeStrategy({ threshold: 0.5 });
    try {
      let fired = false;

      strategy.eventHandler("on_user_turn_started", async (_strategy, _params) => {
        fired = true;
      });

      await strategy.processFrame(new VADUserStartedSpeakingFrame());
      const result = await strategy.processFrame(_audioFrame());

      expect(fired).toBe(true);
      expect(result).toEqual(ProcessFrameResult.STOP);
      expect(mockIpSession.process).toHaveBeenCalled();
    } finally {
      await strategy.cleanup();
    }
  });

  test("test_backchannel_suppressed_no_event_continue", async () => {
    mockIpSession.process = mock(() => 0.23);

    const strategy = _makeStrategy({ threshold: 0.5 });
    try {
      let fired = false;

      strategy.eventHandler("on_user_turn_started", async (_strategy, _params) => {
        fired = true;
      });

      await strategy.processFrame(new VADUserStartedSpeakingFrame());
      const result = await strategy.processFrame(_audioFrame());

      expect(fired).toBe(false);
      expect(result).toEqual(ProcessFrameResult.CONTINUE);
    } finally {
      await strategy.cleanup();
    }
  });

  test("test_reset_on_vad_stopped_clears_state", async () => {
    mockIpSession.process = mock(() => 0.1);

    const strategy = _makeStrategy({ threshold: 0.5 });
    try {
      await strategy.processFrame(new VADUserStartedSpeakingFrame());
      await strategy.processFrame(_audioFrame());
      mockIpSession.process.mockClear();

      await strategy.processFrame(new VADUserStoppedSpeakingFrame());
      const result = await strategy.processFrame(_audioFrame());

      expect(result).toEqual(ProcessFrameResult.CONTINUE);
      // process() is still called (continuous state), but with speech_active=False
      expect(mockIpSession.process).toHaveBeenCalled();
      const args = mockIpSession.process.mock.lastCall as unknown[];
      expect(args[1]).toBeFalsy(); // speech_active should be False
    } finally {
      await strategy.cleanup();
    }
  });

  test("test_reset_on_bot_stopped_clears_state", async () => {
    mockIpSession.process = mock(() => 0.1);

    const strategy = _makeStrategy({ threshold: 0.5 });
    try {
      await strategy.processFrame(new VADUserStartedSpeakingFrame());
      await strategy.processFrame(_audioFrame());
      mockIpSession.process.mockClear();

      await strategy.processFrame(new BotStoppedSpeakingFrame());
      const result = await strategy.processFrame(_audioFrame());

      expect(result).toEqual(ProcessFrameResult.CONTINUE);
      // process() is still called (continuous state), but with speech_active=False
      expect(mockIpSession.process).toHaveBeenCalled();
      const args = mockIpSession.process.mock.lastCall as unknown[];
      expect(args[1]).toBeFalsy(); // speech_active should be False
    } finally {
      await strategy.cleanup();
    }
  });

  test("test_no_op_before_vad_start", async () => {
    mockIpSession.process = mock(() => 0.99);

    const strategy = _makeStrategy();
    try {
      const result = await strategy.processFrame(_audioFrame());
      expect(result).toEqual(ProcessFrameResult.CONTINUE);
      // process() is called (continuous state) even before VAD start,
      // but _speech_active=False prevents triggering despite high prob
      expect(mockIpSession.process).toHaveBeenCalled();
      const args = mockIpSession.process.mock.lastCall as unknown[];
      expect(args[1]).toBeFalsy(); // speech_active should be False
    } finally {
      await strategy.cleanup();
    }
  });

  test("test_decision_sticks_no_double_trigger", async () => {
    mockIpSession.process = mock(() => 0.9);

    const strategy = _makeStrategy({ threshold: 0.5 });
    try {
      let count = 0;

      strategy.eventHandler("on_user_turn_started", async (_strategy, _params) => {
        count += 1;
      });

      await strategy.processFrame(new VADUserStartedSpeakingFrame());
      const r1 = await strategy.processFrame(_audioFrame());
      const r2 = await strategy.processFrame(_audioFrame());

      expect(r1).toEqual(ProcessFrameResult.STOP);
      expect(r2).toEqual(ProcessFrameResult.CONTINUE);
      expect(count).toEqual(1);
    } finally {
      await strategy.cleanup();
    }
  });

  test("test_reset_clears_audio_buffer", async () => {
    mockIpSession.process = mock(() => 0.1);

    const strategy = _makeStrategy({ threshold: 0.5 });
    try {
      await strategy.processFrame(new VADUserStartedSpeakingFrame());
      // Feed a partial frame (smaller than samples_per_frame) so it stays in buffer
      await strategy.processFrame(_audioFrame({ numSamples: 10 }));
      expect(internals(strategy)._audioBuffer.length).toBeGreaterThan(0);

      await strategy.processFrame(new VADUserStoppedSpeakingFrame());
      expect(internals(strategy)._audioBuffer.length).toEqual(0);
    } finally {
      await strategy.cleanup();
    }
  });

  test("test_unrelated_frames_continue", async () => {
    const strategy = _makeStrategy();
    try {
      const r1 = await strategy.processFrame(new BotStartedSpeakingFrame());
      const r2 = await strategy.processFrame(
        new TranscriptionFrame({ text: "hi", userId: "", timestamp: "" }),
      );
      expect(r1).toEqual(ProcessFrameResult.CONTINUE);
      expect(r2).toEqual(ProcessFrameResult.CONTINUE);
    } finally {
      await strategy.cleanup();
    }
  });

  test("test_handle_user_turn_started_clears_state", async () => {
    mockIpSession.process = mock(() => 0.1);

    const strategy = _makeStrategy({ threshold: 0.5 });
    try {
      await strategy.processFrame(new VADUserStartedSpeakingFrame());
      await strategy.processFrame(_audioFrame({ numSamples: 10 }));
      expect(internals(strategy)._speechActive).toBe(true);
      expect(internals(strategy)._audioBuffer.length).toBeGreaterThan(0);

      await strategy.handleUserTurnStarted();

      expect(internals(strategy)._speechActive).toBe(false);
      expect(internals(strategy)._audioBuffer.length).toEqual(0);
      expect(internals(strategy)._decisionMade).toBe(false);
    } finally {
      await strategy.cleanup();
    }
  });

  test("test_cleanup_releases_sdk", async () => {
    const strategy = _makeStrategy();

    await strategy.cleanup();

    expect(mockSdkManager.release).toHaveBeenCalledTimes(1);
    expect(internals(strategy)._ipSession).toBeNull();
    expect(internals(strategy)._sdkAcquired).toBe(false);
  });

  test("test_init_raises_if_no_model_path", () => {
    // Cleared, since the constructor falls back to KRISP_VIVA_IP_MODEL_PATH
    // and an ambient value would satisfy it.
    const saved = process.env.KRISP_VIVA_IP_MODEL_PATH;
    delete process.env.KRISP_VIVA_IP_MODEL_PATH;
    try {
      expect(() => new KrispVivaIPUserTurnStartStrategy({ apiKey: "test-key" })).toThrow(Error);
    } finally {
      if (saved !== undefined) process.env.KRISP_VIVA_IP_MODEL_PATH = saved;
    }
  });

  test("test_init_raises_if_wrong_extension", () => {
    expect(
      () =>
        new KrispVivaIPUserTurnStartStrategy({
          modelPath: "/some/model.bin",
          apiKey: "test-key",
        } satisfies KrispVivaIPUserTurnStartStrategyOptions),
    ).toThrow(Error);
  });

  // DIVERGENCE: upstream raises FileNotFoundError when the model file does not
  // exist. @pipecat-ts/core has no filesystem access, so the constructor does
  // not check file existence; the Krisp runtime that loads the model does.
  test.skip("test_init_raises_if_file_not_found", () => {
    expect(
      () =>
        new KrispVivaIPUserTurnStartStrategy({
          modelPath: "/nonexistent/model.kef",
          apiKey: "test-key",
        }),
    ).toThrow(Error);
  });

  test("test_init_raises_if_sdk_fails", () => {
    mockSdkManager.acquire.mockImplementation(() => {
      throw new Error("SDK error");
    });
    expect(() => new KrispVivaIPUserTurnStartStrategy({ modelPath, apiKey: "test-key" })).toThrow(
      Error,
    );
  });

  test("test_init_uses_env_var_for_model_path", () => {
    const saved = process.env.KRISP_VIVA_IP_MODEL_PATH;
    process.env.KRISP_VIVA_IP_MODEL_PATH = modelPath;
    try {
      const strategy = new KrispVivaIPUserTurnStartStrategy({ apiKey: "test-key" });
      expect(internals(strategy)._modelPath).toEqual(modelPath);
    } finally {
      if (saved !== undefined) process.env.KRISP_VIVA_IP_MODEL_PATH = saved;
      else delete process.env.KRISP_VIVA_IP_MODEL_PATH;
    }
  });

  test("test_vad_stopped_when_speech_inactive_is_no_op", async () => {
    const strategy = _makeStrategy();
    try {
      const result = await strategy.processFrame(new VADUserStoppedSpeakingFrame());
      expect(result).toEqual(ProcessFrameResult.CONTINUE);
      expect(internals(strategy)._speechActive).toBe(false);
    } finally {
      await strategy.cleanup();
    }
  });

  test("test_interruption_at_exact_threshold_triggers", async () => {
    const threshold = 0.5;
    mockIpSession.process = mock(() => threshold);

    const strategy = _makeStrategy({ threshold });
    try {
      let fired = false;

      strategy.eventHandler("on_user_turn_started", async (_strategy, _params) => {
        fired = true;
      });

      await strategy.processFrame(new VADUserStartedSpeakingFrame());
      const result = await strategy.processFrame(_audioFrame());

      expect(fired).toBe(true);
      expect(result).toEqual(ProcessFrameResult.STOP);
    } finally {
      await strategy.cleanup();
    }
  });
});
