// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipecat-ts contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/processors/idle_frame_processor.py

/** Idle frame processor for timeout-based callback execution. */

import { Event, type Task, TimeoutError, waitFor } from "@pipecat-ts/asyncio";
import { type Frame, StartFrame } from "../frames/frames.ts";
import {
  type FrameDirection,
  FrameProcessor,
  type FrameProcessorOptions,
} from "./frame_processor.ts";

type AnyClass = abstract new (...args: any[]) => unknown;

export interface IdleFrameProcessorOptions extends FrameProcessorOptions {
  /** Async callback to execute on timeout. Receives this processor instance. */
  callback: (processor: IdleFrameProcessor) => Promise<void>;
  /** Timeout duration in seconds before triggering the callback. */
  timeout: number;
  /** Optional list of frame types to monitor. If null, monitors all frames. */
  types?: AnyClass[] | null;
}

/**
 * Monitors frame activity and triggers callbacks on timeout.
 *
 * This processor waits to receive any frame or specific frame types within a
 * given timeout period. If the timeout is reached before receiving the
 * expected frames, the provided callback will be executed.
 */
export class IdleFrameProcessor extends FrameProcessor {
  protected _callback: (processor: IdleFrameProcessor) => Promise<void>;
  protected _timeout: number;
  protected _types: AnyClass[];
  protected _idleTask: Task<unknown> | null = null;
  protected _idleEvent = new Event();

  /** Initialize the idle frame processor. */
  constructor(options: IdleFrameProcessorOptions) {
    super(options);

    this._callback = options.callback;
    this._timeout = options.timeout;
    this._types = options.types ?? [];
  }

  /**
   * Process incoming frames and manage idle timeout monitoring.
   *
   * @param frame The frame to process.
   * @param direction The direction of frame flow in the pipeline.
   */
  override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
    await super.processFrame(frame, direction);

    if (frame instanceof StartFrame) {
      this._createIdleTask();
    }

    await this.pushFrame(frame, direction);

    // If we are not waiting for any specific frame set the event, otherwise
    // check if we have received one of the desired frames.
    if (this._types.length === 0) {
      this._idleEvent.set();
    } else {
      for (const t of this._types) {
        if (frame instanceof t) {
          this._idleEvent.set();
        }
      }
    }
  }

  /** Clean up resources and cancel pending tasks. */
  override async cleanup(): Promise<void> {
    // Upstream doesn't call super().cleanup() here; we do, so the base
    // processor's input/process tasks are released too.
    await super.cleanup();
    if (this._idleTask) {
      await this.cancelTask(this._idleTask);
    }
  }

  /** Create and start the idle monitoring task. */
  protected _createIdleTask(): void {
    if (!this._idleTask) {
      this._idleEvent = new Event();
      this._idleTask = this.createTask(() => this._idleTaskHandler());
    }
  }

  /** Handle idle timeout monitoring and callback execution. */
  protected async _idleTaskHandler(): Promise<void> {
    for (;;) {
      try {
        await waitFor(() => this._idleEvent.wait(), this._timeout);
        this._idleEvent.clear();
      } catch (e) {
        if (!(e instanceof TimeoutError)) throw e;
        await this._callback(this);
      }
    }
  }
}
