// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Acceptance test for the voice bot, once per provider: headless Chromium plays
// a scripted user (a recorded question as the microphone) and the bot answers it
// through the whole pipeline: SmallWebRTC in, transcription, chat and speech
// synthesis, SmallWebRTC out. The provider APIs are replaced by mock_openai.ts
// and mock_google.ts, so the test needs no API key.
//
// The browser loads the Pipecat SDK from esm.sh, as the page does; the test
// serves those URLs from local bundles of the same packages instead.
//
// Needs a Chromium for playwright-core (`bunx playwright install chromium`, or
// PIPEDOG_E2E_CHROMIUM=<path>); skipped when none is found.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { trace } from "@opentelemetry/api";
import { startMockGoogle } from "@pipedog/example-test-mocks/mock_google";
import {
  type MockObservability,
  startMockObservability,
} from "@pipedog/example-test-mocks/mock_observability";
import { type MockOpenAI, startMockOpenAI } from "@pipedog/example-test-mocks/mock_openai";
import {
  ANSWER,
  type ProviderMock,
  SCRIPTED_QUESTION,
} from "@pipedog/example-test-mocks/mock_provider";
import { forceFlushTracing, shutdownTracing } from "@pipedog/tracing";
import type { Browser, BrowserContext, Page } from "playwright-core";
import type { VoiceProvider } from "../src/bot.ts";
import { createServer } from "../src/server.ts";

const MOCKS: Record<VoiceProvider, () => ProviderMock> = {
  openai: startMockOpenAI,
  google: startMockGoogle,
};

const HERE = import.meta.dir;
const CACHE = join(HERE, "..", "node_modules", ".cache", "voice-bot-e2e");
const QUESTION_WAV = join(HERE, "..", "..", "test-mocks", "assets", "capital_question.wav");

async function findChromium(): Promise<string | null> {
  if (process.env.PIPEDOG_E2E === "0") return null;
  const explicit = process.env.PIPEDOG_E2E_CHROMIUM;
  if (explicit) return existsSync(explicit) ? explicit : null;
  try {
    const { chromium } = await import("playwright-core");
    const path = chromium.executablePath();
    return existsSync(path) ? path : null;
  } catch {
    return null;
  }
}

const chromiumPath = await findChromium();
if (!chromiumPath) {
  console.log(
    "voice bot e2e: skipping: no Chromium for playwright-core " +
      "(run `bunx playwright install chromium` or set PIPEDOG_E2E_CHROMIUM)",
  );
}

/** Local bundles that stand in for the two esm.sh imports in public/index.html. */
let clientBundle = "";
let transportBundle = "";

beforeAll(async () => {
  if (!chromiumPath) return;
  mkdirSync(CACHE, { recursive: true });
  const bundle = async (source: string) => {
    const entry = join(CACHE, `entry-${Bun.hash(source)}.ts`);
    await Bun.write(entry, source);
    const built = await Bun.build({ entrypoints: [entry], target: "browser", format: "esm" });
    if (!built.success) throw new Error(built.logs.map(String).join("\n"));
    return built.outputs[0]!.text();
  };
  clientBundle = await bundle(`export * from "@pipecat-ai/client-js";`);
  transportBundle = await bundle(`export * from "@pipecat-ai/small-webrtc-transport";`);
});

/**
 * The recorded question followed by 1.5 s of silence, written to the cache. The
 * original ends about 0.1 s after the last word, too short for the turn to end, and
 * the fake microphone loops the file.
 */
function paddedQuestionWav(): string {
  const source = readFileSync(QUESTION_WAV);
  const at = source.indexOf("data");
  const size = source.readUInt32LE(at + 4);
  const speech = source.subarray(at + 8, at + 8 + size);
  const silence = new Uint8Array(24000 * 2 * 1.5);
  const pcm = new Uint8Array(speech.length + silence.length);
  pcm.set(speech);
  pcm.set(silence, speech.length);

  const header = new DataView(new ArrayBuffer(44));
  const text = (offset: number, s: string) =>
    [...s].forEach((c, i) => {
      header.setUint8(offset + i, c.charCodeAt(0));
    });
  text(0, "RIFF");
  header.setUint32(4, 36 + pcm.length, true);
  text(8, "WAVEfmt ");
  header.setUint32(16, 16, true);
  header.setUint16(20, 1, true); // PCM
  header.setUint16(22, 1, true); // mono
  header.setUint32(24, 24000, true);
  header.setUint32(28, 48000, true);
  header.setUint16(32, 2, true);
  header.setUint16(34, 16, true);
  text(36, "data");
  header.setUint32(40, pcm.length, true);

  const out = join(CACHE, "capital_question_padded.wav");
  writeFileSync(out, Buffer.concat([new Uint8Array(header.buffer), pcm]));
  return out;
}

/**
 * Records every RTCPeerConnection the SDK creates, and the loudest level of the
 * bot's remote audio track (`window.__maxRms`), measured with an analyser.
 */
function captureRtcConnections(): void {
  const audio = new AudioContext();
  (window as any).__audio = audio;
  const samples = new Float32Array(2048);
  (window as any).__pcs = [];
  (window as any).__maxRms = 0;
  const onTrack = (event: RTCTrackEvent) => {
    if (event.track.kind !== "audio") return;
    const player = new Audio();
    player.srcObject = new MediaStream([event.track]);
    player.play().catch(() => {});
    const analyser = audio.createAnalyser();
    analyser.fftSize = samples.length;
    audio.createMediaStreamSource(new MediaStream([event.track])).connect(analyser);
    setInterval(() => {
      analyser.getFloatTimeDomainData(samples);
      let sum = 0;
      for (const v of samples) sum += v * v;
      const rms = Math.sqrt(sum / samples.length);
      (window as any).__maxRms = Math.max((window as any).__maxRms, rms);
    }, 50);
  };
  const Original = window.RTCPeerConnection;
  window.RTCPeerConnection = class extends Original {
    constructor(...args: ConstructorParameters<typeof RTCPeerConnection>) {
      super(...args);
      (window as any).__pcs.push(this);
      this.addEventListener("track", onTrack);
    }
  } as typeof RTCPeerConnection;
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for the bot");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

// Tracing and error alerts go to a mock collector and webhook (see
// src/observability.ts). Tracing is set up once per process, on the first session.
let observability: MockObservability;
beforeAll(() => {
  observability = startMockObservability();
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT = observability.tracesUrl;
  process.env.ERROR_WEBHOOK_URL = observability.webhookUrl;
});
afterAll(async () => {
  // Leave the process as it was: other test files set up tracing themselves.
  delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  delete process.env.ERROR_WEBHOOK_URL;
  await shutdownTracing();
  trace.disable();
  observability?.stop();
});

/**
 * Serve the bot against `mock`, connect headless Chromium as the scripted user,
 * run `check` on the connected page, and tear everything down.
 */
async function withSession(
  provider: VoiceProvider,
  mock: ProviderMock,
  check: (page: Page, errors: string[]) => Promise<void>,
): Promise<void> {
  const { chromium } = await import("playwright-core");
  const server = createServer({ provider, apiKey: "test-key", baseUrl: mock.baseUrl });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  const browser: Browser = await chromium.launch({
    executablePath: chromiumPath!,
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
      `--use-file-for-fake-audio-capture=${paddedQuestionWav()}`,
      "--autoplay-policy=no-user-gesture-required",
    ],
  });
  let context: BrowserContext | null = null;
  try {
    context = await browser.newContext();
    await context.route("https://esm.sh/**", (route) =>
      route.fulfill({
        contentType: "text/javascript",
        body: route.request().url().includes("client-js") ? clientBundle : transportBundle,
      }),
    );
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript(captureRtcConnections);
    await page.goto(`http://127.0.0.1:${port}/`);

    await page.click("#connect");
    await page.evaluate(() => (window as any).__audio.resume());
    await page.waitForFunction(() =>
      document.querySelector("#status")?.textContent?.startsWith("Connected"),
    );
    await check(page, errors);
  } finally {
    await context?.close();
    await browser.close();
    server.close();
    mock.stop();
  }
}

for (const provider of ["openai", "google"] as const) {
  test.skipIf(!chromiumPath)(
    `${provider}: the voice bot answers a spoken question in the browser`,
    async () => {
      const mock = MOCKS[provider]();
      await withSession(provider, mock, async (page, errors) => {
        // The bot greets the user, then answers the scripted question.
        await waitFor(() => mock.spoken.includes(ANSWER), 60_000);

        // The browser received the bot's speech: the audio follows the synthesis
        // request, so wait until the remote track has a level.
        const loudest = () => page.evaluate(() => (window as any).__maxRms as number);
        let level = await loudest();
        for (let i = 0; i < 100 && level <= 0.01; i++) {
          await new Promise((resolve) => setTimeout(resolve, 100));
          level = await loudest();
        }
        expect(level).toBeGreaterThan(0.01);

        // The user's audio was transcribed, and the transcript reached the chat model.
        expect(mock.heard).toBeGreaterThan(1000);
        expect(mock.asked.some((question) => question.includes(SCRIPTED_QUESTION))).toBe(true);

        expect(errors).toEqual([]);
      });

      // The conversation was traced.
      await forceFlushTracing();
      expect(observability.traces.length).toBeGreaterThan(0);
    },
    90_000,
  );
}

test.skipIf(!chromiumPath)(
  "a pipeline error is posted to the error webhook",
  async () => {
    const mock = startMockOpenAI() as MockOpenAI;
    mock.failChat = true;
    const before = observability.alerts.length;
    await withSession("openai", mock, async () => {
      await waitFor(() => observability.alerts.length > before, 60_000);
    });
    const alert = observability.alerts[before]!;
    expect(String(alert.text)).toContain("Voice bot error in conversation");
    expect(typeof alert.conversationId).toBe("string");
    expect(String(alert.error).length).toBeGreaterThan(0);
  },
  90_000,
);
