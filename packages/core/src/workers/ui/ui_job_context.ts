// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipecat-ts contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/workers/ui/ui_job_context.py

/**
 * User-facing job group context (compatibility shim).
 *
 * Porting notes:
 * - Upstream this module holds only `UIJobGroupContext`, a deprecated alias
 *   (since 1.8.0) for `JobGroupContext` with the historical constructor
 *   signature. Deprecated upstream APIs are not ported, so this module is
 *   intentionally empty: a group dispatched by a `UIWorker` is client-visible,
 *   so use `JobGroupContext` (`worker.jobGroup(...)`) instead.
 */

export {};
