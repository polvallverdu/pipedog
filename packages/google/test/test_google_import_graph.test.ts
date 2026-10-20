// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/**
 * The Cloud SDKs (`@google-cloud/speech`, `@google-cloud/text-to-speech`) are
 * Node-only optional peers, loaded with `import()` of a variable specifier
 * when a Cloud class first connects. Bundle every module for a Worker and
 * check that none of their code (nor gRPC) is pulled in, so the portable
 * classes (`GeminiSTTService`, `GeminiTTSService` on the Gemini API) and
 * importing the package work on Cloudflare Workers.
 */

import { expect, test } from "bun:test";
import { join } from "node:path";

const SRC = join(import.meta.dir, "..", "src");
const MODULES = ["frames.ts", "stt.ts", "tts.ts", "utils.ts", "gemini_live/stt.ts"];

for (const module of MODULES) {
  test(`${module} bundles for workerd without a Node-only SDK`, async () => {
    const out = await Bun.build({
      entrypoints: [join(SRC, module)],
      target: "browser",
      conditions: ["workerd", "worker", "browser"],
      format: "esm",
    });
    expect(out.success).toBe(true);
    const code = (await Promise.all(out.outputs.map((o) => o.text()))).join("\n");
    for (const marker of ["google-gax", "@grpc/grpc-js", "GrpcClient", "google-auth-library"]) {
      expect(code.includes(marker)).toBe(false);
    }
    // The SDKs are only named, as the specifier strings of the lazy imports.
    for (const sdk of ["@google-cloud/speech", "@google-cloud/text-to-speech"]) {
      const mentions = code.split(JSON.stringify(sdk)).length - 1;
      const imports = code.split(`from ${JSON.stringify(sdk)}`).length - 1;
      expect(imports).toBe(0);
      expect(mentions).toBeLessThanOrEqual(1);
    }
  });
}
