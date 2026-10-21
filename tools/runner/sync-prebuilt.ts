// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Vendor the prebuilt Pipecat client into packages/runner/prebuilt/dist.
//
// Upstream's dev runner serves `pipecat-ai-prebuilt` (github.com/pipecat-ai/pipecat-prebuilt),
// whose built client is only published inside its Python wheel. This downloads the pinned wheel
// from PyPI, checks its SHA-256, and copies `pipecat_ai_prebuilt/client/dist` (and the license)
// unmodified. To move to a new release, update VERSION, URL and SHA256 from
// https://pypi.org/pypi/pipecat-ai-prebuilt/json, update PREBUILT_VERSION in
// packages/runner/src/prebuilt.ts, and run:
//
//   bun tools/runner/sync-prebuilt.ts

import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const VERSION = "1.3.0";
const URL =
  "https://files.pythonhosted.org/packages/e4/6a/df44efb2952089e59a7a2e1798156666257429613d6feac6f1ebb364f420/pipecat_ai_prebuilt-1.3.0-py3-none-any.whl";
const SHA256 = "fe06408efea390d0cfe4257b4bf86aff19b44189cdbb504954dd9329513dbf7f";

const ROOT = join(import.meta.dir, "..", "..");
const OUT = join(ROOT, "packages", "runner", "prebuilt");

const response = await fetch(URL);
if (!response.ok) throw new Error(`download failed: HTTP ${response.status}`);
const wheel = new Uint8Array(await response.arrayBuffer());
const digest = new Bun.CryptoHasher("sha256").update(wheel).digest("hex");
if (digest !== SHA256) throw new Error(`SHA-256 mismatch: expected ${SHA256}, got ${digest}`);

const work = mkdtempSync(join(tmpdir(), "pipecat-prebuilt-"));
try {
  const archive = join(work, "prebuilt.whl");
  writeFileSync(archive, wheel);
  const unzip = Bun.spawnSync(["unzip", "-q", archive, "-d", join(work, "x")]);
  if (unzip.exitCode !== 0) throw new Error(`unzip failed: ${unzip.stderr.toString()}`);
  rmSync(join(OUT, "dist"), { recursive: true, force: true });
  cpSync(join(work, "x", "pipecat_ai_prebuilt", "client", "dist"), join(OUT, "dist"), {
    recursive: true,
  });
  cpSync(
    join(work, "x", `pipecat_ai_prebuilt-${VERSION}.dist-info`, "licenses", "LICENSE"),
    join(OUT, "LICENSE"),
  );
  console.log(`vendored pipecat-ai-prebuilt ${VERSION} into ${OUT}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
