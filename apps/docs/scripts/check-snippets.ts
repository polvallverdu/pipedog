// Copyright (c) 2026, pipecat-ts contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Type-check the documentation samples in snippets/ against the real
// @pipecat-ts sources. Only diagnostics in snippets/ fail the build: the
// packages have their own `bun run typecheck`, and an unrelated error there
// (e.g. a module mid-port) should not block the docs.

import { join } from "node:path";
import { $ } from "bun";

const tsc = join(import.meta.dir, "../node_modules/.bin/tsc");
$.cwd(join(import.meta.dir, ".."));

const result = await $`${tsc} -p snippets/tsconfig.json --pretty false`.nothrow().quiet();
const lines = `${result.stdout}${result.stderr}`.split("\n").filter((l) => l.trim());
const ours = lines.filter((l) => l.startsWith("snippets/"));
const theirs = lines.filter((l) => /^\S.*\(\d+,\d+\): error/.test(l) && !l.startsWith("snippets/"));

if (theirs.length) {
  console.warn(`check-snippets: ignoring ${theirs.length} error(s) outside snippets/:`);
  for (const l of theirs.slice(0, 5)) console.warn(`  ${l}`);
}
if (ours.length) {
  console.error(ours.join("\n"));
  process.exit(1);
}
if (result.exitCode !== 0 && !theirs.length) {
  console.error(lines.join("\n"));
  process.exit(result.exitCode);
}
console.log("snippets ok");
