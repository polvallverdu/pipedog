// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Sample for content/docs/deployment/bundling.mdx. Type-checked on every docs build; the same
// recipe runs, bundled, in examples/bundle-check.

// #region rnnoise
import { initRnnoise, RNNoiseFilter } from "@pipedog/audio-rnnoise-filter";
import rnnoisePath from "@pipedog/audio-rnnoise-filter/rnnoise.wasm" with { type: "file" };

// Load the module before the filter starts; the filter then finds it ready.
await initRnnoise(new URL(rnnoisePath, import.meta.url));
export const audioInFilter = new RNNoiseFilter();
// #endregion
