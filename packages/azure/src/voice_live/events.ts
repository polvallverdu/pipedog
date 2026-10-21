// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/services/azure/voice_live/events.py

/**
 * Event models and data structures for Azure Voice Live API communication.
 *
 * Based on Azure's Voice Live API documentation:
 * https://learn.microsoft.com/en-us/azure/ai-services/speech-service/voice-live-api-reference-2026-07-15
 *
 * Voice Live keeps the original Realtime event names (`response.audio.delta`,
 * `conversation.item.created`) and a flat session object, rather than the
 * `response.output_audio.delta` names and nested `session.audio` object the
 * current OpenAI Realtime API uses.
 *
 * Porting notes:
 * - Upstream models are pydantic `BaseModel`s. They extend the `BaseModel`
 *   of `@pipedog/openai/realtime/events` (the same reduction of pydantic):
 *   fields are camelCase and the constructor takes one options object, while
 *   `modelValidate()` reads and `modelDump()` writes the upstream snake_case
 *   wire keys, so the wire format is unchanged.
 * - Validation is reduced to what the service relies on: required fields and
 *   the `type` literal of server events raise `ValidationError`; value types
 *   and literal values of other fields are not checked.
 * - `SessionProperties.model_fields_set` is `modelFieldsSet`: the fields given
 *   to the constructor or assigned afterwards, as pydantic tracks them.
 */

import { rethrowIfCancelled } from "@pipedog/asyncio";
import type { DirectFunction } from "@pipedog/core/adapters/schemas/direct_function";
import type { FunctionSchema } from "@pipedog/core/adapters/schemas/function_schema";
import { ToolsSchema } from "@pipedog/core/adapters/schemas/tools_schema";
import { LLMContext } from "@pipedog/core/processors/aggregators/llm_context";
import { pyJsonLoads } from "@pipedog/core/utils/py_json";
import { BaseModel, type ModelDumpOptions, ValidationError } from "@pipedog/openai/realtime/events";

export { BaseModel, type ModelDumpOptions, ValidationError };

/** A modality the model can respond with. */
export type Modality = "text" | "audio";

/** Encoding of the audio sent to the service. */
export type InputAudioFormat = "pcm16" | "g711_ulaw" | "g711_alaw";

/** Encoding of the audio returned by the service. */
export type OutputAudioFormat =
  | "pcm16"
  | "pcm16_8000hz"
  | "pcm16_16000hz"
  | "g711_ulaw"
  | "g711_alaw";

//
// Model helpers
//

/** Builds a nested field's value from wire data. */
type Resolver = (value: unknown) => unknown;

function camelToSnake(name: string): string {
  return name.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function required<T>(options: object, name: string, modelName: string): T {
  const value = (options as Record<string, unknown>)[name];
  if (value === undefined) {
    throw new ValidationError(
      `1 validation error for ${modelName}\n${camelToSnake(name)}\n  Field required`,
    );
  }
  return value as T;
}

function literal<T extends string>(value: unknown, expected: T, modelName: string): T {
  if (value === undefined) required({}, "type", modelName);
  if (value !== expected) {
    throw new ValidationError(
      `1 validation error for ${modelName}\ntype\n  Input should be '${expected}'`,
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

//
// Voice configuration
//

export interface OpenAIVoiceOptions {
  type?: "openai";
  name: string;
}

/**
 * A voice belonging to the generative model itself.
 *
 * Needs a native-audio model such as "gpt-realtime"; other models accept only
 * Azure voices.
 *
 * - `type`: voice type, always "openai".
 * - `name`: voice name, e.g. "alloy" or "marin".
 */
export class OpenAIVoice extends BaseModel {
  type = "openai" as const;
  name: string;

  constructor(options: OpenAIVoiceOptions) {
    super();
    this.name = required(options, "name", "OpenAIVoice");
  }
}

export interface AzureStandardVoiceOptions {
  type?: "azure-standard";
  name: string;
  temperature?: number | null;
  style?: string | null;
  pitch?: string | null;
  rate?: string | null;
  volume?: string | null;
  customLexiconUrl?: string | null;
  customTextNormalizationUrl?: string | null;
  preferLocales?: string[] | null;
  locale?: string | null;
}

/**
 * A prebuilt Azure text-to-speech voice.
 *
 * - `type`: voice type, always "azure-standard".
 * - `name`: full voice name, e.g. "en-US-Ava:DragonHDLatestNeural".
 * - `temperature`: variation across renditions of the same text, for HD
 *   voices. Higher values sound less uniform.
 * - `style`: speaking style, for voices that offer styles.
 * - `pitch`: pitch adjustment, e.g. "+5%".
 * - `rate`: speaking rate, e.g. "1.2".
 * - `volume`: volume adjustment, e.g. "+10%".
 * - `customLexiconUrl`: public URL of a custom lexicon to apply.
 * - `customTextNormalizationUrl`: public URL of custom text normalization
 *   rules to apply.
 * - `preferLocales`: locales to prefer when the voice is multilingual.
 * - `locale`: locale to speak, for multilingual voices.
 */
export class AzureStandardVoice extends BaseModel {
  type = "azure-standard" as const;
  name: string;
  temperature: number | null;
  style: string | null;
  pitch: string | null;
  rate: string | null;
  volume: string | null;
  customLexiconUrl: string | null;
  customTextNormalizationUrl: string | null;
  preferLocales: string[] | null;
  locale: string | null;

  constructor(options: AzureStandardVoiceOptions) {
    super();
    this.name = required(options, "name", "AzureStandardVoice");
    this.temperature = options.temperature ?? null;
    this.style = options.style ?? null;
    this.pitch = options.pitch ?? null;
    this.rate = options.rate ?? null;
    this.volume = options.volume ?? null;
    this.customLexiconUrl = options.customLexiconUrl ?? null;
    this.customTextNormalizationUrl = options.customTextNormalizationUrl ?? null;
    this.preferLocales = options.preferLocales ?? null;
    this.locale = options.locale ?? null;
  }
}

export interface AzureCustomVoiceOptions {
  type?: "azure-custom";
  name: string;
  endpointId: string;
  temperature?: number | null;
  rate?: string | null;
  customLexiconUrl?: string | null;
}

/**
 * A custom neural voice trained on the caller's own recordings.
 *
 * - `type`: voice type, always "azure-custom".
 * - `name`: deployed custom voice name.
 * - `endpointId`: deployment (endpoint) ID of the custom voice.
 * - `temperature`: variation across renditions of the same text.
 * - `rate`: speaking rate, e.g. "1.2".
 * - `customLexiconUrl`: public URL of a custom lexicon to apply.
 */
export class AzureCustomVoice extends BaseModel {
  type = "azure-custom" as const;
  name: string;
  endpointId: string;
  temperature: number | null;
  rate: string | null;
  customLexiconUrl: string | null;

  constructor(options: AzureCustomVoiceOptions) {
    super();
    this.name = required(options, "name", "AzureCustomVoice");
    this.endpointId = required(options, "endpointId", "AzureCustomVoice");
    this.temperature = options.temperature ?? null;
    this.rate = options.rate ?? null;
    this.customLexiconUrl = options.customLexiconUrl ?? null;
  }
}

export interface AzurePersonalVoiceOptions {
  type?: "azure-personal";
  name: string;
  model: "DragonLatestNeural" | "DragonHDLatestNeural" | "DragonHDOmniLatestNeural";
  temperature?: number | null;
  rate?: string | null;
}

/**
 * A personal voice built from a short speaker sample.
 *
 * - `type`: voice type, always "azure-personal".
 * - `name`: personal voice name.
 * - `model`: base model rendering the voice, e.g. "DragonLatestNeural".
 * - `temperature`: variation across renditions of the same text.
 * - `rate`: speaking rate, e.g. "1.2".
 */
export class AzurePersonalVoice extends BaseModel {
  type = "azure-personal" as const;
  name: string;
  model: "DragonLatestNeural" | "DragonHDLatestNeural" | "DragonHDOmniLatestNeural";
  temperature: number | null;
  rate: string | null;

  constructor(options: AzurePersonalVoiceOptions) {
    super();
    this.name = required(options, "name", "AzurePersonalVoice");
    this.model = required(options, "model", "AzurePersonalVoice");
    this.temperature = options.temperature ?? null;
    this.rate = options.rate ?? null;
  }
}

export interface AzureRealtimeNativeVoiceOptions {
  type?: "azure-realtime-native";
  name: string;
  temperature?: number | null;
}

/**
 * A voice native to Azure's own realtime model.
 *
 * - `type`: voice type, always "azure-realtime-native".
 * - `name`: voice name.
 * - `temperature`: variation across renditions of the same text.
 */
export class AzureRealtimeNativeVoice extends BaseModel {
  type = "azure-realtime-native" as const;
  name: string;
  temperature: number | null;

  constructor(options: AzureRealtimeNativeVoiceOptions) {
    super();
    this.name = required(options, "name", "AzureRealtimeNativeVoice");
    this.temperature = options.temperature ?? null;
  }
}

/** Any voice configuration Voice Live accepts. */
export type Voice =
  | OpenAIVoice
  | AzureStandardVoice
  | AzureCustomVoice
  | AzurePersonalVoice
  | AzureRealtimeNativeVoice
  | Record<string, unknown>;

const VOICE_CLASSES: Record<string, { modelValidate(data: unknown): unknown }> = {
  openai: OpenAIVoice,
  "azure-standard": AzureStandardVoice,
  "azure-custom": AzureCustomVoice,
  "azure-personal": AzurePersonalVoice,
  "azure-realtime-native": AzureRealtimeNativeVoice,
};

/** Resolve wire data into the voice model its `type` names, or keep it as a dict. */
const voice: Resolver = (value) => {
  if (!isPlainObject(value)) return value;
  const cls = typeof value.type === "string" ? VOICE_CLASSES[value.type] : undefined;
  if (!cls) return value;
  try {
    return cls.modelValidate(value);
  } catch (e) {
    rethrowIfCancelled(e);
    return value;
  }
};

//
// Turn detection
//

export interface EndOfUtteranceDetectionOptions {
  model?: string | null;
  threshold?: number | null;
  timeoutMs?: number | null;
}

/**
 * Semantic end-of-turn detection layered on top of a VAD.
 *
 * - `model`: detection model to use, e.g. "semantic_detection_v1".
 * - `threshold`: confidence above which the turn is considered finished.
 * - `timeoutMs`: how long to keep waiting for the turn to finish.
 */
export class EndOfUtteranceDetection extends BaseModel {
  model: string | null;
  threshold: number | null;
  timeoutMs: number | null;

  constructor(options: EndOfUtteranceDetectionOptions = {}) {
    super();
    this.model = options.model ?? null;
    this.threshold = options.threshold ?? null;
    this.timeoutMs = options.timeoutMs ?? null;
  }
}

/** A server-side turn detection strategy. */
export type TurnDetectionType =
  | "server_vad"
  | "semantic_vad"
  | "azure_semantic_vad"
  | "azure_semantic_vad_multilingual";

export interface TurnDetectionOptions {
  type?: TurnDetectionType | null;
  threshold?: number | null;
  prefixPaddingMs?: number | null;
  silenceDurationMs?: number | null;
  speechDurationMs?: number | null;
  createResponse?: boolean | null;
  interruptResponse?: boolean | null;
  autoTruncate?: boolean | null;
  removeFillerWords?: boolean | null;
  eagerness?: "auto" | "low" | "high" | null;
  endOfUtteranceDetection?: EndOfUtteranceDetection | null;
  languages?: string[] | null;
}

/**
 * Server-side turn detection configuration.
 *
 * The `azure_semantic_vad` types weigh what was said as well as whether
 * anyone is speaking, so a mid-sentence pause doesn't end the turn.
 *
 * - `type`: detection strategy to use. "semantic_vad" needs a native-audio
 *   model such as "gpt-realtime".
 * - `threshold`: speech probability above which audio counts as speech.
 * - `prefixPaddingMs`: audio to keep from before speech was detected.
 * - `silenceDurationMs`: silence that ends a turn.
 * - `speechDurationMs`: speech required before a turn starts.
 * - `createResponse`: whether the service responds when a turn ends.
 * - `interruptResponse`: whether caller speech interrupts the response.
 * - `autoTruncate`: whether an interrupted response is truncated in the
 *   conversation history.
 * - `removeFillerWords`: whether fillers ("um", "uh") are dropped from
 *   transcription.
 * - `eagerness`: how readily a semantic VAD decides the turn is over.
 * - `endOfUtteranceDetection`: semantic end-of-turn detection settings.
 * - `languages`: languages to detect, for multilingual semantic VAD.
 */
export class TurnDetection extends BaseModel {
  static override _nested: Record<string, Resolver> = {
    endOfUtteranceDetection: model(EndOfUtteranceDetection),
  };

  type: TurnDetectionType | null;
  threshold: number | null;
  prefixPaddingMs: number | null;
  silenceDurationMs: number | null;
  speechDurationMs: number | null;
  createResponse: boolean | null;
  interruptResponse: boolean | null;
  autoTruncate: boolean | null;
  removeFillerWords: boolean | null;
  eagerness: "auto" | "low" | "high" | null;
  endOfUtteranceDetection: EndOfUtteranceDetection | null;
  languages: string[] | null;

  constructor(options: TurnDetectionOptions = {}) {
    super();
    this.type = options.type === undefined ? "azure_semantic_vad" : options.type;
    this.threshold = options.threshold ?? null;
    this.prefixPaddingMs = options.prefixPaddingMs ?? null;
    this.silenceDurationMs = options.silenceDurationMs ?? null;
    this.speechDurationMs = options.speechDurationMs ?? null;
    this.createResponse = options.createResponse ?? null;
    this.interruptResponse = options.interruptResponse ?? null;
    this.autoTruncate = options.autoTruncate ?? null;
    this.removeFillerWords = options.removeFillerWords ?? null;
    this.eagerness = options.eagerness ?? null;
    this.endOfUtteranceDetection = options.endOfUtteranceDetection ?? null;
    this.languages = options.languages ?? null;
  }
}

//
// Audio input processing
//

export interface InputAudioNoiseReductionOptions {
  type?: "near_field" | "far_field" | "azure_deep_noise_suppression";
}

/**
 * Noise suppression applied to incoming audio.
 *
 * - `type`: suppression model to apply.
 */
export class InputAudioNoiseReduction extends BaseModel {
  type: "near_field" | "far_field" | "azure_deep_noise_suppression";

  constructor(options: InputAudioNoiseReductionOptions = {}) {
    super();
    this.type = options.type ?? "azure_deep_noise_suppression";
  }
}

export interface InputAudioEchoCancellationOptions {
  type?: "server_echo_cancellation";
  referenceSource?: "server" | "client" | null;
  channels?: number | null;
}

/**
 * Echo cancellation applied to incoming audio.
 *
 * Keeps the agent from hearing its own playback. With `referenceSource` set
 * to "client", the caller sends its own playback as a second channel and
 * `channels` must be 2.
 *
 * - `type`: cancellation model, always "server_echo_cancellation".
 * - `referenceSource`: where the reference signal comes from.
 * - `channels`: channels in the incoming audio: 1 for microphone only, 2 when
 *   playback is supplied alongside it.
 */
export class InputAudioEchoCancellation extends BaseModel {
  type = "server_echo_cancellation" as const;
  referenceSource: "server" | "client" | null;
  channels: number | null;

  constructor(options: InputAudioEchoCancellationOptions = {}) {
    super();
    this.referenceSource = options.referenceSource ?? null;
    this.channels = options.channels ?? null;
  }
}

/** A transcription model Voice Live accepts. */
export type InputAudioTranscriptionModel =
  | "whisper-1"
  | "gpt-4o-transcribe"
  | "gpt-4o-mini-transcribe"
  | "gpt-4o-transcribe-diarize"
  | "azure-speech"
  | "azure-mrs"
  | "mai-transcribe"
  | "mai-transcribe-1"
  | "mai-transcribe-1.5"
  | "mai-transcribe-2"
  | "mai-transcribe-2-streaming"
  | "mai-transcribe-medical";

export interface InputAudioTranscriptionOptions {
  model?: InputAudioTranscriptionModel | null;
  language?: string | null;
  phraseList?: string[] | null;
  prompt?: string | null;
  customSpeech?: Record<string, unknown> | null;
}

/**
 * Transcription of the caller's audio.
 *
 * - `model`: transcription model to use. The OpenAI models ("whisper-1" and
 *   the "gpt-4o-*" models) need a native-audio model such as
 *   "gpt-realtime"; other models accept only the Azure ones.
 * - `language`: language to transcribe, as BCP-47 or ISO 639-1.
 * - `phraseList`: words and phrases to bias recognition toward.
 * - `prompt`: prompt steering transcription, for models that accept one.
 * - `customSpeech`: custom speech model deployments, keyed by locale.
 */
export class InputAudioTranscription extends BaseModel {
  model: InputAudioTranscriptionModel | null;
  language: string | null;
  phraseList: string[] | null;
  prompt: string | null;
  customSpeech: Record<string, unknown> | null;

  constructor(options: InputAudioTranscriptionOptions = {}) {
    super();
    this.model = options.model ?? null;
    this.language = options.language ?? null;
    this.phraseList = options.phraseList ?? null;
    this.prompt = options.prompt ?? null;
    this.customSpeech = options.customSpeech ?? null;
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
  type = "function" as const;
  name: string;
  description: string;
  parameters: Record<string, unknown>;

  constructor(options: FunctionToolOptions) {
    super();
    this.name = required(options, "name", "FunctionTool");
    this.description = required(options, "description", "FunctionTool");
    this.parameters = required(options, "parameters", "FunctionTool");
  }
}

/** A tool definition Voice Live accepts. */
export type VoiceLiveTool = FunctionTool | Record<string, unknown>;

//
// Session properties
//

/** The tools a session can carry. */
export type SessionTools = ToolsSchema | (FunctionSchema | DirectFunction)[] | VoiceLiveTool[];

export interface SessionPropertiesOptions {
  model?: string | null;
  instructions?: string | null;
  modalities?: Modality[] | null;
  voice?: Voice | null;
  inputAudioFormat?: InputAudioFormat | null;
  outputAudioFormat?: OutputAudioFormat | null;
  inputAudioSamplingRate?: number | null;
  turnDetection?: TurnDetection | boolean | null;
  inputAudioTranscription?: InputAudioTranscription | null;
  inputAudioNoiseReduction?: InputAudioNoiseReduction | null;
  inputAudioEchoCancellation?: InputAudioEchoCancellation | null;
  temperature?: number | null;
  maxResponseOutputTokens?: number | "inf" | null;
  tools?: SessionTools | null;
  toolChoice?: string | null;
}

// The fields set on each SessionProperties (pydantic's `model_fields_set`),
// kept off the instance so they are not taken for declared fields.
const fieldsSet = new WeakMap<object, Set<string>>();

/**
 * Make each field of `obj` an accessor that records assignments in the
 * instance's set fields, as pydantic's `__setattr__` does.
 */
function trackFieldsSet(obj: object, names: readonly string[], initial: Iterable<string>): void {
  const set = new Set(initial);
  fieldsSet.set(obj, set);
  const self = obj as Record<string, unknown>;
  for (const name of names) {
    let value = self[name];
    Object.defineProperty(obj, name, {
      enumerable: true,
      configurable: true,
      get: () => value,
      set: (v: unknown) => {
        value = v;
        set.add(name);
      },
    });
  }
}

/**
 * Configuration properties for a Voice Live session.
 *
 * Voice Live carries audio settings directly on the session rather than
 * nesting them under an `audio` object.
 *
 * - `model`: model backing the session, e.g. "gpt-4o-mini". Usually named in
 *   the connection URL instead.
 * - `instructions`: system instructions for the assistant.
 * - `modalities`: modalities the assistant responds with.
 * - `voice`: voice used for audio responses.
 * - `inputAudioFormat`: encoding of the audio sent to the service.
 * - `outputAudioFormat`: encoding of the audio returned by the service.
 * - `inputAudioSamplingRate`: sample rate of the audio sent to the service.
 * - `turnDetection`: turn detection settings, or null/false to disable the
 *   service's own turn detection.
 * - `inputAudioTranscription`: transcription settings for caller audio.
 * - `inputAudioNoiseReduction`: noise suppression settings.
 * - `inputAudioEchoCancellation`: echo cancellation settings.
 * - `temperature`: sampling temperature for responses.
 * - `maxResponseOutputTokens`: output token ceiling per response, or "inf".
 * - `tools`: tools the assistant may call.
 * - `toolChoice`: how the assistant picks among tools.
 */
export class SessionProperties extends BaseModel {
  static override _nested: Record<string, Resolver> = {
    voice,
    turnDetection: (value) =>
      value === null || typeof value === "boolean" ? value : TurnDetection.modelValidate(value),
    inputAudioTranscription: model(InputAudioTranscription),
    inputAudioNoiseReduction: model(InputAudioNoiseReduction),
    inputAudioEchoCancellation: model(InputAudioEchoCancellation),
  };

  /** The model's fields (pydantic's `model_fields`): camelCase field name to wire key. */
  static readonly modelFields: Readonly<Record<string, string>> = {
    model: "model",
    instructions: "instructions",
    modalities: "modalities",
    voice: "voice",
    inputAudioFormat: "input_audio_format",
    outputAudioFormat: "output_audio_format",
    inputAudioSamplingRate: "input_audio_sampling_rate",
    turnDetection: "turn_detection",
    inputAudioTranscription: "input_audio_transcription",
    inputAudioNoiseReduction: "input_audio_noise_reduction",
    inputAudioEchoCancellation: "input_audio_echo_cancellation",
    temperature: "temperature",
    maxResponseOutputTokens: "max_response_output_tokens",
    tools: "tools",
    toolChoice: "tool_choice",
  };

  declare model: string | null;
  declare instructions: string | null;
  declare modalities: Modality[] | null;
  declare voice: Voice | null;
  declare inputAudioFormat: InputAudioFormat | null;
  declare outputAudioFormat: OutputAudioFormat | null;
  declare inputAudioSamplingRate: number | null;
  declare turnDetection: TurnDetection | boolean | null;
  declare inputAudioTranscription: InputAudioTranscription | null;
  declare inputAudioNoiseReduction: InputAudioNoiseReduction | null;
  declare inputAudioEchoCancellation: InputAudioEchoCancellation | null;
  declare temperature: number | null;
  declare maxResponseOutputTokens: number | "inf" | null;
  // Tools provided by the user may be a ToolsSchema or a plain list of
  // standard tools (normalized to a ToolsSchema on construction); a list of
  // provider-native VoiceLiveTool objects passes through.
  declare tools: SessionTools | null;
  declare toolChoice: string | null;

  constructor(options: SessionPropertiesOptions = {}) {
    super();
    const self = this as unknown as Record<string, unknown>;
    const given = options as Record<string, unknown>;
    for (const name of Object.keys(SessionProperties.modelFields)) {
      self[name] = given[name] ?? null;
    }
    this.tools = SessionProperties._normalizeTools(options.tools ?? null);
    trackFieldsSet(
      this,
      Object.keys(SessionProperties.modelFields),
      Object.keys(SessionProperties.modelFields).filter((name) => given[name] !== undefined),
    );
  }

  /**
   * The fields given to the constructor or assigned since (pydantic's
   * `model_fields_set`), by camelCase field name.
   */
  get modelFieldsSet(): ReadonlySet<string> {
    return fieldsSet.get(this) ?? new Set();
  }

  override modelCopy(options: { update?: Record<string, unknown> } = {}): this {
    const copy = super.modelCopy(options);
    trackFieldsSet(copy, Object.keys(SessionProperties.modelFields), [
      ...this.modelFieldsSet,
      ...Object.keys(options.update ?? {}),
    ]);
    return copy;
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

export interface ItemContentOptions {
  type: "input_text" | "input_audio" | "text" | "audio";
  text?: string | null;
  audio?: string | null;
  transcript?: string | null;
}

/**
 * A single piece of content within a conversation item.
 *
 * - `type`: content type.
 * - `text`: text content, for text parts.
 * - `audio`: base64-encoded audio, for audio parts.
 * - `transcript`: transcript of the audio, for audio parts.
 */
export class ItemContent extends BaseModel {
  type: "input_text" | "input_audio" | "text" | "audio";
  text: string | null;
  audio: string | null;
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
  id?: string | null;
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
 * An item in the conversation history.
 *
 * - `id`: identifier of the item, assigned by the service when absent.
 * - `object`: object type, always "realtime.item".
 * - `type`: kind of item this is.
 * - `status`: whether the item is finished.
 * - `role`: who the item belongs to, for message items.
 * - `content`: content parts, for message items.
 * - `callId`: identifier tying a call to its output.
 * - `name`: function name, for function call items.
 * - `arguments`: JSON-encoded arguments, for function call items.
 * - `output`: JSON-encoded result, for function call output items.
 */
export class ConversationItem extends BaseModel {
  static override _nested: Record<string, Resolver> = {
    content: listOf(model(ItemContent)),
  };

  id: string | null;
  object: "realtime.item" | null;
  type: "message" | "function_call" | "function_call_output";
  status: "completed" | "in_progress" | "incomplete" | null;
  role: "user" | "assistant" | "system" | null;
  content: ItemContent[] | null;
  callId: string | null;
  name: string | null;
  arguments: string | null;
  output: string | null;

  constructor(options: ConversationItemOptions) {
    super();
    this.id = options.id ?? null;
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

export interface ResponsePropertiesOptions {
  modalities?: Modality[] | null;
  instructions?: string | null;
  voice?: Voice | null;
  temperature?: number | null;
  maxOutputTokens?: number | "inf" | null;
  tools?: VoiceLiveTool[] | null;
  toolChoice?: string | null;
}

/**
 * Overrides applied to a single response.
 *
 * - `modalities`: modalities this response uses.
 * - `instructions`: instructions for this response only.
 * - `voice`: voice for this response only.
 * - `temperature`: sampling temperature for this response.
 * - `maxOutputTokens`: output token ceiling for this response, or "inf".
 * - `tools`: tools available to this response.
 * - `toolChoice`: how this response picks among tools.
 */
export class ResponseProperties extends BaseModel {
  static override _nested: Record<string, Resolver> = { voice };

  modalities: Modality[] | null;
  instructions: string | null;
  voice: Voice | null;
  temperature: number | null;
  maxOutputTokens: number | "inf" | null;
  tools: VoiceLiveTool[] | null;
  toolChoice: string | null;

  constructor(options: ResponsePropertiesOptions = {}) {
    super();
    this.modalities = options.modalities ?? null;
    this.instructions = options.instructions ?? null;
    this.voice = options.voice ?? null;
    this.temperature = options.temperature ?? null;
    this.maxOutputTokens = options.maxOutputTokens ?? null;
    this.tools = options.tools ?? null;
    this.toolChoice = options.toolChoice ?? null;
  }
}

export interface TokenUsageDetailsOptions {
  cachedTokens?: number | null;
  textTokens?: number | null;
  audioTokens?: number | null;
}

/**
 * Per-modality breakdown of token usage.
 *
 * - `cachedTokens`: tokens served from cache.
 * - `textTokens`: tokens attributable to text.
 * - `audioTokens`: tokens attributable to audio.
 */
export class TokenUsageDetails extends BaseModel {
  cachedTokens: number | null;
  textTokens: number | null;
  audioTokens: number | null;

  constructor(options: TokenUsageDetailsOptions = {}) {
    super();
    this.cachedTokens = options.cachedTokens ?? null;
    this.textTokens = options.textTokens ?? null;
    this.audioTokens = options.audioTokens ?? null;
  }
}

export interface TokenUsageOptions {
  totalTokens?: number | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  inputTokenDetails?: TokenUsageDetails | null;
  outputTokenDetails?: TokenUsageDetails | null;
}

/**
 * Token usage reported for a response.
 *
 * - `totalTokens`: tokens across input and output.
 * - `inputTokens`: tokens in the input.
 * - `outputTokens`: tokens in the output.
 * - `inputTokenDetails`: per-modality breakdown of the input.
 * - `outputTokenDetails`: per-modality breakdown of the output.
 */
export class TokenUsage extends BaseModel {
  static override _nested: Record<string, Resolver> = {
    inputTokenDetails: model(TokenUsageDetails),
    outputTokenDetails: model(TokenUsageDetails),
  };

  totalTokens: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  inputTokenDetails: TokenUsageDetails | null;
  outputTokenDetails: TokenUsageDetails | null;

  constructor(options: TokenUsageOptions = {}) {
    super();
    this.totalTokens = options.totalTokens ?? null;
    this.inputTokens = options.inputTokens ?? null;
    this.outputTokens = options.outputTokens ?? null;
    this.inputTokenDetails = options.inputTokenDetails ?? null;
    this.outputTokenDetails = options.outputTokenDetails ?? null;
  }
}

export interface RealtimeErrorOptions {
  type?: string | null;
  code?: string | null;
  message?: string | null;
  param?: string | null;
  eventId?: string | null;
}

/**
 * An error reported by the service.
 *
 * - `type`: error category.
 * - `code`: machine-readable error code.
 * - `message`: human-readable description.
 * - `param`: parameter the error relates to.
 * - `eventId`: client event that caused the error.
 */
export class RealtimeError extends BaseModel {
  type: string | null;
  code: string | null;
  message: string | null;
  param: string | null;
  eventId: string | null;

  constructor(options: RealtimeErrorOptions = {}) {
    super();
    this.type = options.type ?? null;
    this.code = options.code ?? null;
    this.message = options.message ?? null;
    this.param = options.param ?? null;
    this.eventId = options.eventId ?? null;
  }
}

//
// Client events (sent to Voice Live)
//

export interface ClientEventOptions {
  eventId?: string;
}

/**
 * Base class for client events sent to the Voice Live API.
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
   * Turn detection is disabled by an explicit null. Leaving the field out
   * instead keeps the service's own server VAD running, so a session that
   * set it to null or false has the null restored after `excludeNone` drops
   * it.
   *
   * @param options Options passed to the parent `modelDump`.
   * @returns Object representation of the event.
   */
  override modelDump(options: ModelDumpOptions = {}): Record<string, any> {
    const dump = super.modelDump(options);

    if (this.session.modelFieldsSet.has("turnDetection") && !this.session.turnDetection) {
      dump.session.turn_detection = null;
    }

    return dump;
  }
}

export interface InputAudioBufferAppendEventOptions extends ClientEventOptions {
  type?: "input_audio_buffer.append";
  audio: string;
}

/**
 * Event to append audio to the input buffer.
 *
 * - `type`: event type, always "input_audio_buffer.append".
 * - `audio`: base64-encoded audio to append.
 */
export class InputAudioBufferAppendEvent extends ClientEvent {
  type = "input_audio_buffer.append" as const;
  audio: string;

  constructor(options: InputAudioBufferAppendEventOptions) {
    super(options);
    this.audio = required(options, "audio", "InputAudioBufferAppendEvent");
  }
}

export interface InputAudioBufferCommitEventOptions extends ClientEventOptions {
  type?: "input_audio_buffer.commit";
}

/**
 * Event to commit the input buffer as a conversation item.
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
 * Event to discard the buffered input audio.
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
  item: ConversationItem;
  previousItemId?: string | null;
}

/**
 * Event to add an item to the conversation.
 *
 * - `type`: event type, always "conversation.item.create".
 * - `item`: the item to add.
 * - `previousItemId`: item to insert after, or null to append.
 */
export class ConversationItemCreateEvent extends ClientEvent {
  static override _nested: Record<string, Resolver> = { item: model(ConversationItem) };

  type = "conversation.item.create" as const;
  item: ConversationItem;
  previousItemId: string | null;

  constructor(options: ConversationItemCreateEventOptions) {
    super(options);
    this.item = required(options, "item", "ConversationItemCreateEvent");
    this.previousItemId = options.previousItemId ?? null;
  }
}

export interface ConversationItemTruncateEventOptions extends ClientEventOptions {
  type?: "conversation.item.truncate";
  itemId: string;
  contentIndex?: number;
  audioEndMs?: number;
}

/**
 * Event to truncate an assistant audio item the caller interrupted.
 *
 * - `type`: event type, always "conversation.item.truncate".
 * - `itemId`: item to truncate.
 * - `contentIndex`: content part to truncate.
 * - `audioEndMs`: point, in milliseconds, to truncate the audio at.
 */
export class ConversationItemTruncateEvent extends ClientEvent {
  type = "conversation.item.truncate" as const;
  itemId: string;
  contentIndex: number;
  audioEndMs: number;

  constructor(options: ConversationItemTruncateEventOptions) {
    super(options);
    this.itemId = required(options, "itemId", "ConversationItemTruncateEvent");
    this.contentIndex = options.contentIndex ?? 0;
    this.audioEndMs = options.audioEndMs ?? 0;
  }
}

export interface ResponseCreateEventOptions extends ClientEventOptions {
  type?: "response.create";
  response?: ResponseProperties | null;
}

/**
 * Event asking the model to respond.
 *
 * - `type`: event type, always "response.create".
 * - `response`: overrides applied to this response.
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
 * Event to cancel the response in progress.
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
// Server events (received from Voice Live)
//

export interface ServerEventOptions {
  eventId?: string | null;
  type: string;
}

/**
 * Base class for server events received from the Voice Live API.
 *
 * - `eventId`: unique identifier assigned by the service.
 */
export class ServerEvent extends BaseModel {
  eventId: string | null;
  type: string;

  constructor(options: ServerEventOptions) {
    super();
    this.eventId = options.eventId ?? null;
    this.type = required(options, "type", new.target.name);
  }
}

export interface SessionCreatedEventOptions extends ServerEventOptions {
  type: "session.created";
  session: Record<string, any>;
}

/**
 * Event reporting that the session is open.
 *
 * - `type`: event type, always "session.created".
 * - `session`: the session as created.
 */
export class SessionCreatedEvent extends ServerEvent {
  declare type: "session.created";
  session: Record<string, any>;

  constructor(options: SessionCreatedEventOptions) {
    super(options);
    this.type = literal(options.type, "session.created", "SessionCreatedEvent");
    this.session = required(options, "session", "SessionCreatedEvent");
  }
}

export interface SessionUpdatedEventOptions extends ServerEventOptions {
  type: "session.updated";
  session: Record<string, any>;
}

/**
 * Event reporting that the session configuration was applied.
 *
 * - `type`: event type, always "session.updated".
 * - `session`: the session as updated.
 */
export class SessionUpdatedEvent extends ServerEvent {
  declare type: "session.updated";
  session: Record<string, any>;

  constructor(options: SessionUpdatedEventOptions) {
    super(options);
    this.type = literal(options.type, "session.updated", "SessionUpdatedEvent");
    this.session = required(options, "session", "SessionUpdatedEvent");
  }
}

export interface ConversationItemCreatedOptions extends ServerEventOptions {
  type: "conversation.item.created";
  item: ConversationItem;
  previousItemId?: string | null;
}

/**
 * Event reporting that an item was added to the conversation.
 *
 * - `type`: event type, always "conversation.item.created".
 * - `item`: the item that was added.
 * - `previousItemId`: item it was inserted after.
 */
export class ConversationItemCreated extends ServerEvent {
  static override _nested: Record<string, Resolver> = { item: model(ConversationItem) };

  declare type: "conversation.item.created";
  item: ConversationItem;
  previousItemId: string | null;

  constructor(options: ConversationItemCreatedOptions) {
    super(options);
    this.type = literal(options.type, "conversation.item.created", "ConversationItemCreated");
    this.item = required(options, "item", "ConversationItemCreated");
    this.previousItemId = options.previousItemId ?? null;
  }
}

export interface ConversationItemInputAudioTranscriptionDeltaOptions extends ServerEventOptions {
  type: "conversation.item.input_audio_transcription.delta";
  itemId: string;
  contentIndex?: number;
  delta?: string | null;
}

/**
 * Event carrying part of a caller transcript.
 *
 * - `type`: event type, always
 *   "conversation.item.input_audio_transcription.delta".
 * - `itemId`: item being transcribed.
 * - `contentIndex`: content part being transcribed.
 * - `delta`: transcript text for this update.
 */
export class ConversationItemInputAudioTranscriptionDelta extends ServerEvent {
  declare type: "conversation.item.input_audio_transcription.delta";
  itemId: string;
  contentIndex: number;
  delta: string | null;

  constructor(options: ConversationItemInputAudioTranscriptionDeltaOptions) {
    super(options);
    this.type = literal(
      options.type,
      "conversation.item.input_audio_transcription.delta",
      "ConversationItemInputAudioTranscriptionDelta",
    );
    this.itemId = required(options, "itemId", "ConversationItemInputAudioTranscriptionDelta");
    this.contentIndex = options.contentIndex ?? 0;
    this.delta = options.delta ?? null;
  }
}

export interface ConversationItemInputAudioTranscriptionCompletedOptions
  extends ServerEventOptions {
  type: "conversation.item.input_audio_transcription.completed";
  itemId: string;
  contentIndex?: number;
  transcript?: string;
}

/**
 * Event carrying a finished caller transcript.
 *
 * - `type`: event type, always
 *   "conversation.item.input_audio_transcription.completed".
 * - `itemId`: item that was transcribed.
 * - `contentIndex`: content part that was transcribed.
 * - `transcript`: the finished transcript.
 */
export class ConversationItemInputAudioTranscriptionCompleted extends ServerEvent {
  declare type: "conversation.item.input_audio_transcription.completed";
  itemId: string;
  contentIndex: number;
  transcript: string;

  constructor(options: ConversationItemInputAudioTranscriptionCompletedOptions) {
    super(options);
    this.type = literal(
      options.type,
      "conversation.item.input_audio_transcription.completed",
      "ConversationItemInputAudioTranscriptionCompleted",
    );
    this.itemId = required(options, "itemId", "ConversationItemInputAudioTranscriptionCompleted");
    this.contentIndex = options.contentIndex ?? 0;
    this.transcript = options.transcript ?? "";
  }
}

export interface ConversationItemInputAudioTranscriptionFailedOptions extends ServerEventOptions {
  type: "conversation.item.input_audio_transcription.failed";
  itemId: string;
  contentIndex?: number;
  error?: RealtimeError | null;
}

/**
 * Event reporting that a caller transcript could not be produced.
 *
 * - `type`: event type, always
 *   "conversation.item.input_audio_transcription.failed".
 * - `itemId`: item that failed to transcribe.
 * - `contentIndex`: content part that failed to transcribe.
 * - `error`: why transcription failed.
 */
export class ConversationItemInputAudioTranscriptionFailed extends ServerEvent {
  static override _nested: Record<string, Resolver> = { error: model(RealtimeError) };

  declare type: "conversation.item.input_audio_transcription.failed";
  itemId: string;
  contentIndex: number;
  error: RealtimeError | null;

  constructor(options: ConversationItemInputAudioTranscriptionFailedOptions) {
    super(options);
    this.type = literal(
      options.type,
      "conversation.item.input_audio_transcription.failed",
      "ConversationItemInputAudioTranscriptionFailed",
    );
    this.itemId = required(options, "itemId", "ConversationItemInputAudioTranscriptionFailed");
    this.contentIndex = options.contentIndex ?? 0;
    this.error = options.error ?? null;
  }
}

export interface InputAudioBufferSpeechStartedOptions extends ServerEventOptions {
  type: "input_audio_buffer.speech_started";
  audioStartMs?: number | null;
  itemId?: string | null;
}

/**
 * Event reporting that the caller started speaking.
 *
 * - `type`: event type, always "input_audio_buffer.speech_started".
 * - `audioStartMs`: where in the buffered audio speech began.
 * - `itemId`: item the speech belongs to.
 */
export class InputAudioBufferSpeechStarted extends ServerEvent {
  declare type: "input_audio_buffer.speech_started";
  audioStartMs: number | null;
  itemId: string | null;

  constructor(options: InputAudioBufferSpeechStartedOptions) {
    super(options);
    this.type = literal(
      options.type,
      "input_audio_buffer.speech_started",
      "InputAudioBufferSpeechStarted",
    );
    this.audioStartMs = options.audioStartMs ?? null;
    this.itemId = options.itemId ?? null;
  }
}

export interface InputAudioBufferSpeechStoppedOptions extends ServerEventOptions {
  type: "input_audio_buffer.speech_stopped";
  audioEndMs?: number | null;
  itemId?: string | null;
}

/**
 * Event reporting that the caller stopped speaking.
 *
 * - `type`: event type, always "input_audio_buffer.speech_stopped".
 * - `audioEndMs`: where in the buffered audio speech ended.
 * - `itemId`: item the speech belongs to.
 */
export class InputAudioBufferSpeechStopped extends ServerEvent {
  declare type: "input_audio_buffer.speech_stopped";
  audioEndMs: number | null;
  itemId: string | null;

  constructor(options: InputAudioBufferSpeechStoppedOptions) {
    super(options);
    this.type = literal(
      options.type,
      "input_audio_buffer.speech_stopped",
      "InputAudioBufferSpeechStopped",
    );
    this.audioEndMs = options.audioEndMs ?? null;
    this.itemId = options.itemId ?? null;
  }
}

export interface ResponseCreatedOptions extends ServerEventOptions {
  type: "response.created";
  response: Record<string, any>;
}

/**
 * Event reporting that a response has begun.
 *
 * - `type`: event type, always "response.created".
 * - `response`: the response as created.
 */
export class ResponseCreated extends ServerEvent {
  declare type: "response.created";
  response: Record<string, any>;

  constructor(options: ResponseCreatedOptions) {
    super(options);
    this.type = literal(options.type, "response.created", "ResponseCreated");
    this.response = required(options, "response", "ResponseCreated");
  }
}

export interface ResponseDoneOptions extends ServerEventOptions {
  type: "response.done";
  response: Record<string, any>;
}

/**
 * Event reporting that a response has finished.
 *
 * - `type`: event type, always "response.done".
 * - `response`: the finished response, including status and token usage.
 */
export class ResponseDone extends ServerEvent {
  declare type: "response.done";
  response: Record<string, any>;

  constructor(options: ResponseDoneOptions) {
    super(options);
    this.type = literal(options.type, "response.done", "ResponseDone");
    this.response = required(options, "response", "ResponseDone");
  }

  /** Status the response finished with. */
  get status(): string | null {
    return this.response.status ?? null;
  }

  /** Token usage reported for the response, when present. */
  get usage(): TokenUsage | null {
    const usage = this.response.usage;
    return usage ? TokenUsage.modelValidate(usage) : null;
  }
}

export interface ResponseOutputItemAddedOptions extends ServerEventOptions {
  type: "response.output_item.added";
  responseId?: string | null;
  outputIndex?: number;
  item: ConversationItem;
}

/**
 * Event reporting that an output item was added to a response.
 *
 * - `type`: event type, always "response.output_item.added".
 * - `responseId`: response the item belongs to.
 * - `outputIndex`: position of the item in the output.
 * - `item`: the item that was added.
 */
export class ResponseOutputItemAdded extends ServerEvent {
  static override _nested: Record<string, Resolver> = { item: model(ConversationItem) };

  declare type: "response.output_item.added";
  responseId: string | null;
  outputIndex: number;
  item: ConversationItem;

  constructor(options: ResponseOutputItemAddedOptions) {
    super(options);
    this.type = literal(options.type, "response.output_item.added", "ResponseOutputItemAdded");
    this.responseId = options.responseId ?? null;
    this.outputIndex = options.outputIndex ?? 0;
    this.item = required(options, "item", "ResponseOutputItemAdded");
  }
}

interface ResponseContentEventOptions extends ServerEventOptions {
  responseId?: string | null;
  itemId?: string | null;
  outputIndex?: number;
  contentIndex?: number;
}

export interface ResponseTextDeltaOptions extends ResponseContentEventOptions {
  type: "response.text.delta";
  delta?: string;
}

/**
 * Event carrying part of a text response.
 *
 * - `type`: event type, always "response.text.delta".
 * - `responseId`: response the text belongs to.
 * - `itemId`: item the text belongs to.
 * - `outputIndex`: position of the item in the output.
 * - `contentIndex`: position of the part within the item.
 * - `delta`: text for this update.
 */
export class ResponseTextDelta extends ServerEvent {
  declare type: "response.text.delta";
  responseId: string | null;
  itemId: string | null;
  outputIndex: number;
  contentIndex: number;
  delta: string;

  constructor(options: ResponseTextDeltaOptions) {
    super(options);
    this.type = literal(options.type, "response.text.delta", "ResponseTextDelta");
    this.responseId = options.responseId ?? null;
    this.itemId = options.itemId ?? null;
    this.outputIndex = options.outputIndex ?? 0;
    this.contentIndex = options.contentIndex ?? 0;
    this.delta = options.delta ?? "";
  }
}

export interface ResponseAudioDeltaOptions extends ResponseContentEventOptions {
  type: "response.audio.delta";
  delta?: string;
}

/**
 * Event carrying part of an audio response.
 *
 * - `type`: event type, always "response.audio.delta".
 * - `responseId`: response the audio belongs to.
 * - `itemId`: item the audio belongs to.
 * - `outputIndex`: position of the item in the output.
 * - `contentIndex`: position of the part within the item.
 * - `delta`: base64-encoded audio for this update.
 */
export class ResponseAudioDelta extends ServerEvent {
  declare type: "response.audio.delta";
  responseId: string | null;
  itemId: string | null;
  outputIndex: number;
  contentIndex: number;
  delta: string;

  constructor(options: ResponseAudioDeltaOptions) {
    super(options);
    this.type = literal(options.type, "response.audio.delta", "ResponseAudioDelta");
    this.responseId = options.responseId ?? null;
    this.itemId = options.itemId ?? null;
    this.outputIndex = options.outputIndex ?? 0;
    this.contentIndex = options.contentIndex ?? 0;
    this.delta = options.delta ?? "";
  }
}

export interface ResponseAudioDoneOptions extends ResponseContentEventOptions {
  type: "response.audio.done";
}

/**
 * Event reporting that an audio response is finished.
 *
 * - `type`: event type, always "response.audio.done".
 * - `responseId`: response the audio belongs to.
 * - `itemId`: item the audio belongs to.
 * - `outputIndex`: position of the item in the output.
 * - `contentIndex`: position of the part within the item.
 */
export class ResponseAudioDone extends ServerEvent {
  declare type: "response.audio.done";
  responseId: string | null;
  itemId: string | null;
  outputIndex: number;
  contentIndex: number;

  constructor(options: ResponseAudioDoneOptions) {
    super(options);
    this.type = literal(options.type, "response.audio.done", "ResponseAudioDone");
    this.responseId = options.responseId ?? null;
    this.itemId = options.itemId ?? null;
    this.outputIndex = options.outputIndex ?? 0;
    this.contentIndex = options.contentIndex ?? 0;
  }
}

export interface ResponseAudioTranscriptDeltaOptions extends ResponseContentEventOptions {
  type: "response.audio_transcript.delta";
  delta?: string;
}

/**
 * Event carrying part of the transcript of an audio response.
 *
 * - `type`: event type, always "response.audio_transcript.delta".
 * - `responseId`: response the transcript belongs to.
 * - `itemId`: item the transcript belongs to.
 * - `outputIndex`: position of the item in the output.
 * - `contentIndex`: position of the part within the item.
 * - `delta`: transcript text for this update.
 */
export class ResponseAudioTranscriptDelta extends ServerEvent {
  declare type: "response.audio_transcript.delta";
  responseId: string | null;
  itemId: string | null;
  outputIndex: number;
  contentIndex: number;
  delta: string;

  constructor(options: ResponseAudioTranscriptDeltaOptions) {
    super(options);
    this.type = literal(
      options.type,
      "response.audio_transcript.delta",
      "ResponseAudioTranscriptDelta",
    );
    this.responseId = options.responseId ?? null;
    this.itemId = options.itemId ?? null;
    this.outputIndex = options.outputIndex ?? 0;
    this.contentIndex = options.contentIndex ?? 0;
    this.delta = options.delta ?? "";
  }
}

export interface ResponseFunctionCallArgumentsDoneOptions extends ServerEventOptions {
  type: "response.function_call_arguments.done";
  responseId?: string | null;
  itemId?: string | null;
  outputIndex?: number;
  callId?: string | null;
  name?: string | null;
  arguments?: string;
}

/**
 * Event carrying a function call's finished arguments.
 *
 * - `type`: event type, always "response.function_call_arguments.done".
 * - `responseId`: response the call belongs to.
 * - `itemId`: item the call belongs to.
 * - `outputIndex`: position of the item in the output.
 * - `callId`: identifier tying the call to its output.
 * - `name`: function being called.
 * - `arguments`: JSON-encoded arguments.
 */
export class ResponseFunctionCallArgumentsDone extends ServerEvent {
  declare type: "response.function_call_arguments.done";
  responseId: string | null;
  itemId: string | null;
  outputIndex: number;
  callId: string | null;
  name: string | null;
  arguments: string;

  constructor(options: ResponseFunctionCallArgumentsDoneOptions) {
    super(options);
    this.type = literal(
      options.type,
      "response.function_call_arguments.done",
      "ResponseFunctionCallArgumentsDone",
    );
    this.responseId = options.responseId ?? null;
    this.itemId = options.itemId ?? null;
    this.outputIndex = options.outputIndex ?? 0;
    this.callId = options.callId ?? null;
    this.name = options.name ?? null;
    this.arguments = options.arguments ?? "";
  }
}

export interface ErrorEventOptions extends ServerEventOptions {
  type: "error";
  error: RealtimeError;
}

/**
 * Event reporting that an error occurred.
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
  "session.created": SessionCreatedEvent,
  "session.updated": SessionUpdatedEvent,
  "conversation.item.created": ConversationItemCreated,
  "conversation.item.input_audio_transcription.delta": ConversationItemInputAudioTranscriptionDelta,
  "conversation.item.input_audio_transcription.completed":
    ConversationItemInputAudioTranscriptionCompleted,
  "conversation.item.input_audio_transcription.failed":
    ConversationItemInputAudioTranscriptionFailed,
  "input_audio_buffer.speech_started": InputAudioBufferSpeechStarted,
  "input_audio_buffer.speech_stopped": InputAudioBufferSpeechStopped,
  "response.created": ResponseCreated,
  "response.done": ResponseDone,
  "response.output_item.added": ResponseOutputItemAdded,
  "response.text.delta": ResponseTextDelta,
  "response.audio.delta": ResponseAudioDelta,
  "response.audio.done": ResponseAudioDone,
  "response.audio_transcript.delta": ResponseAudioTranscriptDelta,
  "response.function_call_arguments.done": ResponseFunctionCallArgumentsDone,
};

/**
 * Parse a server event from JSON.
 *
 * @param data JSON text containing the server event, as delivered by the
 *   websocket.
 * @returns Parsed server event object of the appropriate type, or `null` if
 *   the event type is not recognized (e.g. an avatar or animation event, or a
 *   newer server event without a model).
 * @throws Error If a recognized event type fails to parse.
 */
export function parseServerEvent(data: string | Uint8Array): ServerEvent | null {
  const text = typeof data === "string" ? data : new TextDecoder().decode(data);
  const event = pyJsonLoads(text);
  if (!isPlainObject(event) || !("type" in event)) {
    // Python's KeyError for the missing key.
    throw new Error("'type'");
  }
  const eventType = event.type;
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
