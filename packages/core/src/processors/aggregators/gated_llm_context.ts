// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/processors/aggregators/gated_llm_context.py

/** Gated LLM context aggregator for controlled message flow. */

import type { Task } from "@pipedog/asyncio";
import {
  CancelFrame,
  EndFrame,
  type Frame,
  LLMContextFrame,
  StartFrame,
} from "../../frames/frames.ts";
import type { BaseNotifier } from "../../utils/sync/base_notifier.ts";
import {
  type FrameDirection,
  FrameProcessor,
  type FrameProcessorOptions,
} from "../frame_processor.ts";

export interface GatedLLMContextAggregatorOptions extends FrameProcessorOptions {
  /** The notifier that controls when frames are released. */
  notifier: BaseNotifier;
  /** If true, the first context frame passes through immediately. */
  startOpen?: boolean;
}

/**
 * Aggregator that gates LLM context frames until notified.
 *
 * This aggregator captures LLM context frames and holds them until a notifier
 * signals that they can be released. This is useful for controlling the flow
 * of context frames based on external conditions or timing.
 */
export class GatedLLMContextAggregator extends FrameProcessor {
  protected _notifier: BaseNotifier;
  protected _startOpen: boolean;
  protected _lastContextFrame: LLMContextFrame | null = null;
  protected _gateTask: Task<unknown> | null = null;

  /** Initialize the gated context aggregator. */
  constructor(options: GatedLLMContextAggregatorOptions) {
    super(options);
    this._notifier = options.notifier;
    this._startOpen = options.startOpen ?? false;
  }

  /**
   * Process incoming frames, gating LLM context frames.
   *
   * @param frame The frame to process.
   * @param direction The direction of frame flow in the pipeline.
   */
  override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
    await super.processFrame(frame, direction);

    if (frame instanceof StartFrame) {
      await this.pushFrame(frame);
      await this._start();
    }
    if (frame instanceof EndFrame || frame instanceof CancelFrame) {
      await this._stop();
      await this.pushFrame(frame);
    } else if (frame instanceof LLMContextFrame) {
      if (this._startOpen) {
        this._startOpen = false;
        await this.pushFrame(frame, direction);
      } else {
        this._lastContextFrame = frame;
      }
    } else {
      // NOTE: as upstream, a StartFrame also reaches this branch and is pushed
      // a second time.
      await this.pushFrame(frame, direction);
    }
  }

  /** Release resources held by the aggregator. */
  override async cleanup(): Promise<void> {
    await super.cleanup();
    await this._stop();
  }

  /** Start the gate task handler. */
  protected async _start(): Promise<void> {
    if (!this._gateTask) {
      this._gateTask = this.createTask(() => this._gateTaskHandler(), "_gate_task_handler");
    }
  }

  /** Stop the gate task handler. */
  protected async _stop(): Promise<void> {
    if (this._gateTask) {
      await this.cancelTask(this._gateTask);
      this._gateTask = null;
    }
  }

  /** Handle the gating logic by waiting for notifications and releasing frames. */
  protected async _gateTaskHandler(): Promise<void> {
    while (true) {
      await this._notifier.wait();
      if (this._lastContextFrame) {
        await this.pushFrame(this._lastContextFrame);
        this._lastContextFrame = null;
      }
    }
  }
}
