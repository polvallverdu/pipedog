// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipecat-ts contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_llm_response.py

import { describe, expect, test } from "bun:test";

import {
  type Frame,
  InterruptionFrame,
  LLMFullResponseEndFrame,
  LLMFullResponseStartFrame,
  LLMTextFrame,
} from "../src/frames/frames.ts";
import { LLMFullResponseAggregator } from "../src/processors/aggregators/llm_response.ts";
import { runTest, SleepFrame } from "../src/tests/utils.ts";

describe("TestLLMFullResponseAggregator", () => {
  test("test_empty", async () => {
    let completionOk = false;

    const aggregator = new LLMFullResponseAggregator();

    aggregator.eventHandler(
      "on_completion",
      async (_aggregator: unknown, completion: string, completed: boolean) => {
        completionOk = completion === "" && completed;
      },
    );

    const framesToSend: Frame[] = [new LLMFullResponseStartFrame(), new LLMFullResponseEndFrame()];
    const expectedDownFrames = [LLMFullResponseStartFrame, LLMFullResponseEndFrame];
    await runTest(aggregator, {
      framesToSend,
      expectedDownFrames,
    });
    expect(completionOk).toBe(true);
  });

  test("test_simple", async () => {
    let completionOk = false;

    const aggregator = new LLMFullResponseAggregator();

    aggregator.eventHandler(
      "on_completion",
      async (_aggregator: unknown, completion: string, completed: boolean) => {
        completionOk = completion === "Hello from Pipecat!" && completed;
      },
    );

    const framesToSend: Frame[] = [
      new LLMFullResponseStartFrame(),
      new LLMTextFrame({ text: "Hello from Pipecat!" }),
      new LLMFullResponseEndFrame(),
    ];
    const expectedDownFrames = [LLMFullResponseStartFrame, LLMTextFrame, LLMFullResponseEndFrame];
    await runTest(aggregator, {
      framesToSend,
      expectedDownFrames,
    });
    expect(completionOk).toBe(true);
  });

  test("test_multiple", async () => {
    let completionOk = false;

    const aggregator = new LLMFullResponseAggregator();

    aggregator.eventHandler(
      "on_completion",
      async (_aggregator: unknown, completion: string, completed: boolean) => {
        completionOk = completion === "Hello from Pipecat!" && completed;
      },
    );

    const framesToSend: Frame[] = [
      new LLMFullResponseStartFrame(),
      new LLMTextFrame({ text: "Hello " }),
      new LLMTextFrame({ text: "from " }),
      new LLMTextFrame({ text: "Pipecat!" }),
      new LLMFullResponseEndFrame(),
    ];
    const expectedDownFrames = [
      LLMFullResponseStartFrame,
      LLMTextFrame,
      LLMTextFrame,
      LLMTextFrame,
      LLMFullResponseEndFrame,
    ];
    await runTest(aggregator, {
      framesToSend,
      expectedDownFrames,
    });
    expect(completionOk).toBe(true);
  });

  test("test_interruption", async () => {
    let completionOk = true;

    const completionResult: [string, boolean][] = [
      ["Hello ", false],
      ["Hello there!", true],
    ];
    let completionIndex = 0;

    const aggregator = new LLMFullResponseAggregator();

    aggregator.eventHandler(
      "on_completion",
      async (_aggregator: unknown, completion: string, completed: boolean) => {
        const [completionExpected, completionCompleted] = completionResult[completionIndex]!;
        completionOk =
          completionOk && completion === completionExpected && completed === completionCompleted;
        completionIndex += 1;
      },
    );

    const framesToSend: Frame[] = [
      new LLMFullResponseStartFrame(),
      new LLMTextFrame({ text: "Hello " }),
      new SleepFrame(),
      new InterruptionFrame(),
      new LLMFullResponseStartFrame(),
      new LLMTextFrame({ text: "Hello " }),
      new LLMTextFrame({ text: "there!" }),
      new LLMFullResponseEndFrame(),
    ];
    const expectedDownFrames = [
      LLMFullResponseStartFrame,
      LLMTextFrame,
      InterruptionFrame,
      LLMFullResponseStartFrame,
      LLMTextFrame,
      LLMTextFrame,
      LLMFullResponseEndFrame,
    ];
    await runTest(aggregator, {
      framesToSend,
      expectedDownFrames,
    });
    expect(completionOk).toBe(true);
  });
});
