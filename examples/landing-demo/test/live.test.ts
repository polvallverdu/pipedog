// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// A live smoke test against the real services: Workers AI through the AI binding (remote, even
// under `wrangler dev`), Claude, Open-Meteo, the published docs index and /cdn-cgi/trace. Skipped
// unless ANTHROPIC_API_KEY, CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN (Workers AI permission)
// are set. It bills both accounts a few cents.
//
//   ANTHROPIC_API_KEY=... CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... \
//     bun test examples/landing-demo/test/live.test.ts
//
// Turnstile is skipped (dev mode without a Turnstile secret); everything else is as deployed.

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { wavToPcm16k } from "../../workers-durable-voice-agent/client/wav.ts";
import { connectBrowser, type RtviMessage } from "./rtvi_client.ts";
import { EXAMPLE, printProblems, STARTUP_TIMEOUT, startWranglerDev } from "./wrangler_dev.ts";

const live = Boolean(
  process.env.ANTHROPIC_API_KEY &&
    process.env.CLOUDFLARE_ACCOUNT_ID &&
    process.env.CLOUDFLARE_API_TOKEN,
);
const ORIGIN = "http://localhost:3000";
const QUESTION_WAV = join(EXAMPLE, "..", "test-mocks", "assets", "capital_question.wav");

test.skipIf(!live)(
  "live: a spoken question gets a transcript and a spoken answer",
  async () => {
    const worker = await startWranglerDev({
      config: join(EXAMPLE, "wrangler.jsonc"),
      vars: [
        `ANTHROPIC_API_KEY:${process.env.ANTHROPIC_API_KEY}`,
        "SESSION_SIGNING_KEY:live-test-signing-key",
        "DEMO_DEV_MODE:true",
        `ALLOWED_ORIGINS:${ORIGIN}`,
      ],
      logName: "wrangler-live.log",
    });
    try {
      const response = await fetch(`${worker.base}/api/session`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: ORIGIN },
        body: "{}",
      });
      expect(response.status).toBe(200);
      const { wsUrl } = (await response.json()) as { wsUrl: string };
      const browser = await connectBrowser(wsUrl, ORIGIN, {
        pcm16k: wavToPcm16k(readFileSync(QUESTION_WAV)),
      });
      try {
        const info = await browser.waitFor(
          (m: RtviMessage) => m.type === "server-message" && m.data?.type === "session-info",
          30_000,
        );
        console.log(`live: Durable Object colo ${info.data.bot_colo}`);
        const transcript = await browser.waitFor(
          (m) => m.type === "user-transcription" && m.data?.final === true,
          60_000,
        );
        console.log(`live: heard "${transcript.data.text}"`);
        await browser.waitFor((m) => m.type === "bot-llm-text", 60_000);
        const latency = await browser.waitFor(
          (m) => m.type === "server-message" && m.data?.type === "voice-latency",
          60_000,
        );
        console.log(`live: voice-to-voice ${latency.data.seconds.toFixed(2)} s`);
        expect(browser.audioBytes()).toBeGreaterThan(0);
      } finally {
        await browser.close();
      }
    } finally {
      await printProblems(worker.logFile);
      worker.stop();
    }
  },
  STARTUP_TIMEOUT + 180_000,
);
