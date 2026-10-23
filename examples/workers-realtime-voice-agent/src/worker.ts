// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// The Worker: serves the page (from public/, by the assets binding) and routes each call to its
// own Durable Object. A call is identified by the path, /api/call/<id>/..., and every id gets a
// Durable Object of its own, so calls run in parallel.

import type { VoiceCall } from "./voice_call.ts";

export { VoiceCall } from "./voice_call.ts";

export interface Env {
  VOICE_CALL: DurableObjectNamespace<VoiceCall>;
  /** The Realtime SFU app's ID and secret (Dashboard > Realtime > SFU). */
  CLOUDFLARE_REALTIME_APP_ID: string;
  CLOUDFLARE_REALTIME_APP_SECRET: string;
  /** Optional: the Realtime API base URL (the tests point it at a fake SFU). */
  CLOUDFLARE_REALTIME_API_URL?: string;
  OPENAI_API_KEY: string;
  /** Optional: an OpenAI-compatible API base URL. */
  OPENAI_BASE_URL?: string;
  /** Optional: the realtime transcription WebSocket URL. */
  OPENAI_REALTIME_URL?: string;
}

const CALL_PATH = /^\/api\/call\/([A-Za-z0-9_-]{1,64})\//;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const match = CALL_PATH.exec(new URL(request.url).pathname);
    if (!match) return new Response("not found", { status: 404 });
    // The same id always reaches the same Durable Object.
    return env.VOICE_CALL.getByName(match[1]!).fetch(request);
  },
} satisfies ExportedHandler<Env>;
