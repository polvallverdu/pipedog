// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Manage the pinned upstream checkout in .upstream/pipecat.
//
//   bun run upstream            clone/checkout the commit pinned in upstream.json
//   bun run upstream bump [ref] move the pin to `ref` (default origin/main) and list
//                               ported modules/tests whose upstream source changed;
//                               they are reset to "todo" with a note, so the port
//                               workflow picks them up again.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { $ } from "bun";

const pin = JSON.parse(readFileSync("upstream.json", "utf8"));
const dir: string = pin.path;

if (!existsSync(`${dir}/.git`)) {
  await $`git clone --filter=blob:none ${pin.repo} ${dir}`;
}
await $`git -C ${dir} fetch --quiet origin`;

const [cmd, ref = "origin/main"] = process.argv.slice(2);
if (cmd !== "bump") {
  await $`git -C ${dir} checkout --quiet ${pin.commit}`;
  console.log(`upstream at ${pin.commit}`);
  process.exit(0);
}

const next = (await $`git -C ${dir} rev-parse ${ref}`.text()).trim();
const changed = new Set(
  (await $`git -C ${dir} diff --name-only ${pin.commit} ${next}`.text()).trim().split("\n"),
);
await $`git -C ${dir} checkout --quiet ${next}`;

const manifest = JSON.parse(readFileSync("porting/manifest.json", "utf8"));
const stale: string[] = [];
for (const m of manifest.modules) {
  if (m.status !== "todo" && changed.has(m.upstream)) {
    stale.push(m.module);
    m.status = "todo";
    m.notes =
      `upstream changed ${pin.commit.slice(0, 10)}..${next.slice(0, 10)}; re-port the diff. ${m.notes ?? ""}`.trim();
  }
}
for (const t of manifest.tests) {
  if (t.status !== "todo" && changed.has(t.file)) {
    stale.push(t.file);
    t.status = "todo";
    t.notes = `upstream changed ${pin.commit.slice(0, 10)}..${next.slice(0, 10)}; re-port the diff.`;
  }
}
writeFileSync("porting/manifest.json", `${JSON.stringify(manifest, null, 2)}\n`);
pin.commit = next;
writeFileSync("upstream.json", `${JSON.stringify(pin, null, 2)}\n`);
await $`python3 -I tools/port/graph.py`;
console.log(`pinned ${next}; ${stale.length} ported entries need re-porting:\n${stale.join("\n")}`);
