// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipecat-ts contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_krisp_sdk_manager.py

/** Unit tests for Krisp SDK Manager (singleton with reference counting). */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import {
  intToKrispSampleRate,
  KRISP_SAMPLE_RATES,
  type KrispAudioSdk,
  KrispVivaSDKManager,
  setKrispAudioSdk,
} from "../src/audio/krisp_instance.ts";

// Mock krisp_audio SDK. Upstream installs a MagicMock in sys.modules before
// importing; here the binding is installed with setKrispAudioSdk().
const mockVersion = { major: 1, minor: 0, patch: 0 };

const mockKrispAudio = {
  SamplingRate: {
    Sr8000Hz: 8000,
    Sr16000Hz: 16000,
    Sr24000Hz: 24000,
    Sr32000Hz: 32000,
    Sr44100Hz: 44100,
    Sr48000Hz: 48000,
  },
  FrameDuration: {
    Fd10ms: "10ms",
    Fd15ms: "15ms",
    Fd20ms: "20ms",
    Fd30ms: "30ms",
    Fd32ms: "32ms",
  },
  LogLevel: { Off: 0 },
  getVersion: mock(() => mockVersion),
  globalInit: mock((..._args: unknown[]): void => {}),
  globalDestroy: mock((): void => {}),
};

setKrispAudioSdk(mockKrispAudio as KrispAudioSdk);

// Internal state, accessed to keep tests isolated (as upstream does).
const managerState = KrispVivaSDKManager as unknown as {
  _referenceCount: number;
  _initialized: boolean;
};

describe("TestKrispVivaSDKManager", () => {
  beforeEach(() => {
    // Reset mocks and SDK state before each test.
    mockKrispAudio.globalInit.mockReset();
    mockKrispAudio.globalInit.mockImplementation((..._args: unknown[]): void => {});
    mockKrispAudio.globalDestroy.mockReset();
    mockKrispAudio.getVersion.mockReset();
    mockKrispAudio.getVersion.mockImplementation(() => mockVersion);

    // Ensure krisp_instance module uses THIS test's mock.
    setKrispAudioSdk(mockKrispAudio as KrispAudioSdk);

    // Reset the SDK manager state for clean tests
    while (managerState._referenceCount > 0) {
      managerState._referenceCount -= 1;
    }
    managerState._initialized = false;
  });

  test("test_reference_counting", () => {
    // Initial state
    const initialCount = KrispVivaSDKManager.getReferenceCount();
    expect(initialCount).toBe(0);

    // Acquire first reference
    KrispVivaSDKManager.acquire();
    expect(KrispVivaSDKManager.getReferenceCount()).toBe(initialCount + 1);
    expect(KrispVivaSDKManager.isInitialized()).toBe(true);

    // Verify globalInit was called
    expect(mockKrispAudio.globalInit).toHaveBeenCalledTimes(1);

    // Acquire second reference
    KrispVivaSDKManager.acquire();
    expect(KrispVivaSDKManager.getReferenceCount()).toBe(initialCount + 2);
    expect(KrispVivaSDKManager.isInitialized()).toBe(true);

    // globalInit should NOT be called again
    expect(mockKrispAudio.globalInit.mock.calls.length).toBe(1);

    // Release first reference
    KrispVivaSDKManager.release();
    expect(KrispVivaSDKManager.getReferenceCount()).toBe(initialCount + 1);
    expect(KrispVivaSDKManager.isInitialized()).toBe(true);

    // Release second reference
    KrispVivaSDKManager.release();
    expect(KrispVivaSDKManager.getReferenceCount()).toBe(initialCount);

    // The SDK stays initialized until the process exits
    expect(KrispVivaSDKManager.isInitialized()).toBe(true);
    expect(mockKrispAudio.globalDestroy).not.toHaveBeenCalled();
  });

  test("test_multiple_acquire_release_cycles", () => {
    const initialCount = KrispVivaSDKManager.getReferenceCount();

    for (let i = 0; i < 3; i++) {
      KrispVivaSDKManager.acquire();
      expect(KrispVivaSDKManager.getReferenceCount()).toBeGreaterThan(initialCount);
      expect(KrispVivaSDKManager.isInitialized()).toBe(true);
      KrispVivaSDKManager.release();
      expect(KrispVivaSDKManager.getReferenceCount()).toBe(initialCount);
    }

    expect(mockKrispAudio.globalInit.mock.calls.length).toBe(1);
    expect(mockKrispAudio.globalDestroy).not.toHaveBeenCalled();
  });

  test("test_sdk_initialization_failure", () => {
    mockKrispAudio.globalInit.mockImplementation(() => {
      throw new Error("SDK init failed");
    });

    expect(() => KrispVivaSDKManager.acquire()).toThrow(/SDK init failed/);

    // Verify SDK is not initialized after failure
    expect(KrispVivaSDKManager.isInitialized()).toBe(false);
    expect(KrispVivaSDKManager.getReferenceCount()).toBe(0);

    // Reset the side effect for other tests
    mockKrispAudio.globalInit.mockImplementation((..._args: unknown[]): void => {});
  });

  test("test_release_without_acquire", () => {
    const initialCount = KrispVivaSDKManager.getReferenceCount();

    // Release without acquire should be safe (no-op)
    KrispVivaSDKManager.release();

    expect(KrispVivaSDKManager.getReferenceCount()).toBe(initialCount);
    expect(mockKrispAudio.globalDestroy).not.toHaveBeenCalled();
  });

  test("test_is_initialized_state", () => {
    // Initially not initialized
    expect(KrispVivaSDKManager.isInitialized()).toBe(false);

    // After acquire, should be initialized
    KrispVivaSDKManager.acquire();
    expect(KrispVivaSDKManager.isInitialized()).toBe(true);

    // Releasing the last reference does not tear the SDK down
    KrispVivaSDKManager.release();
    expect(KrispVivaSDKManager.isInitialized()).toBe(true);
  });
});

describe("TestSampleRateConversion", () => {
  test("test_supported_sample_rates", () => {
    // Test conversion of all supported sample rates.
    for (const [rateHz, krispEnum] of KRISP_SAMPLE_RATES) {
      const result = intToKrispSampleRate(rateHz);
      expect(result).toEqual(krispEnum);
    }
  });

  test("test_unsupported_sample_rate", () => {
    // Test that unsupported rates raise ValueError.
    expect(() => intToKrispSampleRate(22050)).toThrow(/Unsupported sample rate/); // Not supported

    expect(() => intToKrispSampleRate(96000)).toThrow(/Unsupported sample rate/); // Not supported
  });

  test("test_sample_rate_error_message", () => {
    // Test that error message includes helpful information.
    try {
      intToKrispSampleRate(11025);
    } catch (e) {
      const msg = String(e);
      expect(msg).toContain("11025");
      expect(msg).toContain("Supported rates");
      // Should list at least some supported rates
      expect(msg).toContain("16000");
    }
  });

  test("test_all_krisp_sample_rates_defined", () => {
    // Test that all expected sample rates are in KRISP_SAMPLE_RATES.
    const expectedRates = [8000, 16000, 24000, 32000, 44100, 48000];
    for (const rate of expectedRates) {
      expect(KRISP_SAMPLE_RATES.has(rate)).toBe(true);
    }
  });
});
