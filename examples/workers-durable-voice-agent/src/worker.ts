// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// The Worker: routes each voice session to its own Durable Object. A session is
// identified by the path, /api/session/<id>, and every id gets a Durable Object
// of its own, so sessions run in parallel.

import type { VoiceSession } from "./voice_session.ts";

export { VoiceSession } from "./voice_session.ts";

export interface Env {
  VOICE_SESSION: DurableObjectNamespace<VoiceSession>;
  OPENAI_API_KEY: string;
  /** Optional: an OpenAI-compatible API base URL. */
  OPENAI_BASE_URL?: string;
  /** Optional: the realtime transcription WebSocket URL. */
  OPENAI_REALTIME_URL?: string;
  /** Optional: an OTLP/HTTP traces endpoint; see observability.ts. */
  OTEL_EXPORTER_OTLP_ENDPOINT?: string;
  /** Optional: where pipeline errors are POSTed; see observability.ts. */
  ERROR_WEBHOOK_URL?: string;
}

const SESSION_PATH = /^\/api\/session\/([A-Za-z0-9_-]{1,64})$/;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const match = SESSION_PATH.exec(new URL(request.url).pathname);
    if (!match) return new Response("not found", { status: 404 });
    // The same id always reaches the same Durable Object.
    return env.VOICE_SESSION.getByName(match[1]!).fetch(request);
  },
} satisfies ExportedHandler<Env>;
