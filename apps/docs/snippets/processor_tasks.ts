// Copyright (c) 2026, pipecat-ts contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Samples for content/docs/concepts/interruptions-and-cancellation.mdx.
// Type-checked on every docs build.

// #region processor-task
import { rethrowIfCancelled, sleep, type Task } from "@pipecat-ts/asyncio";
import {
  type Frame,
  InterruptionFrame,
  StartFrame,
  TextFrame,
} from "@pipecat-ts/core/frames/frames";
import { type FrameDirection, FrameProcessor } from "@pipecat-ts/core/processors/frame_processor";

/** Says "tick" every second until the pipeline ends. */
export class Ticker extends FrameProcessor {
  #tickTask: Task<unknown> | null = null;

  override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
    await super.processFrame(frame, direction);

    if (frame instanceof StartFrame) {
      // Tracked by the task manager: cancelled at cleanup, never left floating.
      this.#tickTask = this.createTask(() => this.#tick(), "tick");
    } else if (frame instanceof InterruptionFrame) {
      console.log("interrupted: stop what we were saying");
    }

    await this.pushFrame(frame, direction);
  }

  async #tick(): Promise<void> {
    for (;;) {
      await sleep(1.0); // seconds, never raw setTimeout
      try {
        await this.pushFrame(new TextFrame({ text: "tick" }));
      } catch (e) {
        rethrowIfCancelled(e);
        await this.pushError("tick failed", { exception: e });
      }
    }
  }

  override async cleanup(): Promise<void> {
    await super.cleanup();
    if (this.#tickTask) {
      await this.cancelTask(this.#tickTask);
      this.#tickTask = null;
    }
  }
}
// #endregion processor-task
