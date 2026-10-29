// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/services/openai/realtime/events.py

/**
 * Event models and data structures for OpenAI Realtime API communication.
 *
 * Porting notes:
 * - Upstream models are pydantic `BaseModel`s. Here each model extends the
 *   small `BaseModel` below: fields are camelCase and the constructor takes
 *   one options object, while `modelValidate()` reads and `modelDump()` /
 *   `toJSON()` write the upstream snake_case wire keys, so the wire format is
 *   unchanged. Plain-dict fields (`tracing`, `prompt`, `rate_limits`,
 *   `status_details`, `tools` as provider dicts) are passed through untouched.
 * - Validation is reduced to what the services rely on: required fields and
 *   the `type` literal of server events raise `ValidationError`; value types
 *   are not checked.
 * - `model_copy(update=...)` is `modelCopy({ update })`, with camelCase field
 *   names; `SessionProperties.model_fields` is `SessionProperties.modelFields`
 *   (camelCase field name to wire key).
 */

import { rethrowIfCancelled } from "@pipedog/asyncio";
import type { DirectFunction } from "@pipedog/core/adapters/llm/schemas/direct_function";
import type { FunctionSchema } from "@pipedog/core/adapters/llm/schemas/function_schema";
import { ToolsSchema } from "@pipedog/core/adapters/llm/schemas/tools_schema";
import { LLMContext } from "@pipedog/core/processors/aggregators/llm_context";
import { pyJsonLoads } from "@pipedog/core/utils/py_json";
import { OPENAI_REALTIME_WHISPER_MODEL, OPENAI_SAMPLE_RATE } from "../_constants.ts";

/** A modality the model can respond with. */
export type Modality = "text" | "audio";

/** How much detail the model should read out of an image. */
export type ImageDetail = "auto" | "low" | "high";

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

  /** The `field=value` pairs pydantic's `__str__` / `__repr__` print. */
  _reprArgs(): string[] {
    const args: string[] = [];
    for (const [name, value] of Object.entries(this)) {
      if (value === undefined) continue;
      args.push(`${camelToSnake(name)}=${pyRepr(value)}`);
    }
    const extra = modelExtras.get(this);
    if (extra) {
      for (const [key, value] of Object.entries(extra)) args.push(`${key}=${pyRepr(value)}`);
    }
    return args;
  }

  /** pydantic's `__str__`: `field=value` pairs separated by spaces. */
  toString(): string {
    return this._reprArgs().join(" ");
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

/** A value as Python's `repr()` prints it (pydantic's `__repr__` for models). */
function pyRepr(value: unknown): string {
  if (value === null || value === undefined) return "None";
  if (value === true) return "True";
  if (value === false) return "False";
  if (typeof value === "string") {
    const quote = value.includes("'") && !value.includes('"') ? '"' : "'";
    const escaped = value
      .replaceAll("\\", "\\\\")
      .replaceAll("\n", "\\n")
      .replaceAll("\r", "\\r")
      .replaceAll("\t", "\\t");
    return quote === "'" ? `'${escaped.replaceAll("'", "\\'")}'` : `"${escaped}"`;
  }
  if (value instanceof BaseModel) {
    return `${value.constructor.name}(${value._reprArgs().join(", ")})`;
  }
  if (Array.isArray(value)) return `[${value.map(pyRepr).join(", ")}]`;
  if (isPlainObject(value)) {
    return `{${Object.entries(value)
      .map(([k, v]) => `${pyRepr(k)}: ${pyRepr(v)}`)
      .join(", ")}}`;
  }
  return String(value);
}

//
// session properties
//

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
  rate?: number;
}

/**
 * PCM audio format configuration.
 *
 * - `type`: audio format type, always "audio/pcm".
 * - `rate`: sample rate, always 24000 for PCM.
 */
export class PCMAudioFormat extends AudioFormat {
  declare type: "audio/pcm";
  rate: number;

  constructor(options: PCMAudioFormatOptions = {}) {
    super({ type: options.type ?? "audio/pcm" });
    this.rate = options.rate ?? OPENAI_SAMPLE_RATE;
  }
}

export interface PCMUAudioFormatOptions {
  type?: "audio/pcmu";
}

/**
 * PCMU (G.711 μ-law) audio format configuration.
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

export interface InputAudioTranscriptionOptions {
  /**
   * Transcription model to use (e.g. "gpt-realtime-whisper",
   * "gpt-4o-transcribe", "whisper-1").
   */
  model?: string | null;
  /** Optional language code for transcription. */
  language?: string | null;
  /** Optional transcription hint text. */
  prompt?: string | null;
}

/** Configuration for audio transcription settings. */
export class InputAudioTranscription extends BaseModel {
  model: string;
  language: string | null;
  prompt: string | null;

  /**
   * Initialize InputAudioTranscription.
   *
   * @param options.model Transcription model to use (e.g.
   *   "gpt-realtime-whisper", "gpt-4o-transcribe", "whisper-1").
   * @param options.language Optional language code for transcription.
   * @param options.prompt Optional transcription hint text.
   */
  constructor(options: InputAudioTranscriptionOptions = {}) {
    super();
    this.model = options.model ?? OPENAI_REALTIME_WHISPER_MODEL;
    this.language = options.language ?? null;
    this.prompt = options.prompt ?? null;
  }
}

export interface TurnDetectionOptions {
  type?: "server_vad" | null;
  threshold?: number | null;
  prefixPaddingMs?: number | null;
  silenceDurationMs?: number | null;
}

/**
 * Server-side voice activity detection configuration.
 *
 * - `type`: detection type, must be "server_vad".
 * - `threshold`: voice activity detection threshold (0.0-1.0). Defaults to 0.5.
 * - `prefixPaddingMs`: padding before speech starts in milliseconds. Defaults to 300.
 * - `silenceDurationMs`: silence duration to detect speech end in milliseconds.
 *   Defaults to 500.
 */
export class TurnDetection extends BaseModel {
  type: "server_vad" | null;
  threshold: number | null;
  prefixPaddingMs: number | null;
  silenceDurationMs: number | null;

  constructor(options: TurnDetectionOptions = {}) {
    super();
    this.type = options.type === undefined ? "server_vad" : options.type;
    this.threshold = options.threshold === undefined ? 0.5 : options.threshold;
    this.prefixPaddingMs = options.prefixPaddingMs === undefined ? 300 : options.prefixPaddingMs;
    this.silenceDurationMs =
      options.silenceDurationMs === undefined ? 500 : options.silenceDurationMs;
  }
}

export interface SemanticTurnDetectionOptions {
  type?: "semantic_vad" | null;
  eagerness?: "low" | "medium" | "high" | "auto" | null;
  createResponse?: boolean | null;
  interruptResponse?: boolean | null;
}

/**
 * Semantic-based turn detection configuration.
 *
 * - `type`: detection type, must be "semantic_vad".
 * - `eagerness`: turn detection eagerness level. Can be "low", "medium",
 *   "high", or "auto".
 * - `createResponse`: whether to automatically create responses on turn detection.
 * - `interruptResponse`: whether to interrupt ongoing responses on turn detection.
 */
export class SemanticTurnDetection extends BaseModel {
  type: "semantic_vad" | null;
  eagerness: "low" | "medium" | "high" | "auto" | null;
  createResponse: boolean | null;
  interruptResponse: boolean | null;

  constructor(options: SemanticTurnDetectionOptions = {}) {
    super();
    this.type = options.type === undefined ? "semantic_vad" : options.type;
    this.eagerness = options.eagerness ?? null;
    this.createResponse = options.createResponse ?? null;
    this.interruptResponse = options.interruptResponse ?? null;
  }
}

/** Builds the turn detection a wire value describes: a bool, or a config by its `type`. */
const turnDetection: Resolver = (value) => {
  if (typeof value === "boolean" || value === null || !isPlainObject(value)) return value;
  if (value.type === "semantic_vad") return SemanticTurnDetection.modelValidate(value);
  return TurnDetection.modelValidate(value);
};

export interface InputAudioNoiseReductionOptions {
  type: "near_field" | "far_field" | null;
}

/**
 * Input audio noise reduction configuration.
 *
 * - `type`: noise reduction type for different microphone scenarios.
 */
export class InputAudioNoiseReduction extends BaseModel {
  type: "near_field" | "far_field" | null;

  constructor(options: InputAudioNoiseReductionOptions) {
    super();
    this.type = required(options, "type", "InputAudioNoiseReduction");
  }
}

export interface AudioInputOptions {
  format?: PCMAudioFormat | PCMUAudioFormat | PCMAAudioFormat | null;
  transcription?: InputAudioTranscription | null;
  noiseReduction?: InputAudioNoiseReduction | null;
  turnDetection?: TurnDetection | SemanticTurnDetection | boolean | null;
}

/**
 * Audio input configuration.
 *
 * - `format`: the format of the input audio.
 * - `transcription`: configuration for input audio transcription.
 * - `noiseReduction`: configuration for input audio noise reduction.
 * - `turnDetection`: configuration for turn detection, or false to disable.
 */
export class AudioInput extends BaseModel {
  static override _nested: Record<string, Resolver> = {
    format: audioFormat,
    transcription: model(InputAudioTranscription),
    noiseReduction: model(InputAudioNoiseReduction),
    turnDetection,
  };

  format: PCMAudioFormat | PCMUAudioFormat | PCMAAudioFormat | null;
  transcription: InputAudioTranscription | null;
  noiseReduction: InputAudioNoiseReduction | null;
  turnDetection: TurnDetection | SemanticTurnDetection | boolean | null;

  constructor(options: AudioInputOptions = {}) {
    super();
    this.format = options.format ?? null;
    this.transcription = options.transcription ?? null;
    this.noiseReduction = options.noiseReduction ?? null;
    this.turnDetection = options.turnDetection ?? null;
  }
}

export interface AudioOutputOptions {
  format?: PCMAudioFormat | PCMUAudioFormat | PCMAAudioFormat | null;
  voice?: string | null;
  speed?: number | null;
}

/**
 * Audio output configuration.
 *
 * - `format`: the format of the output audio.
 * - `voice`: the voice the model uses to respond.
 * - `speed`: the speed of the model's spoken response.
 */
export class AudioOutput extends BaseModel {
  static override _nested: Record<string, Resolver> = { format: audioFormat };

  format: PCMAudioFormat | PCMUAudioFormat | PCMAAudioFormat | null;
  voice: string | null;
  speed: number | null;

  constructor(options: AudioOutputOptions = {}) {
    super();
    this.format = options.format ?? null;
    this.voice = options.voice ?? null;
    this.speed = options.speed ?? null;
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

/** A reasoning effort level; any string is accepted for forward compatibility. */
export type ReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh" | (string & {});

export interface ReasoningOptions {
  effort?: ReasoningEffort | null;
}

/**
 * Reasoning configuration for reasoning-capable Realtime models (e.g. `gpt-realtime-2`).
 *
 * - `effort`: how much reasoning effort the model should apply. `null` (the
 *   default) leaves the field unset and lets the server pick.
 */
export class Reasoning extends BaseModel {
  // `| string` for forward compatibility: if OpenAI adds new effort levels,
  // users can pass the new string without waiting for a Pipecat release.
  effort: ReasoningEffort | null;

  constructor(options: ReasoningOptions = {}) {
    super();
    this.effort = options.effort ?? null;
  }
}

/** The tools a session can carry. */
export type SessionTools =
  | ToolsSchema
  | (FunctionSchema | DirectFunction)[]
  | Record<string, unknown>[];

export interface SessionPropertiesOptions {
  type?: "realtime" | null;
  object?: "realtime.session" | null;
  id?: string | null;
  model?: string | null;
  outputModalities?: Modality[] | null;
  instructions?: string | null;
  audio?: AudioConfiguration | null;
  tools?: SessionTools | null;
  toolChoice?: "auto" | "none" | "required" | null;
  maxOutputTokens?: number | "inf" | null;
  tracing?: "auto" | Record<string, unknown> | null;
  prompt?: Record<string, unknown> | null;
  expiresAt?: number | null;
  include?: string[] | null;
  reasoning?: Reasoning | null;
}

/**
 * Configuration properties for an OpenAI Realtime session.
 *
 * - `type`: the type of session, always "realtime".
 * - `object`: object type identifier, always "realtime.session".
 * - `id`: unique identifier for the session.
 * - `model`: the Realtime model used for this session. Note: the model is set
 *   at connection time via the service settings and cannot be changed during
 *   the session.
 * - `outputModalities`: the set of modalities the model can respond with.
 * - `instructions`: system instructions for the assistant.
 * - `audio`: configuration for input and output audio.
 * - `tools`: available function tools for the assistant.
 * - `toolChoice`: tool usage strategy ("auto", "none", or "required").
 * - `maxOutputTokens`: maximum tokens in response or "inf" for unlimited.
 * - `tracing`: configuration options for tracing.
 * - `prompt`: reference to a prompt template and its variables.
 * - `expiresAt`: session expiration timestamp.
 * - `include`: additional fields to include in server outputs.
 * - `reasoning`: reasoning configuration. Only supported by reasoning-capable
 *   Realtime models such as `gpt-realtime-2`.
 */
export class SessionProperties extends BaseModel {
  static override _nested: Record<string, Resolver> = {
    audio: model(AudioConfiguration),
    reasoning: model(Reasoning),
  };

  /** The model's fields (pydantic's `model_fields`): camelCase field name to wire key. */
  static readonly modelFields: Readonly<Record<string, string>> = {
    type: "type",
    object: "object",
    id: "id",
    model: "model",
    outputModalities: "output_modalities",
    instructions: "instructions",
    audio: "audio",
    tools: "tools",
    toolChoice: "tool_choice",
    maxOutputTokens: "max_output_tokens",
    tracing: "tracing",
    prompt: "prompt",
    expiresAt: "expires_at",
    include: "include",
    reasoning: "reasoning",
  };

  type: "realtime" | null;
  object: "realtime.session" | null;
  id: string | null;
  model: string | null;
  outputModalities: Modality[] | null;
  instructions: string | null;
  audio: AudioConfiguration | null;
  // Tools provided by the user (via the service constructor or
  // LLMUpdateSettingsFrame) may be a ToolsSchema or a plain list of standard
  // tools (normalized to a ToolsSchema on construction); a list of
  // provider-native tool dicts passes through. ToolsSchema is never
  // serialized/deserialized when talking to the server.
  tools: SessionTools | null;
  toolChoice: "auto" | "none" | "required" | null;
  maxOutputTokens: number | "inf" | null;
  tracing: "auto" | Record<string, unknown> | null;
  prompt: Record<string, unknown> | null;
  expiresAt: number | null;
  include: string[] | null;
  reasoning: Reasoning | null;

  constructor(options: SessionPropertiesOptions = {}) {
    super();
    this.type = options.type === undefined ? "realtime" : options.type;
    this.object = options.object ?? null;
    this.id = options.id ?? null;
    this.model = options.model ?? null;
    this.outputModalities = options.outputModalities ?? null;
    this.instructions = options.instructions ?? null;
    this.audio = options.audio ?? null;
    this.tools = SessionProperties._normalizeTools(options.tools ?? null);
    this.toolChoice = options.toolChoice ?? null;
    this.maxOutputTokens = options.maxOutputTokens ?? null;
    this.tracing = options.tracing ?? null;
    this.prompt = options.prompt ?? null;
    this.expiresAt = options.expiresAt ?? null;
    this.include = options.include ?? null;
    this.reasoning = options.reasoning ?? null;
  }

  /**
   * Wrap a plain list of standard tools in a `ToolsSchema`.
   *
   * Provider-native tool lists (dicts) pass through unchanged.
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
// context
//

export type ItemContentType =
  | "text"
  | "audio"
  | "input_text"
  | "input_audio"
  | "input_image"
  | "output_text"
  | "output_audio";

export interface ItemContentOptions {
  type: ItemContentType;
  text?: string | null;
  audio?: string | null;
  transcript?: string | null;
  imageUrl?: string | null;
  detail?: ImageDetail | null;
}

/**
 * Content within a conversation item.
 *
 * - `type`: content type (text, audio, input_text, input_audio, input_image,
 *   output_text, or output_audio).
 * - `text`: text content for text-based items.
 * - `audio`: base64-encoded audio data for audio items.
 * - `transcript`: transcribed text for audio items.
 * - `imageUrl`: base64-encoded image data as a data URI for input_image items.
 * - `detail`: detail level for image processing ("auto", "low", or "high").
 */
export class ItemContent extends BaseModel {
  type: ItemContentType;
  text: string | null;
  audio: string | null; // base64-encoded audio
  transcript: string | null;
  imageUrl: string | null; // base64-encoded image as data URI
  detail: ImageDetail | null;

  constructor(options: ItemContentOptions) {
    super();
    this.type = required(options, "type", "ItemContent");
    this.text = options.text ?? null;
    this.audio = options.audio ?? null;
    this.transcript = options.transcript ?? null;
    this.imageUrl = options.imageUrl ?? null;
    this.detail = options.detail ?? null;
  }
}

export interface ConversationItemOptions {
  id?: string;
  object?: "realtime.item" | null;
  type: "message" | "function_call" | "function_call_output";
  status?: "completed" | "in_progress" | "incomplete" | null;
  role?: "user" | "assistant" | "system" | null;
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
  // role and content are present for message items
  role: "user" | "assistant" | "system" | null;
  content: ItemContent[] | null;
  // these four fields are present for function_call items
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
  outputModalities?: Modality[] | null;
  instructions?: string | null;
  audio?: AudioConfiguration | null;
  tools?: Record<string, unknown>[] | null;
  toolChoice?: "auto" | "none" | "required" | null;
  temperature?: number | null;
  maxOutputTokens?: number | "inf" | null;
}

/**
 * Properties for configuring assistant responses.
 *
 * - `outputModalities`: output modalities for the response. Must be either
 *   ["text"] or ["audio"]. Defaults to ["audio"].
 * - `instructions`: specific instructions for this response.
 * - `audio`: audio configuration for this response.
 * - `tools`: available tools for this response.
 * - `toolChoice`: tool usage strategy for this response.
 * - `temperature`: sampling temperature for this response.
 * - `maxOutputTokens`: maximum tokens for this response.
 */
export class ResponseProperties extends BaseModel {
  static override _nested: Record<string, Resolver> = { audio: model(AudioConfiguration) };

  outputModalities: Modality[] | null;
  instructions: string | null;
  audio: AudioConfiguration | null;
  tools: Record<string, unknown>[] | null;
  toolChoice: "auto" | "none" | "required" | null;
  temperature: number | null;
  maxOutputTokens: number | "inf" | null;

  constructor(options: ResponsePropertiesOptions = {}) {
    super();
    this.outputModalities =
      options.outputModalities === undefined ? ["audio"] : options.outputModalities;
    this.instructions = options.instructions ?? null;
    this.audio = options.audio ?? null;
    this.tools = options.tools ?? null;
    this.toolChoice = options.toolChoice ?? null;
    this.temperature = options.temperature ?? null;
    this.maxOutputTokens = options.maxOutputTokens ?? null;
  }
}

//
// error class
//

export interface RealtimeErrorOptions {
  type: string;
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
  type: string;
  code: string | null;
  message: string;
  param: string | null;
  eventId: string | null;

  constructor(options: RealtimeErrorOptions) {
    super();
    this.type = required(options, "type", "RealtimeError");
    this.code = options.code === undefined ? "" : options.code;
    this.message = required(options, "message", "RealtimeError");
    this.param = options.param ?? null;
    this.eventId = options.eventId ?? null;
  }
}

//
// client events
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

  /**
   * Serialize the event to a plain object.
   *
   * Handles special serialization for turn_detection where false becomes null.
   *
   * @param options Options passed to the parent `modelDump`.
   * @returns Object representation of the event.
   */
  override modelDump(options: ModelDumpOptions = {}): Record<string, any> {
    const dump = super.modelDump(options);

    // Handle turn_detection in audio.input so that false becomes null
    if ("audio" in dump.session && dump.session.audio) {
      if ("input" in dump.session.audio && dump.session.audio.input) {
        if ("turn_detection" in dump.session.audio.input) {
          if (dump.session.audio.input.turn_detection === false) {
            dump.session.audio.input.turn_detection = null;
          }
        }
      }
    }

    return dump;
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

export interface ConversationItemTruncateEventOptions extends ClientEventOptions {
  type?: "conversation.item.truncate";
  itemId: string;
  contentIndex: number;
  audioEndMs: number;
}

/**
 * Event to truncate a conversation item's audio content.
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
    this.itemId = required(options, "itemId", "ConversationItemTruncateEvent");
    this.contentIndex = required(options, "contentIndex", "ConversationItemTruncateEvent");
    this.audioEndMs = required(options, "audioEndMs", "ConversationItemTruncateEvent");
  }
}

export interface ConversationItemDeleteEventOptions extends ClientEventOptions {
  type?: "conversation.item.delete";
  itemId: string;
}

/**
 * Event to delete a conversation item.
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

export interface ConversationItemRetrieveEventOptions extends ClientEventOptions {
  type?: "conversation.item.retrieve";
  itemId: string;
}

/**
 * Event to retrieve a conversation item by ID.
 *
 * - `type`: event type, always "conversation.item.retrieve".
 * - `itemId`: ID of the item to retrieve.
 */
export class ConversationItemRetrieveEvent extends ClientEvent {
  type = "conversation.item.retrieve" as const;
  itemId: string;

  constructor(options: ConversationItemRetrieveEventOptions) {
    super(options);
    this.itemId = required(options, "itemId", "ConversationItemRetrieveEvent");
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
// server events
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
 * Event indicating a session has been created.
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

export interface ConversationItemDoneOptions extends ServerEventOptions {
  type: "conversation.item.done";
  previousItemId?: string | null;
  item: ConversationItem;
}

/**
 * Event indicating a conversation item is done processing.
 *
 * - `type`: event type, always "conversation.item.done".
 * - `previousItemId`: ID of the previous item, if any.
 * - `item`: the completed conversation item.
 */
export class ConversationItemDone extends ServerEvent {
  static override _nested: Record<string, Resolver> = { item: model(ConversationItem) };

  declare type: "conversation.item.done";
  previousItemId: string | null;
  item: ConversationItem;

  constructor(options: ConversationItemDoneOptions) {
    super(options);
    this.type = literal(options.type, "conversation.item.done", "ConversationItemDone");
    this.previousItemId = options.previousItemId ?? null;
    this.item = required(options, "item", "ConversationItemDone");
  }
}

export interface ConversationItemInputAudioTranscriptionDeltaOptions extends ServerEventOptions {
  type: "conversation.item.input_audio_transcription.delta";
  itemId: string;
  contentIndex: number;
  delta: string;
}

/**
 * Event containing incremental input audio transcription.
 *
 * - `type`: event type, always "conversation.item.input_audio_transcription.delta".
 * - `itemId`: ID of the conversation item being transcribed.
 * - `contentIndex`: index of the content within the item.
 * - `delta`: incremental transcription text.
 */
export class ConversationItemInputAudioTranscriptionDelta extends ServerEvent {
  declare type: "conversation.item.input_audio_transcription.delta";
  itemId: string;
  contentIndex: number;
  delta: string;

  constructor(options: ConversationItemInputAudioTranscriptionDeltaOptions) {
    super(options);
    const name = "ConversationItemInputAudioTranscriptionDelta";
    this.type = literal(options.type, "conversation.item.input_audio_transcription.delta", name);
    this.itemId = required(options, "itemId", name);
    this.contentIndex = required(options, "contentIndex", name);
    this.delta = required(options, "delta", name);
  }
}

export interface ConversationItemInputAudioTranscriptionCompletedOptions
  extends ServerEventOptions {
  type: "conversation.item.input_audio_transcription.completed";
  itemId: string;
  contentIndex: number;
  transcript: string;
}

/**
 * Event indicating input audio transcription is complete.
 *
 * - `type`: event type, always "conversation.item.input_audio_transcription.completed".
 * - `itemId`: ID of the conversation item that was transcribed.
 * - `contentIndex`: index of the content within the item.
 * - `transcript`: complete transcription text.
 */
export class ConversationItemInputAudioTranscriptionCompleted extends ServerEvent {
  declare type: "conversation.item.input_audio_transcription.completed";
  itemId: string;
  contentIndex: number;
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
    this.contentIndex = required(options, "contentIndex", name);
    this.transcript = required(options, "transcript", name);
  }
}

export interface ConversationItemInputAudioTranscriptionFailedOptions extends ServerEventOptions {
  type: "conversation.item.input_audio_transcription.failed";
  itemId: string;
  contentIndex: number;
  error: RealtimeError;
}

/**
 * Event indicating input audio transcription failed.
 *
 * - `type`: event type, always "conversation.item.input_audio_transcription.failed".
 * - `itemId`: ID of the conversation item that failed transcription.
 * - `contentIndex`: index of the content within the item.
 * - `error`: error details for the transcription failure.
 */
export class ConversationItemInputAudioTranscriptionFailed extends ServerEvent {
  static override _nested: Record<string, Resolver> = { error: model(RealtimeError) };

  declare type: "conversation.item.input_audio_transcription.failed";
  itemId: string;
  contentIndex: number;
  error: RealtimeError;

  constructor(options: ConversationItemInputAudioTranscriptionFailedOptions) {
    super(options);
    const name = "ConversationItemInputAudioTranscriptionFailed";
    this.type = literal(options.type, "conversation.item.input_audio_transcription.failed", name);
    this.itemId = required(options, "itemId", name);
    this.contentIndex = required(options, "contentIndex", name);
    this.error = required(options, "error", name);
  }
}

export interface ConversationItemTruncatedOptions extends ServerEventOptions {
  type: "conversation.item.truncated";
  itemId: string;
  contentIndex: number;
  audioEndMs: number;
}

/**
 * Event indicating a conversation item has been truncated.
 *
 * - `type`: event type, always "conversation.item.truncated".
 * - `itemId`: ID of the truncated conversation item.
 * - `contentIndex`: index of the content within the item.
 * - `audioEndMs`: end time in milliseconds for the truncated audio.
 */
export class ConversationItemTruncated extends ServerEvent {
  declare type: "conversation.item.truncated";
  itemId: string;
  contentIndex: number;
  audioEndMs: number;

  constructor(options: ConversationItemTruncatedOptions) {
    super(options);
    const name = "ConversationItemTruncated";
    this.type = literal(options.type, "conversation.item.truncated", name);
    this.itemId = required(options, "itemId", name);
    this.contentIndex = required(options, "contentIndex", name);
    this.audioEndMs = required(options, "audioEndMs", name);
  }
}

export interface ConversationItemDeletedOptions extends ServerEventOptions {
  type: "conversation.item.deleted";
  itemId: string;
}

/**
 * Event indicating a conversation item has been deleted.
 *
 * - `type`: event type, always "conversation.item.deleted".
 * - `itemId`: ID of the deleted conversation item.
 */
export class ConversationItemDeleted extends ServerEvent {
  declare type: "conversation.item.deleted";
  itemId: string;

  constructor(options: ConversationItemDeletedOptions) {
    super(options);
    this.type = literal(options.type, "conversation.item.deleted", "ConversationItemDeleted");
    this.itemId = required(options, "itemId", "ConversationItemDeleted");
  }
}

export interface ConversationItemRetrievedOptions extends ServerEventOptions {
  type: "conversation.item.retrieved";
  item: ConversationItem;
}

/**
 * Event containing a retrieved conversation item.
 *
 * - `type`: event type, always "conversation.item.retrieved".
 * - `item`: the retrieved conversation item.
 */
export class ConversationItemRetrieved extends ServerEvent {
  static override _nested: Record<string, Resolver> = { item: model(ConversationItem) };

  declare type: "conversation.item.retrieved";
  item: ConversationItem;

  constructor(options: ConversationItemRetrievedOptions) {
    super(options);
    this.type = literal(options.type, "conversation.item.retrieved", "ConversationItemRetrieved");
    this.item = required(options, "item", "ConversationItemRetrieved");
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

export interface ResponseDoneOptions extends ServerEventOptions {
  type: "response.done";
  response: Response;
}

/**
 * Event indicating an assistant response is complete.
 *
 * - `type`: event type, always "response.done".
 * - `response`: the completed response object.
 */
export class ResponseDone extends ServerEvent {
  static override _nested: Record<string, Resolver> = {
    response: (value) => (value === null ? null : Response.modelValidate(value)),
  };

  declare type: "response.done";
  response: Response;

  constructor(options: ResponseDoneOptions) {
    super(options);
    this.type = literal(options.type, "response.done", "ResponseDone");
    this.response = required(options, "response", "ResponseDone");
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

export interface ResponseContentPartAddedOptions extends ServerEventOptions {
  type: "response.content_part.added";
  responseId: string;
  itemId: string;
  outputIndex: number;
  contentIndex: number;
  part: ItemContent;
}

/**
 * Event indicating a content part has been added to a response.
 *
 * - `type`: event type, always "response.content_part.added".
 * - `responseId`: ID of the response.
 * - `itemId`: ID of the conversation item.
 * - `outputIndex`: index of the output item.
 * - `contentIndex`: index of the content part.
 * - `part`: the added content part.
 */
export class ResponseContentPartAdded extends ServerEvent {
  static override _nested: Record<string, Resolver> = { part: model(ItemContent) };

  declare type: "response.content_part.added";
  responseId: string;
  itemId: string;
  outputIndex: number;
  contentIndex: number;
  part: ItemContent;

  constructor(options: ResponseContentPartAddedOptions) {
    super(options);
    const name = "ResponseContentPartAdded";
    this.type = literal(options.type, "response.content_part.added", name);
    this.responseId = required(options, "responseId", name);
    this.itemId = required(options, "itemId", name);
    this.outputIndex = required(options, "outputIndex", name);
    this.contentIndex = required(options, "contentIndex", name);
    this.part = required(options, "part", name);
  }
}

export interface ResponseContentPartDoneOptions extends ServerEventOptions {
  type: "response.content_part.done";
  responseId: string;
  itemId: string;
  outputIndex: number;
  contentIndex: number;
  part: ItemContent;
}

/**
 * Event indicating a content part is complete.
 *
 * - `type`: event type, always "response.content_part.done".
 * - `responseId`: ID of the response.
 * - `itemId`: ID of the conversation item.
 * - `outputIndex`: index of the output item.
 * - `contentIndex`: index of the content part.
 * - `part`: the completed content part.
 */
export class ResponseContentPartDone extends ServerEvent {
  static override _nested: Record<string, Resolver> = { part: model(ItemContent) };

  declare type: "response.content_part.done";
  responseId: string;
  itemId: string;
  outputIndex: number;
  contentIndex: number;
  part: ItemContent;

  constructor(options: ResponseContentPartDoneOptions) {
    super(options);
    const name = "ResponseContentPartDone";
    this.type = literal(options.type, "response.content_part.done", name);
    this.responseId = required(options, "responseId", name);
    this.itemId = required(options, "itemId", name);
    this.outputIndex = required(options, "outputIndex", name);
    this.contentIndex = required(options, "contentIndex", name);
    this.part = required(options, "part", name);
  }
}

/** Options shared by the streamed response-content events. */
interface ResponseContentEventOptions extends ServerEventOptions {
  responseId: string;
  itemId: string;
  outputIndex: number;
  contentIndex: number;
}

export interface ResponseTextDeltaOptions extends ResponseContentEventOptions {
  type: "response.output_text.delta";
  delta: string;
}

/**
 * Event containing incremental text from a response.
 *
 * - `type`: event type, always "response.output_text.delta".
 * - `responseId`: ID of the response.
 * - `itemId`: ID of the conversation item.
 * - `outputIndex`: index of the output item.
 * - `contentIndex`: index of the content part.
 * - `delta`: incremental text content.
 */
export class ResponseTextDelta extends ServerEvent {
  declare type: "response.output_text.delta";
  responseId: string;
  itemId: string;
  outputIndex: number;
  contentIndex: number;
  delta: string;

  constructor(options: ResponseTextDeltaOptions) {
    super(options);
    const name = "ResponseTextDelta";
    this.type = literal(options.type, "response.output_text.delta", name);
    this.responseId = required(options, "responseId", name);
    this.itemId = required(options, "itemId", name);
    this.outputIndex = required(options, "outputIndex", name);
    this.contentIndex = required(options, "contentIndex", name);
    this.delta = required(options, "delta", name);
  }
}

export interface ResponseTextDoneOptions extends ResponseContentEventOptions {
  type: "response.output_text.done";
  text: string;
}

/**
 * Event indicating text content is complete.
 *
 * - `type`: event type, always "response.output_text.done".
 * - `responseId`: ID of the response.
 * - `itemId`: ID of the conversation item.
 * - `outputIndex`: index of the output item.
 * - `contentIndex`: index of the content part.
 * - `text`: complete text content.
 */
export class ResponseTextDone extends ServerEvent {
  declare type: "response.output_text.done";
  responseId: string;
  itemId: string;
  outputIndex: number;
  contentIndex: number;
  text: string;

  constructor(options: ResponseTextDoneOptions) {
    super(options);
    const name = "ResponseTextDone";
    this.type = literal(options.type, "response.output_text.done", name);
    this.responseId = required(options, "responseId", name);
    this.itemId = required(options, "itemId", name);
    this.outputIndex = required(options, "outputIndex", name);
    this.contentIndex = required(options, "contentIndex", name);
    this.text = required(options, "text", name);
  }
}

export interface ResponseAudioTranscriptDeltaOptions extends ResponseContentEventOptions {
  type: "response.output_audio_transcript.delta";
  delta: string;
}

/**
 * Event containing incremental audio transcript from a response.
 *
 * - `type`: event type, always "response.output_audio_transcript.delta".
 * - `responseId`: ID of the response.
 * - `itemId`: ID of the conversation item.
 * - `outputIndex`: index of the output item.
 * - `contentIndex`: index of the content part.
 * - `delta`: incremental transcript text.
 */
export class ResponseAudioTranscriptDelta extends ServerEvent {
  declare type: "response.output_audio_transcript.delta";
  responseId: string;
  itemId: string;
  outputIndex: number;
  contentIndex: number;
  delta: string;

  constructor(options: ResponseAudioTranscriptDeltaOptions) {
    super(options);
    const name = "ResponseAudioTranscriptDelta";
    this.type = literal(options.type, "response.output_audio_transcript.delta", name);
    this.responseId = required(options, "responseId", name);
    this.itemId = required(options, "itemId", name);
    this.outputIndex = required(options, "outputIndex", name);
    this.contentIndex = required(options, "contentIndex", name);
    this.delta = required(options, "delta", name);
  }
}

export interface ResponseAudioTranscriptDoneOptions extends ResponseContentEventOptions {
  type: "response.output_audio_transcript.done";
  transcript: string;
}

/**
 * Event indicating audio transcript is complete.
 *
 * - `type`: event type, always "response.output_audio_transcript.done".
 * - `responseId`: ID of the response.
 * - `itemId`: ID of the conversation item.
 * - `outputIndex`: index of the output item.
 * - `contentIndex`: index of the content part.
 * - `transcript`: complete transcript text.
 */
export class ResponseAudioTranscriptDone extends ServerEvent {
  declare type: "response.output_audio_transcript.done";
  responseId: string;
  itemId: string;
  outputIndex: number;
  contentIndex: number;
  transcript: string;

  constructor(options: ResponseAudioTranscriptDoneOptions) {
    super(options);
    const name = "ResponseAudioTranscriptDone";
    this.type = literal(options.type, "response.output_audio_transcript.done", name);
    this.responseId = required(options, "responseId", name);
    this.itemId = required(options, "itemId", name);
    this.outputIndex = required(options, "outputIndex", name);
    this.contentIndex = required(options, "contentIndex", name);
    this.transcript = required(options, "transcript", name);
  }
}

export interface ResponseAudioDeltaOptions extends ResponseContentEventOptions {
  type: "response.output_audio.delta";
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

export interface ResponseAudioDoneOptions extends ResponseContentEventOptions {
  type: "response.output_audio.done";
}

/**
 * Event indicating audio content is complete.
 *
 * - `type`: event type, always "response.output_audio.done".
 * - `responseId`: ID of the response.
 * - `itemId`: ID of the conversation item.
 * - `outputIndex`: index of the output item.
 * - `contentIndex`: index of the content part.
 */
export class ResponseAudioDone extends ServerEvent {
  declare type: "response.output_audio.done";
  responseId: string;
  itemId: string;
  outputIndex: number;
  contentIndex: number;

  constructor(options: ResponseAudioDoneOptions) {
    super(options);
    const name = "ResponseAudioDone";
    this.type = literal(options.type, "response.output_audio.done", name);
    this.responseId = required(options, "responseId", name);
    this.itemId = required(options, "itemId", name);
    this.outputIndex = required(options, "outputIndex", name);
    this.contentIndex = required(options, "contentIndex", name);
  }
}

export interface ResponseFunctionCallArgumentsDeltaOptions extends ServerEventOptions {
  type: "response.function_call_arguments.delta";
  responseId: string;
  itemId: string;
  outputIndex: number;
  callId: string;
  delta: string;
}

/**
 * Event containing incremental function call arguments.
 *
 * - `type`: event type, always "response.function_call_arguments.delta".
 * - `responseId`: ID of the response.
 * - `itemId`: ID of the conversation item.
 * - `outputIndex`: index of the output item.
 * - `callId`: ID of the function call.
 * - `delta`: incremental function arguments as JSON.
 */
export class ResponseFunctionCallArgumentsDelta extends ServerEvent {
  declare type: "response.function_call_arguments.delta";
  responseId: string;
  itemId: string;
  outputIndex: number;
  callId: string;
  delta: string;

  constructor(options: ResponseFunctionCallArgumentsDeltaOptions) {
    super(options);
    const name = "ResponseFunctionCallArgumentsDelta";
    this.type = literal(options.type, "response.function_call_arguments.delta", name);
    this.responseId = required(options, "responseId", name);
    this.itemId = required(options, "itemId", name);
    this.outputIndex = required(options, "outputIndex", name);
    this.callId = required(options, "callId", name);
    this.delta = required(options, "delta", name);
  }
}

export interface ResponseFunctionCallArgumentsDoneOptions extends ServerEventOptions {
  type: "response.function_call_arguments.done";
  responseId: string;
  itemId: string;
  outputIndex: number;
  callId: string;
  arguments: string;
}

/**
 * Event indicating function call arguments are complete.
 *
 * - `type`: event type, always "response.function_call_arguments.done".
 * - `responseId`: ID of the response.
 * - `itemId`: ID of the conversation item.
 * - `outputIndex`: index of the output item.
 * - `callId`: ID of the function call.
 * - `arguments`: complete function arguments as JSON string.
 */
export class ResponseFunctionCallArgumentsDone extends ServerEvent {
  declare type: "response.function_call_arguments.done";
  responseId: string;
  itemId: string;
  outputIndex: number;
  callId: string;
  arguments: string;

  constructor(options: ResponseFunctionCallArgumentsDoneOptions) {
    super(options);
    const name = "ResponseFunctionCallArgumentsDone";
    this.type = literal(options.type, "response.function_call_arguments.done", name);
    this.responseId = required(options, "responseId", name);
    this.itemId = required(options, "itemId", name);
    this.outputIndex = required(options, "outputIndex", name);
    this.callId = required(options, "callId", name);
    this.arguments = required(options, "arguments", name);
  }
}

export interface InputAudioBufferSpeechStartedOptions extends ServerEventOptions {
  type: "input_audio_buffer.speech_started";
  audioStartMs: number;
  itemId: string;
}

/**
 * Event indicating speech has started in the input audio buffer.
 *
 * - `type`: event type, always "input_audio_buffer.speech_started".
 * - `audioStartMs`: start time of speech in milliseconds.
 * - `itemId`: ID of the associated conversation item.
 */
export class InputAudioBufferSpeechStarted extends ServerEvent {
  declare type: "input_audio_buffer.speech_started";
  audioStartMs: number;
  itemId: string;

  constructor(options: InputAudioBufferSpeechStartedOptions) {
    super(options);
    const name = "InputAudioBufferSpeechStarted";
    this.type = literal(options.type, "input_audio_buffer.speech_started", name);
    this.audioStartMs = required(options, "audioStartMs", name);
    this.itemId = required(options, "itemId", name);
  }
}

export interface InputAudioBufferSpeechStoppedOptions extends ServerEventOptions {
  type: "input_audio_buffer.speech_stopped";
  audioEndMs: number;
  itemId: string;
}

/**
 * Event indicating speech has stopped in the input audio buffer.
 *
 * - `type`: event type, always "input_audio_buffer.speech_stopped".
 * - `audioEndMs`: end time of speech in milliseconds.
 * - `itemId`: ID of the associated conversation item.
 */
export class InputAudioBufferSpeechStopped extends ServerEvent {
  declare type: "input_audio_buffer.speech_stopped";
  audioEndMs: number;
  itemId: string;

  constructor(options: InputAudioBufferSpeechStoppedOptions) {
    super(options);
    const name = "InputAudioBufferSpeechStopped";
    this.type = literal(options.type, "input_audio_buffer.speech_stopped", name);
    this.audioEndMs = required(options, "audioEndMs", name);
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

export interface RateLimitsUpdatedOptions extends ServerEventOptions {
  type: "rate_limits.updated";
  rateLimits: Record<string, unknown>[];
}

/**
 * Event indicating rate limits have been updated.
 *
 * - `type`: event type, always "rate_limits.updated".
 * - `rateLimits`: list of rate limit information.
 */
export class RateLimitsUpdated extends ServerEvent {
  declare type: "rate_limits.updated";
  rateLimits: Record<string, unknown>[];

  constructor(options: RateLimitsUpdatedOptions) {
    super(options);
    this.type = literal(options.type, "rate_limits.updated", "RateLimitsUpdated");
    this.rateLimits = required(options, "rateLimits", "RateLimitsUpdated");
  }
}

export interface CachedTokensDetailsOptions {
  textTokens?: number | null;
  audioTokens?: number | null;
}

/**
 * Details about cached tokens.
 *
 * - `textTokens`: number of cached text tokens.
 * - `audioTokens`: number of cached audio tokens.
 */
export class CachedTokensDetails extends BaseModel {
  textTokens: number | null;
  audioTokens: number | null;

  constructor(options: CachedTokensDetailsOptions = {}) {
    super();
    this.textTokens = options.textTokens === undefined ? 0 : options.textTokens;
    this.audioTokens = options.audioTokens === undefined ? 0 : options.audioTokens;
  }
}

export interface TokenDetailsOptions {
  cachedTokens?: number | null;
  textTokens?: number | null;
  audioTokens?: number | null;
  cachedTokensDetails?: CachedTokensDetails | null;
  imageTokens?: number | null;
}

/**
 * Detailed token usage information.
 *
 * Keys the model doesn't declare are kept (see `modelExtra`).
 *
 * - `cachedTokens`: number of cached tokens used. Defaults to 0.
 * - `textTokens`: number of text tokens used. Defaults to 0.
 * - `audioTokens`: number of audio tokens used. Defaults to 0.
 * - `cachedTokensDetails`: detailed breakdown of cached tokens.
 * - `imageTokens`: number of image tokens used (for input only).
 */
export class TokenDetails extends BaseModel {
  static override _nested: Record<string, Resolver> = {
    cachedTokensDetails: model(CachedTokensDetails),
  };
  static override _extraAllowed = true;

  cachedTokens: number | null;
  textTokens: number | null;
  audioTokens: number | null;
  cachedTokensDetails: CachedTokensDetails | null;
  imageTokens: number | null;

  constructor(options: TokenDetailsOptions = {}) {
    super();
    this.cachedTokens = options.cachedTokens === undefined ? 0 : options.cachedTokens;
    this.textTokens = options.textTokens === undefined ? 0 : options.textTokens;
    this.audioTokens = options.audioTokens === undefined ? 0 : options.audioTokens;
    this.cachedTokensDetails = options.cachedTokensDetails ?? null;
    this.imageTokens = options.imageTokens === undefined ? 0 : options.imageTokens;
  }
}

export interface UsageOptions {
  totalTokens?: number | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  inputTokenDetails?: TokenDetails | null;
  outputTokenDetails?: TokenDetails | null;
}

/**
 * Token usage statistics for a response.
 *
 * - `totalTokens`: total number of tokens used.
 * - `inputTokens`: number of input tokens used.
 * - `outputTokens`: number of output tokens used.
 * - `inputTokenDetails`: detailed breakdown of input token usage.
 * - `outputTokenDetails`: detailed breakdown of output token usage.
 */
export class Usage extends BaseModel {
  static override _nested: Record<string, Resolver> = {
    inputTokenDetails: model(TokenDetails),
    outputTokenDetails: model(TokenDetails),
  };

  totalTokens: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  inputTokenDetails: TokenDetails | null;
  outputTokenDetails: TokenDetails | null;

  constructor(options: UsageOptions = {}) {
    super();
    this.totalTokens = options.totalTokens ?? null;
    this.inputTokens = options.inputTokens ?? null;
    this.outputTokens = options.outputTokens ?? null;
    this.inputTokenDetails = options.inputTokenDetails ?? null;
    this.outputTokenDetails = options.outputTokenDetails ?? null;
  }
}

export type ResponseStatus = "completed" | "in_progress" | "incomplete" | "cancelled" | "failed";

export interface ResponseOptions {
  id?: string | null;
  object?: "realtime.response" | null;
  status?: ResponseStatus | null;
  statusDetails?: any;
  output?: ConversationItem[] | null;
  outputModalities?: Modality[] | null;
  maxOutputTokens?: number | "inf" | null;
  audio?: AudioConfiguration | null;
  usage?: Usage | null;
  voice?: string | null;
  temperature?: number | null;
  outputAudioFormat?: string | null;
}

/**
 * A complete assistant response.
 *
 * - `id`: unique identifier for the response.
 * - `object`: object type, always "realtime.response".
 * - `status`: current status of the response.
 * - `statusDetails`: additional status information.
 * - `output`: list of conversation items in the response.
 * - `outputModalities`: the set of modalities the model used to respond.
 * - `maxOutputTokens`: maximum number of output tokens used.
 * - `audio`: audio configuration for the response.
 * - `usage`: token usage statistics for the response.
 * - `voice`: the voice the model used to respond.
 * - `temperature`: sampling temperature used for the response.
 * - `outputAudioFormat`: the format of output audio.
 */
export class Response extends BaseModel {
  static override _nested: Record<string, Resolver> = {
    output: listOf(model(ConversationItem)),
    audio: model(AudioConfiguration),
    usage: model(Usage),
  };

  id: string | null;
  object: "realtime.response" | null;
  status: ResponseStatus | null;
  statusDetails: any;
  output: ConversationItem[] | null;
  outputModalities: Modality[] | null;
  maxOutputTokens: number | "inf" | null;
  audio: AudioConfiguration | null;
  usage: Usage | null;
  voice: string | null;
  temperature: number | null;
  outputAudioFormat: string | null;

  constructor(options: ResponseOptions = {}) {
    super();
    this.id = options.id ?? null;
    this.object = options.object ?? null;
    this.status = options.status ?? null;
    this.statusDetails = options.statusDetails ?? null;
    this.output = options.output ?? null;
    this.outputModalities = options.outputModalities ?? null;
    this.maxOutputTokens = options.maxOutputTokens ?? null;
    this.audio = options.audio ?? null;
    this.usage = options.usage ?? null;
    this.voice = options.voice ?? null;
    this.temperature = options.temperature ?? null;
    this.outputAudioFormat = options.outputAudioFormat ?? null;
  }
}

/** A server event class `parseServerEvent` can build. */
type ServerEventClass = { modelValidate(data: unknown): ServerEvent };

const _serverEventTypes: Record<string, ServerEventClass> = {
  error: ErrorEvent,
  "session.created": SessionCreatedEvent,
  "session.updated": SessionUpdatedEvent,
  "conversation.created": ConversationCreated,
  "input_audio_buffer.committed": InputAudioBufferCommitted,
  "input_audio_buffer.cleared": InputAudioBufferCleared,
  "input_audio_buffer.speech_started": InputAudioBufferSpeechStarted,
  "input_audio_buffer.speech_stopped": InputAudioBufferSpeechStopped,
  "conversation.item.added": ConversationItemAdded,
  "conversation.item.done": ConversationItemDone,
  "conversation.item.input_audio_transcription.delta": ConversationItemInputAudioTranscriptionDelta,
  "conversation.item.input_audio_transcription.completed":
    ConversationItemInputAudioTranscriptionCompleted,
  "conversation.item.input_audio_transcription.failed":
    ConversationItemInputAudioTranscriptionFailed,
  "conversation.item.truncated": ConversationItemTruncated,
  "conversation.item.deleted": ConversationItemDeleted,
  "conversation.item.retrieved": ConversationItemRetrieved,
  "response.created": ResponseCreated,
  "response.done": ResponseDone,
  "response.output_item.added": ResponseOutputItemAdded,
  "response.output_item.done": ResponseOutputItemDone,
  "response.content_part.added": ResponseContentPartAdded,
  "response.content_part.done": ResponseContentPartDone,
  "response.output_text.delta": ResponseTextDelta,
  "response.output_text.done": ResponseTextDone,
  "response.output_audio_transcript.delta": ResponseAudioTranscriptDelta,
  "response.output_audio_transcript.done": ResponseAudioTranscriptDone,
  "response.output_audio.delta": ResponseAudioDelta,
  "response.output_audio.done": ResponseAudioDone,
  "response.function_call_arguments.delta": ResponseFunctionCallArgumentsDelta,
  "response.function_call_arguments.done": ResponseFunctionCallArgumentsDone,
  "rate_limits.updated": RateLimitsUpdated,
};

/**
 * Parse a server event from JSON string.
 *
 * @param str JSON string (or UTF-8 bytes) containing the server event.
 * @returns Parsed server event object of the appropriate type, or `null` if
 *   the event type has no model here.
 * @throws Error If parsing fails.
 */
export function parseServerEvent(str: string | Uint8Array): ServerEvent | null {
  const text = typeof str === "string" ? str : new TextDecoder().decode(str);
  try {
    const event = pyJsonLoads(text);
    if (!isPlainObject(event) || !("type" in event)) {
      // Python's KeyError for the missing key.
      throw new Error("'type'");
    }
    const eventType = event.type as string;
    if (typeof eventType !== "string" || !Object.hasOwn(_serverEventTypes, eventType)) {
      return null;
    }
    return (_serverEventTypes[eventType] as ServerEventClass).modelValidate(event);
  } catch (e) {
    rethrowIfCancelled(e);
    throw new Error(`${e instanceof Error ? e.message : String(e)} \n\n${text}`);
  }
}
