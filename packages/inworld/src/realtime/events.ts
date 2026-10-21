// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/services/inworld/realtime/events.py

/**
 * Event models and data structures for Inworld Realtime API communication.
 *
 * Based on Inworld's Realtime API documentation:
 * https://docs.inworld.ai/api-reference/realtimeAPI/realtime/realtime-websocket
 *
 * Porting notes:
 * - Upstream models are pydantic `BaseModel`s. Here each model extends the
 *   small `BaseModel` below (the same machinery as `@pipedog/openai`'s
 *   realtime events): fields are camelCase and the constructor takes one
 *   options object, while `modelValidate()` reads and `modelDump()` /
 *   `toJSON()` write the upstream snake_case wire keys, so the wire format is
 *   unchanged. `SessionProperties.providerData` is dumped as `providerData`
 *   with `byAlias` (pydantic's `Field(alias="providerData")`).
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
export type Modality = "text" | "audio";

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
  /** Write aliased fields under their alias (pydantic's `by_alias`). */
  byAlias?: boolean;
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

/** A resolver building a model from wire data (or keeping an instance). */
function model(cls: { modelValidate(data: unknown): unknown }): Resolver {
  return (value) => (value === null ? null : cls.modelValidate(value));
}

/** A resolver building a list of models from wire data. */
function listOf(resolve: Resolver): Resolver {
  return (value) => (Array.isArray(value) ? value.map(resolve) : value);
}

/**
 * Base of the models in this module (pydantic's `BaseModel`).
 *
 * Fields are the instance's own properties, in declaration order (base class
 * fields first, as pydantic orders them).
 */
export class BaseModel {
  /** Fields holding nested models, by field name: how to build each from wire data. */
  static _nested: Record<string, Resolver> = {};
  /** Wire aliases, by field name (pydantic's `Field(alias=...)`). */
  static _aliases: Record<string, string> = {};

  /**
   * Validate wire data (snake_case keys, or a field's alias) into a model
   * (pydantic's `model_validate`). An instance of the model is returned as is.
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
    const byAlias = new Map(Object.entries(cls._aliases).map(([field, alias]) => [alias, field]));
    const options: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data)) {
      const name = byAlias.get(key) ?? snakeToCamel(key);
      const resolve = Object.hasOwn(nested, name) ? nested[name] : undefined;
      options[name] = resolve && value !== undefined ? resolve(value) : value;
    }
    return new this(options);
  }

  /**
   * Serialize the model to a plain object with the wire (snake_case) keys
   * (pydantic's `model_dump`).
   */
  modelDump(options: ModelDumpOptions = {}): Record<string, any> {
    const aliases = (this.constructor as typeof BaseModel)._aliases;
    const out: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(this)) {
      if (value === undefined) continue;
      if (options.excludeNone && value === null) continue;
      const key = options.byAlias && Object.hasOwn(aliases, name) ? aliases[name] : undefined;
      out[key ?? camelToSnake(name)] = dumpValue(value, options);
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
    if (options.update) Object.assign(copy, options.update);
    return copy;
  }
}

//
// Audio format configuration
//

/** Inworld supports configurable sample rates for PCM audio. */
export type SUPPORTED_SAMPLE_RATES = 8000 | 16000 | 24000 | 32000 | 44100 | 48000;

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
// Turn detection configuration (lives inside audio.input)
//

export interface TurnDetectionOptions {
  type?: "server_vad" | "semantic_vad" | null;
  eagerness?: string | null;
  createResponse?: boolean | null;
  interruptResponse?: boolean | null;
}

/**
 * Server-side voice activity detection configuration.
 *
 * - `type`: detection type. "server_vad" for standard VAD, "semantic_vad"
 *   for semantic-based detection.
 * - `eagerness`: how eagerly to detect end of turn. Options: "low",
 *   "medium", "high".
 * - `createResponse`: whether to automatically create a response on turn end.
 * - `interruptResponse`: whether user speech interrupts the current response.
 */
export class TurnDetection extends BaseModel {
  type: "server_vad" | "semantic_vad" | null;
  eagerness: string | null;
  createResponse: boolean | null;
  interruptResponse: boolean | null;

  constructor(options: TurnDetectionOptions = {}) {
    super();
    this.type = options.type === undefined ? "semantic_vad" : options.type;
    this.eagerness = options.eagerness ?? null;
    this.createResponse = options.createResponse ?? null;
    this.interruptResponse = options.interruptResponse ?? null;
  }
}

export interface InputTranscriptionOptions {
  model?: string | null;
}

/**
 * Configuration for input audio transcription.
 *
 * - `model`: the STT model to use for transcription.
 */
export class InputTranscription extends BaseModel {
  model: string | null;

  constructor(options: InputTranscriptionOptions = {}) {
    super();
    this.model = options.model ?? null;
  }
}

//
// Audio configuration
//

export interface AudioInputOptions {
  format?: PCMAudioFormat | PCMUAudioFormat | PCMAAudioFormat | null;
  transcription?: InputTranscription | null;
  turnDetection?: TurnDetection | null;
}

/**
 * Audio input configuration.
 *
 * - `format`: the format configuration for input audio.
 * - `transcription`: configuration for input audio transcription.
 * - `turnDetection`: configuration for turn detection.
 */
export class AudioInput extends BaseModel {
  static override _nested: Record<string, Resolver> = {
    format: audioFormat,
    transcription: model(InputTranscription),
    turnDetection: model(TurnDetection),
  };

  format: PCMAudioFormat | PCMUAudioFormat | PCMAAudioFormat | null;
  transcription: InputTranscription | null;
  turnDetection: TurnDetection | null;

  constructor(options: AudioInputOptions = {}) {
    super();
    this.format = options.format ?? null;
    this.transcription = options.transcription ?? null;
    this.turnDetection = options.turnDetection ?? null;
  }
}

export interface AudioOutputOptions {
  format?: PCMAudioFormat | PCMUAudioFormat | PCMAAudioFormat | null;
  model?: string | null;
  voice?: string | null;
}

/**
 * Audio output configuration.
 *
 * - `format`: the format configuration for output audio.
 * - `model`: the TTS model to use (e.g. "inworld-tts-2").
 * - `voice`: the voice ID to use (e.g. "Sarah", "Clive").
 */
export class AudioOutput extends BaseModel {
  static override _nested: Record<string, Resolver> = { format: audioFormat };

  format: PCMAudioFormat | PCMUAudioFormat | PCMAAudioFormat | null;
  model: string | null;
  voice: string | null;

  constructor(options: AudioOutputOptions = {}) {
    super();
    this.format = options.format ?? null;
    this.model = options.model ?? null;
    this.voice = options.voice ?? null;
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

//
// Tool definitions
//

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

/** Union type for Inworld tools. */
export type InworldTool = FunctionTool | Record<string, unknown>;

//
// Session properties
//

/** The tools a session can carry. */
export type SessionTools = ToolsSchema | (FunctionSchema | DirectFunction)[] | InworldTool[];

export interface SessionPropertiesOptions {
  type?: string | null;
  model?: string | null;
  instructions?: string | null;
  temperature?: number | null;
  outputModalities?: Modality[] | null;
  audio?: AudioConfiguration | null;
  tools?: SessionTools | null;
  providerData?: Record<string, unknown> | null;
}

/**
 * Configuration properties for an Inworld Realtime session.
 *
 * - `type`: session type, always "realtime".
 * - `model`: the LLM model to use (e.g. "openai/gpt-4.1-mini").
 * - `instructions`: system instructions for the assistant.
 * - `temperature`: sampling temperature.
 * - `outputModalities`: output modalities (e.g. ["audio", "text"]).
 * - `audio`: audio configuration including input (transcription, turn
 *   detection) and output (TTS model, voice).
 * - `tools`: available tools for the assistant.
 * - `providerData`: provider-specific data, sent as `providerData`.
 */
export class SessionProperties extends BaseModel {
  static override _nested: Record<string, Resolver> = { audio: model(AudioConfiguration) };
  static override _aliases: Record<string, string> = { providerData: "providerData" };

  /** The model's fields (pydantic's `model_fields`): camelCase field name to wire key. */
  static readonly modelFields: Readonly<Record<string, string>> = {
    type: "type",
    model: "model",
    instructions: "instructions",
    temperature: "temperature",
    outputModalities: "output_modalities",
    audio: "audio",
    tools: "tools",
    providerData: "provider_data",
  };

  type: string | null;
  model: string | null;
  instructions: string | null;
  temperature: number | null;
  outputModalities: Modality[] | null;
  audio: AudioConfiguration | null;
  // Tools provided by the user may be a ToolsSchema or a plain list of standard
  // tools (normalized to a ToolsSchema on construction); a list of
  // provider-native InworldTool objects passes through.
  tools: SessionTools | null;
  providerData: Record<string, unknown> | null;

  constructor(options: SessionPropertiesOptions = {}) {
    super();
    const opts = options as SessionPropertiesOptions & { provider_data?: Record<string, unknown> };
    this.type = options.type === undefined ? "realtime" : options.type;
    this.model = options.model ?? null;
    this.instructions = options.instructions ?? null;
    this.temperature = options.temperature ?? null;
    this.outputModalities = options.outputModalities ?? null;
    this.audio = options.audio ?? null;
    this.tools = SessionProperties._normalizeTools(options.tools ?? null);
    // populate_by_name: both the field name and the alias are accepted.
    this.providerData = options.providerData ?? opts.provider_data ?? null;
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
  type: "message" | "function_call" | "function_call_output";
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
 * - `type`: item type (message, function_call, or function_call_output).
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
  type: "message" | "function_call" | "function_call_output";
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
}

/**
 * Properties for configuring assistant responses.
 *
 * - `modalities`: output modalities for the response (text, audio, or both).
 */
export class ResponseProperties extends BaseModel {
  modalities: Modality[] | null;

  constructor(options: ResponsePropertiesOptions = {}) {
    super();
    this.modalities = options.modalities === undefined ? ["text", "audio"] : options.modalities;
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
// Client Events (sent to Inworld)
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

//
// Server Events (received from Inworld)
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
  session?: SessionProperties | null;
}

/**
 * Event indicating a session has been created.
 *
 * This is the first event received after connecting.
 *
 * - `type`: event type, always "session.created".
 * - `session`: the initial session properties.
 */
export class SessionCreatedEvent extends ServerEvent {
  static override _nested: Record<string, Resolver> = { session: model(SessionProperties) };

  declare type: "session.created";
  session: SessionProperties | null;

  constructor(options: SessionCreatedEventOptions) {
    super(options);
    this.type = literal(options.type, "session.created", "SessionCreatedEvent");
    this.session = options.session ?? null;
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
 * This is the first message received after connecting.
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

export interface ConversationItemInputAudioTranscriptionCompletedOptions
  extends ServerEventOptions {
  type: "conversation.item.input_audio_transcription.completed";
  itemId: string;
  transcript: string;
}

/**
 * Event indicating input audio transcription is complete.
 *
 * - `type`: event type, always
 *   "conversation.item.input_audio_transcription.completed".
 * - `itemId`: ID of the conversation item that was transcribed.
 * - `transcript`: complete transcription text.
 */
export class ConversationItemInputAudioTranscriptionCompleted extends ServerEvent {
  declare type: "conversation.item.input_audio_transcription.completed";
  itemId: string;
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
    this.transcript = required(options, "transcript", name);
  }
}

export interface ConversationItemInputAudioTranscriptionDeltaOptions extends ServerEventOptions {
  type: "conversation.item.input_audio_transcription.delta";
  itemId: string;
  contentIndex?: number | null;
  delta: string;
}

/**
 * Event containing incremental input audio transcription.
 *
 * - `type`: event type, always
 *   "conversation.item.input_audio_transcription.delta".
 * - `itemId`: ID of the conversation item being transcribed.
 * - `contentIndex`: index of the content part.
 * - `delta`: incremental transcription text.
 */
export class ConversationItemInputAudioTranscriptionDelta extends ServerEvent {
  declare type: "conversation.item.input_audio_transcription.delta";
  itemId: string;
  contentIndex: number | null;
  delta: string;

  constructor(options: ConversationItemInputAudioTranscriptionDeltaOptions) {
    super(options);
    const name = "ConversationItemInputAudioTranscriptionDelta";
    this.type = literal(options.type, "conversation.item.input_audio_transcription.delta", name);
    this.itemId = required(options, "itemId", name);
    this.contentIndex = options.contentIndex ?? null;
    this.delta = required(options, "delta", name);
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
  name?: string | null;
  arguments: string;
}

/**
 * Event indicating function call arguments are complete.
 *
 * - `type`: event type, always "response.function_call_arguments.done".
 * - `callId`: ID of the function call.
 * - `name`: name of the function being called. Optional — Inworld may omit
 *   this; the name can be resolved from the tracked function call item.
 * - `arguments`: complete function arguments as JSON string.
 */
export class ResponseFunctionCallArgumentsDone extends ServerEvent {
  declare type: "response.function_call_arguments.done";
  callId: string;
  name: string | null;
  arguments: string;

  constructor(options: ResponseFunctionCallArgumentsDoneOptions) {
    super(options);
    const model = "ResponseFunctionCallArgumentsDone";
    this.type = literal(options.type, "response.function_call_arguments.done", model);
    this.callId = required(options, "callId", model);
    this.name = options.name ?? null;
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
 * - `usage`: token usage (also available at top level).
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
  "conversation.item.input_audio_transcription.completed":
    ConversationItemInputAudioTranscriptionCompleted,
  "conversation.item.input_audio_transcription.delta": ConversationItemInputAudioTranscriptionDelta,
  "input_audio_buffer.speech_started": InputAudioBufferSpeechStarted,
  "input_audio_buffer.speech_stopped": InputAudioBufferSpeechStopped,
  "input_audio_buffer.committed": InputAudioBufferCommitted,
  "input_audio_buffer.cleared": InputAudioBufferCleared,
  "response.created": ResponseCreated,
  "response.output_item.added": ResponseOutputItemAdded,
  "response.output_item.done": ResponseOutputItemDone,
  "response.content_part.added": ResponseContentPartAdded,
  "response.content_part.done": ResponseContentPartDone,
  "response.output_audio_transcript.delta": ResponseAudioTranscriptDelta,
  "response.output_audio_transcript.done": ResponseAudioTranscriptDone,
  "response.output_audio.delta": ResponseAudioDelta,
  "response.output_audio.done": ResponseAudioDone,
  "response.function_call_arguments.delta": ResponseFunctionCallArgumentsDelta,
  "response.function_call_arguments.done": ResponseFunctionCallArgumentsDone,
  "response.done": ResponseDone,
};

/**
 * Parse a server event from JSON.
 *
 * @param data JSON text (or UTF-8 bytes) containing the server event, as
 *   delivered by the websocket.
 * @returns Parsed server event object of the appropriate type, or `null` if
 *   the event type is not recognized (e.g. a newer server event without a
 *   model).
 * @throws Error If a recognized event type fails to parse.
 */
export function parseServerEvent(data: string | Uint8Array): ServerEvent | null {
  const text = typeof data === "string" ? data : new TextDecoder().decode(data);
  const event = pyJsonLoads(text) as Record<string, unknown>;
  if (!isPlainObject(event) || !("type" in event)) {
    // Python's KeyError for the missing key.
    throw new Error("'type'");
  }
  const eventType = event.type as string;
  if (typeof eventType !== "string" || !Object.hasOwn(_serverEventTypes, eventType)) {
    return null;
  }
  try {
    return (_serverEventTypes[eventType] as ServerEventClass).modelValidate(event);
  } catch (e) {
    rethrowIfCancelled(e);
    throw new Error(`${e instanceof Error ? e.message : String(e)} \n\n${text}`);
  }
}
