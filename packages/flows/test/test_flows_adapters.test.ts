// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_flows_adapters.py

/**
 * Tests for the LLM adapter.
 *
 * This module tests the LLMAdapter class used by the flow manager for
 * conversation-summary generation and formatting.
 */

import { expect, test } from "bun:test";
import { LLMAdapter } from "@pipedog/flows/adapters";

test("test_format_summary_message", () => {
  const adapter = new LLMAdapter();
  const message = adapter.formatSummaryMessage("Test summary");
  expect(message).toEqual({
    role: "developer",
    content: "Here's a summary of the conversation:\nTest summary",
  });
});
