// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// The demo locally with no accounts at all: the fakes (test/fakes.ts) and `wrangler dev` with
// them, on http://127.0.0.1:8787. Open it, press the mic, and a scripted user asks a few
// questions (whatever the microphone hears). For working on the page, and for screenshots.
//
//   bun run --cwd examples/landing-demo dev:fakes

import { startFakeSfu } from "../../workers-realtime-voice-agent/test/fake_sfu.ts";
import { fakeVars, startFakes } from "./fakes.ts";
import { startWranglerDev } from "./wrangler_dev.ts";

const port = Number(process.env.PORT ?? 8787);
const fakes = startFakes({
  turns: [
    "What's the weather in Barcelona?",
    "And where is this call running?",
    "How does turn detection work in pipedog docs?",
  ],
  turnEvery: Number(process.env.TURN_EVERY ?? 160),
  toneMs: 1400,
});
// A fake SFU, so the WebRTC option shows as available (it can't carry real WebRTC).
const sfu = process.env.WITH_WEBRTC ? startFakeSfu() : null;

const worker = await startWranglerDev({
  port,
  vars: [
    "ANTHROPIC_API_KEY:fake",
    "SESSION_SIGNING_KEY:local-dev-key",
    "DEMO_DEV_MODE:true",
    `ALLOWED_ORIGINS:http://localhost:5173,http://localhost:${port}`,
    "FRAME_ANCESTORS:http://localhost:3000,http://127.0.0.1:3000,http://127.0.0.1:4173",
    ...(sfu
      ? [
          "CLOUDFLARE_REALTIME_APP_ID:fake",
          "CLOUDFLARE_REALTIME_APP_SECRET:fake",
          `CLOUDFLARE_REALTIME_API_URL:${sfu.baseUrl}`,
        ]
      : []),
    ...fakeVars(fakes.url),
  ],
  logName: "wrangler-dev-fakes.log",
});
console.log(`The demo, with fakes: ${worker.base}/  (Ctrl-C to stop)`);

const stop = () => {
  worker.stop();
  fakes.stop();
  sfu?.stop();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
await new Promise(() => {});
