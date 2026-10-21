// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Azure services for pipedog. Subpaths mirror `pipecat.services.azure.*` (`/llm`, `/image`,
 * `/stt`, `/tts`, `/realtime/llm`, `/voice_live/llm`, `/voice_live/events`) and the Voice Live
 * adapter. The Voice Live event models stay on their subpath, since their names overlap the
 * OpenAI Realtime ones.
 */

export * from "./azure_voice_live_adapter.ts";
export * from "./common.ts";
export * from "./image.ts";
export * from "./llm.ts";
export * from "./realtime/llm.ts";
export {
  type AzureProfanity,
  AzureSpeechConfig,
  type AzureSpeechConfigOptions,
  AzureSTTService,
  type AzureSTTServiceOptions,
  AzureSTTSettings,
  type AzureSTTSettingsOptions,
  ProfanityOption,
  PropertyId,
  type RecognitionCanceledEvent,
  type RecognitionEvent,
  ResultReason,
} from "./stt.ts";
export {
  type AzureBaseTTSServiceOptions,
  AzureHttpTTSService,
  type AzureHttpTTSServiceOptions,
  type AzureSynthesisConfig,
  AzureTTSService,
  type AzureTTSServiceOptions,
  AzureTTSSettings,
  type AzureTTSSettingsOptions,
  CancellationReason,
  SpeechSynthesisOutputFormat,
  type SynthesisAudioEvent,
  type SynthesisCanceledEvent,
  type SynthesisCompletedEvent,
  type SynthesisWordBoundaryEvent,
  sampleRateToOutputFormat,
} from "./tts.ts";
export * from "./voice_live/llm.ts";
