// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// The demo page (SvelteKit, served by the Worker) in a real Chromium, against the fakes: press
// the mic, and the conversation, the tool card, the metrics and the pipeline strip fill in, through
// Pipecat's own browser client over the WebSocket. Chromium's fake microphone plays a recorded
// question, then silence, in a loop: Silero VAD in the Worker hears it, and the fake Flux (the
// default) or Nova-3 (chosen on the page) transcribes it as the scripted turn. The WebRTC switch is checked disabled here (no Realtime credentials); WebRTC
// itself is covered by e2e.test.ts against a fake SFU, since a fake SFU can't do real WebRTC.
//
// Needs a Chromium for playwright-core (`bunx playwright-core install chromium`, or set
// PIPEDOG_E2E_CHROMIUM); skipped without one, or with PIPEDOG_E2E=0.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser } from "playwright-core";
import { type Fakes, fakeVars, startFakes } from "./fakes.ts";
import {
  EXAMPLE,
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

/** A 16-bit mono WAV with `secs` of silence appended, for Chromium's looping fake microphone. */
function withSilence(wav: Uint8Array, secs: number): Uint8Array {
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  // Find the "fmt " and "data" chunks.
  let rate = 0;
  let offset = 12;
  let data: Uint8Array | null = null;
  while (offset + 8 <= wav.length) {
    const id = String.fromCharCode(...wav.subarray(offset, offset + 4));
    const size = view.getUint32(offset + 4, true);
    if (id === "fmt ") rate = view.getUint32(offset + 12, true);
    if (id === "data") data = wav.subarray(offset + 8, offset + 8 + size);
    offset += 8 + size + (size % 2);
  }
  if (!data || !rate) throw new Error("not a 16-bit mono WAV");
  const pcm = new Uint8Array(data.length + Math.round(rate * secs) * 2);
  pcm.set(data);
  const out = new Uint8Array(44 + pcm.length);
  const o = new DataView(out.buffer);
  out.set(new TextEncoder().encode("RIFF"), 0);
  o.setUint32(4, 36 + pcm.length, true);
  out.set(new TextEncoder().encode("WAVEfmt "), 8);
  o.setUint32(16, 16, true);
  o.setUint16(20, 1, true); // PCM
  o.setUint16(22, 1, true); // mono
  o.setUint32(24, rate, true);
  o.setUint32(28, rate * 2, true);
  o.setUint16(32, 2, true);
  o.setUint16(34, 16, true);
  out.set(new TextEncoder().encode("data"), 36);
  o.setUint32(40, pcm.length, true);
  out.set(pcm, 44);
  return out;
}

let fakes: Fakes;
let worker: WranglerDev | null = null;
let browser: Browser | null = null;

/**
 * Before the page loads: record every pipeline stage that lights up, since most are lit for a
 * moment only (`window.__stagesLit`).
 */
const RECORD_STAGES = () => {
  const lit = new Set<string>();
  (window as unknown as { __stagesLit: Set<string> }).__stagesLit = lit;
  new MutationObserver((records) => {
    for (const r of records) {
      const el = r.target as HTMLElement;
      if (el.dataset?.active === "true" && el.dataset.stage) lit.add(el.dataset.stage);
    }
  }).observe(document, { subtree: true, attributes: true, attributeFilter: ["data-active"] });
};

const stagesLit = (page: import("playwright-core").Page) =>
  page.evaluate(() => [...(window as unknown as { __stagesLit: Set<string> }).__stagesLit].sort());

beforeAll(async () => {
  if (!chromiumPath) return;
  fakes = startFakes({ turns: ["What's the weather in Barcelona?"] });
  // The question, then long enough a silence that the answer is over before it comes round again.
  const question = readFileSync(
    join(EXAMPLE, "..", "test-mocks", "assets", "capital_question.wav"),
  );
  const micFile = join(mkdtempSync(join(tmpdir(), "landing-demo-mic-")), "mic.wav");
  writeFileSync(micFile, withSilence(question, 20));
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
      `--use-file-for-fake-audio-capture=${micFile}`,
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
  "the page: tap the mic, and the chat, the tool card, the metrics and the strip fill in (Flux)",
  async () => {
    const context = await browser!.newContext({ permissions: ["microphone"] });
    const page = await context.newPage();
    await page.addInitScript(RECORD_STAGES);
    const sttBefore = fakes.sttModels.length;
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    try {
      await page.goto(`${worker!.base}/`);
      await page.getByText("Ready", { exact: true }).waitFor({ timeout: 15_000 });
      // No Realtime credentials: WebRTC can't be chosen. Flux is the default speech to text.
      expect(await page.getByRole("radio", { name: "WebRTC" }).isDisabled()).toBe(true);
      expect(await page.getByRole("radio", { name: /Flux/ }).getAttribute("aria-checked")).toBe(
        "true",
      );
      expect(await page.locator(".stack").textContent()).toContain("Deepgram Flux");

      await page.getByRole("button", { name: "Start talking" }).click();
      // The greeting, then the user's turn, the tool card, and the answer.
      await page.getByText("I'm a voice agent built with pipedog").waitFor({ timeout: 20_000 });
      await page
        .locator(".chat-col")
        .getByText("What's the weather in Barcelona?")
        .waitFor({ timeout: 30_000 });
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
      expect(fakes.sttModels.slice(sttBefore)).toEqual(["@cf/deepgram/flux"]);

      // The strip: every working stage lit up at some point, and the timed ones show a time.
      const strip = page.locator(".pipeline");
      expect(await strip.locator('[data-stage="stt"] .svc').textContent()).toBe("Flux");
      expect(await strip.locator('[data-stage="turn"] .svc').textContent()).toBe("Flux");
      await page.waitForFunction(
        () =>
          ["turn", "llm", "tts", "speaker"].every((stage) =>
            /\d/.test(
              document.querySelector(`.pipeline [data-stage="${stage}"] .ms`)?.textContent ?? "",
            ),
          ),
        undefined,
        { timeout: 20_000 },
      );
      expect(await stagesLit(page)).toEqual(
        ["llm", "mic", "speaker", "stt", "tts", "turn", "vad"].sort(),
      );

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

test.skipIf(!chromiumPath)(
  "Nova-3, chosen on the page: the ticket carries it, and Smart Turn decides",
  async () => {
    const context = await browser!.newContext({ permissions: ["microphone"] });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    const sttBefore = fakes.sttModels.length;
    const smartTurnBefore = fakes.smartTurnRequests;
    try {
      await page.goto(`${worker!.base}/`);
      await page.getByText("Ready", { exact: true }).waitFor({ timeout: 15_000 });
      const nova3 = page.getByRole("radio", { name: /Nova-3/ });
      await nova3.click();
      expect(await nova3.getAttribute("aria-checked")).toBe("true");
      expect(await page.locator(".stack").textContent()).toContain("Nova-3");

      await page.getByRole("button", { name: "Start talking" }).click();
      // The switch is locked while the session runs.
      await page.getByRole("button", { name: "End the session" }).waitFor({ timeout: 15_000 });
      expect(await page.getByRole("radio", { name: /Flux/ }).isDisabled()).toBe(true);
      await page
        .locator(".chat-col")
        .getByText("What's the weather in Barcelona?")
        .waitFor({ timeout: 45_000 });
      expect(fakes.sttModels.slice(sttBefore)).toEqual(["@cf/deepgram/nova-3"]);
      const strip = page.locator(".pipeline");
      expect(await strip.locator('[data-stage="turn"] .svc').textContent()).toBe("Smart Turn");
      await page.waitForFunction(
        () =>
          /\d/.test(document.querySelector('.pipeline [data-stage="turn"] .ms')?.textContent ?? ""),
        undefined,
        { timeout: 20_000 },
      );
      expect(fakes.smartTurnRequests).toBeGreaterThan(smartTurnBefore);

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
