// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_azure_tts.py

/**
 * Tests for AzureTTSService audio delivery and SSML construction.
 *
 * Upstream's Speech SDK fires its synthesis callbacks from native threads, and
 * these tests check that a callback wakes a getter parked on an otherwise idle
 * loop. pipedog has no threads: the callbacks run on the service's receive
 * task. The tests keep the intent: the getter is parked first, then the
 * callback fires from another task after a delay, and the getter must wake
 * promptly rather than waiting for the `waitFor` timer.
 */

import { describe, expect, test } from "bun:test";

import { createTask, monotonic, sleep, waitFor } from "@pipedog/asyncio";

import { AzureHttpTTSService, AzureTTSService, CancellationReason } from "../src/tts.ts";

const SSML_SERVICE_CLASSES = [AzureTTSService, AzureHttpTTSService] as const;

// The callback fires after this delay, by which point the awaiting getter has
// parked.
const _FIRE_DELAY = 0.1;
// Generous wait so a lost wakeup blocks on the timer; tight bound so a prompt
// delivery passes.
const _WAIT = 5.0;
const _MAX_DELIVERY = 1.0;

function _makeService(): AzureTTSService {
  return new AzureTTSService({ apiKey: "test-key", region: "eastus" });
}

/**
 * Park `getCoro` on an idle loop, then `fire()` the callback from another task.
 *
 * @returns The value the getter received; asserts it arrived promptly.
 */
async function _assertIdleLoopWakeup<T>(getCoro: () => Promise<T>, fire: () => void): Promise<T> {
  const task = createTask(getCoro);
  const t0 = monotonic();
  createTask(async () => {
    await sleep(_FIRE_DELAY);
    fire();
  });
  const result = await waitFor(() => task, _WAIT);
  expect(monotonic() - t0).toBeLessThan(_MAX_DELIVERY);
  return result;
}

test("test_synthesizing_audio_wakes_idle_loop", async () => {
  // Audio pushed from a callback reaches a parked getter on an idle loop.
  const svc = _makeService();

  const audio = new Uint8Array(512);
  for (let i = 0; i < 256; i++) audio[i * 2 + 1] = 1;
  const evt = { result: { audioData: audio } };

  const data = await _assertIdleLoopWakeup(
    () => svc._audioQueue.get(),
    () => svc._handleSynthesizing(evt),
  );
  expect(data).toEqual(audio);
});

test("test_canceled_error_wakes_idle_loop", async () => {
  // A non-user cancellation delivers its error to a parked getter on an idle loop.
  const svc = _makeService();

  const evt = {
    result: {
      cancellationDetails: { reason: CancellationReason.Error, errorDetails: "boom" },
    },
  };

  const item = await _assertIdleLoopWakeup(
    () => svc._audioQueue.get(),
    () => svc._handleCanceled(evt),
  );
  expect(item).toBeInstanceOf(Error);
  expect(String((item as Error).message)).toContain("boom");
});

test("test_completion_sentinel_wakes_idle_loop", async () => {
  // The completion sentinel reaches the word-boundary getter on an idle loop.
  //
  // `_handleCompleted` routes completion through the word-boundary queue,
  // whose getter is the word-processor task; that handoff must wake an idle
  // loop.
  const svc = _makeService();

  const evt = { result: { audioDuration: null } }; // skip duration bookkeeping

  const item = await _assertIdleLoopWakeup(
    () => svc._wordBoundaryQueue.get(),
    () => svc._handleCompleted(evt),
  );
  expect(item).toBeNull();
});

describe.each(SSML_SERVICE_CLASSES.map((cls) => [cls.name, cls] as const))(
  "%s",
  (_name, serviceClass) => {
    test("test_construct_ssml_default_has_no_lang_element", () => {
      // Default settings emit no <lang> element anywhere in the output.
      const service = new serviceClass({ apiKey: "test-key", region: "eastus" });

      const ssml = service._constructSsml("Hello there.");

      expect(ssml).not.toContain("<lang");
      expect(ssml).toEqual(
        "<speak version='1.0' xml:lang='en-US' " +
          "xmlns='http://www.w3.org/2001/10/synthesis' " +
          "xmlns:mstts='http://www.w3.org/2001/mstts'>" +
          "<voice name='en-US-SaraNeural'>" +
          "<mstts:silence type='Sentenceboundary' value='20ms' />" +
          "Hello there." +
          "</voice></speak>",
      );
    });

    test("test_construct_ssml_force_locale_false_matches_default", () => {
      // forceLocale=false explicitly must match the unset default byte-for-byte.
      const defaultService = new serviceClass({ apiKey: "test-key", region: "eastus" });
      const explicitFalseService = new serviceClass({
        apiKey: "test-key",
        region: "eastus",
        settings: new serviceClass.Settings({ forceLocale: false }),
      });

      expect(defaultService._constructSsml("Hello there.")).toEqual(
        explicitFalseService._constructSsml("Hello there."),
      );
    });

    test("test_construct_ssml_force_locale_wraps_text_in_lang_element", () => {
      // forceLocale=true wraps the text in <lang xml:lang> inside <voice>.
      const service = new serviceClass({
        apiKey: "test-key",
        region: "eastus",
        settings: new serviceClass.Settings({ language: "en-GB", forceLocale: true }),
      });

      const ssml = service._constructSsml("Hello there.");

      expect(ssml).toEqual(
        "<speak version='1.0' xml:lang='en-GB' " +
          "xmlns='http://www.w3.org/2001/10/synthesis' " +
          "xmlns:mstts='http://www.w3.org/2001/mstts'>" +
          "<voice name='en-US-SaraNeural'>" +
          "<mstts:silence type='Sentenceboundary' value='20ms' />" +
          "<lang xml:lang='en-GB'>" +
          "Hello there." +
          "</lang>" +
          "</voice></speak>",
      );
    });

    test("test_construct_ssml_force_locale_wraps_nested_style_and_prosody", () => {
      // forceLocale=true wraps the entire nested style/prosody/emphasis block,
      // not just the raw text.
      const service = new serviceClass({
        apiKey: "test-key",
        region: "eastus",
        settings: new serviceClass.Settings({
          language: "en-GB",
          forceLocale: true,
          style: "cheerful",
          rate: "slow",
          emphasis: "strong",
        }),
      });

      const ssml = service._constructSsml("Hello there.");

      expect(ssml).toEqual(
        "<speak version='1.0' xml:lang='en-GB' " +
          "xmlns='http://www.w3.org/2001/10/synthesis' " +
          "xmlns:mstts='http://www.w3.org/2001/mstts'>" +
          "<voice name='en-US-SaraNeural'>" +
          "<mstts:silence type='Sentenceboundary' value='20ms' />" +
          "<lang xml:lang='en-GB'>" +
          "<mstts:express-as style='cheerful'>" +
          "<prosody rate='slow'>" +
          "<emphasis level='strong'>" +
          "Hello there." +
          "</emphasis>" +
          "</prosody>" +
          "</mstts:express-as>" +
          "</lang>" +
          "</voice></speak>",
      );
    });
  },
);
