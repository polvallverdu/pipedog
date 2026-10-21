// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

import type { SmallWebRTCConnection } from "@pipedog/transport-smallwebrtc/connection";
import type { WhatsAppWebhookRequest } from "../src/index.ts";

export const OFFER_SDP = "v=0\r\no=- 1 1 IN IP4 0.0.0.0\r\ns=-\r\n";
export const ANSWER_SDP = [
  "v=0",
  "a=fingerprint:sha-256 AA:BB",
  "a=fingerprint:sha-384 CC:DD",
  "a=fingerprint:sha-512 EE:FF",
  "a=setup:active",
].join("\r\n");

export interface FakeConnection {
  initialized: Array<[string, string]>;
  disconnects: number;
  handlers: Map<string, Array<(c: unknown) => unknown>>;
  pcId: string;
  initialize(sdp: string, type: string): Promise<void>;
  getAnswer(): { sdp: string; type: string; pc_id: string } | null;
  disconnect(): Promise<void>;
  eventHandler(name: string, fn: (c: unknown) => unknown): void;
}

export function fakeConnection(answer: string | null = ANSWER_SDP): FakeConnection {
  const c: FakeConnection = {
    initialized: [],
    disconnects: 0,
    handlers: new Map(),
    pcId: "pc-1",
    async initialize(sdp, type) {
      c.initialized.push([sdp, type]);
    },
    getAnswer: () => (answer === null ? null : { sdp: answer, type: "answer", pc_id: "pc-1" }),
    async disconnect() {
      c.disconnects++;
    },
    eventHandler(name, fn) {
      c.handlers.set(name, [...(c.handlers.get(name) ?? []), fn]);
    },
  };
  return c;
}

export const asConnection = (c: FakeConnection) => c as unknown as SmallWebRTCConnection;

export interface Recorded {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

/** A fetch that records calls and answers with `respond(body)`. */
export function recordingFetch(
  respond: (body: Record<string, unknown>) => unknown = () => ({
    messaging_product: "whatsapp",
    success: true,
  }),
) {
  const calls: Recorded[] = [];
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    calls.push({
      url: String(url),
      headers: init?.headers as Record<string, string>,
      body,
    });
    return Response.json(respond(body));
  }) as typeof fetch;
  return { fetch: fn, calls };
}

export function connectWebhook(callId = "wacid.1", sdp = OFFER_SDP): WhatsAppWebhookRequest {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "WABA",
        changes: [
          {
            field: "calls",
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: "+1 555 0100", phone_number_id: "PN1" },
              contacts: [{ profile: { name: "Ada" }, wa_id: "34600000000" }],
              calls: [
                {
                  id: callId,
                  from: "34600000000",
                  to: "15550100",
                  event: "connect",
                  timestamp: "1700000000",
                  direction: "USER_INITIATED",
                  session: { sdp, sdp_type: "offer" },
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

export function terminateWebhook(callId = "wacid.1"): WhatsAppWebhookRequest {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "WABA",
        changes: [
          {
            field: "calls",
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: "+1 555 0100", phone_number_id: "PN1" },
              calls: [
                {
                  id: callId,
                  from: "34600000000",
                  to: "15550100",
                  event: "terminate",
                  timestamp: "1700000100",
                  direction: "USER_INITIATED",
                  status: "COMPLETED",
                  duration: 12,
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

export async function sign(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
  return `sha256=${Array.from(mac, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}
