// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Sample for content/docs/deployment/bundling.mdx. Type-checked on every docs build.

// #region resampler
import { initResampler } from "@pipedog/resampler-wasm";
import resamplerPath from "@pipedog/resampler-wasm/resampler.wasm" with { type: "file" };

// Optional: without this the resampler falls back to a copy of the module embedded in the
// package's JavaScript (38 KB), so a bundle needs nothing.
await initResampler(new URL(resamplerPath, import.meta.url));
// #endregion
