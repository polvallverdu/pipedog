// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// CI only, right before `changeset publish`: rewrite every publishable
// package in place into its npm form (see manifest.ts). Never commit the result.
//
//   bun tools/release/prepare.ts

import {
  checkPackageFiles,
  checkPublishManifest,
  preparePackageDir,
  publishablePackages,
  publishManifest,
} from "./manifest.ts";

const pkgs = publishablePackages();
const versions = new Map([...pkgs].map(([name, p]) => [name, p.manifest.version as string]));
const distinct = new Set(versions.values());
if (distinct.size !== 1) {
  throw new Error(
    `fixed mode: all packages must share one version, got ${[...distinct].join(", ")}`,
  );
}
let failed = false;
for (const [name, p] of pkgs) {
  const problems = checkPublishManifest(publishManifest(p.manifest, versions));
  if (problems.length) {
    failed = true;
    console.error(`${name}: ${problems.join("; ")}`);
    continue;
  }
  preparePackageDir(p.dir, p.manifest, versions);
  const missing = checkPackageFiles(p.dir, publishManifest(p.manifest, versions));
  if (missing.length) {
    failed = true;
    console.error(`${name}: ${missing.join("; ")}`);
    continue;
  }
  console.log(`prepared ${name}@${p.manifest.version}`);
}
if (failed) process.exit(1);
