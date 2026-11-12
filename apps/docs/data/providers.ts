// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// The provider catalog behind the Services, Transports, Serializers and Audio sections. The ported pages
// are written by hand; scripts/generate-providers.ts writes the "coming soon" pages, the folder
// meta.json files and the overview tables from this file. Run `bun run providers:generate` in
// apps/docs after changing it.

export type Category = "llm" | "stt" | "tts" | "s2s" | "image" | "video";
export type Section = Category | "transports" | "serializers" | "audio";

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
  audio: {
    title: "Audio filters & mixers",
    description:
      "Clean up the user's audio before it reaches VAD and speech-to-text, and mix background sound into the bot's audio.",
    upstreamFolder: "audio-filters",
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
  /** The status column, when not "Ported" (e.g. a package with no upstream counterpart). */
  status?: string;
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
  /** Show the package's runtime matrix on the page. */
  runtimeMatrix?: boolean;
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
    runtimeMatrix: true,
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
    runtimeMatrix: true,
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
    runtimeMatrix: true,
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
    runtimeMatrix: true,
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
    runtimeMatrix: true,
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
    runtimeMatrix: true,
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
    runtimeMatrix: true,
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
    runtimeMatrix: true,
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
    runtimeMatrix: true,
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
    runtimeMatrix: true,
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
    runtimeMatrix: true,
  },
  {
    slug: "groq",
    name: "Groq",
    pkg: "@pipedog/groq",
    cls: "GroqLLMService",
    settings: "GroqLLMSettings",
    about: "Groq serves open models with fast inference on its LPUs.",
    baseUrl: "https://api.groq.com/openai/v1",
    model: "openai/gpt-oss-120b",
    models: [],
    env: "GROQ_API_KEY",
    account: "A Groq account and an API key from the [Groq console](https://console.groq.com/).",
    links: [
      {
        title: "Groq docs",
        href: "https://console.groq.com/docs/api-reference#chat-create",
        text: "The chat completions API reference.",
      },
    ],
    developerRole: true,
    settingsRows: [
      '| `reasoningEffort` | `"none" \\| "default" \\| "low" \\| "medium" \\| "high" \\| null` | `null` | Sent as `reasoning_effort` when set. Which values a model accepts varies; the non-reasoning models reject it. |',
    ],
    usage: [
      {
        region: "reasoning",
        intro:
          'Keep a Qwen model\'s reasoning out of the spoken reply with `reasoningEffort: "none"`:',
      },
    ],
    notes: [
      "The same package has Groq's [speech-to-text](/docs/services/stt/groq) and [text-to-speech](/docs/services/tts/groq) services.",
    ],
    runtimeMatrix: true,
  },
  {
    slug: "mistral",
    name: "Mistral",
    pkg: "@pipedog/mistral",
    cls: "MistralLLMService",
    settings: "MistralLLMSettings",
    about: "Mistral AI's chat models.",
    baseUrl: "https://api.mistral.ai/v1",
    model: "mistral-small-latest",
    models: ["mistral-large-latest"],
    env: "MISTRAL_API_KEY",
    account: "A Mistral account and an API key from [Mistral](https://docs.mistral.ai/api/).",
    links: [
      { title: "Mistral docs", href: "https://docs.mistral.ai/api/", text: "The API reference." },
    ],
    developerRole: false,
    adapter: {
      cls: "MistralLLMAdapter",
      module: "mistral_adapter",
      about:
        "rewrites the history to Mistral's rules: an assistant message after every tool message, system messages only at the start, and `prefix: true` on a trailing assistant message",
    },
    notes: [
      "`seed` is sent as Mistral's `random_seed`. `stream_options`, `max_completion_tokens` and `service_tier` are not sent.",
      "Mistral detects function calls from the whole history, so calls that already have a tool result in the context are skipped instead of run twice. `on_function_calls_started` may still fire twice.",
      "The same package has Mistral's [speech-to-text](/docs/services/stt/mistral) and [text-to-speech](/docs/services/tts/mistral) services.",
    ],
    runtimeMatrix: true,
  },
  {
    slug: "together",
    name: "Together AI",
    pkg: "@pipedog/together",
    cls: "TogetherLLMService",
    settings: "TogetherLLMSettings",
    about: "Together AI serves open models through an OpenAI-compatible API.",
    baseUrl: "https://api.together.xyz/v1",
    model: "zai-org/GLM-5.2",
    models: [],
    env: "TOGETHER_API_KEY",
    account: "A Together AI account and an API key from [Together AI](https://together.ai/).",
    links: [
      {
        title: "Together AI docs",
        href: "https://docs.together.ai/reference/chat-completions-1",
        text: "The chat completions API reference.",
      },
    ],
    developerRole: false,
    settingsRows: [
      "| `reasoning` | `Record<string, unknown> \\| null` | `null` | Together's reasoning toggle, e.g. `{ enabled: false }`, sent as `reasoning` in the request body. `null` leaves it to the model. |",
      '| `reasoningEffort` | `"low" \\| "medium" \\| "high" \\| "max" \\| string \\| null` | `null` | How much the model reasons, sent as `reasoning_effort` when set, unless `extra` already has one. Values vary by model (`"max"` on `zai-org/GLM-5.3`). It reaches models that ignore `reasoning`, such as GLM-5.3. `null` leaves Together\'s per-model default. |',
    ],
    usage: [
      {
        region: "reasoning",
        intro:
          "Turn off a reasoning model's thinking pass, which otherwise delays the first spoken token:",
      },
      {
        region: "effort",
        intro:
          "Models that ignore the toggle, such as `zai-org/GLM-5.3`, still take a reasoning effort:",
      },
    ],
    notes: [
      "The same package has Together's [speech-to-text](/docs/services/stt/together) and [text-to-speech](/docs/services/tts/together) services.",
    ],
    runtimeMatrix: true,
  },
  {
    slug: "grok",
    name: "xAI Grok",
    pkg: "@pipedog/xai",
    cls: "GrokLLMService",
    settings: "GrokLLMSettings",
    about: "xAI's Grok models.",
    baseUrl: "https://api.x.ai/v1",
    model: "grok-4.20-non-reasoning",
    models: ["grok-4.6"],
    env: "XAI_API_KEY",
    account: "An xAI account and an API key from the [xAI console](https://console.x.ai/).",
    links: [
      {
        title: "xAI docs",
        href: "https://docs.x.ai/docs/api-reference#chat-completions",
        text: "The chat completions API reference.",
      },
    ],
    developerRole: true,
    settingsRows: [
      '| `reasoningEffort` | `"none" \\| "low" \\| "medium" \\| "high" \\| "xhigh" \\| null` | `null` | Sent as `reasoning_effort` when set, unless `extra` already has one. The non-reasoning models, including the default, reject it. |',
    ],
    usage: [
      {
        region: "reasoning",
        intro: "A reasoning model, with its reasoning effort:",
      },
    ],
    notes: [
      "xAI reports reasoning tokens apart from `completion_tokens`, so they are added to the completion count in token usage metrics when the total says so.",
      "`@pipedog/grok` re-exports `GrokLLMService` from `@pipedog/xai/llm`, as upstream's deprecated `pipecat.services.grok.llm` does. Import from `@pipedog/xai/llm`.",
      "The same package has xAI's [speech-to-text](/docs/services/stt/xai) and [text-to-speech](/docs/services/tts/xai) services, and [Grok Voice Agent](/docs/services/s2s/grok), the realtime (speech-to-speech) service.",
    ],
    runtimeMatrix: true,
  },
  {
    slug: "inception",
    name: "Inception",
    pkg: "@pipedog/inception",
    cls: "InceptionLLMService",
    settings: "InceptionLLMSettings",
    about:
      "Inception serves Mercury-3, a diffusion-based reasoning language model, over an OpenAI-compatible API.",
    baseUrl: "https://api.inceptionlabs.ai/v1",
    model: "mercury-3",
    models: [],
    env: "INCEPTION_API_KEY",
    account:
      "An Inception account and an API key from [Inception](https://docs.inceptionlabs.ai/).",
    links: [
      {
        title: "Inception docs",
        href: "https://docs.inceptionlabs.ai/",
        text: "Models and the API reference.",
      },
    ],
    developerRole: false,
    settingsRows: [
      '| `reasoningEffort` | `"instant" \\| "low" \\| "medium" \\| "high" \\| null` | `null` | Sent as `reasoning_effort` when set. When unset, Inception\'s server-side default applies. |',
      "| `realtime` | `boolean \\| null` | `true` | Sent as `realtime` in the request body, to cut the time to the first diffusion block. |",
    ],
    usage: [
      {
        region: "reasoning",
        intro: "Trade reasoning for speed with `reasoningEffort`:",
      },
    ],
    notes: [
      "`realtime` and `reasoningEffort` go out in the request's `extra_body`. A field you put in `settings.extra` under `extra_body` wins over the service's own.",
      'The default model was `mercury-2` before. Inception retires Mercury 2 and 2.5 on November 15, 2026, and they are closed to new signups. Until then, `settings: new InceptionLLMService.Settings({ model: "mercury-2" })` keeps it.',
    ],
    runtimeMatrix: true,
  },
  {
    slug: "sarvam",
    name: "Sarvam AI",
    pkg: "@pipedog/sarvam",
    cls: "SarvamLLMService",
    settings: "SarvamLLMSettings",
    about:
      "Sarvam AI's models for Indian languages, over an OpenAI-compatible API (`sarvam-105b`, plus a few hosted open models).",
    baseUrl: "https://api.sarvam.ai/v2",
    model: "sarvam-105b",
    models: ["sarvam-105b-conversations", "gemma4", "glm5.3", "deepseekv4.1-flash"],
    env: "SARVAM_API_KEY",
    account:
      "A Sarvam account and an API key from the [Sarvam dashboard](https://dashboard.sarvam.ai/).",
    links: [
      {
        title: "Sarvam docs",
        href: "https://docs.sarvam.ai/",
        text: "Models and the API reference.",
      },
    ],
    developerRole: false,
    settingsRows: [
      "| `wikiGrounding` | `boolean \\| null` | `null` | Sent as `wiki_grounding` when set. Only `sarvam-105b` and `gemma4` support it. |",
      '| `reasoningEffort` | `"low" \\| "medium" \\| "high" \\| null` | `null` | Sent as `reasoning_effort` when set, on the models that reason. |',
    ],
    usage: [
      {
        region: "grounding",
        intro: "Ground answers in Wikipedia and set the reasoning effort:",
      },
    ],
    notes: [
      "Only `deepseekv4.1-flash`, `gemma4`, `glm5.3`, `sarvam-105b` and `sarvam-105b-conversations` are accepted as the model. Any other raises when the service is constructed.",
      "When you don't pass `baseUrl`, it is chosen from the model: `/v1` for `sarvam-105b-conversations` and `/v2` for the rest.",
      "A context that a model can't serve (an image for a model without vision, say) fails with a non-fatal `ErrorFrame`, not an exception, so an `LLMSwitcher` can fall back to another service.",
      "The same package has Sarvam's [speech-to-text](/docs/services/stt/sarvam) and [text-to-speech](/docs/services/tts/sarvam) services.",
    ],
    runtimeMatrix: true,
  },
  {
    slug: "smallest",
    name: "Smallest AI",
    pkg: "@pipedog/smallest",
    cls: "SmallestLLMService",
    settings: "SmallestLLMSettings",
    about:
      "Smallest AI serves Electron, its own LLM, through the Waves API's OpenAI-compatible chat completions endpoint.",
    baseUrl: "https://api.smallest.ai/waves/v1",
    model: "electron",
    models: [],
    env: "SMALLEST_API_KEY",
    account: "A Smallest AI account and an API key from [Smallest AI](https://smallest.ai/).",
    links: [
      {
        title: "Smallest AI docs",
        href: "https://docs.smallest.ai/",
        text: "Models and the Waves API.",
      },
    ],
    developerRole: false,
    notes: [
      "Every request carries `X-Source: pipecat` and `X-Pipecat-Version` headers (the version is pipedog's), merged over any `defaultHeaders` you pass.",
      "The same package has Smallest AI's [speech-to-text](/docs/services/stt/smallest) and [text-to-speech](/docs/services/tts/smallest) services.",
    ],
    runtimeMatrix: true,
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
      slug: "azure",
      name: "Azure OpenAI",
      pkg: "@pipedog/azure",
      classes: ["AzureLLMService"],
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
    {
      slug: "ai-sdk",
      name: "Vercel AI SDK",
      pkg: "@pipedog/ai-sdk",
      classes: ["AISDKLLMService"],
    },
    {
      slug: "cloudflare",
      name: "Cloudflare Workers AI",
      pkg: "@pipedog/cloudflare",
      classes: ["WorkersAILLMService"],
    },
    {
      slug: "perplexity",
      name: "Perplexity",
      pkg: "@pipedog/perplexity",
      classes: ["PerplexityAgentHttpLLMService"],
    },
    {
      slug: "nvidia",
      name: "NVIDIA",
      pkg: "@pipedog/nvidia",
      classes: ["NvidiaLLMService", "NvidiaOmniLLMService"],
    },
    ...[...compatibleLlm]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((page) => ({
        slug: page.slug,
        name: page.name,
        pkg: page.pkg,
        classes: [page.cls],
      })),
  ],
  stt: [
    {
      slug: "assemblyai",
      name: "AssemblyAI",
      pkg: "@pipedog/assemblyai",
      classes: ["AssemblyAISTTService", "AssemblyAISyncSTTService"],
    },
    {
      slug: "gladia",
      name: "Gladia",
      pkg: "@pipedog/gladia",
      classes: ["GladiaSTTService"],
    },
    {
      slug: "speechmatics",
      name: "Speechmatics",
      pkg: "@pipedog/speechmatics",
      classes: ["SpeechmaticsSTTService"],
    },
    {
      slug: "soniox",
      name: "Soniox",
      pkg: "@pipedog/soniox",
      classes: ["SonioxSTTService"],
    },
    {
      slug: "deepgram",
      name: "Deepgram",
      pkg: "@pipedog/deepgram",
      classes: ["DeepgramSTTService", "DeepgramFluxSTTService"],
    },
    {
      slug: "cloudflare",
      name: "Cloudflare Workers AI",
      pkg: "@pipedog/cloudflare",
      classes: [
        "WorkersAIFluxSTTService",
        "WorkersAINova3STTService",
        "WorkersAIWhisperSTTService",
      ],
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
      slug: "azure",
      name: "Azure Speech",
      pkg: "@pipedog/azure",
      classes: ["AzureSTTService"],
    },
    {
      slug: "whisper",
      name: "Whisper",
      pkg: "@pipedog/whisper",
      classes: ["WhisperSTTService", "WhisperSTTServiceMLX", "BaseWhisperSTTService"],
    },
    {
      slug: "moonshine",
      name: "Moonshine (local)",
      pkg: "@pipedog/moonshine",
      classes: ["MoonshineSTTService"],
    },
    {
      slug: "funasr",
      name: "FunASR SenseVoice (local)",
      pkg: "@pipedog/funasr",
      classes: ["FunASRSTTService"],
    },
    { slug: "groq", name: "Groq", pkg: "@pipedog/groq", classes: ["GroqSTTService"] },
    { slug: "mistral", name: "Mistral", pkg: "@pipedog/mistral", classes: ["MistralSTTService"] },
    {
      slug: "together",
      name: "Together AI",
      pkg: "@pipedog/together",
      classes: ["TogetherSTTService"],
    },
    { slug: "xai", name: "xAI", pkg: "@pipedog/xai", classes: ["XAISTTService"] },
    {
      slug: "sarvam",
      name: "Sarvam AI",
      pkg: "@pipedog/sarvam",
      classes: ["SarvamSTTService", "SarvamRealtimeSTTService"],
    },
    {
      slug: "smallest",
      name: "Smallest AI",
      pkg: "@pipedog/smallest",
      classes: ["SmallestSTTService"],
    },
    {
      slug: "gradium",
      name: "Gradium",
      pkg: "@pipedog/gradium",
      classes: ["GradiumSTTService"],
    },
    { slug: "meta", name: "Meta", pkg: "@pipedog/meta", classes: ["MetaSTTService"] },
    {
      slug: "zoom-ai",
      name: "Zoom AI",
      pkg: "@pipedog/zoom-ai",
      classes: ["ZoomAISTTService"],
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
      slug: "cloudflare",
      name: "Cloudflare Workers AI",
      pkg: "@pipedog/cloudflare",
      classes: [
        "WorkersAIAuraTTSService",
        "WorkersAIAuraHttpTTSService",
        "WorkersAIMeloTTSService",
      ],
    },
    {
      slug: "speechmatics",
      name: "Speechmatics",
      pkg: "@pipedog/speechmatics",
      classes: ["SpeechmaticsTTSService"],
    },
    {
      slug: "soniox",
      name: "Soniox",
      pkg: "@pipedog/soniox",
      classes: ["SonioxTTSService"],
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
      classes: ["ElevenLabsTTSService", "ElevenLabsHttpTTSService", "ElevenLabsDialogueTTSService"],
    },
    { slug: "groq", name: "Groq", pkg: "@pipedog/groq", classes: ["GroqTTSService"] },
    { slug: "mistral", name: "Mistral", pkg: "@pipedog/mistral", classes: ["MistralTTSService"] },
    {
      slug: "together",
      name: "Together AI",
      pkg: "@pipedog/together",
      classes: ["TogetherTTSService"],
    },
    {
      slug: "xai",
      name: "xAI",
      pkg: "@pipedog/xai",
      classes: ["XAITTSService", "XAIHttpTTSService"],
    },
    {
      slug: "sarvam",
      name: "Sarvam AI",
      pkg: "@pipedog/sarvam",
      classes: ["SarvamTTSService", "SarvamHttpTTSService"],
    },
    {
      slug: "smallest",
      name: "Smallest AI",
      pkg: "@pipedog/smallest",
      classes: ["SmallestTTSService"],
    },
    {
      slug: "gradium",
      name: "Gradium",
      pkg: "@pipedog/gradium",
      classes: ["GradiumTTSService"],
    },
    {
      slug: "inworld",
      name: "Inworld",
      pkg: "@pipedog/inworld",
      classes: ["InworldTTSService", "InworldHttpTTSService"],
    },
    { slug: "aws", name: "AWS Polly", pkg: "@pipedog/aws", classes: ["AWSPollyTTSService"] },
    {
      slug: "azure",
      name: "Azure Speech",
      pkg: "@pipedog/azure",
      classes: ["AzureTTSService", "AzureHttpTTSService"],
    },
    {
      slug: "kokoro",
      name: "Kokoro (local)",
      pkg: "@pipedog/kokoro",
      classes: ["KokoroTTSService"],
    },
    {
      slug: "piper",
      name: "Piper",
      pkg: "@pipedog/piper",
      classes: ["PiperTTSService", "PiperHttpTTSService"],
    },
    {
      slug: "pocket-tts",
      name: "Pocket TTS (local)",
      pkg: "@pipedog/pocket-tts",
      classes: ["PocketTTSService"],
    },
    {
      slug: "rime",
      name: "Rime",
      pkg: "@pipedog/rime",
      classes: ["RimeTTSService", "RimeHttpTTSService", "RimeV1TTSService"],
    },
    { slug: "fish", name: "Fish Audio", pkg: "@pipedog/fish", classes: ["FishAudioTTSService"] },
    { slug: "hume", name: "Hume", pkg: "@pipedog/hume", classes: ["HumeTTSService"] },
    {
      slug: "neuphonic",
      name: "Neuphonic",
      pkg: "@pipedog/neuphonic",
      classes: ["NeuphonicTTSService", "NeuphonicHttpTTSService"],
    },
    {
      slug: "speechify",
      name: "Speechify",
      pkg: "@pipedog/speechify",
      classes: ["SpeechifyHttpTTSService"],
    },
    {
      slug: "minimax",
      name: "MiniMax",
      pkg: "@pipedog/minimax",
      classes: ["MiniMaxHttpTTSService"],
    },
    {
      slug: "resembleai",
      name: "Resemble AI",
      pkg: "@pipedog/resembleai",
      classes: ["ResembleAITTSService"],
    },
    { slug: "camb", name: "Camb.ai", pkg: "@pipedog/camb", classes: ["CambTTSService"] },
    {
      slug: "asyncai",
      name: "Async",
      pkg: "@pipedog/asyncai",
      classes: ["AsyncAITTSService", "AsyncAIHttpTTSService"],
    },
    {
      slug: "bland",
      name: "Bland",
      pkg: "@pipedog/bland",
      classes: ["BlandTTSService", "BlandHttpTTSService"],
    },
    {
      slug: "assemblyai",
      name: "AssemblyAI",
      pkg: "@pipedog/assemblyai",
      classes: ["AssemblyAITTSService"],
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
      slug: "grok",
      name: "xAI Grok Realtime",
      pkg: "@pipedog/xai",
      classes: ["GrokRealtimeLLMService"],
    },
    {
      slug: "aws",
      name: "AWS Nova Sonic",
      pkg: "@pipedog/aws",
      classes: ["AWSNovaSonicLLMService"],
    },
    {
      slug: "azure-voice-live",
      name: "Azure Voice Live",
      pkg: "@pipedog/azure",
      classes: ["AzureVoiceLiveLLMService"],
    },
    {
      slug: "azure-realtime",
      name: "Azure OpenAI Realtime",
      pkg: "@pipedog/azure",
      classes: ["AzureRealtimeLLMService"],
    },
  ],
  image: [
    { slug: "openai", name: "OpenAI", pkg: "@pipedog/openai", classes: ["OpenAIImageGenService"] },
    { slug: "google", name: "Google", pkg: "@pipedog/google", classes: ["GoogleImageGenService"] },
    {
      slug: "azure",
      name: "Azure OpenAI",
      pkg: "@pipedog/azure",
      classes: ["AzureImageGenServiceREST"],
    },
  ],
  video: [
    {
      slug: "heygen",
      name: "HeyGen",
      pkg: "@pipedog/heygen",
      classes: ["HeyGenVideoService", "HeyGenTransport"],
    },
  ],
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
      slug: "cloudflare-realtime",
      name: "Cloudflare Realtime",
      pkg: "@pipedog/transport-cloudflare-realtime",
      classes: ["CloudflareRealtimeTransport", "CloudflareRealtimeCall"],
      status: "pipedog only",
    },
    {
      slug: "smallwebrtc",
      name: "SmallWebRTC",
      pkg: "@pipedog/transport-smallwebrtc",
      classes: ["SmallWebRTCTransport"],
    },
    {
      slug: "livekit",
      name: "LiveKit",
      pkg: "@pipedog/transport-livekit",
      classes: ["LiveKitTransport"],
    },
    {
      slug: "whatsapp",
      name: "WhatsApp",
      pkg: "@pipedog/transport-whatsapp",
      classes: ["WhatsAppClient", "WhatsAppApi"],
    },
    {
      slug: "local-audio",
      name: "Local audio",
      pkg: "@pipedog/transport-local",
      classes: ["LocalAudioTransport"],
    },
  ],
  audio: [
    {
      slug: "rnnoise-filter",
      name: "RNNoise filter",
      pkg: "@pipedog/audio-rnnoise-filter",
      classes: ["RNNoiseFilter"],
    },
    {
      slug: "soundfile-mixer",
      name: "Soundfile mixer",
      pkg: "@pipedog/audio-soundfile-mixer",
      classes: ["SoundfileMixer"],
    },
    {
      slug: "ducking",
      name: "Ducking",
      pkg: "@pipedog/audio-ducking",
      classes: ["AudioDuckingFilter", "AudioDuckingObserver"],
      status: "pipedog only",
    },
    {
      slug: "ten-vad",
      name: "TEN VAD",
      pkg: "@pipedog/audio-ten-vad",
      classes: ["TenVADAnalyzer"],
      status: "pipedog only",
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
    {
      slug: "twilio",
      name: "Twilio",
      pkg: "@pipedog/serializer-twilio",
      classes: ["TwilioFrameSerializer"],
    },
    {
      slug: "plivo",
      name: "Plivo",
      pkg: "@pipedog/serializer-plivo",
      classes: ["PlivoFrameSerializer"],
    },
    {
      slug: "exotel",
      name: "Exotel",
      pkg: "@pipedog/serializer-exotel",
      classes: ["ExotelFrameSerializer"],
    },
    {
      slug: "vonage",
      name: "Vonage",
      pkg: "@pipedog/serializer-vonage",
      classes: ["VonageFrameSerializer"],
    },
    {
      slug: "genesys",
      name: "Genesys",
      pkg: "@pipedog/serializer-genesys",
      classes: ["GenesysAudioHookSerializer"],
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
  /**
   * Why the port can't happen yet. Without it the page is "coming soon". "blocked" means there is
   * no viable JS path today, "deferred" means it is possible but needs vendor SDKs or keys.
   */
  status?: "blocked" | "deferred";
  /** Why it is blocked or deferred. Required with `status`. */
  reason?: string;
  /** What would unblock it. Required with `status`. */
  unblock?: string;
  /** Where the reason comes from. */
  sources?: { title: string; href: string }[];
}

/** Popular upstream providers that aren't ported yet: one short page each. */
export const upcoming: UpcomingPage[] = [
  // LLM
  // STT
  {
    section: "stt",
    slug: "nvidia",
    name: "NVIDIA Riva",
    about: "Speech recognition from NVIDIA Riva.",
    classes: ["NvidiaSTTService", "NvidiaSegmentedSTTService"],
    modules: ["services/nvidia/stt.py"],
  },
  // TTS
  {
    section: "tts",
    slug: "nvidia",
    name: "NVIDIA Riva",
    about: "Speech synthesis from NVIDIA Riva.",
    classes: ["NvidiaTTSService"],
    modules: ["services/nvidia/tts.py"],
  },
  // Speech-to-speech
  // Image
  // Video
  {
    section: "video",
    slug: "tavus",
    name: "Tavus",
    about: "Tavus' realtime video avatars.",
    classes: ["TavusVideoService", "TavusTransport"],
    modules: ["services/tavus/video.py", "transports/tavus/transport.py"],
    status: "blocked",
    reason:
      "Tavus avatars join a Daily room, so they need the Daily transport, which has no server-side JS path (see Daily).",
    unblock:
      "Unblocked when Daily gets a server-side JS transport. The REST client for Tavus is portable on its own.",
    sources: [
      {
        title: "Pipecat's Tavus transport",
        href: "https://docs.pipecat.ai/api-reference/server/services/transport/tavus",
      },
    ],
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
    status: "blocked",
    reason:
      "Upstream uses the native daily-python SDK. Daily publishes no headless or server-side JS SDK, and @daily-co/daily-js is browser-only. Tavus and LemonSlice run on Daily rooms, so they are blocked too.",
    unblock:
      "Unblocked if Daily ships a Node or server SDK, or if someone builds a headless media path. The REST helpers for rooms and tokens are portable now, and a pull request for them would be accepted.",
    sources: [
      { title: "daily-js quickstart", href: "https://docs.daily.co/docs/daily-js/quickstart" },
    ],
  },
  {
    section: "transports",
    slug: "vonage",
    name: "Vonage Video",
    about: "Vonage Video API sessions, through the Video Connector.",
    classes: ["VonageVideoConnectorTransport"],
    modules: ["transports/vonage/video_connector.py"],
    status: "blocked",
    reason:
      "Upstream uses a native, Python-only SDK. Vonage lists Node.js as coming soon. The Vonage voice (Audio Connector) serializer is a different thing and is already ported.",
    unblock: "Unblocked when Vonage ships its Node SDK.",
    sources: [
      {
        title: "Vonage Video AI connectors",
        href: "https://developer.vonage.com/en/video/ai-connectors/overview",
      },
    ],
  },
  {
    section: "transports",
    slug: "lemonslice",
    name: "LemonSlice",
    about: "LemonSlice's realtime video avatars, delivered through Daily rooms.",
    classes: ["LemonSliceTransport", "LemonSliceApi"],
    modules: ["transports/lemonslice/transport.py", "transports/lemonslice/api.py"],
    upstreamUrl: "https://docs.pipecat.ai/server/services/transport/lemonslice",
    status: "blocked",
    reason:
      "LemonSliceTransport is built on the Daily transport (its params extend DailyParams), which has no server-side JS path (see Daily).",
    unblock:
      "Unblocked when Daily gets a server-side JS transport. The REST client (LemonSliceApi) is portable on its own.",
    sources: [
      {
        title: "Pipecat's LemonSlice transport",
        href: "https://docs.pipecat.ai/server/services/transport/lemonslice",
      },
    ],
  },
  {
    section: "transports",
    slug: "moq",
    name: "MoQ",
    about: "Media over QUIC (MoQ) relays.",
    classes: ["MOQTransport", "MOQParams"],
    modules: ["transports/moq/transport.py"],
    upstreamUrl: "https://docs.pipecat.ai/api-reference/server/services/transport/moq",
    status: "deferred",
    reason:
      "The protocol is still changing. The JS library, @moq/net, falls back to WebSocket on servers and only has experimental WebTransport.",
    unblock: "Deferred until the spec and server-side JS support settle.",
    sources: [{ title: "MoQ JS library", href: "https://doc.moq.dev/js/" }],
  },
  // Audio filters, mixers and VAD
  {
    section: "audio",
    slug: "krisp-viva-filter",
    name: "Krisp VIVA",
    about: "Krisp's voice isolation filter, VAD analyzer and turn analyzer.",
    classes: ["KrispVivaFilter", "KrispVivaVadAnalyzer", "KrispVivaTurn"],
    modules: [
      "audio/filters/krisp_viva_filter.py",
      "audio/vad/krisp_viva_vad.py",
      "audio/turn/krisp_viva_turn.py",
    ],
    upstreamUrl:
      "https://docs.pipecat.ai/api-reference/server/services/audio-filters/krisp-viva-filter",
    status: "deferred",
    reason:
      "The Krisp VIVA SDK is proprietary. It isn't on public npm, and it needs a license and the model files from Krisp.",
    unblock:
      "Bring your own SDK: core already has the `KrispAudioSdk` seam (`audio/krisp_instance`), and `setKrispAudioSdk()` takes the SDK you obtained from Krisp. An optional package that wires it up is planned.",
    sources: [
      {
        title: "Krisp VIVA in Pipecat",
        href: "https://docs.pipecat.ai/pipecat/features/krisp-viva",
      },
    ],
  },
  {
    section: "audio",
    slug: "aic-filter",
    name: "ai-coustics",
    about:
      "ai-coustics speech enhancement (AICFilter) and the Quail voice activity detector (AICQuailVADAnalyzer).",
    classes: ["AICFilter", "AICQuailVADAnalyzer"],
    modules: ["audio/filters/aic_filter.py", "audio/vad/aic_quail_vad.py"],
    upstreamUrl: "https://docs.pipecat.ai/api-reference/server/services/audio-filters/aic-filter",
    status: "deferred",
    reason:
      "`@ai-coustics/aic-sdk` is a native addon for darwin and linux, or a browser WebAssembly build, and it needs a license key. Neither fits every pipedog runtime.",
    unblock:
      "Deferred until there is a package we can test without a license key, or someone contributes it as an optional package for Node and Bun.",
    sources: [
      {
        title: "ai-coustics Node.js SDK",
        href: "https://docs.ai-coustics.com/sdk/bindings/nodejs",
      },
    ],
  },
  {
    section: "audio",
    slug: "koala-filter",
    name: "Koala",
    about: "Picovoice Koala noise suppression (KoalaFilter).",
    classes: ["KoalaFilter"],
    modules: ["audio/filters/koala_filter.py"],
    upstreamUrl: "https://docs.pipecat.ai/api-reference/server/services/audio-filters/koala-filter",
    status: "deferred",
    reason:
      "Picovoice has no Node build of Koala. There is only `@picovoice/koala-web`, for the browser, and every build needs an AccessKey.",
    unblock:
      "Deferred until Picovoice ships a Node or server-side WebAssembly build, or someone ports it on top of `@picovoice/koala-web`.",
    sources: [{ title: "Koala for web", href: "https://picovoice.ai/docs/quick-start/koala-web" }],
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
  {
    name: "fal",
    folder: "fal",
    kinds: ["STT", "Image"],
    classes: ["FalSTTService", "FalImageGenService"],
  },
  { name: "Keenable", folder: "keenable", kinds: ["Search"], classes: ["KeenableWebSearch"] },
  { name: "Mem0", folder: "mem0", kinds: ["Memory"], classes: ["Mem0MemoryService"] },
  { name: "Moondream", folder: "moondream", kinds: ["Vision"], classes: ["MoondreamService"] },
  {
    name: "OpenClaw",
    folder: "openclaw",
    kinds: ["Agents"],
    classes: ["OpenClawGatewayService"],
  },
  { name: "XTTS (deprecated upstream)", folder: "xtts", kinds: ["TTS"], classes: ["XTTSService"] },
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
    name: "NVIDIA on SageMaker",
    classes: ["NvidiaSageMakerSTTService", "NvidiaSageMakerTTSService"],
    modules: ["services/nvidia/sagemaker/"],
  },
];
