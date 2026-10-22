// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/cli/registry/_configs.py

/**
 * Service configurations: the TypeScript expression that builds each service in a
 * generated `bot.ts`, keyed by the service value (`"deepgram_stt"`).
 *
 * DIVERGENCE: upstream's `_configs.py` is generated from `service_metadata.py` by
 * `scripts/cli/update_registry.py` and holds Python. This file is hand-written TypeScript, and
 * `test/test_service_registry.test.ts` takes the place of the generator: it checks that every
 * class and module named here exists in the workspace package, that every environment variable
 * a config reads is declared in `service_metadata.ts`, and (in `test/e2e`) that every config
 * type-checks against the real packages. The OpenAI-compatible LLM services are built from the
 * `COMPATIBLE_LLMS` table, which the test compares with `apps/docs/data/providers.ts`.
 *
 * A config is an expression. Continuation lines are indented relative to the line it starts on;
 * `SYSTEM_INSTRUCTION` is a constant defined in the generated `bot.ts`.
 */

/** An OpenAI-compatible LLM service (a subclass of `OpenAILLMService`, one package each). */
export interface CompatibleLlm {
  /** The service value. */
  value: string;
  /** The label in prompts. */
  label: string;
  /** The npm package. */
  pkg: string;
  /** The service class, in `<pkg>/llm`. */
  cls: string;
  /** The environment variable holding the API key; `null` when the provider needs none. */
  env: string | null;
  /** The default model. */
  model: string;
}

/** The OpenAI-compatible LLM services, checked against `apps/docs/data/providers.ts`. */
export const COMPATIBLE_LLMS: readonly CompatibleLlm[] = [
  {
    value: "baseten_llm",
    label: "Baseten",
    pkg: "@pipedog/baseten",
    cls: "BasetenLLMService",
    env: "BASETEN_API_KEY",
    model: "zai-org/GLM-5.3",
  },
  {
    value: "cerebras_llm",
    label: "Cerebras",
    pkg: "@pipedog/cerebras",
    cls: "CerebrasLLMService",
    env: "CEREBRAS_API_KEY",
    model: "gpt-oss-120b",
  },
  {
    value: "crusoe_llm",
    label: "Crusoe",
    pkg: "@pipedog/crusoe",
    cls: "CrusoeLLMService",
    env: "CRUSOE_API_KEY",
    model: "openai/gpt-oss-120b",
  },
  {
    value: "deepseek_llm",
    label: "DeepSeek",
    pkg: "@pipedog/deepseek",
    cls: "DeepSeekLLMService",
    env: "DEEPSEEK_API_KEY",
    model: "deepseek-flash",
  },
  {
    value: "fireworks_llm",
    label: "Fireworks AI",
    pkg: "@pipedog/fireworks",
    cls: "FireworksLLMService",
    env: "FIREWORKS_API_KEY",
    model: "accounts/fireworks/models/nemotron-3-ultra-nvfp4",
  },
  {
    value: "xai_llm",
    label: "Grok",
    pkg: "@pipedog/xai",
    cls: "GrokLLMService",
    env: "XAI_API_KEY",
    model: "grok-4.20-non-reasoning",
  },
  {
    value: "groq_llm",
    label: "Groq",
    pkg: "@pipedog/groq",
    cls: "GroqLLMService",
    env: "GROQ_API_KEY",
    model: "openai/gpt-oss-120b",
  },
  {
    value: "inception_llm",
    label: "Inception",
    pkg: "@pipedog/inception",
    cls: "InceptionLLMService",
    env: "INCEPTION_API_KEY",
    model: "mercury-2",
  },
  {
    value: "mistral_llm",
    label: "Mistral",
    pkg: "@pipedog/mistral",
    cls: "MistralLLMService",
    env: "MISTRAL_API_KEY",
    model: "mistral-small-latest",
  },
  {
    value: "nebius_llm",
    label: "Nebius",
    pkg: "@pipedog/nebius",
    cls: "NebiusLLMService",
    env: "NEBIUS_API_KEY",
    model: "Qwen/Qwen3-30B-A3B-Instruct-2507",
  },
  {
    value: "novita_llm",
    label: "Novita",
    pkg: "@pipedog/novita",
    cls: "NovitaLLMService",
    env: "NOVITA_API_KEY",
    model: "moonshotai/kimi-k2.5",
  },
  {
    value: "ollama_llm",
    label: "Ollama",
    pkg: "@pipedog/ollama",
    cls: "OLLamaLLMService",
    env: null,
    model: "llama2",
  },
  {
    value: "openrouter_llm",
    label: "OpenRouter",
    pkg: "@pipedog/openrouter",
    cls: "OpenRouterLLMService",
    env: "OPENROUTER_API_KEY",
    model: "openai/gpt-4.1",
  },
  {
    value: "perplexity_llm",
    label: "Perplexity",
    pkg: "@pipedog/perplexity",
    cls: "PerplexityLLMService",
    env: "PERPLEXITY_API_KEY",
    model: "sonar",
  },
  {
    value: "qwen_llm",
    label: "Qwen",
    pkg: "@pipedog/qwen",
    cls: "QwenLLMService",
    env: "QWEN_API_KEY",
    model: "qwen-plus",
  },
  {
    value: "sambanova_llm",
    label: "SambaNova",
    pkg: "@pipedog/sambanova",
    cls: "SambaNovaLLMService",
    env: "SAMBANOVA_API_KEY",
    model: "Meta-Llama-3.3-70B-Instruct",
  },
  {
    value: "sarvam_llm",
    label: "Sarvam AI",
    pkg: "@pipedog/sarvam",
    cls: "SarvamLLMService",
    env: "SARVAM_API_KEY",
    model: "sarvam-105b",
  },
  {
    value: "together_llm",
    label: "Together AI",
    pkg: "@pipedog/together",
    cls: "TogetherLLMService",
    env: "TOGETHER_API_KEY",
    model: "zai-org/GLM-5.2",
  },
];

/** The environment variable that overrides a compatible LLM's model: `CEREBRAS_API_KEY` -> `CEREBRAS_MODEL`. */
export function compatibleLlmModelEnv(llm: CompatibleLlm): string {
  return `${llm.value.replace(/_llm$/, "").toUpperCase()}_MODEL`;
}

function compatibleLlmConfig(llm: CompatibleLlm): string {
  const key = llm.env ? `\n  apiKey: process.env.${llm.env} ?? "",` : "";
  return `new ${llm.cls}({${key}
  settings: new ${llm.cls}.Settings({
    model: process.env.${compatibleLlmModelEnv(llm)} ?? ${JSON.stringify(llm.model)},
    systemInstruction: SYSTEM_INSTRUCTION,
  }),
})`;
}

/** An API key and a settings block, the shape of most services. */
function keyed(cls: string, env: string, settings?: string): string {
  const s = settings ? `\n  settings: new ${cls}.Settings({\n${settings}\n  }),` : "";
  return `new ${cls}({\n  apiKey: process.env.${env} ?? "",${s}\n})`;
}

const AWS_CREDENTIALS = `  // Left out, the AWS_* environment variables are read.`;

/** The expression that builds each service, by service value. */
export const SERVICE_CONFIGS: Record<string, string> = {
  // STT services
  aws_transcribe_stt: `new AWSTranscribeSTTService({
${AWS_CREDENTIALS}
  awsAccessKeyId: process.env.AWS_ACCESS_KEY_ID,
  apiKey: process.env.AWS_SECRET_ACCESS_KEY,
  region: process.env.AWS_REGION ?? "us-east-1",
})`,
  azure_stt: `new AzureSTTService({
  apiKey: process.env.AZURE_SPEECH_API_KEY ?? "",
  region: process.env.AZURE_SPEECH_REGION ?? "eastus",
})`,
  cartesia_stt: keyed("CartesiaSTTService", "CARTESIA_API_KEY"),
  cartesia_turns_stt: keyed("CartesiaTurnsSTTService", "CARTESIA_API_KEY"),
  assemblyai_stt: keyed("AssemblyAISTTService", "ASSEMBLYAI_API_KEY"),
  deepgram_stt: keyed("DeepgramSTTService", "DEEPGRAM_API_KEY"),
  deepgram_flux_stt: keyed("DeepgramFluxSTTService", "DEEPGRAM_API_KEY"),
  elevenlabs_stt: keyed("ElevenLabsSTTService", "ELEVENLABS_API_KEY"),
  elevenlabs_realtime_stt: keyed("ElevenLabsRealtimeSTTService", "ELEVENLABS_API_KEY"),
  gladia_stt: keyed("GladiaSTTService", "GLADIA_API_KEY"),
  gemini_stt: keyed("GeminiSTTService", "GOOGLE_API_KEY"),
  google_stt: `new GoogleSTTService({
  credentialsPath: process.env.GOOGLE_APPLICATION_CREDENTIALS ?? "",
})`,
  gradium_stt: keyed("GradiumSTTService", "GRADIUM_API_KEY"),
  groq_stt: keyed("GroqSTTService", "GROQ_API_KEY"),
  meta_stt: keyed("MetaSTTService", "META_API_KEY"),
  mistral_stt: keyed("MistralSTTService", "MISTRAL_API_KEY"),
  moonshine_stt: `new MoonshineSTTService({
  settings: new MoonshineSTTService.Settings({
    model: process.env.MOONSHINE_MODEL ?? "small-streaming",
  }),
})`,
  openai_stt: keyed("OpenAISTTService", "OPENAI_API_KEY"),
  openai_realtime_stt: `new OpenAIRealtimeSTTService({
  apiKey: process.env.OPENAI_API_KEY ?? "",
  // OpenAI detects the end of each turn, so no turn model has to run here.
  turnDetection: { type: "server_vad" },
})`,
  soniox_stt: keyed("SonioxSTTService", "SONIOX_API_KEY"),
  speechmatics_stt: keyed("SpeechmaticsSTTService", "SPEECHMATICS_API_KEY"),
  sarvam_stt: keyed("SarvamSTTService", "SARVAM_API_KEY"),
  sarvam_realtime_stt: keyed("SarvamRealtimeSTTService", "SARVAM_API_KEY"),
  smallest_stt: keyed("SmallestSTTService", "SMALLEST_API_KEY"),
  together_stt: keyed("TogetherSTTService", "TOGETHER_API_KEY"),
  whisper_stt: `new WhisperSTTService({
  settings: new WhisperSTTService.Settings({
    model: process.env.WHISPER_MODEL ?? "Systran/faster-distil-whisper-medium.en",
  }),
})`,
  xai_stt: keyed("XAISTTService", "XAI_API_KEY"),

  // LLM services
  anthropic_llm: keyed(
    "AnthropicLLMService",
    "ANTHROPIC_API_KEY",
    `    model: process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-6",
    systemInstruction: SYSTEM_INSTRUCTION,
    maxTokens: 1024,`,
  ),
  aws_bedrock_llm: `new AWSBedrockLLMService({
${AWS_CREDENTIALS}
  awsAccessKey: process.env.AWS_ACCESS_KEY_ID,
  awsSecretKey: process.env.AWS_SECRET_ACCESS_KEY,
  awsRegion: process.env.AWS_REGION ?? "us-east-1",
  settings: new AWSBedrockLLMService.Settings({
    model: process.env.AWS_BEDROCK_MODEL ?? "us.anthropic.claude-haiku-4-5-20251001-v1:0",
    systemInstruction: SYSTEM_INSTRUCTION,
    maxTokens: 1024,
  }),
})`,
  azure_llm: `new AzureLLMService({
  apiKey: process.env.AZURE_OPENAI_API_KEY ?? "",
  // Ending the endpoint in /openai/v1 selects Azure's v1 API.
  endpoint: process.env.AZURE_OPENAI_ENDPOINT ?? "",
  settings: new AzureLLMService.Settings({
    // On Azure the model is the deployment name.
    model: process.env.AZURE_OPENAI_MODEL ?? "",
    systemInstruction: SYSTEM_INSTRUCTION,
  }),
})`,
  google_gemini_llm: keyed(
    "GoogleLLMService",
    "GOOGLE_API_KEY",
    `    model: process.env.GOOGLE_MODEL ?? "gemini-3.6-flash",
    systemInstruction: SYSTEM_INSTRUCTION,`,
  ),
  google_vertex_llm: `new GoogleVertexLLMService({
  credentialsPath: process.env.GOOGLE_APPLICATION_CREDENTIALS ?? "",
  projectId: process.env.GOOGLE_CLOUD_PROJECT_ID ?? "",
  settings: new GoogleVertexLLMService.Settings({
    model: process.env.GOOGLE_MODEL ?? "gemini-3.6-flash",
    systemInstruction: SYSTEM_INSTRUCTION,
  }),
})`,
  openai_llm: keyed(
    "OpenAILLMService",
    "OPENAI_API_KEY",
    `    model: process.env.OPENAI_MODEL ?? "gpt-4.1",
    systemInstruction: SYSTEM_INSTRUCTION,`,
  ),
  openai_responses_llm: keyed(
    "OpenAIResponsesLLMService",
    "OPENAI_API_KEY",
    `    model: process.env.OPENAI_MODEL ?? "gpt-4.1",
    systemInstruction: SYSTEM_INSTRUCTION,`,
  ),
  ...Object.fromEntries(COMPATIBLE_LLMS.map((llm) => [llm.value, compatibleLlmConfig(llm)])),

  // TTS services
  aws_polly_tts: `new AWSPollyTTSService({
${AWS_CREDENTIALS}
  awsAccessKeyId: process.env.AWS_ACCESS_KEY_ID,
  apiKey: process.env.AWS_SECRET_ACCESS_KEY,
  region: process.env.AWS_REGION ?? "us-east-1",
  settings: new AWSPollyTTSService.Settings({
    voice: process.env.AWS_POLLY_VOICE ?? "Joanna",
  }),
})`,
  azure_tts: `new AzureTTSService({
  apiKey: process.env.AZURE_SPEECH_API_KEY ?? "",
  region: process.env.AZURE_SPEECH_REGION ?? "eastus",
  settings: new AzureTTSService.Settings({
    voice: process.env.AZURE_SPEECH_VOICE ?? "en-US-AvaMultilingualNeural",
  }),
})`,
  asyncai_tts: keyed(
    "AsyncAITTSService",
    "ASYNC_API_KEY",
    `    voice: process.env.ASYNC_VOICE_ID ?? "",`,
  ),
  bland_tts: keyed(
    "BlandTTSService",
    "BLAND_API_KEY",
    `    voice: process.env.BLAND_VOICE_ID ?? "29158307-9893-4149-8a75-bc9ce313d64e",`,
  ),
  camb_tts: keyed("CambTTSService", "CAMB_API_KEY"),
  cartesia_tts: keyed(
    "CartesiaTTSService",
    "CARTESIA_API_KEY",
    `    voice: process.env.CARTESIA_VOICE_ID ?? "86e30c1d-714b-4074-a1f2-1cb6b552fb49",`,
  ),
  deepgram_tts: keyed(
    "DeepgramTTSService",
    "DEEPGRAM_API_KEY",
    `    voice: process.env.DEEPGRAM_VOICE_ID ?? "aura-2-helena-en",`,
  ),
  deepgram_flux_tts: keyed("DeepgramFluxTTSService", "DEEPGRAM_API_KEY"),
  elevenlabs_tts: keyed(
    "ElevenLabsTTSService",
    "ELEVENLABS_API_KEY",
    `    voice: process.env.ELEVENLABS_VOICE_ID ?? "",`,
  ),
  elevenlabs_dialogue_tts: keyed(
    "ElevenLabsDialogueTTSService",
    "ELEVENLABS_API_KEY",
    `    voice: process.env.ELEVENLABS_VOICE_ID ?? "",`,
  ),
  fish_tts: keyed(
    "FishAudioTTSService",
    "FISH_API_KEY",
    `    voice: process.env.FISH_VOICE_ID ?? "",`,
  ),
  gemini_tts: keyed("GeminiTTSService", "GOOGLE_API_KEY"),
  google_tts: `new GoogleTTSService({
  credentialsPath: process.env.GOOGLE_APPLICATION_CREDENTIALS ?? "",
  settings: new GoogleTTSService.Settings({
    voice: process.env.GOOGLE_VOICE_ID ?? "en-US-Chirp3-HD-Charon",
  }),
})`,
  gradium_tts: keyed("GradiumTTSService", "GRADIUM_API_KEY"),
  groq_tts: keyed(
    "GroqTTSService",
    "GROQ_API_KEY",
    `    voice: process.env.GROQ_VOICE_ID ?? "autumn",`,
  ),
  hume_tts: keyed("HumeTTSService", "HUME_API_KEY", `    voice: process.env.HUME_VOICE_ID ?? "",`),
  inworld_tts: keyed(
    "InworldTTSService",
    "INWORLD_API_KEY",
    `    voice: process.env.INWORLD_VOICE_ID ?? "Ashley",`,
  ),
  kokoro_tts: `new KokoroTTSService({
  settings: new KokoroTTSService.Settings({
    voice: process.env.KOKORO_VOICE_ID ?? "af_heart",
  }),
  minimax_tts: `new MiniMaxHttpTTSService({
  apiKey: process.env.MINIMAX_API_KEY ?? "",
  groupId: process.env.MINIMAX_GROUP_ID ?? "",
})`,
  mistral_tts: keyed(
    "MistralTTSService",
    "MISTRAL_API_KEY",
    `    voice: process.env.MISTRAL_VOICE_ID ?? "",`,
  ),
  neuphonic_tts: keyed(
    "NeuphonicTTSService",
    "NEUPHONIC_API_KEY",
    `    voice: process.env.NEUPHONIC_VOICE_ID ?? "",`,
  ),
  openai_tts: keyed(
    "OpenAITTSService",
    "OPENAI_API_KEY",
    `    voice: process.env.OPENAI_VOICE_ID ?? "marin",`,
  ),
  piper_tts: `new PiperTTSService({
  settings: new PiperTTSService.Settings({
    voice: process.env.PIPER_VOICE_ID ?? "en_US-ryan-high",
  }),
})`,
  pockettts_tts: `new PocketTTSService({
  settings: new PocketTTSService.Settings({
    voice: process.env.POCKET_TTS_VOICE_ID ?? "alba",
  }),
})`,
  rime_tts: keyed(
    "RimeTTSService",
    "RIME_API_KEY",
    `    voice: process.env.RIME_VOICE_ID ?? "luna",`,
  ),
  soniox_tts: keyed("SonioxTTSService", "SONIOX_API_KEY"),
  speechmatics_tts: keyed("SpeechmaticsTTSService", "SPEECHMATICS_API_KEY"),
  resembleai_tts: keyed(
    "ResembleAITTSService",
    "RESEMBLE_API_KEY",
    `    voice: process.env.RESEMBLE_VOICE_UUID ?? "",`,
  ),
  speechify_tts: keyed("SpeechifyHttpTTSService", "SPEECHIFY_API_KEY"),
  together_tts: keyed(
    "TogetherTTSService",
    "TOGETHER_API_KEY",
    `    voice: process.env.TOGETHER_VOICE_ID ?? "af_heart",`,
  ),
  sarvam_tts: keyed("SarvamTTSService", "SARVAM_API_KEY"),
  smallest_tts: keyed("SmallestTTSService", "SMALLEST_API_KEY"),
  xai_tts: keyed("XAITTSService", "XAI_API_KEY", `    voice: process.env.XAI_VOICE_ID ?? "eve",`),

  // Realtime (speech-to-speech) services
  aws_nova_realtime: `new AWSNovaSonicLLMService({
${AWS_CREDENTIALS}
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  region: process.env.AWS_REGION ?? "us-east-1",
  settings: new AWSNovaSonicLLMService.Settings({
    voice: process.env.AWS_NOVA_VOICE ?? "tiffany",
    systemInstruction: SYSTEM_INSTRUCTION,
  }),
})`,
  azure_realtime: `new AzureRealtimeLLMService({
  apiKey: process.env.AZURE_OPENAI_API_KEY ?? "",
  baseUrl: process.env.AZURE_OPENAI_REALTIME_URL ?? "",
  settings: new AzureRealtimeLLMService.Settings({
    // The deployment name, sent as ?model=<deployment>.
    model: process.env.AZURE_OPENAI_MODEL ?? "",
    systemInstruction: SYSTEM_INSTRUCTION,
  }),
})`,
  azure_voice_live: `new AzureVoiceLiveLLMService({
  apiKey: process.env.AZURE_VOICE_LIVE_API_KEY ?? "",
  endpoint: process.env.AZURE_VOICE_LIVE_ENDPOINT ?? "",
  settings: new AzureVoiceLiveLLMService.Settings({
    model: process.env.AZURE_VOICE_LIVE_MODEL ?? "gpt-4o-mini",
    systemInstruction: SYSTEM_INSTRUCTION,
  }),
})`,
  gemini_live_realtime: `new GeminiLiveLLMService({
  apiKey: process.env.GOOGLE_API_KEY ?? "",
  systemInstruction: SYSTEM_INSTRUCTION,
  settings: new GeminiLiveLLMService.Settings({
    voice: process.env.GOOGLE_VOICE_ID ?? "Puck",
  }),
})`,
  gemini_vertex_live_realtime: `new GeminiLiveVertexLLMService({
  credentialsPath: process.env.GOOGLE_APPLICATION_CREDENTIALS ?? "",
  projectId: process.env.GOOGLE_CLOUD_PROJECT_ID ?? "",
  location: process.env.GOOGLE_CLOUD_LOCATION ?? "us-east4",
  systemInstruction: SYSTEM_INSTRUCTION,
})`,
  inworld_realtime: `new InworldRealtimeLLMService({
  apiKey: process.env.INWORLD_API_KEY ?? "",
  settings: new InworldRealtimeLLMService.Settings({
    systemInstruction: SYSTEM_INSTRUCTION,
  }),
})`,
  openai_realtime: `new OpenAIRealtimeLLMService({
  apiKey: process.env.OPENAI_API_KEY ?? "",
  settings: new OpenAIRealtimeLLMService.Settings({
    systemInstruction: SYSTEM_INSTRUCTION,
    sessionProperties: new SessionProperties({
      audio: new AudioConfiguration({
        input: new AudioInput({
          transcription: new InputAudioTranscription(),
          turnDetection: new SemanticTurnDetection(),
        }),
      }),
    }),
  }),
})`,
  ultravox: `new UltravoxRealtimeLLMService({
  params: new OneShotInputParams({
    apiKey: process.env.ULTRAVOX_API_KEY ?? "",
    systemPrompt: SYSTEM_INSTRUCTION,
  }),
})`,
  xai_realtime: `new GrokRealtimeLLMService({
  apiKey: process.env.XAI_API_KEY ?? "",
  settings: new GrokRealtimeLLMService.Settings({
    systemInstruction: SYSTEM_INSTRUCTION,
  }),
})`,

  // Video avatar services
  heygen_video: `new HeyGenVideoService({
  apiKey: process.env.HEYGEN_LIVE_AVATAR_API_KEY ?? "",
  serviceType: ServiceType.LIVE_AVATAR,
  sessionRequest: new LiveAvatarNewSessionRequest({
    avatarId: process.env.HEYGEN_AVATAR_ID ?? "",
  }),
})`,
};
