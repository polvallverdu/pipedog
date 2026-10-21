// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_evals_conversation.py

import { describe, expect, test } from "bun:test";
import { EvalConversation } from "../src/conversation.ts";

describe("TestEvalConversation", () => {
  test("test_a_bot_turn_is_what_it_said_between_user_turns_with_its_calls_before_it", () => {
    const conversation = new EvalConversation();
    conversation.addAssistantMessage("Hello!");
    conversation.addUserMessage("A table at six, please.");
    conversation.addAssistantMessage("Let me check.");
    conversation.addToolCall("check_availability", { time: "6" });
    conversation.addAssistantMessage("Six is free.");
    conversation.endBotTurn();
    expect(conversation.messages).toEqual([
      { role: "assistant", content: "Hello!" },
      { role: "user", content: "A table at six, please." },
      {
        role: "tool_call",
        name: "check_availability",
        arguments: { time: "6" },
        cancelled: false,
      },
      { role: "assistant", content: "Let me check. Six is free." },
    ]);
  });

  test("test_a_turn_in_which_nothing_was_said_is_not_a_turn", () => {
    const conversation = new EvalConversation();
    conversation.addUserMessage("Hi.");
    conversation.addToolCall("lookup", {});
    conversation.addAssistantMessage("  ");
    conversation.addUserMessage("Hello?");
    conversation.addUserMessage("");
    conversation.endBotTurn();
    expect(conversation.messages.map((m) => m.role)).toEqual(["user", "tool_call", "user"]);
  });

  test("test_a_cancel_marks_the_latest_call_by_that_name_still_standing", () => {
    const conversation = new EvalConversation();
    conversation.addToolCall("book", { time: "6" });
    conversation.addToolCall("book", { time: "7" });

    const cancelled = () => conversation.messages.map((m) => m.cancelled);

    conversation.cancelToolCall("book");
    expect(cancelled()).toEqual([false, true]);
    conversation.cancelToolCall("book");
    expect(cancelled()).toEqual([true, true]);
    conversation.cancelToolCall("lookup");
    expect(cancelled()).toEqual([true, true]);
  });

  test("test_the_user_spoke_last_until_the_bot_says_something", () => {
    const conversation = new EvalConversation();
    expect(conversation.userSpokeLast).toBe(false);
    conversation.addUserMessage("Bye.");
    expect(conversation.userSpokeLast).toBe(true);
    // A call is not something said.
    conversation.addToolCall("end", {});
    expect(conversation.userSpokeLast).toBe(true);
    conversation.addAssistantMessage("Goodbye!");
    expect(conversation.userSpokeLast).toBe(false);
  });
});
