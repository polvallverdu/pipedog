// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_ui_tools.py

/**
 * Tests for `ReplyToolMixin` and the action helper methods on `UIWorker`.
 *
 * The mixin exposes a single bundled `reply(answer, scroll_to, highlight, ...)`
 * LLM tool whose `answer` argument is required. The helper methods
 * (`scrollTo`, `highlight`, ...) are plain instance methods on `UIWorker` that
 * wrap `sendCommand` with the standard payload models; apps call them inside
 * custom `tool` bodies when the canonical `reply` shape doesn't fit.
 *
 * `ReplyToolMixin` is deprecated upstream (since 1.12.0, use `screen_tools`)
 * and is not ported, so the tests that exercise it are skipped.
 */

import { describe, expect, mock, test } from "bun:test";

import type { BusUICommandMessage } from "../src/bus/ui/messages.ts";
import type { LLMService } from "../src/services/llm_service.ts";
import { _collectTools } from "../src/workers/llm/tool_decorator.ts";
import { UIWorker } from "../src/workers/ui/index.ts";

/**
 * Minimal stand-in for `unittest.mock.MagicMock`: every attribute access
 * returns a callable mock, and calling it returns another such mock.
 */
function magicMock(): any {
  const cache = new Map<PropertyKey, unknown>();
  const fn = mock((..._args: unknown[]) => magicMock());
  return new Proxy(fn, {
    get(target, prop, receiver) {
      if (prop === "then") {
        return undefined;
      }
      if (prop === Symbol.toPrimitive || prop === "toString") {
        return () => "<MagicMock>";
      }
      if (prop in target) {
        return Reflect.get(target, prop, receiver);
      }
      if (!cache.has(prop)) {
        cache.set(prop, magicMock());
      }
      return cache.get(prop);
    },
  });
}

class _PlainWorker extends UIWorker {}

function _new(cls: typeof UIWorker): UIWorker {
  return new cls({ name: "ui", llm: magicMock() as LLMService });
}

function _capture(worker: UIWorker): BusUICommandMessage[] {
  const sent: BusUICommandMessage[] = [];

  const _record = async (message: BusUICommandMessage): Promise<void> => {
    sent.push(message);
  };

  (worker as unknown as { sendBusMessage: typeof _record }).sendBusMessage = _record;
  return sent;
}

/** The helper methods are plain methods, not LLM tools. */
describe("TestUIWorkerActionHelpers", () => {
  test("test_scroll_to_helper_dispatches_command", async () => {
    const worker = _new(_PlainWorker);
    const sent = _capture(worker);

    await worker.scrollTo("e42");

    expect(sent.length).toEqual(1);
    expect(sent[0]!.commandName).toEqual("scroll_to");
    expect(sent[0]!.payload).toEqual({ ref: "e42", target_id: null, behavior: null });
  });

  test("test_highlight_helper_dispatches_command", async () => {
    const worker = _new(_PlainWorker);
    const sent = _capture(worker);

    await worker.highlight("e7");

    expect(sent.length).toEqual(1);
    expect(sent[0]!.commandName).toEqual("highlight");
    expect(sent[0]!.payload).toEqual({ ref: "e7", target_id: null, duration_ms: null });
  });

  test("test_select_text_helper_whole_element", async () => {
    const worker = _new(_PlainWorker);
    const sent = _capture(worker);

    await worker.selectText("e42");

    expect(sent.length).toEqual(1);
    expect(sent[0]!.commandName).toEqual("select_text");
    expect(sent[0]!.payload).toEqual({
      ref: "e42",
      target_id: null,
      start_offset: null,
      end_offset: null,
    });
  });

  test("test_select_text_helper_with_offsets", async () => {
    const worker = _new(_PlainWorker);
    const sent = _capture(worker);

    await worker.selectText("e42", { startOffset: 10, endOffset: 25 });

    expect(sent.length).toEqual(1);
    expect(sent[0]!.payload).toEqual({
      ref: "e42",
      target_id: null,
      start_offset: 10,
      end_offset: 25,
    });
  });

  test("test_click_helper_dispatches_command", async () => {
    const worker = _new(_PlainWorker);
    const sent = _capture(worker);

    await worker.click("e42");

    expect(sent.length).toEqual(1);
    expect(sent[0]!.commandName).toEqual("click");
    expect(sent[0]!.payload).toEqual({ ref: "e42", target_id: null });
  });

  test("test_set_input_value_helper_default_replace", async () => {
    const worker = _new(_PlainWorker);
    const sent = _capture(worker);

    await worker.setInputValue("e42", "hello world");

    expect(sent.length).toEqual(1);
    expect(sent[0]!.commandName).toEqual("set_input_value");
    expect(sent[0]!.payload).toEqual({
      ref: "e42",
      target_id: null,
      value: "hello world",
      replace: true,
    });
  });

  test("test_set_input_value_helper_append_mode", async () => {
    const worker = _new(_PlainWorker);
    const sent = _capture(worker);

    await worker.setInputValue("e42", "more text", { replace: false });

    expect((sent[0]!.payload as Record<string, unknown>).replace).toEqual(false);
  });

  test("test_helpers_are_not_llm_tools", async () => {
    const worker = _new(_PlainWorker);
    const toolNames = _collectTools(worker).map((t) => t.name);
    for (const name of ["scrollTo", "highlight", "selectText", "click", "setInputValue"]) {
      expect(toolNames).not.toContain(name);
    }
  });
});

describe("TestReplyToolMixin", () => {
  // Skipped: `ReplyToolMixin` is deprecated upstream (since 1.12.0, use
  // `screen_tools`) and is not ported; this test only checks its deprecation
  // warning.
  test.skip("test_composing_the_mixin_warns", async () => {});

  // Skipped: exercises the deprecated, unported `ReplyToolMixin`.
  test.skip("test_mixin_exposes_reply_tool", async () => {});

  test("test_plain_uiworker_has_no_reply_tool", async () => {
    const worker = _new(_PlainWorker);
    const toolNames = _collectTools(worker).map((t) => t.name);
    expect(toolNames).not.toContain("reply");
  });

  // Skipped: the remaining tests exercise `ReplyToolMixin.reply` and
  // `respond_to_job(tts_speak=...)`, both deprecated upstream (since 1.12.0)
  // and not ported.
  test.skip("test_reply_with_answer_only_terminates", async () => {});
  test.skip("test_reply_with_highlight_only", async () => {});
  test.skip("test_reply_with_multiple_highlights", async () => {});
  test.skip("test_reply_with_scroll_and_highlight_runs_in_order", async () => {});
  test.skip("test_reply_with_select_text_only", async () => {});
  test.skip("test_reply_with_scroll_and_select_text", async () => {});
  test.skip("test_reply_with_fills_writes_each_input", async () => {});
  test.skip("test_reply_with_click_clicks_each_in_order", async () => {});
  test.skip("test_reply_with_fills_skips_invalid_entries", async () => {});
  test.skip("test_reply_with_non_dict_fill_entries_does_not_crash", async () => {});
  test.skip("test_reply_with_non_string_highlight_refs_skipped", async () => {});
  test.skip("test_reply_with_non_string_click_refs_skipped", async () => {});
  test.skip("test_reply_dispatches_via_helper_methods", async () => {});
});
