// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// The provider catalog behind the Services, Transports and Serializers sections. The ported pages
// are written by hand; scripts/generate-providers.ts writes the "coming soon" pages, the folder
// meta.json files and the overview tables from this file. Run `bun run providers:generate` in
// apps/docs after changing it.

export type Category = "llm" | "stt" | "tts" | "s2s" | "image" | "video";
export type Section = Category | "transports" | "serializers";

export interface SectionInfo {
  /** Sidebar title. */
  title: string;
  /** One line, for the folder's index and the overview table. */
  description: string;
  /** Pipecat's docs folder for this category, under docs.pipecat.ai/api-reference/server/services/. */
  upstreamFolder: string;
}

export const sections: Record<Section, SectionInfo> = {
  llm: {
    title: "LLM",
    description: "Chat models that turn the conversation context into a response.",
    upstreamFolder: "llm",
  },
  stt: {
    title: "Speech-to-text",
    description: "Transcribe the user's speech into TranscriptionFrames.",
    upstreamFolder: "stt",
  },
  tts: {
    title: "Text-to-speech",
    description: "Turn the bot's text into audio frames.",
    upstreamFolder: "tts",
  },
  s2s: {
    title: "Speech-to-speech",
    description: "Realtime models that take audio in and give audio out, in one service.",
    upstreamFolder: "s2s",
  },
  image: {
    title: "Image generation",
    description: "Generate images from text prompts.",
    upstreamFolder: "image-generation",
  },
  video: {
    title: "Video avatars",
    description: "Animated avatars that speak the bot's audio.",
    upstreamFolder: "video",
  },
  transports: {
    title: "Transports",
    description: "Move audio, video and messages between the user and the pipeline.",
    upstreamFolder: "transport",
  },
  serializers: {
    title: "Serializers",
    description:
      "Convert frames to and from a wire format, for WebSocket and telephony transports.",
    upstreamFolder: "serializers",
  },
};

export interface PortedPage {
  /** File name under content/docs/<folder>/, without .mdx. */
  slug: string;
  /** Display name, for the overview table. */
  name: string;
  /** The pipedog package. */
  pkg: string;
  /** The ported classes. */
  classes: string[];
}

/** Pages written by hand, in sidebar order. */
export const ported: Record<Section, PortedPage[]> = {
  llm: [
    { slug: "openai", name: "OpenAI", pkg: "@pipedog/openai", classes: ["OpenAILLMService"] },
    {
      slug: "openai-responses",
      name: "OpenAI Responses",
      pkg: "@pipedog/openai",
      classes: ["OpenAIResponsesLLMService", "OpenAIResponsesHttpLLMService"],
    },
    {
      slug: "anthropic",
      name: "Anthropic",
      pkg: "@pipedog/anthropic",
      classes: ["AnthropicLLMService"],
    },
    {
      slug: "google",
      name: "Google Gemini",
      pkg: "@pipedog/google",
      classes: ["GoogleLLMService"],
    },
    {
      slug: "google-vertex",
      name: "Google Vertex AI",
      pkg: "@pipedog/google",
      classes: ["GoogleVertexLLMService"],
    },
    {
      slug: "langchain",
      name: "LangChain",
      pkg: "@pipedog/langchain",
      classes: ["LangchainProcessor"],
    },
  ],
  stt: [
    {
      slug: "deepgram",
      name: "Deepgram",
      pkg: "@pipedog/deepgram",
      classes: ["DeepgramSTTService", "DeepgramFluxSTTService"],
    },
    {
      slug: "openai",
      name: "OpenAI",
      pkg: "@pipedog/openai",
      classes: ["OpenAISTTService", "OpenAIRealtimeSTTService"],
    },
    {
      slug: "google",
      name: "Google",
      pkg: "@pipedog/google",
      classes: ["GoogleSTTService", "GeminiSTTService"],
    },
    {
      slug: "cartesia",
      name: "Cartesia",
      pkg: "@pipedog/cartesia",
      classes: ["CartesiaSTTService", "CartesiaTurnsSTTService"],
    },
    {
      slug: "elevenlabs",
      name: "ElevenLabs",
      pkg: "@pipedog/elevenlabs",
      classes: ["ElevenLabsSTTService", "ElevenLabsRealtimeSTTService"],
    },
    {
      slug: "whisper",
      name: "Whisper (base)",
      pkg: "@pipedog/whisper",
      classes: ["BaseWhisperSTTService"],
    },
  ],
  tts: [
    { slug: "openai", name: "OpenAI", pkg: "@pipedog/openai", classes: ["OpenAITTSService"] },
    {
      slug: "google",
      name: "Google",
      pkg: "@pipedog/google",
      classes: ["GoogleTTSService", "GoogleHttpTTSService", "GeminiTTSService"],
    },
    {
      slug: "deepgram",
      name: "Deepgram",
      pkg: "@pipedog/deepgram",
      classes: ["DeepgramTTSService", "DeepgramHttpTTSService", "DeepgramFluxTTSService"],
    },
    {
      slug: "cartesia",
      name: "Cartesia",
      pkg: "@pipedog/cartesia",
      classes: ["CartesiaTTSService", "CartesiaHttpTTSService"],
    },
    {
      slug: "elevenlabs",
      name: "ElevenLabs",
      pkg: "@pipedog/elevenlabs",
      classes: ["ElevenLabsTTSService", "ElevenLabsHttpTTSService"],
    },
  ],
  s2s: [
    {
      slug: "openai",
      name: "OpenAI Realtime",
      pkg: "@pipedog/openai",
      classes: ["OpenAIRealtimeLLMService"],
    },
    {
      slug: "openai-live",
      name: "OpenAI Live",
      pkg: "@pipedog/openai",
      classes: ["OpenAILiveLLMService"],
    },
    {
      slug: "gemini-live",
      name: "Gemini Live",
      pkg: "@pipedog/google",
      classes: ["GeminiLiveLLMService"],
    },
    {
      slug: "gemini-live-vertex",
      name: "Gemini Live on Vertex AI",
      pkg: "@pipedog/google",
      classes: ["GeminiLiveVertexLLMService"],
    },
  ],
  image: [
    { slug: "openai", name: "OpenAI", pkg: "@pipedog/openai", classes: ["OpenAIImageGenService"] },
    { slug: "google", name: "Google", pkg: "@pipedog/google", classes: ["GoogleImageGenService"] },
  ],
  video: [],
  transports: [
    {
      slug: "websocket",
      name: "WebSocket",
      pkg: "@pipedog/transport-websocket",
      classes: [
        "FastAPIWebsocketTransport",
        "SingleClientWebsocketServerTransport",
        "WebsocketClientTransport",
        "RTVIClientTransport",
      ],
    },
    {
      slug: "smallwebrtc",
      name: "SmallWebRTC",
      pkg: "@pipedog/transport-smallwebrtc",
      classes: ["SmallWebRTCTransport"],
    },
  ],
  serializers: [
    {
      slug: "protobuf",
      name: "Protobuf",
      pkg: "@pipedog/serializer-protobuf",
      classes: ["ProtobufFrameSerializer"],
    },
    {
      slug: "rtvi-client",
      name: "RTVI client",
      pkg: "@pipedog/serializer-rtvi-client",
      classes: ["RTVIClientSerializer"],
    },
    {
      slug: "telnyx",
      name: "Telnyx",
      pkg: "@pipedog/serializer-telnyx",
      classes: ["TelnyxFrameSerializer"],
    },
  ],
};

export interface UpcomingPage {
  section: Section;
  /** File name, and the slug of the upstream page unless `upstreamUrl` is set. */
  slug: string;
  /** Display name. */
  name: string;
  /** What the provider is, in one or two sentences. */
  about: string;
  /** The upstream classes a port would bring over. */
  classes: string[];
  /** The upstream module(s), under src/pipecat/. */
  modules: string[];
  /** The upstream docs page, when it isn't <upstreamFolder>/<slug>. */
  upstreamUrl?: string;
}

/** Popular upstream providers that aren't ported yet: one short page each. */
export const upcoming: UpcomingPage[] = [
  // LLM
  {
    section: "llm",
    slug: "azure",
    name: "Azure OpenAI",
    about: "OpenAI models hosted on Microsoft Azure, through the OpenAI-compatible API.",
    classes: ["AzureLLMService"],
    modules: ["services/azure/llm.py"],
  },
  {
    section: "llm",
    slug: "aws",
    name: "AWS Bedrock",
    about: "Foundation models (Claude, Llama, Nova and others) through Amazon Bedrock.",
    classes: ["AWSBedrockLLMService"],
    modules: ["services/aws/llm.py"],
  },
  {
    section: "llm",
    slug: "groq",
    name: "Groq",
    about: "Fast inference of open models on Groq's LPUs, with an OpenAI-compatible API.",
    classes: ["GroqLLMService"],
    modules: ["services/groq/llm.py"],
  },
  {
    section: "llm",
    slug: "together",
    name: "Together AI",
    about: "Open models served by Together AI, with an OpenAI-compatible API.",
    classes: ["TogetherLLMService"],
    modules: ["services/together/llm.py"],
  },
  {
    section: "llm",
    slug: "ollama",
    name: "Ollama",
    about: "Open models running locally with Ollama.",
    classes: ["OLLamaLLMService"],
    modules: ["services/ollama/llm.py"],
  },
  {
    section: "llm",
    slug: "mistral",
    name: "Mistral",
    about: "Mistral AI's chat models.",
    classes: ["MistralLLMService"],
    modules: ["services/mistral/llm.py"],
  },
  {
    section: "llm",
    slug: "grok",
    name: "xAI Grok",
    about: "xAI's Grok models, with an OpenAI-compatible API.",
    classes: ["GrokLLMService"],
    modules: ["services/xai/llm.py"],
  },
  {
    section: "llm",
    slug: "nvidia",
    name: "NVIDIA",
    about: "Models served by NVIDIA NIM.",
    classes: ["NvidiaLLMService"],
    modules: ["services/nvidia/llm.py"],
  },
  {
    section: "llm",
    slug: "deepseek",
    name: "DeepSeek",
    about: "DeepSeek's chat and reasoning models.",
    classes: ["DeepSeekLLMService"],
    modules: ["services/deepseek/llm.py"],
  },
  {
    section: "llm",
    slug: "openrouter",
    name: "OpenRouter",
    about: "One API in front of many model providers.",
    classes: ["OpenRouterLLMService"],
    modules: ["services/openrouter/llm.py"],
  },
  {
    section: "llm",
    slug: "cerebras",
    name: "Cerebras",
    about: "Fast inference of open models on Cerebras hardware.",
    classes: ["CerebrasLLMService"],
    modules: ["services/cerebras/llm.py"],
  },
  {
    section: "llm",
    slug: "fireworks",
    name: "Fireworks AI",
    about: "Open models served by Fireworks AI.",
    classes: ["FireworksLLMService"],
    modules: ["services/fireworks/llm.py"],
  },
  {
    section: "llm",
    slug: "sarvam",
    name: "Sarvam AI",
    about: "Sarvam AI's models for Indian languages.",
    classes: ["SarvamLLMService"],
    modules: ["services/sarvam/llm.py"],
  },
  // STT
  {
    section: "stt",
    slug: "azure",
    name: "Azure Speech",
    about: "Speech recognition from Azure AI Speech.",
    classes: ["AzureSTTService"],
    modules: ["services/azure/stt.py"],
  },
  {
    section: "stt",
    slug: "aws",
    name: "AWS Transcribe",
    about: "Streaming speech recognition from Amazon Transcribe.",
    classes: ["AWSTranscribeSTTService"],
    modules: ["services/aws/stt.py"],
  },
  {
    section: "stt",
    slug: "groq",
    name: "Groq",
    about: "Whisper models served by Groq.",
    classes: ["GroqSTTService"],
    modules: ["services/groq/stt.py"],
  },
  {
    section: "stt",
    slug: "assemblyai",
    name: "AssemblyAI",
    about: "AssemblyAI's streaming speech recognition, with turn detection.",
    classes: ["AssemblyAISTTService", "AssemblyAISyncSTTService"],
    modules: ["services/assemblyai/stt.py"],
  },
  {
    section: "stt",
    slug: "gladia",
    name: "Gladia",
    about: "Gladia's realtime multilingual speech recognition.",
    classes: ["GladiaSTTService"],
    modules: ["services/gladia/stt.py"],
  },
  {
    section: "stt",
    slug: "speechmatics",
    name: "Speechmatics",
    about: "Speechmatics' realtime speech recognition, with diarization.",
    classes: ["SpeechmaticsSTTService"],
    modules: ["services/speechmatics/stt.py"],
  },
  {
    section: "stt",
    slug: "together",
    name: "Together AI",
    about: "Speech recognition models served by Together AI.",
    classes: ["TogetherSTTService"],
    modules: ["services/together/stt.py"],
  },
  {
    section: "stt",
    slug: "mistral",
    name: "Mistral",
    about: "Mistral AI's Voxtral speech recognition.",
    classes: ["MistralSTTService"],
    modules: ["services/mistral/stt.py"],
  },
  {
    section: "stt",
    slug: "xai",
    name: "xAI",
    about: "xAI's speech recognition.",
    classes: ["XAISTTService"],
    modules: ["services/xai/stt.py"],
  },
  {
    section: "stt",
    slug: "soniox",
    name: "Soniox",
    about: "Soniox's realtime multilingual speech recognition.",
    classes: ["SonioxSTTService"],
    modules: ["services/soniox/stt.py"],
  },
  {
    section: "stt",
    slug: "nvidia",
    name: "NVIDIA Riva",
    about: "Speech recognition from NVIDIA Riva.",
    classes: ["NvidiaSTTService", "NvidiaSegmentedSTTService"],
    modules: ["services/nvidia/stt.py"],
  },
  {
    section: "stt",
    slug: "sarvam",
    name: "Sarvam AI",
    about: "Speech recognition for Indian languages from Sarvam AI.",
    classes: ["SarvamSTTService", "SarvamRealtimeSTTService"],
    modules: ["services/sarvam/stt.py"],
  },
  // TTS
  {
    section: "tts",
    slug: "azure",
    name: "Azure Speech",
    about: "Neural voices from Azure AI Speech.",
    classes: ["AzureTTSService", "AzureHttpTTSService"],
    modules: ["services/azure/tts.py"],
  },
  {
    section: "tts",
    slug: "aws",
    name: "AWS Polly",
    about: "Speech synthesis from Amazon Polly.",
    classes: ["AWSPollyTTSService"],
    modules: ["services/aws/tts.py"],
  },
  {
    section: "tts",
    slug: "groq",
    name: "Groq",
    about: "Speech synthesis served by Groq.",
    classes: ["GroqTTSService"],
    modules: ["services/groq/tts.py"],
  },
  {
    section: "tts",
    slug: "speechmatics",
    name: "Speechmatics",
    about: "Speech synthesis from Speechmatics.",
    classes: ["SpeechmaticsTTSService"],
    modules: ["services/speechmatics/tts.py"],
  },
  {
    section: "tts",
    slug: "rime",
    name: "Rime",
    about: "Rime's expressive voices for conversational agents.",
    classes: ["RimeTTSService", "RimeHttpTTSService", "RimeNonJsonTTSService"],
    modules: ["services/rime/tts.py"],
  },
  {
    section: "tts",
    slug: "together",
    name: "Together AI",
    about: "Speech synthesis models served by Together AI.",
    classes: ["TogetherTTSService"],
    modules: ["services/together/tts.py"],
  },
  {
    section: "tts",
    slug: "mistral",
    name: "Mistral",
    about: "Speech synthesis from Mistral AI.",
    classes: ["MistralTTSService"],
    modules: ["services/mistral/tts.py"],
  },
  {
    section: "tts",
    slug: "xai",
    name: "xAI",
    about: "Speech synthesis from xAI.",
    classes: ["XAITTSService", "XAIHttpTTSService"],
    modules: ["services/xai/tts.py"],
  },
  {
    section: "tts",
    slug: "fish",
    name: "Fish Audio",
    about: "Fish Audio's voices, including cloned voices.",
    classes: ["FishAudioTTSService"],
    modules: ["services/fish/tts.py"],
  },
  {
    section: "tts",
    slug: "soniox",
    name: "Soniox",
    about: "Speech synthesis from Soniox.",
    classes: ["SonioxTTSService"],
    modules: ["services/soniox/tts.py"],
  },
  {
    section: "tts",
    slug: "nvidia",
    name: "NVIDIA Riva",
    about: "Speech synthesis from NVIDIA Riva.",
    classes: ["NvidiaTTSService"],
    modules: ["services/nvidia/tts.py"],
  },
  {
    section: "tts",
    slug: "inworld",
    name: "Inworld",
    about: "Inworld's low-latency voices.",
    classes: ["InworldTTSService", "InworldHttpTTSService"],
    modules: ["services/inworld/tts.py"],
  },
  {
    section: "tts",
    slug: "hume",
    name: "Hume",
    about: "Hume's expressive speech synthesis (Octave).",
    classes: ["HumeTTSService"],
    modules: ["services/hume/tts.py"],
  },
  {
    section: "tts",
    slug: "sarvam",
    name: "Sarvam AI",
    about: "Speech synthesis for Indian languages from Sarvam AI.",
    classes: ["SarvamTTSService", "SarvamHttpTTSService"],
    modules: ["services/sarvam/tts.py"],
  },
  // Speech-to-speech
  {
    section: "s2s",
    slug: "aws",
    name: "AWS Nova Sonic",
    about: "Amazon Nova Sonic, a speech-to-speech model on Amazon Bedrock.",
    classes: ["AWSNovaSonicLLMService"],
    modules: ["services/aws/nova_sonic/llm.py"],
  },
  {
    section: "s2s",
    slug: "azure-voice-live",
    name: "Azure Voice Live",
    about: "Azure's realtime speech-to-speech APIs: Voice Live, and OpenAI Realtime on Azure.",
    classes: ["AzureVoiceLiveLLMService", "AzureRealtimeLLMService"],
    modules: ["services/azure/voice_live/llm.py", "services/azure/realtime/llm.py"],
  },
  {
    section: "s2s",
    slug: "grok",
    name: "xAI Grok Realtime",
    about: "xAI's realtime voice API.",
    classes: ["GrokRealtimeLLMService"],
    modules: ["services/xai/realtime/llm.py"],
  },
  {
    section: "s2s",
    slug: "ultravox",
    name: "Ultravox",
    about: "Ultravox's realtime speech-to-speech model.",
    classes: ["UltravoxRealtimeLLMService"],
    modules: ["services/ultravox/llm.py"],
  },
  {
    section: "s2s",
    slug: "inworld",
    name: "Inworld Realtime",
    about: "Inworld's realtime speech-to-speech API.",
    classes: ["InworldRealtimeLLMService"],
    modules: ["services/inworld/realtime/llm.py"],
  },
  // Image
  {
    section: "image",
    slug: "azure",
    name: "Azure OpenAI",
    about: "Image generation with OpenAI models on Azure.",
    classes: ["AzureImageGenServiceREST"],
    modules: ["services/azure/image.py"],
  },
  // Video
  {
    section: "video",
    slug: "tavus",
    name: "Tavus",
    about: "Tavus' realtime video avatars.",
    classes: ["TavusVideoService", "TavusTransport"],
    modules: ["services/tavus/video.py", "transports/tavus/transport.py"],
  },
  {
    section: "video",
    slug: "heygen",
    name: "HeyGen",
    about: "HeyGen's interactive and LiveAvatar video avatars.",
    classes: ["HeyGenVideoService", "HeyGenTransport"],
    modules: ["services/heygen/video.py", "transports/heygen/transport.py"],
  },
  {
    section: "video",
    slug: "simli",
    name: "Simli",
    about: "Simli's realtime lip-synced avatars.",
    classes: ["SimliVideoService"],
    modules: ["services/simli/video.py"],
  },
  // Transports
  {
    section: "transports",
    slug: "daily",
    name: "Daily",
    about: "WebRTC rooms on Daily, with telephony (PSTN and SIP) and recording.",
    classes: ["DailyTransport"],
    modules: ["transports/daily/transport.py"],
  },
  {
    section: "transports",
    slug: "livekit",
    name: "LiveKit",
    about: "WebRTC rooms on LiveKit.",
    classes: ["LiveKitTransport"],
    modules: ["transports/livekit/transport.py"],
  },
  {
    section: "transports",
    slug: "vonage",
    name: "Vonage Video",
    about: "Vonage Video API sessions, through the Video Connector.",
    classes: ["VonageVideoConnectorTransport"],
    modules: ["transports/vonage/video_connector.py"],
  },
  {
    section: "transports",
    slug: "whatsapp",
    name: "WhatsApp",
    about: "WhatsApp Business voice calls, over WebRTC.",
    classes: ["WhatsAppClient"],
    modules: ["transports/whatsapp/client.py", "transports/whatsapp/api.py"],
  },
  {
    section: "transports",
    slug: "local-audio",
    name: "Local audio",
    about: "The machine's microphone and speakers, for development (PyAudio upstream).",
    classes: ["LocalAudioTransport"],
    modules: ["transports/local/audio.py"],
    upstreamUrl:
      "https://github.com/pipecat-ai/pipecat/blob/main/src/pipecat/transports/local/audio.py",
  },
  // Serializers
  {
    section: "serializers",
    slug: "twilio",
    name: "Twilio",
    about: "Twilio Media Streams, for phone calls over a WebSocket.",
    classes: ["TwilioFrameSerializer"],
    modules: ["serializers/twilio.py"],
  },
  {
    section: "serializers",
    slug: "plivo",
    name: "Plivo",
    about: "Plivo audio streams, for phone calls over a WebSocket.",
    classes: ["PlivoFrameSerializer"],
    modules: ["serializers/plivo.py"],
  },
  {
    section: "serializers",
    slug: "exotel",
    name: "Exotel",
    about: "Exotel voice streams, for phone calls over a WebSocket.",
    classes: ["ExotelFrameSerializer"],
    modules: ["serializers/exotel.py"],
  },
  {
    section: "serializers",
    slug: "vonage",
    name: "Vonage",
    about: "Vonage Voice API audio over a WebSocket.",
    classes: ["VonageFrameSerializer"],
    modules: ["serializers/vonage.py"],
  },
  {
    section: "serializers",
    slug: "genesys",
    name: "Genesys",
    about: "Genesys Cloud AudioHook, for contact-center calls.",
    classes: ["GenesysAudioHookSerializer"],
    modules: ["serializers/genesys.py"],
  },
];

export interface LongTailProvider {
  name: string;
  /** Upstream folder under src/pipecat/services/. */
  folder: string;
  /** What the upstream modules provide. */
  kinds: string[];
  classes: string[];
}

/** Every other upstream service, listed on one page. */
export const longTail: LongTailProvider[] = [
  { name: "Async", folder: "asyncai", kinds: ["TTS"], classes: ["AsyncAITTSService"] },
  { name: "Baseten", folder: "baseten", kinds: ["LLM"], classes: ["BasetenLLMService"] },
  { name: "Bland", folder: "bland", kinds: ["TTS"], classes: ["BlandTTSService"] },
  { name: "Camb.ai", folder: "camb", kinds: ["TTS"], classes: ["CambTTSService"] },
  { name: "Crusoe", folder: "crusoe", kinds: ["LLM"], classes: ["CrusoeLLMService"] },
  {
    name: "fal",
    folder: "fal",
    kinds: ["STT", "Image"],
    classes: ["FalSTTService", "FalImageGenService"],
  },
  { name: "FunASR", folder: "funasr", kinds: ["STT"], classes: ["FunASRSTTService"] },
  {
    name: "Gradium",
    folder: "gradium",
    kinds: ["STT", "TTS"],
    classes: ["GradiumSTTService", "GradiumTTSService"],
  },
  { name: "Inception", folder: "inception", kinds: ["LLM"], classes: ["InceptionLLMService"] },
  { name: "Keenable", folder: "keenable", kinds: ["Search"], classes: ["KeenableWebSearch"] },
  { name: "Kokoro", folder: "kokoro", kinds: ["TTS"], classes: ["KokoroTTSService"] },
  { name: "Mem0", folder: "mem0", kinds: ["Memory"], classes: ["Mem0MemoryService"] },
  { name: "Meta", folder: "meta", kinds: ["STT"], classes: ["MetaSTTService"] },
  { name: "MiniMax", folder: "minimax", kinds: ["TTS"], classes: ["MiniMaxHttpTTSService"] },
  { name: "Moondream", folder: "moondream", kinds: ["Vision"], classes: ["MoondreamService"] },
  { name: "Moonshine", folder: "moonshine", kinds: ["STT"], classes: ["MoonshineSTTService"] },
  { name: "Nebius", folder: "nebius", kinds: ["LLM"], classes: ["NebiusLLMService"] },
  { name: "Neuphonic", folder: "neuphonic", kinds: ["TTS"], classes: ["NeuphonicTTSService"] },
  { name: "Novita", folder: "novita", kinds: ["LLM"], classes: ["NovitaLLMService"] },
  {
    name: "OpenClaw",
    folder: "openclaw",
    kinds: ["Agents"],
    classes: ["OpenClawGatewayService"],
  },
  { name: "Perplexity", folder: "perplexity", kinds: ["LLM"], classes: ["PerplexityLLMService"] },
  { name: "Piper", folder: "piper", kinds: ["TTS"], classes: ["PiperTTSService"] },
  { name: "Pocket TTS", folder: "pocket_tts", kinds: ["TTS"], classes: ["PocketTTSService"] },
  { name: "Qwen", folder: "qwen", kinds: ["LLM"], classes: ["QwenLLMService"] },
  {
    name: "Resemble AI",
    folder: "resembleai",
    kinds: ["TTS"],
    classes: ["ResembleAITTSService"],
  },
  { name: "SambaNova", folder: "sambanova", kinds: ["LLM"], classes: ["SambaNovaLLMService"] },
  {
    name: "Smallest AI",
    folder: "smallest",
    kinds: ["STT", "TTS"],
    classes: ["SmallestSTTService", "SmallestTTSService"],
  },
  { name: "Speechify", folder: "speechify", kinds: ["TTS"], classes: ["SpeechifyHttpTTSService"] },
  { name: "XTTS", folder: "xtts", kinds: ["TTS"], classes: ["XTTSService"] },
];

/** Classes of ported providers that aren't ported yet themselves. */
export const unportedVariants: { name: string; classes: string[]; modules: string[] }[] = [
  {
    name: "Deepgram on SageMaker",
    classes: [
      "DeepgramSageMakerSTTService",
      "DeepgramSageMakerTTSService",
      "DeepgramFluxSageMakerSTTService",
      "DeepgramFluxSageMakerTTSService",
    ],
    modules: ["services/deepgram/sagemaker/", "services/deepgram/flux/sagemaker/"],
  },
  {
    name: "ElevenLabs Dialogue",
    classes: ["ElevenLabsDialogueTTSService"],
    modules: ["services/elevenlabs/dialogue/tts.py"],
  },
  {
    name: "Local Whisper",
    classes: ["WhisperSTTService"],
    modules: ["services/whisper/stt.py"],
  },
  {
    name: "NVIDIA on SageMaker",
    classes: ["NvidiaSageMakerSTTService", "NvidiaSageMakerTTSService"],
    modules: ["services/nvidia/sagemaker/"],
  },
  {
    name: "AWS AgentCore",
    classes: ["AWSAgentCoreProcessor"],
    modules: ["services/aws/agent_core.py"],
  },
];
