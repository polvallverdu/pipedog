// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/cli/registry/service_metadata.py

/**
 * SERVICE METADATA REGISTRY: the source of truth for the services `pipedog init` offers.
 *
 * To add a service: add a `ServiceDefinition` to the right list below, its constructor to
 * `_configs.ts` and its imports to `_imports.ts`. `test/test_service_registry.test.ts` fails until
 * the three agree, the service exists in the workspace package it names, and the docs'
 * `apps/docs/data/providers.ts` doesn't list a ported service that is neither offered here nor
 * explained in `NOT_OFFERED`. `test/e2e` type-checks a generated bot for every service.
 *
 * DIVERGENCE: upstream lists every Pipecat service, whether or not it is installed. This list is
 * limited to what pipedog has ported, so a service that isn't ported can't be offered (Daily,
 * Deepgram's SageMaker variants, AssemblyAI, Sarvam, ...). Pipecat Cloud, Daily PSTN, Twilio +
 * Daily SIP and Krisp aren't offered either; they have no pipedog counterpart. Upstream's
 * `package` field (`pipecat-ai[deepgram]`, a PyPI extra) is an npm package here.
 *
 * For operations on services, use `ServiceLoader` from `service_loader.ts`.
 */

import { COMPATIBLE_LLMS, SERVICE_CONFIGS } from "./_configs.ts";
import { BASE_IMPORTS, FEATURE_IMPORTS, IMPORTS } from "./_imports.ts";

export const DEFAULT_SYSTEM_INSTRUCTION =
  "You are a helpful assistant in a voice conversation. Your responses will be spoken aloud, so avoid emojis, bullet points, or other formatting that can't be spoken. Respond to what the user said in a creative, helpful, and brief way.";

/** The kinds of service the registry lists. */
export type ServiceType = "transport" | "stt" | "llm" | "tts" | "realtime" | "video";
/** What the bot talks over: a browser or app (WebRTC, WebSocket), or the phone network. */
export type BotType = "web" | "telephony";

/** An environment variable a service reads, for `.env.example` and the generated bot's startup check. */
export interface EnvVarDefinition {
  name: string;
  /** What it is, and where to get it. */
  description?: string;
  /** Whether the bot can't work without it. */
  required: boolean;
  /** The value the generated bot uses when it isn't set. */
  default?: string;
}

export interface ServiceDefinitionOptions {
  value: string;
  label: string;
  /** The npm package. */
  pkg: string;
  /** The classes the bot imports for this service (informational, and checked by the tests). */
  className?: string[] | null;
  /**
   * The environment variables the service reads. Left out, they are read from the service's
   * config in `_configs.ts` (`ServiceLoader.getEnvVars`).
   */
  envVars?: EnvVarDefinition[] | null;
  /**
   * Other third-party npm packages a bot using this service installs, with their version ranges.
   * The `@pipedog/*` packages the bot imports are found from its imports.
   */
  extraDependencies?: Record<string, string> | null;
  /** A note shown in `--list-options` output and the generated README (a runtime limit, say). */
  note?: string | null;
  /**
   * The npm package a generated web client installs to connect over this transport
   * (`@pipecat-ai/small-webrtc-transport`), with its version range in `clientPackageVersion`.
   * Only web transports have one.
   */
  clientPackage?: string | null;
  clientPackageVersion?: string | null;
}

/**
 * Service metadata definition.
 *
 * Upstream's `include_params`, `settings_params`, `manual_config`, `additional_imports` and
 * `param_defaults` shaped the generated Python; here the constructor expression is written out
 * in `_configs.ts`, so they have no counterpart.
 */
export class ServiceDefinition {
  /** Service identifier (`"openai_llm"`). */
  readonly value: string;
  /** Human-readable name (`"OpenAI"`). */
  readonly label: string;
  /** The npm package (`"@pipedog/openai"`); upstream's `package`, a PyPI requirement. */
  readonly pkg: string;
  readonly className: string[] | null;
  readonly envVars: EnvVarDefinition[] | null;
  readonly extraDependencies: Record<string, string> | null;
  readonly note: string | null;
  readonly clientPackage: string | null;
  readonly clientPackageVersion: string | null;

  constructor(options: ServiceDefinitionOptions) {
    // Validate service definition after initialization.
    if (!options.value) throw new Error("Service must have a value");
    if (!options.label) throw new Error("Service must have a label");
    if (!options.pkg) throw new Error("Service must have a package");
    if (Boolean(options.clientPackage) !== Boolean(options.clientPackageVersion)) {
      throw new Error("clientPackage and clientPackageVersion go together");
    }
    this.value = options.value;
    this.label = options.label;
    this.pkg = options.pkg;
    this.className = options.className ?? null;
    this.envVars = options.envVars ?? null;
    this.extraDependencies = options.extraDependencies ?? null;
    this.note = options.note ?? null;
    this.clientPackage = options.clientPackage ?? null;
    this.clientPackageVersion = options.clientPackageVersion ?? null;
  }
}

const svc = (
  value: string,
  label: string,
  pkg: string,
  className: string[],
  rest: Partial<ServiceDefinitionOptions> = {},
) => new ServiceDefinition({ value, label, pkg, className, ...rest });

/**
 * Feature definitions: the classes and functions each optional feature imports.
 * `ServiceLoader.getImportsForServices` adds the matching `FEATURE_IMPORTS`.
 */
export const FEATURE_DEFINITIONS: Record<string, string[]> = {
  recording: ["AudioBufferProcessor", "mkdir", "writeFile"],
  transcription: ["AssistantTurnStoppedMessage", "UserTurnStoppedMessage"],
  vad: ["SileroVADAnalyzer"],
  pipeline: ["Pipeline", "WorkerRunner", "PipelineParams", "PipelineWorker"],
  context: ["LLMContext", "LLMContextAggregatorPair", "LLMUserAggregatorParams"],
  runner: ["RunnerArguments", "createTransport"],
  // Queued on connect to kick off the conversation.
  llm_run_frame: ["LLMRunFrame"],
  observability: ["setupTracing", "OTLPTraceExporter"],
  // The "eval" transport entry (`--eval`) needs EvalTransportParams so `pipedog eval`
  // can drive the generated bot for behavioral evals.
  eval: ["EvalTransportParams"],
  // Video input on a SmallWebRTC transport captures its sources from videoInSources.
  video_in_sources: ["VideoInSourceParams"],
};

/**
 * Ported services the registry doesn't offer, by class name, with the reason. The test compares
 * `apps/docs/data/providers.ts` against the registry: a ported service must be offered or be here.
 */
export const NOT_OFFERED: Record<string, string> = {
  OpenAIResponsesHttpLLMService: "the HTTP variant of OpenAIResponsesLLMService, which is offered",
  AWSAgentCoreProcessor:
    "a processor for an AWS agent runtime (it needs an agent ARN), not a model",
  LangchainProcessor: "a processor around your own LangChain chain, not a model",
  SageMakerBidiClient: "a client other services build on, not a service",
  BaseWhisperSTTService: "a base class (use OpenAI, Groq or Together speech-to-text)",
  OpenAILiveLLMService: "needs a second, delegated LLM service that has to be configured by hand",
  GoogleHttpTTSService: "the HTTP variant of GoogleTTSService, which is offered",
  DeepgramHttpTTSService: "the HTTP variant of DeepgramTTSService, which is offered",
  CartesiaHttpTTSService: "the HTTP variant of CartesiaTTSService, which is offered",
  ElevenLabsHttpTTSService: "the HTTP variant of ElevenLabsTTSService, which is offered",
  XAIHttpTTSService: "the HTTP variant of XAITTSService, which is offered",
  InworldHttpTTSService: "the HTTP variant of InworldTTSService, which is offered",
  AzureHttpTTSService: "the HTTP variant of AzureTTSService, which is offered",
  HeyGenTransport: "a transport, not a video service (HeyGenVideoService is offered)",
  WhisperSTTServiceMLX:
    "upstream doesn't offer it either; in pipedog it runs the same ONNX engine as WhisperSTTService, which is offered",
  FunASRSTTService: "upstream doesn't offer it; a local SenseVoice model, mainly for Chinese",
  PiperHttpTTSService:
    "needs a separately run Piper HTTP server (PiperTTSService, which runs Piper in process, is offered)",
};

export class ServiceRegistry {
  /** Service configs, from `_configs.ts`. */
  static readonly SERVICE_CONFIGS = SERVICE_CONFIGS;
  /** Imports per service, from `_imports.ts`. */
  static readonly IMPORTS = IMPORTS;
  static readonly FEATURE_IMPORTS = FEATURE_IMPORTS;
  static readonly BASE_IMPORTS = BASE_IMPORTS;
  static readonly FEATURE_DEFINITIONS = FEATURE_DEFINITIONS;
  static readonly NOT_OFFERED = NOT_OFFERED;

  /** Web/mobile transports. */
  static readonly WEBRTC_TRANSPORTS: ServiceDefinition[] = [
    svc("smallwebrtc", "SmallWebRTC", "@pipedog/transport-smallwebrtc", ["TransportParams"], {
      clientPackage: "@pipecat-ai/small-webrtc-transport",
      clientPackageVersion: "^1.10.8",
      envVars: [],
    }),
    svc(
      "websocket",
      "WebSocket",
      "@pipedog/transport-websocket",
      ["FastAPIWebsocketParams", "ProtobufFrameSerializer"],
      {
        clientPackage: "@pipecat-ai/websocket-transport",
        clientPackageVersion: "^1.7.2",
        envVars: [],
      },
    ),
    svc("livekit", "LiveKit (WebRTC)", "@pipedog/transport-livekit", ["LiveKitParams"], {
      clientPackage: "@pipecat-ai/livekit-transport",
      clientPackageVersion: "^1.0.0",
      extraDependencies: { "@livekit/rtc-node": "^1.1.0" },
      note: "Runs on Bun and Node: LiveKit's media SDK is a native addon (no Workers or Deno).",
      envVars: [
        {
          name: "LIVEKIT_URL",
          description: "Your LiveKit server URL (wss://...)",
          required: true,
        },
        { name: "LIVEKIT_API_KEY", required: true },
        { name: "LIVEKIT_API_SECRET", required: true },
        {
          name: "LIVEKIT_ROOM_NAME",
          description: "Leave out to create a new room per session",
          required: false,
        },
      ],
    }),
  ];

  /** Telephony transports. The runner reads each provider's handshake and sets the serializer. */
  static readonly TELEPHONY_TRANSPORTS: ServiceDefinition[] = [
    svc("twilio", "Twilio", "@pipedog/serializer-twilio", ["FastAPIWebsocketParams"], {
      envVars: [
        {
          name: "TWILIO_ACCOUNT_SID",
          description: "Twilio console. Lets the bot hang up the call",
          required: false,
        },
        { name: "TWILIO_AUTH_TOKEN", description: "Twilio console", required: false },
      ],
    }),
    svc("telnyx", "Telnyx", "@pipedog/serializer-telnyx", ["FastAPIWebsocketParams"], {
      envVars: [
        {
          name: "TELNYX_API_KEY",
          description: "Telnyx portal. Lets the bot hang up the call",
          required: false,
        },
      ],
    }),
    svc("plivo", "Plivo", "@pipedog/serializer-plivo", ["FastAPIWebsocketParams"], {
      envVars: [
        {
          name: "PLIVO_AUTH_ID",
          description: "Plivo console. Lets the bot hang up the call",
          required: false,
        },
        { name: "PLIVO_AUTH_TOKEN", description: "Plivo console", required: false },
      ],
    }),
    svc("exotel", "Exotel", "@pipedog/serializer-exotel", ["FastAPIWebsocketParams"], {
      envVars: [],
    }),
  ];

  /** Speech-to-text services (cascade mode). */
  static readonly STT_SERVICES: ServiceDefinition[] = [
    svc("aws_transcribe_stt", "AWS Transcribe", "@pipedog/aws", ["AWSTranscribeSTTService"]),
    svc("azure_stt", "Azure Speech", "@pipedog/azure", ["AzureSTTService"]),
    svc("cartesia_stt", "Cartesia", "@pipedog/cartesia", ["CartesiaSTTService"]),
    svc("cartesia_turns_stt", "Cartesia Turns", "@pipedog/cartesia", ["CartesiaTurnsSTTService"]),
    svc("deepgram_stt", "Deepgram", "@pipedog/deepgram", ["DeepgramSTTService"]),
    svc("deepgram_flux_stt", "Deepgram Flux", "@pipedog/deepgram", ["DeepgramFluxSTTService"]),
    svc("elevenlabs_stt", "ElevenLabs", "@pipedog/elevenlabs", ["ElevenLabsSTTService"]),
    svc("elevenlabs_realtime_stt", "ElevenLabs Realtime", "@pipedog/elevenlabs", [
      "ElevenLabsRealtimeSTTService",
    ]),
    svc("gemini_stt", "Gemini Transcribe Live", "@pipedog/google", ["GeminiSTTService"]),
    svc("google_stt", "Google Speech-to-Text", "@pipedog/google", ["GoogleSTTService"], {
      note: "Uses Google's gRPC Node SDK: runs on Bun and Node, not on Workers.",
    }),
    svc("groq_stt", "Groq (Whisper)", "@pipedog/groq", ["GroqSTTService"]),
    svc("mistral_stt", "Mistral", "@pipedog/mistral", ["MistralSTTService"]),
    svc("moonshine_stt", "Moonshine", "@pipedog/moonshine", ["MoonshineSTTService"], {
      extraDependencies: { "onnxruntime-node": "^1.30.0" },
      note: "Runs the model locally (downloaded on first use into ~/.cache/pipedog): Bun, Node and Deno, not Workers.",
    }),
    svc("openai_stt", "OpenAI (Whisper)", "@pipedog/openai", ["OpenAISTTService"]),
    svc("openai_realtime_stt", "OpenAI Realtime", "@pipedog/openai", ["OpenAIRealtimeSTTService"]),
    svc("together_stt", "Together AI", "@pipedog/together", ["TogetherSTTService"]),
    svc("whisper_stt", "Whisper (Local)", "@pipedog/whisper", ["WhisperSTTService"], {
      extraDependencies: { "onnxruntime-node": "^1.30.0" },
      note: "Runs the model locally (downloaded on first use into ~/.cache/pipedog): Bun, Node and Deno, not Workers.",
    }),
    svc("xai_stt", "xAI", "@pipedog/xai", ["XAISTTService"]),
  ];

  /** LLM services (cascade mode). */
  static readonly LLM_SERVICES: ServiceDefinition[] = [
    svc("anthropic_llm", "Anthropic Claude", "@pipedog/anthropic", ["AnthropicLLMService"]),
    svc("aws_bedrock_llm", "AWS Bedrock", "@pipedog/aws", ["AWSBedrockLLMService"]),
    svc("azure_llm", "Azure OpenAI", "@pipedog/azure", ["AzureLLMService"]),
    svc("google_gemini_llm", "Google Gemini", "@pipedog/google", ["GoogleLLMService"]),
    svc("google_vertex_llm", "Google Vertex AI", "@pipedog/google", ["GoogleVertexLLMService"], {
      note: "Uses Google's Node SDK for credentials: runs on Bun and Node.",
    }),
    svc("openai_llm", "OpenAI", "@pipedog/openai", ["OpenAILLMService"]),
    svc("openai_responses_llm", "OpenAI Responses", "@pipedog/openai", [
      "OpenAIResponsesLLMService",
    ]),
    // The OpenAI-compatible services, one package each.
    ...COMPATIBLE_LLMS.map((l) => svc(l.value, l.label, l.pkg, [l.cls])),
  ].sort((a, b) => a.label.localeCompare(b.label));

  /** Text-to-speech services (cascade mode). */
  static readonly TTS_SERVICES: ServiceDefinition[] = [
    svc("aws_polly_tts", "AWS Polly", "@pipedog/aws", ["AWSPollyTTSService"]),
    svc("azure_tts", "Azure TTS", "@pipedog/azure", ["AzureTTSService"]),
    svc("cartesia_tts", "Cartesia", "@pipedog/cartesia", ["CartesiaTTSService"]),
    svc("deepgram_tts", "Deepgram", "@pipedog/deepgram", ["DeepgramTTSService"]),
    svc("deepgram_flux_tts", "Deepgram Flux", "@pipedog/deepgram", ["DeepgramFluxTTSService"]),
    svc("elevenlabs_tts", "ElevenLabs", "@pipedog/elevenlabs", ["ElevenLabsTTSService"]),
    svc("gemini_tts", "Gemini TTS", "@pipedog/google", ["GeminiTTSService"]),
    svc("google_tts", "Google TTS", "@pipedog/google", ["GoogleTTSService"], {
      note: "Uses Google's gRPC Node SDK: runs on Bun and Node, not on Workers.",
    }),
    svc("groq_tts", "Groq TTS", "@pipedog/groq", ["GroqTTSService"]),
    svc("inworld_tts", "Inworld", "@pipedog/inworld", ["InworldTTSService"]),
    svc("kokoro_tts", "Kokoro", "@pipedog/kokoro", ["KokoroTTSService"], {
      extraDependencies: {
        "onnxruntime-node": "^1.30.0",
        "@echogarden/espeak-ng-emscripten": "^0.3.5",
      },
      note: "Runs the model locally (downloaded on first use into ~/.cache/pipedog): Bun, Node and Deno, not Workers.",
    }),
    svc("mistral_tts", "Mistral", "@pipedog/mistral", ["MistralTTSService"]),
    svc("openai_tts", "OpenAI TTS", "@pipedog/openai", ["OpenAITTSService"]),
    svc("piper_tts", "Piper", "@pipedog/piper", ["PiperTTSService"], {
      extraDependencies: {
        "onnxruntime-node": "^1.30.0",
        "@echogarden/espeak-ng-emscripten": "^0.3.5",
      },
      note: "Runs the model locally (downloaded on first use into ~/.cache/pipedog): Bun, Node and Deno, not Workers.",
    }),
    svc("pockettts_tts", "Pocket TTS", "@pipedog/pocket-tts", ["PocketTTSService"], {
      extraDependencies: { "onnxruntime-node": "^1.30.0" },
      note: "Runs the model locally (downloaded on first use into ~/.cache/pipedog): Bun, Node and Deno, not Workers.",
    }),
    svc("together_tts", "Together AI", "@pipedog/together", ["TogetherTTSService"]),
    svc("xai_tts", "xAI", "@pipedog/xai", ["XAITTSService"]),
  ];

  /** Realtime (speech-to-speech) services. */
  static readonly REALTIME_SERVICES: ServiceDefinition[] = [
    svc("aws_nova_realtime", "AWS Nova Sonic", "@pipedog/aws", ["AWSNovaSonicLLMService"]),
    svc("azure_realtime", "Azure Realtime", "@pipedog/azure", ["AzureRealtimeLLMService"]),
    svc("azure_voice_live", "Azure Voice Live", "@pipedog/azure", ["AzureVoiceLiveLLMService"]),
    svc("gemini_live_realtime", "Gemini Live", "@pipedog/google", ["GeminiLiveLLMService"]),
    svc("gemini_vertex_live_realtime", "Gemini Vertex Live", "@pipedog/google", [
      "GeminiLiveVertexLLMService",
    ]),
    svc("xai_realtime", "Grok Realtime", "@pipedog/xai", ["GrokRealtimeLLMService"]),
    svc("inworld_realtime", "Inworld Realtime", "@pipedog/inworld", ["InworldRealtimeLLMService"]),
    svc("openai_realtime", "OpenAI Realtime", "@pipedog/openai", ["OpenAIRealtimeLLMService"]),
    svc("ultravox", "Ultravox", "@pipedog/ultravox", ["UltravoxRealtimeLLMService"]),
  ];

  /** Video avatar services (web bots). */
  static readonly VIDEO_SERVICES: ServiceDefinition[] = [
    svc("heygen_video", "HeyGen", "@pipedog/heygen", ["HeyGenVideoService"]),
  ];
}
