// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_ui_commands.py

/** Tests for UIWorker.sendCommand and standard command payload models. */

import { describe, expect, mock, test } from "bun:test";

import { BusUICommandMessage } from "../src/bus/ui/messages.ts";
import {
  Click,
  Focus,
  Highlight,
  Navigate,
  ScrollTo,
  SelectText,
  SetInputValue,
  Toast,
} from "../src/processors/frameworks/rtvi/models.ts";
import type { LLMService } from "../src/services/llm_service.ts";
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

/**
 * A UIWorker whose `sendBusMessage` captures sent commands.
 *
 * `sendCommand` publishes via `sendBusMessage`; replacing it avoids needing an
 * attached bus for these unit tests.
 */
function makeWorker(): [UIWorker, BusUICommandMessage[]] {
  const worker = new UIWorker({ name: "ui", llm: magicMock() as LLMService });
  const sent: BusUICommandMessage[] = [];

  const record = async (message: unknown): Promise<void> => {
    if (message instanceof BusUICommandMessage) {
      sent.push(message);
    }
  };

  (worker as unknown as { sendBusMessage: typeof record }).sendBusMessage = record;
  return [worker, sent];
}

describe("TestSendCommand", () => {
  test("test_serializes_pydantic_payload_via_model_dump", async () => {
    const [worker, sent] = makeWorker();

    await worker.sendCommand("toast", new Toast({ title: "Saved", subtitle: "Favorites" }));

    expect(sent.length).toEqual(1);
    const cmd = sent[0]!;
    expect(cmd.source).toEqual("ui");
    expect(cmd.target).toBeNull();
    expect(cmd.commandName).toEqual("toast");
    expect(cmd.payload).toEqual({
      title: "Saved",
      subtitle: "Favorites",
      description: null,
      image_url: null,
      duration_ms: null,
    });
  });

  test("test_forwards_dict_payload_as_is", async () => {
    const [worker, sent] = makeWorker();

    await worker.sendCommand("app_specific", { foo: 1, bar: [1, 2, 3] });

    expect(sent[0]!.commandName).toEqual("app_specific");
    expect(sent[0]!.payload).toEqual({ foo: 1, bar: [1, 2, 3] });
  });

  test("test_none_payload_becomes_empty_dict", async () => {
    const [worker, sent] = makeWorker();

    await worker.sendCommand("ping");

    expect(sent[0]!.payload).toEqual({});
  });

  test("test_dict_payload_for_apps_with_custom_command_names", async () => {
    const [worker, sent] = makeWorker();

    await worker.sendCommand("navigate", { view: "home" });
    expect(sent[0]!.payload).toEqual({ view: "home" });
  });
});

describe("TestStandardCommands", () => {
  test("test_toast_payload_shape", async () => {
    const [worker, sent] = makeWorker();
    await worker.sendCommand(
      "toast",
      new Toast({
        title: "Now playing",
        subtitle: "Nirvana",
        description: "Smells Like Teen Spirit",
        imageUrl: "https://example.com/cover.jpg",
        durationMs: 3000,
      }),
    );
    expect(sent[0]!.payload).toEqual({
      title: "Now playing",
      subtitle: "Nirvana",
      description: "Smells Like Teen Spirit",
      image_url: "https://example.com/cover.jpg",
      duration_ms: 3000,
    });
  });

  test("test_navigate_payload_shape", async () => {
    const [worker, sent] = makeWorker();
    await worker.sendCommand("navigate", new Navigate({ view: "detail", params: { id: "42" } }));
    expect(sent[0]!.payload).toEqual({ view: "detail", params: { id: "42" } });
  });

  test("test_scroll_to_payload_shape_by_target_id", async () => {
    const [worker, sent] = makeWorker();
    await worker.sendCommand(
      "scroll_to",
      new ScrollTo({ targetId: "new_releases", behavior: "smooth" }),
    );
    expect(sent[0]!.payload).toEqual({
      ref: null,
      target_id: "new_releases",
      behavior: "smooth",
    });
  });

  test("test_scroll_to_payload_shape_by_ref", async () => {
    const [worker, sent] = makeWorker();
    await worker.sendCommand("scroll_to", new ScrollTo({ ref: "e42", behavior: "smooth" }));
    expect(sent[0]!.payload).toEqual({ ref: "e42", target_id: null, behavior: "smooth" });
  });

  test("test_highlight_payload_shape", async () => {
    const [worker, sent] = makeWorker();
    await worker.sendCommand(
      "highlight",
      new Highlight({ targetId: "play_btn", durationMs: 1000 }),
    );
    expect(sent[0]!.payload).toEqual({ ref: null, target_id: "play_btn", duration_ms: 1000 });
  });

  test("test_focus_payload_shape", async () => {
    const [worker, sent] = makeWorker();
    await worker.sendCommand("focus", new Focus({ targetId: "search_input" }));
    expect(sent[0]!.payload).toEqual({ ref: null, target_id: "search_input" });
  });

  test("test_focus_payload_shape_by_ref", async () => {
    const [worker, sent] = makeWorker();
    await worker.sendCommand("focus", new Focus({ ref: "e7" }));
    expect(sent[0]!.payload).toEqual({ ref: "e7", target_id: null });
  });

  test("test_select_text_payload_whole_element", async () => {
    const [worker, sent] = makeWorker();
    await worker.sendCommand("select_text", new SelectText({ ref: "e42" }));
    expect(sent[0]!.payload).toEqual({
      ref: "e42",
      target_id: null,
      start_offset: null,
      end_offset: null,
    });
  });

  test("test_select_text_payload_with_offsets", async () => {
    const [worker, sent] = makeWorker();
    await worker.sendCommand(
      "select_text",
      new SelectText({ ref: "e42", startOffset: 5, endOffset: 12 }),
    );
    expect(sent[0]!.payload).toEqual({
      ref: "e42",
      target_id: null,
      start_offset: 5,
      end_offset: 12,
    });
  });

  test("test_set_input_value_payload_replace_default", async () => {
    const [worker, sent] = makeWorker();
    await worker.sendCommand("set_input_value", new SetInputValue({ ref: "e7", value: "hello" }));
    expect(sent[0]!.payload).toEqual({
      ref: "e7",
      target_id: null,
      value: "hello",
      replace: true,
    });
  });

  test("test_set_input_value_payload_append", async () => {
    const [worker, sent] = makeWorker();
    await worker.sendCommand(
      "set_input_value",
      new SetInputValue({ ref: "e7", value: " world", replace: false }),
    );
    expect(sent[0]!.payload).toEqual({
      ref: "e7",
      target_id: null,
      value: " world",
      replace: false,
    });
  });

  test("test_click_payload_by_ref", async () => {
    const [worker, sent] = makeWorker();
    await worker.sendCommand("click", new Click({ ref: "e42" }));
    expect(sent[0]!.payload).toEqual({ ref: "e42", target_id: null });
  });

  test("test_click_payload_by_target_id", async () => {
    const [worker, sent] = makeWorker();
    await worker.sendCommand("click", new Click({ targetId: "submit" }));
    expect(sent[0]!.payload).toEqual({ ref: null, target_id: "submit" });
  });
});
