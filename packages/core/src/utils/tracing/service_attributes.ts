// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/utils/tracing/service_attributes.py

/**
 * Functions for adding attributes to OpenTelemetry spans.
 *
 * This module provides specialized functions for adding service-specific
 * attributes to OpenTelemetry spans, following standard semantic conventions
 * where applicable and Pipecat-specific conventions for additional context.
 *
 * Porting notes:
 * - Upstream's keyword arguments become an options object after the span.
 *   Extra keyword arguments (upstream `**kwargs`) are any other keys of that
 *   object; they are used verbatim as attribute names.
 * - Settings field names are camelCase in TS (`givenFields()`); they are
 *   converted back to snake_case for the `settings.*` attribute names so spans
 *   carry the same attribute names as upstream.
 */

import type { ServiceSettings } from "../../services/settings.ts";
import type { OtelSpan } from "./setup.ts";

type Primitive = string | number | boolean;

/** Python `isinstance(value, (str, int, float, bool))`. */
function isPrimitive(value: unknown): value is Primitive {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

/** Convert a camelCase name back to upstream's snake_case (`voiceId` → `voice_id`). */
export function _camelToSnake(name: string): string {
  return name.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

/** Set every primitive extra keyword argument (keys not in `known`) as an attribute. */
function setExtraAttributes(
  span: OtelSpan,
  options: Record<string, unknown>,
  known: ReadonlySet<string>,
): void {
  for (const [key, value] of Object.entries(options)) {
    if (known.has(key)) continue;
    if (isPrimitive(value)) {
      span.setAttribute(key, value);
    }
  }
}

/** Set the primitive given fields of `settings` as `settings.<key>` attributes. */
function setSettingsAttributes(span: OtelSpan, settings: ServiceSettings | null | undefined): void {
  // Use givenFields() defensively in case a service doesn't initialize all settings.
  if (settings) {
    for (const [key, value] of Object.entries(settings.givenFields())) {
      if (isPrimitive(value)) {
        span.setAttribute(`settings.${_camelToSnake(key)}`, value);
      }
    }
  }
}

/**
 * Extract the standardized gen_ai.provider.name value from a service class name.
 *
 * Source:
 * https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/registry/attributes/gen-ai.md
 *
 * Uses standard OTel names where possible, with special case mappings for
 * service names that don't follow the pattern.
 *
 * @param serviceName The service class name to extract provider name from.
 * @returns The standardized gen_ai.provider.name value.
 */
export function _getProviderNameFromServiceName(serviceName: string): string {
  const SPECIAL_CASE_MAPPINGS: Record<string, string> = {
    // AWS
    AWSBedrockLLMService: "aws.bedrock",
    // Azure
    AzureLLMService: "azure.ai.openai",
    // Google
    GoogleLLMService: "gcp.gemini",
    GoogleVertexLLMService: "gcp.vertex_ai",
    // Others
    GrokLLMService: "x_ai",
    MistralLLMService: "mistral_ai",
  };

  if (Object.hasOwn(SPECIAL_CASE_MAPPINGS, serviceName)) {
    return SPECIAL_CASE_MAPPINGS[serviceName] as string;
  }

  let provider: string;
  if (serviceName.endsWith("LLMService")) {
    provider = serviceName.slice(0, -10).toLowerCase();
  } else {
    provider = serviceName.toLowerCase();
  }

  return provider;
}

export interface TtsSpanAttributesOptions {
  /** Name of the TTS service (e.g., "cartesia"). */
  serviceName: string;
  /** Model name/identifier. */
  model: string;
  /** Voice identifier. */
  voiceId: string;
  /** The text being synthesized. */
  text?: string | null;
  /** Service configuration settings. */
  settings?: ServiceSettings | null;
  /** Number of characters in the text. */
  characterCount?: number | null;
  /** Name of the operation (default: "tts"). */
  operationName?: string;
  /** Time to first byte in seconds. */
  ttfb?: number | null;
  /** Additional attributes to add. */
  [key: string]: unknown;
}

const TTS_KNOWN = new Set([
  "serviceName",
  "model",
  "voiceId",
  "text",
  "settings",
  "characterCount",
  "operationName",
  "ttfb",
]);

/**
 * Add TTS-specific attributes to a span.
 *
 * @param span The span to add attributes to.
 * @param options The TTS attributes; any other key is added as an attribute.
 */
export function addTtsSpanAttributes(span: OtelSpan, options: TtsSpanAttributesOptions): void {
  const operationName = options.operationName ?? "tts";

  // Add standard attributes
  span.setAttribute(
    "gen_ai.provider.name",
    options.serviceName.replaceAll("TTSService", "").toLowerCase(),
  );
  span.setAttribute("gen_ai.request.model", options.model);
  span.setAttribute("gen_ai.operation.name", operationName);
  span.setAttribute("gen_ai.output.type", "speech");
  span.setAttribute("voice_id", options.voiceId);

  // Add optional attributes
  if (options.text) {
    span.setAttribute("text", options.text);
  }

  if (options.characterCount !== null && options.characterCount !== undefined) {
    span.setAttribute("metrics.character_count", options.characterCount);
  }

  if (options.ttfb !== null && options.ttfb !== undefined) {
    span.setAttribute("metrics.ttfb", options.ttfb);
  }

  setSettingsAttributes(span, options.settings);

  // Add any additional keyword arguments as attributes
  setExtraAttributes(span, options, TTS_KNOWN);
}

export interface SttSpanAttributesOptions {
  /** Name of the STT service (e.g., "deepgram"). */
  serviceName: string;
  /** Model name/identifier. */
  model: string;
  /** Name of the operation (default: "stt"). */
  operationName?: string;
  /** The transcribed text. */
  transcript?: string | null;
  /** Whether this is a final transcript. */
  isFinal?: boolean | null;
  /** Detected or configured language. */
  language?: string | null;
  /** User ID associated with the audio being transcribed. */
  userId?: string | null;
  /** Service configuration settings. */
  settings?: ServiceSettings | null;
  /** Whether voice activity detection is enabled. */
  vadEnabled?: boolean;
  /** Time to first byte in seconds. */
  ttfb?: number | null;
  /** Additional attributes to add. */
  [key: string]: unknown;
}

const STT_KNOWN = new Set([
  "serviceName",
  "model",
  "operationName",
  "transcript",
  "isFinal",
  "language",
  "userId",
  "settings",
  "vadEnabled",
  "ttfb",
]);

/**
 * Add STT-specific attributes to a span.
 *
 * @param span The span to add attributes to.
 * @param options The STT attributes; any other key is added as an attribute.
 */
export function addSttSpanAttributes(span: OtelSpan, options: SttSpanAttributesOptions): void {
  const operationName = options.operationName ?? "stt";

  // Add standard attributes
  span.setAttribute(
    "gen_ai.provider.name",
    options.serviceName.replaceAll("STTService", "").toLowerCase(),
  );
  span.setAttribute("gen_ai.request.model", options.model);
  span.setAttribute("gen_ai.operation.name", operationName);
  span.setAttribute("vad_enabled", options.vadEnabled ?? false);

  // Add optional attributes
  if (options.transcript) {
    span.setAttribute("transcript", options.transcript);
  }

  if (options.isFinal !== null && options.isFinal !== undefined) {
    span.setAttribute("is_final", options.isFinal);
  }

  if (options.language) {
    span.setAttribute("language", options.language);
  }

  if (options.userId) {
    span.setAttribute("user_id", options.userId);
  }

  if (options.ttfb !== null && options.ttfb !== undefined) {
    span.setAttribute("metrics.ttfb", options.ttfb);
  }

  setSettingsAttributes(span, options.settings);

  // Add any additional keyword arguments as attributes
  setExtraAttributes(span, options, STT_KNOWN);
}

export interface LlmSpanAttributesOptions {
  /** Name of the LLM service (e.g., "openai"). */
  serviceName: string;
  /** Model name/identifier. */
  model: string;
  /** Whether streaming is enabled. */
  stream?: boolean;
  /** JSON-serialized messages. */
  messages?: string | null;
  /** Aggregated output text from the LLM. */
  output?: string | null;
  /** JSON-serialized tools configuration. */
  tools?: string | null;
  /** Number of tools available. */
  toolCount?: number | null;
  /** Tool selection configuration. */
  toolChoice?: string | null;
  /** System instructions. */
  systemInstructions?: string | null;
  /** Service parameters. */
  parameters?: Record<string, unknown> | null;
  /** Additional parameters. */
  extraParameters?: Record<string, unknown> | null;
  /** Time to first byte in seconds. */
  ttfb?: number | null;
  /** Additional attributes to add. */
  [key: string]: unknown;
}

const LLM_KNOWN = new Set([
  "serviceName",
  "model",
  "stream",
  "messages",
  "output",
  "tools",
  "toolCount",
  "toolChoice",
  "systemInstructions",
  "parameters",
  "extraParameters",
  "ttfb",
]);

const GEN_AI_REQUEST_PARAMETERS = new Set([
  "temperature",
  "max_tokens",
  "max_completion_tokens",
  "top_p",
  "top_k",
  "frequency_penalty",
  "presence_penalty",
  "seed",
]);

/**
 * Add LLM-specific attributes to a span.
 *
 * @param span The span to add attributes to.
 * @param options The LLM attributes; any other key is added as an attribute.
 *   Keys of `parameters` may be camelCase settings names; they are converted
 *   to snake_case attribute names.
 */
export function addLlmSpanAttributes(span: OtelSpan, options: LlmSpanAttributesOptions): void {
  // Add standard attributes
  span.setAttribute("gen_ai.provider.name", _getProviderNameFromServiceName(options.serviceName));
  span.setAttribute("gen_ai.request.model", options.model);
  span.setAttribute("gen_ai.operation.name", "chat");
  span.setAttribute("gen_ai.output.type", "text");
  span.setAttribute("stream", options.stream ?? true);

  // Add optional attributes
  if (options.messages) {
    span.setAttribute("input", options.messages);
  }

  if (options.output) {
    span.setAttribute("output", options.output);
  }

  if (options.tools) {
    span.setAttribute("tools", options.tools);
  }

  if (options.toolCount !== null && options.toolCount !== undefined) {
    span.setAttribute("tool_count", options.toolCount);
  }

  if (options.toolChoice) {
    span.setAttribute("tool_choice", options.toolChoice);
  }

  if (options.systemInstructions) {
    span.setAttribute("gen_ai.system_instructions", options.systemInstructions);
  }

  if (options.ttfb !== null && options.ttfb !== undefined) {
    span.setAttribute("metrics.ttfb", options.ttfb);
  }

  // Add parameters if provided
  if (options.parameters) {
    for (const [rawKey, value] of Object.entries(options.parameters)) {
      if (isPrimitive(value)) {
        const key = _camelToSnake(rawKey);
        if (GEN_AI_REQUEST_PARAMETERS.has(key)) {
          span.setAttribute(`gen_ai.request.${key}`, value);
        } else {
          span.setAttribute(`param.${key}`, value);
        }
      }
    }
  }

  // Add extra parameters if provided
  if (options.extraParameters) {
    for (const [key, value] of Object.entries(options.extraParameters)) {
      if (isPrimitive(value)) {
        span.setAttribute(`extra.${key}`, value);
      }
    }
  }

  // Add any additional keyword arguments as attributes
  setExtraAttributes(span, options, LLM_KNOWN);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export interface GeminiLiveSpanAttributesOptions {
  /** Name of the service. */
  serviceName: string;
  /** Model name/identifier. */
  model: string;
  /** Name of the operation (setup, model_turn, tool_call, etc.). */
  operationName: string;
  /** Voice identifier used for output. */
  voiceId?: string | null;
  /** Language code for the session. */
  language?: string | null;
  /** Supported modalities (e.g., "AUDIO", "TEXT"). */
  modalities?: string | null;
  /** Service configuration settings. */
  settings?: ServiceSettings | null;
  /** Available tools/functions list. */
  tools?: unknown[] | null;
  /** JSON-serialized tools for detailed inspection. */
  toolsSerialized?: string | null;
  /** Transcription text. */
  transcript?: string | null;
  /** Whether transcript is input (true) or output (false). */
  isInput?: boolean | null;
  /** Text output from model. */
  textOutput?: string | null;
  /** Size of audio data in bytes. */
  audioDataSize?: number | null;
  /** Additional attributes to add. */
  [key: string]: unknown;
}

const GEMINI_KNOWN = new Set([
  "serviceName",
  "model",
  "operationName",
  "voiceId",
  "language",
  "modalities",
  "settings",
  "tools",
  "toolsSerialized",
  "transcript",
  "isInput",
  "textOutput",
  "audioDataSize",
]);

/** An enum member upstream (`.value`); a plain string in TS. */
function enumValue(value: unknown): unknown {
  return isObject(value) && "value" in value ? value.value : value;
}

/**
 * Add Gemini Live specific attributes to a span.
 *
 * @param span The span to add attributes to.
 * @param options The Gemini Live attributes; any other key is added as an attribute.
 */
export function addGeminiLiveSpanAttributes(
  span: OtelSpan,
  options: GeminiLiveSpanAttributesOptions,
): void {
  // Add standard attributes
  span.setAttribute("gen_ai.provider.name", "gcp.gemini");
  span.setAttribute("gen_ai.request.model", options.model);
  span.setAttribute("gen_ai.operation.name", options.operationName);
  span.setAttribute("service.operation", options.operationName);

  // Add optional attributes
  if (options.voiceId) {
    span.setAttribute("voice_id", options.voiceId);
  }

  if (options.language) {
    span.setAttribute("language", options.language);
  }

  if (options.modalities) {
    span.setAttribute("modalities", options.modalities);
  }

  if (options.transcript) {
    span.setAttribute("transcript", options.transcript);
    if (options.isInput !== null && options.isInput !== undefined) {
      span.setAttribute("transcript.is_input", options.isInput);
    }
  }

  if (options.textOutput) {
    span.setAttribute("text_output", options.textOutput);
  }

  if (options.audioDataSize !== null && options.audioDataSize !== undefined) {
    span.setAttribute("audio.data_size_bytes", options.audioDataSize);
  }

  const tools = options.tools;
  if (tools && tools.length > 0) {
    span.setAttribute("tools.count", tools.length);
    span.setAttribute("tools.available", true);

    // Add individual tool names for easier filtering
    const toolNames: string[] = [];
    for (const tool of tools) {
      if (isObject(tool) && "name" in tool) {
        const toolName = tool.name;
        if (toolName !== null && toolName !== undefined) {
          toolNames.push(String(toolName));
        }
      }
    }

    if (toolNames.length > 0) {
      span.setAttribute("tools.names", toolNames.join(","));
    }
  }

  if (options.toolsSerialized) {
    span.setAttribute("tools.definitions", options.toolsSerialized);
  }

  // Use givenFields() defensively in case a service doesn't initialize all settings.
  if (options.settings) {
    for (const [key, value] of Object.entries(options.settings.givenFields())) {
      if (isPrimitive(value)) {
        span.setAttribute(`settings.${_camelToSnake(key)}`, value);
      } else if (key === "vad" && value) {
        // Handle VAD settings specially
        if (isObject(value)) {
          if ("disabled" in value && value.disabled !== null && value.disabled !== undefined) {
            span.setAttribute("settings.vad.disabled", value.disabled as boolean);
          }
          if ("startSensitivity" in value && value.startSensitivity) {
            span.setAttribute(
              "settings.vad.start_sensitivity",
              String(enumValue(value.startSensitivity)),
            );
          }
          if ("endSensitivity" in value && value.endSensitivity) {
            span.setAttribute(
              "settings.vad.end_sensitivity",
              String(enumValue(value.endSensitivity)),
            );
          }
        }
      }
    }
  }

  // Add any additional keyword arguments as attributes
  setExtraAttributes(span, options, GEMINI_KNOWN);
}

export interface OpenaiRealtimeSpanAttributesOptions {
  /** Name of the service. */
  serviceName: string;
  /** Model name/identifier. */
  model: string;
  /** Name of the operation (setup, transcription, response, etc.). */
  operationName: string;
  /** Session configuration properties. */
  sessionProperties?: Record<string, unknown> | null;
  /** Transcription text. */
  transcript?: string | null;
  /** Whether transcript is input (true) or output (false). */
  isInput?: boolean | null;
  /** JSON-serialized context messages. */
  contextMessages?: string | null;
  /** Function calls being made. */
  functionCalls?: unknown[] | null;
  /** Available tools/functions list. */
  tools?: unknown[] | null;
  /** JSON-serialized tools for detailed inspection. */
  toolsSerialized?: string | null;
  /** Size of audio data in bytes. */
  audioDataSize?: number | null;
  /** Additional attributes to add. */
  [key: string]: unknown;
}

const OPENAI_REALTIME_KNOWN = new Set([
  "serviceName",
  "model",
  "operationName",
  "sessionProperties",
  "transcript",
  "isInput",
  "contextMessages",
  "functionCalls",
  "tools",
  "toolsSerialized",
  "audioDataSize",
]);

/**
 * Add OpenAI Realtime specific attributes to a span.
 *
 * @param span The span to add attributes to.
 * @param options The OpenAI Realtime attributes; any other key is added as an attribute.
 */
export function addOpenaiRealtimeSpanAttributes(
  span: OtelSpan,
  options: OpenaiRealtimeSpanAttributesOptions,
): void {
  // Add standard attributes
  span.setAttribute("gen_ai.provider.name", "openai");
  span.setAttribute("gen_ai.request.model", options.model);
  span.setAttribute("gen_ai.operation.name", options.operationName);
  span.setAttribute("service.operation", options.operationName);

  // Add optional attributes
  if (options.transcript) {
    span.setAttribute("transcript", options.transcript);
    if (options.isInput !== null && options.isInput !== undefined) {
      span.setAttribute("transcript.is_input", options.isInput);
    }
  }

  if (options.contextMessages) {
    span.setAttribute("input", options.contextMessages);
  }

  if (options.audioDataSize !== null && options.audioDataSize !== undefined) {
    span.setAttribute("audio.data_size_bytes", options.audioDataSize);
  }

  const tools = options.tools;
  if (tools && tools.length > 0) {
    span.setAttribute("tools.count", tools.length);
    span.setAttribute("tools.available", true);

    // Add individual tool names for easier filtering
    const toolNames: string[] = [];
    for (const tool of tools) {
      if (isObject(tool) && "name" in tool) {
        toolNames.push(String(tool.name));
      } else if (isObject(tool) && isObject(tool.function) && "name" in tool.function) {
        toolNames.push(String(tool.function.name));
      }
    }

    if (toolNames.length > 0) {
      span.setAttribute("tools.names", toolNames.join(","));
    }
  }

  if (options.toolsSerialized) {
    span.setAttribute("tools.definitions", options.toolsSerialized);
  }

  const functionCalls = options.functionCalls;
  if (functionCalls && functionCalls.length > 0) {
    span.setAttribute("function_calls.count", functionCalls.length);
    const call = functionCalls[0];
    if (isObject(call) && "name" in call) {
      span.setAttribute("function_calls.first_name", String(call.name));
    }
  }

  // Add session properties if provided
  if (options.sessionProperties) {
    for (const [key, value] of Object.entries(options.sessionProperties)) {
      if (isPrimitive(value)) {
        span.setAttribute(`session.${key}`, value);
      } else if (key === "turn_detection" && value !== null && value !== undefined) {
        if (typeof value === "boolean") {
          span.setAttribute("session.turn_detection.enabled", value);
        } else if (isObject(value)) {
          span.setAttribute("session.turn_detection.enabled", true);
          for (const [tdKey, tdValue] of Object.entries(value)) {
            if (isPrimitive(tdValue)) {
              span.setAttribute(`session.turn_detection.${tdKey}`, tdValue);
            }
          }
        }
      }
    }
  }

  // Add any additional keyword arguments as attributes
  setExtraAttributes(span, options, OPENAI_REALTIME_KNOWN);
}
