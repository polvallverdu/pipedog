// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_messages.py

import { describe, expect, test } from "bun:test";
import { sleep } from "@pipedog/asyncio";
import {
  AsyncQueueBus,
  BusDataMessage,
  BusFrameMessage,
  type BusMessage,
  BusSubscriber,
} from "../src/bus/index.ts";
import { TextFrame } from "../src/frames/frames.ts";
import { FrameDirection } from "../src/processors/frame_processor.ts";
import { TaskManager } from "../src/utils/asyncio/task_manager.ts";

/** Plain base for the subscribers below (Python subclasses `BusSubscriber` directly). */
class PlainBase {}

describe("TestBusMessageRouting", () => {
  test("test_broadcast_message_no_target", async () => {
    // A BusMessage with no target is broadcast (target is None).
    const msg = new BusDataMessage({ source: "task_a" });
    expect(msg.target).toBeNull();
  });

  test("test_targeted_message", async () => {
    // A BusMessage with target set is only for that task.
    const msg = new BusDataMessage({ source: "task_a", target: "task_b" });
    expect(msg.target).toEqual("task_b");
  });

  test("test_broadcast_reaches_all_subscribers", async () => {
    // Broadcast messages (no target) reach all subscribers.
    const bus = new AsyncQueueBus();
    const tm = new TaskManager();
    await bus.setup(tm);
    const receivedA: BusMessage[] = [];
    const receivedB: BusMessage[] = [];

    class SubA extends BusSubscriber(PlainBase) {
      get name(): string {
        return "sub_a";
      }

      override async onBusMessage(message: BusMessage): Promise<void> {
        receivedA.push(message);
      }
    }

    class SubB extends BusSubscriber(PlainBase) {
      get name(): string {
        return "sub_b";
      }

      override async onBusMessage(message: BusMessage): Promise<void> {
        receivedB.push(message);
      }
    }

    await bus.subscribe(new SubA());
    await bus.subscribe(new SubB());

    await bus.start();
    const msg = new BusDataMessage({ source: "task_x" }); // no target
    await bus.send(msg);
    await sleep(0.05);
    await bus.stop();

    // Both subscribers see the broadcast
    expect(receivedA.length).toEqual(1);
    expect(receivedB.length).toEqual(1);
  });

  test("test_bus_frame_message_wraps_frame", async () => {
    // BusFrameMessage wraps a frame with source and direction.
    const frame = new TextFrame({ text: "hello" });
    const msg = new BusFrameMessage({
      source: "task_a",
      frame,
      direction: FrameDirection.DOWNSTREAM,
    });
    expect(msg.frame).toBe(frame);
    expect(msg.direction).toEqual(FrameDirection.DOWNSTREAM);
    expect(msg.source).toEqual("task_a");
    expect(msg.target).toBeNull();
  });

  test("test_bus_frame_message_with_target", async () => {
    // BusFrameMessage can carry a target for directed delivery.
    const frame = new TextFrame({ text: "hello" });
    const msg = new BusFrameMessage({
      source: "task_a",
      target: "task_b",
      frame,
      direction: FrameDirection.DOWNSTREAM,
    });
    expect(msg.target).toEqual("task_b");
    expect(msg.frame).toBe(frame);
  });
});
