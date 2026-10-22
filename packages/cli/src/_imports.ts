// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/cli/registry/_imports.py

/**
 * Import statements for the services and features of a generated `bot.ts`.
 *
 * DIVERGENCE: upstream's `_imports.py` is generated (`scripts/cli/update_registry.py`) and
 * lists Python imports. This file is hand-written TypeScript; `test/test_service_registry.test.ts`
 * checks every module and class named here against the workspace packages.
 *
 * Each entry is one `import { A, B } from "module";` line (or `import type`). `mergeImports`
 * in `service_loader.ts` merges and sorts them.
 */

import { COMPATIBLE_LLMS } from "./_configs.ts";

/** Imports every generated bot has. */
export const BASE_IMPORTS: readonly string[] = [
  'import { logger } from "@pipedog/core/utils/logger";',
];

/** Imports for the features a bot can have, by feature name (`FEATURE_DEFINITIONS`). */
export const FEATURE_IMPORTS: Record<string, readonly string[]> = {
  pipeline: [
    'import { Pipeline } from "@pipedog/core/pipeline/pipeline";',
    'import { PipelineParams, PipelineWorker } from "@pipedog/core/pipeline/worker";',
    'import { WorkerRunner } from "@pipedog/core/workers/runner";',
  ],
  context: [
    'import { LLMContext } from "@pipedog/core/processors/aggregators/llm_context";',
    'import { LLMContextAggregatorPair, LLMUserAggregatorParams } from "@pipedog/core/processors/aggregators/llm_response_universal";',
  ],
  runner: [
    'import type { RunnerArguments } from "@pipedog/runner/types";',
    'import { createTransport } from "@pipedog/runner/utils";',
  ],
  vad: ['import { SileroVADAnalyzer } from "@pipedog/audio-silero";'],
  llm_run_frame: ['import { LLMRunFrame } from "@pipedog/core/frames/frames";'],
  recording: [
    'import { AudioBufferProcessor } from "@pipedog/core/processors/audio/audio_buffer_processor";',
    'import { mkdir, writeFile } from "node:fs/promises";',
  ],
  transcription: [
    'import type { AssistantTurnStoppedMessage, UserTurnStoppedMessage } from "@pipedog/core/processors/aggregators/llm_response_universal";',
  ],
  observability: ['import { OTLPTraceExporter, setupTracing } from "@pipedog/tracing";'],
  eval: ['import { EvalTransportParams } from "@pipedog/evals/transport";'],
  video_in_sources: [
    'import { VideoInSourceParams } from "@pipedog/core/transports/base_transport";',
  ],
};

const compatibleLlmImports = Object.fromEntries(
  COMPATIBLE_LLMS.map((llm) => [
    llm.value,
    [`import { ${llm.cls} } from "${llm.pkg}/llm";`] as readonly string[],
  ]),
);

/** Imports of each service and transport, by service value. */
export const IMPORTS: Record<string, readonly string[]> = {
  // Transports. Bots build them with createTransport(); only the params are needed.
  smallwebrtc: ['import { TransportParams } from "@pipedog/core/transports/base_transport";'],
  websocket: [
    'import { ProtobufFrameSerializer } from "@pipedog/serializer-protobuf/protobuf";',
    'import { FastAPIWebsocketParams } from "@pipedog/transport-websocket/fastapi";',
  ],
  livekit: ['import { LiveKitParams } from "@pipedog/transport-livekit/transport";'],
  twilio: ['import { FastAPIWebsocketParams } from "@pipedog/transport-websocket/fastapi";'],
  telnyx: ['import { FastAPIWebsocketParams } from "@pipedog/transport-websocket/fastapi";'],
  plivo: ['import { FastAPIWebsocketParams } from "@pipedog/transport-websocket/fastapi";'],
  exotel: ['import { FastAPIWebsocketParams } from "@pipedog/transport-websocket/fastapi";'],

  // STT services
  aws_transcribe_stt: ['import { AWSTranscribeSTTService } from "@pipedog/aws/stt";'],
  azure_stt: ['import { AzureSTTService } from "@pipedog/azure/stt";'],
  cartesia_stt: ['import { CartesiaSTTService } from "@pipedog/cartesia/stt";'],
  cartesia_turns_stt: ['import { CartesiaTurnsSTTService } from "@pipedog/cartesia/turns/stt";'],
  deepgram_stt: ['import { DeepgramSTTService } from "@pipedog/deepgram/stt";'],
  deepgram_flux_stt: ['import { DeepgramFluxSTTService } from "@pipedog/deepgram/flux/stt";'],
  elevenlabs_stt: ['import { ElevenLabsSTTService } from "@pipedog/elevenlabs/stt";'],
  elevenlabs_realtime_stt: [
    'import { ElevenLabsRealtimeSTTService } from "@pipedog/elevenlabs/stt";',
  ],
  gemini_stt: ['import { GeminiSTTService } from "@pipedog/google/gemini_live/stt";'],
  google_stt: ['import { GoogleSTTService } from "@pipedog/google/stt";'],
  groq_stt: ['import { GroqSTTService } from "@pipedog/groq/stt";'],
  mistral_stt: ['import { MistralSTTService } from "@pipedog/mistral/stt";'],
  moonshine_stt: ['import { MoonshineSTTService } from "@pipedog/moonshine/stt";'],
  openai_stt: ['import { OpenAISTTService } from "@pipedog/openai/stt";'],
  openai_realtime_stt: ['import { OpenAIRealtimeSTTService } from "@pipedog/openai/stt";'],
  together_stt: ['import { TogetherSTTService } from "@pipedog/together/stt";'],
  whisper_stt: ['import { WhisperSTTService } from "@pipedog/whisper/stt";'],
  xai_stt: ['import { XAISTTService } from "@pipedog/xai/stt";'],

  // LLM services
  anthropic_llm: ['import { AnthropicLLMService } from "@pipedog/anthropic/llm";'],
  aws_bedrock_llm: ['import { AWSBedrockLLMService } from "@pipedog/aws/llm";'],
  azure_llm: ['import { AzureLLMService } from "@pipedog/azure/llm";'],
  google_gemini_llm: ['import { GoogleLLMService } from "@pipedog/google/llm";'],
  google_vertex_llm: ['import { GoogleVertexLLMService } from "@pipedog/google/vertex/llm";'],
  openai_llm: ['import { OpenAILLMService } from "@pipedog/openai/llm";'],
  openai_responses_llm: [
    'import { OpenAIResponsesLLMService } from "@pipedog/openai/responses/llm";',
  ],
  ...compatibleLlmImports,

  // TTS services
  aws_polly_tts: ['import { AWSPollyTTSService } from "@pipedog/aws/tts";'],
  azure_tts: ['import { AzureTTSService } from "@pipedog/azure/tts";'],
  cartesia_tts: ['import { CartesiaTTSService } from "@pipedog/cartesia/tts";'],
  deepgram_tts: ['import { DeepgramTTSService } from "@pipedog/deepgram/tts";'],
  deepgram_flux_tts: ['import { DeepgramFluxTTSService } from "@pipedog/deepgram/flux/tts";'],
  elevenlabs_tts: ['import { ElevenLabsTTSService } from "@pipedog/elevenlabs/tts";'],
  elevenlabs_dialogue_tts: [
    'import { ElevenLabsDialogueTTSService } from "@pipedog/elevenlabs/dialogue/tts";',
  ],
  fish_tts: ['import { FishAudioTTSService } from "@pipedog/fish/tts";'],
  gemini_tts: ['import { GeminiTTSService } from "@pipedog/google/tts";'],
  google_tts: ['import { GoogleTTSService } from "@pipedog/google/tts";'],
  groq_tts: ['import { GroqTTSService } from "@pipedog/groq/tts";'],
  hume_tts: ['import { HumeTTSService } from "@pipedog/hume/tts";'],
  inworld_tts: ['import { InworldTTSService } from "@pipedog/inworld/tts";'],
  kokoro_tts: ['import { KokoroTTSService } from "@pipedog/kokoro/tts";'],
  mistral_tts: ['import { MistralTTSService } from "@pipedog/mistral/tts";'],
  openai_tts: ['import { OpenAITTSService } from "@pipedog/openai/tts";'],
  piper_tts: ['import { PiperTTSService } from "@pipedog/piper/tts";'],
  pockettts_tts: ['import { PocketTTSService } from "@pipedog/pocket-tts/tts";'],
  rime_tts: ['import { RimeTTSService } from "@pipedog/rime/tts";'],
  together_tts: ['import { TogetherTTSService } from "@pipedog/together/tts";'],
  xai_tts: ['import { XAITTSService } from "@pipedog/xai/tts";'],

  // Realtime (speech-to-speech) services
  aws_nova_realtime: ['import { AWSNovaSonicLLMService } from "@pipedog/aws/nova_sonic/llm";'],
  azure_realtime: ['import { AzureRealtimeLLMService } from "@pipedog/azure/realtime/llm";'],
  azure_voice_live: ['import { AzureVoiceLiveLLMService } from "@pipedog/azure/voice_live/llm";'],
  gemini_live_realtime: ['import { GeminiLiveLLMService } from "@pipedog/google/gemini_live/llm";'],
  gemini_vertex_live_realtime: [
    'import { GeminiLiveVertexLLMService } from "@pipedog/google/gemini_live/vertex/llm";',
  ],
  inworld_realtime: ['import { InworldRealtimeLLMService } from "@pipedog/inworld/realtime/llm";'],
  openai_realtime: [
    'import { AudioConfiguration, AudioInput, InputAudioTranscription, SemanticTurnDetection, SessionProperties } from "@pipedog/openai/realtime/events";',
    'import { OpenAIRealtimeLLMService } from "@pipedog/openai/realtime/llm";',
  ],
  ultravox: [
    'import { OneShotInputParams, UltravoxRealtimeLLMService } from "@pipedog/ultravox/llm";',
  ],
  xai_realtime: ['import { GrokRealtimeLLMService } from "@pipedog/xai/realtime/llm";'],

  // Video avatar services
  heygen_video: [
    'import { LiveAvatarNewSessionRequest } from "@pipedog/heygen/api_liveavatar";',
    'import { ServiceType } from "@pipedog/heygen/client";',
    'import { HeyGenVideoService } from "@pipedog/heygen/video";',
  ],
};
