// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Moonshine speech-to-text for pipedog. `@pipedog/moonshine/stt` mirrors
 * `pipecat.services.moonshine.stt`; `@pipedog/moonshine/moonshine_voice` is the
 * local inference engine (the `moonshine_voice` surface the service uses).
 */

export {
  downloadModel,
  findModelInfo,
  getModelForLanguage,
  ModelArch,
  type ModelCacheOptions,
  type ModelDownloadOptions,
  type ModelInfo,
  modelArchToString,
  stringToModelArch,
  supportedLanguages,
  supportedLanguagesFriendly,
  Transcriber,
  type TranscriberOptions,
  type Transcript,
  type TranscriptLine,
} from "./moonshine_voice.ts";
export * from "./stt.ts";
