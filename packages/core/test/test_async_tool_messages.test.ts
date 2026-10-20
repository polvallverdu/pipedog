// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipecat-ts contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_async_tool_messages.py

import { describe, expect, test } from "bun:test";
import * as asyncToolMessages from "../src/processors/aggregators/async_tool_messages.ts";

// The parser tests intentionally exercise the parser via the canonical
// builders, so a drift between the two sides will surface as a parse failure
// in CI rather than as a silent contract break in production.

type AnyMessage = Parameters<typeof asyncToolMessages.parseMessage>[0];

/** Parse an arbitrary (possibly malformed) message dict, as the Python tests do. */
function parse(message: Record<string, unknown>) {
  return asyncToolMessages.parseMessage(message as unknown as AnyMessage);
}

/** View a built message as a plain dict. */
function asDict(message: AnyMessage): Record<string, unknown> {
  return message as unknown as Record<string, unknown>;
}

function _startedMessage(toolCallId = "call_123"): AnyMessage {
  return asyncToolMessages.buildStartedMessage(toolCallId);
}

function _intermediateMessage(toolCallId = "call_123", result = '"intermediate-1"'): AnyMessage {
  return asyncToolMessages.buildIntermediateResultMessage(toolCallId, result);
}

function _finalMessage(toolCallId = "call_123", result = '"final-result"'): AnyMessage {
  return asyncToolMessages.buildFinalResultMessage(toolCallId, result);
}

describe("TestParseMessage", () => {
  test("test_parses_started", () => {
    const info = asyncToolMessages.parseMessage(_startedMessage("abc"));
    expect(info).not.toBeNull();
    expect(info!.kind).toBe("started");
    expect(info!.toolCallId).toBe("abc");
    expect(info!.status).toBe("running");
    expect(info!.result).toBeNull();
    expect(typeof info!.description === "string" && info!.description.length > 0).toBe(true);
  });

  test("test_parses_intermediate", () => {
    const info = asyncToolMessages.parseMessage(_intermediateMessage("abc", '"hello"'));
    expect(info).not.toBeNull();
    expect(info!.kind).toBe("intermediate");
    expect(info!.toolCallId).toBe("abc");
    expect(info!.status).toBe("running");
    expect(info!.result).toBe('"hello"');
  });

  test("test_parses_final", () => {
    const info = asyncToolMessages.parseMessage(_finalMessage("abc", '"done"'));
    expect(info).not.toBeNull();
    expect(info!.kind).toBe("final");
    expect(info!.toolCallId).toBe("abc");
    expect(info!.status).toBe("finished");
    expect(info!.result).toBe('"done"');
  });

  test("test_parses_completed_sentinel_result", () => {
    // When a function returns no value, the aggregator sets the result to
    // the literal "COMPLETED" — same convention used for synchronous tool
    // calls. The parser doesn't treat it specially; it's just a string.
    const info = asyncToolMessages.parseMessage(_finalMessage("abc", "COMPLETED"));
    expect(info).not.toBeNull();
    expect(info!.kind).toBe("final");
    expect(info!.result).toBe("COMPLETED");
  });

  test("test_returns_none_for_regular_user_message", () => {
    expect(parse({ role: "user", content: "hello" })).toBeNull();
  });

  test("test_returns_none_for_regular_assistant_message", () => {
    expect(parse({ role: "assistant", content: "hi" })).toBeNull();
  });

  test("test_returns_none_for_regular_tool_message", () => {
    // IN_PROGRESS / regular tool result string content.
    expect(parse({ role: "tool", tool_call_id: "x", content: "IN_PROGRESS" })).toBeNull();
    expect(parse({ role: "tool", tool_call_id: "x", content: "weather: sunny" })).toBeNull();
  });

  test("test_returns_none_for_developer_message_without_payload", () => {
    // role=developer is also used for non-async-tool things (potentially).
    expect(parse({ role: "developer", content: "some other developer note" })).toBeNull();
  });

  test("test_returns_none_for_invalid_json_content", () => {
    expect(parse({ role: "tool", content: "{not json" })).toBeNull();
  });

  test("test_returns_none_for_non_dict_json", () => {
    expect(parse({ role: "tool", content: "[1, 2, 3]" })).toBeNull();
  });

  test("test_returns_none_for_wrong_payload_type", () => {
    expect(
      parse({
        role: "tool",
        content: JSON.stringify({ type: "something_else", tool_call_id: "x" }),
      }),
    ).toBeNull();
  });

  test("test_returns_none_when_tool_call_id_missing", () => {
    expect(
      parse({
        role: "tool",
        content: JSON.stringify({ type: "async_tool", status: "running" }),
      }),
    ).toBeNull();
  });

  test("test_returns_none_when_status_invalid", () => {
    expect(
      parse({
        role: "tool",
        content: JSON.stringify({ type: "async_tool", tool_call_id: "x", status: "weird" }),
      }),
    ).toBeNull();
  });

  test("test_returns_none_for_non_string_content", () => {
    // A multimodal message with content as a list would not be an async-tool message.
    expect(parse({ role: "tool", content: [{ type: "text", text: "hi" }] })).toBeNull();
  });

  test("test_returns_none_for_missing_role", () => {
    expect(parse({ content: "{}" })).toBeNull();
  });
});

/** Verify the builders produce the canonical payload shape and round-trip cleanly. */
describe("TestBuilders", () => {
  test("test_started_message_shape", () => {
    const msg = asDict(asyncToolMessages.buildStartedMessage("call_42"));
    // Top-level: role=tool plus the tool_call_id (so the message can sit
    // alongside other regular tool messages in the context).
    expect(msg.role).toBe("tool");
    expect(msg.tool_call_id).toBe("call_42");
    const payload = JSON.parse(msg.content as string);
    expect(payload.type).toBe("async_tool");
    expect(payload.status).toBe("running");
    expect(payload.tool_call_id).toBe("call_42");
    expect("result" in payload).toBe(false);
    expect(typeof payload.description === "string" && payload.description.length > 0).toBe(true);
  });

  test("test_intermediate_message_shape", () => {
    const msg = asDict(asyncToolMessages.buildIntermediateResultMessage("call_99", '"step-1"'));
    // Intermediate/final use role=developer and don't carry tool_call_id at
    // the top level (that's only inside the payload).
    expect(msg.role).toBe("developer");
    expect("tool_call_id" in msg).toBe(false);
    const payload = JSON.parse(msg.content as string);
    expect(payload.type).toBe("async_tool");
    expect(payload.status).toBe("running");
    expect(payload.tool_call_id).toBe("call_99");
    expect(payload.result).toBe('"step-1"');
    expect(typeof payload.description === "string" && payload.description.length > 0).toBe(true);
  });

  test("test_final_message_shape", () => {
    const msg = asDict(asyncToolMessages.buildFinalResultMessage("call_7", '"all-done"'));
    expect(msg.role).toBe("developer");
    expect("tool_call_id" in msg).toBe(false);
    const payload = JSON.parse(msg.content as string);
    expect(payload.type).toBe("async_tool");
    expect(payload.status).toBe("finished");
    expect(payload.tool_call_id).toBe("call_7");
    expect(payload.result).toBe('"all-done"');
    expect(typeof payload.description === "string" && payload.description.length > 0).toBe(true);
  });

  test("test_final_message_with_completed_sentinel", () => {
    // The aggregator passes the literal "COMPLETED" string when the
    // function returned no value (same convention as for synchronous
    // tool calls). The builder doesn't treat it specially; it just
    // round-trips as the result.
    const msg = asyncToolMessages.buildFinalResultMessage("call_1", "COMPLETED");
    const payload = JSON.parse(asDict(msg).content as string);
    expect(payload.result).toBe("COMPLETED");
    const info = asyncToolMessages.parseMessage(msg);
    expect(info).not.toBeNull();
    expect(info!.kind).toBe("final");
    expect(info!.result).toBe("COMPLETED");
  });

  test("test_cancelled_message_shape", () => {
    const msg = asDict(asyncToolMessages.buildCancelledMessage("call_5"));
    expect(msg.role).toBe("developer");
    expect("tool_call_id" in msg).toBe(false);
    const payload = JSON.parse(msg.content as string);
    expect(payload.type).toBe("async_tool");
    expect(payload.status).toBe("finished");
    expect(payload.tool_call_id).toBe("call_5");
    expect((payload.result as string).startsWith("CANCELLED")).toBe(true);
    expect(typeof payload.description === "string" && payload.description.length > 0).toBe(true);
  });

  test("test_cancelled_round_trip", () => {
    // A cancelled call settles the tool_call_id the same way a result does,
    // so it parses back as a final message.
    const msg = asyncToolMessages.buildCancelledMessage("call_x");
    const info = asyncToolMessages.parseMessage(msg);
    expect(info).not.toBeNull();
    expect(info!.kind).toBe("final");
    expect(info!.toolCallId).toBe("call_x");
    expect(info!.status).toBe("finished");
    expect(info!.result!.startsWith("CANCELLED")).toBe(true);
  });

  test("test_started_round_trip", () => {
    const msg = asyncToolMessages.buildStartedMessage("call_x");
    const info = asyncToolMessages.parseMessage(msg);
    expect(info).not.toBeNull();
    expect(info!.kind).toBe("started");
    expect(info!.toolCallId).toBe("call_x");
    expect(info!.status).toBe("running");
    expect(info!.result).toBeNull();
  });

  test("test_intermediate_round_trip", () => {
    const msg = asyncToolMessages.buildIntermediateResultMessage("call_x", '{"step": 1}');
    const info = asyncToolMessages.parseMessage(msg);
    expect(info).not.toBeNull();
    expect(info!.kind).toBe("intermediate");
    expect(info!.toolCallId).toBe("call_x");
    expect(info!.status).toBe("running");
    expect(info!.result).toBe('{"step": 1}');
  });

  test("test_final_round_trip", () => {
    const msg = asyncToolMessages.buildFinalResultMessage("call_x", '{"answer": 42}');
    const info = asyncToolMessages.parseMessage(msg);
    expect(info).not.toBeNull();
    expect(info!.kind).toBe("final");
    expect(info!.toolCallId).toBe("call_x");
    expect(info!.status).toBe("finished");
    expect(info!.result).toBe('{"answer": 42}');
  });

  test("test_non_ascii_result_is_not_escaped", () => {
    // The aggregator passes a result already serialized with
    // ensure_ascii=False; the payload must not escape it a second time.
    const result = '{"status": "आपका ऑर्डर कल पहुँचेगा"}';
    const msg = asyncToolMessages.buildFinalResultMessage("call_x", result);
    const content = asDict(msg).content as string;
    expect(content.includes("आपका ऑर्डर कल पहुँचेगा")).toBe(true);
    expect(content.includes("\\u")).toBe(false);
    const info = asyncToolMessages.parseMessage(msg);
    expect(info).not.toBeNull();
    expect(info!.result).toBe(result);
  });
});
