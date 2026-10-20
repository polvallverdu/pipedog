// Copyright (c) 2026, pipecat-ts contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Reads every packages/*/package.json at build time, so the runtime
// compatibility table in the docs is generated from each package's
// `pipecat.runtimes` field (written by the compat harness) and never
// hardcoded.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

export const RUNTIMES = ["bun", "node", "deno", "workerd"] as const;
export type Runtime = (typeof RUNTIMES)[number];

export const RUNTIME_LABELS: Record<Runtime, string> = {
  bun: "Bun",
  node: "Node.js",
  deno: "Deno",
  workerd: "Cloudflare Workers",
};

export interface PackageCompat {
  name: string;
  description: string | null;
  dir: string;
  runtimes: Runtime[];
  upstream: string[];
}

/** The monorepo's packages/ directory (the docs app lives in apps/docs). */
export function packagesDir(): string {
  return path.resolve(process.cwd(), "../../packages");
}

export function readPackageCompat(dir = packagesDir()): PackageCompat[] {
  const out: PackageCompat[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const pkgPath = path.join(dir, entry.name, "package.json");
    if (!existsSync(pkgPath)) continue;
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
      name?: string;
      description?: string;
      private?: boolean;
      pipecat?: { runtimes?: string[]; upstream?: string[] };
    };
    if (!pkg.name) continue;
    const runtimes = (pkg.pipecat?.runtimes ?? []).filter((r): r is Runtime =>
      (RUNTIMES as readonly string[]).includes(r),
    );
    out.push({
      name: pkg.name,
      description: pkg.description ?? null,
      dir: `packages/${entry.name}`,
      runtimes,
      upstream: pkg.pipecat?.upstream ?? [],
    });
  }
  // Core first, then alphabetical.
  const rank = (n: string) => (n === "@pipecat-ts/asyncio" ? 0 : n === "@pipecat-ts/core" ? 1 : 2);
  return out.sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name));
}
