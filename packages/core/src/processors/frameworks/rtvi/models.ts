// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/processors/frameworks/rtvi/models.py

/**
 * RTVI protocol v2 message models.
 *
 * Contains all RTVI protocol v2 message definitions and data structures.
 * Import this module under the `RTVI` alias to use as a namespace.
 *
 * @example
 * import * as RTVI from "@pipedog/core/processors/frameworks/rtvi/models";
 *
 * const msg = new RTVI.BotReady({
 *   id: "1",
 *   data: new RTVI.BotReadyData({ version: RTVI.PROTOCOL_VERSION }),
 * });
 *
 * Porting notes:
 * - Upstream models are pydantic `BaseModel`s. Here each model is a class
 *   extending the small `BaseModel` below: fields are camelCase and the
 *   constructor takes one options object, while `modelValidate()` reads and
 *   `modelDump()` / `toJSON()` write the upstream snake_case wire keys, so
 *   the RTVI wire format is unchanged. The constructor validates its options
 *   like pydantic does and throws `ValidationError`.
 * - Dropped (deprecated upstream): `LLMFunctionCallMessageData` and
 *   `LLMFunctionCallMessage` (only the deprecated
 *   `RTVIProcessor.handle_function_call` sends them).
 * - Kept although deprecated upstream, because the observer still sends them
 *   by default and clients read them: `BotLLMTextMessage`,
 *   `BotTTSTextMessage`, `UserTranscriptionMessage(Data)` and the
 *   `aggregated_by` wire field of `BotOutputMessageData`.
 */

import type { KeypadEntry } from "../../../audio/dtmf/types.ts";
import { KeypadEntry as KeypadEntryValues } from "../../../audio/dtmf/types.ts";
import { BotCapabilities, type BotCapabilitiesOptions } from "../../../pipeline/capabilities.ts";
import type { TextType } from "../../../utils/text/base_text_aggregator.ts";

/**
 * Source type for an RTVI `send-file` message.
 *
 * Matches `FileSourceType` from frames: a file arrives either as inline base64
 * bytes or as a URL, and both flow through to a `UserFileRawFrame`
 * unresolved.
 */
export type RTVIFileSourceType = "bytes" | "url";

// -- Constants --
export const PROTOCOL_VERSION = "2.2.0";

// -- Version compatibility --
// Any 1.x client is deprecated but still supported with the old bot-output format.
export const LEGACY_SUPPORTED_MAJOR = 1;

export const MESSAGE_LABEL = "rtvi-ai";
export type MessageLiteral = "rtvi-ai";

//
// Model machinery (pydantic's BaseModel, reduced to what RTVI needs).
//

/** One validation problem: where it is (wire keys) and what is wrong. */
export interface ValidationErrorDetail {
  loc: (string | number)[];
  msg: string;
}

/** Raised when data does not match a model, like pydantic's `ValidationError`. */
// `Error` is shadowed in this module by the RTVI `Error` model below.
const BuiltinError = globalThis.Error;

export class ValidationError extends BuiltinError {
  override name = "ValidationError";
  readonly title: string;
  readonly details: ValidationErrorDetail[];

  constructor(title: string, details: ValidationErrorDetail[]) {
    const lines = details.map((d) => `${d.loc.join(".")}\n  ${d.msg}`);
    super(
      `${details.length} validation error${details.length === 1 ? "" : "s"} for ${title}\n${lines.join("\n")}`,
    );
    this.title = title;
    this.details = details;
  }

  /** The list of problems (pydantic `ValidationError.errors()`). */
  errors(): ValidationErrorDetail[] {
    return this.details;
  }
}

class FieldError extends BuiltinError {
  readonly detail: ValidationErrorDetail[];

  constructor(detail: ValidationErrorDetail[]) {
    super(detail.map((d) => d.msg).join("; "));
    this.detail = detail;
  }
}

function fail(msg: string, loc: (string | number)[] = []): never {
  throw new FieldError([{ loc, msg }]);
}

/**
 * Validates one value. `wire` is true when the value comes from wire data
 * (`modelValidate`), where nested models use snake_case keys; constructor
 * options use camelCase keys.
 */
type Parser<T> = (value: unknown, wire?: boolean) => T;

interface FieldSpec<T = unknown> {
  parse: Parser<T>;
  /** Factory for the default value; absent when the field is required. */
  default?: () => T;
  /** Wire key; defaults to the snake_case form of the field name. */
  key?: string;
}

type FieldSpecs = Record<string, FieldSpec>;

function field<T>(parse: Parser<T>, defaultValue?: () => T, key?: string): FieldSpec<T> {
  const spec: FieldSpec<T> = { parse };
  if (defaultValue) spec.default = defaultValue;
  if (key) spec.key = key;
  return spec;
}

function wireKey(name: string, spec: FieldSpec): string {
  return spec.key ?? name.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const P = {
  any: (): Parser<unknown> => (v) => v,
  str: (): Parser<string> => (v) =>
    typeof v === "string" ? v : fail("Input should be a valid string"),
  int: (): Parser<number> => (v) =>
    typeof v === "number" && Number.isInteger(v) ? v : fail("Input should be a valid integer"),
  float: (): Parser<number> => (v) =>
    typeof v === "number" && Number.isFinite(v) ? v : fail("Input should be a valid number"),
  bool: (): Parser<boolean> => (v) =>
    typeof v === "boolean" ? v : fail("Input should be a valid boolean"),
  dict: (): Parser<Record<string, unknown>> => (v) =>
    isPlainObject(v) ? v : fail("Input should be a valid dictionary"),
  literal:
    <const L extends readonly (string | number | boolean | null)[]>(
      ...values: L
    ): Parser<L[number]> =>
    (v) =>
      values.includes(v as L[number])
        ? (v as L[number])
        : fail(`Input should be ${values.map((x) => JSON.stringify(x)).join(" or ")}`),
  optional:
    <T>(parse: Parser<T>): Parser<T | null> =>
    (v, wire) =>
      v === null || v === undefined ? null : parse(v, wire),
  list:
    <T>(parse: Parser<T>, options: { minLength?: number } = {}): Parser<T[]> =>
    (v, wire) => {
      if (!Array.isArray(v)) fail("Input should be a valid list");
      if (options.minLength !== undefined && v.length < options.minLength) {
        fail(
          `List should have at least ${options.minLength} item after validation, not ${v.length}`,
        );
      }
      const details: ValidationErrorDetail[] = [];
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
      const details: ValidationErrorDetail[] = [];
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
    <C extends ModelClass<BaseModel>>(cls: () => C): Parser<InstanceType<C>> =>
    (v, wire) => {
      const c = cls();
      if (v instanceof c) return v as InstanceType<C>;
      if (!isPlainObject(v)) fail(`Input should be a valid dictionary or instance of ${c.name}`);
      try {
        return (wire ? c.modelValidate(v) : new c(v)) as InstanceType<C>;
      } catch (e) {
        if (e instanceof ValidationError) throw new FieldError(e.details);
        throw e;
      }
    },
};

type ModelClass<T extends BaseModel> = (new (
  options: any,
) => T) & {
  name: string;
  modelValidate(data: unknown): T;
};

const EXTRA = Symbol("pipecat.rtvi.extra");
const WIRE = Symbol("pipecat.rtvi.wire");

/** Options for `modelDump()`. */
export interface ModelDumpOptions {
  /** Leave out fields whose value is `null`. */
  excludeNone?: boolean;
}

function dumpValue(value: unknown, options: ModelDumpOptions): unknown {
  if (value instanceof BaseModel) return value.modelDump(options);
  if (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { modelDump?: unknown }).modelDump === "function"
  ) {
    return (value as { modelDump(o: ModelDumpOptions): unknown }).modelDump(options);
  }
  if (Array.isArray(value)) return value.map((v) => dumpValue(v, options));
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, dumpValue(v, options)]));
  }
  return value;
}

/**
 * Base class of the RTVI models (pydantic `BaseModel`).
 *
 * Subclasses declare their fields with `declare` and describe them in the
 * static `fields` table. The constructor validates camelCase options;
 * `modelValidate()` validates wire (snake_case) data; `modelDump()` produces
 * wire data.
 */
export abstract class BaseModel {
  /** Field table: name, parser, default and wire key. */
  static readonly fields: FieldSpecs = {};
  /** What to do with unknown wire keys: drop them, or keep them in `modelExtra`. */
  static readonly extra: "ignore" | "allow" = "ignore";

  /** Unknown keys kept by models created with `extra = "allow"` (pydantic `model_extra`). */
  modelExtra: Record<string, unknown> | null = null;

  constructor(options: object = {}) {
    const cls = new.target as unknown as typeof BaseModel;
    const input = cls._beforeValidate({ ...(options as Record<string, unknown>) });
    const details: ValidationErrorDetail[] = [];
    const self = this as unknown as Record<string, unknown>;
    const wire = (options as Record<symbol, unknown>)[WIRE] === true;

    for (const [name, spec] of Object.entries(cls.fields)) {
      const raw = input[name];
      const key = wireKey(name, spec);
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
      throw new ValidationError(cls.name, details);
    }

    if (cls.extra === "allow") {
      const extra: Record<string, unknown> = {
        ...((options as Record<symbol, Record<string, unknown> | undefined>)[EXTRA] ?? {}),
      };
      for (const [k, v] of Object.entries(options)) {
        if (!(k in cls.fields)) extra[k] = v;
      }
      this.modelExtra = extra;
    }
  }

  /**
   * Hook run on the (camelCase) input before the fields are validated, like
   * pydantic's `@model_validator(mode="before")`.
   */
  protected static _beforeValidate(data: Record<string, unknown>): Record<string, unknown> {
    return data;
  }

  /**
   * Validate wire data (snake_case keys) into a model (pydantic `model_validate`).
   *
   * @throws ValidationError If the data does not match the model.
   */
  static modelValidate<C extends abstract new (...args: any[]) => BaseModel>(
    this: C,
    data: unknown,
  ): InstanceType<C> {
    type T = InstanceType<C>;
    // `this` is the subclass modelValidate() is called on, as with a classmethod.
    // biome-ignore lint/complexity/noThisInStatic: polymorphic static.
    const cls = this as unknown as typeof BaseModel;
    // biome-ignore lint/complexity/noThisInStatic: polymorphic static.
    const ctor = this as unknown as new (options: object) => T;
    if (data instanceof cls) return data as T;
    if (!isPlainObject(data)) {
      throw new ValidationError(cls.name, [
        { loc: [], msg: `Input should be a valid dictionary or instance of ${cls.name}` },
      ]);
    }
    const options: Record<string | symbol, unknown> = {};
    const known = new Set<string>();
    for (const [name, spec] of Object.entries(cls.fields)) {
      const key = wireKey(name, spec);
      known.add(key);
      if (key in data) options[name] = data[key];
    }
    if (cls.extra === "allow") {
      const extra: Record<string, unknown> = {};
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
  modelDump(options: ModelDumpOptions = {}): Record<string, unknown> {
    const cls = this.constructor as typeof BaseModel;
    const self = this as unknown as Record<string, unknown>;
    const dump: Record<string, unknown> = {};
    for (const [name, spec] of Object.entries(cls.fields)) {
      const value = self[name];
      if (options.excludeNone && (value === null || value === undefined)) continue;
      dump[wireKey(name, spec)] = dumpValue(value, options);
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
  toJSON(): Record<string, unknown> {
    return this.modelDump();
  }
}

const LABEL_FIELD = field(P.literal(MESSAGE_LABEL), () => MESSAGE_LABEL);

function typeField<const L extends string>(type: L): FieldSpec<L> {
  return field(P.literal(type), () => type);
}

// -- Base Message Structure --

export interface MessageOptions {
  label?: MessageLiteral;
  type: string;
  id: string;
  data?: Record<string, unknown> | null;
}

/**
 * Base RTVI message structure.
 *
 * Represents the standard format for RTVI protocol messages.
 */
export class Message extends BaseModel {
  declare label: MessageLiteral;
  declare type: string;
  declare id: string;
  declare data: Record<string, unknown> | null;

  static override readonly fields: FieldSpecs = {
    label: LABEL_FIELD,
    type: field(P.str()),
    id: field(P.str()),
    data: field(P.optional(P.dict()), () => null),
  };

  constructor(options: MessageOptions) {
    super(options);
  }
}

// -- Client -> Pipecat messages.

export interface RawClientMessageDataOptions {
  t: string;
  d?: unknown;
}

/** Data structure expected from client messages sent to the RTVI server. */
export class RawClientMessageData extends BaseModel {
  declare t: string;
  declare d: unknown;

  static override readonly fields: FieldSpecs = {
    t: field(P.str()),
    d: field(P.optional(P.any()), () => null),
  };

  constructor(options: RawClientMessageDataOptions) {
    super(options);
  }
}

export interface ClientMessageOptions {
  msgId: string;
  type: string;
  data?: unknown;
}

/** Cleansed data structure for client messages for handling. */
export class ClientMessage extends BaseModel {
  declare msgId: string;
  declare type: string;
  declare data: unknown;

  static override readonly fields: FieldSpecs = {
    msgId: field(P.str()),
    type: field(P.str()),
    data: field(P.optional(P.any()), () => null),
  };

  constructor(options: ClientMessageOptions) {
    super(options);
  }
}

export interface RawServerResponseDataOptions {
  t: string;
  d?: unknown;
}

/** Data structure for server responses to client messages. */
export class RawServerResponseData extends BaseModel {
  declare t: string;
  declare d: unknown;

  static override readonly fields: FieldSpecs = {
    t: field(P.str()),
    d: field(P.optional(P.any()), () => null),
  };

  constructor(options: RawServerResponseDataOptions) {
    super(options);
  }
}

export interface ServerResponseOptions {
  label?: MessageLiteral;
  type?: "server-response";
  id: string;
  data: RawServerResponseData | RawServerResponseDataOptions;
}

/**
 * The RTVI-formatted message response from the server to the client.
 *
 * This message is used to respond to custom messages sent by the client.
 */
export class ServerResponse extends BaseModel {
  declare label: MessageLiteral;
  declare type: "server-response";
  declare id: string;
  declare data: RawServerResponseData;

  static override readonly fields: FieldSpecs = {
    label: LABEL_FIELD,
    type: typeField("server-response"),
    id: field(P.str()),
    data: field(P.model(() => RawServerResponseData)),
  };

  constructor(options: ServerResponseOptions) {
    super(options);
  }
}

export interface AboutClientDataOptions {
  library: string;
  libraryVersion?: string | null;
  platform?: string | null;
  platformVersion?: string | null;
  platformDetails?: unknown;
}

/**
 * Data about the RTVI client.
 *
 * Contains information about the client, including which RTVI library it is
 * using, what platform it is on and any additional details, if available.
 */
export class AboutClientData extends BaseModel {
  declare library: string;
  declare libraryVersion: string | null;
  declare platform: string | null;
  declare platformVersion: string | null;
  declare platformDetails: unknown;

  static override readonly fields: FieldSpecs = {
    library: field(P.str()),
    libraryVersion: field(P.optional(P.str()), () => null),
    platform: field(P.optional(P.str()), () => null),
    platformVersion: field(P.optional(P.str()), () => null),
    platformDetails: field(P.optional(P.any()), () => null),
  };

  constructor(options: AboutClientDataOptions) {
    super(options);
  }
}

export interface ClientReadyDataOptions {
  version: string;
  about: AboutClientData | AboutClientDataOptions;
}

/**
 * Data format of client ready messages.
 *
 * Contains the RTVI protocol version and client information.
 */
export class ClientReadyData extends BaseModel {
  declare version: string;
  declare about: AboutClientData;

  static override readonly fields: FieldSpecs = {
    version: field(P.str()),
    about: field(P.model(() => AboutClientData)),
  };

  constructor(options: ClientReadyDataOptions) {
    super(options);
  }
}

// -- Pipecat -> Client errors

export interface ErrorResponseDataOptions {
  error: string;
}

/**
 * Data for an RTVI error response.
 *
 * Contains the error message to send back to the client.
 */
export class ErrorResponseData extends BaseModel {
  declare error: string;

  static override readonly fields: FieldSpecs = {
    error: field(P.str()),
  };

  constructor(options: ErrorResponseDataOptions) {
    super(options);
  }
}

export interface ErrorResponseOptions {
  label?: MessageLiteral;
  type?: "error-response";
  id: string;
  data: ErrorResponseData | ErrorResponseDataOptions;
}

/**
 * RTVI error response message.
 *
 * RTVI formatted error response message for relaying failed client requests.
 */
export class ErrorResponse extends BaseModel {
  declare label: MessageLiteral;
  declare type: "error-response";
  declare id: string;
  declare data: ErrorResponseData;

  static override readonly fields: FieldSpecs = {
    label: LABEL_FIELD,
    type: typeField("error-response"),
    id: field(P.str()),
    data: field(P.model(() => ErrorResponseData)),
  };

  constructor(options: ErrorResponseOptions) {
    super(options);
  }
}

export interface ErrorDataOptions {
  error: string;
  /** Indicates the pipeline has stopped due to this error. */
  fatal: boolean;
}

/**
 * Data for an RTVI error event.
 *
 * Contains error information including whether it's fatal.
 */
export class ErrorData extends BaseModel {
  declare error: string;
  /** Indicates the pipeline has stopped due to this error. */
  declare fatal: boolean;

  static override readonly fields: FieldSpecs = {
    error: field(P.str()),
    fatal: field(P.bool()),
  };

  constructor(options: ErrorDataOptions) {
    super(options);
  }
}

export interface ErrorOptions {
  label?: MessageLiteral;
  type?: "error";
  data: ErrorData | ErrorDataOptions;
}

/**
 * RTVI error event message.
 *
 * RTVI formatted error message for relaying errors in the pipeline.
 */
// biome-ignore lint/suspicious/noShadowRestrictedNames: upstream name (RTVI.Error).
export class Error extends BaseModel {
  declare label: MessageLiteral;
  declare type: "error";
  declare data: ErrorData;

  static override readonly fields: FieldSpecs = {
    label: LABEL_FIELD,
    type: typeField("error"),
    data: field(P.model(() => ErrorData)),
  };

  constructor(options: ErrorOptions) {
    super(options);
  }
}

// -- Pipecat -> Client responses and messages.

export interface BotReadyDataOptions {
  version: string;
  about?: Record<string, unknown> | null;
  capabilities?: BotCapabilities | BotCapabilitiesOptions | null;
}

const botCapabilitiesParser: Parser<BotCapabilities> = (v, wire) => {
  if (v instanceof BotCapabilities) return v;
  if (!isPlainObject(v)) fail("Input should be a valid dictionary or instance of BotCapabilities");
  if (!wire) return new BotCapabilities(v);
  const optBool = (key: string): boolean | null => {
    const x = v[key];
    if (x === undefined || x === null) return null;
    if (typeof x !== "boolean") fail("Input should be a valid boolean", [key]);
    return x;
  };
  return new BotCapabilities({
    audioIn: optBool("audio_in"),
    audioOut: optBool("audio_out"),
    videoIn: optBool("video_in"),
    screenIn: optBool("screen_in"),
    videoOut: optBool("video_out"),
    metrics: optBool("metrics"),
  });
};

/**
 * Data for bot ready notification.
 *
 * Contains protocol version and initial configuration.
 *
 * - `version`: the RTVI protocol version the bot speaks with this client.
 * - `about`: information about the bot, such as the Pipecat library and version.
 * - `capabilities`: what the bot does in this session (media sent and
 *   received, metrics), so the client can show only the UI that applies.
 *   Added in protocol 2.2.0.
 */
export class BotReadyData extends BaseModel {
  declare version: string;
  declare about: Record<string, unknown> | null;
  declare capabilities: BotCapabilities | null;

  static override readonly fields: FieldSpecs = {
    version: field(P.str()),
    about: field(P.optional(P.dict()), () => null),
    capabilities: field(P.optional(botCapabilitiesParser), () => null),
  };

  constructor(options: BotReadyDataOptions) {
    super(options);
  }
}

export interface BotReadyOptions {
  label?: MessageLiteral;
  type?: "bot-ready";
  id: string;
  data: BotReadyData | BotReadyDataOptions;
}

/**
 * Message indicating bot is ready for interaction.
 *
 * Sent after bot initialization is complete.
 */
export class BotReady extends BaseModel {
  declare label: MessageLiteral;
  declare type: "bot-ready";
  declare id: string;
  declare data: BotReadyData;

  static override readonly fields: FieldSpecs = {
    label: LABEL_FIELD,
    type: typeField("bot-ready"),
    id: field(P.str()),
    data: field(P.model(() => BotReadyData)),
  };

  constructor(options: BotReadyOptions) {
    super(options);
  }
}

export interface SendTextOptionsOptions {
  runImmediately?: boolean;
  audioResponse?: boolean;
}

/**
 * Options for sending text input to the LLM.
 *
 * Contains options for how the pipeline should process the text input.
 */
export class SendTextOptions extends BaseModel {
  declare runImmediately: boolean;
  declare audioResponse: boolean;

  static override readonly fields: FieldSpecs = {
    runImmediately: field(P.bool(), () => true),
    audioResponse: field(P.bool(), () => true),
  };

  constructor(options: SendTextOptionsOptions = {}) {
    super(options);
  }
}

export interface SendTextDataOptions {
  content: string;
  options?: SendTextOptions | SendTextOptionsOptions | null;
}

/**
 * Data format for sending text input to the LLM.
 *
 * Contains the text content to send and any options for how the pipeline
 * should process it.
 */
export class SendTextData extends BaseModel {
  declare content: string;
  declare options: SendTextOptions | null;

  static override readonly fields: FieldSpecs = {
    content: field(P.str()),
    options: field(P.optional(P.model(() => SendTextOptions)), () => null),
  };

  constructor(options: SendTextDataOptions) {
    super(options);
  }
}

export interface FileSourceOptions {
  type: RTVIFileSourceType;
}

const fileSourceTypeParser = P.literal("bytes", "url");

/** Base class for RTVI file sources. */
export class FileSource extends BaseModel {
  declare type: RTVIFileSourceType;

  static override readonly fields: FieldSpecs = {
    type: field(fileSourceTypeParser),
  };

  constructor(options: FileSourceOptions) {
    super(options);
  }
}

export interface FileBytesOptions {
  type?: RTVIFileSourceType;
  /** Base64-encoded string. */
  bytes: string;
  width?: number | null;
  height?: number | null;
}

/** File source as base64-encoded bytes. */
export class FileBytes extends FileSource {
  /** Base64-encoded string. */
  declare bytes: string;
  declare width: number | null;
  declare height: number | null;

  static override readonly fields: FieldSpecs = {
    type: field(fileSourceTypeParser, () => "bytes" as const),
    bytes: field(P.str()),
    width: field(P.optional(P.int()), () => null),
    height: field(P.optional(P.int()), () => null),
  };

  constructor(options: FileBytesOptions) {
    super(options as FileSourceOptions);
  }
}

export interface FileUrlOptions {
  type?: RTVIFileSourceType;
  url: string;
}

/**
 * File source as a URL.
 *
 * - `url`: the file's URL: whatever the `POST /files` upload endpoint
 *   returned (`pipecat:<id>` with the default local storage, or a URL minted
 *   by a custom storage backend), a cloud-storage URI (`s3://`, `gs://`), or a
 *   plain `http(s)` URL. The URL is resolved at completion time: the LLM
 *   provider fetches it itself when it can (public URLs, its own cloud IAM),
 *   and otherwise the LLM service's `FileResolver` downloads the bytes and
 *   inlines them.
 */
export class FileUrl extends FileSource {
  declare url: string;

  static override readonly fields: FieldSpecs = {
    type: field(fileSourceTypeParser, () => "url" as const),
    url: field(P.str()),
  };

  constructor(options: FileUrlOptions) {
    super(options as FileSourceOptions);
  }
}

export interface FileOptions {
  /** Mime format of the file, e.g. 'application/pdf'. */
  format: string;
  name?: string | null;
  source: FileBytes | FileUrl | FileBytesOptions | FileUrlOptions;
}

/** File data structure for RTVI file sending. */
export class File extends BaseModel {
  /** Mime format of the file, e.g. 'application/pdf'. */
  declare format: string;
  declare name: string | null;
  declare source: FileBytes | FileUrl;

  static override readonly fields: FieldSpecs = {
    format: field(P.str()),
    name: field(P.optional(P.str()), () => null),
    source: field(
      P.union<FileBytes | FileUrl>(
        P.model(() => FileBytes),
        P.model(() => FileUrl),
      ),
    ),
  };

  constructor(options: FileOptions) {
    super(options);
  }
}

export interface SendFileOptionsOptions {
  runImmediately?: boolean;
  audioResponse?: boolean;
  /** E.g. 'detail' in OpenAI or 'citations' in Bedrock. */
  customOptions?: Record<string, unknown> | null;
}

/** Options for sending a file to the LLM. */
export class SendFileOptions extends BaseModel {
  declare runImmediately: boolean;
  declare audioResponse: boolean;
  /** E.g. 'detail' in OpenAI or 'citations' in Bedrock. */
  declare customOptions: Record<string, unknown> | null;

  static override readonly fields: FieldSpecs = {
    runImmediately: field(P.bool(), () => true),
    audioResponse: field(P.bool(), () => true),
    customOptions: field(P.optional(P.dict()), () => null),
  };

  constructor(options: SendFileOptionsOptions = {}) {
    super(options);
  }
}

export interface SendFileDataOptions {
  /** Text to accompany the file. */
  content: string;
  file: File | FileOptions;
  options?: SendFileOptions | SendFileOptionsOptions | null;
}

/**
 * Data format for sending a file to the LLM.
 *
 * Contains the information of the file to send and any options for how the
 * pipeline should process it.
 */
export class SendFileData extends BaseModel {
  /** Text to accompany the file. */
  declare content: string;
  declare file: File;
  declare options: SendFileOptions | null;

  static override readonly fields: FieldSpecs = {
    content: field(P.str()),
    file: field(P.model(() => File)),
    options: field(P.optional(P.model(() => SendFileOptions)), () => null),
  };

  constructor(options: SendFileDataOptions) {
    super(options);
  }
}

export interface DTMFInputDataOptions {
  buttons: KeypadEntry[];
}

/**
 * Data format for DTMF keypresses sent from the client.
 *
 * Carries one or more keypad entries (`0`-`9`, `*`, `#`), delivered in order,
 * so the bot's DTMF handling (e.g. a `DTMFAggregator`) sees them exactly as a
 * telephony transport would deliver rapid keypresses.
 *
 * Protocol 2.1.0 replaced the single `button` field with `buttons`.
 */
export class DTMFInputData extends BaseModel {
  declare buttons: KeypadEntry[];

  static override readonly fields: FieldSpecs = {
    buttons: field(
      P.list(P.literal(...(Object.values(KeypadEntryValues) as KeypadEntry[])), { minLength: 1 }),
    ),
  };

  constructor(options: DTMFInputDataOptions) {
    super(options);
  }
}

export interface LLMFunctionCallStartMessageDataOptions {
  functionName?: string | null;
}

/**
 * Data for LLM function call start notification.
 *
 * Contains the function name being called. Fields may be omitted based on the
 * configured function_call_report_level for security.
 *
 * - `functionName`: name of the function called.
 */
export class LLMFunctionCallStartMessageData extends BaseModel {
  declare functionName: string | null;

  static override readonly fields: FieldSpecs = {
    functionName: field(P.optional(P.str()), () => null),
  };

  constructor(options: LLMFunctionCallStartMessageDataOptions = {}) {
    super(options);
  }
}

export interface LLMFunctionCallStartMessageOptions {
  label?: MessageLiteral;
  type?: "llm-function-call-started";
  data: LLMFunctionCallStartMessageData | LLMFunctionCallStartMessageDataOptions;
}

/**
 * Message notifying that an LLM function call has started.
 *
 * Sent when the LLM begins a function call.
 */
export class LLMFunctionCallStartMessage extends BaseModel {
  declare label: MessageLiteral;
  declare type: "llm-function-call-started";
  declare data: LLMFunctionCallStartMessageData;

  static override readonly fields: FieldSpecs = {
    label: LABEL_FIELD,
    type: typeField("llm-function-call-started"),
    data: field(P.model(() => LLMFunctionCallStartMessageData)),
  };

  constructor(options: LLMFunctionCallStartMessageOptions) {
    super(options);
  }
}

export interface LLMFunctionCallResultDataOptions {
  functionName: string;
  toolCallId: string;
  arguments: Record<string, unknown>;
  result: Record<string, unknown> | string;
}

/**
 * Data for LLM function call result.
 *
 * Contains function call details and result.
 */
export class LLMFunctionCallResultData extends BaseModel {
  declare functionName: string;
  declare toolCallId: string;
  declare arguments: Record<string, unknown>;
  declare result: Record<string, unknown> | string;

  static override readonly fields: FieldSpecs = {
    functionName: field(P.str()),
    toolCallId: field(P.str()),
    arguments: field(P.dict()),
    result: field(P.union<Record<string, unknown> | string>(P.dict(), P.str())),
  };

  constructor(options: LLMFunctionCallResultDataOptions) {
    super(options);
  }
}

export interface LLMFunctionCallInProgressMessageDataOptions {
  toolCallId: string;
  functionName?: string | null;
  arguments?: Record<string, unknown> | null;
}

/**
 * Data for LLM function call in-progress notification.
 *
 * Contains function call details including name, ID, and arguments. Fields
 * may be omitted based on the configured function_call_report_level for
 * security.
 *
 * - `toolCallId`: unique identifier of the call.
 * - `functionName`: name of the function called.
 * - `arguments`: arguments passed to the function.
 */
export class LLMFunctionCallInProgressMessageData extends BaseModel {
  declare toolCallId: string;
  declare functionName: string | null;
  declare arguments: Record<string, unknown> | null;

  static override readonly fields: FieldSpecs = {
    toolCallId: field(P.str()),
    functionName: field(P.optional(P.str()), () => null),
    arguments: field(P.optional(P.dict()), () => null),
  };

  constructor(options: LLMFunctionCallInProgressMessageDataOptions) {
    super(options);
  }
}

export interface LLMFunctionCallInProgressMessageOptions {
  label?: MessageLiteral;
  type?: "llm-function-call-in-progress";
  data: LLMFunctionCallInProgressMessageData | LLMFunctionCallInProgressMessageDataOptions;
}

/**
 * Message notifying that an LLM function call is in progress.
 *
 * Sent when the LLM function call execution begins.
 */
export class LLMFunctionCallInProgressMessage extends BaseModel {
  declare label: MessageLiteral;
  declare type: "llm-function-call-in-progress";
  declare data: LLMFunctionCallInProgressMessageData;

  static override readonly fields: FieldSpecs = {
    label: LABEL_FIELD,
    type: typeField("llm-function-call-in-progress"),
    data: field(P.model(() => LLMFunctionCallInProgressMessageData)),
  };

  constructor(options: LLMFunctionCallInProgressMessageOptions) {
    super(options);
  }
}

export interface LLMFunctionCallStoppedMessageDataOptions {
  toolCallId: string;
  cancelled: boolean;
  functionName?: string | null;
  result?: unknown;
}

/**
 * Data for LLM function call stopped notification.
 *
 * Contains details about the function call that stopped, including whether
 * it was cancelled or completed with a result. Fields may be omitted based on
 * the configured function_call_report_level for security.
 *
 * - `toolCallId`: unique identifier of the call.
 * - `cancelled`: whether the call was cancelled rather than completed.
 * - `functionName`: name of the function called.
 * - `result`: the result, when the call completed with one.
 */
export class LLMFunctionCallStoppedMessageData extends BaseModel {
  declare toolCallId: string;
  declare cancelled: boolean;
  declare functionName: string | null;
  declare result: unknown;

  static override readonly fields: FieldSpecs = {
    toolCallId: field(P.str()),
    cancelled: field(P.bool()),
    functionName: field(P.optional(P.str()), () => null),
    result: field(P.optional(P.any()), () => null),
  };

  constructor(options: LLMFunctionCallStoppedMessageDataOptions) {
    super(options);
  }
}

export interface LLMFunctionCallStoppedMessageOptions {
  label?: MessageLiteral;
  type?: "llm-function-call-stopped";
  data: LLMFunctionCallStoppedMessageData | LLMFunctionCallStoppedMessageDataOptions;
}

/**
 * Message notifying that an LLM function call has stopped.
 *
 * Sent when a function call completes (with result) or is cancelled.
 */
export class LLMFunctionCallStoppedMessage extends BaseModel {
  declare label: MessageLiteral;
  declare type: "llm-function-call-stopped";
  declare data: LLMFunctionCallStoppedMessageData;

  static override readonly fields: FieldSpecs = {
    label: LABEL_FIELD,
    type: typeField("llm-function-call-stopped"),
    data: field(P.model(() => LLMFunctionCallStoppedMessageData)),
  };

  constructor(options: LLMFunctionCallStoppedMessageOptions) {
    super(options);
  }
}

/** Options of a message that only has a label and a type. */
export interface SignalMessageOptions<T extends string> {
  label?: MessageLiteral;
  type?: T;
}

/** Message indicating bot LLM processing has started. */
export class BotLLMStartedMessage extends BaseModel {
  declare label: MessageLiteral;
  declare type: "bot-llm-started";

  static override readonly fields: FieldSpecs = {
    label: LABEL_FIELD,
    type: typeField("bot-llm-started"),
  };

  constructor(options: SignalMessageOptions<"bot-llm-started"> = {}) {
    super(options);
  }
}

/** Message indicating bot LLM processing has stopped. */
export class BotLLMStoppedMessage extends BaseModel {
  declare label: MessageLiteral;
  declare type: "bot-llm-stopped";

  static override readonly fields: FieldSpecs = {
    label: LABEL_FIELD,
    type: typeField("bot-llm-stopped"),
  };

  constructor(options: SignalMessageOptions<"bot-llm-stopped"> = {}) {
    super(options);
  }
}

/** Message indicating bot TTS processing has started. */
export class BotTTSStartedMessage extends BaseModel {
  declare label: MessageLiteral;
  declare type: "bot-tts-started";

  static override readonly fields: FieldSpecs = {
    label: LABEL_FIELD,
    type: typeField("bot-tts-started"),
  };

  constructor(options: SignalMessageOptions<"bot-tts-started"> = {}) {
    super(options);
  }
}

/** Message indicating bot TTS processing has stopped. */
export class BotTTSStoppedMessage extends BaseModel {
  declare label: MessageLiteral;
  declare type: "bot-tts-stopped";

  static override readonly fields: FieldSpecs = {
    label: LABEL_FIELD,
    type: typeField("bot-tts-stopped"),
  };

  constructor(options: SignalMessageOptions<"bot-tts-stopped"> = {}) {
    super(options);
  }
}

export interface TextMessageDataOptions {
  text: string;
}

/**
 * Data for text-based RTVI messages.
 *
 * Contains text content.
 */
export class TextMessageData extends BaseModel {
  declare text: string;

  static override readonly fields: FieldSpecs = {
    text: field(P.str()),
  };

  constructor(options: TextMessageDataOptions) {
    super(options);
  }
}

export type SpokenStatus = "new" | "in-progress" | "completed" | null;

export interface SpokenProgressDataOptions {
  accumulatedText: string;
  remainingText: string;
}

/**
 * Word-level TTS progress within a spoken segment.
 *
 * - `accumulatedText`: text already spoken in this segment, including the
 *   current word.
 * - `remainingText`: text not yet spoken in this segment.
 */
export class SpokenProgressData extends BaseModel {
  declare accumulatedText: string;
  declare remainingText: string;

  static override readonly fields: FieldSpecs = {
    accumulatedText: field(P.str()),
    remainingText: field(P.str()),
  };

  constructor(options: SpokenProgressDataOptions) {
    super(options);
  }
}

export interface BotOutputTransformResultOptions {
  text: string;
  accumulatedText?: string | null;
  remainingText?: string | null;
}

/**
 * Return type for bot output transform functions.
 *
 * - `text`: the transformed full text of the segment.
 * - `accumulatedText`: transformed spoken-so-far portion. Only populated when
 *   the transform is called from a progress context.
 * - `remainingText`: transformed not-yet-spoken portion. Only populated when
 *   the transform is called from a progress context.
 */
export class BotOutputTransformResult extends BaseModel {
  declare text: string;
  declare accumulatedText: string | null;
  declare remainingText: string | null;

  static override readonly fields: FieldSpecs = {
    text: field(P.str()),
    accumulatedText: field(P.optional(P.str()), () => null),
    remainingText: field(P.optional(P.str()), () => null),
  };

  constructor(options: BotOutputTransformResultOptions) {
    super(options);
  }
}

export interface BotOutputMessageDataOptions extends TextMessageDataOptions {
  textType?: TextType | string;
  aggregatedBy?: TextType | string | null;
  segmentId?: number | null;
  spoken?: boolean | null;
  willBeSpoken?: boolean | null;
  spokenStatus?: SpokenStatus;
  spokenProgress?: SpokenProgressData | SpokenProgressDataOptions | null;
}

/**
 * Data for bot output RTVI messages.
 *
 * Extends TextMessageData to include metadata about the output.
 *
 * This class supports both protocol v1 (1.4.x) and v2 (2.0.0+) clients. The
 * observer populates different field subsets depending on the negotiated
 * version; `sendRtviMessage` serialises with `excludeNone: true` so each
 * client only sees the fields relevant to its version.
 *
 * - `textType`: what form the text is in (e.g., sentence, code, etc.).
 * - `aggregatedBy`: what form the text is in, always the same as `textType`.
 *   Deprecated upstream since 1.13.0 (use `textType`); kept because it is
 *   still on the wire.
 * - `segmentId`: ID of the source AggregatedTextFrame.
 * - `spoken`: **(v1 only)** whether the text has been spoken by TTS.
 * - `willBeSpoken`: **(v2+)** whether the text will be spoken by TTS.
 * - `spokenStatus`: **(v2+)** lifecycle status of the segment: `"new"` on its
 *   first message, the only one for text that isn't spoken; `"in-progress"`
 *   as each of its words is spoken, for TTS services with word timestamps;
 *   `"completed"` once its last word is spoken.
 * - `spokenProgress`: **(v2+)** accumulated / remaining text breakdown.
 *   Present when `willBeSpoken` is true.
 */
export class BotOutputMessageData extends TextMessageData {
  declare textType: TextType | string;
  declare aggregatedBy: TextType | string | null;
  declare segmentId: number | null;
  // v1 field (protocol 1.4.x)
  declare spoken: boolean | null;
  // v2 fields (protocol 2.0.0+)
  declare willBeSpoken: boolean | null;
  declare spokenStatus: SpokenStatus;
  declare spokenProgress: SpokenProgressData | null;

  static override readonly fields: FieldSpecs = {
    ...TextMessageData.fields,
    textType: field<string>(P.str()),
    aggregatedBy: field(P.optional(P.str()), () => null),
    segmentId: field(P.optional(P.int()), () => null),
    spoken: field(P.optional(P.bool()), () => null),
    willBeSpoken: field(P.optional(P.bool()), () => null),
    spokenStatus: field(P.optional(P.literal("new", "in-progress", "completed")), () => null),
    spokenProgress: field(P.optional(P.model(() => SpokenProgressData)), () => null),
  };

  constructor(options: BotOutputMessageDataOptions) {
    super(options as TextMessageDataOptions);
  }

  /** Fill whichever of `textType` and `aggregatedBy` is missing from the other. */
  protected static override _beforeValidate(
    data: Record<string, unknown>,
  ): Record<string, unknown> {
    if (data.textType === undefined && data.aggregatedBy !== undefined) {
      return { ...data, textType: data.aggregatedBy };
    } else if (data.aggregatedBy === undefined && data.textType !== undefined) {
      return { ...data, aggregatedBy: data.textType };
    }
    return data;
  }
}

export interface BotOutputMessageOptions {
  label?: MessageLiteral;
  type?: "bot-output";
  data: BotOutputMessageData | BotOutputMessageDataOptions;
}

/**
 * Message containing bot output text.
 *
 * An event meant to holistically represent what the bot is outputting, along
 * with metadata about the output and if it has been spoken.
 */
export class BotOutputMessage extends BaseModel {
  declare label: MessageLiteral;
  declare type: "bot-output";
  declare data: BotOutputMessageData;

  static override readonly fields: FieldSpecs = {
    label: LABEL_FIELD,
    type: typeField("bot-output"),
    data: field(P.model(() => BotOutputMessageData)),
  };

  constructor(options: BotOutputMessageOptions) {
    super(options);
  }
}

/** Options of a message whose data is a `TextMessageData`. */
export interface TextMessageOptions<T extends string> {
  label?: MessageLiteral;
  type?: T;
  data: TextMessageData | TextMessageDataOptions;
}

/**
 * Message containing bot transcription text.
 *
 * Sent when the bot's speech is transcribed.
 */
export class BotTranscriptionMessage extends BaseModel {
  declare label: MessageLiteral;
  declare type: "bot-transcription";
  declare data: TextMessageData;

  static override readonly fields: FieldSpecs = {
    label: LABEL_FIELD,
    type: typeField("bot-transcription"),
    data: field(P.model(() => TextMessageData)),
  };

  constructor(options: TextMessageOptions<"bot-transcription">) {
    super(options);
  }
}

/**
 * Message containing bot LLM text output.
 *
 * Sent when the bot's LLM generates text.
 *
 * Deprecated upstream since 1.13.0 (use `LLMRawTextMessage`); kept because
 * the observer still sends it while `botLlmEnabled` is on.
 */
export class BotLLMTextMessage extends BaseModel {
  declare label: MessageLiteral;
  declare type: "bot-llm-text";
  declare data: TextMessageData;

  static override readonly fields: FieldSpecs = {
    label: LABEL_FIELD,
    type: typeField("bot-llm-text"),
    data: field(P.model(() => TextMessageData)),
  };

  constructor(options: TextMessageOptions<"bot-llm-text">) {
    super(options);
  }
}

export interface BotLLMMarkerMessageDataOptions {
  text: string;
  kind?: string | null;
  raw?: string;
  markers?: string[];
}

/**
 * Data for a bot LLM marker message.
 *
 * - `text`: the marker as the LLM produced it; empty when the response
 *   carried none.
 * - `kind`: what the marker means, in the emitter's vocabulary (the
 *   turn-completion mixin's `complete`, `short` or `long`), or `null` when the
 *   emitter gave none.
 * - `raw`: the response's text as the LLM produced it, markers included.
 * - `markers`: every marker the emitter recognizes.
 */
export class BotLLMMarkerMessageData extends BaseModel {
  declare text: string;
  declare kind: string | null;
  declare raw: string;
  declare markers: string[];

  static override readonly fields: FieldSpecs = {
    text: field(P.str()),
    kind: field(P.optional(P.str()), () => null),
    raw: field(P.str(), () => ""),
    markers: field(P.list(P.str()), () => []),
  };

  constructor(options: BotLLMMarkerMessageDataOptions) {
    super(options);
  }
}

export interface BotLLMMarkerMessageOptions {
  label?: MessageLiteral;
  type?: "bot-llm-marker";
  data: BotLLMMarkerMessageData | BotLLMMarkerMessageDataOptions;
}

/**
 * Message reporting the sideband marker the bot's LLM emitted in a response.
 *
 * A marker is structured assistant output kept out of the spoken text, such
 * as the turn-completion markers of `filterIncompleteUserTurns`. Sent once
 * per response, when it ends, and only when the observer's
 * `botLlmMarkerEnabled` is on.
 */
export class BotLLMMarkerMessage extends BaseModel {
  declare label: MessageLiteral;
  declare type: "bot-llm-marker";
  declare data: BotLLMMarkerMessageData;

  static override readonly fields: FieldSpecs = {
    label: LABEL_FIELD,
    type: typeField("bot-llm-marker"),
    data: field(P.model(() => BotLLMMarkerMessageData)),
  };

  constructor(options: BotLLMMarkerMessageOptions) {
    super(options);
  }
}

/**
 * Message containing bot TTS text output.
 *
 * Sent when text is being processed by TTS.
 *
 * Deprecated upstream since 1.13.0 (use `TTSRawTextMessage`); kept because
 * the observer still sends it while `botTtsEnabled` is on.
 */
export class BotTTSTextMessage extends BaseModel {
  declare label: MessageLiteral;
  declare type: "bot-tts-text";
  declare data: TextMessageData;

  static override readonly fields: FieldSpecs = {
    label: LABEL_FIELD,
    type: typeField("bot-tts-text"),
    data: field(P.model(() => TextMessageData)),
  };

  constructor(options: TextMessageOptions<"bot-tts-text">) {
    super(options);
  }
}

export interface AudioMessageDataOptions {
  audio: string;
  sampleRate: number;
  numChannels: number;
}

/**
 * Data for audio-based RTVI messages.
 *
 * Contains audio data and metadata.
 */
export class AudioMessageData extends BaseModel {
  declare audio: string;
  declare sampleRate: number;
  declare numChannels: number;

  static override readonly fields: FieldSpecs = {
    audio: field(P.str()),
    sampleRate: field(P.int()),
    numChannels: field(P.int()),
  };

  constructor(options: AudioMessageDataOptions) {
    super(options);
  }
}

export interface BotTTSAudioMessageOptions {
  label?: MessageLiteral;
  type?: "bot-tts-audio";
  data: AudioMessageData | AudioMessageDataOptions;
}

/**
 * Message containing bot TTS audio output.
 *
 * Sent when the bot's TTS generates audio.
 */
export class BotTTSAudioMessage extends BaseModel {
  declare label: MessageLiteral;
  declare type: "bot-tts-audio";
  declare data: AudioMessageData;

  static override readonly fields: FieldSpecs = {
    label: LABEL_FIELD,
    type: typeField("bot-tts-audio"),
    data: field(P.model(() => AudioMessageData)),
  };

  constructor(options: BotTTSAudioMessageOptions) {
    super(options);
  }
}

export interface UserTranscriptionMessageDataOptions {
  text: string;
  userId: string;
  timestamp: string;
  final: boolean;
}

/**
 * Data for user transcription messages.
 *
 * Contains transcription text and metadata.
 *
 * Deprecated upstream since 1.13.0 (use `STTRawTextMessageData`); kept
 * because the observer still sends `user-transcription` messages.
 */
export class UserTranscriptionMessageData extends BaseModel {
  declare text: string;
  declare userId: string;
  declare timestamp: string;
  declare final: boolean;

  static override readonly fields: FieldSpecs = {
    text: field(P.str()),
    userId: field(P.str()),
    timestamp: field(P.str()),
    final: field(P.bool()),
  };

  constructor(options: UserTranscriptionMessageDataOptions) {
    super(options);
  }
}

export interface UserTranscriptionMessageOptions {
  label?: MessageLiteral;
  type?: "user-transcription";
  data: UserTranscriptionMessageData | UserTranscriptionMessageDataOptions;
}

/**
 * Message containing user transcription.
 *
 * Sent when user speech is transcribed.
 *
 * Deprecated upstream since 1.13.0 (use `STTRawTextMessage`, or
 * `UserInputMessage` for what the user said); kept because the observer
 * still sends it.
 */
export class UserTranscriptionMessage extends BaseModel {
  declare label: MessageLiteral;
  declare type: "user-transcription";
  declare data: UserTranscriptionMessageData;

  static override readonly fields: FieldSpecs = {
    label: LABEL_FIELD,
    type: typeField("user-transcription"),
    data: field(P.model(() => UserTranscriptionMessageData)),
  };

  constructor(options: UserTranscriptionMessageOptions) {
    super(options);
  }
}

export type UserInputType = "transcription" | "chat" | "backchannel";

export interface UserInputMessageDataOptions {
  text: string;
  inputType: UserInputType;
  timestamp: string;
  final: boolean;
  userId?: string | null;
  msgId?: string | null;
}

/**
 * Data for user input messages.
 *
 * - `text`: what the user said or typed.
 * - `inputType`: what kind of input it is: `"transcription"` for speech
 *   transcribed by the STT, `"chat"` for text the client sent, or
 *   `"backchannel"` for a short acknowledgment the user said while the bot
 *   talks, such as "mhm".
 * - `timestamp`: when the user said or sent it.
 * - `final`: whether the text is final. Only an interim transcription isn't.
 * - `userId`: identifier for the user who spoke or typed. For chat, set only
 *   when the transport knows the sender, such as Daily and LiveKit.
 * - `msgId`: for chat, the id of the client's `send-text` message.
 */
export class UserInputMessageData extends BaseModel {
  declare text: string;
  declare inputType: UserInputType;
  declare timestamp: string;
  declare final: boolean;
  declare userId: string | null;
  declare msgId: string | null;

  static override readonly fields: FieldSpecs = {
    text: field(P.str()),
    inputType: field(P.literal("transcription", "chat", "backchannel")),
    timestamp: field(P.str()),
    final: field(P.bool()),
    userId: field(P.optional(P.str()), () => null),
    msgId: field(P.optional(P.str()), () => null),
  };

  constructor(options: UserInputMessageDataOptions) {
    super(options);
  }
}

export interface UserInputMessageOptions {
  label?: MessageLiteral;
  type?: "user-input";
  data: UserInputMessageData | UserInputMessageDataOptions;
}

/**
 * Message containing what the user said or typed.
 *
 * The user's counterpart of `bot-output`. A backchannel doesn't interrupt the
 * bot or reach the LLM.
 */
export class UserInputMessage extends BaseModel {
  declare label: MessageLiteral;
  declare type: "user-input";
  declare data: UserInputMessageData;

  static override readonly fields: FieldSpecs = {
    label: LABEL_FIELD,
    type: typeField("user-input"),
    data: field(P.model(() => UserInputMessageData)),
  };

  constructor(options: UserInputMessageOptions) {
    super(options);
  }
}

/**
 * Message containing user text input for LLM.
 *
 * Sent when user text is processed by the LLM.
 */
export class UserLLMTextMessage extends BaseModel {
  declare label: MessageLiteral;
  declare type: "user-llm-text";
  declare data: TextMessageData;

  static override readonly fields: FieldSpecs = {
    label: LABEL_FIELD,
    type: typeField("user-llm-text"),
    data: field(P.model(() => TextMessageData)),
  };

  constructor(options: TextMessageOptions<"user-llm-text">) {
    super(options);
  }
}

export interface STTRawTextMessageDataOptions {
  text: string;
  userId: string;
  timestamp: string;
  final: boolean;
}

/**
 * Data for STT raw text messages.
 *
 * - `text`: the transcribed text.
 * - `userId`: identifier for the user who spoke.
 * - `timestamp`: when the user said it.
 * - `final`: whether the transcription is final, as opposed to interim.
 */
export class STTRawTextMessageData extends BaseModel {
  declare text: string;
  declare userId: string;
  declare timestamp: string;
  declare final: boolean;

  static override readonly fields: FieldSpecs = {
    text: field(P.str()),
    userId: field(P.str()),
    timestamp: field(P.str()),
    final: field(P.bool()),
  };

  constructor(options: STTRawTextMessageDataOptions) {
    super(options);
  }
}

export interface STTRawTextMessageOptions {
  label?: MessageLiteral;
  type?: "stt-raw-text";
  data: STTRawTextMessageData | STTRawTextMessageDataOptions;
}

/** Message reporting a transcription as the STT produced it, interim ones included. */
export class STTRawTextMessage extends BaseModel {
  declare label: MessageLiteral;
  declare type: "stt-raw-text";
  declare data: STTRawTextMessageData;

  static override readonly fields: FieldSpecs = {
    label: LABEL_FIELD,
    type: typeField("stt-raw-text"),
    data: field(P.model(() => STTRawTextMessageData)),
  };

  constructor(options: STTRawTextMessageOptions) {
    super(options);
  }
}

/** Message reporting a chunk of text as the LLM streamed it. */
export class LLMRawTextMessage extends BaseModel {
  declare label: MessageLiteral;
  declare type: "llm-raw-text";
  declare data: TextMessageData;

  static override readonly fields: FieldSpecs = {
    label: LABEL_FIELD,
    type: typeField("llm-raw-text"),
    data: field(P.model(() => TextMessageData)),
  };

  constructor(options: TextMessageOptions<"llm-raw-text">) {
    super(options);
  }
}

/** Message reporting text the TTS speaks, as it is spoken. */
export class TTSRawTextMessage extends BaseModel {
  declare label: MessageLiteral;
  declare type: "tts-raw-text";
  declare data: TextMessageData;

  static override readonly fields: FieldSpecs = {
    label: LABEL_FIELD,
    type: typeField("tts-raw-text"),
    data: field(P.model(() => TextMessageData)),
  };

  constructor(options: TextMessageOptions<"tts-raw-text">) {
    super(options);
  }
}

/** Message indicating user has started speaking. */
export class UserStartedSpeakingMessage extends BaseModel {
  declare label: MessageLiteral;
  declare type: "user-started-speaking";

  static override readonly fields: FieldSpecs = {
    label: LABEL_FIELD,
    type: typeField("user-started-speaking"),
  };

  constructor(options: SignalMessageOptions<"user-started-speaking"> = {}) {
    super(options);
  }
}

/** Message indicating user has stopped speaking. */
export class UserStoppedSpeakingMessage extends BaseModel {
  declare label: MessageLiteral;
  declare type: "user-stopped-speaking";

  static override readonly fields: FieldSpecs = {
    label: LABEL_FIELD,
    type: typeField("user-stopped-speaking"),
  };

  constructor(options: SignalMessageOptions<"user-stopped-speaking"> = {}) {
    super(options);
  }
}

/**
 * Message indicating VAD detected the user started speaking.
 *
 * Raw VAD signal, emitted independently of turn finalization (unlike
 * `user-started-speaking`, which a turn strategy may gate or defer).
 */
export class VADUserStartedSpeakingMessage extends BaseModel {
  declare label: MessageLiteral;
  declare type: "vad-user-started-speaking";

  static override readonly fields: FieldSpecs = {
    label: LABEL_FIELD,
    type: typeField("vad-user-started-speaking"),
  };

  constructor(options: SignalMessageOptions<"vad-user-started-speaking"> = {}) {
    super(options);
  }
}

/**
 * Message indicating VAD detected the user stopped speaking.
 *
 * Raw VAD signal, emitted independently of turn finalization (unlike
 * `user-stopped-speaking`, which a turn strategy may gate or defer).
 */
export class VADUserStoppedSpeakingMessage extends BaseModel {
  declare label: MessageLiteral;
  declare type: "vad-user-stopped-speaking";

  static override readonly fields: FieldSpecs = {
    label: LABEL_FIELD,
    type: typeField("vad-user-stopped-speaking"),
  };

  constructor(options: SignalMessageOptions<"vad-user-stopped-speaking"> = {}) {
    super(options);
  }
}

/** Message indicating user has been muted. */
export class UserMuteStartedMessage extends BaseModel {
  declare label: MessageLiteral;
  declare type: "user-mute-started";

  static override readonly fields: FieldSpecs = {
    label: LABEL_FIELD,
    type: typeField("user-mute-started"),
  };

  constructor(options: SignalMessageOptions<"user-mute-started"> = {}) {
    super(options);
  }
}

/** Message indicating user has been unmuted. */
export class UserMuteStoppedMessage extends BaseModel {
  declare label: MessageLiteral;
  declare type: "user-mute-stopped";

  static override readonly fields: FieldSpecs = {
    label: LABEL_FIELD,
    type: typeField("user-mute-stopped"),
  };

  constructor(options: SignalMessageOptions<"user-mute-stopped"> = {}) {
    super(options);
  }
}

/** Message indicating bot has started speaking. */
export class BotStartedSpeakingMessage extends BaseModel {
  declare label: MessageLiteral;
  declare type: "bot-started-speaking";

  static override readonly fields: FieldSpecs = {
    label: LABEL_FIELD,
    type: typeField("bot-started-speaking"),
  };

  constructor(options: SignalMessageOptions<"bot-started-speaking"> = {}) {
    super(options);
  }
}

/** Message indicating bot has stopped speaking. */
export class BotStoppedSpeakingMessage extends BaseModel {
  declare label: MessageLiteral;
  declare type: "bot-stopped-speaking";

  static override readonly fields: FieldSpecs = {
    label: LABEL_FIELD,
    type: typeField("bot-stopped-speaking"),
  };

  constructor(options: SignalMessageOptions<"bot-stopped-speaking"> = {}) {
    super(options);
  }
}

/**
 * Message indicating the bot was interrupted and its in-flight output cut off.
 *
 * Fires for any pipeline interruption (a VAD-detected user barge-in or a
 * programmatic interrupt, e.g. `send-text` with `run_immediately`) so a
 * client can drop whatever the bot was mid-saying.
 */
export class BotInterruptedMessage extends BaseModel {
  declare label: MessageLiteral;
  declare type: "bot-interrupted";

  static override readonly fields: FieldSpecs = {
    label: LABEL_FIELD,
    type: typeField("bot-interrupted"),
  };

  constructor(options: SignalMessageOptions<"bot-interrupted"> = {}) {
    super(options);
  }
}

export interface MetricsMessageOptions {
  label?: MessageLiteral;
  type?: "metrics";
  data: Record<string, unknown>;
}

/**
 * Message containing performance metrics.
 *
 * Sent to provide performance and usage metrics.
 */
export class MetricsMessage extends BaseModel {
  declare label: MessageLiteral;
  declare type: "metrics";
  declare data: Record<string, unknown>;

  static override readonly fields: FieldSpecs = {
    label: LABEL_FIELD,
    type: typeField("metrics"),
    data: field(P.dict()),
  };

  constructor(options: MetricsMessageOptions) {
    super(options);
  }
}

export interface ServerMessageOptions {
  label?: MessageLiteral;
  type?: "server-message";
  data: unknown;
}

/**
 * Generic server message.
 *
 * Used for custom server-to-client messages.
 */
export class ServerMessage extends BaseModel {
  declare label: MessageLiteral;
  declare type: "server-message";
  declare data: unknown;

  static override readonly fields: FieldSpecs = {
    label: LABEL_FIELD,
    type: typeField("server-message"),
    // `Any` without a default: the key is required, but `null` is accepted.
    data: field(P.any()),
  };

  constructor(options: ServerMessageOptions) {
    super(options);
  }
}

export interface AudioLevelMessageDataOptions {
  value: number;
}

/** Data format for sending audio levels. */
export class AudioLevelMessageData extends BaseModel {
  declare value: number;

  static override readonly fields: FieldSpecs = {
    value: field(P.float()),
  };

  constructor(options: AudioLevelMessageDataOptions) {
    super(options);
  }
}

export interface AudioLevelMessageOptions<T extends string> {
  label?: MessageLiteral;
  type?: T;
  data: AudioLevelMessageData | AudioLevelMessageDataOptions;
}

/** Message indicating user audio level. */
export class UserAudioLevelMessage extends BaseModel {
  declare label: MessageLiteral;
  declare type: "user-audio-level";
  declare data: AudioLevelMessageData;

  static override readonly fields: FieldSpecs = {
    label: LABEL_FIELD,
    type: typeField("user-audio-level"),
    data: field(P.model(() => AudioLevelMessageData)),
  };

  constructor(options: AudioLevelMessageOptions<"user-audio-level">) {
    super(options);
  }
}

/** Message indicating bot audio level. */
export class BotAudioLevelMessage extends BaseModel {
  declare label: MessageLiteral;
  declare type: "bot-audio-level";
  declare data: AudioLevelMessageData;

  static override readonly fields: FieldSpecs = {
    label: LABEL_FIELD,
    type: typeField("bot-audio-level"),
    data: field(P.model(() => AudioLevelMessageData)),
  };

  constructor(options: AudioLevelMessageOptions<"bot-audio-level">) {
    super(options);
  }
}

/** Message including a system log. */
export class SystemLogMessage extends BaseModel {
  declare label: MessageLiteral;
  declare type: "system-log";
  declare data: TextMessageData;

  static override readonly fields: FieldSpecs = {
    label: LABEL_FIELD,
    type: typeField("system-log"),
    data: field(P.model(() => TextMessageData)),
  };

  constructor(options: TextMessageOptions<"system-log">) {
    super(options);
  }
}

// -- UI Worker Protocol ------------------------------------------------------
//
// A structured RTVI message vocabulary that lets server-side workers observe
// and drive a GUI app on the client side. The protocol covers five
// first-class RTVI message types:
//
//   ui-event              client-to-server event message
//   ui-command            server-to-client command message
//   ui-snapshot           client-to-server accessibility snapshot
//   ui-cancel-job-group   client-to-server cancellation request
//   ui-job-group          server-to-client job-group lifecycle envelope
//
// This section is data only (constants and payload models, no behavior).
// `UIWorker` (workers/ui) builds the higher-level abstractions on top, and
// single-LLM Pipecat apps can target the same wire format directly via custom
// tools that emit typed RTVI messages with these types. The matching
// client-side implementation lives in `@pipecat-ai/client-js` and
// `@pipecat-ai/client-react`.

// The wire-format `type` strings ("ui-event", "ui-command", "ui-snapshot",
// "ui-cancel-job-group", "ui-job-group") are pinned as literal field defaults
// on the corresponding `*Message` class below, matching the convention used
// for every other RTVI message type in this module.

// Each `ui-job-group` envelope carries a `kind` field that the client's
// reducer dispatches on. The four kinds form the lifecycle of a user-facing
// job group:
//
//   group_started -> job_update* -> job_completed x N -> group_completed
//
// where N is the number of workers in the group. The kind strings are pinned
// as literal defaults on the matching `UIJob*Data` class below.

// -- UI envelope data classes --

export interface UIEventDataOptions {
  event: string;
  payload?: unknown;
}

/**
 * Inner `data` for a `ui-event` message.
 *
 * - `event`: app-defined event.
 * - `payload`: app-defined payload, schemaless by design.
 */
export class UIEventData extends BaseModel {
  declare event: string;
  declare payload: unknown;

  static override readonly fields: FieldSpecs = {
    event: field(P.str()),
    payload: field(P.optional(P.any()), () => null),
  };

  constructor(options: UIEventDataOptions) {
    super(options);
  }
}

export interface UICommandDataOptions {
  command: string;
  payload?: unknown;
}

/**
 * Inner `data` for a `ui-command` message.
 *
 * - `command`: app-defined command.
 * - `payload`: app-defined payload (already a plain object by the time it
 *   lands on the wire). The standard command payload models below produce the
 *   right shape via `modelDump()`.
 */
export class UICommandData extends BaseModel {
  declare command: string;
  declare payload: unknown;

  static override readonly fields: FieldSpecs = {
    command: field(P.str()),
    payload: field(P.optional(P.any()), () => null),
  };

  constructor(options: UICommandDataOptions) {
    super(options);
  }
}

export interface A11yNodeOptions {
  ref: string;
  role: string;
  name?: string | null;
  value?: string | null;
  state?: string[] | null;
  level?: number | null;
  colcount?: number | null;
  rowcount?: number | null;
  children?: (A11yNode | A11yNodeOptions)[] | null;
  /** Extra fields are allowed. */
  [key: string]: unknown;
}

/**
 * One node in the UI accessibility snapshot tree.
 *
 * Mirrors the client-side `A11yNode` wire shape. Extra fields are allowed
 * (kept in `modelExtra`) so clients can add platform-specific or future
 * metadata without breaking older servers.
 *
 * - `ref`: stable client-assigned element reference.
 * - `role`: ARIA-style role for the node.
 * - `name`: optional accessible name.
 * - `value`: optional current value for inputs/progress/etc.
 * - `state`: optional short state tags (e.g. `"focused"`, `"disabled"`,
 *   `"offscreen"`).
 * - `level`: optional heading level.
 * - `colcount`: optional column count for grid-like containers.
 * - `rowcount`: optional row count for grid-like containers.
 * - `children`: optional child nodes.
 */
export class A11yNode extends BaseModel {
  static override readonly extra = "allow" as const;

  declare ref: string;
  declare role: string;
  declare name: string | null;
  declare value: string | null;
  declare state: string[] | null;
  declare level: number | null;
  declare colcount: number | null;
  declare rowcount: number | null;
  declare children: A11yNode[] | null;

  static override readonly fields: FieldSpecs = {
    ref: field(P.str()),
    role: field(P.str()),
    name: field(P.optional(P.str()), () => null),
    value: field(P.optional(P.str()), () => null),
    state: field(P.optional(P.list(P.str())), () => null),
    level: field(P.optional(P.int()), () => null),
    colcount: field(P.optional(P.int()), () => null),
    rowcount: field(P.optional(P.int()), () => null),
    children: field(P.optional(P.list(P.model(() => A11yNode))), () => null),
  };

  constructor(options: A11yNodeOptions) {
    super(options);
  }
}

export interface A11ySelectionOptions {
  ref: string;
  text: string;
  startOffset?: number | null;
  endOffset?: number | null;
  /** Extra fields are allowed. */
  [key: string]: unknown;
}

/**
 * The user's current text selection in the UI snapshot.
 *
 * Extra fields are allowed for forward compatibility with client snapshot
 * additions.
 *
 * - `ref`: ref of the element that carries the selection.
 * - `text`: selected text.
 * - `startOffset`: optional selection start offset.
 * - `endOffset`: optional selection end offset.
 */
export class A11ySelection extends BaseModel {
  static override readonly extra = "allow" as const;

  declare ref: string;
  declare text: string;
  declare startOffset: number | null;
  declare endOffset: number | null;

  static override readonly fields: FieldSpecs = {
    ref: field(P.str()),
    text: field(P.str()),
    startOffset: field(P.optional(P.int()), () => null),
    endOffset: field(P.optional(P.int()), () => null),
  };

  constructor(options: A11ySelectionOptions) {
    super(options);
  }
}

export interface A11ySnapshotOptions {
  root: A11yNode | A11yNodeOptions;
  capturedAt: number;
  selection?: A11ySelection | A11ySelectionOptions | null;
  /** Extra fields are allowed. */
  [key: string]: unknown;
}

/**
 * Client accessibility snapshot sent in a `ui-snapshot` message.
 *
 * Mirrors the client-side `A11ySnapshot` wire shape. Extra fields are allowed
 * so clients can add compatible metadata over time.
 *
 * - `root`: root accessibility node.
 * - `capturedAt`: client-side epoch milliseconds when captured.
 * - `selection`: optional current text selection.
 */
export class A11ySnapshot extends BaseModel {
  static override readonly extra = "allow" as const;

  declare root: A11yNode;
  declare capturedAt: number;
  declare selection: A11ySelection | null;

  static override readonly fields: FieldSpecs = {
    root: field(P.model(() => A11yNode)),
    capturedAt: field(P.int()),
    selection: field(P.optional(P.model(() => A11ySelection)), () => null),
  };

  constructor(options: A11ySnapshotOptions) {
    super(options);
  }
}

export interface UISnapshotDataOptions {
  tree: A11ySnapshot | A11ySnapshotOptions;
}

/**
 * Inner `data` for a `ui-snapshot` message.
 *
 * The accessibility snapshot tree mirrors the client-side `A11ySnapshot` wire
 * shape and is kept forward-compatible by allowing extra fields on the
 * snapshot models.
 *
 * - `tree`: the serialized accessibility tree.
 */
export class UISnapshotData extends BaseModel {
  declare tree: A11ySnapshot;

  static override readonly fields: FieldSpecs = {
    tree: field(P.model(() => A11ySnapshot)),
  };

  constructor(options: UISnapshotDataOptions) {
    super(options);
  }
}

export interface UICancelJobGroupDataOptions {
  jobId: string;
  reason?: string | null;
}

/**
 * Inner `data` for a `ui-cancel-job-group` message.
 *
 * - `jobId`: the job group id the client wants cancelled.
 * - `reason`: optional human-readable reason.
 */
export class UICancelJobGroupData extends BaseModel {
  declare jobId: string;
  declare reason: string | null;

  static override readonly fields: FieldSpecs = {
    jobId: field(P.str()),
    reason: field(P.optional(P.str()), () => null),
  };

  constructor(options: UICancelJobGroupDataOptions) {
    super(options);
  }
}

export interface UIJobGroupStartedDataOptions {
  kind?: "group_started";
  jobId: string;
  workers?: string[] | null;
  label?: string | null;
  cancellable?: boolean;
  at?: number;
}

/**
 * `data` for a `ui-job-group` envelope with kind `group_started`.
 *
 * - `kind`: always `"group_started"`.
 * - `jobId`: shared job-group identifier for the group.
 * - `workers`: names of the workers the work was dispatched to.
 * - `label`: optional human-readable label for the group.
 * - `cancellable`: whether the client may request cancellation.
 * - `at`: epoch milliseconds when the group started.
 */
export class UIJobGroupStartedData extends BaseModel {
  declare kind: "group_started";
  declare jobId: string;
  declare workers: string[] | null;
  declare label: string | null;
  declare cancellable: boolean;
  declare at: number;

  static override readonly fields: FieldSpecs = {
    kind: field(P.literal("group_started"), () => "group_started" as const),
    jobId: field(P.str()),
    workers: field(P.optional(P.list(P.str())), () => null),
    label: field(P.optional(P.str()), () => null),
    cancellable: field(P.bool(), () => true),
    at: field(P.int(), () => 0),
  };

  constructor(options: UIJobGroupStartedDataOptions) {
    super(options);
  }
}

export interface UIJobUpdateDataOptions {
  kind?: "job_update";
  jobId: string;
  workerName: string;
  data?: unknown;
  at?: number;
}

/**
 * `data` for a `ui-job-group` envelope with kind `job_update`.
 *
 * - `kind`: always `"job_update"`.
 * - `jobId`: the shared job-group identifier.
 * - `workerName`: the worker that produced the update.
 * - `data`: the worker's update payload, forwarded verbatim.
 * - `at`: epoch milliseconds when the update was emitted.
 */
export class UIJobUpdateData extends BaseModel {
  declare kind: "job_update";
  declare jobId: string;
  declare workerName: string;
  declare data: unknown;
  declare at: number;

  static override readonly fields: FieldSpecs = {
    kind: field(P.literal("job_update"), () => "job_update" as const),
    jobId: field(P.str()),
    workerName: field(P.str()),
    data: field(P.optional(P.any()), () => null),
    at: field(P.int(), () => 0),
  };

  constructor(options: UIJobUpdateDataOptions) {
    super(options);
  }
}

export interface UIJobCompletedDataOptions {
  kind?: "job_completed";
  jobId: string;
  workerName: string;
  status: string;
  response?: unknown;
  at?: number;
}

/**
 * `data` for a `ui-job-group` envelope with kind `job_completed`.
 *
 * - `kind`: always `"job_completed"`.
 * - `jobId`: the shared job-group identifier.
 * - `workerName`: the worker that produced the response.
 * - `status`: completion status string.
 * - `response`: the worker's response payload.
 * - `at`: epoch milliseconds when the response was received.
 */
export class UIJobCompletedData extends BaseModel {
  declare kind: "job_completed";
  declare jobId: string;
  declare workerName: string;
  declare status: string;
  declare response: unknown;
  declare at: number;

  static override readonly fields: FieldSpecs = {
    kind: field(P.literal("job_completed"), () => "job_completed" as const),
    jobId: field(P.str()),
    workerName: field(P.str()),
    status: field(P.str()),
    response: field(P.optional(P.any()), () => null),
    at: field(P.int(), () => 0),
  };

  constructor(options: UIJobCompletedDataOptions) {
    super(options);
  }
}

export interface UIJobGroupCompletedDataOptions {
  kind?: "group_completed";
  jobId: string;
  at?: number;
}

/**
 * `data` for a `ui-job-group` envelope with kind `group_completed`.
 *
 * - `kind`: always `"group_completed"`.
 * - `jobId`: the shared job-group identifier.
 * - `at`: epoch milliseconds when the group completed.
 */
export class UIJobGroupCompletedData extends BaseModel {
  declare kind: "group_completed";
  declare jobId: string;
  declare at: number;

  static override readonly fields: FieldSpecs = {
    kind: field(P.literal("group_completed"), () => "group_completed" as const),
    jobId: field(P.str()),
    at: field(P.int(), () => 0),
  };

  constructor(options: UIJobGroupCompletedDataOptions) {
    super(options);
  }
}

/**
 * Discriminated union over the four job-group lifecycle data shapes, keyed
 * by the `kind` field.
 */
export type UIJobGroupData =
  | UIJobGroupStartedData
  | UIJobUpdateData
  | UIJobCompletedData
  | UIJobGroupCompletedData;

const uiJobGroupDataParser: Parser<UIJobGroupData> = P.union<UIJobGroupData>(
  P.model(() => UIJobGroupStartedData),
  P.model(() => UIJobUpdateData),
  P.model(() => UIJobCompletedData),
  P.model(() => UIJobGroupCompletedData),
);

// -- UI envelope message classes --

export interface UIEventMessageOptions {
  label?: MessageLiteral;
  type?: "ui-event";
  id: string;
  data: UIEventData | UIEventDataOptions;
}

/** RTVI `ui-event` message (client -> server). */
export class UIEventMessage extends BaseModel {
  declare label: MessageLiteral;
  declare type: "ui-event";
  declare id: string;
  declare data: UIEventData;

  static override readonly fields: FieldSpecs = {
    label: LABEL_FIELD,
    type: typeField("ui-event"),
    id: field(P.str()),
    data: field(P.model(() => UIEventData)),
  };

  constructor(options: UIEventMessageOptions) {
    super(options);
  }
}

export interface UICommandMessageOptions {
  label?: MessageLiteral;
  type?: "ui-command";
  data: UICommandData | UICommandDataOptions;
}

/** RTVI `ui-command` message (server -> client). */
export class UICommandMessage extends BaseModel {
  declare label: MessageLiteral;
  declare type: "ui-command";
  declare data: UICommandData;

  static override readonly fields: FieldSpecs = {
    label: LABEL_FIELD,
    type: typeField("ui-command"),
    data: field(P.model(() => UICommandData)),
  };

  constructor(options: UICommandMessageOptions) {
    super(options);
  }
}

export interface UISnapshotMessageOptions {
  label?: MessageLiteral;
  type?: "ui-snapshot";
  id: string;
  data: UISnapshotData | UISnapshotDataOptions;
}

/** RTVI `ui-snapshot` message (client -> server). */
export class UISnapshotMessage extends BaseModel {
  declare label: MessageLiteral;
  declare type: "ui-snapshot";
  declare id: string;
  declare data: UISnapshotData;

  static override readonly fields: FieldSpecs = {
    label: LABEL_FIELD,
    type: typeField("ui-snapshot"),
    id: field(P.str()),
    data: field(P.model(() => UISnapshotData)),
  };

  constructor(options: UISnapshotMessageOptions) {
    super(options);
  }
}

export interface UICancelJobGroupMessageOptions {
  label?: MessageLiteral;
  type?: "ui-cancel-job-group";
  id: string;
  data: UICancelJobGroupData | UICancelJobGroupDataOptions;
}

/** RTVI `ui-cancel-job-group` message (client -> server). */
export class UICancelJobGroupMessage extends BaseModel {
  declare label: MessageLiteral;
  declare type: "ui-cancel-job-group";
  declare id: string;
  declare data: UICancelJobGroupData;

  static override readonly fields: FieldSpecs = {
    label: LABEL_FIELD,
    type: typeField("ui-cancel-job-group"),
    id: field(P.str()),
    data: field(P.model(() => UICancelJobGroupData)),
  };

  constructor(options: UICancelJobGroupMessageOptions) {
    super(options);
  }
}

export interface UIJobGroupMessageOptions {
  label?: MessageLiteral;
  type?: "ui-job-group";
  data: UIJobGroupData;
}

/**
 * RTVI `ui-job-group` message (server -> client).
 *
 * The `data` field is one of the four job-group lifecycle shapes,
 * discriminated by the `kind` field.
 */
export class UIJobGroupMessage extends BaseModel {
  declare label: MessageLiteral;
  declare type: "ui-job-group";
  declare data: UIJobGroupData;

  static override readonly fields: FieldSpecs = {
    label: LABEL_FIELD,
    type: typeField("ui-job-group"),
    data: field(uiJobGroupDataParser),
  };

  constructor(options: UIJobGroupMessageOptions) {
    super(options);
  }
}

// -- UI command payloads --
//
// These models describe commands that have matching default React handlers
// in `@pipecat-ai/client-react`'s `standardHandlers`. Apps can use them as-is,
// override the client handler to customize rendering, or ignore them entirely
// and define their own command names.
//
// Server-side helpers that send commands accept these models directly.
// `modelDump()` converts them to the plain-object shape that travels over the
// wire.

export interface ToastOptions {
  title: string;
  subtitle?: string | null;
  description?: string | null;
  imageUrl?: string | null;
  durationMs?: number | null;
}

/**
 * A transient notification surface shown on the client.
 *
 * - `title`: required headline.
 * - `subtitle`: optional second line beneath the title.
 * - `description`: optional body text.
 * - `imageUrl`: optional leading image.
 * - `durationMs`: optional dismiss timer. Client default applies when null.
 */
export class Toast extends BaseModel {
  declare title: string;
  declare subtitle: string | null;
  declare description: string | null;
  declare imageUrl: string | null;
  declare durationMs: number | null;

  static override readonly fields: FieldSpecs = {
    title: field(P.str()),
    subtitle: field(P.optional(P.str()), () => null),
    description: field(P.optional(P.str()), () => null),
    imageUrl: field(P.optional(P.str()), () => null),
    durationMs: field(P.optional(P.int()), () => null),
  };

  constructor(options: ToastOptions) {
    super(options);
  }
}

export interface NavigateOptions {
  view: string;
  params?: Record<string, unknown> | null;
}

/**
 * Client-side navigation to a named view.
 *
 * - `view`: app-defined view name (route, screen id, tab key, etc.).
 * - `params`: optional view-specific parameters.
 */
export class Navigate extends BaseModel {
  declare view: string;
  declare params: Record<string, unknown> | null;

  static override readonly fields: FieldSpecs = {
    view: field(P.str()),
    params: field(P.optional(P.dict()), () => null),
  };

  constructor(options: NavigateOptions) {
    super(options);
  }
}

export interface ScrollToOptions {
  ref?: string | null;
  targetId?: string | null;
  behavior?: string | null;
}

/**
 * Scroll a target element into view.
 *
 * The client resolves the target by `ref` first (a snapshot ref like `"e42"`
 * assigned by the a11y walker), then falls back to `targetId`
 * (`document.getElementById`). Supply whichever you have; `ref` is the normal
 * choice when acting on a node from `<ui_state>`.
 *
 * - `ref`: snapshot ref from `<ui_state>`.
 * - `targetId`: element id registered on the client.
 * - `behavior`: optional scroll behavior hint. Typical values: `"smooth"` or
 *   `"instant"`. Clients may ignore.
 */
export class ScrollTo extends BaseModel {
  declare ref: string | null;
  declare targetId: string | null;
  declare behavior: string | null;

  static override readonly fields: FieldSpecs = {
    ref: field(P.optional(P.str()), () => null),
    targetId: field(P.optional(P.str()), () => null),
    behavior: field(P.optional(P.str()), () => null),
  };

  constructor(options: ScrollToOptions = {}) {
    super(options);
  }
}

export interface HighlightOptions {
  ref?: string | null;
  targetId?: string | null;
  durationMs?: number | null;
}

/**
 * Briefly emphasize a target element (flash, glow, pulse).
 *
 * - `ref`: snapshot ref from `<ui_state>`.
 * - `targetId`: element id registered on the client.
 * - `durationMs`: optional highlight duration. Client default applies when
 *   null.
 */
export class Highlight extends BaseModel {
  declare ref: string | null;
  declare targetId: string | null;
  declare durationMs: number | null;

  static override readonly fields: FieldSpecs = {
    ref: field(P.optional(P.str()), () => null),
    targetId: field(P.optional(P.str()), () => null),
    durationMs: field(P.optional(P.int()), () => null),
  };

  constructor(options: HighlightOptions = {}) {
    super(options);
  }
}

export interface FocusOptions {
  ref?: string | null;
  targetId?: string | null;
}

/**
 * Move input focus to a target element.
 *
 * - `ref`: snapshot ref from `<ui_state>`.
 * - `targetId`: element id registered on the client.
 */
export class Focus extends BaseModel {
  declare ref: string | null;
  declare targetId: string | null;

  static override readonly fields: FieldSpecs = {
    ref: field(P.optional(P.str()), () => null),
    targetId: field(P.optional(P.str()), () => null),
  };

  constructor(options: FocusOptions = {}) {
    super(options);
  }
}

export interface ClickOptions {
  ref?: string | null;
  targetId?: string | null;
}

/**
 * Click an element on the client.
 *
 * Closes the form-fill loop for non-text inputs (checkboxes, radios) and
 * exposes the rest of the action vocabulary (submit buttons, links,
 * app-specific clickable nodes). The standard handler silently no-ops on
 * `disabled` targets so the worker can't bypass UI affordances the user is
 * meant to control.
 *
 * For native `<select>`, prefer `SetInputValue` (clicking options doesn't
 * reliably change the selection); for custom comboboxes (ARIA listbox +
 * popup), apps wire their own command matching the library's interaction
 * model.
 *
 * - `ref`: snapshot ref from `<ui_state>`.
 * - `targetId`: element id registered on the client. Used as a fallback when
 *   `ref` is not set or has gone stale.
 */
export class Click extends BaseModel {
  declare ref: string | null;
  declare targetId: string | null;

  static override readonly fields: FieldSpecs = {
    ref: field(P.optional(P.str()), () => null),
    targetId: field(P.optional(P.str()), () => null),
  };

  constructor(options: ClickOptions = {}) {
    super(options);
  }
}

export interface SetInputValueOptions {
  value?: string;
  ref?: string | null;
  targetId?: string | null;
  replace?: boolean;
}

/**
 * Write a value into a text input or textarea on the client.
 *
 * Use this for form-filling: the worker has decided what should go into a
 * field (clarifying answer, tax form entry, etc.) and asks the client to
 * populate it. With `replace: true` (the default), the existing value is
 * overwritten; with `replace: false` the value is appended.
 *
 * The standard handler silently no-ops on `disabled`, `readonly`, and
 * `<input type="hidden">` targets so the worker can't write into fields the
 * user can't.
 *
 * - `value`: the text to write.
 * - `ref`: snapshot ref from `<ui_state>`. Typically the ref of an `<input>`
 *   or `<textarea>`.
 * - `targetId`: element id registered on the client. Used as a fallback when
 *   `ref` is not set or has gone stale.
 * - `replace`: when true (the default), overwrite the current value. When
 *   false, append to it.
 */
export class SetInputValue extends BaseModel {
  declare value: string;
  declare ref: string | null;
  declare targetId: string | null;
  declare replace: boolean;

  static override readonly fields: FieldSpecs = {
    value: field(P.str(), () => ""),
    ref: field(P.optional(P.str()), () => null),
    targetId: field(P.optional(P.str()), () => null),
    replace: field(P.bool(), () => true),
  };

  constructor(options: SetInputValueOptions = {}) {
    super(options);
  }
}

export interface SelectTextOptions {
  ref?: string | null;
  targetId?: string | null;
  startOffset?: number | null;
  endOffset?: number | null;
}

/**
 * Select text on the page so the user can see what the worker means.
 *
 * Mirror of the `selection` field surfaced in the snapshot. Use this to point
 * the user's attention at a specific paragraph or range after the worker has
 * decided what it's referring to.
 *
 * With `startOffset` and `endOffset` omitted, the entire target's text
 * content is selected (`Range.selectNodeContents` for document elements;
 * `el.select()` for `<input>` / `<textarea>`).
 *
 * - `ref`: snapshot ref from `<ui_state>`. Typically the ref of a paragraph
 *   or input element.
 * - `targetId`: element id registered on the client. Used as a fallback when
 *   `ref` is not set or has gone stale.
 * - `startOffset`: character offset within the target's text where the
 *   selection should start. For `<input>` and `<textarea>` this is the value
 *   offset; for document elements it is computed against the concatenation of
 *   descendant text nodes in document order.
 * - `endOffset`: end character offset, exclusive. Same coordinate system as
 *   `startOffset`.
 */
export class SelectText extends BaseModel {
  declare ref: string | null;
  declare targetId: string | null;
  declare startOffset: number | null;
  declare endOffset: number | null;

  static override readonly fields: FieldSpecs = {
    ref: field(P.optional(P.str()), () => null),
    targetId: field(P.optional(P.str()), () => null),
    startOffset: field(P.optional(P.int()), () => null),
    endOffset: field(P.optional(P.int()), () => null),
  };

  constructor(options: SelectTextOptions = {}) {
    super(options);
  }
}
