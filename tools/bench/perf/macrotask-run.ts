// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Runs macrotask.ts on Bun, Node, Deno and workerd through the compat harness.

import { join } from "node:path";
import { ROOT, RUNTIMES } from "../../compat/packages.ts";
import { runSmoke } from "../../compat/runners.ts";

for (const rt of RUNTIMES) {
  const r = await runSmoke(rt, join(ROOT, "tools", "bench", "perf", "macrotask.ts"), "macrotask");
  const res = r.ok
    ? Object.entries(r.result as Record<string, number>)
        .map(([k, v]) => `${k} ${v.toFixed(2)} µs`)
        .join(", ")
    : `❌ ${r.error}`;
  console.log(`${rt.padEnd(8)} ${res}`);
}
process.exit(0);
