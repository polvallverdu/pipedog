// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Samples for content/docs/services/llm/sarvam.mdx. Type-checked on every docs build.

// #region usage
import { LLMUpdateSettingsFrame } from "@pipedog/core/frames/frames";
import { SarvamLLMService } from "@pipedog/sarvam/llm";

const llm = new SarvamLLMService({
  apiKey: process.env.SARVAM_API_KEY ?? "",
  settings: new SarvamLLMService.Settings({
    model: "sarvam-105b",
    systemInstruction: "You are a helpful assistant in a voice conversation.",
  }),
});
// #endregion usage

// #region grounding
const grounded = new SarvamLLMService({
  apiKey: process.env.SARVAM_API_KEY ?? "",
  settings: new SarvamLLMService.Settings({
    model: "sarvam-105b",
    wikiGrounding: true,
    reasoningEffort: "low",
  }),
});
// #endregion grounding

// #region update
// Queue it on the worker, or push it from a processor upstream of the service.
const update = new LLMUpdateSettingsFrame({
  delta: new SarvamLLMService.Settings({ temperature: 0.2 }),
});
// #endregion update
