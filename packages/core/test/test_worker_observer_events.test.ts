// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Which events WorkerObserver queues for an observer: not in upstream, which
 * queues every event for every observer (see `onProcessFrame` and
 * `BaseObserver.acceptsPush`).
 */

import { describe, expect, test } from "bun:test";
import { gather } from "@pipedog/asyncio";
import { AggregatedTextFrame, TextFrame } from "../src/frames/frames.ts";
import { BaseObserver, FrameProcessed, FramePushed } from "../src/observers/base_observer.ts";
import { WorkerObserver } from "../src/pipeline/worker_observer.ts";
import { IdentityFilter } from "../src/processors/filters/identity_filter.ts";
import { FrameDirection } from "../src/processors/frame_processor.ts";
import { RTVIObserver } from "../src/processors/frameworks/rtvi/observer.ts";
import { TaskManager } from "../src/utils/asyncio/task_manager.ts";

const internals = (w: WorkerObserver): any => w;

async function joinProxies(workerObserver: WorkerObserver): Promise<void> {
  const proxies = [...internals(workerObserver)._proxies.values()];
  await gather(...proxies.map((proxy: any) => () => proxy.queue.join()));
}

const source = new IdentityFilter({ name: "source" });

function pushed(frame = new TextFrame({ text: "hello" })): FramePushed {
  return new FramePushed({
    source,
    destination: source,
    frame,
    direction: FrameDirection.DOWNSTREAM,
    timestamp: 0,
  });
}

function processed(): FrameProcessed {
  return new FrameProcessed({
    processor: source,
    frame: new TextFrame({ text: "hello" }),
    direction: FrameDirection.DOWNSTREAM,
    timestamp: 0,
  });
}

/** Counts the events it is handed. */
class CountingObserver extends BaseObserver {
  processed = 0;
  pushes = 0;

  override async onProcessFrame(_data: FrameProcessed): Promise<void> {
    this.processed++;
  }

  override async onPushFrame(_data: FramePushed): Promise<void> {
    this.pushes++;
  }
}

/** Only watches pushes, like the worker's default observers. */
class PushOnlyObserver extends BaseObserver {
  pushes = 0;

  override async onPushFrame(_data: FramePushed): Promise<void> {
    this.pushes++;
  }
}

async function withWorkerObserver(
  observers: BaseObserver[],
  body: (w: WorkerObserver) => Promise<void>,
): Promise<void> {
  const workerObserver = new WorkerObserver({ observers });
  await workerObserver.setup(new TaskManager());
  try {
    await body(workerObserver);
  } finally {
    await workerObserver.cleanup();
  }
}

describe("WorkerObserver: which events are queued", () => {
  test("a processed frame reaches only the observers that handle onProcessFrame", async () => {
    const counting = new CountingObserver();
    const pushOnly = new PushOnlyObserver();
    await withWorkerObserver([counting, pushOnly], async (w) => {
      const proxies = internals(w)._proxies;
      await w.onProcessFrame(processed());
      // Put on an unbounded queue doesn't yield, so the queues show it at once.
      expect(proxies.get(counting).queue.qsize()).toBe(1);
      expect(proxies.get(pushOnly).queue.qsize()).toBe(0);
      await joinProxies(w);
      expect(counting.processed).toBe(1);
    });
  });

  test("a push an observer doesn't accept is not queued for it", async () => {
    class Picky extends CountingObserver {
      override acceptsPush(data: FramePushed): boolean {
        return data.frame instanceof AggregatedTextFrame;
      }
    }
    const picky = new Picky();
    const counting = new CountingObserver();
    await withWorkerObserver([picky, counting], async (w) => {
      await w.onPushFrame(pushed());
      await w.onPushFrame(pushed(new AggregatedTextFrame({ text: "hi", aggregatedBy: "word" })));
      await joinProxies(w);
      expect(picky.pushes).toBe(1);
      expect(counting.pushes).toBe(2);
    });
  });
});

describe("RTVIObserver.acceptsPush", () => {
  const first = () => {
    const data = pushed();
    data.firstPush = true;
    return data;
  };
  const again = (frame = new TextFrame({ text: "hello" })) => {
    const data = pushed(frame);
    data.firstPush = false;
    return data;
  };

  test("takes a frame's first push, and aggregated text on every push", () => {
    const observer = new RTVIObserver();
    expect(observer.acceptsPush(first())).toBe(true);
    expect(observer.acceptsPush(again())).toBe(false);
    expect(
      observer.acceptsPush(again(new AggregatedTextFrame({ text: "hi", aggregatedBy: "word" }))),
    ).toBe(true);
  });

  test("a subclass that overrides onPushFrame gets every push", () => {
    class Custom extends RTVIObserver {
      override async onPushFrame(data: FramePushed): Promise<void> {
        await super.onPushFrame(data);
      }
    }
    expect(new Custom().acceptsPush(again())).toBe(true);
  });
});
