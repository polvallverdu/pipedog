// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Files the package ships next to its code: `agent_templates/` (AGENTS.md, CLAUDE.md,
 * GETTING_STARTED.md) and `templates/` (the Vite client's static files). They are plain files so
 * they can be diffed against upstream's and read as they are; `package.json` lists the two
 * directories in `files`.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** The package's root directory, from `src/templates/` or `dist/templates/`. */
export const PACKAGE_ROOT: string = fileURLToPath(new URL("../../", import.meta.url));

/** Read a file of the package (`agent_templates/AGENTS.md`) as text. */
export function readAsset(relativePath: string): string {
  return readFileSync(new URL(relativePath, new URL("../../", import.meta.url)), "utf8");
}

/** The package's version, which is the release of `@pipedog/*` generated projects depend on. */
export const VERSION: string = (
  JSON.parse(readAsset("package.json")) as {
    version: string;
  }
).version;
