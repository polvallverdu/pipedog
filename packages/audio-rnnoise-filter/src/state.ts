// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

import type { RnnoiseEngine } from "./engine.ts";

let engine: RnnoiseEngine | null = null;
let pending: Promise<RnnoiseEngine> | null = null;

/** @internal */
export function setEngine(e: RnnoiseEngine): RnnoiseEngine {
  engine = e;
  return e;
}

/** @internal */
export function currentEngine(): RnnoiseEngine | null {
  return engine;
}

/** @internal Run `load` once; concurrent callers share the promise. */
export function initOnce(load: () => Promise<RnnoiseEngine>): Promise<RnnoiseEngine> {
  if (engine) return Promise.resolve(engine);
  pending ??= load().then(setEngine, (e) => {
    pending = null;
    throw e;
  });
  return pending;
}
