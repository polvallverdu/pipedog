// Copyright (c) 2026, pipecat-ts contributors
// SPDX-License-Identifier: BSD-2-Clause

// Cloudflare Workers smoke test. Imports the package by name so the "workerd"
// export condition is what selects the entry (bundled by run.ts).

import { getResampler, initResampler } from "@pipecat-ts/resampler-wasm";
import { runChecks } from "../checks.ts";

export default {
  async fetch(): Promise<Response> {
    try {
      const engine = await initResampler();
      const sync = getResampler() === engine;
      // workerd refuses to compile WASM from bytes; confirm that is why the entry imports a Module.
      let compileFromBytes = "allowed";
      try {
        await WebAssembly.compile(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
      } catch (e) {
        compileFromBytes = `blocked (${(e as Error).message})`;
      }
      return Response.json({ ok: true, report: runChecks(engine), sync, compileFromBytes });
    } catch (e) {
      return Response.json({ ok: false, error: String((e as Error).stack ?? e) }, { status: 500 });
    }
  },
};
