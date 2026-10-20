// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/bus/__init__.py

/**
 * Worker bus package -- pub/sub messaging between workers and the runner.
 *
 * Provides the pub/sub infrastructure that connects workers to each other and
 * to the runner. Key components:
 *
 * - `WorkerBus` -- abstract base class defining the send/receive interface.
 * - `AsyncQueueBus` -- in-process implementation backed by an asyncio `Queue`.
 * - `BusBridgeProcessor` -- bidirectional mid-pipeline bridge for
 *   transport/session workers that exchanges frames with other workers
 *   through the bus.
 * - `BusMessage` and its subclasses -- the typed message hierarchy used for
 *   worker lifecycle events (activation, cancellation, shutdown), job
 *   coordination, and frame transport.
 */

export { WorkerRegistryEntry } from "../registry/types.ts";
export { BusBridgeProcessor } from "./bridge_processor.ts";
export { WorkerBus } from "./bus.ts";
export { AsyncQueueBus } from "./local/index.ts";
export {
  BusActivateWorkerMessage,
  BusAddWorkerMessage,
  BusCancelMessage,
  BusCancelWorkerMessage,
  BusDataMessage,
  BusDeactivateWorkerMessage,
  BusEndMessage,
  BusEndWorkerMessage,
  BusFlushProgressMessage,
  BusFrameMessage,
  BusJobCancelMessage,
  BusJobRequestMessage,
  BusJobResponseMessage,
  BusJobResponseUrgentMessage,
  BusJobStreamDataMessage,
  BusJobStreamEndMessage,
  BusJobStreamStartMessage,
  BusJobUpdateMessage,
  BusJobUpdateRequestMessage,
  BusJobUpdateUrgentMessage,
  BusLocalMessage,
  BusMessage,
  BusSystemMessage,
  BusTTSSpeakMessage,
  BusWorkerErrorMessage,
  BusWorkerLocalErrorMessage,
  BusWorkerReadyMessage,
  BusWorkerRegistryMessage,
} from "./messages.ts";
export { BusSubscriber } from "./subscriber.ts";
