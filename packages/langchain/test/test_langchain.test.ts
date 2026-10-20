// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_langchain.py

/**
 * PORTING NOTES:
 * - langchain_core's `FakeStreamingListLLM(responses=[...])` → `FakeStreamingLLM({ responses, sleep: 0 })`
 *   from `@langchain/core/utils/testing`: both stream the response one character
 *   at a time (the Python one has no sleep by default).
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { ChatPromptTemplate } from "@langchain/core/prompts";
import { FakeStreamingLLM } from "@langchain/core/utils/testing";
import {
  type Frame,
  InterruptionFrame,
  LLMContextAssistantTimestampFrame,
  LLMContextAssistantTurnFrame,
  LLMContextFrame,
  LLMContextUserTurnFrame,
  LLMFullResponseEndFrame,
  LLMFullResponseStartFrame,
  TextFrame,
  TranscriptionFrame,
  UserStartedSpeakingFrame,
  UserStoppedSpeakingFrame,
  VADUserStartedSpeakingFrame,
  VADUserStoppedSpeakingFrame,
} from "@pipedog/core/frames/frames";
import { Pipeline } from "@pipedog/core/pipeline/pipeline";
import { LLMContext } from "@pipedog/core/processors/aggregators/llm_context";
import {
  LLMContextAggregatorPair,
  LLMUserAggregatorParams,
} from "@pipedog/core/processors/aggregators/llm_response_universal";
import { type FrameDirection, FrameProcessor } from "@pipedog/core/processors/frame_processor";
import { runTest, SleepFrame } from "@pipedog/core/tests/utils";
import { SpeechTimeoutUserTurnStopStrategy } from "@pipedog/core/turns/user_stop/index";
import { UserTurnStrategies } from "@pipedog/core/turns/user_turn_strategies";
import { LangchainProcessor } from "../src/langchain.ts";

describe("TestLangchain", () => {
  class MockProcessor extends FrameProcessor {
    token: string[] = [];
    // Start collecting tokens when we see the start frame
    startCollecting = false;

    constructor(name: string) {
      super({ name });
    }

    override toString(): string {
      return this.name;
    }

    override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
      await super.processFrame(frame, direction);

      if (frame instanceof LLMFullResponseStartFrame) {
        this.startCollecting = true;
      } else if (frame instanceof TextFrame && this.startCollecting) {
        this.token.push(frame.text);
      } else if (frame instanceof LLMFullResponseEndFrame) {
        this.startCollecting = false;
      }

      await this.pushFrame(frame, direction);
    }
  }

  let expectedResponse: string;
  let fakeLlm: FakeStreamingLLM;

  beforeEach(() => {
    expectedResponse = "Hello dear human";
    fakeLlm = new FakeStreamingLLM({ responses: [expectedResponse], sleep: 0 });
  });

  test("test_langchain", async () => {
    const messages: [string, string][] = [
      ["system", "Say hello to {name}"],
      ["human", "{input}"],
    ];
    const prompt = await ChatPromptTemplate.fromMessages(messages).partial({ name: "Thomas" });
    const chain = prompt.pipe(fakeLlm);
    const proc = new LangchainProcessor(chain);
    const mockProc = new MockProcessor("token_collector");

    const context = new LLMContext();
    const contextAggregator = new LLMContextAggregatorPair(context, {
      userParams: new LLMUserAggregatorParams({
        userTurnStrategies: new UserTurnStrategies({
          stop: [new SpeechTimeoutUserTurnStopStrategy()],
        }),
      }),
    });

    const pipeline = new Pipeline([
      contextAggregator.user(),
      proc,
      mockProc,
      contextAggregator.assistant(),
    ]);

    const framesToSend = [
      new VADUserStartedSpeakingFrame(),
      new TranscriptionFrame({ text: "Hi World", userId: "user", timestamp: "now" }),
      new SleepFrame(),
      new VADUserStoppedSpeakingFrame(),
      new SleepFrame({ sleep: 1.0 }),
    ];
    const expectedDownFrames = [
      VADUserStartedSpeakingFrame,
      UserStartedSpeakingFrame,
      InterruptionFrame,
      VADUserStoppedSpeakingFrame,
      UserStoppedSpeakingFrame,
      LLMContextUserTurnFrame,
      LLMContextFrame,
      LLMContextAssistantTimestampFrame,
      LLMContextAssistantTurnFrame,
    ];
    await runTest(pipeline, {
      framesToSend,
      expectedDownFrames,
    });

    expect(mockProc.token.join("")).toEqual(expectedResponse);
    const assistantMessages = contextAggregator.assistant().messages;
    expect(
      (assistantMessages[assistantMessages.length - 1] as { content: unknown }).content,
    ).toEqual(expectedResponse);
  });
});
