// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// End to end with the unchanged Pipecat browser SDK (@pipecat-ai/client-js +
// @pipecat-ai/small-webrtc-transport) in headless Chromium, against our
// SmallWebRTC transport running a tiny pipeline (e2e/bot.ts) on Bun, Node
// and Deno. Checks bot-ready, RTVI over the data channel (including a
// message larger than an SCTP chunk), audio both ways (tone bursts into the
// mic are played back by the bot), renegotiation, restart_pc, ICE restart,
// and getStats.
//
// Needs a Chromium for playwright-core (`npx playwright install chromium`, or
// PIPEDOG_E2E_CHROMIUM=<path>); skipped when none is found, or with
// PIPEDOG_E2E=0. Runtimes that aren't installed are skipped.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";

const HERE = import.meta.dir;
const OUT = join(HERE, "..", "node_modules", ".cache", "e2e");

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
    "e2e: skipping the browser tests: no Chromium for playwright-core " +
      "(run `npx playwright install chromium` or set PIPEDOG_E2E_CHROMIUM)",
  );
}

const RUNTIMES: { name: string; cmd: string[] | null }[] = [
  { name: "bun", cmd: [process.execPath] },
  { name: "node", cmd: Bun.which("node") ? [Bun.which("node")!] : null },
  { name: "deno", cmd: Bun.which("deno") ? [Bun.which("deno")!, "run", "-A"] : null },
];

let browser: import("playwright-core").Browser | null = null;
const pageBundle = join(OUT, "page.js");

beforeAll(async () => {
  if (!chromiumPath) return;
  const built = await Bun.build({
    entrypoints: [join(HERE, "e2e", "page.ts")],
    target: "browser",
    outdir: OUT,
    naming: "page.js",
  });
  if (!built.success) throw new Error(built.logs.join("\n"));
  const { chromium } = await import("playwright-core");
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PIPEDOG_E2E_CHROMIUM ? chromiumPath : undefined,
    args: ["--autoplay-policy=no-user-gesture-required", "--use-fake-ui-for-media-stream"],
  });
});

afterAll(async () => {
  await browser?.close();
});

interface Bot {
  port: number;
  proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
  /** The bot's log lines. */
  output: string[];
}

async function startBot(cmd: string[]): Promise<Bot> {
  const proc = Bun.spawn([...cmd, join(HERE, "e2e", "bot.ts")], {
    cwd: join(HERE, ".."),
    env: {
      ...process.env,
      PORT: "0",
      PAGE_BUNDLE: pageBundle,
      PIPECAT_LOG_LEVEL: process.env.PIPECAT_LOG_LEVEL ?? "INFO",
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let text = "";
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value);
    const m = /LISTENING (\d+)/.exec(text);
    if (m) {
      // Keep draining so the bot never blocks on a full pipe.
      const output = text.split("\n");
      const drain = async (r: ReadableStreamDefaultReader<Uint8Array>) => {
        for (;;) {
          const { value: chunk, done: end } = await r.read();
          if (end) return;
          output.push(...decoder.decode(chunk).split("\n"));
        }
      };
      void drain(reader);
      void drain(proc.stderr.getReader());
      return { port: Number(m[1]), proc, output };
    }
  }
  proc.kill();
  throw new Error(`bot did not start: ${text}${await new Response(proc.stderr).text()}`);
}

const count = (xs: unknown) => (xs as (number | null)[]).filter((x) => x !== null).length;
const median = (xs: unknown) => {
  const v = (xs as (number | null)[]).filter((x): x is number => x !== null).sort((a, b) => a - b);
  return v.length ? v[v.length >> 1] : null;
};

describe("SmallWebRTC end to end with the Pipecat browser SDK", () => {
  for (const runtime of RUNTIMES) {
    const run = chromiumPath && runtime.cmd ? test : test.skip;
    run(
      `browser <-> bot on ${runtime.name}`,
      async () => {
        const { port, proc, output } = await startBot(runtime.cmd!);
        const page = await browser!.newPage();
        const consoleErrors: string[] = [];
        page.on("console", (m) => {
          if (m.type() === "error") consoleErrors.push(m.text().slice(0, 300));
        });
        page.on("pageerror", (e) => consoleErrors.push(e.message));
        try {
          const url = `http://127.0.0.1:${port}/`;
          await page.goto(url);
          await page.waitForFunction(() => (window as any).__ready);
          const res: any = await page.evaluate(() => (window as any).runTest());
          const summary: any = await (await fetch(`${url}summary`)).json();

          const report = {
            runtime: summary.runtime,
            connectToReadyMs: res.connectToReadyMs,
            dcRttMedianMs: median(res.dcRttMs),
            dcReplies: `${count(res.dcRttMs)}/${res.dcRttMs.length}`,
            bigMessageLength: res.bigMessageLength,
            mediaRttMs: res.mediaRttMs,
            afterRenegotiateRttMs: res.afterRenegotiateRttMs,
            afterRestartPcRttMs: res.afterRestartPcRttMs,
            iceRestart: res.iceRestart,
            afterIceRestartRttMs: res.afterIceRestartRttMs,
            botStats: res.botStats,
            inboundBeforeIceRestart: res.inboundBeforeIceRestart,
            browserAudioStats: res.browserAudioStats,
            server: {
              offers: summary.offers,
              renegotiations: summary.renegotiations,
              restarts: summary.restarts,
              audioFrames: summary.audioFrames,
              loudFrames: summary.loudFrames,
              patchMs: summary.patches.map((p: any) => p.ms),
            },
          };
          console.log(`e2e ${runtime.name}: ${JSON.stringify(report)}`);
          if (consoleErrors.length)
            console.log(`e2e ${runtime.name} browser errors:`, consoleErrors);
          const problems = output.filter((l) => /WARNING|ERROR/.test(l));
          if (problems.length)
            console.log(`e2e ${runtime.name} bot warnings:\n${problems.join("\n")}`);

          // bot-ready, then RTVI over the data channel
          expect(res.botReady).not.toBeNull();
          expect(count(res.dcRttMs)).toEqual(res.dcRttMs.length);
          expect(res.bigMessageLength).toEqual(64 * 1024);
          // audio both ways
          expect(summary.loudFrames).toBeGreaterThan(0);
          expect(count(res.mediaRttMs)).toBeGreaterThanOrEqual(4);
          // no audio lost on loopback outside the ICE restart window
          expect(res.inboundBeforeIceRestart?.lost ?? 0).toBeLessThanOrEqual(2);
          // renegotiation, restart_pc, ICE restart
          expect(summary.renegotiations).toBeGreaterThanOrEqual(2);
          expect(count(res.afterRenegotiateRttMs)).toBeGreaterThanOrEqual(2);
          expect(summary.restarts).toBeGreaterThanOrEqual(1);
          expect(count(res.afterRestartPcRttMs)).toBeGreaterThanOrEqual(2);
          expect(res.iceRestart.error).toBeUndefined();
          expect(res.iceRestart.newRemoteUfrag).not.toEqual(res.iceRestart.oldRemoteUfrag);
          expect(count(res.afterIceRestartRttMs)).toBeGreaterThanOrEqual(2);
          // getStats
          expect(res.botStats?.["candidate-pair"] ?? 0).toBeGreaterThan(0);
          // mDNS candidates don't hold up PATCH /api/offer
          for (const p of summary.patches) expect(p.ms).toBeLessThan(500);
        } finally {
          await page.close();
          proc.kill();
          await proc.exited;
        }
      },
      120_000,
    );
  }
});
