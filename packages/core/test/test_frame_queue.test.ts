// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipecat-ts contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_frame_queue.py

/** The frame queue reads a frame's `interruptible` flag as it is. */

import { describe, expect, test } from "bun:test";
import { waitFor } from "@pipecat-ts/asyncio";
import { EndFrame, type Frame, TextFrame } from "../src/frames/frames.ts";
import { FramePriorityQueue, FrameQueue } from "../src/utils/frame_queue.ts";

describe("TestFrameQueueInterruptibility", () => {
  test("test_a_flag_set_on_a_queued_frame_is_respected", () => {
    const queue = new FrameQueue();
    const frame = new TextFrame({ text: "hi" });
    queue.putNowait(frame);
    expect(queue.hasUninterruptible).toBe(false);

    frame.interruptible = false;
    expect(queue.hasUninterruptible).toBe(true);
    queue.getNowait();
    expect(queue.hasUninterruptible).toBe(false);

    const end = new EndFrame();
    queue.putNowait(end);
    expect(queue.hasUninterruptible).toBe(true);
    end.interruptible = true;
    expect(queue.hasUninterruptible).toBe(false);
  });

  test("test_reset_keeps_what_is_uninterruptible_now", () => {
    const queue = new FrameQueue();
    const plain = new TextFrame({ text: "hi" });
    const end = new EndFrame();
    queue.putNowait(plain);
    queue.putNowait(end);
    plain.interruptible = false;
    end.interruptible = true;

    queue.reset();

    expect(queue.qsize()).toEqual(1);
    expect(queue.getNowait()).toBe(plain);
    expect(queue.hasUninterruptible).toBe(false);
  });

  test("test_has_frame_and_tuple_items", () => {
    const queue = new FrameQueue<[Frame, string]>((item) => item[0]);
    queue.putNowait([new TextFrame({ text: "hi" }), "down"]);
    queue.putNowait([new EndFrame(), "down"]);
    expect(queue.hasFrame(TextFrame)).toBe(true);
    expect(queue.hasUninterruptible).toBe(true);
    queue.reset();
    expect(queue.hasFrame(TextFrame)).toBe(false);
    expect(queue.hasFrame(EndFrame)).toBe(true);
    expect(queue.getNowait()[1]).toEqual("down");
  });
});

describe("TestFramePriorityQueue", () => {
  test("test_reset_preserves_priority_order_and_join", async () => {
    const queue = new FramePriorityQueue<[number, number, Frame]>((item) => item[2]);
    const frames = [0, 1, 2, 3].map((i) => new TextFrame({ text: String(i) }));
    for (const frame of frames.slice(0, 3)) {
      frame.interruptible = false;
    }
    for (const [priority, sequence, frame] of [
      [2, 0, frames[0]],
      [1, 2, frames[2]],
      [1, 1, frames[1]],
      [0, 3, frames[3]],
    ] as [number, number, TextFrame][]) {
      queue.putNowait([priority, sequence, frame]);
    }

    queue.reset();

    for (const frame of [frames[1], frames[2], frames[0]]) {
      expect(queue.hasUninterruptible).toBe(true);
      expect(queue.getNowait()[2]).toBe(frame as TextFrame);
      queue.taskDone();
    }
    expect(queue.hasUninterruptible).toBe(false);
    await waitFor(() => queue.join(), 1);
  });
});
