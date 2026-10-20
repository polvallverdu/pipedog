// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipecat-ts contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/bus/queue.py

/** Priority queue for bus messages. */

import { heapPop, heapPush, Queue } from "@pipecat-ts/asyncio";
import { type BusMessage, BusSystemMessage } from "./messages.ts";

export const HIGH_PRIORITY = 1;
export const LOW_PRIORITY = 2;

type BusQueueEntry = [priority: number, counter: number, message: BusMessage];

function compareEntries(a: BusQueueEntry, b: BusQueueEntry): number {
  return a[0] - b[0] || a[1] - b[1];
}

/**
 * Priority queue that delivers system messages before normal messages.
 *
 * Messages that extend `BusSystemMessage` (e.g. cancel messages) get high
 * priority. All other messages are delivered in FIFO order at normal
 * priority.
 *
 * Upstream subclasses `asyncio.PriorityQueue` and wraps each message in a
 * `(priority, counter, message)` tuple in `put()`/`put_nowait()`, unwrapping
 * it in `get()`. Here the queue is a `Queue<BusMessage>` whose storage hooks
 * keep the same tuples in a heap, so `put`, `putNowait`, `get` and
 * `getNowait` all take and return plain messages.
 */
export class BusMessageQueue extends Queue<BusMessage> {
  #heap: BusQueueEntry[] = [];
  #highCounter = 0;
  #lowCounter = 0;

  /** Add a message to the heap with automatic priority assignment. */
  protected override _put(item: BusMessage): void {
    if (item instanceof BusSystemMessage) {
      this.#highCounter += 1;
      heapPush(this.#heap, [HIGH_PRIORITY, this.#highCounter, item], compareEntries);
    } else {
      this.#lowCounter += 1;
      heapPush(this.#heap, [LOW_PRIORITY, this.#lowCounter, item], compareEntries);
    }
  }

  /** Get the next message, with system messages prioritized. */
  protected override _get(): BusMessage {
    const [, , message] = heapPop(this.#heap, compareEntries);
    return message;
  }

  protected override _size(): number {
    return this.#heap.length;
  }
}
