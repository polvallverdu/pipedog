// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Log context for the evals: loguru's `logger.contextualize` / `record["extra"]`.
 *
 * DIVERGENCE: pipedog's logger has no `extra` or `contextualize`, so the context
 * values (`eval_run`, `eval_pipeline`) live here, in an AsyncLocalStorage the
 * suite's capture sink reads when a record is logged. It follows the awaits of
 * the code run inside `contextualize`, which covers the harness's own code; a
 * record whose context was lost (e.g. logged from a task woken by another
 * context) counts as the innermost active capture's, which in the suite's
 * one-run-per-process workers is the right run anyway.
 *
 * It lives in its own module so the harness (client, session) can tag its
 * pipelines without importing the suite.
 */

import { AsyncLocalStorage } from "node:async_hooks";

const _logContext = new AsyncLocalStorage<Record<string, unknown>>();

/**
 * Run `fn` with `extra` added to the log context (loguru's
 * `with logger.contextualize(**extra):`).
 *
 * @example
 * contextualize({ eval_pipeline: "judge" }, () => logger.debug("judge line"));
 */
export function contextualize<T>(extra: Record<string, unknown>, fn: () => T): T {
  return _logContext.run({ ...(_logContext.getStore() ?? {}), ...extra }, fn);
}

/** The current log context: what `contextualize` has set around this code. */
export function logContext(): Record<string, unknown> {
  return _logContext.getStore() ?? {};
}
