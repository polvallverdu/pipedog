// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/bus/subscriber.py

/** Bus subscriber mixin for receiving messages from a WorkerBus. */

import { type Ctor, defineMixin } from "../utils/mixin.ts";
import type { BusMessage } from "./messages.ts";

/**
 * An object that receives messages from a `WorkerBus`.
 *
 * Implementors override `onBusMessage()` to handle incoming messages.
 * Concrete subscribers must provide a `name` property (typically inherited
 * from `BaseObject`).
 */
export interface BusSubscriber extends BusSubscriberMethods {
  /** Unique name identifying this subscriber on the bus. */
  readonly name: string;
}

/** The members the `BusSubscriber` mixin provides (the base supplies `name`). */
export interface BusSubscriberMethods {
  /**
   * Whether this subscriber should be handed this message.
   *
   * Checked by the bus before every delivery. Returning false drops the
   * message for this subscriber alone; others still receive it. Subscribers
   * that take everything, which is the default, need not override this.
   *
   * @param message The bus message about to be delivered.
   * @returns Whether to deliver the message.
   */
  acceptsBusMessage(message: BusMessage): boolean;

  /**
   * Handle an incoming bus message.
   *
   * Only called for messages `acceptsBusMessage` allowed.
   *
   * @param message The bus message to handle.
   */
  onBusMessage(message: BusMessage): Promise<void>;
}

/**
 * Mixin for objects that receive messages from a `WorkerBus`:
 * `class BaseWorker(BaseObject, BusSubscriber)` →
 * `class BaseWorker extends BusSubscriber(BaseObject)`.
 *
 * The base class provides `name` (upstream's `name` property raises
 * `NotImplementedError` and is always supplied by `BaseObject`).
 */
export const BusSubscriber = defineMixin<
  BusSubscriber,
  <B extends Ctor>(base: B) => B & Ctor<BusSubscriberMethods>
>("BusSubscriber", <B extends Ctor>(Base: B) => {
  abstract class BusSubscriberMixin extends Base implements BusSubscriberMethods {
    /** See `BusSubscriber.acceptsBusMessage`. Accepts everything by default. */
    acceptsBusMessage(_message: BusMessage): boolean {
      return true;
    }

    /** See `BusSubscriber.onBusMessage`. Does nothing by default. */
    async onBusMessage(_message: BusMessage): Promise<void> {}
  }
  return BusSubscriberMixin;
});
