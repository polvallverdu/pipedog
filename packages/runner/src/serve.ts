// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Serve a `RunnerApp` on Bun, Node or Deno (upstream runs its FastAPI app with
 * uvicorn).
 *
 * The app is a fetch handler; `serveFetch` from `@pipedog/transport-websocket`
 * listens with the runtime's own server and upgrades WebSockets with it:
 * `Bun.serve`'s `upgrade()` on Bun, the `ws` package (an optional peer
 * dependency) on Node, and `Deno.upgradeWebSocket` on Deno. The app's
 * lifespans run before the server starts listening and after it stops.
 */

import { serveFetch } from "@pipedog/transport-websocket/serve";

import type { RunnerApp } from "./run.ts";

export interface ServeOptions {
  /** The host to listen on. Defaults to `localhost`. */
  host?: string;
  /** The port to listen on; 0 picks a free one. Defaults to 7860. */
  port?: number;
}

/** A listening runner. */
export interface RunnerServer {
  /** The host it listens on. */
  readonly host: string;
  /** The port it listens on (the real one when 0 was asked for). */
  readonly port: number;
  /** `http://host:port`. */
  readonly url: string;
  /** Stop listening and run the app's shutdown hooks. */
  close(): Promise<void>;
}

/**
 * Serve `app` on this runtime's HTTP server. Runs the app's startup hooks
 * first.
 *
 * @throws Error On runtimes without a server to listen with (Cloudflare
 *   Workers: export `{ fetch: app.fetch }` instead).
 */
export async function serve(app: RunnerApp, options: ServeOptions = {}): Promise<RunnerServer> {
  const host = options.host ?? "localhost";
  await app.startup();
  let server: Awaited<ReturnType<typeof serveFetch>>;
  try {
    // A WebRTC offer can wait for ICE gathering; keep requests open meanwhile.
    server = await serveFetch(app.fetch, { host, port: options.port ?? 7860, idleTimeout: 120 });
  } catch (e) {
    await app.shutdown();
    throw e;
  }
  return {
    host,
    port: server.port,
    url: `http://${host}:${server.port}`,
    async close() {
      await server.close();
      await app.shutdown();
    },
  };
}
