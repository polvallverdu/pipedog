// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/**
 * A worker thread module for `SmartTurnWorkerPool`:
 *
 * ```ts
 * const pool = new SmartTurnWorkerPool({
 *   spawn: () => spawnThread(new URL("./smart_turn_thread.ts", import.meta.url)),
 * });
 * ```
 */

import { serveSmartTurn } from "./smart_turn_pool.ts";
import { parentThread } from "./threads.ts";

const port = await parentThread();
if (!port) throw new Error("smart_turn_thread.ts runs in a worker thread (spawnThread)");
serveSmartTurn(port);
