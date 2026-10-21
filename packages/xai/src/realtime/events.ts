// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/services/xai/realtime/events.py

/**
 * Event models and data structures for Grok Voice Agent API communication.
 *
 * Based on xAI's Grok Voice Agent API documentation:
 * https://docs.x.ai/docs/guides/voice/agent
 *
 * Porting notes:
 * - Upstream models are pydantic `BaseModel`s. Here each model extends the
 *   small `BaseModel` below (the same machinery as `@pipedog/openai`'s
 *   realtime events): fields are camelCase and the constructor takes one
 *   options object, while `modelValidate()` reads and `modelDump()` /
 *   `toJSON()` write the upstream snake_case wire keys, so the wire format is
 *   unchanged. Models with pydantic's `extra="allow"` keep unknown keys in
 *   `modelExtra` and dump them back.
 * - Validation is reduced to what the service relies on: required fields and
 *   the `type` literal of server events raise `ValidationError`; value types
 *   are not checked.
 * - `model_copy(update=...)` is `modelCopy({ update })`, with camelCase field
 *   names; `SessionProperties.model_fields` is `SessionProperties.modelFields`
 *   (camelCase field name to wire key).
 */

import { rethrowIfCancelled } from "@pipedog/asyncio";
import type { DirectFunction } from "@pipedog/core/adapters/schemas/direct_function";
import type { FunctionSchema } from "@pipedog/core/adapters/schemas/function_schema";
import { ToolsSchema } from "@pipedog/core/adapters/schemas/tools_schema";
import { LLMContext } from "@pipedog/core/processors/aggregators/llm_context";
import { pyJsonLoads } from "@pipedog/core/utils/py_json";

/** A modality the model can respond with. */
type Modality = "text" | "audio";

//
// Model machinery (pydantic's BaseModel, reduced to what these events need).
//

/** Raised when data does not match a model, like pydantic's `ValidationError`. */
export class ValidationError extends Error {
  override name = "ValidationError";
}

/** Options for `BaseModel.modelDump()`. */
export interface ModelDumpOptions {
  /** Leave out fields whose value is `null` (pydantic's `exclude_none`). */
  excludeNone?: boolean;
}

/** Builds a nested field's value from wire data. */
type Resolver = (value: unknown) => unknown;

function camelToSnake(name: string): string {
  return name.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

function snakeToCamel(name: string): string {
  return name.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function dumpValue(value: unknown, options: ModelDumpOptions): unknown {
  if (value instanceof BaseModel) return value.modelDump(options);
  if (Array.isArray(value)) return value.map((v) => dumpValue(v, options));
  return value;
}

function required<T>(options: object, name: string, model: string): T {
  const value = (options as Record<string, unknown>)[name];
  if (value === undefined) {
    throw new ValidationError(
      `1 validation error for ${model}\n${camelToSnake(name)}\n  Field required`,
    );
  }
  return value as T;
}

function literal<T extends string>(value: unknown, expected: T, model: string): T {
  if (value === undefined) required({}, "type", model);
  if (value !== expected) {
    throw new ValidationError(
      `1 validation error for ${model}\ntype\n  Input should be '${expected}'`,
    );
  }
  return expected;
}

/** A `type` that must be one of several literals (`Literal["a", "b"]`). */
function oneOf<T extends string>(value: unknown, expected: readonly T[], model: string): T {
  if (value === undefined) required({}, "type", model);
  if (!expected.includes(value as T)) {
    const options = expected.map((e) => `'${e}'`).join(" or ");
    throw new ValidationError(
      `1 validation error for ${model}\ntype\n  Input should be ${options}`,
    );
  }
  return value as T;
}

/** A resolver building a model from wire data (or keeping an instance). */
function model(cls: { modelValidate(data: unknown): unknown }): Resolver {
  return (value) => (value === null ? null : cls.modelValidate(value));
}

/** A resolver building a list of models from wire data. */
function listOf(resolve: Resolver): Resolver {
  return (value) => (Array.isArray(value) ? value.map(resolve) : value);
}

// Extra fields of models that allow them, kept off the instance so they are
// not taken for declared fields.
const modelExtras = new WeakMap<object, Record<string, unknown>>();

/**
 * Base of the models in this module (pydantic's `BaseModel`).
 *
 * Fields are the instance's own properties, in declaration order (base class
 * fields first, as pydantic orders them).
 */
export class BaseModel {
  /** Fields holding nested models, by field name: how to build each from wire data. */
  static _nested: Record<string, Resolver> = {};
  /** Whether keys that match no field are kept (pydantic's `extra="allow"`). */
  static _extraAllowed = false;

  /** Extra fields kept from wire data (pydantic's `model_extra`), by wire key. */
  get modelExtra(): Record<string, unknown> | null {
    return modelExtras.get(this) ?? null;
  }

  /**
   * Validate wire data (snake_case keys) into a model (pydantic's
   * `model_validate`). An instance of the model is returned as is.
   */
  static modelValidate<T extends BaseModel>(this: new (options: any) => T, data: unknown): T {
    // biome-ignore lint/complexity/noThisInStatic: polymorphic static, like pydantic's classmethod.
    if (data instanceof this) return data;
    // biome-ignore lint/complexity/noThisInStatic: polymorphic static.
    const cls = this as unknown as typeof BaseModel;
    if (!isPlainObject(data)) {
      throw new ValidationError(
        `1 validation error for ${cls.name}\n  Input should be a valid dictionary or instance of ${cls.name}`,
      );
    }
    const nested = cls._nested;
    const options: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data)) {
      const name = snakeToCamel(key);
      const resolve = Object.hasOwn(nested, name) ? nested[name] : undefined;
      options[name] = resolve && value !== undefined ? resolve(value) : value;
    }
    const instance = new this(options);
    if (cls._extraAllowed) {
      const extra: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(data)) {
        if (!Object.hasOwn(instance, snakeToCamel(key))) extra[key] = value;
      }
      if (Object.keys(extra).length > 0) modelExtras.set(instance, extra);
    }
    return instance;
  }

  /**
   * Serialize the model to a plain object with the wire (snake_case) keys
   * (pydantic's `model_dump`).
   */
  modelDump(options: ModelDumpOptions = {}): Record<string, any> {
    const out: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(this)) {
      if (value === undefined) continue;
      if (options.excludeNone && value === null) continue;
      out[camelToSnake(name)] = dumpValue(value, options);
    }
    const extra = modelExtras.get(this);
    if (extra) {
      for (const [key, value] of Object.entries(extra)) {
        if (options.excludeNone && value === null) continue;
        out[key] = value;
      }
    }
    return out;
  }

  /** JSON form: the wire dump. */
  toJSON(): Record<string, any> {
    return this.modelDump();
  }

  /**
   * Shallow copy of the model, with `update` (camelCase field names) applied
   * (pydantic's `model_copy`).
   */
  modelCopy(options: { update?: Record<string, unknown> } = {}): this {
    const copy = Object.assign(Object.create(Object.getPrototypeOf(this)), this) as this;
    const extra = modelExtras.get(this);
    if (extra) modelExtras.set(copy, { ...extra });
    if (options.update) Object.assign(copy, options.update);
    return copy;
  }
}

//
// Audio format configuration
//

/** Grok supports configurable sample rates for PCM audio. */
export type SUPPORTED_SAMPLE_RATES = 8000 | 11025 | 16000 | 22050 | 24000 | 32000 | 44100 | 48000;

export interface AudioFormatOptions {
  type?: string;
}

/** Base class for audio format configuration. */
export class AudioFormat extends BaseModel {
  type: string;

  constructor(options: AudioFormatOptions) {
    super();
    this.type = required<string>(options, "type", new.target.name);
  }
}

export interface PCMAudioFormatOptions {
  type?: "audio/pcm";
  rate?: SUPPORTED_SAMPLE_RATES;
}

/**
 * PCM audio format configuration with configurable sample rate.
 *
 * - `type`: audio format type, always "audio/pcm".
 * - `rate`: sample rate in Hz. Defaults to 24000.
 */
export class PCMAudioFormat extends AudioFormat {
  declare type: "audio/pcm";
  rate: SUPPORTED_SAMPLE_RATES;

  constructor(options: PCMAudioFormatOptions = {}) {
    super({ type: options.type ?? "audio/pcm" });
    this.rate = options.rate ?? 24000;
  }
}

export interface PCMUAudioFormatOptions {
  type?: "audio/pcmu";
}

/**
 * PCMU (G.711 mu-law) audio format configuration.
 *
 * Fixed at 8000 Hz sample rate.
 *
 * - `type`: audio format type, always "audio/pcmu".
 */
export class PCMUAudioFormat extends AudioFormat {
  declare type: "audio/pcmu";

  constructor(options: PCMUAudioFormatOptions = {}) {
    super({ type: options.type ?? "audio/pcmu" });
  }
}

export interface PCMAAudioFormatOptions {
  type?: "audio/pcma";
}

/**
 * PCMA (G.711 A-law) audio format configuration.
 *
 * Fixed at 8000 Hz sample rate.
 *
 * - `type`: audio format type, always "audio/pcma".
 */
export class PCMAAudioFormat extends AudioFormat {
  declare type: "audio/pcma";

  constructor(options: PCMAAudioFormatOptions = {}) {
    super({ type: options.type ?? "audio/pcma" });
  }
}

/** Builds the audio format a wire dict describes, by its `type`. */
const audioFormat: Resolver = (value) => {
  if (value === null || value instanceof AudioFormat || !isPlainObject(value)) return value;
  if (value.type === "audio/pcmu") return PCMUAudioFormat.modelValidate(value);
  if (value.type === "audio/pcma") return PCMAAudioFormat.modelValidate(value);
  return PCMAudioFormat.modelValidate(value);
};

//
// Turn detection configuration
//

export interface TurnDetectionOptions {
  type?: "server_vad" | null;
  threshold?: number | null;
  silenceDurationMs?: number | null;
  prefixPaddingMs?: number | null;
  idleTimeoutMs?: number | null;
}

/**
 * Server-side voice activity detection configuration.
 *
 * - `type`: detection type, must be "server_vad" or null for manual.
 * - `threshold`: VAD activation threshold (0.1–0.9). Higher requires louder audio.
 * - `silenceDurationMs`: silence before the server ends the user turn.
 * - `prefixPaddingMs`: audio (ms) included before detected speech start.
 * - `idleTimeoutMs`: when set, the server re-engages after this many ms of
 *   silence following an assistant response (`timeout_triggered`).
 */
export class TurnDetection extends BaseModel {
  type: "server_vad" | null;
  threshold: number | null;
  silenceDurationMs: number | null;
  prefixPaddingMs: number | null;
  idleTimeoutMs: number | null;

  constructor(options: TurnDetectionOptions = {}) {
    super();
    this.type = options.type === undefined ? "server_vad" : options.type;
    this.threshold = options.threshold ?? null;
    this.silenceDurationMs = options.silenceDurationMs ?? null;
    this.prefixPaddingMs = options.prefixPaddingMs ?? null;
    this.idleTimeoutMs = options.idleTimeoutMs ?? null;
  }
}

//
// Audio configuration
//

export interface InputAudioTranscriptionOptions {
  model?: string | null;
  languageHint?: string | null;
  keyterms?: string[] | null;
}

/**
 * Input audio transcription settings for the voice agent.
 *
 * - `model`: transcription model. Use `grok-transcribe` for streaming
 *   `conversation.item.input_audio_transcription.updated` events.
 * - `languageHint`: BCP-47 language code to bias ASR.
 * - `keyterms`: domain terms to bias transcription (max 100, ≤50 chars each).
 */
export class InputAudioTranscription extends BaseModel {
  model: string | null;
  languageHint: string | null;
  keyterms: string[] | null;

  constructor(options: InputAudioTranscriptionOptions = {}) {
    super();
    this.model = options.model ?? null;
    this.languageHint = options.languageHint ?? null;
    this.keyterms = options.keyterms ?? null;
  }
}

export interface AudioInputOptions {
  format?: PCMAudioFormat | PCMUAudioFormat | PCMAAudioFormat | null;
  transcription?: InputAudioTranscription | null;
  transport?: "json" | "binary" | null;
}

/**
 * Audio input configuration.
 *
 * - `format`: the format configuration for input audio.
 * - `transcription`: optional input transcription settings.
 * - `transport`: wire path for input audio (`json` or `binary`).
 */
export class AudioInput extends BaseModel {
  static override _nested: Record<string, Resolver> = {
    format: audioFormat,
    transcription: model(InputAudioTranscription),
  };

  format: PCMAudioFormat | PCMUAudioFormat | PCMAAudioFormat | null;
  transcription: InputAudioTranscription | null;
  transport: "json" | "binary" | null;

  constructor(options: AudioInputOptions = {}) {
    super();
    this.format = options.format ?? null;
    this.transcription = options.transcription ?? null;
    this.transport = options.transport ?? null;
  }
}

export interface AudioOutputOptions {
  format?: PCMAudioFormat | PCMUAudioFormat | PCMAAudioFormat | null;
  speed?: number | null;
  transport?: "json" | "binary" | null;
}

/**
 * Audio output configuration.
 *
 * - `format`: the format configuration for output audio.
 * - `speed`: playback speed multiplier (0.7–1.5).
 * - `transport`: wire path for assistant audio (`json` or `binary`).
 */
export class AudioOutput extends BaseModel {
  static override _nested: Record<string, Resolver> = { format: audioFormat };

  format: PCMAudioFormat | PCMUAudioFormat | PCMAAudioFormat | null;
  speed: number | null;
  transport: "json" | "binary" | null;

  constructor(options: AudioOutputOptions = {}) {
    super();
    this.format = options.format ?? null;
    this.speed = options.speed ?? null;
    this.transport = options.transport ?? null;
  }
}

export interface AudioConfigurationOptions {
  input?: AudioInput | null;
  output?: AudioOutput | null;
}

/**
 * Audio configuration for input and output.
 *
 * - `input`: configuration for input audio.
 * - `output`: configuration for output audio.
 */
export class AudioConfiguration extends BaseModel {
  static override _nested: Record<string, Resolver> = {
    input: model(AudioInput),
    output: model(AudioOutput),
  };

  input: AudioInput | null;
  output: AudioOutput | null;

  constructor(options: AudioConfigurationOptions = {}) {
    super();
    this.input = options.input ?? null;
    this.output = options.output ?? null;
  }
}

export interface ReasoningOptions {
  effort?: "high" | "none" | null;
}

/**
 * Reasoning controls for voice-agent models.
 *
 * - `effort`: `high` enables reasoning; `none` disables it.
 */
export class Reasoning extends BaseModel {
  effort: "high" | "none" | null;

  constructor(options: ReasoningOptions = {}) {
    super();
    this.effort = options.effort ?? null;
  }
}

export interface SessionResumptionOptions {
  enabled?: boolean | null;
}

/**
 * Session resumption opt-in for reconnecting with conversation history.
 *
 * - `enabled`: when true, the server caches turns for `conversation_id` replay.
 */
export class SessionResumption extends BaseModel {
  enabled: boolean | null;

  constructor(options: SessionResumptionOptions = {}) {
    super();
    this.enabled = options.enabled ?? null;
  }
}

//
// Tool definitions - Grok-specific tools
//

/**
 * Web search tool configuration.
 *
 * Enables the voice agent to search the web for current information.
 */
export class WebSearchTool extends BaseModel {
  type: "web_search";

  constructor(options: { type?: "web_search" } = {}) {
    super();
    this.type = options.type ?? "web_search";
  }
}

export interface XSearchToolOptions {
  type?: "x_search";
  allowedXHandles?: string[] | null;
}

/**
 * X (Twitter) search tool configuration.
 *
 * Enables the voice agent to search X for posts and information.
 *
 * - `type`: tool type, always "x_search".
 * - `allowedXHandles`: optional list of X handles to filter search results.
 */
export class XSearchTool extends BaseModel {
  type: "x_search";
  allowedXHandles: string[] | null;

  constructor(options: XSearchToolOptions = {}) {
    super();
    this.type = options.type ?? "x_search";
    this.allowedXHandles = options.allowedXHandles ?? null;
  }
}

export interface FileSearchToolOptions {
  type?: "file_search";
  vectorStoreIds: string[];
  maxNumResults?: number | null;
}

/**
 * File/Collection search tool configuration.
 *
 * Enables the voice agent to search through uploaded document collections.
 *
 * - `type`: tool type, always "file_search".
 * - `vectorStoreIds`: list of collection IDs to search.
 * - `maxNumResults`: maximum number of results to return.
 */
export class FileSearchTool extends BaseModel {
  type: "file_search";
  vectorStoreIds: string[];
  maxNumResults: number | null;

  constructor(options: FileSearchToolOptions) {
    super();
    this.type = options.type ?? "file_search";
    this.vectorStoreIds = required(options, "vectorStoreIds", "FileSearchTool");
    this.maxNumResults = options.maxNumResults === undefined ? 10 : options.maxNumResults;
  }
}

export interface FunctionToolOptions {
  type?: "function";
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/**
 * Custom function tool configuration.
 *
 * - `type`: tool type, always "function".
 * - `name`: name of the function.
 * - `description`: description of what the function does.
 * - `parameters`: JSON schema for function parameters.
 */
export class FunctionTool extends BaseModel {
  type: "function";
  name: string;
  description: string;
  parameters: Record<string, unknown>;

  constructor(options: FunctionToolOptions) {
    super();
    this.type = options.type ?? "function";
    this.name = required(options, "name", "FunctionTool");
    this.description = required(options, "description", "FunctionTool");
    this.parameters = required(options, "parameters", "FunctionTool");
  }
}

/**
 * Remote MCP tool configuration managed by xAI.
 *
 * - `type`: tool type, always "mcp". Other keys (server URL, label, ...) are
 *   kept as extra fields, as pydantic's `extra="allow"`.
 */
export class McpTool extends BaseModel {
  static override _extraAllowed = true;

  type: "mcp";

  constructor(options: { type?: "mcp" } = {}) {
    super();
    this.type = options.type ?? "mcp";
  }
}

/** Union type for all Grok tools. */
export type GrokTool =
  | WebSearchTool
  | XSearchTool
  | FileSearchTool
  | FunctionTool
  | McpTool
  | Record<string, unknown>;

//
// Voice options
//

/**
 * Voice IDs are plain strings: any built-in voice (xAI documents the
 * catalogue at https://docs.x.ai/docs/guides/voice/agent, and
 * `GET /v1/tts/voices` returns it) or a custom ID from the Custom Voices API.
 * IDs are case-insensitive.
 */
export type GrokVoice = string;

//
// Session properties
//

/** The tools a session can carry. */
export type SessionTools = ToolsSchema | (FunctionSchema | DirectFunction)[] | GrokTool[];

export interface SessionPropertiesOptions {
  instructions?: string | null;
  voice?: string | null;
  turnDetection?: TurnDetection | null;
  audio?: AudioConfiguration | null;
  tools?: SessionTools | null;
  reasoning?: Reasoning | null;
  resumption?: SessionResumption | null;
  replace?: Record<string, string> | null;
  id?: string | null;
  object?: string | null;
  model?: string | null;
}

/**
 * Configuration properties for a Grok Voice Agent session.
 *
 * - `instructions`: system instructions for the assistant.
 * - `voice`: the voice the model uses to respond — a built-in voice ID (see
 *   https://docs.x.ai/docs/guides/voice/agent) or a custom one from the
 *   Custom Voices API. Defaults to "eve", which is xAI's own default.
 * - `turnDetection`: configuration for turn detection. Defaults to
 *   server-side VAD. Set to null for manual turn detection.
 * - `audio`: configuration for input and output audio.
 * - `tools`: available tools for the assistant (web_search, x_search,
 *   file_search, function, mcp).
 * - `reasoning`: optional reasoning effort controls.
 * - `resumption`: optional session-resumption opt-in.
 * - `replace`: optional pronunciation replacement map applied before TTS.
 * - `id`: session id when present on server snapshots (`session.created`).
 * - `object`: object type from server snapshots.
 * - `model`: model id echoed on server snapshots.
 */
export class SessionProperties extends BaseModel {
  // Unknown server fields are ignored, so session.created / session.updated
  // snapshots remain parseable.
  static override _nested: Record<string, Resolver> = {
    turnDetection: model(TurnDetection),
    audio: model(AudioConfiguration),
    reasoning: model(Reasoning),
    resumption: model(SessionResumption),
  };

  /** The model's fields (pydantic's `model_fields`): camelCase field name to wire key. */
  static readonly modelFields: Readonly<Record<string, string>> = {
    instructions: "instructions",
    voice: "voice",
    turnDetection: "turn_detection",
    audio: "audio",
    tools: "tools",
    reasoning: "reasoning",
    resumption: "resumption",
    replace: "replace",
    id: "id",
    object: "object",
    model: "model",
  };

  instructions: string | null;
  voice: string | null;
  turnDetection: TurnDetection | null;
  audio: AudioConfiguration | null;
  // Tools provided by the user may be a ToolsSchema or a plain list of standard
  // tools (normalized to a ToolsSchema on construction); a list of
  // provider-native GrokTool objects passes through.
  tools: SessionTools | null;
  reasoning: Reasoning | null;
  resumption: SessionResumption | null;
  replace: Record<string, string> | null;
  id: string | null;
  object: string | null;
  model: string | null;

  constructor(options: SessionPropertiesOptions = {}) {
    super();
    this.instructions = options.instructions ?? null;
    this.voice = options.voice === undefined ? "eve" : options.voice;
    this.turnDetection =
      options.turnDetection === undefined
        ? new TurnDetection({ type: "server_vad" })
        : options.turnDetection;
    this.audio = options.audio ?? null;
    this.tools = SessionProperties._normalizeTools(options.tools ?? null);
    this.reasoning = options.reasoning ?? null;
    this.resumption = options.resumption ?? null;
    this.replace = options.replace ?? null;
    this.id = options.id ?? null;
    this.object = options.object ?? null;
    this.model = options.model ?? null;
  }

  /**
   * Wrap a plain list of standard tools in a `ToolsSchema`.
   *
   * Provider-native tool lists pass through unchanged.
   */
  static _normalizeTools(v: SessionTools | null): SessionTools | null {
    if (Array.isArray(v)) {
      const normalized = LLMContext._normalizeAndValidateTools(v, { allowProviderTools: true });
      return normalized instanceof ToolsSchema || Array.isArray(normalized)
        ? (normalized as SessionTools)
        : null;
    }
    return v;
  }
}

//
// Conversation items
//

export type ItemContentType =
  | "text"
  | "audio"
  | "input_text"
  | "input_audio"
  | "output_text"
  | "output_audio";

export interface ItemContentOptions {
  type: ItemContentType;
  text?: string | null;
  audio?: string | null;
  transcript?: string | null;
}

/**
 * Content within a conversation item.
 *
 * - `type`: content type (input_text, input_audio, text, audio).
 * - `text`: text content for text-based items.
 * - `audio`: base64-encoded audio data for audio items.
 * - `transcript`: transcribed text for audio items.
 */
export class ItemContent extends BaseModel {
  type: ItemContentType;
  text: string | null;
  audio: string | null; // base64-encoded audio
  transcript: string | null;

  constructor(options: ItemContentOptions) {
    super();
    this.type = required(options, "type", "ItemContent");
    this.text = options.text ?? null;
    this.audio = options.audio ?? null;
    this.transcript = options.transcript ?? null;
  }
}

export interface ConversationItemOptions {
  id?: string;
  object?: "realtime.item" | null;
  type: "message" | "function_call" | "function_call_output" | "force_message";
  status?: "completed" | "in_progress" | "incomplete" | null;
  role?: "user" | "assistant" | "system" | "tool" | null;
  content?: ItemContent[] | null;
  callId?: string | null;
  name?: string | null;
  arguments?: string | null;
  output?: string | null;
}

/**
 * A conversation item in the realtime session.
 *
 * - `id`: unique identifier for the item, auto-generated if not provided.
 * - `object`: object type identifier for the realtime API.
 * - `type`: item type (message, function_call, function_call_output, or
 *   force_message).
 * - `status`: current status of the item.
 * - `role`: speaker role for message items (user, assistant, or system).
 * - `content`: content list for message items.
 * - `callId`: function call identifier for function_call items.
 * - `name`: function name for function_call items.
 * - `arguments`: function arguments as JSON string for function_call items.
 * - `output`: function output as JSON string for function_call_output items.
 */
export class ConversationItem extends BaseModel {
  static override _nested: Record<string, Resolver> = {
    content: listOf(model(ItemContent)),
  };

  id: string;
  object: "realtime.item" | null;
  type: "message" | "function_call" | "function_call_output" | "force_message";
  status: "completed" | "in_progress" | "incomplete" | null;
  role: "user" | "assistant" | "system" | "tool" | null;
  content: ItemContent[] | null;
  callId: string | null;
  name: string | null;
  arguments: string | null;
  output: string | null;

  constructor(options: ConversationItemOptions) {
    super();
    this.id = options.id ?? crypto.randomUUID().replaceAll("-", "");
    this.object = options.object ?? null;
    this.type = required(options, "type", "ConversationItem");
    this.status = options.status ?? null;
    this.role = options.role ?? null;
    this.content = options.content ?? null;
    this.callId = options.callId ?? null;
    this.name = options.name ?? null;
    this.arguments = options.arguments ?? null;
    this.output = options.output ?? null;
  }
}

export interface RealtimeConversationOptions {
  id: string;
  object: "realtime.conversation";
}

/**
 * A realtime conversation session.
 *
 * - `id`: unique identifier for the conversation.
 * - `object`: object type identifier, always "realtime.conversation".
 */
export class RealtimeConversation extends BaseModel {
  id: string;
  object: "realtime.conversation";

  constructor(options: RealtimeConversationOptions) {
    super();
    this.id = required(options, "id", "RealtimeConversation");
    this.object = required(options, "object", "RealtimeConversation");
  }
}

export interface ResponsePropertiesOptions {
  modalities?: Modality[] | null;
  instructions?: string | null;
}

/**
 * Properties for configuring assistant responses.
 *
 * - `modalities`: output modalities for the response (text, audio, or both).
 * - `instructions`: per-response system prompt override (session
 *   instructions resume on the next response).
 */
export class ResponseProperties extends BaseModel {
  modalities: Modality[] | null;
  instructions: string | null;

  constructor(options: ResponsePropertiesOptions = {}) {
    super();
    this.modalities = options.modalities === undefined ? ["text", "audio"] : options.modalities;
    this.instructions = options.instructions ?? null;
  }
}

//
// Error class
//

export interface RealtimeErrorOptions {
  type?: string | null;
  code?: string | null;
  message: string;
  param?: string | null;
  eventId?: string | null;
}

/**
 * Error information from the realtime API.
 *
 * - `type`: error type identifier.
 * - `code`: specific error code.
 * - `message`: human-readable error message.
 * - `param`: parameter name that caused the error, if applicable.
 * - `eventId`: event ID associated with the error, if applicable.
 */
export class RealtimeError extends BaseModel {
  type: string | null;
  code: string | null;
  message: string;
  param: string | null;
  eventId: string | null;

  constructor(options: RealtimeErrorOptions) {
    super();
    this.type = options.type ?? null;
    this.code = options.code === undefined ? "" : options.code;
    this.message = required(options, "message", "RealtimeError");
    this.param = options.param ?? null;
    this.eventId = options.eventId ?? null;
  }
}

//
// Client Events (sent to Grok)
//

export interface ClientEventOptions {
  eventId?: string;
}

/**
 * Base class for client events sent to the realtime API.
 *
 * - `eventId`: unique identifier for the event, auto-generated if not provided.
 */
export class ClientEvent extends BaseModel {
  eventId: string;

  constructor(options: ClientEventOptions = {}) {
    super();
    this.eventId = options.eventId ?? crypto.randomUUID();
  }
}

export interface SessionUpdateEventOptions extends ClientEventOptions {
  type?: "session.update";
  session: SessionProperties;
}

/**
 * Event to update session properties.
 *
 * - `type`: event type, always "session.update".
 * - `session`: updated session properties.
 */
export class SessionUpdateEvent extends ClientEvent {
  static override _nested: Record<string, Resolver> = { session: model(SessionProperties) };

  type = "session.update" as const;
  session: SessionProperties;

  constructor(options: SessionUpdateEventOptions) {
    super(options);
    this.session = required(options, "session", "SessionUpdateEvent");
  }
}

export interface InputAudioBufferAppendEventOptions extends ClientEventOptions {
  type?: "input_audio_buffer.append";
  audio: string;
}

/**
 * Event to append audio data to the input buffer.
 *
 * - `type`: event type, always "input_audio_buffer.append".
 * - `audio`: base64-encoded audio data to append.
 */
export class InputAudioBufferAppendEvent extends ClientEvent {
  type = "input_audio_buffer.append" as const;
  audio: string; // base64-encoded audio

  constructor(options: InputAudioBufferAppendEventOptions) {
    super(options);
    this.audio = required(options, "audio", "InputAudioBufferAppendEvent");
  }
}

export interface InputAudioBufferCommitEventOptions extends ClientEventOptions {
  type?: "input_audio_buffer.commit";
}

/**
 * Event to commit the current input audio buffer.
 *
 * Used when turn_detection is null (manual mode).
 *
 * - `type`: event type, always "input_audio_buffer.commit".
 */
export class InputAudioBufferCommitEvent extends ClientEvent {
  type = "input_audio_buffer.commit" as const;

  constructor(options: InputAudioBufferCommitEventOptions = {}) {
    super(options);
  }
}

export interface InputAudioBufferClearEventOptions extends ClientEventOptions {
  type?: "input_audio_buffer.clear";
}

/**
 * Event to clear the input audio buffer.
 *
 * - `type`: event type, always "input_audio_buffer.clear".
 */
export class InputAudioBufferClearEvent extends ClientEvent {
  type = "input_audio_buffer.clear" as const;

  constructor(options: InputAudioBufferClearEventOptions = {}) {
    super(options);
  }
}

export interface ConversationItemCreateEventOptions extends ClientEventOptions {
  type?: "conversation.item.create";
  previousItemId?: string | null;
  item: ConversationItem;
}

/**
 * Event to create a new conversation item.
 *
 * - `type`: event type, always "conversation.item.create".
 * - `previousItemId`: ID of the item to insert after, if any.
 * - `item`: the conversation item to create.
 */
export class ConversationItemCreateEvent extends ClientEvent {
  static override _nested: Record<string, Resolver> = { item: model(ConversationItem) };

  type = "conversation.item.create" as const;
  previousItemId: string | null;
  item: ConversationItem;

  constructor(options: ConversationItemCreateEventOptions) {
    super(options);
    this.previousItemId = options.previousItemId ?? null;
    this.item = required(options, "item", "ConversationItemCreateEvent");
  }
}

export interface ResponseCreateEventOptions extends ClientEventOptions {
  type?: "response.create";
  response?: ResponseProperties | null;
}

/**
 * Event to create a new assistant response.
 *
 * - `type`: event type, always "response.create".
 * - `response`: optional response configuration properties.
 */
export class ResponseCreateEvent extends ClientEvent {
  static override _nested: Record<string, Resolver> = { response: model(ResponseProperties) };

  type = "response.create" as const;
  response: ResponseProperties | null;

  constructor(options: ResponseCreateEventOptions = {}) {
    super(options);
    this.response = options.response ?? null;
  }
}

export interface ResponseCancelEventOptions extends ClientEventOptions {
  type?: "response.cancel";
}

/**
 * Event to cancel the current assistant response.
 *
 * - `type`: event type, always "response.cancel".
 */
export class ResponseCancelEvent extends ClientEvent {
  type = "response.cancel" as const;

  constructor(options: ResponseCancelEventOptions = {}) {
    super(options);
  }
}

export interface ConversationItemTruncateEventOptions extends ClientEventOptions {
  type?: "conversation.item.truncate";
  itemId: string;
  contentIndex: number;
  audioEndMs: number;
}

/**
 * Event to truncate a previous assistant audio item.
 *
 * - `type`: event type, always "conversation.item.truncate".
 * - `itemId`: ID of the item to truncate.
 * - `contentIndex`: index of the content to truncate within the item.
 * - `audioEndMs`: end time in milliseconds for the truncated audio.
 */
export class ConversationItemTruncateEvent extends ClientEvent {
  type = "conversation.item.truncate" as const;
  itemId: string;
  contentIndex: number;
  audioEndMs: number;

  constructor(options: ConversationItemTruncateEventOptions) {
    super(options);
    const name = "ConversationItemTruncateEvent";
    this.itemId = required(options, "itemId", name);
    this.contentIndex = required(options, "contentIndex", name);
    this.audioEndMs = required(options, "audioEndMs", name);
  }
}

export interface ConversationItemDeleteEventOptions extends ClientEventOptions {
  type?: "conversation.item.delete";
  itemId: string;
}

/**
 * Event to delete a conversation item by ID.
 *
 * - `type`: event type, always "conversation.item.delete".
 * - `itemId`: ID of the item to delete.
 */
export class ConversationItemDeleteEvent extends ClientEvent {
  type = "conversation.item.delete" as const;
  itemId: string;

  constructor(options: ConversationItemDeleteEventOptions) {
    super(options);
    this.itemId = required(options, "itemId", "ConversationItemDeleteEvent");
  }
}

//
// Server Events (received from Grok)
//

export interface ServerEventOptions {
  eventId: string;
  type: string;
}

/**
 * Base class for server events received from the realtime API.
 *
 * - `eventId`: unique identifier for the event.
 * - `type`: type of the server event.
 */
export class ServerEvent extends BaseModel {
  eventId: string;
  type: string;

  constructor(options: ServerEventOptions) {
    super();
    this.eventId = required(options, "eventId", new.target.name);
    this.type = required(options, "type", new.target.name);
  }
}

export interface SessionCreatedEventOptions extends ServerEventOptions {
  type: "session.created";
  session: SessionProperties;
}

/**
 * Event indicating a session has been created on connect.
 *
 * - `type`: event type, always "session.created".
 * - `session`: the created session properties.
 */
export class SessionCreatedEvent extends ServerEvent {
  static override _nested: Record<string, Resolver> = { session: model(SessionProperties) };

  declare type: "session.created";
  session: SessionProperties;

  constructor(options: SessionCreatedEventOptions) {
    super(options);
    this.type = literal(options.type, "session.created", "SessionCreatedEvent");
    this.session = required(options, "session", "SessionCreatedEvent");
  }
}

export interface SessionUpdatedEventOptions extends ServerEventOptions {
  type: "session.updated";
  session: SessionProperties;
}

/**
 * Event indicating a session has been updated.
 *
 * - `type`: event type, always "session.updated".
 * - `session`: the updated session properties.
 */
export class SessionUpdatedEvent extends ServerEvent {
  static override _nested: Record<string, Resolver> = { session: model(SessionProperties) };

  declare type: "session.updated";
  session: SessionProperties;

  constructor(options: SessionUpdatedEventOptions) {
    super(options);
    this.type = literal(options.type, "session.updated", "SessionUpdatedEvent");
    this.session = required(options, "session", "SessionUpdatedEvent");
  }
}

export interface ConversationCreatedOptions extends ServerEventOptions {
  type: "conversation.created";
  conversation: RealtimeConversation;
}

/**
 * Event indicating a conversation has been created.
 *
 * Sent after connect; Pipecat uses this to send the initial session update.
 *
 * - `type`: event type, always "conversation.created".
 * - `conversation`: the created conversation.
 */
export class ConversationCreated extends ServerEvent {
  static override _nested: Record<string, Resolver> = {
    conversation: model(RealtimeConversation),
  };

  declare type: "conversation.created";
  conversation: RealtimeConversation;

  constructor(options: ConversationCreatedOptions) {
    super(options);
    this.type = literal(options.type, "conversation.created", "ConversationCreated");
    this.conversation = required(options, "conversation", "ConversationCreated");
  }
}

export interface ConversationItemAddedOptions extends ServerEventOptions {
  type: "conversation.item.added";
  previousItemId?: string | null;
  item: ConversationItem;
}

/**
 * Event indicating a conversation item has been added.
 *
 * - `type`: event type, always "conversation.item.added".
 * - `previousItemId`: ID of the previous item, if any.
 * - `item`: the added conversation item.
 */
export class ConversationItemAdded extends ServerEvent {
  static override _nested: Record<string, Resolver> = { item: model(ConversationItem) };

  declare type: "conversation.item.added";
  previousItemId: string | null;
  item: ConversationItem;

  constructor(options: ConversationItemAddedOptions) {
    super(options);
    this.type = literal(options.type, "conversation.item.added", "ConversationItemAdded");
    this.previousItemId = options.previousItemId ?? null;
    this.item = required(options, "item", "ConversationItemAdded");
  }
}

export interface ConversationItemDeletedOptions extends ServerEventOptions {
  type: "conversation.item.deleted";
  itemId: string;
}

/**
 * Event confirming a conversation item was deleted.
 *
 * - `type`: event type, always "conversation.item.deleted".
 * - `itemId`: ID of the deleted conversation item.
 */
export class ConversationItemDeleted extends ServerEvent {
  declare type: "conversation.item.deleted";
  itemId: string;

  constructor(options: ConversationItemDeletedOptions) {
    super(options);
    const name = "ConversationItemDeleted";
    this.type = literal(options.type, "conversation.item.deleted", name);
    this.itemId = required(options, "itemId", name);
  }
}

export interface ConversationItemTruncatedOptions extends ServerEventOptions {
  type: "conversation.item.truncated";
  itemId: string;
  contentIndex?: number | null;
  audioEndMs?: number | null;
}

/**
 * Event confirming a conversation item was truncated.
 *
 * - `type`: event type, always "conversation.item.truncated".
 * - `itemId`: ID of the truncated conversation item.
 * - `contentIndex`: index of the content within the item.
 * - `audioEndMs`: end time in milliseconds for the truncated audio.
 */
export class ConversationItemTruncated extends ServerEvent {
  declare type: "conversation.item.truncated";
  itemId: string;
  contentIndex: number | null;
  audioEndMs: number | null;

  constructor(options: ConversationItemTruncatedOptions) {
    super(options);
    const name = "ConversationItemTruncated";
    this.type = literal(options.type, "conversation.item.truncated", name);
    this.itemId = required(options, "itemId", name);
    this.contentIndex = options.contentIndex ?? null;
    this.audioEndMs = options.audioEndMs ?? null;
  }
}

export interface ConversationItemInputAudioTranscriptionUpdatedOptions extends ServerEventOptions {
  type: "conversation.item.input_audio_transcription.updated";
  itemId: string;
  contentIndex?: number | null;
  transcript: string;
}

/**
 * Cumulative streaming update for user input audio transcription.
 *
 * Emitted when `audio.input.transcription.model` is `grok-transcribe`.
 * Unlike a delta, `transcript` is the full cumulative text so far and may
 * correct earlier updates.
 *
 * - `type`: event type, always
 *   "conversation.item.input_audio_transcription.updated".
 * - `itemId`: ID of the conversation item being transcribed.
 * - `contentIndex`: index of the content within the item, if provided.
 * - `transcript`: cumulative transcription text so far.
 */
export class ConversationItemInputAudioTranscriptionUpdated extends ServerEvent {
  declare type: "conversation.item.input_audio_transcription.updated";
  itemId: string;
  contentIndex: number | null;
  transcript: string;

  constructor(options: ConversationItemInputAudioTranscriptionUpdatedOptions) {
    super(options);
    const name = "ConversationItemInputAudioTranscriptionUpdated";
    this.type = literal(options.type, "conversation.item.input_audio_transcription.updated", name);
    this.itemId = required(options, "itemId", name);
    this.contentIndex = options.contentIndex ?? null;
    this.transcript = required(options, "transcript", name);
  }
}

export interface ConversationItemInputAudioTranscriptionCompletedOptions
  extends ServerEventOptions {
  type: "conversation.item.input_audio_transcription.completed";
  itemId: string;
  contentIndex?: number | null;
  transcript: string;
}

/**
 * Event indicating input audio transcription is complete.
 *
 * - `type`: event type, always
 *   "conversation.item.input_audio_transcription.completed".
 * - `itemId`: ID of the conversation item that was transcribed.
 * - `contentIndex`: index of the content within the item, if provided.
 * - `transcript`: complete transcription text.
 */
export class ConversationItemInputAudioTranscriptionCompleted extends ServerEvent {
  declare type: "conversation.item.input_audio_transcription.completed";
  itemId: string;
  contentIndex: number | null;
  transcript: string;

  constructor(options: ConversationItemInputAudioTranscriptionCompletedOptions) {
    super(options);
    const name = "ConversationItemInputAudioTranscriptionCompleted";
    this.type = literal(
      options.type,
      "conversation.item.input_audio_transcription.completed",
      name,
    );
    this.itemId = required(options, "itemId", name);
    this.contentIndex = options.contentIndex ?? null;
    this.transcript = required(options, "transcript", name);
  }
}

export interface InputAudioBufferSpeechStartedOptions extends ServerEventOptions {
  type: "input_audio_buffer.speech_started";
  itemId: string;
}

/**
 * Event indicating speech has started in the input audio buffer.
 *
 * Only sent when turn_detection is "server_vad".
 *
 * - `type`: event type, always "input_audio_buffer.speech_started".
 * - `itemId`: ID of the associated conversation item.
 */
export class InputAudioBufferSpeechStarted extends ServerEvent {
  declare type: "input_audio_buffer.speech_started";
  itemId: string;

  constructor(options: InputAudioBufferSpeechStartedOptions) {
    super(options);
    const name = "InputAudioBufferSpeechStarted";
    this.type = literal(options.type, "input_audio_buffer.speech_started", name);
    this.itemId = required(options, "itemId", name);
  }
}

export interface InputAudioBufferSpeechStoppedOptions extends ServerEventOptions {
  type: "input_audio_buffer.speech_stopped";
  itemId: string;
}

/**
 * Event indicating speech has stopped in the input audio buffer.
 *
 * Only sent when turn_detection is "server_vad".
 *
 * - `type`: event type, always "input_audio_buffer.speech_stopped".
 * - `itemId`: ID of the associated conversation item.
 */
export class InputAudioBufferSpeechStopped extends ServerEvent {
  declare type: "input_audio_buffer.speech_stopped";
  itemId: string;

  constructor(options: InputAudioBufferSpeechStoppedOptions) {
    super(options);
    const name = "InputAudioBufferSpeechStopped";
    this.type = literal(options.type, "input_audio_buffer.speech_stopped", name);
    this.itemId = required(options, "itemId", name);
  }
}

export interface InputAudioBufferCommittedOptions extends ServerEventOptions {
  type: "input_audio_buffer.committed";
  previousItemId?: string | null;
  itemId: string;
}

/**
 * Event indicating the input audio buffer has been committed.
 *
 * - `type`: event type, always "input_audio_buffer.committed".
 * - `previousItemId`: ID of the previous item, if any.
 * - `itemId`: ID of the committed conversation item.
 */
export class InputAudioBufferCommitted extends ServerEvent {
  declare type: "input_audio_buffer.committed";
  previousItemId: string | null;
  itemId: string;

  constructor(options: InputAudioBufferCommittedOptions) {
    super(options);
    const name = "InputAudioBufferCommitted";
    this.type = literal(options.type, "input_audio_buffer.committed", name);
    this.previousItemId = options.previousItemId ?? null;
    this.itemId = required(options, "itemId", name);
  }
}

export interface InputAudioBufferClearedOptions extends ServerEventOptions {
  type: "input_audio_buffer.cleared";
}

/**
 * Event indicating the input audio buffer has been cleared.
 *
 * - `type`: event type, always "input_audio_buffer.cleared".
 */
export class InputAudioBufferCleared extends ServerEvent {
  declare type: "input_audio_buffer.cleared";

  constructor(options: InputAudioBufferClearedOptions) {
    super(options);
    this.type = literal(options.type, "input_audio_buffer.cleared", "InputAudioBufferCleared");
  }
}

export interface InputAudioBufferTimeoutTriggeredOptions extends ServerEventOptions {
  type: "input_audio_buffer.timeout_triggered";
  itemId?: string | null;
}

/**
 * Event indicating the idle timeout fired with no user speech.
 *
 * When `turn_detection.idle_timeout_ms` is set, the server commits a silent
 * user turn and generates a proactive check-in.
 *
 * - `type`: event type, always "input_audio_buffer.timeout_triggered".
 * - `itemId`: ID of the associated conversation item, if provided.
 */
export class InputAudioBufferTimeoutTriggered extends ServerEvent {
  declare type: "input_audio_buffer.timeout_triggered";
  itemId: string | null;

  constructor(options: InputAudioBufferTimeoutTriggeredOptions) {
    super(options);
    const name = "InputAudioBufferTimeoutTriggered";
    this.type = literal(options.type, "input_audio_buffer.timeout_triggered", name);
    this.itemId = options.itemId ?? null;
  }
}

export interface InputAudioBufferDtmfEventReceivedOptions extends ServerEventOptions {
  type: "input_audio_buffer.dtmf_event_received";
  digit?: string | null;
}

/**
 * DTMF tone detected on a SIP session.
 *
 * - `type`: event type, always "input_audio_buffer.dtmf_event_received".
 * - `digit`: the DTMF digit received.
 */
export class InputAudioBufferDtmfEventReceived extends ServerEvent {
  static override _extraAllowed = true;

  declare type: "input_audio_buffer.dtmf_event_received";
  digit: string | null;

  constructor(options: InputAudioBufferDtmfEventReceivedOptions) {
    super(options);
    const name = "InputAudioBufferDtmfEventReceived";
    this.type = literal(options.type, "input_audio_buffer.dtmf_event_received", name);
    this.digit = options.digit ?? null;
  }
}

export interface ResponseCreatedOptions extends ServerEventOptions {
  type: "response.created";
  response: Response;
}

/**
 * Event indicating an assistant response has been created.
 *
 * - `type`: event type, always "response.created".
 * - `response`: the created response object.
 */
export class ResponseCreated extends ServerEvent {
  // `Response` is declared below; resolved lazily, like upstream's forward reference.
  static override _nested: Record<string, Resolver> = {
    response: (value) => (value === null ? null : Response.modelValidate(value)),
  };

  declare type: "response.created";
  response: Response;

  constructor(options: ResponseCreatedOptions) {
    super(options);
    this.type = literal(options.type, "response.created", "ResponseCreated");
    this.response = required(options, "response", "ResponseCreated");
  }
}

export interface ResponseOutputItemAddedOptions extends ServerEventOptions {
  type: "response.output_item.added";
  responseId: string;
  outputIndex: number;
  item: ConversationItem;
}

/**
 * Event indicating an output item has been added to a response.
 *
 * - `type`: event type, always "response.output_item.added".
 * - `responseId`: ID of the response.
 * - `outputIndex`: index of the output item.
 * - `item`: the added conversation item.
 */
export class ResponseOutputItemAdded extends ServerEvent {
  static override _nested: Record<string, Resolver> = { item: model(ConversationItem) };

  declare type: "response.output_item.added";
  responseId: string;
  outputIndex: number;
  item: ConversationItem;

  constructor(options: ResponseOutputItemAddedOptions) {
    super(options);
    const name = "ResponseOutputItemAdded";
    this.type = literal(options.type, "response.output_item.added", name);
    this.responseId = required(options, "responseId", name);
    this.outputIndex = required(options, "outputIndex", name);
    this.item = required(options, "item", name);
  }
}

export interface ResponseAudioTranscriptDeltaOptions extends ServerEventOptions {
  type: "response.output_audio_transcript.delta";
  responseId: string;
  itemId: string;
  delta: string;
}

/**
 * Event containing incremental audio transcript from a response.
 *
 * - `type`: event type, always "response.output_audio_transcript.delta".
 * - `responseId`: ID of the response.
 * - `itemId`: ID of the conversation item.
 * - `delta`: incremental transcript text.
 */
export class ResponseAudioTranscriptDelta extends ServerEvent {
  declare type: "response.output_audio_transcript.delta";
  responseId: string;
  itemId: string;
  delta: string;

  constructor(options: ResponseAudioTranscriptDeltaOptions) {
    super(options);
    const name = "ResponseAudioTranscriptDelta";
    this.type = literal(options.type, "response.output_audio_transcript.delta", name);
    this.responseId = required(options, "responseId", name);
    this.itemId = required(options, "itemId", name);
    this.delta = required(options, "delta", name);
  }
}

export interface ResponseAudioTranscriptDoneOptions extends ServerEventOptions {
  type: "response.output_audio_transcript.done";
  responseId: string;
  itemId: string;
}

/**
 * Event indicating audio transcript is complete.
 *
 * - `type`: event type, always "response.output_audio_transcript.done".
 * - `responseId`: ID of the response.
 * - `itemId`: ID of the conversation item.
 */
export class ResponseAudioTranscriptDone extends ServerEvent {
  declare type: "response.output_audio_transcript.done";
  responseId: string;
  itemId: string;

  constructor(options: ResponseAudioTranscriptDoneOptions) {
    super(options);
    const name = "ResponseAudioTranscriptDone";
    this.type = literal(options.type, "response.output_audio_transcript.done", name);
    this.responseId = required(options, "responseId", name);
    this.itemId = required(options, "itemId", name);
  }
}

export interface ResponseAudioDeltaOptions extends ServerEventOptions {
  type: "response.output_audio.delta";
  responseId: string;
  itemId: string;
  outputIndex: number;
  contentIndex: number;
  delta: string;
}

/**
 * Event containing incremental audio data from a response.
 *
 * - `type`: event type, always "response.output_audio.delta".
 * - `responseId`: ID of the response.
 * - `itemId`: ID of the conversation item.
 * - `outputIndex`: index of the output item.
 * - `contentIndex`: index of the content part.
 * - `delta`: base64-encoded incremental audio data.
 */
export class ResponseAudioDelta extends ServerEvent {
  declare type: "response.output_audio.delta";
  responseId: string;
  itemId: string;
  outputIndex: number;
  contentIndex: number;
  delta: string; // base64-encoded audio

  constructor(options: ResponseAudioDeltaOptions) {
    super(options);
    const name = "ResponseAudioDelta";
    this.type = literal(options.type, "response.output_audio.delta", name);
    this.responseId = required(options, "responseId", name);
    this.itemId = required(options, "itemId", name);
    this.outputIndex = required(options, "outputIndex", name);
    this.contentIndex = required(options, "contentIndex", name);
    this.delta = required(options, "delta", name);
  }
}

export interface ResponseAudioDoneOptions extends ServerEventOptions {
  type: "response.output_audio.done";
  responseId: string;
  itemId: string;
}

/**
 * Event indicating audio content is complete.
 *
 * - `type`: event type, always "response.output_audio.done".
 * - `responseId`: ID of the response.
 * - `itemId`: ID of the conversation item.
 */
export class ResponseAudioDone extends ServerEvent {
  declare type: "response.output_audio.done";
  responseId: string;
  itemId: string;

  constructor(options: ResponseAudioDoneOptions) {
    super(options);
    const name = "ResponseAudioDone";
    this.type = literal(options.type, "response.output_audio.done", name);
    this.responseId = required(options, "responseId", name);
    this.itemId = required(options, "itemId", name);
  }
}

export interface ResponseFunctionCallArgumentsDeltaOptions extends ServerEventOptions {
  type: "response.function_call_arguments.delta";
  responseId?: string | null;
  itemId?: string | null;
  callId: string;
  delta: string;
  previousItemId?: string | null;
}

/**
 * Event containing incremental function call arguments.
 *
 * - `type`: event type, always "response.function_call_arguments.delta".
 * - `responseId`: ID of the response.
 * - `itemId`: ID of the conversation item.
 * - `callId`: ID of the function call.
 * - `delta`: incremental function arguments as JSON.
 * - `previousItemId`: ID of the previous item, if any.
 */
export class ResponseFunctionCallArgumentsDelta extends ServerEvent {
  declare type: "response.function_call_arguments.delta";
  responseId: string | null;
  itemId: string | null;
  callId: string;
  delta: string;
  previousItemId: string | null;

  constructor(options: ResponseFunctionCallArgumentsDeltaOptions) {
    super(options);
    const name = "ResponseFunctionCallArgumentsDelta";
    this.type = literal(options.type, "response.function_call_arguments.delta", name);
    this.responseId = options.responseId ?? null;
    this.itemId = options.itemId ?? null;
    this.callId = required(options, "callId", name);
    this.delta = required(options, "delta", name);
    this.previousItemId = options.previousItemId ?? null;
  }
}

export interface ResponseFunctionCallArgumentsDoneOptions extends ServerEventOptions {
  type: "response.function_call_arguments.done";
  callId: string;
  name: string;
  arguments: string;
}

/**
 * Event indicating function call arguments are complete.
 *
 * - `type`: event type, always "response.function_call_arguments.done".
 * - `callId`: ID of the function call.
 * - `name`: name of the function being called.
 * - `arguments`: complete function arguments as JSON string.
 */
export class ResponseFunctionCallArgumentsDone extends ServerEvent {
  declare type: "response.function_call_arguments.done";
  callId: string;
  name: string;
  arguments: string;

  constructor(options: ResponseFunctionCallArgumentsDoneOptions) {
    super(options);
    const model = "ResponseFunctionCallArgumentsDone";
    this.type = literal(options.type, "response.function_call_arguments.done", model);
    this.callId = required(options, "callId", model);
    this.name = required(options, "name", model);
    this.arguments = required(options, "arguments", model);
  }
}

export interface UsageOptions {
  totalTokens?: number | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
}

/**
 * Token usage statistics for a response.
 *
 * All fields are optional because Grok sends empty usage in some events.
 *
 * - `totalTokens`: total number of tokens used.
 * - `inputTokens`: number of input tokens used.
 * - `outputTokens`: number of output tokens used.
 */
export class Usage extends BaseModel {
  totalTokens: number | null;
  inputTokens: number | null;
  outputTokens: number | null;

  constructor(options: UsageOptions = {}) {
    super();
    this.totalTokens = options.totalTokens ?? null;
    this.inputTokens = options.inputTokens ?? null;
    this.outputTokens = options.outputTokens ?? null;
  }
}

export type ResponseStatus = "completed" | "in_progress" | "incomplete" | "cancelled" | "failed";

export interface ResponseOptions {
  id: string;
  object: "realtime.response";
  status: ResponseStatus;
  statusDetails?: any;
  output: ConversationItem[];
  usage?: Usage | null;
}

/**
 * A complete assistant response.
 *
 * - `id`: unique identifier for the response.
 * - `object`: object type, always "realtime.response".
 * - `status`: current status of the response.
 * - `statusDetails`: additional status information.
 * - `output`: list of conversation items in the response.
 * - `usage`: token usage statistics for the response.
 */
export class Response extends BaseModel {
  static override _nested: Record<string, Resolver> = {
    output: listOf(model(ConversationItem)),
    usage: model(Usage),
  };

  id: string;
  object: "realtime.response";
  status: ResponseStatus;
  statusDetails: any;
  output: ConversationItem[];
  usage: Usage | null;

  constructor(options: ResponseOptions) {
    super();
    this.id = required(options, "id", "Response");
    this.object = required(options, "object", "Response");
    this.status = required(options, "status", "Response");
    this.statusDetails = options.statusDetails ?? null;
    this.output = required(options, "output", "Response");
    this.usage = options.usage ?? null;
  }
}

export interface ResponseDoneOptions extends ServerEventOptions {
  type: "response.done";
  response: Response;
  usage?: Usage | null;
}

/**
 * Event indicating an assistant response is complete.
 *
 * - `type`: event type, always "response.done".
 * - `response`: the completed response object.
 * - `usage`: token usage (also available at top level in Grok).
 */
export class ResponseDone extends ServerEvent {
  static override _nested: Record<string, Resolver> = {
    response: model(Response),
    usage: model(Usage),
  };

  declare type: "response.done";
  response: Response;
  usage: Usage | null;

  constructor(options: ResponseDoneOptions) {
    super(options);
    this.type = literal(options.type, "response.done", "ResponseDone");
    this.response = required(options, "response", "ResponseDone");
    this.usage = options.usage ?? null;
  }
}

export interface ResponseOutputItemDoneOptions extends ServerEventOptions {
  type: "response.output_item.done";
  responseId: string;
  outputIndex: number;
  item: ConversationItem;
}

/**
 * Event indicating an output item is complete.
 *
 * - `type`: event type, always "response.output_item.done".
 * - `responseId`: ID of the response.
 * - `outputIndex`: index of the output item.
 * - `item`: the completed conversation item.
 */
export class ResponseOutputItemDone extends ServerEvent {
  static override _nested: Record<string, Resolver> = { item: model(ConversationItem) };

  declare type: "response.output_item.done";
  responseId: string;
  outputIndex: number;
  item: ConversationItem;

  constructor(options: ResponseOutputItemDoneOptions) {
    super(options);
    const name = "ResponseOutputItemDone";
    this.type = literal(options.type, "response.output_item.done", name);
    this.responseId = required(options, "responseId", name);
    this.outputIndex = required(options, "outputIndex", name);
    this.item = required(options, "item", name);
  }
}

export interface ContentPartOptions {
  type: string;
  transcript?: string | null;
}

/**
 * A content part within a response.
 *
 * - `type`: type of the content part (audio, text).
 * - `transcript`: transcript text if applicable.
 */
export class ContentPart extends BaseModel {
  type: string;
  transcript: string | null;

  constructor(options: ContentPartOptions) {
    super();
    this.type = required(options, "type", "ContentPart");
    this.transcript = options.transcript ?? null;
  }
}

export interface ResponseContentPartAddedOptions extends ServerEventOptions {
  type: "response.content_part.added";
  responseId: string;
  itemId: string;
  contentIndex: number;
  outputIndex: number;
  part: ContentPart;
}

/**
 * Event indicating a content part has been added to a response.
 *
 * - `type`: event type, always "response.content_part.added".
 * - `responseId`: ID of the response.
 * - `itemId`: ID of the conversation item.
 * - `contentIndex`: index of the content part.
 * - `outputIndex`: index of the output item.
 * - `part`: the added content part.
 */
export class ResponseContentPartAdded extends ServerEvent {
  static override _nested: Record<string, Resolver> = { part: model(ContentPart) };

  declare type: "response.content_part.added";
  responseId: string;
  itemId: string;
  contentIndex: number;
  outputIndex: number;
  part: ContentPart;

  constructor(options: ResponseContentPartAddedOptions) {
    super(options);
    const name = "ResponseContentPartAdded";
    this.type = literal(options.type, "response.content_part.added", name);
    this.responseId = required(options, "responseId", name);
    this.itemId = required(options, "itemId", name);
    this.contentIndex = required(options, "contentIndex", name);
    this.outputIndex = required(options, "outputIndex", name);
    this.part = required(options, "part", name);
  }
}

export interface ResponseContentPartDoneOptions extends ServerEventOptions {
  type: "response.content_part.done";
  responseId: string;
  itemId: string;
  contentIndex: number;
  outputIndex: number;
}

/**
 * Event indicating a content part is complete.
 *
 * - `type`: event type, always "response.content_part.done".
 * - `responseId`: ID of the response.
 * - `itemId`: ID of the conversation item.
 * - `contentIndex`: index of the content part.
 * - `outputIndex`: index of the output item.
 */
export class ResponseContentPartDone extends ServerEvent {
  declare type: "response.content_part.done";
  responseId: string;
  itemId: string;
  contentIndex: number;
  outputIndex: number;

  constructor(options: ResponseContentPartDoneOptions) {
    super(options);
    const name = "ResponseContentPartDone";
    this.type = literal(options.type, "response.content_part.done", name);
    this.responseId = required(options, "responseId", name);
    this.itemId = required(options, "itemId", name);
    this.contentIndex = required(options, "contentIndex", name);
    this.outputIndex = required(options, "outputIndex", name);
  }
}

export interface PingEventOptions extends ServerEventOptions {
  type: "ping";
  timestamp: number;
}

/**
 * Keep-alive ping event from the server.
 *
 * - `type`: event type, always "ping".
 * - `timestamp`: server timestamp in milliseconds.
 */
export class PingEvent extends ServerEvent {
  declare type: "ping";
  timestamp: number;

  constructor(options: PingEventOptions) {
    super(options);
    this.type = literal(options.type, "ping", "PingEvent");
    this.timestamp = required(options, "timestamp", "PingEvent");
  }
}

export interface ErrorEventOptions extends ServerEventOptions {
  type: "error";
  error: RealtimeError;
}

/**
 * Event indicating an error occurred.
 *
 * - `type`: event type, always "error".
 * - `error`: error details.
 */
export class ErrorEvent extends ServerEvent {
  static override _nested: Record<string, Resolver> = { error: model(RealtimeError) };

  declare type: "error";
  error: RealtimeError;

  constructor(options: ErrorEventOptions) {
    super(options);
    this.type = literal(options.type, "error", "ErrorEvent");
    this.error = required(options, "error", "ErrorEvent");
  }
}

export interface ResponseTextDeltaOptions extends ServerEventOptions {
  type: "response.output_text.delta" | "response.text.delta";
  responseId?: string | null;
  itemId?: string | null;
  outputIndex?: number | null;
  contentIndex?: number | null;
  delta: string;
}

/**
 * Event containing incremental text-mode output from a response.
 *
 * xAI emits both `response.text.delta` and `response.output_text.delta` with
 * the same payload; clients should accept either name.
 *
 * - `type`: `response.output_text.delta` or `response.text.delta`.
 * - `responseId`: ID of the response.
 * - `itemId`: ID of the conversation item.
 * - `outputIndex`: index of the output item.
 * - `contentIndex`: index of the content part.
 * - `delta`: incremental text content.
 */
export class ResponseTextDelta extends ServerEvent {
  declare type: "response.output_text.delta" | "response.text.delta";
  responseId: string | null;
  itemId: string | null;
  outputIndex: number | null;
  contentIndex: number | null;
  delta: string;

  constructor(options: ResponseTextDeltaOptions) {
    super(options);
    const name = "ResponseTextDelta";
    this.type = oneOf(options.type, ["response.output_text.delta", "response.text.delta"], name);
    this.responseId = options.responseId ?? null;
    this.itemId = options.itemId ?? null;
    this.outputIndex = options.outputIndex ?? null;
    this.contentIndex = options.contentIndex ?? null;
    this.delta = required(options, "delta", name);
  }
}

export type McpListToolsEventType =
  | "mcp_list_tools.in_progress"
  | "mcp_list_tools.completed"
  | "mcp_list_tools.failed";

/**
 * MCP tool discovery lifecycle event.
 *
 * - `type`: one of `mcp_list_tools.in_progress`, `.completed`, or `.failed`.
 *   Other keys are kept as extra fields.
 */
export class McpListToolsEvent extends ServerEvent {
  static override _extraAllowed = true;

  declare type: McpListToolsEventType;

  constructor(options: ServerEventOptions) {
    super(options);
    this.type = oneOf(
      options.type,
      ["mcp_list_tools.in_progress", "mcp_list_tools.completed", "mcp_list_tools.failed"],
      "McpListToolsEvent",
    );
  }
}

export type ResponseMcpCallEventType =
  | "response.mcp_call_arguments.delta"
  | "response.mcp_call_arguments.done"
  | "response.mcp_call.in_progress"
  | "response.mcp_call.completed"
  | "response.mcp_call.failed";

/**
 * MCP tool call lifecycle or argument streaming event.
 *
 * - `type`: an MCP call event name under `response.mcp_call*`. Other keys
 *   are kept as extra fields.
 */
export class ResponseMcpCallEvent extends ServerEvent {
  static override _extraAllowed = true;

  declare type: ResponseMcpCallEventType;

  constructor(options: ServerEventOptions) {
    super(options);
    this.type = oneOf(
      options.type,
      [
        "response.mcp_call_arguments.delta",
        "response.mcp_call_arguments.done",
        "response.mcp_call.in_progress",
        "response.mcp_call.completed",
        "response.mcp_call.failed",
      ],
      "ResponseMcpCallEvent",
    );
  }
}

//
// Event parsing
//

/** A server event class `parseServerEvent` can build. */
type ServerEventClass = { modelValidate(data: unknown): ServerEvent };

const _serverEventTypes: Record<string, ServerEventClass> = {
  error: ErrorEvent,
  ping: PingEvent,
  "session.created": SessionCreatedEvent,
  "session.updated": SessionUpdatedEvent,
  "conversation.created": ConversationCreated,
  "conversation.item.added": ConversationItemAdded,
  "conversation.item.deleted": ConversationItemDeleted,
  "conversation.item.truncated": ConversationItemTruncated,
  "conversation.item.input_audio_transcription.updated":
    ConversationItemInputAudioTranscriptionUpdated,
  "conversation.item.input_audio_transcription.completed":
    ConversationItemInputAudioTranscriptionCompleted,
  "input_audio_buffer.speech_started": InputAudioBufferSpeechStarted,
  "input_audio_buffer.speech_stopped": InputAudioBufferSpeechStopped,
  "input_audio_buffer.committed": InputAudioBufferCommitted,
  "input_audio_buffer.cleared": InputAudioBufferCleared,
  "input_audio_buffer.timeout_triggered": InputAudioBufferTimeoutTriggered,
  "input_audio_buffer.dtmf_event_received": InputAudioBufferDtmfEventReceived,
  "response.created": ResponseCreated,
  "response.output_item.added": ResponseOutputItemAdded,
  "response.output_item.done": ResponseOutputItemDone,
  "response.content_part.added": ResponseContentPartAdded,
  "response.content_part.done": ResponseContentPartDone,
  "response.output_audio_transcript.delta": ResponseAudioTranscriptDelta,
  "response.output_audio_transcript.done": ResponseAudioTranscriptDone,
  "response.output_audio.delta": ResponseAudioDelta,
  "response.output_audio.done": ResponseAudioDone,
  "response.output_text.delta": ResponseTextDelta,
  "response.text.delta": ResponseTextDelta,
  "response.function_call_arguments.delta": ResponseFunctionCallArgumentsDelta,
  "response.function_call_arguments.done": ResponseFunctionCallArgumentsDone,
  "mcp_list_tools.in_progress": McpListToolsEvent,
  "mcp_list_tools.completed": McpListToolsEvent,
  "mcp_list_tools.failed": McpListToolsEvent,
  "response.mcp_call_arguments.delta": ResponseMcpCallEvent,
  "response.mcp_call_arguments.done": ResponseMcpCallEvent,
  "response.mcp_call.in_progress": ResponseMcpCallEvent,
  "response.mcp_call.completed": ResponseMcpCallEvent,
  "response.mcp_call.failed": ResponseMcpCallEvent,
  "response.done": ResponseDone,
};

/**
 * Parse a server event from JSON.
 *
 * @param data JSON text (or UTF-8 bytes) containing the server event, as
 *   delivered by the websocket.
 * @returns Parsed server event object of the appropriate type.
 * @throws Error If the event type is unimplemented or parsing fails.
 */
export function parseServerEvent(data: string | Uint8Array): ServerEvent {
  const text = typeof data === "string" ? data : new TextDecoder().decode(data);
  try {
    const event = pyJsonLoads(text);
    if (!isPlainObject(event) || !("type" in event)) {
      // Python's KeyError for the missing key.
      throw new Error("'type'");
    }
    const eventType = event.type as string;
    if (typeof eventType !== "string" || !Object.hasOwn(_serverEventTypes, eventType)) {
      throw new Error(`Unimplemented server event type: ${eventType}`);
    }
    return (_serverEventTypes[eventType] as ServerEventClass).modelValidate(event);
  } catch (e) {
    rethrowIfCancelled(e);
    throw new Error(`${e instanceof Error ? e.message : String(e)} \n\n${text}`);
  }
}
