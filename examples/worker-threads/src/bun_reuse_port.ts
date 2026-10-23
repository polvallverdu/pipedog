// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Bun: one worker thread per core, each with its own server on the same port.
 *
 *   bun src/bun_reuse_port.ts
 *
 * `reusePort` lets every thread listen on the port; on Linux the kernel
 * spreads new connections across them (macOS and Windows don't balance them).
 * Each thread runs its calls, and its own model sessions, on its own event loop.
 */

import {
  bunWebSocket,
  type UpgradingServer,
  websocketFetchHandler,
} from "@pipedog/transport-websocket/fetch";
import { runBot } from "./bot.ts";

const port = Number(process.env.PORT ?? 8765);

if (Bun.isMainThread) {
  for (let i = 0; i < navigator.hardwareConcurrency; i++) new Worker(import.meta.url);
} else {
  const handler = websocketFetchHandler((connection) => runBot(connection));
  const config = {
    port,
    reusePort: true,
    fetch: (request: Request, server: UpgradingServer) => handler(request, server),
    websocket: bunWebSocket,
  };
  // The handlers take the small server and socket interfaces they use, not Bun's full types.
  Bun.serve(config as unknown as Parameters<typeof Bun.serve>[0]);
}
