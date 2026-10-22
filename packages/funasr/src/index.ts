// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/**
 * FunASR speech-to-text for pipedog: `FunASRSTTService` (a port of Pipecat's)
 * running SenseVoiceSmall locally through `@pipedog/onnx`, plus the engine it
 * uses (`AutoModel`, `richTranscriptionPostprocess`).
 */

export {
  AutoModel,
  type AutoModelOptions,
  ctcGreedySearch,
  decodePieces,
  type GenerateOptions,
  type GenerateResult,
  parseTokens,
  richTranscriptionPostprocess,
  SENSE_VOICE_LANGUAGE_IDS,
  SENSE_VOICE_MODEL_IDS,
  SENSE_VOICE_REPO,
  SENSE_VOICE_REVISION,
  SENSE_VOICE_TEXTNORM_IDS,
  senseVoiceFileUrl,
} from "./funasr.ts";
export {
  type FunASRModel,
  FunASRSTTService,
  type FunASRSTTServiceOptions,
  FunASRSTTSettings,
  type FunASRSTTSettingsOptions,
  funasrLanguageToFrameLanguage,
  languageToFunasrLanguage,
} from "./stt.ts";
