// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipecat-ts contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/processors/aggregators/gated.py

/**
 * Gated frame aggregator for conditional frame accumulation.
 *
 * This module provides a gated aggregator that accumulates frames based on
 * custom gate open/close functions, allowing for conditional frame buffering
 * and release in frame processing pipelines.
 */

import { type Frame, SystemFrame } from "../../frames/frames.ts";
import { logger } from "../../utils/logger.ts";
import { FrameDirection, FrameProcessor } from "../frame_processor.ts";

/** Predicate deciding whether a frame opens or closes the gate. */
export type GateFn = (frame: Frame) => boolean;

/**
 * Accumulate frames, with custom functions to start and stop accumulation.
 *
 * Yields gate-opening frame before any accumulated frames, then ensuing frames
 * until and not including the gate-closed frame. The aggregator maintains an
 * internal gate state that controls whether frames are passed through
 * immediately or accumulated for later release.
 */
export class GatedAggregator extends FrameProcessor {
  protected _gateOpenFn: GateFn;
  protected _gateCloseFn: GateFn;
  protected _gateOpen: boolean;
  protected _direction: FrameDirection;
  protected _accumulator: [Frame, FrameDirection][] = [];

  /**
   * Initialize the gated aggregator.
   *
   * @param gateOpenFn Function that returns true when a frame should open the gate.
   * @param gateCloseFn Function that returns true when a frame should close the gate.
   * @param startOpen Whether the gate should start in the open state.
   * @param direction The frame direction this aggregator operates on.
   */
  constructor(
    gateOpenFn: GateFn,
    gateCloseFn: GateFn,
    startOpen: boolean,
    direction: FrameDirection = FrameDirection.DOWNSTREAM,
  ) {
    super();
    this._gateOpenFn = gateOpenFn;
    this._gateCloseFn = gateCloseFn;
    this._gateOpen = startOpen;
    this._direction = direction;
  }

  /**
   * Process incoming frames with gated accumulation logic.
   *
   * @param frame The frame to process.
   * @param direction The direction of the frame flow.
   */
  override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
    await super.processFrame(frame, direction);

    // We must not block system frames.
    if (frame instanceof SystemFrame) {
      await this.pushFrame(frame, direction);
      return;
    }

    // Ignore frames that are not following the direction of this gate.
    if (direction !== this._direction) {
      await this.pushFrame(frame, direction);
      return;
    }

    const oldState = this._gateOpen;
    if (this._gateOpen) {
      this._gateOpen = !this._gateCloseFn(frame);
    } else {
      this._gateOpen = this._gateOpenFn(frame);
    }

    if (oldState !== this._gateOpen) {
      const state = this._gateOpen ? "open" : "closed";
      logger.debug(`Gate is now ${state} because of ${frame}`);
    }

    if (this._gateOpen) {
      await this.pushFrame(frame, direction);
      for (const [f, d] of this._accumulator) {
        await this.pushFrame(f, d);
      }
      this._accumulator = [];
    } else {
      this._accumulator.push([frame, direction]);
    }
  }
}
