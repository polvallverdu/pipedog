// Copyright (c) 2026, pipecat-ts contributors
// SPDX-License-Identifier: BSD-2-Clause

// Node >= 22.6 smoke test, runs the TypeScript sources directly:
//   node --experimental-strip-types test/smoke/node.ts   (flag not needed on Node >= 23.6)

import { initResampler } from "../../src/index.ts";
import { runChecks } from "./checks.ts";

const engine = await initResampler();
console.log(`node ${process.version}: ${runChecks(engine)}`);
