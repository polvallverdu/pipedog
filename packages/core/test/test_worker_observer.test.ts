// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipecat-ts contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_worker_observer.py

/** Tests for how WorkerObserver hands pushes to the observers it manages. */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Event, gather, waitFor } from "@pipecat-ts/asyncio";
import { type Frame, TextFrame } from "../src/frames/frames.ts";
import {
  BaseObserver,
  type BaseObserverOptions,
  FramePushed,
} from "../src/observers/base_observer.ts";
import { Pipeline } from "../src/pipeline/pipeline.ts";
import { WorkerObserver } from "../src/pipeline/worker_observer.ts";
import { IdentityFilter } from "../src/processors/filters/identity_filter.ts";
import { FrameDirection } from "../src/processors/frame_processor.ts";
import { runTest, SleepFrame } from "../src/tests/utils.ts";
import { TaskManager } from "../src/utils/asyncio/task_manager.ts";

/** Test access to WorkerObserver's protected state, as the Python test reads `_proxies`. */
const internals = (w: WorkerObserver): any => w;

/** Wait for every proxy queue to be drained. */
async function joinProxies(workerObserver: WorkerObserver): Promise<void> {
  const proxies = [...internals(workerObserver)._proxies.values()];
  await gather(...proxies.map((proxy: any) => () => proxy.queue.join()));
}

/** Records every push of a text frame it is told about. */
class RecordingObserver extends BaseObserver {
  pushes: [string, boolean][] = [];

  constructor(options: BaseObserverOptions = {}) {
    super(options);
  }

  override async onPushFrame(data: FramePushed): Promise<void> {
    if (data.frame instanceof TextFrame) {
      this.pushes.push([data.source.name, data.firstPush]);
    }
  }
}

/** A frame is pushed again by every processor that passes it along. */
describe("TestWorkerObserverInAPipeline", () => {
  async function run(...observers: BaseObserver[]): Promise<void> {
    const pipeline = new Pipeline([
      new IdentityFilter({ name: "first" }),
      new IdentityFilter({ name: "second" }),
      new IdentityFilter({ name: "third" }),
    ]);
    await runTest(pipeline, {
      framesToSend: [new TextFrame({ text: "hello" }), new SleepFrame({ sleep: 0.1 })],
      expectedDownFrames: [TextFrame],
      observers,
    });
  }

  test("test_an_observer_that_handles_a_frame_once_is_told_once", async () => {
    const observer = new RecordingObserver({ observeEveryPush: false });
    await run(observer);
    expect(observer.pushes.length).toEqual(1);
    expect(observer.pushes[0]?.[1]).toBe(true);
  });

  test("test_an_observer_gets_every_hop_by_default", async () => {
    const observer = new RecordingObserver();
    await run(observer);
    const sources = observer.pushes.map(([source]) => source);
    for (const name of ["first", "second", "third"]) {
      expect(sources).toContain(name);
    }
    // Only the first push is marked as such.
    const firsts = observer.pushes.map(([, first]) => first);
    expect(firsts).toEqual([true, ...Array(firsts.length - 1).fill(false)]);
  });
});

describe("TestWorkerObserverMemory", () => {
  test("test_first_observer_can_be_added_after_setup", async () => {
    const workerObserver = new WorkerObserver();
    await workerObserver.setup(new TaskManager());
    try {
      const observer = new RecordingObserver();
      workerObserver.addObserver(observer);
      const source = new IdentityFilter({ name: "source" });

      await workerObserver.onPushFrame(
        new FramePushed({
          source,
          destination: source,
          frame: new TextFrame({ text: "hello" }),
          direction: FrameDirection.DOWNSTREAM,
          timestamp: 0,
        }),
      );
      await joinProxies(workerObserver);
      expect(observer.pushes).toEqual([["source", true]]);
    } finally {
      await workerObserver.cleanup();
    }
  });

  test("test_a_frame_is_forgotten_once_the_pipeline_lets_go_of_it", async () => {
    const observer = new RecordingObserver();
    const workerObserver = new WorkerObserver({ observers: [observer] });
    await workerObserver.setup(new TaskManager());
    const source = new IdentityFilter({ name: "source" });

    async function push(frame: Frame): Promise<void> {
      await workerObserver.onPushFrame(
        new FramePushed({
          source,
          destination: source,
          frame,
          direction: FrameDirection.DOWNSTREAM,
          timestamp: 0,
        }),
      );
    }

    for (let i = 0; i < 10; i++) {
      await push(new TextFrame({ text: "hello" }));
    }
    expect(internals(workerObserver)._framesPushed.size).toEqual(10);

    // The proxy holds on to the last push it handled, so end with a frame
    // the test keeps and wait for it to be handed over.
    const kept = new TextFrame({ text: "kept" });
    await push(kept);
    await joinProxies(workerObserver);
    // A weak reference read in a job stays alive until that job ends, so
    // collect from a fresh one.
    await new Promise((resolve) => setTimeout(resolve, 0));
    Bun.gc(true);

    expect([...internals(workerObserver)._framesPushed.values()]).toEqual([kept]);
    expect(observer.pushes.length).toEqual(11);

    await workerObserver.cleanup();
  });
});

/** Records its cleanup and fires an event for every text frame. */
class CleanupRecordingObserver extends BaseObserver {
  cleanedUp = false;

  constructor(options: BaseObserverOptions = {}) {
    super(options);
    this._registerEventHandler("on_text");
  }

  override async onPushFrame(data: FramePushed): Promise<void> {
    if (data.frame instanceof TextFrame) {
      await this._callEventHandler("on_text");
    }
  }

  override async cleanup(): Promise<void> {
    await super.cleanup();
    this.cleanedUp = true;
  }
}

describe("TestWorkerObserverRemoval", () => {
  let observer: CleanupRecordingObserver;
  let workerObserver: WorkerObserver;

  beforeEach(async () => {
    observer = new CleanupRecordingObserver();
    workerObserver = new WorkerObserver({ observers: [observer] });
    await workerObserver.setup(new TaskManager());
  });

  afterEach(async () => {
    await workerObserver.cleanup();
  });

  async function pushText(): Promise<void> {
    const source = new IdentityFilter();
    await workerObserver.onPushFrame(
      new FramePushed({
        source,
        destination: source,
        frame: new TextFrame({ text: "hello" }),
        direction: FrameDirection.DOWNSTREAM,
        timestamp: 0,
      }),
    );
  }

  test("test_a_removed_observer_is_cleaned_up", async () => {
    await workerObserver.removeObserver(observer);
    expect(observer.cleanedUp).toBe(true);
  });

  test("test_an_observer_can_be_removed_from_its_own_event_handler", async () => {
    const removed = new Event();

    observer.eventHandler("on_text", async (o: BaseObserver) => {
      await workerObserver.removeObserver(o);
      removed.set();
    });

    await pushText();
    await waitFor(() => removed.wait(), 1.0);
    expect(observer.cleanedUp).toBe(true);
  });
});

class FailingCleanupObserver extends BaseObserver {
  override async cleanup(): Promise<void> {
    await super.cleanup();
    throw new Error("cleanup failed");
  }
}

describe("TestWorkerObserverShutdown", () => {
  test("test_an_observer_failing_cleanup_does_not_stop_the_others", async () => {
    const later = new CleanupRecordingObserver();
    const workerObserver = new WorkerObserver({
      observers: [new FailingCleanupObserver(), later],
    });
    await workerObserver.setup(new TaskManager());

    await workerObserver.cleanup();

    expect(later.cleanedUp).toBe(true);
  });
});
