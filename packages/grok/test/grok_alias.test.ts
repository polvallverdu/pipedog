// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// @pipedog/grok/llm is the deprecated alias of @pipedog/xai/llm.

import { expect, test } from "bun:test";
import * as xai from "@pipedog/xai/llm";
import * as grok from "../src/llm.ts";

test("re-exports xAI's Grok LLM service", () => {
  expect(grok.GrokLLMService).toBe(xai.GrokLLMService);
  expect(grok.GrokLLMSettings).toBe(xai.GrokLLMSettings);
});
