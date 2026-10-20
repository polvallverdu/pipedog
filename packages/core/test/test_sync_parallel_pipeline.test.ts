// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipecat-ts contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_sync_parallel_pipeline.py

import { describe, expect, test } from "bun:test";
import { sleep } from "@pipecat-ts/asyncio";
import { Frame, TextFrame } from "../src/frames/frames.ts";
import { FrameOrder, SyncParallelPipeline } from "../src/pipeline/sync_parallel_pipeline.ts";
import { IdentityFilter } from "../src/processors/filters/identity_filter.ts";
import {
  type FrameDirection,
  FrameProcessor,
  type FrameProcessorOptions,
} from "../src/processors/frame_processor.ts";
import { runTest } from "../src/tests/utils.ts";

interface TaggedFrameOptions {
  tag?: string;
}

/** A simple tagged frame for testing pipeline ordering. */
class TaggedFrame extends Frame {
  tag: string;

  constructor(options: TaggedFrameOptions = {}) {
    super(options);
    this.tag = options.tag ?? "";
  }

  override toString(): string {
    return `${this.name}(tag: ${this.tag})`;
  }
}

interface EmitTaggedFrameProcessorOptions extends FrameProcessorOptions {
  delay?: number;
}

/**
 * Emits a TaggedFrame for every TextFrame it receives.
 *
 * Used to produce distinguishable output from different pipelines so tests
 * can verify ordering.
 */
class EmitTaggedFrameProcessor extends FrameProcessor {
  #tag: string;
  #delay: number;

  constructor(tag: string, options: EmitTaggedFrameProcessorOptions = {}) {
    super(options);
    this.#tag = tag;
    this.#delay = options.delay ?? 0;
  }

  override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
    await super.processFrame(frame, direction);

    if (frame instanceof TextFrame) {
      if (this.#delay > 0) {
        await sleep(this.#delay);
      }
      await this.pushFrame(new TaggedFrame({ tag: this.#tag }));
    } else {
      await this.pushFrame(frame, direction);
    }
  }
}

describe("TestSyncParallelPipeline", () => {
  test("test_dedup_multiple_frames", async () => {
    // Identical frames from multiple paths should be deduplicated.
    const pipeline = new SyncParallelPipeline([new IdentityFilter()], [new IdentityFilter()]);

    const framesToSend = [new TextFrame({ text: "one" }), new TextFrame({ text: "two" })];
    const expectedDownFrames = [TextFrame, TextFrame];
    await runTest(pipeline, {
      framesToSend,
      expectedDownFrames,
    });
  });

  test("test_arrival_order", async () => {
    // With FrameOrder.ARRIVAL, a slow first pipeline's frames should arrive
    // after a fast second pipeline's frames.
    const pipeline = new SyncParallelPipeline(
      [new EmitTaggedFrameProcessor("slow", { delay: 0.05 })],
      [new EmitTaggedFrameProcessor("fast")],
      { frameOrder: FrameOrder.ARRIVAL },
    );

    const framesToSend = [new TextFrame({ text: "one" }), new TextFrame({ text: "two" })];
    const [downFrames] = await runTest(pipeline, { framesToSend });

    const tags = downFrames.filter((f) => f instanceof TaggedFrame).map((f) => f.tag);
    // Expected fast before slow in each batch.
    expect(tags).toEqual(["fast", "slow", "fast", "slow"]);
  });

  test("test_pipeline_order", async () => {
    // With FrameOrder.PIPELINE and multiple input frames, each batch should
    // follow pipeline definition order regardless of processing speed.
    const pipeline = new SyncParallelPipeline(
      [new EmitTaggedFrameProcessor("slow", { delay: 0.05 })],
      [new EmitTaggedFrameProcessor("fast")],
      { frameOrder: FrameOrder.PIPELINE },
    );

    const framesToSend = [new TextFrame({ text: "one" }), new TextFrame({ text: "two" })];
    const [downFrames] = await runTest(pipeline, { framesToSend });

    const tags = downFrames.filter((f) => f instanceof TaggedFrame).map((f) => f.tag);
    // Expected pipeline definition order (slow, fast) in each batch.
    expect(tags).toEqual(["slow", "fast", "slow", "fast"]);
  });

  test("test_default_is_arrival", () => {
    // The default frame_order should be ARRIVAL.
    const pipeline = new SyncParallelPipeline([new IdentityFilter()]);
    // biome-ignore lint/complexity/useLiteralKeys: reads a protected member, as upstream does.
    expect(pipeline["_frameOrder"]).toEqual(FrameOrder.ARRIVAL);
  });
});
