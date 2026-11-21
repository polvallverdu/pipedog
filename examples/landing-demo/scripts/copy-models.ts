// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Copies Silero VAD's model into the page's static assets before the page is built, so the Worker
// serves it from Workers Static Assets and the session's Durable Object reads it through the
// ASSETS binding (models are not bundled into the Worker). The copy is gitignored.

import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

const source = Bun.resolveSync("@pipedog/audio-silero/silero_vad.onnx", import.meta.dir);
const target = join(import.meta.dir, "..", "web", "static", "models", "silero_vad.onnx");
mkdirSync(dirname(target), { recursive: true });
copyFileSync(source, target);
