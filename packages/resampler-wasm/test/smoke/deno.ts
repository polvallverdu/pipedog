// Copyright (c) 2026, pipecat-ts contributors
// SPDX-License-Identifier: BSD-2-Clause

// Deno 2 smoke test:  deno run -A test/smoke/deno.ts

import { initResampler } from "../../src/index.ts";
import { runChecks } from "./checks.ts";

declare const Deno: { version: { deno: string } };

const engine = await initResampler();
console.log(`deno ${Deno.version.deno}: ${runChecks(engine)}`);
