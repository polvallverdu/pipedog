// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/audio/krisp_instance.py

/**
 * Krisp Instance manager for pipecat audio.
 *
 * PORTING NOTE: the Krisp VIVA SDK (`krisp_audio`) has no edge-compatible
 * JavaScript binding. The module's logic is ported against the
 * `KrispAudioSdk` interface below, but the default SDK is a stub whose calls
 * throw "not ported yet". A runtime-specific package can provide the real
 * binding with `setKrispAudioSdk()`.
 */

import { logger } from "../utils/logger.ts";

/** Version triple reported by the Krisp SDK. */
export interface KrispSdkVersion {
  major: number;
  minor: number;
  patch: number;
}

/** The subset of the `krisp_audio` SDK surface this module uses. */
export interface KrispAudioSdk {
  SamplingRate: Record<string, unknown>;
  FrameDuration: Record<string, unknown>;
  LogLevel: { Off: unknown } & Record<string, unknown>;
  getVersion(): KrispSdkVersion;
  globalInit(...args: unknown[]): void;
}

function notPorted(): never {
  throw new Error("krisp_audio is not ported yet");
}

// Placeholder SDK: the enum members are their own names, every call throws.
const STUB_KRISP_AUDIO: KrispAudioSdk = {
  SamplingRate: {
    Sr8000Hz: "Sr8000Hz",
    Sr16000Hz: "Sr16000Hz",
    Sr24000Hz: "Sr24000Hz",
    Sr32000Hz: "Sr32000Hz",
    Sr44100Hz: "Sr44100Hz",
    Sr48000Hz: "Sr48000Hz",
  },
  FrameDuration: {
    Fd10ms: "Fd10ms",
    Fd15ms: "Fd15ms",
    Fd20ms: "Fd20ms",
    Fd30ms: "Fd30ms",
    Fd32ms: "Fd32ms",
  },
  LogLevel: { Off: "Off" },
  getVersion: notPorted,
  globalInit: notPorted,
};

let krispAudio: KrispAudioSdk = STUB_KRISP_AUDIO;

// Krisp SDK SamplingRate enum member for each sample rate (Hz)
const SAMPLE_RATE_MEMBERS: ReadonlyArray<[number, string]> = [
  [8000, "Sr8000Hz"],
  [16000, "Sr16000Hz"],
  [24000, "Sr24000Hz"],
  [32000, "Sr32000Hz"],
  [44100, "Sr44100Hz"],
  [48000, "Sr48000Hz"],
];

// Krisp SDK FrameDuration enum member for each frame duration (ms)
const FRAME_DURATION_MEMBERS: ReadonlyArray<[number, string]> = [
  [10, "Fd10ms"],
  [15, "Fd15ms"],
  [20, "Fd20ms"],
  [30, "Fd30ms"],
  [32, "Fd32ms"],
];

const sampleRates = new Map<number, unknown>();
const frameDurations = new Map<number, unknown>();

// Upstream builds these maps from the krisp_audio enums at import time; here
// they are rebuilt whenever an SDK binding is installed.
function buildKrispMaps(): void {
  sampleRates.clear();
  for (const [rate, member] of SAMPLE_RATE_MEMBERS) {
    sampleRates.set(rate, krispAudio.SamplingRate[member]);
  }
  frameDurations.clear();
  for (const [duration, member] of FRAME_DURATION_MEMBERS) {
    frameDurations.set(duration, krispAudio.FrameDuration[member]);
  }
}
buildKrispMaps();

/**
 * Install the Krisp SDK binding used by this module.
 *
 * STUB SUPPORT: there is no bundled binding; until one is installed every
 * SDK call throws.
 */
export function setKrispAudioSdk(sdk: KrispAudioSdk): void {
  krispAudio = sdk;
  buildKrispMaps();
}

// Mapping of sample rates (Hz) to Krisp SDK SamplingRate enums
export const KRISP_SAMPLE_RATES: ReadonlyMap<number, unknown> = sampleRates;

// Mapping of frame durations (ms) to Krisp SDK FrameDuration enums
export const KRISP_FRAME_DURATIONS: ReadonlyMap<number, unknown> = frameDurations;

/**
 * Convert integer sample rate to Krisp SDK enum value.
 *
 * @param sampleRate Sample rate in Hz (e.g., 16000, 24000, 48000).
 * @returns Corresponding Krisp SDK SampleRate enum value.
 * @throws Error if the sample rate is not supported by Krisp SDK.
 */
export function intToKrispSampleRate(sampleRate: number): unknown {
  if (!KRISP_SAMPLE_RATES.has(sampleRate)) {
    const supportedRates = [...KRISP_SAMPLE_RATES.keys()].sort((a, b) => a - b).join(", ");
    throw new Error(
      `Unsupported sample rate: ${sampleRate} Hz. Supported rates: ${supportedRates} Hz`,
    );
  }
  return KRISP_SAMPLE_RATES.get(sampleRate);
}

/**
 * Convert integer frame duration to Krisp SDK enum value.
 *
 * @param frameDurationMs Frame duration in milliseconds (e.g., 10, 20, 30).
 * @returns Corresponding Krisp SDK FrameDuration enum value.
 * @throws Error if the frame duration is not supported by Krisp SDK.
 */
export function intToKrispFrameDuration(frameDurationMs: number): unknown {
  if (!KRISP_FRAME_DURATIONS.has(frameDurationMs)) {
    const supportedDurations = [...KRISP_FRAME_DURATIONS.keys()].sort((a, b) => a - b).join(", ");
    throw new Error(
      `Unsupported frame duration: ${frameDurationMs} ms. ` +
        `Supported durations: ${supportedDurations} ms`,
    );
  }
  return KRISP_FRAME_DURATIONS.get(frameDurationMs);
}

// Krisp SDK switched its Python bindings from pybind11 to nanobind starting in
// 1.11.0. Among other things, this changed the noise suppression level
// argument from int to float and requires writable (not just readable) ndarray
// input.
const NANOBIND_SDK_VERSION: [number, number, number] = [1, 11, 0];

/** Whether the installed krisp_audio build uses nanobind bindings (>= 1.11.0). */
export function krispSdkUsesNanobindBindings(): boolean {
  const version = krispAudio.getVersion();
  const v = [version.major, version.minor, version.patch];
  for (let i = 0; i < 3; i++) {
    if ((v[i] as number) !== NANOBIND_SDK_VERSION[i]) {
      return (v[i] as number) > NANOBIND_SDK_VERSION[i];
    }
  }
  return true;
}

function getEnv(name: string): string | undefined {
  return (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.[
    name
  ];
}

/**
 * Singleton manager for Krisp VIVA SDK with reference counting.
 *
 * The SDK's global state is shared by every Krisp session in the process, so
 * it is initialized once, on first use, and left up for the life of the
 * process: destroying it while any session is still alive leaves that session
 * reading freed memory, and there is no point in the process where every
 * session is known to be gone. The reference count tracks how many components
 * hold the SDK; it does not decide when to tear it down.
 *
 * (Upstream guards the state with a threading lock; JavaScript runs these
 * synchronous methods atomically, so no lock is needed.)
 */
export class KrispVivaSDKManager {
  protected static _initialized = false;
  protected static _referenceCount = 0;

  /** Callback for Krisp SDK licensing errors. */
  protected static _licenseCallback(error: unknown, errorMessage: unknown): void {
    logger.error(`Krisp licensing error: ${error} - ${errorMessage}`);
  }

  /** Callback for Krisp SDK logging. */
  protected static _logCallback(logMessage: unknown, logLevel: unknown): void {
    logger.info(`[${logLevel}] ${logMessage}`);
  }

  /**
   * Acquire a reference to the SDK (initializes if needed).
   *
   * Call this before creating Krisp sessions.
   *
   * @param apiKey Krisp SDK API key. If empty, falls back to the
   *   KRISP_VIVA_API_KEY environment variable. Only the key of the caller that
   *   initializes the SDK is used.
   * @throws If SDK initialization fails (propagated from krisp_audio).
   */
  static acquire(apiKey = ""): void {
    // Initialize the SDK once per process.
    if (!KrispVivaSDKManager._initialized) {
      try {
        const key = apiKey || getEnv("KRISP_VIVA_API_KEY") || "";
        try {
          // New SDK signature (requires license key)
          krispAudio.globalInit(
            "",
            key,
            KrispVivaSDKManager._licenseCallback,
            KrispVivaSDKManager._logCallback,
            krispAudio.LogLevel.Off,
          );
        } catch (e) {
          if (!(e instanceof TypeError)) throw e;
          // Old SDK signature (no license key)
          krispAudio.globalInit("", KrispVivaSDKManager._logCallback, krispAudio.LogLevel.Off);
        }
      } catch (e) {
        logger.error(`Krisp SDK initialization failed: ${e}`);
        throw e;
      }

      // Set before anything else that could fail: a flag that claims the SDK
      // is down while it is up would let a second globalInit() re-seat global
      // state that live sessions still point at.
      KrispVivaSDKManager._initialized = true;

      const SDK_VERSION = krispAudio.getVersion();
      logger.debug(
        `Krisp Audio Python SDK initialized - Version: ` +
          `${SDK_VERSION.major}.${SDK_VERSION.minor}.${SDK_VERSION.patch}`,
      );
    }

    KrispVivaSDKManager._referenceCount += 1;
    logger.debug(`Krisp SDK reference count: ${KrispVivaSDKManager._referenceCount}`);
  }

  /**
   * Release a reference to the SDK.
   *
   * Call this once the caller's Krisp sessions are gone. Releasing the last
   * reference does not tear the SDK down; see the class docs.
   */
  static release(): void {
    if (KrispVivaSDKManager._referenceCount > 0) {
      KrispVivaSDKManager._referenceCount -= 1;
      logger.debug(`Krisp SDK reference count: ${KrispVivaSDKManager._referenceCount}`);
    }
  }

  /**
   * Get the current reference count.
   *
   * @returns Current number of active references to the SDK.
   */
  static getReferenceCount(): number {
    return KrispVivaSDKManager._referenceCount;
  }

  /**
   * Check if the SDK is currently initialized.
   *
   * @returns True if SDK is initialized, false otherwise.
   */
  static isInitialized(): boolean {
    return KrispVivaSDKManager._initialized;
  }
}
