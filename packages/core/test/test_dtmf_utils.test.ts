// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_dtmf_utils.py

import { beforeEach, describe, expect, test } from "bun:test";

import { KeypadEntry } from "../src/audio/dtmf/types.ts";
import type * as DtmfUtils from "../src/audio/dtmf/utils.ts";

let loadCount = 0;

describe("TestLoadDTMFAudio", () => {
  let loadDtmfAudio: typeof DtmfUtils.loadDtmfAudio;

  beforeEach(async () => {
    // The module caches decoded/resampled audio in process-global state.
    // Upstream clears `__DTMF_AUDIO__` / `__DTMF_RESAMPLER__` directly; those are
    // module-private here, so load a fresh module instance so each test starts
    // from a clean cache.
    loadCount++;
    const utils = (await import(
      `../src/audio/dtmf/utils.ts?fresh=${loadCount}`
    )) as typeof DtmfUtils;
    loadDtmfAudio = utils.loadDtmfAudio;
  });

  test("test_cache_is_keyed_by_sample_rate", async () => {
    // Different sample rates for the same button must not collide in the cache.
    const audio8k = await loadDtmfAudio(KeypadEntry.ONE, { sampleRate: 8000 });
    const audio16k = await loadDtmfAudio(KeypadEntry.ONE, { sampleRate: 16000 });

    // 16 kHz PCM of the same tone has roughly twice the bytes of 8 kHz. With a
    // button-only cache key the 8 kHz audio was returned for the 16 kHz request,
    // so the lengths matched and this assertion failed.
    expect(audio16k.length).toBeGreaterThan(audio8k.length * 1.8);
  });

  test("test_cached_rate_returns_identical_bytes", async () => {
    // Re-requesting a previously loaded sample rate returns the same bytes.
    const first = await loadDtmfAudio(KeypadEntry.ONE, { sampleRate: 8000 });
    // Load a different rate in between; it must not clobber the 8 kHz entry.
    await loadDtmfAudio(KeypadEntry.ONE, { sampleRate: 16000 });
    const again = await loadDtmfAudio(KeypadEntry.ONE, { sampleRate: 8000 });
    expect(first).toEqual(again);
  });
});
