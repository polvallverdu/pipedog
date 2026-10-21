// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// The phone bot as one fetch handler, `(Request) => Promise<Response>`, with
// two routes:
//
//   POST /twiml  Twilio's voice webhook. Answers the call with TwiML that
//                connects it to the media stream: <Connect><Stream url="wss://…/ws">.
//   GET  /ws     The Media Streams WebSocket, upgraded by `websocketFetchHandler`.
//                Each connection is one call, answered by `runPhoneBot`.
//
// Serve it with `serveFetch` on Bun or Node (src/server.ts), `Deno.serve`
// (src/deno.ts), a Cloudflare Worker or Durable Object, or a framework route.
// On Bun the second argument is the server, which upgrades the WebSocket.

import { rethrowIfCancelled } from "@pipedog/asyncio";
import { base64ToBytes, bytesToBase64 } from "@pipedog/core/utils/base64";
import { type UpgradingServer, websocketFetchHandler } from "@pipedog/transport-websocket/fetch";
import { type PhoneBotOptions, runPhoneBot } from "./bot.ts";

export interface PhoneAppOptions extends PhoneBotOptions {
  /**
   * The public base URL Twilio reaches this server at (e.g.
   * `https://abc.ngrok.app`). It builds the stream URL and checks webhook
   * signatures, which Twilio computes over the URL it called. Defaults to the
   * request's own URL, which is wrong behind most proxies and tunnels.
   */
  publicUrl?: string | null;
  /**
   * Check the `X-Twilio-Signature` of webhook requests with `twilioAuthToken`.
   * Defaults to true when an auth token is set.
   */
  validateWebhook?: boolean;
}

/** Escape text for an XML attribute. */
function xmlAttr(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

/**
 * The TwiML that connects a call to a bidirectional media stream at
 * `streamUrl`. The `parameters` arrive in the stream's `start` message
 * (`customParameters`); `from_number` and `to_number` become
 * `callData.fromNumber` and `callData.toNumber`.
 */
export function connectStreamTwiml(streamUrl: string, parameters: Record<string, string>): string {
  const params = Object.entries(parameters)
    .map(([name, value]) => `<Parameter name="${xmlAttr(name)}" value="${xmlAttr(value)}" />`)
    .join("");
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    `<Response><Connect><Stream url="${xmlAttr(streamUrl)}">${params}</Stream></Connect></Response>`
  );
}

/**
 * Twilio's request signature: HMAC-SHA1 of the full URL followed by each POST
 * parameter's name and value, sorted by name, keyed with the auth token, in
 * base64. See https://www.twilio.com/docs/usage/security#validating-requests.
 */
export async function twilioSignature(
  authToken: string,
  url: string,
  params: Record<string, string>,
): Promise<string> {
  const data =
    url +
    Object.keys(params)
      .sort()
      .map((k) => k + params[k])
      .join("");
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(authToken),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return bytesToBase64(new Uint8Array(mac));
}

/** Compare two base64 signatures in constant time. */
function sameSignature(a: string, b: string): boolean {
  let x: Uint8Array;
  let y: Uint8Array;
  try {
    x = base64ToBytes(a);
    y = base64ToBytes(b);
  } catch (e) {
    rethrowIfCancelled(e);
    return false;
  }
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= (x[i] as number) ^ (y[i] as number);
  return diff === 0;
}

/** Build the phone bot's fetch handler. */
export function createPhoneApp(
  options: PhoneAppOptions,
): (request: Request, server?: UpgradingServer | null) => Promise<Response> {
  const media = websocketFetchHandler((connection) => runPhoneBot(connection, options));
  const validate = options.validateWebhook ?? Boolean(options.twilioAuthToken);

  /** The URL as Twilio sees it: `publicUrl` + the path and query. */
  const publicUrl = (request: Request): URL => {
    const url = new URL(request.url);
    return options.publicUrl ? new URL(url.pathname + url.search, options.publicUrl) : url;
  };

  async function twiml(request: Request): Promise<Response> {
    const params: Record<string, string> = {};
    if (request.method === "POST") {
      for (const [k, v] of new URLSearchParams(await request.text())) params[k] = v;
    }
    const url = publicUrl(request);
    if (validate) {
      if (!options.twilioAuthToken) throw new Error("validateWebhook needs twilioAuthToken");
      const expected = await twilioSignature(options.twilioAuthToken, url.href, params);
      const given = request.headers.get("x-twilio-signature") ?? "";
      if (!sameSignature(given, expected)) {
        return new Response("invalid Twilio signature", { status: 403 });
      }
    }
    const stream = new URL("/ws", url);
    stream.protocol = stream.protocol === "http:" ? "ws:" : "wss:";
    const body = connectStreamTwiml(stream.href, {
      from_number: params.From ?? "",
      to_number: params.To ?? "",
    });
    return new Response(body, { headers: { "content-type": "text/xml; charset=utf-8" } });
  }

  return async (request: Request, server?: UpgradingServer | null): Promise<Response> => {
    const { pathname } = new URL(request.url);
    if (pathname === "/twiml") return twiml(request);
    if (pathname === "/ws") return media(request, server);
    return new Response("not found", { status: 404 });
  };
}
