// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Sample for content/docs/deployment/bundling.mdx. Type-checked on every docs build; the same
// recipe runs, bundled, in examples/bundle-check.

// #region silero
import { SileroVADAnalyzer } from "@pipedog/audio-silero";
import sileroPath from "@pipedog/audio-silero/silero_vad.onnx" with { type: "file" };

// `new URL(path, import.meta.url)` is where the bundler put the file, wherever the bot is
// started from. (`Bun.file(sileroPath)` alone is relative to the working directory.)
export const vad = new SileroVADAnalyzer({ model: new URL(sileroPath, import.meta.url) });
// #endregion
