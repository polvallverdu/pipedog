// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipecat-ts contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/registry/types.py

/** Shared types for the worker registry. */

export interface WorkerRegistryEntryOptions {
  /** The worker's name. */
  name: string;
  /** Name of the parent worker, or null for root tasks. */
  parent?: string | null;
  /** Whether the worker is currently active. */
  active?: boolean;
  /** Whether the worker is bridged. */
  bridged?: boolean;
  /** Unix timestamp when the worker became ready. */
  startedAt?: number | null;
}

/** Information about a worker in a registry snapshot. */
export class WorkerRegistryEntry {
  name: string;
  parent: string | null;
  active: boolean;
  bridged: boolean;
  startedAt: number | null;

  constructor(options: WorkerRegistryEntryOptions) {
    this.name = options.name;
    this.parent = options.parent ?? null;
    this.active = options.active ?? false;
    this.bridged = options.bridged ?? false;
    this.startedAt = options.startedAt ?? null;
  }
}

export interface WorkerReadyDataOptions {
  /** The name of the worker. */
  workerName: string;
  /** The name of the runner managing this worker. */
  runner: string;
}

/** Information about a registered worker. */
export class WorkerReadyData {
  workerName: string;
  runner: string;

  constructor(options: WorkerReadyDataOptions) {
    this.workerName = options.workerName;
    this.runner = options.runner;
  }
}

export interface WorkerErrorDataOptions {
  /** The name of the worker that errored. */
  workerName: string;
  /** Description of the error. */
  error: string;
}

/** Information about a worker error. */
export class WorkerErrorData {
  workerName: string;
  error: string;

  constructor(options: WorkerErrorDataOptions) {
    this.workerName = options.workerName;
    this.error = options.error;
  }
}
