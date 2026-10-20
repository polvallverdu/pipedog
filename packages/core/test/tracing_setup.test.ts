// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

// The optional `@opentelemetry/api` peer (upstream's `is_tracing_available()`):
// detected automatically when installed, overridable with registerOpenTelemetry().
// Without the package (checked by `bun tools/compat/run.ts --package core`),
// loadOpenTelemetry() resolves to false and every helper is a no-op.

import { afterAll, beforeAll, expect, test } from "bun:test";
import * as api from "@opentelemetry/api";
import {
  getOpenTelemetry,
  isTracingAvailable,
  loadOpenTelemetry,
  type OpenTelemetryModules,
  registerOpenTelemetry,
  setupTracing,
} from "../src/utils/tracing/setup.ts";

let previous: OpenTelemetryModules | null = null;
beforeAll(() => {
  previous = getOpenTelemetry();
});
afterAll(() => {
  registerOpenTelemetry(previous);
});

test("the installed @opentelemetry/api is detected", async () => {
  expect(await loadOpenTelemetry()).toBe(true);
  expect(isTracingAvailable()).toBe(true);
  // The same API (one global registry), whichever copy was imported.
  expect(typeof getOpenTelemetry()?.api.trace.getTracer).toBe("function");
});

test("registerOpenTelemetry(null) disables tracing", async () => {
  registerOpenTelemetry(null);
  expect(isTracingAvailable()).toBe(false);
  expect(await loadOpenTelemetry()).toBe(false);
  expect(setupTracing()).toBe(false);
});

test("a traced worker built at module top level still exports spans", () => {
  // In a fresh process, so core's automatic import has not run yet.
  const result = Bun.spawnSync(
    [process.execPath, "run", `${import.meta.dir}/fixtures/top_level_tracing.ts`],
    { stdout: "pipe", stderr: "pipe" },
  );
  const out = result.stdout.toString();
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  const line = out.split("\n").find((l) => l.startsWith("__RESULT__"));
  expect(line, out).toBeDefined();
  const { availableAtConstruction, hasTurnTraceObserver, spans } = JSON.parse(
    line!.slice("__RESULT__".length),
  );
  // The race this guards against: OpenTelemetry was not loaded yet.
  expect(availableAtConstruction).toBe(false);
  expect(hasTurnTraceObserver).toBe(true);
  const conversation = spans.find((s: any) => s.name === "conversation");
  const turn = spans.find((s: any) => s.name === "turn");
  expect(conversation?.attributes["conversation.id"]).toBe("conv-top-level");
  expect(turn?.attributes["turn.number"]).toBe(1);
  expect(turn?.parentSpanId).toBe(conversation?.spanId);
});

test("setupTracing needs the sdk and resources modules", () => {
  registerOpenTelemetry({ api });
  expect(isTracingAvailable()).toBe(true);
  expect(setupTracing({ serviceName: "x" })).toBe(false);
});
