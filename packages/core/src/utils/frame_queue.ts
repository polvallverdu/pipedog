// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipecat-ts contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/utils/frame_queue.py

/** Frame queue utilities for Pipecat pipeline processors. */

import { heapPop, heapPush, pythonCompare, Queue } from "@pipecat-ts/asyncio";
import type { Frame } from "../frames/frames.ts";

export type FrameClass<T extends Frame = Frame> = abstract new (...args: any[]) => T;

/**
 * A Queue that knows whether any uninterruptible frame is enqueued.
 *
 * `reset()` removes every interruptible item and keeps the uninterruptible
 * ones (`frame.interruptible === false`) in place.
 *
 * Items may be raw frames or tuples whose first element is a frame. Pass a
 * `frameGetter` to extract the frame from each item; queues that also carry
 * non-frame items should return null from their getter for those.
 */
export class FrameQueue<T = Frame> extends Queue<T> {
  protected readonly _frameGetter: (item: T) => Frame | null;

  constructor(frameGetter: (item: T) => Frame | null = (item) => item as unknown as Frame) {
    super();
    this._frameGetter = frameGetter;
  }

  /** Whether any frame of the given type is in the queue. */
  hasFrame(frameType: FrameClass): boolean {
    return this._items.some((item) => this._frameGetter(item) instanceof frameType);
  }

  /** Whether any uninterruptible frame is currently in the queue. */
  get hasUninterruptible(): boolean {
    return this._items.some((item) => this._isUninterruptible(item));
  }

  /** Remove all interruptible items, keeping uninterruptible ones. */
  reset(): void {
    const kept: T[] = [];
    while (!this.empty()) {
      const item = this.getNowait();
      if (this._isUninterruptible(item)) kept.push(item);
      this.taskDone();
    }
    for (const item of kept) this.putNowait(item);
  }

  protected _isUninterruptible(item: T): boolean {
    const frame = this._frameGetter(item);
    return frame !== null && !frame.interruptible;
  }
}

/**
 * A priority queue with frame-aware interruption handling. For
 * `[priority, sequence, frame]` items pass `(item) => item[2]`.
 */
export class FramePriorityQueue<T = Frame> extends FrameQueue<T> {
  readonly #compare: (a: T, b: T) => number;

  constructor(
    frameGetter: (item: T) => Frame | null = (item) => item as unknown as Frame,
    compare: (a: T, b: T) => number = pythonCompare,
  ) {
    super(frameGetter);
    this.#compare = compare;
  }

  protected override _put(item: T): void {
    heapPush(this._items, item, this.#compare);
  }

  protected override _get(): T {
    return heapPop(this._items, this.#compare);
  }
}
