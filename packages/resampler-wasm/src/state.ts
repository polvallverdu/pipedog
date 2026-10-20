// Copyright (c) 2026, pipecat-ts contributors
// SPDX-License-Identifier: BSD-2-Clause

/** The process-wide engine shared by both entry points. */

import type { RubatoEngine } from "./engine.ts";

let engine: RubatoEngine | null = null;
let pending: Promise<RubatoEngine> | null = null;

/** @internal */
export function setEngine(e: RubatoEngine): RubatoEngine {
  engine = e;
  return e;
}

/** @internal */
export function currentEngine(): RubatoEngine | null {
  return engine;
}

/** @internal Run `load` once; concurrent callers share the promise. */
export function initOnce(load: () => Promise<RubatoEngine>): Promise<RubatoEngine> {
  if (engine) return Promise.resolve(engine);
  pending ??= load().then(setEngine, (e) => {
    pending = null;
    throw e;
  });
  return pending;
}
