// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/utils/utils.py

/**
 * Utility functions for object identification and counting.
 */

const counts = new Map<string, number>();
let nextId = 0;

/** Generate a unique id for an object. */
export function objId(): number {
  return nextId++;
}

/** Generate a unique count for an object based on its class name. */
export function objCount(obj: object): number {
  const name = obj.constructor.name;
  const count = counts.get(name) ?? 0;
  counts.set(name, count + 1);
  return count;
}
