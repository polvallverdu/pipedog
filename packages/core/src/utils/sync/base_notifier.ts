// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/utils/sync/base_notifier.py

/** Base notifier interface for Pipecat. */

/**
 * Abstract base class for notification mechanisms.
 *
 * Provides a standard interface for implementing notification and waiting
 * patterns used for event coordination and signaling between components
 * in the Pipecat framework.
 */
export abstract class BaseNotifier {
  /**
   * Send a notification signal.
   *
   * Implementations should trigger any waiting coroutines or processes
   * that are blocked on this notifier.
   */
  abstract notify(): Promise<void>;

  /**
   * Wait for a notification signal.
   *
   * Implementations should block until a notification is received
   * from the corresponding notify() call.
   */
  abstract wait(): Promise<void>;
}
