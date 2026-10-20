// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_bus.py

import { describe, expect, test } from "bun:test";
import { Event, sleep, waitFor } from "@pipedog/asyncio";
import {
  AsyncQueueBus,
  BusCancelMessage,
  BusCancelWorkerMessage,
  BusDataMessage,
  BusJobCancelMessage,
  type BusMessage,
  BusSubscriber,
} from "../src/bus/index.ts";
import { TaskManager } from "../src/utils/asyncio/task_manager.ts";

/** Create an AsyncQueueBus with a TaskManager for testing. */
async function createTestBus(): Promise<[AsyncQueueBus, TaskManager]> {
  const bus = new AsyncQueueBus();
  const tm = new TaskManager();
  await bus.setup(tm);
  return [bus, tm];
}

/** Plain base for the subscribers below (Python subclasses `BusSubscriber` directly). */
class PlainBase {}

let collectorCounter = 0;

/** Subscriber that collects messages into a list. */
class _CollectorSub extends BusSubscriber(PlainBase) {
  #name: string;
  received: BusMessage[] = [];

  constructor() {
    super();
    this.#name = `collector_${collectorCounter++}`;
  }

  get name(): string {
    return this.#name;
  }

  override async onBusMessage(message: BusMessage): Promise<void> {
    this.received.push(message);
  }
}

describe("TestAsyncQueueBus", () => {
  test("test_send_delivers_to_subscriber", async () => {
    // send() delivers a message to a subscriber.
    const [bus] = await createTestBus();
    const sub = new _CollectorSub();
    await bus.subscribe(sub);
    await bus.start();

    const msg = new BusDataMessage({ source: "task_a" });
    await bus.send(msg);
    await sleep(0.05);
    await bus.stop();

    expect(sub.received.length).toEqual(1);
    expect(sub.received[0]).toBe(msg);
  });

  test("test_multiple_messages_in_order", async () => {
    // Messages are dispatched in FIFO order.
    const [bus] = await createTestBus();
    const sub = new _CollectorSub();
    await bus.subscribe(sub);
    await bus.start();

    const msgs = Array.from({ length: 5 }, (_, i) => new BusDataMessage({ source: `task_${i}` }));
    for (const m of msgs) {
      await bus.send(m);
    }
    await sleep(0.1);
    await bus.stop();

    expect(sub.received.length).toEqual(5);
    msgs.forEach((sent, i) => {
      expect(sub.received[i]).toBe(sent);
    });
  });

  test("test_start_stop_lifecycle", async () => {
    // start() begins dispatch tasks, stop() cancels them cleanly.
    const [bus] = await createTestBus();
    const sub = new _CollectorSub();
    await bus.subscribe(sub);
    await bus.start();

    await bus.send(new BusDataMessage({ source: "a" }));
    await sleep(0.05);
    expect(sub.received.length).toEqual(1);

    await bus.stop();

    await bus.send(new BusDataMessage({ source: "b" }));
    await sleep(0.05);
    // After stop, messages are not dispatched
    expect(sub.received.length).toEqual(1);
  });
});

describe("TestBusSubscriber", () => {
  test("test_subscribe_calls_on_bus_message", async () => {
    // subscribe() delivers messages to subscriber's on_bus_message.
    const [bus] = await createTestBus();
    const sub = new _CollectorSub();
    await bus.subscribe(sub);
    await bus.start();

    const msg = new BusDataMessage({ source: "task_a" });
    await bus.send(msg);
    await sleep(0.05);
    await bus.stop();

    expect(sub.received.length).toEqual(1);
    expect(sub.received[0]).toBe(msg);
  });

  test("test_multiple_subscribers_independent", async () => {
    // Two subscribers each get every message on their own task.
    const [bus] = await createTestBus();
    const sub1 = new _CollectorSub();
    const sub2 = new _CollectorSub();
    await bus.subscribe(sub1);
    await bus.subscribe(sub2);
    await bus.start();

    const msg = new BusDataMessage({ source: "task_a" });
    await bus.send(msg);
    await sleep(0.05);
    await bus.stop();

    expect(sub1.received.length).toEqual(1);
    expect(sub2.received.length).toEqual(1);
    expect(sub1.received[0]).toBe(msg);
    expect(sub2.received[0]).toBe(msg);
  });

  test("test_unsubscribe_stops_delivery", async () => {
    // unsubscribe() prevents further message delivery.
    const [bus] = await createTestBus();
    const sub = new _CollectorSub();
    await bus.subscribe(sub);
    await bus.start();

    await bus.send(new BusDataMessage({ source: "a" }));
    await sleep(0.05);
    expect(sub.received.length).toEqual(1);

    await bus.unsubscribe(sub);
    await bus.send(new BusDataMessage({ source: "b" }));
    await sleep(0.05);
    await bus.stop();

    expect(sub.received.length).toEqual(1);
  });

  test("test_slow_subscriber_does_not_block_others", async () => {
    // A slow subscriber does not block a fast subscriber.
    const [bus] = await createTestBus();
    const fastReceived: BusMessage[] = [];
    const fastDone = new Event();

    class SlowSub extends BusSubscriber(PlainBase) {
      get name(): string {
        return "slow";
      }

      override async onBusMessage(_message: BusMessage): Promise<void> {
        await sleep(0.5);
      }
    }

    class FastSub extends BusSubscriber(PlainBase) {
      get name(): string {
        return "fast";
      }

      override async onBusMessage(message: BusMessage): Promise<void> {
        fastReceived.push(message);
        fastDone.set();
      }
    }

    await bus.subscribe(new SlowSub());
    await bus.subscribe(new FastSub());
    await bus.start();

    await bus.send(new BusDataMessage({ source: "a" }));
    await waitFor(() => fastDone.wait(), 0.1);
    await bus.stop();

    expect(fastReceived.length).toEqual(1);
  });
});

describe("TestBusMessagePriority", () => {
  test("test_system_message_preempts_data_messages", async () => {
    // System messages are delivered before data messages queued earlier.
    const [bus] = await createTestBus();
    const sub = new _CollectorSub();
    await bus.subscribe(sub);

    // Queue messages before starting dispatch
    for (let i = 0; i < 5; i++) {
      await bus.send(new BusDataMessage({ source: `data_${i}` }));
    }
    await bus.send(new BusCancelMessage({ source: "runner", reason: "urgent" }));

    await bus.start();
    await sleep(0.1);
    await bus.stop();

    // System message should be first
    expect(sub.received[0]).toBeInstanceOf(BusCancelMessage);
    expect(sub.received[0]?.source).toEqual("runner");
  });

  test("test_data_messages_preserve_fifo_order", async () => {
    // Data messages maintain FIFO order among themselves.
    const [bus] = await createTestBus();
    const sub = new _CollectorSub();
    await bus.subscribe(sub);
    await bus.start();

    for (let i = 0; i < 5; i++) {
      await bus.send(new BusDataMessage({ source: `task_${i}` }));
    }
    await sleep(0.1);
    await bus.stop();

    const sources = sub.received.map((m) => m.source);
    expect(sources).toEqual(Array.from({ length: 5 }, (_, i) => `task_${i}`));
  });

  test("test_system_messages_preserve_fifo_order", async () => {
    // Multiple system messages maintain FIFO order among themselves.
    const [bus] = await createTestBus();
    const sub = new _CollectorSub();
    await bus.subscribe(sub);
    await bus.start();

    await bus.send(new BusCancelMessage({ source: "first", reason: "a" }));
    await bus.send(new BusCancelMessage({ source: "second", reason: "b" }));
    await sleep(0.1);
    await bus.stop();

    expect(sub.received[0]?.source).toEqual("first");
    expect(sub.received[1]?.source).toEqual("second");
  });

  test("test_mixed_messages_system_first", async () => {
    // When data and system messages are queued, all system come first.
    const [bus] = await createTestBus();
    const sub = new _CollectorSub();
    await bus.subscribe(sub);

    // Queue before starting so all messages are pending
    await bus.send(new BusDataMessage({ source: "data_1" }));
    await bus.send(new BusDataMessage({ source: "data_2" }));
    await bus.send(new BusCancelMessage({ source: "cancel_1" }));
    await bus.send(new BusDataMessage({ source: "data_3" }));
    await bus.send(new BusCancelWorkerMessage({ source: "cancel_2", target: "task" }));

    await bus.start();
    await sleep(0.1);
    await bus.stop();

    const sources = sub.received.map((m) => m.source);
    expect(sources).toEqual(["cancel_1", "cancel_2", "data_1", "data_2", "data_3"]);
  });

  test("test_task_cancel_is_system_priority", async () => {
    // BusJobCancelMessage has system priority.
    const [bus] = await createTestBus();
    const sub = new _CollectorSub();
    await bus.subscribe(sub);

    await bus.send(new BusDataMessage({ source: "data" }));
    await bus.send(new BusJobCancelMessage({ source: "parent", target: "worker", jobId: "t1" }));

    await bus.start();
    await sleep(0.1);
    await bus.stop();

    expect(sub.received[0]).toBeInstanceOf(BusJobCancelMessage);
  });
});

let failingCounter = 0;

/**
 * Subscriber that raises on its first message, then records the rest.
 *
 * Models a subscriber whose lifecycle hook (e.g. `on_job_response`) throws:
 * the bus dispatch task must survive so later messages are still delivered.
 */
class _FailingSub extends BusSubscriber(PlainBase) {
  #name: string;
  received: BusMessage[] = [];
  #raised = false;

  constructor() {
    super();
    this.#name = `failing_${failingCounter++}`;
  }

  get name(): string {
    return this.#name;
  }

  override async onBusMessage(message: BusMessage): Promise<void> {
    if (!this.#raised) {
      this.#raised = true;
      throw new Error("simulated subscriber failure");
    }
    this.received.push(message);
  }
}

/** A subscriber exception must not stop future delivery to that subscriber. */
describe("TestSubscriberException", () => {
  test("test_data_dispatch_survives_subscriber_exception", async () => {
    // A raise in on_bus_message must not tear down the data dispatch task.
    const [bus] = await createTestBus();
    const sub = new _FailingSub();
    await bus.subscribe(sub);
    await bus.start();

    // First data message raises inside _data_dispatch_task.
    await bus.send(new BusDataMessage({ source: "first" }));
    await sleep(0.05);
    // Second data message must still be delivered (was lost before the fix).
    await bus.send(new BusDataMessage({ source: "second" }));
    await sleep(0.05);
    await bus.stop();

    expect(sub.received.map((m) => m.source)).toEqual(["second"]);
  });

  test("test_router_survives_subscriber_exception_on_system_message", async () => {
    // A raise on a system message must not tear down the router task.
    const [bus] = await createTestBus();
    const sub = new _FailingSub();
    await bus.subscribe(sub);
    await bus.start();

    // First system message raises inline inside _router_task.
    await bus.send(new BusCancelMessage({ source: "first" }));
    await sleep(0.05);
    // Second system message must still be delivered (was lost before the fix).
    await bus.send(new BusCancelMessage({ source: "second" }));
    await sleep(0.05);
    await bus.stop();

    expect(sub.received.map((m) => m.source)).toEqual(["second"]);
  });
});
