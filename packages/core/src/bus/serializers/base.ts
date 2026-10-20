// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipecat-ts contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/bus/serializers/base.py

/** Abstract base classes for bus message serialization. */

import type { BusMessage } from "../messages.ts";

/**
 * Serialize and deserialize `BusMessage` instances for network transport.
 *
 * Network bus implementations use a `MessageSerializer` to convert messages
 * to bytes for transmission and reconstruct them on the receiving end.
 */
export abstract class MessageSerializer {
  /**
   * Convert a bus message to bytes.
   *
   * @param message The bus message to serialize.
   * @returns The serialized bytes.
   */
  abstract serialize(message: BusMessage): Uint8Array;

  /**
   * Reconstruct a bus message from bytes.
   *
   * @param data The serialized bytes produced by `serialize()`.
   * @returns The reconstructed `BusMessage`.
   */
  abstract deserialize(data: Uint8Array): BusMessage | null;
}
