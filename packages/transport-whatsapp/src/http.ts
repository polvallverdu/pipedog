// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/**
 * A fetch handler for WhatsApp's webhook endpoint: `(Request) => Promise<Response>`.
 *
 * Not in upstream (there the FastAPI app does this). It answers Meta's verification
 * `GET`, and for each `POST` validates the signature (when the client has an app secret),
 * parses the body and hands it to `WhatsAppClient.handleWebhookRequest`. It runs wherever
 * `Request`/`Response` exist, including Cloudflare Workers, where only the verification
 * and the signature check work: connect events need WebRTC.
 *
 * @example
 * ```ts
 * const handler = whatsAppWebhookHandler(client, {
 *   verifyToken: process.env.WHATSAPP_VERIFY_TOKEN,
 *   connectionCallback: (connection, call) => void runBot(connection, call),
 * });
 * Bun.serve({ port: 8080, routes: { "/webhook": { GET: handler, POST: handler } } });
 * ```
 */

import { logger } from "@pipedog/core/utils/logger";
import { parseWebhookRequest, WebhookValidationError } from "./api.ts";
import type { WhatsAppClient, WhatsAppConnectionCallback } from "./client.ts";

export interface WhatsAppWebhookHandlerOptions {
  /** The verify token you entered in the Meta app dashboard. */
  verifyToken: string;
  /** Invoked with each new connection (see `HandleWebhookRequestOptions`). */
  connectionCallback?: WhatsAppConnectionCallback | null;
}

/** Create the webhook endpoint's handler. */
export function whatsAppWebhookHandler(
  client: WhatsAppClient,
  options: WhatsAppWebhookHandlerOptions,
): (request: Request) => Promise<Response> {
  return async (request) => {
    if (request.method === "GET") {
      const params = Object.fromEntries(new URL(request.url).searchParams);
      try {
        const challenge = await client.handleVerifyWebhookRequest(params, options.verifyToken);
        return new Response(String(challenge), { status: 200 });
      } catch (e) {
        logger.warning(`WhatsApp webhook verification failed: ${e}`);
        return new Response("Forbidden", { status: 403 });
      }
    }
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });

    const rawBody = new Uint8Array(await request.arrayBuffer());
    let body: ReturnType<typeof parseWebhookRequest>;
    try {
      body = parseWebhookRequest(JSON.parse(new TextDecoder().decode(rawBody)));
    } catch (e) {
      const message = e instanceof WebhookValidationError ? e.message : "invalid JSON";
      return new Response(message, { status: 400 });
    }
    try {
      await client.handleWebhookRequest(body, {
        connectionCallback: options.connectionCallback,
        rawBody,
        sha256Signature: request.headers.get("x-hub-signature-256"),
      });
      return Response.json({ status: "ok" });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const status = /signature|Missing raw|No supported event/i.test(message) ? 400 : 500;
      return Response.json({ error: message }, { status });
    }
  };
}
