// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Serve the phone bot on Bun (or Node, with the `ws` package) with serveFetch,
// which upgrades the media WebSocket with the runtime's server.
//
//   bun src/server.ts
//
// Environment: as src/deno.ts.

import { serveFetch } from "@pipedog/transport-websocket/serve";
import { createPhoneApp } from "./app.ts";

const env = (name: string) => process.env[name] || null;

const app = createPhoneApp({
  openaiApiKey: env("OPENAI_API_KEY") ?? "",
  openaiBaseUrl: env("OPENAI_BASE_URL"),
  openaiRealtimeUrl: env("OPENAI_REALTIME_URL"),
  twilioAccountSid: env("TWILIO_ACCOUNT_SID"),
  twilioAuthToken: env("TWILIO_AUTH_TOKEN"),
  twilioApiBaseUrl: env("TWILIO_API_BASE_URL"),
  publicUrl: env("PUBLIC_URL"),
});

const server = await serveFetch(app, {
  host: env("HOST") ?? "0.0.0.0",
  port: Number(env("PORT") ?? 8765),
});
console.log(`Twilio phone bot listening on port ${server.port}`);
