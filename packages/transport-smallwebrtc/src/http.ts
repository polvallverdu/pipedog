// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/**
 * The SmallWebRTC signalling endpoint, as standard `Request` → `Response`
 * handlers.
 *
 * Pipecat's development runner serves `SmallWebRTCRequestHandler` from a
 * FastAPI app:
 *
 * - `POST /api/offer` `{sdp, type, pc_id?, restart_pc?, request_data?}` →
 *   `{sdp, type, pc_id}`
 * - `PATCH /api/offer` `{pc_id, candidates: [{candidate, sdp_mid, sdp_mline_index}]}`
 *   → `{"status": "success"}`
 *
 * `smallWebRTCOfferHandler()` implements the same contract for any server
 * built on the Fetch API (`Bun.serve`, `Deno.serve`, Hono), and
 * `nodeRequestListener()` adapts it to Node's `http` module. This is what the
 * browser SDK's `SmallWebRTCTransport` talks to.
 */

import { rethrowIfCancelled } from "@pipedog/asyncio";
import { logger } from "@pipedog/core/utils/logger";
import { pyJsonDumps } from "@pipedog/core/utils/py_json";

import type { SmallWebRTCConnection } from "./connection.ts";
import {
  HTTPException,
  SmallWebRTCPatchRequest,
  SmallWebRTCRequest,
  type SmallWebRTCRequestHandler,
} from "./request_handler.ts";

function json(body: unknown, status = 200): Response {
  return new Response(pyJsonDumps(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Called with each new connection and the request that created it. Start the
 * bot in the background (don't await it): the answer is sent once this
 * returns.
 */
export type SmallWebRTCConnectionCallback = (
  connection: SmallWebRTCConnection,
  request: SmallWebRTCRequest,
) => void | Promise<void>;

/**
 * Serve `POST` (offers) and `PATCH` (ICE candidates) for one URL, e.g. `/api/offer`.
 *
 * Errors follow FastAPI: an `HTTPException` becomes its status with
 * `{"detail": ...}`, a malformed body a 400 and anything else a 500.
 */
export function smallWebRTCOfferHandler(
  handler: SmallWebRTCRequestHandler,
  onConnection: SmallWebRTCConnectionCallback,
): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    let body: Record<string, any>;
    try {
      body = (await request.json()) as Record<string, any>;
      if (typeof body !== "object" || body === null) throw new Error("expected a JSON object");
    } catch (e) {
      rethrowIfCancelled(e);
      return json({ detail: `Invalid WebRTC request: ${e}` }, 400);
    }
    try {
      if (request.method === "POST") {
        if (typeof body.sdp !== "string" || typeof body.type !== "string") {
          return json({ detail: "Invalid WebRTC request: sdp and type are required" }, 400);
        }
        const offer = SmallWebRTCRequest.fromDict(body);
        const answer = await handler.handleWebRequest(offer, (connection) =>
          onConnection(connection, offer),
        );
        return json(answer);
      }
      if (request.method === "PATCH") {
        if (typeof body.pc_id !== "string") {
          return json({ detail: "Invalid WebRTC request: pc_id is required" }, 400);
        }
        await handler.handlePatchRequest(SmallWebRTCPatchRequest.fromDict(body));
        return json({ status: "success" });
      }
      return json({ detail: "Method Not Allowed" }, 405);
    } catch (e) {
      rethrowIfCancelled(e);
      if (e instanceof HTTPException) return json({ detail: e.detail }, e.statusCode);
      logger.error(`SmallWebRTC signalling error: ${e}`);
      return json({ detail: "Internal Server Error" }, 500);
    }
  };
}

/** The parts of Node's `IncomingMessage` the adapter uses. */
export interface NodeIncomingMessage extends AsyncIterable<Uint8Array | string> {
  method?: string;
  url?: string;
  headers: Record<string, string | string[] | undefined>;
}

/** The parts of Node's `ServerResponse` the adapter uses. */
export interface NodeServerResponse {
  writeHead(status: number, headers?: Record<string, string>): unknown;
  end(body?: Uint8Array | string): unknown;
}

/**
 * Adapt a Fetch API handler to a Node `http.createServer()` request listener.
 *
 * @example
 * http.createServer(nodeRequestListener(app)).listen(7860);
 */
export function nodeRequestListener(
  fetchHandler: (request: Request) => Response | Promise<Response>,
): (req: NodeIncomingMessage, res: NodeServerResponse) => Promise<void> {
  return async (req, res) => {
    const chunks: Uint8Array[] = [];
    for await (const chunk of req) {
      chunks.push(typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk);
    }
    const host = (req.headers.host as string | undefined) ?? "localhost";
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
      if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
    }
    const method = req.method ?? "GET";
    const length = chunks.reduce((n, c) => n + c.length, 0);
    const body = new Uint8Array(length);
    let offset = 0;
    for (const c of chunks) {
      body.set(c, offset);
      offset += c.length;
    }
    let response: Response;
    try {
      response = await fetchHandler(
        new Request(`http://${host}${req.url ?? "/"}`, {
          method,
          headers,
          body: method === "GET" || method === "HEAD" ? undefined : body,
        }),
      );
    } catch (e) {
      rethrowIfCancelled(e);
      logger.error(`Request handler error: ${e}`);
      response = new Response("Internal Server Error", { status: 500 });
    }
    const outHeaders: Record<string, string> = {};
    response.headers.forEach((value, name) => {
      outHeaders[name] = value;
    });
    res.writeHead(response.status, outHeaders);
    res.end(new Uint8Array(await response.arrayBuffer()));
  };
}
