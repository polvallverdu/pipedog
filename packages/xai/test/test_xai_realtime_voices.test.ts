// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_xai_realtime_voices.py

/** Tests for the xAI (Grok) Realtime voice setting. */

import { expect, test } from "bun:test";

import * as events from "../src/realtime/events.ts";

test("test_default_voice_matches_xai_default", () => {
  // xAI's server-side default is "eve"; the session mirrors it.
  expect(new events.SessionProperties().voice).toBe("eve");
});

test("test_default_voice_reaches_the_wire", () => {
  // The default voice is serialized into the session update sent to xAI.
  const session = new events.SessionUpdateEvent({
    session: new events.SessionProperties(),
  }).modelDump({ excludeNone: true }).session;

  expect(session.voice).toBe("eve");
});

test("test_voice_is_a_plain_string", () => {
  // Built-in IDs and Custom Voices API IDs are both just strings.
  expect(new events.SessionProperties({ voice: "my-custom-voice-1" }).voice).toBe(
    "my-custom-voice-1",
  );
});
