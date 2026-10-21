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

export interface CompatibleLlmLink {
  title: string;
  href: string;
  text: string;
}

/**
 * An LLM service that subclasses OpenAILLMService for an OpenAI-compatible provider. Their pages
 * are nearly identical, so scripts/generate-providers.ts writes them from this data; the usage
 * samples are hand-written in snippets/services/llm-<slug>.ts.
 */
export interface CompatibleLlmPage {
  /** File name under content/docs/services/llm/, and Pipecat's page slug. */
  slug: string;
  /** Display name. */
  name: string;
  /** The pipedog package. */
  pkg: string;
  /** The service class, in `<pkg>/llm`. */
  cls: string;
  /** Its settings class, in `<pkg>/llm`. */
  settings: string;
  /** What the provider is, in one sentence (ends with a period). */
  about: string;
  /** The default `baseUrl`. */
  baseUrl: string;
  /** The default model. */
  model: string;
  /** Other models to try, besides the default. */
  models: string[];
  /** The environment variable the samples read the API key from; null when no key is needed. */
  env: string | null;
  /** How to get an account and key, one sentence of Markdown. */
  account: string;
  /** Provider docs, for the Cards. */
  links: CompatibleLlmLink[];
  /** Whether "developer" messages are sent as is (else they are sent as "user" messages). */
  developerRole: boolean;
  /** Settings rows beyond the OpenAI ones (Markdown table rows). */
  settingsRows?: string[];
  /** The adapter class the service uses, in `<pkg>/<adapter.module>`, when not OpenAI's. */
  adapter?: { cls: string; module: string; about: string };
  /** Extra usage regions of the snippet, with the sentence that introduces each. */
  usage?: { region: string; intro: string }[];
  /** Provider-specific notes (Markdown bullets, without the leading dash). */
  notes: string[];
}

export const compatibleLlm: CompatibleLlmPage[] = [
  {
    slug: "baseten",
    name: "Baseten",
    pkg: "@pipedog/baseten",
    cls: "BasetenLLMService",
    settings: "BasetenLLMSettings",
    about:
      "Baseten's Model APIs serve open-weights models (GLM, Kimi, DeepSeek, Nemotron, gpt-oss) over an OpenAI-compatible API, and dedicated deployments run your own model on your own GPUs.",
    baseUrl: "https://inference.baseten.co/v1",
    model: "zai-org/GLM-5.3",
    models: [],
    env: "BASETEN_API_KEY",
    account:
      "A Baseten account and an API key from the [Baseten console](https://app.baseten.co/).",
    links: [
      {
        title: "Baseten docs",
        href: "https://docs.baseten.co/",
        text: "Model APIs and deployments.",
      },
    ],
    developerRole: false,
    usage: [
      {
        region: "dedicated",
        intro:
          "A dedicated deployment: point `baseUrl` at its `/sync/v1` URL and set `model` to the model it serves.",
      },
    ],
    notes: [
      'Baseten\'s message roles are system, user, assistant and tool, so "developer" messages are sent as "user" messages.',
    ],
  },
  {
    slug: "cerebras",
    name: "Cerebras",
    pkg: "@pipedog/cerebras",
    cls: "CerebrasLLMService",
    settings: "CerebrasLLMSettings",
    about: "Cerebras serves open models with fast inference on its own hardware.",
    baseUrl: "https://api.cerebras.ai/v1",
    model: "gpt-oss-120b",
    models: [],
    env: "CEREBRAS_API_KEY",
    account:
      "A Cerebras account and an API key from the [Cerebras platform](https://cloud.cerebras.ai/).",
    links: [
      {
        title: "Cerebras docs",
        href: "https://inference-docs.cerebras.ai/api-reference/chat-completions",
        text: "The chat completions API reference.",
      },
    ],
    developerRole: true,
    usage: [
      {
        region: "extra",
        intro: "Cerebras-only request fields, such as `reasoning_effort`, go in `extra`:",
      },
    ],
    notes: [
      "Cerebras honors `max_tokens`, `max_completion_tokens` and the penalties, so they are sent when set.",
    ],
  },
  {
    slug: "crusoe",
    name: "Crusoe",
    pkg: "@pipedog/crusoe",
    cls: "CrusoeLLMService",
    settings: "CrusoeLLMSettings",
    about: "Crusoe Cloud's Managed Inference serves open models through an OpenAI-compatible API.",
    baseUrl: "https://api.inference.crusoecloud.com/v1/",
    model: "openai/gpt-oss-120b",
    models: [],
    env: "CRUSOE_API_KEY",
    account: "A Crusoe Cloud account and an API key from [Crusoe](https://crusoe.ai/).",
    links: [{ title: "Crusoe", href: "https://crusoe.ai/", text: "Crusoe Cloud and its docs." }],
    developerRole: false,
    notes: [],
  },
  {
    slug: "deepseek",
    name: "DeepSeek",
    pkg: "@pipedog/deepseek",
    cls: "DeepSeekLLMService",
    settings: "DeepSeekLLMSettings",
    about: "DeepSeek's chat models, with control over their thinking mode.",
    baseUrl: "https://api.deepseek.com/v1",
    model: "deepseek-flash",
    models: [],
    env: "DEEPSEEK_API_KEY",
    account:
      "A DeepSeek account and an API key from the [DeepSeek platform](https://platform.deepseek.com/).",
    links: [
      {
        title: "DeepSeek docs",
        href: "https://api-docs.deepseek.com/api/create-chat-completion",
        text: "The chat completion API reference.",
      },
    ],
    developerRole: false,
    settingsRows: [
      '| `thinking` | `DeepSeekThinkingConfig \\| null` | `{ type: "disabled" }` | Thinking mode, sent as `thinking` in the request body. `null` leaves it to DeepSeek\'s default. A plain `{ type }` object is converted. |',
    ],
    adapter: {
      cls: "DeepSeekLLMAdapter",
      module: "deepseek_adapter",
      about:
        "adds an empty `reasoning_content` to assistant messages that have none, which DeepSeek requires in thinking mode once a tool call is involved",
    },
    usage: [
      {
        region: "thinking",
        intro:
          "Thinking is off by default, because DeepSeek's V4 models otherwise reason before every answer, which delays the first spoken token. Turn it on with `DeepSeekLLMService.ThinkingConfig`:",
      },
    ],
    notes: [
      "`seed`, `max_completion_tokens` and `service_tier` are not sent: DeepSeek doesn't support them.",
      "DeepSeek can't enforce a response schema (`supportsResponseSchema` is `false`), so `runInference` ignores `responseSchema`, with a warning.",
    ],
  },
  {
    slug: "fireworks",
    name: "Fireworks AI",
    pkg: "@pipedog/fireworks",
    cls: "FireworksLLMService",
    settings: "FireworksLLMSettings",
    about: "Fireworks AI serves open and proprietary models through an OpenAI-compatible API.",
    baseUrl: "https://api.fireworks.ai/inference/v1",
    model: "accounts/fireworks/models/nemotron-3-ultra-nvfp4",
    models: [],
    env: "FIREWORKS_API_KEY",
    account: "A Fireworks AI account and an API key from [Fireworks](https://fireworks.ai/).",
    links: [
      {
        title: "Fireworks docs",
        href: "https://docs.fireworks.ai/api-reference/post-chatcompletions",
        text: "The chat completions API reference.",
      },
    ],
    developerRole: true,
    notes: [
      "Model names use the `accounts/fireworks/models/` prefix.",
      "`seed`, `max_completion_tokens`, `stream_options` and `service_tier` are not sent. Without `stream_options`, token usage is reported only when Fireworks includes it anyway.",
    ],
  },
  {
    slug: "nebius",
    name: "Nebius",
    pkg: "@pipedog/nebius",
    cls: "NebiusLLMService",
    settings: "NebiusLLMSettings",
    about: "Nebius Token Factory serves open models through an OpenAI-compatible API.",
    baseUrl: "https://api.tokenfactory.nebius.com/v1/",
    model: "Qwen/Qwen3-30B-A3B-Instruct-2507",
    models: [],
    env: "NEBIUS_API_KEY",
    account:
      "A Nebius account and an API key from [Nebius Token Factory](https://tokenfactory.nebius.com/).",
    links: [
      {
        title: "Nebius Token Factory",
        href: "https://tokenfactory.nebius.com/",
        text: "Models and API keys.",
      },
    ],
    developerRole: false,
    notes: [],
  },
  {
    slug: "novita",
    name: "Novita AI",
    pkg: "@pipedog/novita",
    cls: "NovitaLLMService",
    settings: "NovitaLLMSettings",
    about: "Novita AI serves open models through an OpenAI-compatible API.",
    baseUrl: "https://api.novita.ai/openai",
    model: "moonshotai/kimi-k2.5",
    models: ["openai/gpt-oss-120b"],
    env: "NOVITA_API_KEY",
    account: "A Novita AI account and an API key from [Novita AI](https://novita.ai).",
    links: [
      { title: "Novita AI docs", href: "https://novita.ai/docs", text: "Models and the API." },
    ],
    developerRole: true,
    notes: [],
  },
  {
    slug: "ollama",
    name: "Ollama",
    pkg: "@pipedog/ollama",
    cls: "OLLamaLLMService",
    settings: "OllamaLLMSettings",
    about: "Ollama runs open models on your own machine, behind an OpenAI-compatible API.",
    baseUrl: "http://localhost:11434/v1",
    model: "llama2",
    models: ["mistral"],
    env: null,
    account:
      '[Ollama](https://ollama.com/download) running locally, with a model pulled (`ollama pull llama2`). No API key is needed; `apiKey` defaults to `"ollama"`, which a local Ollama ignores.',
    links: [
      {
        title: "Ollama library",
        href: "https://ollama.com/library",
        text: "The models you can pull.",
      },
    ],
    developerRole: false,
    usage: [
      {
        region: "proxy",
        intro: "An Ollama server on another host, behind a proxy that checks a key:",
      },
    ],
    notes: [
      "`OLLamaLLMService` doesn't require an API key, unlike the other OpenAI-compatible services, and never falls back to `OPENAI_API_KEY`.",
      'Ollama seems to ignore "developer" messages, so they are sent as "user" messages.',
    ],
  },
  {
    slug: "openrouter",
    name: "OpenRouter",
    pkg: "@pipedog/openrouter",
    cls: "OpenRouterLLMService",
    settings: "OpenRouterLLMSettings",
    about:
      "OpenRouter puts one OpenAI-compatible API in front of many model providers, and routes each request to one of them.",
    baseUrl: "https://openrouter.ai/api/v1",
    model: "openai/gpt-4.1",
    models: ["anthropic/claude-sonnet-4"],
    env: "OPENROUTER_API_KEY",
    account:
      "An OpenRouter account, with credits, and an API key from [OpenRouter](https://openrouter.ai/).",
    links: [
      {
        title: "OpenRouter docs",
        href: "https://openrouter.ai/docs/api-reference/chat-completion",
        text: "The chat completion API reference.",
      },
      {
        title: "Provider routing",
        href: "https://openrouter.ai/docs/guides/routing/provider-selection",
        text: "The provider preferences and their semantics.",
      },
    ],
    developerRole: false,
    settingsRows: [
      "| `provider` | `OpenRouterProviderPreferences \\| null` | `null` | Which upstream providers may serve the request, sent as `provider` in the request body. A plain object is converted. |",
    ],
    usage: [
      {
        region: "provider",
        intro:
          "Constrain which providers serve the request with `OpenRouterLLMService.ProviderPreferences`. Its options are camelCase (`allowFallbacks`, `preferredMaxLatency`, ...); options it doesn't know are sent as given:",
      },
    ],
    notes: [
      "For Gemini models, every system message after the first is sent as a user message.",
      "A `provider` in `extra.extra_body` wins over the `provider` setting.",
    ],
  },
  {
    slug: "perplexity",
    name: "Perplexity",
    pkg: "@pipedog/perplexity",
    cls: "PerplexityLLMService",
    settings: "PerplexityLLMSettings",
    about: "Perplexity's Sonar models answer with web search built in.",
    baseUrl: "https://api.perplexity.ai",
    model: "sonar",
    models: ["sonar-pro"],
    env: "PERPLEXITY_API_KEY",
    account: "A Perplexity account and an API key from [Perplexity](https://www.perplexity.ai/).",
    links: [
      {
        title: "Perplexity docs",
        href: "https://docs.perplexity.ai/api-reference/chat-completions-post",
        text: "The chat completions API reference.",
      },
    ],
    developerRole: false,
    adapter: {
      cls: "PerplexityLLMAdapter",
      module: "perplexity_adapter",
      about:
        "rewrites the history to Perplexity's rules: only initial system messages, strict user/assistant alternation (merging neighbors with the same role), and no trailing assistant message",
    },
    notes: [
      "Only `model`, `messages` and the sampling settings that are set (`temperature`, `topP`, `maxTokens`, the penalties) are sent: Perplexity doesn't take tools, so function calling isn't available.",
    ],
  },
  {
    slug: "qwen",
    name: "Qwen",
    pkg: "@pipedog/qwen",
    cls: "QwenLLMService",
    settings: "QwenLLMSettings",
    about: "Alibaba Cloud's Qwen models, through DashScope's OpenAI-compatible mode.",
    baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    model: "qwen-plus",
    models: ["qwen-max", "qwen-turbo"],
    env: "QWEN_API_KEY",
    account:
      "An Alibaba Cloud account and a DashScope API key from [Alibaba Cloud Model Studio](https://www.alibabacloud.com/).",
    links: [
      {
        title: "Qwen docs",
        href: "https://www.alibabacloud.com/help/en/model-studio/use-qwen-by-calling-api",
        text: "Calling Qwen through the API.",
      },
    ],
    developerRole: false,
    notes: [
      "The default `baseUrl` is DashScope's international endpoint. Pass your region's endpoint as `baseUrl` if your key belongs to another one.",
    ],
  },
  {
    slug: "sambanova",
    name: "SambaNova",
    pkg: "@pipedog/sambanova",
    cls: "SambaNovaLLMService",
    settings: "SambaNovaLLMSettings",
    about: "SambaNova Cloud serves open models with fast inference on its own hardware.",
    baseUrl: "https://api.sambanova.ai/v1",
    model: "Meta-Llama-3.3-70B-Instruct",
    models: [],
    env: "SAMBANOVA_API_KEY",
    account:
      "A SambaNova Cloud account and an API key from [SambaNova](https://docs.sambanova.ai/).",
    links: [
      { title: "SambaNova docs", href: "https://docs.sambanova.ai/", text: "Models and the API." },
    ],
    developerRole: false,
    notes: [
      "`service_tier` is not sent: SambaNova doesn't support it.",
      "SambaNova's tool calls may come without an index. The service skips tool calls whose arguments are empty, and runs function calls only when the last one has arguments.",
    ],
  },
];

/** Ported pages (hand-written, except the OpenAI-compatible LLMs above), in sidebar order. */
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
      slug: "aws",
      name: "AWS Bedrock",
      pkg: "@pipedog/aws",
      classes: ["AWSBedrockLLMService"],
    },
    {
      slug: "aws-agentcore",
      name: "AWS AgentCore",
      pkg: "@pipedog/aws",
      classes: ["AWSAgentCoreProcessor"],
    },
    {
      slug: "langchain",
      name: "LangChain",
      pkg: "@pipedog/langchain",
      classes: ["LangchainProcessor"],
    },
    ...compatibleLlm.map((page) => ({
      slug: page.slug,
      name: page.name,
      pkg: page.pkg,
      classes: [page.cls],
    })),
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
      slug: "aws",
      name: "AWS Transcribe",
      pkg: "@pipedog/aws",
      classes: ["AWSTranscribeSTTService"],
    },
    {
      slug: "aws-sagemaker",
      name: "AWS SageMaker (bidi client)",
      pkg: "@pipedog/aws",
      classes: ["SageMakerBidiClient"],
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
    {
      slug: "inworld",
      name: "Inworld",
      pkg: "@pipedog/inworld",
      classes: ["InworldTTSService", "InworldHttpTTSService"],
    },
    { slug: "aws", name: "AWS Polly", pkg: "@pipedog/aws", classes: ["AWSPollyTTSService"] },
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
    {
      slug: "inworld",
      name: "Inworld Realtime",
      pkg: "@pipedog/inworld",
      classes: ["InworldRealtimeLLMService"],
    },
    {
      slug: "ultravox",
      name: "Ultravox",
      pkg: "@pipedog/ultravox",
      classes: ["UltravoxRealtimeLLMService"],
    },
    {
      slug: "aws",
      name: "AWS Nova Sonic",
      pkg: "@pipedog/aws",
      classes: ["AWSNovaSonicLLMService"],
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
  { name: "Bland", folder: "bland", kinds: ["TTS"], classes: ["BlandTTSService"] },
  { name: "Camb.ai", folder: "camb", kinds: ["TTS"], classes: ["CambTTSService"] },
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
  { name: "Neuphonic", folder: "neuphonic", kinds: ["TTS"], classes: ["NeuphonicTTSService"] },
  {
    name: "OpenClaw",
    folder: "openclaw",
    kinds: ["Agents"],
    classes: ["OpenClawGatewayService"],
  },
  { name: "Piper", folder: "piper", kinds: ["TTS"], classes: ["PiperTTSService"] },
  { name: "Pocket TTS", folder: "pocket_tts", kinds: ["TTS"], classes: ["PocketTTSService"] },
  {
    name: "Resemble AI",
    folder: "resembleai",
    kinds: ["TTS"],
    classes: ["ResembleAITTSService"],
  },
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
];
