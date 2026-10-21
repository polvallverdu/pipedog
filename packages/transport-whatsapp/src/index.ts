// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/**
 * WhatsApp Business calling for pipedog: a port of `pipecat.transports.whatsapp`
 * (`WhatsAppClient`, `WhatsAppApi`). Calls are answered over SmallWebRTC
 * (`@pipedog/transport-smallwebrtc`), so use `SmallWebRTCTransport` with the connection
 * the client hands you.
 *
 * Runtimes: Node, Bun and Deno for whole calls. On Cloudflare Workers only the webhook
 * verification, signature check and API calls work (no WebRTC there).
 */

export * from "./api.ts";
export * from "./client.ts";
export * from "./http.ts";
