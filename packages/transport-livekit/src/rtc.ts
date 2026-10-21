// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Lazy access to LiveKit's realtime SDK, `@livekit/rtc-node` (an optional peer
 * dependency, the counterpart of Python's `livekit.rtc`).
 *
 * `@livekit/rtc-node` loads a native N-API addon (`@livekit/rtc-ffi-bindings`)
 * as soon as it is imported, and that addon ships prebuilt binaries for a
 * handful of platforms only (macOS arm64/x64, Linux x64/arm64 with glibc,
 * Windows x64). So it is never imported at module load: `loadRtc()` imports it
 * the first time a LiveKit room is set up, and importing this package stays
 * possible everywhere.
 *
 * Code reads the SDK through the mutable `rtc` object, which `loadRtc()` fills
 * in. Tests replace its members with `spyOn(rtc, "AudioSource")`, as upstream's
 * tests `patch.object(rtc, "AudioSource")`.
 */

import type * as RtcNode from "@livekit/rtc-node";
import { rethrowIfCancelled } from "@pipedog/asyncio";

/** The `@livekit/rtc-node` module. */
export type Rtc = typeof RtcNode;

// Held in a variable so bundlers leave the import alone: the native addon must
// be loaded from node_modules at runtime.
const RTC_NODE = "@livekit/rtc-node";

/**
 * The loaded `@livekit/rtc-node` module. Empty until `loadRtc()` resolves.
 *
 * A plain object (not the module namespace), so its members can be replaced.
 */
export const rtc = {} as Rtc;

let loading: Promise<Rtc> | null = null;

/** Whether `loadRtc()` has loaded the SDK (or `setRtc()` provided one). */
export function rtcLoaded(): boolean {
  return "Room" in rtc;
}

/**
 * Import `@livekit/rtc-node` once and fill in `rtc`.
 *
 * @returns The `rtc` object.
 * @throws Error With install instructions when the package is missing or its
 *   native addon has no build for this platform.
 */
export async function loadRtc(): Promise<Rtc> {
  if (rtcLoaded()) return rtc;
  loading ??= (async () => {
    let mod: Rtc;
    try {
      mod = (await import(RTC_NODE)) as Rtc;
    } catch (e) {
      loading = null;
      rethrowIfCancelled(e);
      const reason = e instanceof Error ? e.message : String(e);
      throw new Error(
        `In order to use LiveKit, you need @livekit/rtc-node (${reason}). ` +
          "Add it with `bun add @livekit/rtc-node` / `npm i @livekit/rtc-node`. It is a native " +
          "addon with prebuilt binaries for macOS (arm64, x64), Linux with glibc (x64, arm64) and " +
          "Windows (x64); it does not run on Cloudflare Workers or in browsers.",
      );
    }
    if (!rtcLoaded()) Object.assign(rtc, mod);
    return rtc;
  })();
  return await loading;
}

/**
 * Use `mod` as the LiveKit SDK instead of importing `@livekit/rtc-node`.
 *
 * For tests and for applications that load the SDK themselves (e.g. from a
 * bundle). Members already set are replaced.
 */
export function setRtc(mod: Partial<Rtc>): void {
  Object.assign(rtc, mod);
}
