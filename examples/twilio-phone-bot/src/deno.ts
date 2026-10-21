// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Serve the phone bot with Deno.serve, which upgrades WebSockets from fetch.
//
//   deno run --allow-net --allow-env --allow-read src/deno.ts
//
// Environment: OPENAI_API_KEY; TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN (hang-up
// and webhook signatures); PUBLIC_URL (the URL Twilio reaches, e.g. your ngrok
// URL); PORT (default 8765). Optional: OPENAI_BASE_URL, OPENAI_REALTIME_URL,
// TWILIO_API_BASE_URL.

import { createPhoneApp } from "./app.ts";

// Deno's globals, declared here so the file type-checks with the Bun types.
declare const Deno: {
  env: { get(name: string): string | undefined };
  serve(
    options: { port: number; hostname?: string; onListen?: (addr: { port: number }) => void },
    handler: (request: Request) => Response | Promise<Response>,
  ): unknown;
};

const env = (name: string) => Deno.env.get(name) || null;

const app = createPhoneApp({
  openaiApiKey: env("OPENAI_API_KEY") ?? "",
  openaiBaseUrl: env("OPENAI_BASE_URL"),
  openaiRealtimeUrl: env("OPENAI_REALTIME_URL"),
  twilioAccountSid: env("TWILIO_ACCOUNT_SID"),
  twilioAuthToken: env("TWILIO_AUTH_TOKEN"),
  twilioApiBaseUrl: env("TWILIO_API_BASE_URL"),
  publicUrl: env("PUBLIC_URL"),
});

Deno.serve(
  {
    port: Number(env("PORT") ?? 8765),
    hostname: env("HOST") ?? "0.0.0.0",
    onListen: ({ port }) => console.log(`Twilio phone bot listening on port ${port}`),
  },
  app,
);
