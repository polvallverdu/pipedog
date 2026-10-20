// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipecat-ts contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_function_call_observer.py

import { beforeEach, describe, expect, test } from "bun:test";
import { sleep } from "@pipecat-ts/asyncio";
import {
  type Frame,
  FunctionCallCancelFrame,
  FunctionCallFromLLM,
  FunctionCallInProgressFrame,
  type FunctionCallInProgressFrameOptions,
  FunctionCallResultFrame,
  type FunctionCallResultFrameOptions,
  FunctionCallResultProperties,
  FunctionCallsStartedFrame,
  TextFrame,
} from "../src/frames/frames.ts";
import { FramePushed } from "../src/observers/base_observer.ts";
import {
  type FunctionCallEvent,
  FunctionCallEventKind,
  FunctionCallObserver,
} from "../src/observers/function_call_observer.ts";
import { IdentityFilter } from "../src/processors/filters/identity_filter.ts";
import { FrameDirection } from "../src/processors/frame_processor.ts";
import { TaskManager } from "../src/utils/asyncio/task_manager.ts";

/** The life of a function call, moment by moment. */
describe("TestFunctionCallObserver", () => {
  let clock: number;
  let observer: FunctionCallObserver;
  let events: FunctionCallEvent[];

  function watch(o: FunctionCallObserver): void {
    o.eventHandler(
      "on_function_call_event",
      async (_observer: unknown, event: FunctionCallEvent) => {
        events.push(event);
      },
    );
  }

  beforeEach(async () => {
    clock = 1_000_000.0;
    observer = new FunctionCallObserver({ timeSource: () => clock });
    // Event handlers run as tasks, so the observer needs a task manager.
    await observer.setup(new TaskManager());
    events = [];
    watch(observer);
  });

  /** Advance the clock without sleeping. */
  function wait(seconds: number): void {
    clock += seconds;
  }

  async function settle(): Promise<void> {
    await sleep(0.01);
  }

  /** Feed one frame to the observer, as a pipeline push would. */
  async function push(
    frame: Frame,
    options: { observer?: FunctionCallObserver; direction?: FrameDirection } = {},
  ): Promise<void> {
    await (options.observer ?? observer).onPushFrame(
      new FramePushed({
        source: new IdentityFilter({ name: "source" }),
        destination: new IdentityFilter({ name: "destination" }),
        frame,
        direction: options.direction ?? FrameDirection.DOWNSTREAM,
        timestamp: 0,
      }),
    );
    await settle();
  }

  function inProgress(
    kwargs: Partial<FunctionCallInProgressFrameOptions> = {},
  ): FunctionCallInProgressFrame {
    return new FunctionCallInProgressFrame({
      functionName: "get_weather",
      toolCallId: "call_1",
      arguments: { city: "SF" },
      cancelOnInterruption: true,
      groupId: "group_1",
      ...kwargs,
    });
  }

  function result(kwargs: Partial<FunctionCallResultFrameOptions> = {}): FunctionCallResultFrame {
    return new FunctionCallResultFrame({
      functionName: "get_weather",
      toolCallId: "call_1",
      arguments: { city: "SF" },
      result: { temperature: 12 },
      ...kwargs,
    });
  }

  function started(...calls: [string, string][]): FunctionCallsStartedFrame {
    return new FunctionCallsStartedFrame({
      functionCalls: calls.map(
        ([name, toolCallId]) =>
          new FunctionCallFromLLM({
            functionName: name,
            toolCallId,
            arguments: { city: "SF" },
            context: null,
          }),
      ),
    });
  }

  test("test_a_call_is_reported_when_its_execution_starts", async () => {
    await push(started(["get_weather", "call_1"]));

    expect(events.length).toBe(1);
    const [event] = events as [FunctionCallEvent];
    expect(event.kind).toEqual(FunctionCallEventKind.STARTED);
    expect(event.functionName).toEqual("get_weather");
    expect(event.toolCallId).toEqual("call_1");
    expect(event.arguments).toEqual({ city: "SF" });
  });

  test("test_every_call_in_an_llm_response_is_its_own_moment", async () => {
    await push(started(["get_weather", "call_1"], ["get_time", "call_2"]));

    expect(events.map((event) => [event.kind, event.toolCallId])).toEqual([
      [FunctionCallEventKind.STARTED, "call_1"],
      [FunctionCallEventKind.STARTED, "call_2"],
    ]);
  });

  test("test_a_call_that_goes_in_progress_names_when_it_started", async () => {
    // Calls run one at a time by default, so a call can wait to run.
    await push(started(["get_weather", "call_1"]));
    wait(0.9);
    await push(inProgress());

    expect(events.length).toBe(2);
    const [, inProgressEvent] = events as [FunctionCallEvent, FunctionCallEvent];
    expect(inProgressEvent.timestamp - inProgressEvent.startedAt!).toBeCloseTo(0.9, 6);
  });

  test("test_a_call_that_never_runs_is_left_where_it_stopped", async () => {
    // A call still waiting when the conversation moves on runs no further.
    await push(started(["get_weather", "call_1"]));

    expect(events.length).toBe(1);
    const [event] = events as [FunctionCallEvent];
    expect(event.kind).toEqual(FunctionCallEventKind.STARTED);
  });

  test("test_a_call_describes_itself_when_it_goes_in_progress", async () => {
    await push(inProgress());

    expect(events.length).toBe(1);
    const [event] = events as [FunctionCallEvent];
    expect(event.kind).toEqual(FunctionCallEventKind.IN_PROGRESS);
    expect(event.functionName).toEqual("get_weather");
    expect(event.toolCallId).toEqual("call_1");
    expect(event.groupId).toEqual("group_1");
    expect(event.arguments).toEqual({ city: "SF" });
    expect(event.timestamp).toEqual(1_000_000.0);
  });

  test("test_a_call_that_settles_names_when_it_began_running", async () => {
    // So the time a call ran reads from the record that ends it.
    await push(inProgress());
    wait(1.4);
    await push(result());

    expect(events.length).toBe(2);
    const [, settled] = events as [FunctionCallEvent, FunctionCallEvent];
    expect(settled.kind).toEqual(FunctionCallEventKind.COMPLETED);
    expect(settled.timestamp - settled.inProgressAt!).toBeCloseTo(1.4, 6);
  });

  test("test_a_call_the_conversation_waits_on_is_marked_blocking", async () => {
    await push(inProgress());
    await push(inProgress({ toolCallId: "call_2", cancelOnInterruption: false }));

    expect(events.length).toBe(2);
    const [blocking, nonBlocking] = events as [FunctionCallEvent, FunctionCallEvent];
    expect(blocking.blocking).toBe(true);
    expect(nonBlocking.blocking).toBe(false);
  });

  test("test_a_handler_that_raised_is_reported_as_a_failure", async () => {
    await push(inProgress());
    await push(result({ error: "RuntimeError: the API is down" }));

    expect(events.length).toBe(2);
    const [, settled] = events as [FunctionCallEvent, FunctionCallEvent];
    expect(settled.kind).toEqual(FunctionCallEventKind.FAILED);
    expect(settled.error).toEqual("RuntimeError: the API is down");
  });

  test("test_a_deadline_and_an_interruption_settle_a_call_differently", async () => {
    // Only a call cancelled by its own deadline asks for inference.
    await push(inProgress());
    await push(
      new FunctionCallCancelFrame({
        functionName: "get_weather",
        toolCallId: "call_1",
        runLlm: true,
      }),
    );
    await push(inProgress({ toolCallId: "call_2" }));
    await push(new FunctionCallCancelFrame({ functionName: "get_weather", toolCallId: "call_2" }));

    expect(events.filter((_, i) => i % 2 === 1).map((event) => event.kind)).toEqual([
      FunctionCallEventKind.TIMED_OUT,
      FunctionCallEventKind.CANCELLED,
    ]);
  });

  test("test_progress_reported_along_the_way_does_not_settle_a_call", async () => {
    // A call that doesn't block can report before it is done.
    await push(inProgress({ cancelOnInterruption: false }));
    await push(
      result({
        result: "still looking",
        properties: new FunctionCallResultProperties({ isFinal: false }),
      }),
    );
    await push(result());

    expect(events.map((event) => event.kind)).toEqual([
      FunctionCallEventKind.IN_PROGRESS,
      FunctionCallEventKind.COMPLETED,
    ]);
  });

  test("test_results_travel_only_when_they_are_asked_for", async () => {
    // They hold whatever a provider decided to return.
    await push(result());

    expect(events.length).toBe(1);
    const [defaultEvent] = events as [FunctionCallEvent];
    expect(defaultEvent.result).toBeNull();

    const reportingResults = new FunctionCallObserver({
      includeResults: true,
      timeSource: () => clock,
    });
    await reportingResults.setup(new TaskManager());
    watch(reportingResults);
    await push(result(), { observer: reportingResults });

    expect(events[events.length - 1]!.result).toEqual({ temperature: 12 });
  });

  test("test_arguments_can_be_left_out", async () => {
    const notReportingArguments = new FunctionCallObserver({
      includeArguments: false,
      timeSource: () => clock,
    });
    await notReportingArguments.setup(new TaskManager());
    watch(notReportingArguments);

    await push(inProgress(), { observer: notReportingArguments });

    expect(events.length).toBe(1);
    const [event] = events as [FunctionCallEvent];
    expect(event.functionName).toEqual("get_weather");
    expect(event.arguments).toBeNull();
  });

  test("test_a_call_that_began_before_the_observer_settles_without_that_moment", async () => {
    await push(result());

    expect(events.length).toBe(1);
    const [event] = events as [FunctionCallEvent];
    expect(event.kind).toEqual(FunctionCallEventKind.COMPLETED);
    expect(event.inProgressAt).toBeNull();
  });

  test("test_a_broadcast_moment_is_reported_once", async () => {
    // Broadcast frames arrive twice, with two IDs.
    const frame = inProgress();
    const sibling = inProgress();
    frame.broadcastSiblingId = sibling.id;
    sibling.broadcastSiblingId = frame.id;

    await push(frame);
    await push(sibling, { direction: FrameDirection.UPSTREAM });

    expect(events.length).toBe(1);
  });

  test("test_frames_from_elsewhere_in_the_pipeline_are_ignored", async () => {
    await push(new TextFrame({ text: "hello" }));

    expect(events).toEqual([]);
  });
});
