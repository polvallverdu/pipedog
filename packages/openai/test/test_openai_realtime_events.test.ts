// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_openai_realtime_events.py

import { expect, test } from "bun:test";

import { pyJsonDumps } from "@pipedog/core/utils/py_json";

import * as events from "../src/realtime/events.ts";

test("test_parse_server_event_returns_none_for_unmodeled_type", () => {
  const raw = pyJsonDumps({ event_id: "ev_1", type: "output_audio_buffer.cleared" });

  expect(events.parseServerEvent(raw)).toBeNull();
});

test("test_parse_response_done_with_only_status", () => {
  const raw = pyJsonDumps({
    event_id: "ev_1",
    type: "response.done",
    response: { status: "completed" },
  });

  const evt = events.parseServerEvent(raw);

  expect(evt).toBeInstanceOf(events.ResponseDone);
  const done = evt as events.ResponseDone;
  expect(done.response.usage).toBeNull();
  expect(done.response.statusDetails).toBeNull();
});
