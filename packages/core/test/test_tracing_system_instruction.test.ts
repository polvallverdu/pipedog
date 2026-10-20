// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_tracing_system_instruction.py

/**
 * Tests for system-instruction resolution in tracing.
 *
 * System instructions can live on the LLM service (`settings.systemInstruction`,
 * the norm) or arrive as an initial system message in the context. The
 * `_getSystemInstruction` helper resolves the effective value with the
 * service setting taking priority, matching service behavior.
 */

import { expect, test } from "bun:test";
import { LLMContext } from "../src/processors/aggregators/llm_context.ts";
import { addGeminiLiveSpanAttributes } from "../src/utils/tracing/service_attributes.ts";
import { _getSystemInstruction } from "../src/utils/tracing/service_decorators.ts";

const SYSTEM_CONTEXT = new LLMContext({ messages: [{ role: "system", content: "from context" }] });

function _service(systemInstruction: string | null = null) {
  return { settings: { systemInstruction } };
}

test("test_settings_system_instruction_takes_priority", () => {
  const service = _service("from settings");
  expect(_getSystemInstruction(service, SYSTEM_CONTEXT)).toBe("from settings");
});

test("test_falls_back_to_context_system_message", () => {
  expect(_getSystemInstruction(_service(), SYSTEM_CONTEXT)).toBe("from context");
});

test("test_falls_back_when_service_has_no_settings", () => {
  expect(_getSystemInstruction({}, SYSTEM_CONTEXT)).toBe("from context");
});

test("test_context_multipart_system_message", () => {
  const context = new LLMContext({
    messages: [
      {
        role: "system",
        content: [
          { type: "text", text: "part one." },
          { type: "text", text: "part two." },
        ],
      },
    ],
  });
  expect(_getSystemInstruction(_service(), context)).toBe("part one. part two.");
});

test("test_none_when_no_instruction_anywhere", () => {
  expect(_getSystemInstruction(_service(), new LLMContext())).toBeNull();
  expect(_getSystemInstruction(_service(), null)).toBeNull();
  expect(
    _getSystemInstruction(
      _service(),
      new LLMContext({ messages: [{ role: "user", content: "x" }] }),
    ),
  ).toBeNull();
});

test("test_gemini_span_attributes_accept_dotted_kwarg", () => {
  // The Gemini Live decorator passes `gen_ai.system_instructions` through
  // `addGeminiLiveSpanAttributes(span, operationAttrs)` — dotted keys must
  // survive the options round trip and land on the span.
  class _FakeSpan {
    attributes: Record<string, unknown> = {};

    setAttribute(key: string, value: unknown) {
      this.attributes[key] = value;
      return this;
    }
  }

  const span = new _FakeSpan();
  addGeminiLiveSpanAttributes(span as any, {
    serviceName: "GeminiLiveLLMService",
    model: "gemini-live",
    operationName: "llm_setup",
    "gen_ai.system_instructions": "be helpful",
  });
  expect(span.attributes["gen_ai.system_instructions"]).toBe("be helpful");
});
