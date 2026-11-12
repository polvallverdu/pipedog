// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_evals_conversation_observer.py

import { beforeEach, describe, expect, test } from "bun:test";
import {
  ExternalFunctionCallInProgressFrame,
  type Frame,
  FunctionCallCancelFrame,
  FunctionCallInProgressFrame,
  LLMContextAssistantTurnFrame,
  LLMContextUserTurnFrame,
  LLMFullResponseEndFrame,
  LLMFullResponseStartFrame,
  LLMTextFrame,
  ProposedUserStartedSpeakingFrame,
  ProposedUserStoppedSpeakingFrame,
  TranscriptionFrame,
} from "@pipedog/core/frames/frames";
import { FramePushed } from "@pipedog/core/observers/base_observer";
import { Pipeline } from "@pipedog/core/pipeline/pipeline";
import { LLMContext } from "@pipedog/core/processors/aggregators/llm_context";
import {
  LLMContextAggregatorPair,
  LLMUserAggregatorParams,
} from "@pipedog/core/processors/aggregators/llm_response_universal";
import { IdentityFilter } from "@pipedog/core/processors/filters/identity_filter";
import { FrameDirection } from "@pipedog/core/processors/frame_processor";
import { RTVISendTextFrame } from "@pipedog/core/processors/frameworks/rtvi/frames";
import { runTest, SleepFrame } from "@pipedog/core/tests/utils";
import { ExternalUserTurnStartStrategy } from "@pipedog/core/turns/user_start/external_user_turn_start_strategy";
import { ExternalUserTurnStopStrategy } from "@pipedog/core/turns/user_stop/external_user_turn_stop_strategy";
import { UserTurnStrategies } from "@pipedog/core/turns/user_turn_strategies";
import { TaskManager } from "@pipedog/core/utils/asyncio/task_manager";
import type { EvalConversationMessage } from "../src/conversation.ts";
import {
  type EvalConversationEndedMessage,
  EvalConversationObserver,
} from "../src/conversation_observer.ts";

function inProgress(name: string, args: Record<string, unknown>): FunctionCallInProgressFrame {
  return new FunctionCallInProgressFrame({
    functionName: name,
    toolCallId: name,
    arguments: args,
  });
}

describe("TestEvalConversationObserver", () => {
  let observer: EvalConversationObserver;
  let reported: EvalConversationMessage[][];

  beforeEach(async () => {
    observer = new EvalConversationObserver();
    // Event handlers run as tasks, so the observer needs a task manager.
    await observer.setup(new TaskManager());
    reported = [];

    observer.eventHandler(
      "on_conversation_ended",
      async (_observer, message: EvalConversationEndedMessage) => {
        reported.push(message.conversation);
      },
    );
  });

  /** Feed one frame to the observer, as its first push in a pipeline would. */
  async function push(frame: Frame, direction: FrameDirection = FrameDirection.DOWNSTREAM) {
    await observer.onPushFrame(
      new FramePushed({
        source: new IdentityFilter({ name: "source" }),
        destination: new IdentityFilter({ name: "destination" }),
        frame,
        direction,
        timestamp: 0,
      }),
    );
  }

  test("test_the_turns_and_calls_are_reported_as_a_conversation_once_the_pipeline_is_done", async () => {
    // A turn answered early is reported once, as written when it ends.
    await push(
      new LLMContextUserTurnFrame({ text: "a table at six", timestamp: "t", speculation: true }),
    );
    await push(new LLMContextUserTurnFrame({ text: "A table at six.", timestamp: "t" }));
    // A broadcast call arrives as two frames: the upstream one is the same call.
    const downstream = inProgress("check", { time: "6" });
    const upstream = inProgress("check", {});
    downstream.broadcastSiblingId = upstream.id;
    upstream.broadcastSiblingId = downstream.id;
    await push(downstream);
    await push(upstream, FrameDirection.UPSTREAM);
    await push(new LLMContextAssistantTurnFrame({ text: "Let me check.", timestamp: "t" }));
    await push(
      new ExternalFunctionCallInProgressFrame({
        functionName: "book",
        toolCallId: "book",
        arguments: { time: "6" },
      }),
    );
    await push(new FunctionCallCancelFrame({ functionName: "book", toolCallId: "book" }));
    await push(new LLMContextAssistantTurnFrame({ text: "Six is free.", timestamp: "t" }));
    // Text a client sent is a user turn as well.
    await push(new RTVISendTextFrame({ msgId: "1", text: "Thanks." }));
    await push(new LLMContextAssistantTurnFrame({ text: "Bye!", timestamp: "t" }));
    expect(reported).toEqual([]);

    await observer.cleanup();

    expect(reported).toEqual([
      [
        { role: "user", content: "A table at six." },
        {
          role: "tool_call",
          name: "check",
          arguments: { time: "6" },
          cancelled: false,
        },
        {
          role: "tool_call",
          name: "book",
          arguments: { time: "6" },
          cancelled: true,
        },
        { role: "assistant", content: "Let me check. Six is free." },
        { role: "user", content: "Thanks." },
        { role: "assistant", content: "Bye!" },
      ],
    ]);
  });

  test("test_the_aggregators_turns_reach_the_conversation_through_a_pipeline", async () => {
    const context = new LLMContext();
    const aggregators = new LLMContextAggregatorPair(context, {
      userParams: new LLMUserAggregatorParams({
        userTurnStrategies: new UserTurnStrategies({
          start: [new ExternalUserTurnStartStrategy()],
          stop: [new ExternalUserTurnStopStrategy({ timeout: 60.0 })],
        }),
      }),
    });
    const observer = new EvalConversationObserver();
    const reported: EvalConversationMessage[][] = [];

    observer.eventHandler(
      "on_conversation_ended",
      async (_observer, message: EvalConversationEndedMessage) => {
        reported.push(message.conversation);
      },
    );

    await runTest(new Pipeline([aggregators.user(), aggregators.assistant()]), {
      framesToSend: [
        new ProposedUserStartedSpeakingFrame(),
        new TranscriptionFrame({ text: "A table at six, please.", userId: "", timestamp: "now" }),
        new ProposedUserStoppedSpeakingFrame(),
        new SleepFrame({ sleep: 0.1 }),
        new LLMFullResponseStartFrame(),
        new LLMTextFrame({ text: "Six is free." }),
        new LLMFullResponseEndFrame(),
        new SleepFrame({ sleep: 0.1 }),
      ],
      expectedDownFrames: null,
      observers: [observer],
    });

    expect(reported).toEqual([
      [
        { role: "user", content: "A table at six, please." },
        { role: "assistant", content: "Six is free." },
      ],
    ]);
  });
});
