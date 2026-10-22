// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Sarvam AI services for pipedog. Subpaths mirror upstream: `/llm`, `/stt`, `/tts`.
 *
 * `stt.ts` and `tts.ts` each define their own `languageToSarvamLanguage` (as upstream does);
 * this entry re-exports the STT one and TTS's is available at `@pipedog/sarvam/tts`.
 */

export * from "./_sdk.ts";
export * from "./llm.ts";
export * from "./stt.ts";
export {
  getSpeakersForModel,
  SarvamHttpTTSService,
  type SarvamHttpTTSServiceOptions,
  SarvamHttpTTSSettings,
  type SarvamHttpTTSSettingsOptions,
  SarvamTTSModel,
  SarvamTTSService,
  type SarvamTTSServiceOptions,
  SarvamTTSSettings,
  type SarvamTTSSettingsOptions,
  SarvamTTSSpeakerV3,
  TTS_MODEL_CONFIGS,
  TTSModelConfig,
  type TTSModelConfigOptions,
} from "./tts.ts";
