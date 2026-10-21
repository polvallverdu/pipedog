// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// @pipedog/grok/realtime/* are the deprecated aliases of @pipedog/xai/realtime/*,
// and @pipedog/grok/grok_realtime_adapter re-exports xAI's adapter.

import { expect, test } from "bun:test";
import * as xaiAdapter from "@pipedog/xai/grok_realtime_adapter";
import * as xaiEvents from "@pipedog/xai/realtime/events";
import * as xaiLlm from "@pipedog/xai/realtime/llm";
import * as adapter from "../src/grok_realtime_adapter.ts";
import * as events from "../src/realtime/events.ts";
import * as llm from "../src/realtime/llm.ts";

test("re-exports xAI's Grok Realtime service, events and adapter", () => {
  expect(llm.GrokRealtimeLLMService).toBe(xaiLlm.GrokRealtimeLLMService);
  expect(llm.GrokRealtimeLLMSettings).toBe(xaiLlm.GrokRealtimeLLMSettings);
  expect(events.SessionProperties).toBe(xaiEvents.SessionProperties);
  expect(events.parseServerEvent).toBe(xaiEvents.parseServerEvent);
  expect(adapter.GrokRealtimeLLMAdapter).toBe(xaiAdapter.GrokRealtimeLLMAdapter);
});
