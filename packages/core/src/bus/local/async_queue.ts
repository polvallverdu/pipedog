// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipecat-ts contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/bus/local/async_queue.py

/** In-process worker bus backed by asyncio queues. */

import { logger } from "../../utils/logger.ts";
import { WorkerBus } from "../bus.ts";
import type { BusMessage } from "../messages.ts";

/** In-process bus that delivers messages via priority queues. */
export class AsyncQueueBus extends WorkerBus {
  /**
   * Deliver a message to all local subscriber queues.
   *
   * @param message The bus message to deliver.
   */
  async publish(message: BusMessage): Promise<void> {
    logger.trace(`${this}: sending ${message}`);
    this.onMessageReceived(message);
  }
}
