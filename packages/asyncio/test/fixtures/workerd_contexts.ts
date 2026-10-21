// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// A Worker for workerd_contexts.test.ts. Each WebSocket session (a request,
// or a Durable Object with ?id=) echoes every message from a loop callback,
// after a burst of other callbacks, so the sessions' callbacks are ready at the
// same time. A callback run in another session's I/O context can't send on
// this session's socket: the session counts those failures and reports them
// when the client sends "end".

import { callSoon } from "../../src/index.ts";

interface ServerSocket {
  accept(): void;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
}

declare const WebSocketPair: { new (): { 0: unknown; 1: ServerSocket } };

/** Callbacks queued ahead of each echo. */
const BURST = 20;

function session(): Response {
  const pair = new WebSocketPair();
  const server = pair[1];
  server.accept();
  let failures = 0;
  let firstFailure = "";
  server.addEventListener("message", (event) => {
    const data = String(event.data);
    if (data === "end") {
      server.send(JSON.stringify({ failures, firstFailure }));
      server.close(1000, "done");
      return;
    }
    for (let i = 0; i < BURST; i++) callSoon(() => {});
    callSoon(() => {
      try {
        server.send(data);
      } catch (e) {
        failures++;
        firstFailure ||= String(e);
      }
    });
  });
  return new Response(null, { status: 101, webSocket: pair[0] } as ResponseInit);
}

export class Session {
  fetch(): Response {
    return session();
  }
}

interface Namespace {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(request: Request): Promise<Response> };
}

export default {
  fetch(request: Request, env: { SESSION: Namespace }): Response | Promise<Response> {
    if (request.headers.get("upgrade") !== "websocket") return new Response("ok");
    const id = new URL(request.url).searchParams.get("id");
    if (id) return env.SESSION.get(env.SESSION.idFromName(id)).fetch(request);
    return session();
  },
};
