// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_rtvi_observer_function_calls.py

/** Tests for how RTVIObserver reports function calls, this pipeline's own and external ones. */

import { describe, expect, mock, test } from "bun:test";
import {
  ExternalFunctionCall,
  ExternalFunctionCallCancelFrame,
  ExternalFunctionCallInProgressFrame,
  ExternalFunctionCallResultFrame,
  ExternalFunctionCallsStartedFrame,
  type Frame,
  FunctionCallResultFrame,
  FunctionCallResultProperties,
} from "../src/frames/frames.ts";
import {
  RTVIFunctionCallReportLevel,
  RTVIObserver,
  RTVIObserverParams,
} from "../src/processors/frameworks/rtvi/observer.ts";

// Messages are inspected loosely, as upstream does.
type SentMessage = any;

interface ObserverInternals {
  _reportFunctionCallFrame(frame: Frame): Promise<void>;
}

function _observer(
  levels: Record<string, RTVIFunctionCallReportLevel>,
): [ObserverInternals, SentMessage[]] {
  const observer = new RTVIObserver(null, {
    params: new RTVIObserverParams({ functionCallReportLevel: levels }),
  });
  const sent: SentMessage[] = [];
  observer.sendRtviMessage = mock(async (m: SentMessage) => {
    sent.push(m);
  });
  return [observer as unknown as ObserverInternals, sent];
}

function _external(phase: string): Frame {
  const args = { location: "Seattle" };
  if (phase === "started") {
    return new ExternalFunctionCallsStartedFrame({
      functionCalls: [
        new ExternalFunctionCall({ functionName: "get_weather", toolCallId: "toolu_1" }),
      ],
    });
  }
  if (phase === "in_progress") {
    return new ExternalFunctionCallInProgressFrame({
      functionName: "get_weather",
      toolCallId: "toolu_1",
      arguments: args,
    });
  }
  return new ExternalFunctionCallResultFrame({
    functionName: "get_weather",
    toolCallId: "toolu_1",
    arguments: args,
    result: { temp: 62 },
  });
}

describe("TestExternalFunctionCalls", () => {
  test("test_an_external_call_is_reported_like_the_pipelines_own", async () => {
    const [observer, sent] = _observer({ "*": RTVIFunctionCallReportLevel.FULL });

    for (const phase of ["started", "in_progress", "stopped"]) {
      await observer._reportFunctionCallFrame(_external(phase));
    }

    expect(sent.map((m) => m.type)).toEqual([
      "llm-function-call-started",
      "llm-function-call-in-progress",
      "llm-function-call-stopped",
    ]);
    expect(sent[0].data.functionName).toEqual("get_weather");
    expect(sent[1].data.arguments).toEqual({ location: "Seattle" });
    expect(sent[2].data.result).toEqual({ temp: 62 });
  });

  test("test_external_calls_announced_together_are_each_reported_started", async () => {
    // The started frame carries every call announced at once, as the pipeline's own does.
    const [observer, sent] = _observer({ "*": RTVIFunctionCallReportLevel.FULL });

    await observer._reportFunctionCallFrame(
      new ExternalFunctionCallsStartedFrame({
        functionCalls: [
          new ExternalFunctionCall({ functionName: "get_weather", toolCallId: "toolu_1" }),
          new ExternalFunctionCall({ functionName: "get_time", toolCallId: "toolu_2" }),
        ],
      }),
    );

    expect(sent.map((m) => m.type)).toEqual([
      "llm-function-call-started",
      "llm-function-call-started",
    ]);
    expect(sent.map((m) => m.data.functionName)).toEqual(["get_weather", "get_time"]);
  });

  test("test_an_intermediate_result_leaves_the_call_running", async () => {
    // Only a final result stops a call, the pipeline's own or an external one.
    const [observer, sent] = _observer({ "*": RTVIFunctionCallReportLevel.FULL });

    await observer._reportFunctionCallFrame(
      new FunctionCallResultFrame({
        functionName: "get_weather",
        toolCallId: "call_1",
        arguments: {},
        result: "62",
        properties: new FunctionCallResultProperties({ isFinal: false }),
      }),
    );
    await observer._reportFunctionCallFrame(
      new ExternalFunctionCallResultFrame({
        functionName: "get_weather",
        toolCallId: "toolu_1",
        arguments: {},
        result: "62",
        isFinal: false,
      }),
    );
    await observer._reportFunctionCallFrame(
      new ExternalFunctionCallCancelFrame({ functionName: "get_weather", toolCallId: "toolu_1" }),
    );

    expect(sent.map((m) => m.type)).toEqual(["llm-function-call-stopped"]);
    expect(sent[0].data.cancelled).toBe(true);
  });

  test("test_the_report_level_applies_by_the_external_calls_own_name", async () => {
    const [observer, sent] = _observer({
      "*": RTVIFunctionCallReportLevel.FULL,
      get_weather: RTVIFunctionCallReportLevel.NAME,
    });

    await observer._reportFunctionCallFrame(_external("in_progress"));

    expect(sent[0].data.functionName).toEqual("get_weather");
    expect(sent[0].data.arguments).toBeNull();
  });
});
