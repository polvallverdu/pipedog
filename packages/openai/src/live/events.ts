// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/services/openai/live/events.py

/**
 * Event and session models for the OpenAI Live API (WebSocket transport).
 *
 * The Live API is a full-duplex speech-to-speech API: the model listens and
 * speaks at the same time and decides on its own when to talk. Clients start a
 * session, stream audio in, receive audio and transcript events out, and answer
 * the model's *delegations* (units of work it hands to a backend model).
 *
 * Server events are parsed leniently: unrecognised fields are kept, and event
 * types this module doesn't model become `UnknownServerEvent` rather than
 * errors, so an addition to the API doesn't break the receive loop.
 *
 * Porting notes:
 * - Upstream models are pydantic `BaseModel`s. Here each model extends the
 *   small `LiveModel` below: fields are camelCase and the constructor takes
 *   one options object (validated like pydantic, throwing
 *   `LiveModelValidationError`), while `modelValidate()` reads and
 *   `modelDump()` / `toPayload()` write the upstream snake_case wire keys, so
 *   the wire format is unchanged. Free-form `dict` fields are kept as-is.
 * - Models with `extra="allow"` keep unknown wire keys in `modelExtra`.
 */

import { pyJsonLoads } from "@pipedog/core/utils/py_json";

type Dict = Record<string, any>;

/** Maximum number of startup `input` messages a session accepts. */
export const MAX_INPUT_ITEMS = 128;

//
// Model machinery (pydantic's BaseModel, reduced to what these events need).
//

/** One validation problem: where it is (wire keys) and what is wrong. */
export interface LiveModelValidationErrorDetail {
  loc: (string | number)[];
  msg: string;
}

/** Raised when data does not match a model, like pydantic's `ValidationError`. */
export class LiveModelValidationError extends Error {
  override name = "ValidationError";
  readonly title: string;
  readonly details: LiveModelValidationErrorDetail[];

  constructor(title: string, details: LiveModelValidationErrorDetail[]) {
    const lines = details.map((d) => `${d.loc.join(".")}\n  ${d.msg}`);
    super(
      `${details.length} validation error${details.length === 1 ? "" : "s"} for ${title}\n${lines.join("\n")}`,
    );
    this.title = title;
    this.details = details;
  }

  /** The list of problems (pydantic `ValidationError.errors()`). */
  errors(): LiveModelValidationErrorDetail[] {
    return this.details;
  }
}

class FieldError extends Error {
  readonly detail: LiveModelValidationErrorDetail[];

  constructor(detail: LiveModelValidationErrorDetail[]) {
    super(detail.map((d) => d.msg).join("; "));
    this.detail = detail;
  }
}

function fail(msg: string): never {
  throw new FieldError([{ loc: [], msg }]);
}

/**
 * Validates one value. `wire` is true when the value comes from wire data
 * (`modelValidate`), where nested models use snake_case keys.
 */
type Parser<T> = (value: unknown, wire: boolean) => T;

interface FieldSpec<T = unknown> {
  parse: Parser<T>;
  /** Factory for the default value; absent when the field is required. */
  default?: () => T;
}

type FieldSpecs = Record<string, FieldSpec>;

function field<T>(parse: Parser<T>, defaultValue?: () => T): FieldSpec<T> {
  const spec: FieldSpec<T> = { parse };
  if (defaultValue) spec.default = defaultValue;
  return spec;
}

function wireKey(name: string): string {
  return name.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

function isPlainObject(value: unknown): value is Dict {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const P = {
  any: (): Parser<any> => (v) => v,
  str: (): Parser<string> => (v) =>
    typeof v === "string" ? v : fail("Input should be a valid string"),
  int: (): Parser<number> => (v) =>
    typeof v === "number" && Number.isInteger(v) ? v : fail("Input should be a valid integer"),
  float: (): Parser<number> => (v) =>
    typeof v === "number" ? v : fail("Input should be a valid number"),
  bool: (): Parser<boolean> => (v) =>
    typeof v === "boolean" ? v : fail("Input should be a valid boolean"),
  dict: (): Parser<Dict> => (v) =>
    isPlainObject(v) ? v : fail("Input should be a valid dictionary"),
  literal:
    <const L extends readonly string[]>(...values: L): Parser<L[number]> =>
    (v) =>
      values.includes(v as L[number])
        ? (v as L[number])
        : fail(`Input should be ${values.map((x) => `'${x}'`).join(" or ")}`),
  optional:
    <T>(parse: Parser<T>): Parser<T | null> =>
    (v, wire) =>
      v === null || v === undefined ? null : parse(v, wire),
  list:
    <T>(parse: Parser<T>): Parser<T[]> =>
    (v, wire) => {
      if (!Array.isArray(v)) fail("Input should be a valid list");
      const details: LiveModelValidationErrorDetail[] = [];
      const out = v.map((item, i) => {
        try {
          return parse(item, wire);
        } catch (e) {
          if (!(e instanceof FieldError)) throw e;
          for (const d of e.detail) details.push({ loc: [i, ...d.loc], msg: d.msg });
          return undefined as T;
        }
      });
      if (details.length > 0) throw new FieldError(details);
      return out;
    },
  union:
    <T>(...parsers: Parser<T>[]): Parser<T> =>
    (v, wire) => {
      const details: LiveModelValidationErrorDetail[] = [];
      for (const parse of parsers) {
        try {
          return parse(v, wire);
        } catch (e) {
          if (!(e instanceof FieldError)) throw e;
          details.push(...e.detail);
        }
      }
      throw new FieldError(details);
    },
  model:
    <C extends LiveModelClass>(cls: () => C): Parser<InstanceType<C>> =>
    (v, wire) => {
      const c = cls();
      if (v instanceof c) return v as InstanceType<C>;
      if (!isPlainObject(v)) fail(`Input should be a valid dictionary or instance of ${c.name}`);
      try {
        const ctor = c as unknown as new (options: unknown) => LiveModel;
        return (wire ? c.modelValidate(v) : new ctor(v)) as InstanceType<C>;
      } catch (e) {
        if (e instanceof LiveModelValidationError) throw new FieldError(e.details);
        throw e;
      }
    },
};

type LiveModelClass = (abstract new (
  options: any,
) => LiveModel) &
  (new (
    options: any,
  ) => LiveModel) & {
    name: string;
    modelValidate(data: unknown): LiveModel;
  };

const EXTRA = Symbol("pipecat.openai.live.extra");
const WIRE = Symbol("pipecat.openai.live.wire");

/** Options for `modelDump()`. */
export interface ModelDumpOptions {
  /** Leave out model fields whose value is `null`. */
  excludeNone?: boolean;
}

function dumpValue(value: unknown, options: ModelDumpOptions): unknown {
  if (value instanceof LiveModel) return value.modelDump(options);
  if (Array.isArray(value)) return value.map((v) => dumpValue(v, options));
  return value;
}

/**
 * Base class of the Live API models (pydantic `BaseModel`).
 *
 * Subclasses declare their fields with `declare` and describe them in the
 * static `fields` table (parser and default). The constructor validates
 * camelCase options; `modelValidate()` validates wire (snake_case) data;
 * `modelDump()` produces wire data.
 */
export abstract class LiveModel {
  /** Field table: name, parser and default. */
  static readonly fields: FieldSpecs = {};
  /** What to do with unknown wire keys: drop them, or keep them in `modelExtra`. */
  static readonly extra: "ignore" | "allow" = "ignore";

  /** Unknown keys kept by models created with `extra = "allow"` (pydantic `model_extra`). */
  modelExtra: Dict | null = null;

  constructor(options: object = {}) {
    const cls = new.target as unknown as typeof LiveModel;
    const input = options as Record<string | symbol, unknown>;
    const details: LiveModelValidationErrorDetail[] = [];
    const self = this as unknown as Dict;
    const wire = input[WIRE] === true;

    for (const [name, spec] of Object.entries(cls.fields)) {
      const raw = input[name];
      const key = wireKey(name);
      if (raw === undefined) {
        if (spec.default) {
          self[name] = spec.default();
        } else {
          details.push({ loc: [key], msg: "Field required" });
        }
        continue;
      }
      try {
        self[name] = spec.parse(raw, wire);
      } catch (e) {
        if (!(e instanceof FieldError)) throw e;
        for (const d of e.detail) details.push({ loc: [key, ...d.loc], msg: d.msg });
      }
    }

    if (details.length > 0) {
      throw new LiveModelValidationError(cls.name, details);
    }

    if (cls.extra === "allow") {
      const extra: Dict = { ...((input[EXTRA] as Dict | undefined) ?? {}) };
      for (const [k, v] of Object.entries(options)) {
        if (!(k in cls.fields)) extra[k] = v;
      }
      this.modelExtra = extra;
    }
  }

  /**
   * Validate wire data (snake_case keys) into a model (pydantic `model_validate`).
   *
   * @throws LiveModelValidationError If the data does not match the model.
   */
  static modelValidate<C extends abstract new (...args: any[]) => LiveModel>(
    this: C,
    data: unknown,
  ): InstanceType<C> {
    type T = InstanceType<C>;
    // biome-ignore lint/complexity/noThisInStatic: polymorphic static.
    const cls = this as unknown as typeof LiveModel;
    // biome-ignore lint/complexity/noThisInStatic: polymorphic static.
    const ctor = this as unknown as new (options: object) => T;
    if (data instanceof cls) return data as T;
    if (!isPlainObject(data)) {
      throw new LiveModelValidationError(cls.name, [
        { loc: [], msg: `Input should be a valid dictionary or instance of ${cls.name}` },
      ]);
    }
    const options: Record<string | symbol, unknown> = {};
    const known = new Set<string>();
    for (const name of Object.keys(cls.fields)) {
      const key = wireKey(name);
      known.add(key);
      if (key in data) options[name] = data[key];
    }
    if (cls.extra === "allow") {
      const extra: Dict = {};
      for (const [k, v] of Object.entries(data)) {
        if (!known.has(k)) extra[k] = v;
      }
      options[EXTRA] = extra;
    }
    options[WIRE] = true;
    return new ctor(options);
  }

  /**
   * The wire form of the model, with upstream's snake_case keys (pydantic
   * `model_dump`). Nested models are dumped too.
   */
  modelDump(options: ModelDumpOptions = {}): Dict {
    const cls = this.constructor as typeof LiveModel;
    const self = this as unknown as Dict;
    const dump: Dict = {};
    for (const name of Object.keys(cls.fields)) {
      const value = self[name];
      if (options.excludeNone && (value === null || value === undefined)) continue;
      dump[wireKey(name)] = dumpValue(value, options);
    }
    if (this.modelExtra) {
      for (const [k, v] of Object.entries(this.modelExtra)) {
        if (options.excludeNone && (v === null || v === undefined)) continue;
        dump[k] = dumpValue(v, options);
      }
    }
    return dump;
  }

  /** Serialize with the wire keys, as pydantic does. */
  toJSON(): Dict {
    return this.modelDump();
  }
}

function typeField<const L extends string>(type: L): FieldSpec<L> {
  return field(P.literal(type), () => type);
}

//
// session configuration
//

export interface InputTextContentOptions {
  type?: "input_text";
  /** The text. */
  text: string;
}

/**
 * A text content part supplied by the client.
 *
 * - `type`: content type, always "input_text".
 * - `text`: the text.
 */
export class InputTextContent extends LiveModel {
  static override readonly fields: FieldSpecs = {
    type: typeField("input_text"),
    text: field(P.str()),
  };
  declare type: "input_text";
  declare text: string;

  constructor(options: InputTextContentOptions) {
    super(options);
  }
}

export interface OutputTextContentOptions {
  type?: "output_text";
  /** The text. */
  text: string;
}

/**
 * A text content part attributed to the assistant.
 *
 * - `type`: content type, always "output_text".
 * - `text`: the text.
 */
export class OutputTextContent extends LiveModel {
  static override readonly fields: FieldSpecs = {
    type: typeField("output_text"),
    text: field(P.str()),
  };
  declare type: "output_text";
  declare text: string;

  constructor(options: OutputTextContentOptions) {
    super(options);
  }
}

export interface InputItemOptions {
  type?: "message";
  /** Message role. */
  role: "developer" | "user" | "assistant";
  /** Exactly one text content part. */
  content: (
    | InputTextContent
    | OutputTextContent
    | InputTextContentOptions
    | OutputTextContentOptions
  )[];
}

/**
 * A prior text-only conversation message seeded at session start.
 *
 * - `type`: item type, always "message".
 * - `role`: message role. Developer and user messages carry `input_text`
 *   content; assistant messages carry `output_text`. A `system` role is not
 *   accepted here: application instructions belong in
 *   `SessionConfig.instructions` or a developer message.
 * - `content`: exactly one text content part.
 */
export class InputItem extends LiveModel {
  static override readonly fields: FieldSpecs = {
    type: typeField("message"),
    role: field(P.literal("developer", "user", "assistant")),
    content: field(
      P.list(
        P.union<InputTextContent | OutputTextContent>(
          P.model(() => InputTextContent),
          P.model(() => OutputTextContent),
        ),
      ),
    ),
  };
  declare type: "message";
  declare role: "developer" | "user" | "assistant";
  declare content: (InputTextContent | OutputTextContent)[];

  constructor(options: InputItemOptions) {
    super(options);
  }
}

export interface AudioOutputConfigOptions {
  /** Output voice name (defaults to `marin` server-side). */
  voice?: string | null;
}

/**
 * Output audio configuration.
 *
 * - `voice`: output voice name (defaults to `marin` server-side).
 */
export class AudioOutputConfig extends LiveModel {
  static override readonly fields: FieldSpecs = {
    voice: field(P.optional(P.str()), () => null),
  };
  declare voice: string | null;

  constructor(options: AudioOutputConfigOptions = {}) {
    super(options);
  }
}

export type AudioFormatType = "audio/pcm" | "audio/pcmu" | "audio/pcma";

export interface AudioFormatOptions {
  /** `audio/pcm` (16 or 24 kHz PCM16), `audio/pcmu` or `audio/pcma` (8 kHz G.711). */
  type?: AudioFormatType;
  /** Sample rate in Hz. */
  rate?: number;
}

/**
 * WebSocket audio format, selected once at session start for input and output.
 *
 * - `type`: `audio/pcm` (16 or 24 kHz PCM16), `audio/pcmu` or `audio/pcma`
 *   (8 kHz G.711).
 * - `rate`: sample rate in Hz.
 */
export class AudioFormat extends LiveModel {
  static override readonly fields: FieldSpecs = {
    type: field(P.literal("audio/pcm", "audio/pcmu", "audio/pcma"), () => "audio/pcm"),
    rate: field(P.int(), () => 24000),
  };
  declare type: AudioFormatType;
  declare rate: number;

  constructor(options: AudioFormatOptions = {}) {
    super(options);
  }
}

export interface AudioConfigOptions {
  /** Output audio configuration. */
  output?: AudioOutputConfig | AudioOutputConfigOptions | null;
  /** WebSocket audio format, shared by input and output. */
  format?: AudioFormat | AudioFormatOptions | null;
}

/**
 * Session audio configuration.
 *
 * - `output`: output audio configuration.
 * - `format`: WebSocket audio format, shared by input and output.
 */
export class AudioConfig extends LiveModel {
  static override readonly fields: FieldSpecs = {
    output: field(P.optional(P.model(() => AudioOutputConfig)), () => null),
    format: field(P.optional(P.model(() => AudioFormat)), () => null),
  };
  declare output: AudioOutputConfig | null;
  declare format: AudioFormat | null;

  constructor(options: AudioConfigOptions = {}) {
    super(options);
  }
}

export interface ClientDelegationConfigOptions {
  type?: "client";
}

/**
 * Delegation configuration selecting client delegation.
 *
 * - `type`: delegation type, always "client".
 */
export class ClientDelegationConfig extends LiveModel {
  static override readonly fields: FieldSpecs = {
    type: typeField("client"),
  };
  declare type: "client";

  constructor(options: ClientDelegationConfigOptions = {}) {
    super(options);
  }
}

export interface ResponsesDelegationConfigOptions {
  type?: "responses";
  /** Configuration of the backend Responses model. */
  responses: Dict;
}

/**
 * Delegation configuration selecting Responses delegation.
 *
 * - `type`: delegation type, always "responses".
 * - `responses`: configuration of the backend Responses model: `model`,
 *   `instructions`, `tools`, `tool_choice`, `reasoning`,
 *   `max_output_tokens`, `service_tier`, and other Responses request fields
 *   the Live API accepts.
 */
export class ResponsesDelegationConfig extends LiveModel {
  static override readonly fields: FieldSpecs = {
    type: typeField("responses"),
    responses: field(P.dict()),
  };
  declare type: "responses";
  declare responses: Dict;

  constructor(options: ResponsesDelegationConfigOptions) {
    super(options);
  }
}

export type DelegationConfig = ClientDelegationConfig | ResponsesDelegationConfig;

const delegationParser = P.optional(
  P.union<DelegationConfig>(
    P.model(() => ClientDelegationConfig),
    P.model(() => ResponsesDelegationConfig),
  ),
);

export interface SessionConfigOptions {
  /** The live model. Required, and immutable after start. */
  model: string;
  /** Instructions for the live model. Immutable after start. */
  instructions?: string | null;
  /** Audio configuration. */
  audio?: AudioConfig | AudioConfigOptions | null;
  /** Delegation mode. Omitted selects client delegation. */
  delegation?:
    | DelegationConfig
    | ClientDelegationConfigOptions
    | ResponsesDelegationConfigOptions
    | null;
  /** Prior text-only conversation messages. Startup-only. */
  input?: (InputItem | InputItemOptions)[] | null;
  /** Whether the server keeps the session for 30 days. Startup-only. */
  store?: boolean | null;
}

/**
 * Live session configuration, sent once with `session.start`.
 *
 * - `model`: the live model. Required, and immutable after start.
 * - `instructions`: instructions for the live model. Immutable after start;
 *   `SessionInstructionsAppendEvent` adds more later.
 * - `audio`: audio configuration. The output voice and format are immutable
 *   after start.
 * - `delegation`: delegation mode. Omitted selects client delegation. The
 *   mode is immutable: switching needs a new session.
 * - `input`: prior text-only conversation messages. Startup-only.
 * - `store`: whether the server keeps the session for 30 days, as a
 *   downloadable recording and as a source for a fork. Startup-only; the
 *   server default is false.
 */
export class SessionConfig extends LiveModel {
  static override readonly fields: FieldSpecs = {
    model: field(P.str()),
    instructions: field(P.optional(P.str()), () => null),
    audio: field(P.optional(P.model(() => AudioConfig)), () => null),
    delegation: field(delegationParser, () => null),
    input: field(P.optional(P.list(P.model(() => InputItem))), () => null),
    store: field(P.optional(P.bool()), () => null),
  };
  declare model: string;
  declare instructions: string | null;
  declare audio: AudioConfig | null;
  declare delegation: DelegationConfig | null;
  declare input: InputItem[] | null;
  declare store: boolean | null;

  constructor(options: SessionConfigOptions) {
    super(options);
  }
}

export interface SessionUpdateConfigOptions {
  /** Replacement delegation settings, of the session's mode. */
  delegation?:
    | DelegationConfig
    | ClientDelegationConfigOptions
    | ResponsesDelegationConfigOptions
    | null;
}

/**
 * The sparse session update a running session accepts.
 *
 * Only delegation settings can change, and only within the mode chosen at
 * startup. Startup fields (`model`, `instructions`, `audio`, `input`) are not
 * update fields.
 *
 * - `delegation`: replacement delegation settings, of the session's mode.
 */
export class SessionUpdateConfig extends LiveModel {
  static override readonly fields: FieldSpecs = {
    delegation: field(delegationParser, () => null),
  };
  declare delegation: DelegationConfig | null;

  constructor(options: SessionUpdateConfigOptions = {}) {
    super(options);
  }
}

//
// client events
//

export interface ClientEventOptions {
  /**
   * Client-chosen identifier, echoed back as `client_event_id` on
   * acknowledgments and errors.
   */
  eventId?: string;
}

const CLIENT_EVENT_FIELDS: FieldSpecs = {
  eventId: field(P.str(), () => crypto.randomUUID()),
};

/**
 * Base class for events sent to the Live API.
 *
 * - `eventId`: client-chosen identifier, echoed back as `client_event_id` on
 *   acknowledgments and errors.
 */
export class ClientEvent extends LiveModel {
  static override readonly fields: FieldSpecs = CLIENT_EVENT_FIELDS;
  declare eventId: string;

  constructor(options: ClientEventOptions = {}) {
    super(options);
  }

  /**
   * Render the event as the JSON payload to send.
   *
   * Unset optional fields are omitted: the session schema is strict about
   * unknown fields, and a `null` is not the same as an absent field.
   *
   * @returns The payload.
   */
  toPayload(): Dict {
    return this.modelDump({ excludeNone: true });
  }
}

export interface SessionStartEventOptions extends ClientEventOptions {
  type?: "session.start";
  /** The session configuration, including the model. */
  session: SessionConfig | SessionConfigOptions;
}

/**
 * Start the session. The first message on a WebSocket, sent exactly once.
 *
 * - `type`: event type, always "session.start".
 * - `session`: the session configuration, including the model.
 */
export class SessionStartEvent extends ClientEvent {
  static override readonly fields: FieldSpecs = {
    ...CLIENT_EVENT_FIELDS,
    type: typeField("session.start"),
    session: field(P.model(() => SessionConfig)),
  };
  declare type: "session.start";
  declare session: SessionConfig;

  constructor(options: SessionStartEventOptions) {
    super(options);
  }
}

export interface SessionUpdateEventOptions extends ClientEventOptions {
  type?: "session.update";
  /** The sparse update. */
  session: SessionUpdateConfig | SessionUpdateConfigOptions;
}

/**
 * Apply a sparse update to a running session.
 *
 * - `type`: event type, always "session.update".
 * - `session`: the sparse update.
 */
export class SessionUpdateEvent extends ClientEvent {
  static override readonly fields: FieldSpecs = {
    ...CLIENT_EVENT_FIELDS,
    type: typeField("session.update"),
    session: field(P.model(() => SessionUpdateConfig)),
  };
  declare type: "session.update";
  declare session: SessionUpdateConfig;

  constructor(options: SessionUpdateEventOptions) {
    super(options);
  }
}

export interface InputAudioAppendEventOptions extends ClientEventOptions {
  type?: "session.input_audio.append";
  /** Base64-encoded audio bytes. */
  audio: string;
}

/**
 * Append audio in the session's audio format. Not acknowledged.
 *
 * - `type`: event type, always "session.input_audio.append".
 * - `audio`: base64-encoded audio bytes.
 */
export class InputAudioAppendEvent extends ClientEvent {
  static override readonly fields: FieldSpecs = {
    ...CLIENT_EVENT_FIELDS,
    type: typeField("session.input_audio.append"),
    audio: field(P.str()),
  };
  declare type: "session.input_audio.append";
  declare audio: string;

  constructor(options: InputAudioAppendEventOptions) {
    super(options);
  }
}

export interface ContextAppendEventOptions extends ClientEventOptions {
  /**
   * The client delegation this content belongs to, or `null` for general
   * session context. Always sent, including when it is `null`.
   */
  delegationId: string | null;
  /** The text, at most 500 tokens. */
  content: string;
}

const CONTEXT_APPEND_FIELDS: FieldSpecs = {
  ...CLIENT_EVENT_FIELDS,
  // Required, but `null` is a valid value.
  delegationId: field(P.optional(P.str())),
  content: field(P.str()),
};

/**
 * Base class for the three context-append events.
 *
 * - `delegationId`: the client delegation this content belongs to, or `null`
 *   for general session context. Always sent, including when it is `null`.
 * - `content`: the text, at most 500 tokens.
 */
export class ContextAppendEvent extends ClientEvent {
  static override readonly fields: FieldSpecs = CONTEXT_APPEND_FIELDS;
  declare delegationId: string | null;
  declare content: string;

  constructor(options: ContextAppendEventOptions) {
    // A `null` delegation id is a value, not a missing field.
    super(options);
  }

  /**
   * Render the event, keeping `delegation_id` even when it is `null`.
   *
   * The field is required on these events, and `null` is meaningful: it marks
   * the content as general session context rather than belonging to a
   * delegation.
   *
   * @returns The payload.
   */
  override toPayload(): Dict {
    return { ...super.toPayload(), delegation_id: this.delegationId };
  }
}

/**
 * Append instructions the live model will follow, without replacing the
 * startup ones.
 *
 * - `type`: event type, always "session.instructions.append".
 */
export class SessionInstructionsAppendEvent extends ContextAppendEvent {
  static override readonly fields: FieldSpecs = {
    ...CONTEXT_APPEND_FIELDS,
    type: typeField("session.instructions.append"),
  };
  declare type: "session.instructions.append";
}

/**
 * Append information to the live model's internal reasoning.
 *
 * The content is not spoken when appended, though the model can draw on it
 * when a later user request makes it relevant. It is not a secrecy boundary.
 *
 * - `type`: event type, always "session.thinking.append".
 */
export class SessionThinkingAppendEvent extends ContextAppendEvent {
  static override readonly fields: FieldSpecs = {
    ...CONTEXT_APPEND_FIELDS,
    type: typeField("session.thinking.append"),
  };
  declare type: "session.thinking.append";
}

/**
 * Append information for the live model to speak aloud, in its own words.
 *
 * - `type`: event type, always "session.commentary.append".
 */
export class SessionCommentaryAppendEvent extends ContextAppendEvent {
  static override readonly fields: FieldSpecs = {
    ...CONTEXT_APPEND_FIELDS,
    type: typeField("session.commentary.append"),
  };
  declare type: "session.commentary.append";
}

export interface FunctionCallOutputItemOptions {
  type?: "function_call_output";
  /** The `call_id` of the completed `function_call` item. */
  callId: string;
  /** The function output, as a string. */
  output: string;
}

/**
 * The result of a client-actionable function call from a Responses delegation.
 *
 * - `type`: item type, always "function_call_output".
 * - `callId`: the `call_id` of the completed `function_call` item.
 * - `output`: the function output, as a string.
 */
export class FunctionCallOutputItem extends LiveModel {
  static override readonly fields: FieldSpecs = {
    type: typeField("function_call_output"),
    callId: field(P.str()),
    output: field(P.str()),
  };
  declare type: "function_call_output";
  declare callId: string;
  declare output: string;

  constructor(options: FunctionCallOutputItemOptions) {
    super(options);
  }
}

export interface ResponseItemCreateEventOptions extends ClientEventOptions {
  type?: "response.item.create";
  /** The input item, such as a function call output. */
  item: FunctionCallOutputItem | Dict;
}

/**
 * Queue an input item for the backend Responses model. Not acknowledged.
 *
 * Queueing an item does not start inference: `ResponseCreateEvent` does.
 * Responses delegation only.
 *
 * - `type`: event type, always "response.item.create".
 * - `item`: the input item, such as a function call output.
 */
export class ResponseItemCreateEvent extends ClientEvent {
  static override readonly fields: FieldSpecs = {
    ...CLIENT_EVENT_FIELDS,
    type: typeField("response.item.create"),
    item: field(
      P.union<FunctionCallOutputItem | Dict>(
        P.model(() => FunctionCallOutputItem),
        P.dict(),
      ),
    ),
  };
  declare type: "response.item.create";
  declare item: FunctionCallOutputItem | Dict;

  constructor(options: ResponseItemCreateEventOptions) {
    super(options);
  }
}

export interface ResponseCreateEventOptions extends ClientEventOptions {
  type?: "response.create";
}

/**
 * Start or continue delegated Responses work. Responses delegation only.
 *
 * Every output required by the pending response must be queued first, or the
 * command is rejected with `function_call_outputs_required`.
 *
 * - `type`: event type, always "response.create".
 */
export class ResponseCreateEvent extends ClientEvent {
  static override readonly fields: FieldSpecs = {
    ...CLIENT_EVENT_FIELDS,
    type: typeField("response.create"),
  };
  declare type: "response.create";

  constructor(options: ResponseCreateEventOptions = {}) {
    super(options);
  }
}

export interface SessionCloseEventOptions extends ClientEventOptions {
  type?: "session.close";
}

/**
 * Request a graceful shutdown; the server answers with `session.closed`.
 *
 * - `type`: event type, always "session.close".
 */
export class SessionCloseEvent extends ClientEvent {
  static override readonly fields: FieldSpecs = {
    ...CLIENT_EVENT_FIELDS,
    type: typeField("session.close"),
  };
  declare type: "session.close";

  constructor(options: SessionCloseEventOptions = {}) {
    super(options);
  }
}

//
// server events
//

const SERVER_EVENT_FIELDS: FieldSpecs = {
  type: field(P.str()),
  eventId: field(P.optional(P.str()), () => null),
  clientEventId: field(P.optional(P.str()), () => null),
};

/** Server event fields are read from wire data with `modelValidate()`. */
export type ServerEventOptions = Dict;

/**
 * Base class for events received from the Live API.
 *
 * Unknown fields are retained (in `modelExtra`) so events keep parsing as the
 * API grows.
 *
 * - `type`: the event type.
 * - `eventId`: identifier of this server event.
 * - `clientEventId`: the client event this one answers, when correlatable.
 */
export class ServerEvent extends LiveModel {
  static override readonly extra = "allow" as const;
  static override readonly fields: FieldSpecs = SERVER_EVENT_FIELDS;
  declare type: string;
  declare eventId: string | null;
  declare clientEventId: string | null;

  constructor(options: ServerEventOptions) {
    super(options);
  }
}

/**
 * The resolved session, echoed by `session.started`, `session.updated` and
 * `session.closed`.
 *
 * - `id`: session identifier. Opaque: forward it unchanged.
 * - `expiresAt`: session expiry as a Unix timestamp in seconds.
 * - `status`: session status.
 * - `model`: the live model.
 * - `instructions`: the startup instructions.
 * - `audio`: audio configuration.
 * - `delegation`: delegation configuration.
 * - `input`: the startup conversation history.
 * - `contextManagement`: long-session context handling.
 */
export class SessionResource extends LiveModel {
  static override readonly extra = "allow" as const;
  static override readonly fields: FieldSpecs = {
    id: field(P.optional(P.str()), () => null),
    expiresAt: field(P.optional(P.int()), () => null),
    status: field(P.optional(P.str()), () => null),
    model: field(P.optional(P.str()), () => null),
    instructions: field(P.optional(P.str()), () => null),
    audio: field(P.optional(P.dict()), () => null),
    delegation: field(P.optional(P.dict()), () => null),
    input: field(P.optional(P.list(P.dict())), () => null),
    contextManagement: field(P.optional(P.dict()), () => null),
  };
  declare id: string | null;
  declare expiresAt: number | null;
  declare status: string | null;
  declare model: string | null;
  declare instructions: string | null;
  declare audio: Dict | null;
  declare delegation: Dict | null;
  declare input: Dict[] | null;
  declare contextManagement: Dict | null;

  constructor(options: Dict = {}) {
    super(options);
  }
}

/**
 * The session is configured and ready for audio.
 *
 * - `type`: event type, always "session.started".
 * - `session`: the resolved session.
 */
export class SessionStartedEvent extends ServerEvent {
  static override readonly fields: FieldSpecs = {
    ...SERVER_EVENT_FIELDS,
    type: field(P.literal("session.started")),
    session: field(P.model(() => SessionResource)),
  };
  declare type: "session.started";
  declare session: SessionResource;
}

/**
 * A sparse `session.update` was applied.
 *
 * - `type`: event type, always "session.updated".
 * - `session`: the complete resolved session, not just the changed fields.
 */
export class SessionUpdatedEvent extends ServerEvent {
  static override readonly fields: FieldSpecs = {
    ...SERVER_EVENT_FIELDS,
    type: field(P.literal("session.updated")),
    session: field(P.model(() => SessionResource)),
  };
  declare type: "session.updated";
  declare session: SessionResource;
}

/**
 * A chunk of output audio in the session's audio format.
 *
 * - `type`: event type, always "session.output_audio.delta".
 * - `delta`: base64-encoded audio bytes.
 */
export class OutputAudioDeltaEvent extends ServerEvent {
  static override readonly fields: FieldSpecs = {
    ...SERVER_EVENT_FIELDS,
    type: field(P.literal("session.output_audio.delta")),
    delta: field(P.str()),
  };
  declare type: "session.output_audio.delta";
  declare delta: string;
}

/**
 * A timed transcript fragment of user or assistant speech.
 *
 * Fragments are frame-aligned, not word- or turn-aligned: accumulate them in
 * order, and group them into turns in the application if it needs turns.
 *
 * - `type`: "session.input_transcript.delta" (the user) or
 *   "session.output_transcript.delta" (the assistant).
 * - `delta`: the fragment text.
 * - `startMs`: start of the fragment on the session timeline.
 * - `endMs`: end of the fragment on the session timeline.
 */
export class TranscriptDeltaEvent extends ServerEvent {
  static override readonly fields: FieldSpecs = {
    ...SERVER_EVENT_FIELDS,
    type: field(P.literal("session.input_transcript.delta", "session.output_transcript.delta")),
    delta: field(P.str(), () => ""),
    startMs: field(P.optional(P.int()), () => null),
    endMs: field(P.optional(P.int()), () => null),
  };
  declare type: "session.input_transcript.delta" | "session.output_transcript.delta";
  declare delta: string;
  declare startMs: number | null;
  declare endMs: number | null;

  /** The speaker. */
  get role(): "user" | "assistant" {
    return this.type === "session.input_transcript.delta" ? "user" : "assistant";
  }
}

/**
 * A unit of work the live model delegated.
 *
 * The metadata carries no task text: a client delegator works out what to do
 * from the conversation and application state it keeps itself.
 *
 * - `id`: delegation identifier, used to correlate returned context. Opaque:
 *   return it unchanged.
 * - `type`: item type, always "delegation".
 * - `target`: "client" or "responses".
 * - `responseId`: for Responses delegations, the id of the Responses run.
 */
export class DelegationMetadata extends LiveModel {
  static override readonly extra = "allow" as const;
  static override readonly fields: FieldSpecs = {
    id: field(P.str()),
    type: field(P.str(), () => "delegation"),
    target: field(P.str()),
    responseId: field(P.optional(P.str()), () => null),
  };
  declare id: string;
  declare type: string;
  declare target: string;
  declare responseId: string | null;

  constructor(options: Dict) {
    super(options);
  }
}

/**
 * The live model created a delegation.
 *
 * - `type`: event type, always "session.delegation.created".
 * - `offsetMs`: position on the session timeline.
 * - `delegation`: the delegation metadata.
 */
export class SessionDelegationCreatedEvent extends ServerEvent {
  static override readonly fields: FieldSpecs = {
    ...SERVER_EVENT_FIELDS,
    type: field(P.literal("session.delegation.created")),
    offsetMs: field(P.optional(P.int()), () => null),
    delegation: field(P.model(() => DelegationMetadata)),
  };
  declare type: "session.delegation.created";
  declare offsetMs: number | null;
  declare delegation: DelegationMetadata;
}

/**
 * An output item of a Responses delegation.
 *
 * - `id`: item identifier.
 * - `type`: item type, e.g. "function_call" or "message".
 * - `status`: item status, e.g. "completed".
 * - `callId`: for function calls, the call identifier to answer with.
 * - `name`: for function calls, the function name.
 * - `arguments`: for function calls, the JSON-encoded arguments.
 */
export class ResponseOutputItem extends LiveModel {
  static override readonly extra = "allow" as const;
  static override readonly fields: FieldSpecs = {
    id: field(P.optional(P.str()), () => null),
    type: field(P.optional(P.str()), () => null),
    status: field(P.optional(P.str()), () => null),
    callId: field(P.optional(P.str()), () => null),
    name: field(P.optional(P.str()), () => null),
    arguments: field(P.optional(P.str()), () => null),
  };
  declare id: string | null;
  declare type: string | null;
  declare status: string | null;
  declare callId: string | null;
  declare name: string | null;
  declare arguments: string | null;

  constructor(options: Dict = {}) {
    super(options);
  }
}

/**
 * A Responses lifecycle event, wrapped with the delegation it belongs to.
 *
 * The nested event keeps its Responses meaning and is dispatched by its own
 * complete `type`. Lifecycle snapshots inside are reduced — `output` is an
 * empty array even at `response.completed` — so collect output items from
 * their individual events rather than from a snapshot.
 *
 * - `type`: event type, always "response.event".
 * - `delegationId`: the delegation this response belongs to, when known.
 * - `event`: the nested Responses event.
 */
export class ResponseEventEnvelope extends ServerEvent {
  static override readonly fields: FieldSpecs = {
    ...SERVER_EVENT_FIELDS,
    type: field(P.literal("response.event")),
    delegationId: field(P.optional(P.str()), () => null),
    event: field(P.dict(), () => ({})),
  };
  declare type: "response.event";
  declare delegationId: string | null;
  declare event: Dict;

  /** The nested Responses event's type, or `""` if it has none. */
  get innerType(): string {
    const inner = this.event.type;
    return typeof inner === "string" ? inner : "";
  }
}

/**
 * Appended context was accepted and placed on the session timeline.
 *
 * Acceptance is not proof the model has spoken the content.
 *
 * - `type`: "session.instructions.appended", "session.thinking.appended" or
 *   "session.commentary.appended".
 * - `startMs`: start of the accepted range.
 * - `endMs`: end of the accepted range.
 */
export class ContextAppendedEvent extends ServerEvent {
  static override readonly fields: FieldSpecs = {
    ...SERVER_EVENT_FIELDS,
    type: field(
      P.literal(
        "session.instructions.appended",
        "session.thinking.appended",
        "session.commentary.appended",
      ),
    ),
    startMs: field(P.optional(P.int()), () => null),
    endMs: field(P.optional(P.int()), () => null),
  };
  declare type:
    | "session.instructions.appended"
    | "session.thinking.appended"
    | "session.commentary.appended";
  declare startMs: number | null;
  declare endMs: number | null;
}

/**
 * Context utilization, when reported.
 *
 * - `usageRatio`: fraction of the context window in use.
 */
export class ContextWindowUsage extends LiveModel {
  static override readonly extra = "allow" as const;
  static override readonly fields: FieldSpecs = {
    usageRatio: field(P.optional(P.float()), () => null),
  };
  declare usageRatio: number | null;

  constructor(options: Dict = {}) {
    super(options);
  }
}

/**
 * Cumulative live session usage.
 *
 * Backend token usage is not here: it belongs to the wrapped Responses
 * lifecycle, on the nested `response.completed` event.
 *
 * - `seconds`: cumulative live audio duration in seconds.
 */
export class Usage extends LiveModel {
  static override readonly extra = "allow" as const;
  static override readonly fields: FieldSpecs = {
    seconds: field(P.optional(P.float()), () => null),
  };
  declare seconds: number | null;

  constructor(options: Dict = {}) {
    super(options);
  }
}

/**
 * Periodic cumulative usage report.
 *
 * - `type`: event type, always "session.usage.updated".
 * - `usage`: cumulative usage, not an increment to sum.
 * - `contextWindow`: context utilization, when reported.
 */
export class SessionUsageUpdatedEvent extends ServerEvent {
  static override readonly fields: FieldSpecs = {
    ...SERVER_EVENT_FIELDS,
    type: field(P.literal("session.usage.updated")),
    usage: field(P.model(() => Usage)),
    contextWindow: field(P.optional(P.model(() => ContextWindowUsage)), () => null),
  };
  declare type: "session.usage.updated";
  declare usage: Usage;
  declare contextWindow: ContextWindowUsage | null;
}

/**
 * Graceful shutdown completed. Transport closure alone is not finalization.
 *
 * - `type`: event type, always "session.closed".
 * - `reason`: why the session closed.
 * - `session`: the session snapshot, as configuration rather than a live
 *   session.
 * - `usage`: final cumulative usage.
 */
export class SessionClosedEvent extends ServerEvent {
  static override readonly fields: FieldSpecs = {
    ...SERVER_EVENT_FIELDS,
    type: field(P.literal("session.closed")),
    reason: field(P.optional(P.str()), () => null),
    session: field(P.optional(P.model(() => SessionResource)), () => null),
    usage: field(P.optional(P.model(() => Usage)), () => null),
  };
  declare type: "session.closed";
  declare reason: string | null;
  declare session: SessionResource | null;
  declare usage: Usage | null;
}

/**
 * The error envelope shared by Live API and normalized Responses errors.
 *
 * - `type`: error type, e.g. "invalid_request_error".
 * - `code`: error code.
 * - `message`: human-readable message.
 * - `param`: the offending field, when one caused the failure.
 * - `clientEventId`: the client event the error correlates to, when known.
 */
export class ErrorDetails extends LiveModel {
  static override readonly extra = "allow" as const;
  static override readonly fields: FieldSpecs = {
    type: field(P.optional(P.str()), () => null),
    code: field(P.optional(P.str()), () => null),
    message: field(P.optional(P.str()), () => null),
    param: field(P.optional(P.str()), () => null),
    clientEventId: field(P.optional(P.str()), () => null),
  };
  declare type: string | null;
  declare code: string | null;
  declare message: string | null;
  declare param: string | null;
  declare clientEventId: string | null;

  constructor(options: Dict = {}) {
    super(options);
  }
}

/**
 * A startup, validation, command or delegated-Responses error.
 *
 * - `type`: event type, always "error".
 * - `error`: the error details.
 */
export class ErrorEvent extends ServerEvent {
  static override readonly fields: FieldSpecs = {
    ...SERVER_EVENT_FIELDS,
    type: field(P.literal("error")),
    error: field(P.model(() => ErrorDetails)),
  };
  declare type: "error";
  declare error: ErrorDetails;
}

/** A server event this module doesn't model; its fields are retained as extras. */
export class UnknownServerEvent extends ServerEvent {}

const _serverEventTypes: Record<string, typeof ServerEvent> = {
  error: ErrorEvent,
  "session.started": SessionStartedEvent,
  "session.updated": SessionUpdatedEvent,
  "session.usage.updated": SessionUsageUpdatedEvent,
  "session.closed": SessionClosedEvent,
  "session.output_audio.delta": OutputAudioDeltaEvent,
  "session.input_transcript.delta": TranscriptDeltaEvent,
  "session.output_transcript.delta": TranscriptDeltaEvent,
  "session.delegation.created": SessionDelegationCreatedEvent,
  "session.instructions.appended": ContextAppendedEvent,
  "session.thinking.appended": ContextAppendedEvent,
  "session.commentary.appended": ContextAppendedEvent,
  "response.event": ResponseEventEnvelope,
};

/**
 * Parse a server event from its JSON text.
 *
 * Event types this module doesn't model become `UnknownServerEvent`.
 *
 * @param message The JSON text of one server event, as a string or UTF-8 bytes.
 * @returns The parsed event.
 * @throws Error If the text isn't a JSON object with a string `type`, or a
 *   modeled event fails validation (upstream: ValueError).
 */
export function parseServerEvent(message: string | Uint8Array): ServerEvent {
  const text = typeof message === "string" ? message : new TextDecoder().decode(message);
  let data: unknown;
  try {
    data = pyJsonLoads(text);
  } catch (e) {
    throw new Error(`Invalid server event JSON: ${e instanceof Error ? e.message : String(e)}`, {
      cause: e,
    });
  }
  if (!isPlainObject(data) || typeof data.type !== "string") {
    throw new Error(`Server event is not an object with a string type: ${text}`);
  }

  const eventType = data.type;
  const model = Object.hasOwn(_serverEventTypes, eventType)
    ? _serverEventTypes[eventType]!
    : UnknownServerEvent;
  try {
    return model.modelValidate(data);
  } catch (e) {
    throw new Error(
      `Invalid ${eventType} server event: ${e instanceof Error ? e.message : String(e)}`,
      { cause: e },
    );
  }
}
