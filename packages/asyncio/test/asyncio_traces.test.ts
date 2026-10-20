// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// asyncio interleavings: each scenario in trace_scenarios.ts must log exactly
// what CPython's asyncio logged for it (python/traces.json).

import { describe, expect, test } from "bun:test";
import { expectedTraces, runScenario, scenarios } from "./trace_scenarios.ts";

describe("asyncio interleavings match CPython", () => {
  test("every recorded scenario has a TypeScript twin", () => {
    expect(Object.keys(scenarios).sort()).toEqual(Object.keys(expectedTraces).sort());
  });

  for (const name of Object.keys(scenarios)) {
    test(name, async () => {
      expect(await runScenario(name)).toEqual(expectedTraces[name]!);
    });
  }
});
