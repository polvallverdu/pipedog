// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// The demo page (SvelteKit, served by the Worker) in a real Chromium, against the fakes: press
// the mic, and the conversation, the tool card and the metrics appear, through Pipecat's own
// browser client over the WebSocket. Chromium's fake microphone supplies the audio (the fake Flux
// only counts it). The WebRTC switch is checked disabled here (no Realtime credentials); WebRTC
// itself is covered by e2e.test.ts against a fake SFU, since a fake SFU can't do real WebRTC.
//
// Needs a Chromium for playwright-core (`bunx playwright-core install chromium`, or set
// PIPEDOG_E2E_CHROMIUM); skipped without one, or with PIPEDOG_E2E=0.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import type { Browser } from "playwright-core";
import { type Fakes, fakeVars, startFakes } from "./fakes.ts";
import {
  printProblems,
  STARTUP_TIMEOUT,
  startWranglerDev,
  type WranglerDev,
} from "./wrangler_dev.ts";

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
  console.log("landing demo browser test: skipping, no Chromium for playwright-core");
}

let fakes: Fakes;
let worker: WranglerDev | null = null;
let browser: Browser | null = null;

beforeAll(async () => {
  if (!chromiumPath) return;
  fakes = startFakes({ turns: ["What's the weather in Barcelona?"], turnEvery: 90 });
  worker = await startWranglerDev({
    vars: [
      "ANTHROPIC_API_KEY:test-anthropic-key",
      "SESSION_SIGNING_KEY:test-signing-key",
      "DEMO_DEV_MODE:true",
      ...fakeVars(fakes.url),
    ],
    logName: "wrangler-browser.log",
  });
  const { chromium } = await import("playwright-core");
  browser = await chromium.launch({
    executablePath: chromiumPath,
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
      "--autoplay-policy=no-user-gesture-required",
    ],
  });
}, STARTUP_TIMEOUT);

afterAll(async () => {
  await browser?.close();
  if (worker) await printProblems(worker.logFile);
  worker?.stop();
  fakes?.stop();
});

test.skipIf(!chromiumPath)(
  "the page: tap the mic, and the chat, the tool card and the metrics fill in",
  async () => {
    const context = await browser!.newContext({ permissions: ["microphone"] });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    try {
      await page.goto(`${worker!.base}/`);
      await page.getByText("Ready", { exact: true }).waitFor({ timeout: 15_000 });
      // No Realtime credentials: WebRTC can't be chosen.
      expect(await page.getByRole("radio", { name: "WebRTC" }).isDisabled()).toBe(true);

      await page.getByRole("button", { name: "Start talking" }).click();
      // The greeting, then the user's turn, the tool card, and the answer.
      await page.getByText("I'm a voice agent built with pipedog").waitFor({ timeout: 20_000 });
      await page.getByText("What's the weather in Barcelona?").waitFor({ timeout: 30_000 });
      const card = page.locator(".tool", { hasText: "get_weather" });
      await card.getByText("done").waitFor({ timeout: 20_000 });
      expect(await card.textContent()).toContain("18 °C · partly cloudy · Barcelona");
      await page.getByText("degrees and partly cloudy").waitFor({ timeout: 20_000 });

      // The metrics: the Durable Object's colo, an LLM TTFB, voice to voice, a round trip.
      const metrics = page.locator(".metrics");
      await metrics.getByText("MAD", { exact: true }).waitFor({ timeout: 10_000 });
      await page.waitForFunction(
        () => {
          const text = document.querySelector(".metrics")?.textContent ?? "";
          return /Voice to voice\s*\d/.test(text) && /Round trip\s*\d/.test(text);
        },
        undefined,
        { timeout: 20_000 },
      );
      expect(await metrics.textContent()).toContain("WebSocket · protobuf");

      // Hang up.
      await page.getByRole("button", { name: "End the session" }).click();
      await page.getByText("Session ended", { exact: true }).waitFor({ timeout: 10_000 });
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  },
  120_000,
);

test.skipIf(!chromiumPath)("embedded and dark, from the query string", async () => {
  const page = await browser!.newPage();
  try {
    await page.goto(`${worker!.base}/?embed=1&theme=dark`);
    const classes = await page.evaluate(() => document.documentElement.className);
    expect(classes).toContain("dark");
    expect(classes).toContain("embed");
    // Embedded: the card alone, without the page's own header.
    expect(await page.locator("h1").isVisible()).toBe(false);
    // The landing page switches the theme with a message.
    await page.evaluate(() =>
      window.dispatchEvent(
        new MessageEvent("message", {
          data: { type: "pipedog-theme", theme: "light" },
          source: window.parent,
        }),
      ),
    );
    expect(await page.evaluate(() => document.documentElement.classList.contains("dark"))).toBe(
      false,
    );
  } finally {
    await page.close();
  }
});
