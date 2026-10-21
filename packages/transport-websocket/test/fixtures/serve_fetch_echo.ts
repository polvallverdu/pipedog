// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// An echo server built from a fetch handler, served with serveFetch: GET /hello
// answers over HTTP, /ws echoes WebSocket messages back with an "echo:" prefix.
// Prints `listening <port>` once ready. Run by fetch.test.ts on Bun, Node and Deno.

import { websocketFetchHandler } from "../../src/fetch.ts";
import { serveFetch } from "../../src/serve.ts";

const echo = websocketFetchHandler(async (connection) => {
  for await (const message of connection) {
    await connection.send(typeof message === "string" ? `echo:${message}` : message);
  }
});

const server = await serveFetch(
  async (request, upgrader) => {
    const { pathname } = new URL(request.url);
    if (pathname === "/ws") return echo(request, upgrader);
    if (pathname === "/hello") return new Response(`hello ${request.method}`);
    return new Response("not found", { status: 404 });
  },
  { host: "127.0.0.1", port: 0 },
);
console.log(`listening ${server.port}`);
