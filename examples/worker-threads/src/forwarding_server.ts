// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Any runtime (Bun, Node, Deno): the main thread accepts every WebSocket and
 * forwards it to the least busy of one worker thread per core, where the
 * bot runs (`bot_thread.ts`).
 *
 *   bun src/forwarding_server.ts
 *
 * The main thread only moves messages; the pipelines, and their models, run
 * on the workers' event loops.
 */

import { websocketFetchHandler } from "@pipedog/transport-websocket/fetch";
import { serveFetch } from "@pipedog/transport-websocket/serve";
import { forwardConnection } from "./socket_forwarding.ts";
import { coreCount, spawnThread, type ThreadPort } from "./threads.ts";

const port = Number(process.env.PORT ?? 8765);

const workers: Array<{ port: ThreadPort; calls: number }> = await Promise.all(
  Array.from({ length: coreCount() }, async () => ({
    port: await spawnThread(new URL("./bot_thread.ts", import.meta.url)),
    calls: 0,
  })),
);

const handler = websocketFetchHandler(async (connection) => {
  const worker = workers.reduce((a, b) => (b.calls < a.calls ? b : a));
  worker.calls++;
  try {
    await forwardConnection(connection, worker.port, { path: connection.path });
  } finally {
    worker.calls--;
  }
});

const server = await serveFetch((request, upgrading) => handler(request, upgrading), {
  host: "0.0.0.0",
  port,
});
console.log(`listening on :${server.port} with ${workers.length} worker threads`);
