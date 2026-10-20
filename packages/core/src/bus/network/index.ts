// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipecat-ts contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/bus/network/__init__.py

/**
 * Network bus implementations for distributed workers.
 *
 * Each adapter has its own optional dependency, so each lives in its own
 * package and is imported from there:
 *
 * - `PgmqBus`: `@pipecat-ts/bus-pgmq/pgmq`
 * - `RedisBus`: `@pipecat-ts/bus-redis/redis`
 *
 * PORTING NOTE: upstream re-exports both names lazily (a module
 * `__getattr__`) so the package loads with only the extras installed.
 * ES modules have no lazy re-exports, and a static re-export would make core
 * depend on both network packages, so this module re-exports nothing.
 */

export {};
