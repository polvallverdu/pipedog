// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Node: one process per core with `node:cluster`, sharing one port.
 *
 *   node src/node_cluster.ts
 *
 * Node's threads can't share a listening socket, but cluster's processes can:
 * the primary accepts connections and hands them to the processes in turn.
 * Each process runs its calls on its own event loop.
 */

import cluster from "node:cluster";
import { availableParallelism } from "node:os";
import { websocketFetchHandler } from "@pipedog/transport-websocket/fetch";
import { serveFetch } from "@pipedog/transport-websocket/serve";
import { runBot } from "./bot.ts";

const port = Number(process.env.PORT ?? 8765);

if (cluster.isPrimary) {
  for (let i = 0; i < availableParallelism(); i++) cluster.fork();
} else {
  const handler = websocketFetchHandler((connection) => runBot(connection));
  await serveFetch((request, server) => handler(request, server), { host: "0.0.0.0", port });
}
