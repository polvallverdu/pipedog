// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/utils/sync/event_notifier.py

/** Event-based notifier implementation using asyncio Event primitives. */

import { Event } from "@pipedog/asyncio";
import { BaseNotifier } from "./base_notifier.ts";

/**
 * Event-based notifier using asyncio.Event for task synchronization.
 *
 * Provides a simple single-consumer notification mechanism where one task
 * can signal an event and one other task can wait for that event to occur.
 * The event is automatically cleared after each wait operation.
 *
 * Note: This notifier supports only a single waiter at a time. If multiple
 * tasks wait concurrently, notifications may be lost.
 */
export class EventNotifier extends BaseNotifier {
  protected _event: Event;

  /**
   * Initialize the event notifier.
   *
   * Creates an internal asyncio.Event for managing notifications.
   */
  constructor() {
    super();
    this._event = new Event();
  }

  /**
   * Signal the event to notify waiting tasks.
   *
   * Sets the internal event, causing any tasks waiting on this
   * notifier to be awakened.
   */
  async notify(): Promise<void> {
    this._event.set();
  }

  /**
   * Wait for the event to be signaled.
   *
   * Blocks until another task calls notify(). Automatically clears
   * the event after being awakened so subsequent calls will wait
   * for the next notification.
   */
  async wait(): Promise<void> {
    await this._event.wait();
    this._event.clear();
  }
}
