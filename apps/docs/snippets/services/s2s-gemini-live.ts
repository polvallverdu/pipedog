// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Samples for content/docs/services/s2s/gemini-live.mdx. Type-checked on every docs build.

// #region usage
import { LLMContext } from "@pipedog/core/processors/aggregators/llm_context";
import { Language } from "@pipedog/core/transcriptions/language";
import {
  ContextWindowCompressionParams,
  GeminiLiveLLMService,
  GeminiVADParams,
} from "@pipedog/google/gemini_live/llm";

const llm = new GeminiLiveLLMService({
  apiKey: process.env.GOOGLE_API_KEY ?? "",
  systemInstruction: "You are a friendly voice assistant. Keep answers short.",
  settings: new GeminiLiveLLMService.Settings({
    model: "models/gemini-3.8-live",
    voice: "Puck",
    language: Language.EN_US,
  }),
});
// #endregion usage

// #region settings
const tuned = new GeminiLiveLLMService({
  apiKey: process.env.GOOGLE_API_KEY ?? "",
  settings: new GeminiLiveLLMService.Settings({
    temperature: 0.6,
    contextWindowCompression: new ContextWindowCompressionParams({
      enabled: true,
      triggerTokens: 8000,
    }),
    thinking: { includeThoughts: true },
  }),
});
// #endregion settings

// #region local-vad
// Turn off server-side VAD. A local VAD in the user aggregator then drives
// turns, and the service sends activity start/end signals to Gemini.
const locallyDriven = new GeminiLiveLLMService({
  apiKey: process.env.GOOGLE_API_KEY ?? "",
  settings: new GeminiLiveLLMService.Settings({
    vad: new GeminiVADParams({ disabled: true }),
  }),
});
// #endregion local-vad

// #region file-api
// uploadFile() reads the file with node:fs/promises (Bun, Node, Deno).
const uploaded = await llm.fileApi.uploadFile("menu.txt", "Menu");
const file = uploaded.file as { uri: string };

const context = new LLMContext({
  messages: [
    {
      role: "user",
      content: [
        { type: "text", text: "What's on the menu today?" },
        { type: "file_data", file_data: { mime_type: "text/plain", file_uri: file.uri } },
      ],
    },
  ],
});
// #endregion file-api
