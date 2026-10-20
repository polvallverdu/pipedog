// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipecat-ts contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_error_observer.py

import { beforeEach, describe, expect, test } from "bun:test";
import { ErrorFrame, type Frame, TextFrame } from "../src/frames/frames.ts";
import { FramePushed } from "../src/observers/base_observer.ts";
import { type ErrorEvent, ErrorObserver } from "../src/observers/error_observer.ts";
import { Pipeline } from "../src/pipeline/pipeline.ts";
import { IdentityFilter } from "../src/processors/filters/identity_filter.ts";
import {
  FrameDirection,
  FrameProcessor,
  type FrameProcessorOptions,
} from "../src/processors/frame_processor.ts";
import { runTest, SleepFrame } from "../src/tests/utils.ts";
import { TaskManager } from "../src/utils/asyncio/task_manager.ts";
import { ErrorCategory } from "../src/utils/errors.ts";

/**
 * Stand-in for Python's builtin `ConnectionError`. JS has no such class; a
 * connection failure is recognised by the error code the runtime attaches.
 */
class ConnectionError extends Error {
  code = "EHOSTUNREACH";
}

/** A processor that fails the way a service does, on being given work. */
class FailingProcessor extends FrameProcessor {
  #exception: Error;
  #category: ErrorCategory | null;

  constructor(
    exception: Error,
    category: ErrorCategory | null = null,
    options: FrameProcessorOptions = {},
  ) {
    super(options);
    this.#exception = exception;
    this.#category = category;
  }

  override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
    await super.processFrame(frame, direction);
    if (frame instanceof TextFrame) {
      await this.pushError("the provider said no", {
        exception: this.#exception,
        category: this.#category,
      });
    } else {
      await this.pushFrame(frame, direction);
    }
  }
}

/** Errors as they are raised, through a running pipeline. */
describe("TestErrorObserverInAPipeline", () => {
  async function errorsFrom(
    exception: Error,
    category: ErrorCategory | null = null,
  ): Promise<ErrorEvent[]> {
    const observer = new ErrorObserver();
    const events: ErrorEvent[] = [];

    observer.eventHandler("on_error", async (_observer: unknown, event: ErrorEvent) => {
      events.push(event);
    });

    const failing = new FailingProcessor(exception, category, { name: "stt" });
    await runTest(new Pipeline([failing]), {
      framesToSend: [new TextFrame({ text: "work" }), new SleepFrame({ sleep: 0.1 })],
      expectedDownFrames: [],
      observers: [observer],
    });
    return events;
  }

  test("test_an_error_is_reported_where_it_is_raised", async () => {
    // Named for the processor that failed, not the ones it travels through.
    const events = await errorsFrom(new ConnectionError("no route to host"));
    expect(events).toHaveLength(1);
    const [event] = events as [ErrorEvent];

    expect(event.processor).toEqual("stt");
    expect(event.message).toEqual("the provider said no");
    expect(event.exceptionType).toEqual("ConnectionError");
    // Worked out from the exception, since the processor named no category.
    expect(event.category).toEqual(ErrorCategory.CONNECTIVITY);
  });

  test("test_a_recoverable_failure_leaves_the_processor_usable", async () => {
    // An unreachable service may well answer the next request.
    const events = await errorsFrom(new ConnectionError("no route to host"));
    expect(events).toHaveLength(1);
    const [event] = events as [ErrorEvent];

    expect(event.processorUsable).toBe(true);
  });

  test("test_a_permanent_failure_costs_the_processor_its_usability", async () => {
    // Rejected credentials stay rejected, so the capability is gone.
    const events = await errorsFrom(new Error("invalid api key"), ErrorCategory.AUTHENTICATION);
    expect(events).toHaveLength(1);
    const [event] = events as [ErrorEvent];

    expect(event.processorUsable).toBe(false);
  });
});

/** What the observer makes of the frames it is shown. */
describe("TestErrorObserver", () => {
  let clock: number;
  let observer: ErrorObserver;
  let events: ErrorEvent[];

  beforeEach(async () => {
    clock = 1_000_000.0;
    observer = new ErrorObserver({ timeSource: () => clock });
    // Event handlers run as tasks, so the observer needs a task manager.
    await observer.setup(new TaskManager());
    events = [];

    observer.eventHandler("on_error", async (_observer: unknown, event: ErrorEvent) => {
      events.push(event);
    });
  });

  async function settle(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  /** Feed one frame to the observer, as a pipeline push would. */
  async function push(frame: Frame, source: FrameProcessor | null = null): Promise<void> {
    await observer.onPushFrame(
      new FramePushed({
        source: source ?? new IdentityFilter({ name: "source" }),
        destination: new IdentityFilter({ name: "destination" }),
        frame,
        direction: FrameDirection.UPSTREAM,
        timestamp: 0,
      }),
    );
    await settle();
  }

  test("test_each_error_is_its_own_event", async () => {
    // A processor that fails twice failed twice.
    const failing = new IdentityFilter({ name: "tts" });

    await push(new ErrorFrame({ error: "first", processor: failing }), failing);
    await push(new ErrorFrame({ error: "second", processor: failing }), failing);

    expect(events.map((event) => event.message)).toEqual(["first", "second"]);
  });

  test("test_an_error_reports_when_it_happened", async () => {
    await push(new ErrorFrame({ error: "failed" }));

    expect(events).toHaveLength(1);
    const [event] = events as [ErrorEvent];
    expect(event.timestamp).toEqual(1_000_000.0);
  });

  test("test_an_error_assembled_by_hand_is_attributed_to_its_pusher", async () => {
    // `pushError` settles both of these; a bare frame carries neither.
    await push(new ErrorFrame({ error: "failed" }), new IdentityFilter({ name: "llm" }));

    expect(events).toHaveLength(1);
    const [event] = events as [ErrorEvent];
    expect(event.processor).toEqual("llm");
    expect(event.category).toEqual(ErrorCategory.UNKNOWN);
    expect(event.exceptionType).toBeNull();
  });

  test("test_frames_that_are_not_errors_are_not_reported", async () => {
    await push(new TextFrame({ text: "hello" }));

    expect(events).toEqual([]);
  });
});
