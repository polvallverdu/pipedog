// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Acceptance test for the voice bot, once per provider: headless Chromium plays
// a scripted user (a recorded question as the microphone) and the bot answers it
// through the whole pipeline: protobuf frames over the WebSocket in,
// transcription, chat and speech synthesis, protobuf frames out. The provider
// APIs are replaced by mock_openai.ts and mock_google.ts, so the test needs no
// API key.
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
  GREETING,
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
  transportBundle = await bundle(`export * from "@pipecat-ai/websocket-transport";`);
});

/**
 * The recorded question between 2.5 s and 1.5 s of silence, written to the cache.
 *
 * The fake microphone starts playing the file as soon as the page connects, while
 * the bot is still getting ready to greet. The original starts talking 0.05 s in, so
 * the scripted user cut the greeting short: about 0.3 s after the bot started
 * speaking under load, before the second sentence, which the bot then never said
 * (nor showed). The silence before lets the user wait for the greeting (1 s of
 * speech) to end. The original ends about 0.1 s after the last word, too short for
 * the turn to end, and the fake microphone loops the file.
 */
function paddedQuestionWav(): string {
  const source = readFileSync(QUESTION_WAV);
  const at = source.indexOf("data");
  const size = source.readUInt32LE(at + 4);
  const speech = source.subarray(at + 8, at + 8 + size);
  const before = new Uint8Array(24000 * 2 * 2.5);
  const after = new Uint8Array(24000 * 2 * 1.5);
  const pcm = new Uint8Array(before.length + speech.length + after.length);
  pcm.set(speech, before.length);

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
 * Counts the bytes the page receives over WebSockets (`window.__received`), and
 * records the loudest level of what the page plays (`window.__maxRms`): every
 * node the SDK connects to the speakers is also connected to an analyser.
 */
function captureAudio(): void {
  (window as any).__received = 0;
  (window as any).__maxRms = 0;
  (window as any).__contexts = [];

  const Socket = window.WebSocket;
  window.WebSocket = class extends Socket {
    constructor(...args: ConstructorParameters<typeof WebSocket>) {
      super(...args);
      this.addEventListener("message", (event: MessageEvent) => {
        const data = event.data;
        const size =
          data instanceof ArrayBuffer ? data.byteLength : data instanceof Blob ? data.size : 0;
        (window as any).__received += size;
      });
    }
  } as typeof WebSocket;

  const samples = new Float32Array(2048);
  const tapped = new WeakSet<AudioNode>();
  const connect = AudioNode.prototype.connect as (...args: unknown[]) => unknown;
  AudioNode.prototype.connect = function (this: AudioNode, ...args: unknown[]) {
    const result = connect.apply(this, args);
    if (args[0] instanceof AudioDestinationNode && !tapped.has(this)) {
      tapped.add(this);
      (window as any).__contexts.push(this.context);
      const analyser = this.context.createAnalyser();
      analyser.fftSize = samples.length;
      connect.call(this, analyser);
      setInterval(() => {
        analyser.getFloatTimeDomainData(samples);
        let sum = 0;
        for (const v of samples) sum += v * v;
        const rms = Math.sqrt(sum / samples.length);
        (window as any).__maxRms = Math.max((window as any).__maxRms, rms);
      }, 50);
    }
    return result;
  } as typeof AudioNode.prototype.connect;
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
    // The page needs nothing from the network but the SDK: anything else fails
    // the test, so it can't come to depend on a third-party CDN.
    const external: string[] = [];
    await context.route(
      (url) => url.hostname !== "127.0.0.1",
      (route) => {
        const url = route.request().url();
        if (!url.startsWith("https://esm.sh/")) {
          external.push(url);
          return route.abort();
        }
        return route.fulfill({
          contentType: "text/javascript",
          body: url.includes("client-js") ? clientBundle : transportBundle,
        });
      },
    );
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript(captureAudio);
    await page.goto(`http://127.0.0.1:${port}/`);

    await page.click("#connect");
    await page.waitForFunction(() =>
      document.querySelector("#status")?.textContent?.startsWith("Connected"),
    );
    await check(page, errors);
    expect(external).toEqual([]);
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

        // The browser received the bot's speech over the WebSocket, the greeting's
        // and the answer's (0.5 s of 24 kHz PCM each), and played it. The audio
        // follows the synthesis request, so wait for it.
        const received = () => page.evaluate(() => (window as any).__received as number);
        const loudest = () => page.evaluate(() => (window as any).__maxRms as number);
        for (
          let i = 0;
          i < 100 && ((await received()) <= 2 * 24000 || (await loudest()) <= 0.01);
          i++
        ) {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        expect(await received()).toBeGreaterThan(2 * 24000);
        expect(await loudest()).toBeGreaterThan(0.01);

        // The user's audio was transcribed, and the transcript reached the chat model.
        expect(mock.heard).toBeGreaterThan(1000);
        expect(mock.asked.some((question) => question.includes(SCRIPTED_QUESTION))).toBe(true);

        // The page's transcript shows both sides of the conversation, from RTVI
        // messages carried in the same protobuf frames.
        await page.waitForFunction(
          (answer) => document.querySelector("#transcript")?.textContent?.includes(answer),
          ANSWER,
        );
        const user = await page.locator("#transcript .user").allTextContents();
        const bot = await page.locator("#transcript .bot").allTextContents();
        expect(user.some((line) => line.includes(SCRIPTED_QUESTION))).toBe(true);
        // Each sentence is shown once, though it is reported again once spoken.
        expect(bot.filter((line) => line === GREETING)).toHaveLength(1);
        expect(bot.some((line) => line.includes(ANSWER))).toBe(true);

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
