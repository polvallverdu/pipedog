// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Runs the Worker under `wrangler dev` (workerd) for the tests and the local widget demo.

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

export const EXAMPLE = join(import.meta.dir, "..");
const WRANGLER = join(EXAMPLE, "node_modules", ".bin", "wrangler");
const LOG_DIR = join(EXAMPLE, "node_modules", ".cache", "landing-demo-e2e");
const STARTUP_TIMEOUT_MS = 180_000;

export interface WranglerDev {
  base: string;
  port: number;
  logFile: string;
  stop(): void;
}

export interface WranglerDevOptions {
  /** The wrangler config; defaults to the test one (no AI binding). */
  config?: string;
  /** `NAME:value` pairs, passed with --var. */
  vars: string[];
  /** A fixed port; a free one by default. */
  port?: number;
  logName?: string;
}

/** Start `wrangler dev` and resolve once it reports it is ready. */
export async function startWranglerDev(options: WranglerDevOptions): Promise<WranglerDev> {
  mkdirSync(LOG_DIR, { recursive: true });
  let port = options.port ?? 0;
  if (!port) {
    const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
    port = probe.port;
    probe.stop(true);
  }
  const proc = Bun.spawn(
    [
      WRANGLER,
      "dev",
      "--config",
      options.config ?? join(EXAMPLE, "test", "wrangler.e2e.jsonc"),
      "--port",
      String(port),
      "--ip",
      "127.0.0.1",
      ...options.vars.flatMap((v) => ["--var", v]),
      // Fresh Durable Object storage each run: the budget starts empty.
      "--persist-to",
      mkdtempSync(join(LOG_DIR, "state-")),
    ],
    { cwd: EXAMPLE, stdout: "pipe", stderr: "pipe", env: { ...process.env, CI: "true" } },
  );

  const logFile = join(LOG_DIR, options.logName ?? "wrangler.log");
  // A writer doesn't truncate the file: remove the last run's log first.
  rmSync(logFile, { force: true });
  const log = Bun.file(logFile).writer();
  const ready = new Promise<void>((resolve, reject) => {
    const scan = async (stream: ReadableStream<Uint8Array>) => {
      const decoder = new TextDecoder();
      for await (const chunk of stream) {
        log.write(chunk);
        log.flush();
        if (decoder.decode(chunk).includes("Ready on")) resolve();
      }
    };
    scan(proc.stdout as ReadableStream<Uint8Array>).catch(reject);
    scan(proc.stderr as ReadableStream<Uint8Array>).catch(reject);
    proc.exited.then((code) => reject(new Error(`wrangler exited with code ${code}`)));
  });
  try {
    await Promise.race([
      ready,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("wrangler dev did not start")), STARTUP_TIMEOUT_MS),
      ),
    ]);
  } catch (e) {
    proc.kill();
    throw e;
  }
  const base = `http://127.0.0.1:${port}`;
  // The first request compiles the Worker.
  await fetch(`${base}/api/status`);
  return { base, port, logFile, stop: () => proc.kill() };
}

/** The Worker's warnings and errors, for a failure on CI where the log isn't shown. */
export async function printProblems(logFile: string): Promise<void> {
  const log = Bun.file(logFile);
  if (!(await log.exists())) return;
  const problems = (await log.text())
    .split("\n")
    .filter((line) => /\b(ERROR|WARNING|Uncaught)\b/.test(line));
  if (problems.length)
    console.log(`Worker warnings and errors:\n${problems.slice(-40).join("\n")}`);
}

export const STARTUP_TIMEOUT = STARTUP_TIMEOUT_MS + 30_000;
