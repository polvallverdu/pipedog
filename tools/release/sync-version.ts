// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Write @pipedog/core's package.json version into src/version.ts, so the
// startup banner and version() report the real version. Runs after
// `changeset version` (see the root "version-packages" script).

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./manifest.ts";

const dir = join(ROOT, "packages", "core");
const { version } = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
const file = join(dir, "src", "version.ts");
const before = readFileSync(file, "utf8");
const after = before.replace(
  /export const VERSION = "[^"]*";/,
  `export const VERSION = "${version}";`,
);
writeFileSync(file, after);
console.log(`core version.ts -> ${version}`);
