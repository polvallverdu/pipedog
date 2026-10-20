// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Worker entry for the WebSocket end-to-end runs on workerd: the echo bot
// behind FastAPIWebsocketTransport, on the server half of a WebSocketPair.
//
//   /     -> the Worker accepts the socket and runs the bot in ctx.waitUntil()
//   /do   -> forwarded to a Durable Object, which accepts the socket and runs the bot
//   /client?uri=<ws uri> -> runs the client end (global WebSocket) and answers its result

import { type WebSocketLike, WebsocketConnection } from "../../src/socket.ts";
import { quietLogs, runEchoBotOnSocket, runEchoClient } from "./apps.ts";

quietLogs();

interface WebSocketPairLike {
  0: WebSocketLike;
  1: WebSocketLike & { accept(): void };
}

interface DurableObjectNamespaceLike {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(request: Request): Promise<Response> };
}

interface Env {
  ECHO: DurableObjectNamespaceLike;
}

interface ExecutionContextLike {
  waitUntil(promise: Promise<unknown>): void;
}

function accept(request: Request, run: (bot: Promise<void>) => void): Response {
  if ((request.headers.get("upgrade") ?? "").toLowerCase() !== "websocket") {
    return new Response("expected a WebSocket upgrade", { status: 426 });
  }
  const Pair = (globalThis as unknown as { WebSocketPair: new () => WebSocketPairLike })
    .WebSocketPair;
  const pair = new Pair();
  const client = pair[0];
  const server = pair[1];
  server.accept();
  const connection = WebsocketConnection.fromWebSocket(server, {
    headers: request.headers,
    path: new URL(request.url).pathname,
  });
  run(
    runEchoBotOnSocket(connection).catch((e) => {
      console.error("E2E_ERROR", e);
    }),
  );
  // `webSocket` is a workerd extension of ResponseInit.
  return new Response(null, { status: 101, webSocket: client } as ResponseInit);
}

/** The Durable Object variant: the socket lives in the object, not the request. */
export class EchoBot {
  async fetch(request: Request): Promise<Response> {
    // The object stays alive while its socket is open; the bot's promise
    // needs no waitUntil there.
    return accept(request, (bot) => {
      void bot;
    });
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContextLike): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") return new Response("ok");
    if (url.pathname === "/client") {
      const result = await runEchoClient(url.searchParams.get("uri") as string);
      return Response.json(result);
    }
    if (url.pathname === "/do") {
      return env.ECHO.get(env.ECHO.idFromName("echo")).fetch(request);
    }
    return accept(request, (bot) => ctx.waitUntil(bot));
  },
};
