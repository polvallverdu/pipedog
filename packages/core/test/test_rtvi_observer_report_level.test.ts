// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_rtvi_observer_report_level.py

/** Tests for the function call fields RTVIObserver sends at a report level. */

import { describe, expect, mock, test } from "bun:test";
import {
  FunctionCallCancelFrame,
  FunctionCallFromLLM,
  FunctionCallInProgressFrame,
  FunctionCallResultFrame,
  FunctionCallsStartedFrame,
} from "../src/frames/frames.ts";
import { IdentityFilter } from "../src/processors/filters/identity_filter.ts";
import {
  RTVIFunctionCallReportLevel,
  RTVIObserver,
  RTVIObserverParams,
} from "../src/processors/frameworks/rtvi/observer.ts";
import { runTest } from "../src/tests/utils.ts";

// Messages are inspected loosely, as upstream does.
type SentMessage = any;

/** `assertCountEqual`: the same elements, in any order. */
function expectCountEqual(actual: unknown[], expected: unknown[]): void {
  const key = (v: unknown) => JSON.stringify(v);
  const sortByKey = (xs: unknown[]) => [...xs].sort((a, b) => key(a).localeCompare(key(b)));
  expect(sortByKey(actual)).toEqual(sortByKey(expected));
}

describe("TestRTVIObserverReportLevel", () => {
  test("test_arguments_level_reports_arguments_and_no_result", async () => {
    const observer = new RTVIObserver(null, {
      params: new RTVIObserverParams({
        functionCallReportLevel: { "*": RTVIFunctionCallReportLevel.ARGUMENTS },
      }),
    });
    const sent: SentMessage[] = [];
    observer.sendRtviMessage = mock(async (m: SentMessage) => {
      sent.push(m);
    });
    const args = { query: "pricing" };

    await runTest(new IdentityFilter(), {
      framesToSend: [
        new FunctionCallsStartedFrame({
          functionCalls: [
            new FunctionCallFromLLM({
              functionName: "search",
              toolCallId: "call_1",
              arguments: args,
              context: null,
            }),
          ],
        }),
        new FunctionCallInProgressFrame({
          functionName: "search",
          toolCallId: "call_1",
          arguments: args,
        }),
        new FunctionCallResultFrame({
          functionName: "search",
          toolCallId: "call_1",
          arguments: args,
          result: { passages: ["Pro costs $20 a month."] },
        }),
        new FunctionCallCancelFrame({ functionName: "search", toolCallId: "call_2" }),
      ],
      observers: [observer],
    });

    // System frames can overtake the others, so the order of the messages is not fixed.
    expectCountEqual(
      sent.map((m) => [m.type, m.data.modelDump({ excludeNone: true })]),
      [
        ["llm-function-call-started", { function_name: "search" }],
        [
          "llm-function-call-in-progress",
          { tool_call_id: "call_1", function_name: "search", arguments: args },
        ],
        [
          "llm-function-call-stopped",
          { tool_call_id: "call_1", cancelled: false, function_name: "search" },
        ],
        [
          "llm-function-call-stopped",
          { tool_call_id: "call_2", cancelled: true, function_name: "search" },
        ],
      ],
    );
  });
});
