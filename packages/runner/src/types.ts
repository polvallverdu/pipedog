// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/runner/types.py

/**
 * Runner session argument types for the development runner.
 *
 * PARTIAL PORT: only the telephony call data types (`CallData`,
 * `TelnyxCallData`, `ExotelCallData`) are ported, for
 * `parseTelephonyWebsocket` in `./utils.ts`. The runner argument classes
 * (`RunnerArguments`, `DailyRunnerArguments`, `WebSocketRunnerArguments`, ...)
 * and the Daily dial-in models belong to the development runner, which is not
 * ported yet.
 */

/** A JSON object, as Python's `dict`. */
export type JsonDict = Record<string, unknown>;

function isRecord(value: unknown): value is JsonDict {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Raised by `modelValidate` for input pydantic would reject (`pydantic.ValidationError`). */
export class CallDataValidationError extends TypeError {
  override name = "ValidationError";
}

/** A field of a `CallData` model: its property, its wire key, and its validator. */
interface FieldSpec {
  /** The camelCase property on the class. */
  prop: string;
  /** The field name upstream (snake_case). */
  name: string;
  /** The wire (alias) key, when it differs from `name`. */
  alias?: string;
  /** `str | None`, `dict`, or `str | dict | None`. */
  kind: "str" | "dict" | "str_or_dict";
}

function validateField(field: FieldSpec, value: unknown, model: string): unknown {
  const ok =
    field.kind === "str"
      ? value === null || typeof value === "string"
      : field.kind === "dict"
        ? isRecord(value)
        : value === null || typeof value === "string" || isRecord(value);
  if (!ok) {
    const expected =
      field.kind === "str"
        ? "a valid string"
        : field.kind === "dict"
          ? "a valid dictionary"
          : "a valid string or dictionary";
    throw new CallDataValidationError(
      `1 validation error for ${model}\n${field.alias ?? field.name}\n  Input should be ${expected}`,
    );
  }
  return value;
}

export interface CallDataOptions {
  /** Provider media-stream identifier. */
  streamId?: string | null;
  /**
   * Provider call identifier, normalized across providers (Twilio `callSid`,
   * Plivo `callId`, Exotel `call_sid`, Telnyx `call_control_id`).
   */
  callId?: string | null;
  /** Caller's number. Wire key `from`. */
  fromNumber?: string | null;
  /** Dialed number. Wire key `to`. */
  toNumber?: string | null;
  /** Custom parameters sent by the provider (e.g. Twilio TwiML stream parameters). */
  body?: JsonDict;
  /** Provider-specific keys not modeled as fields (pydantic's `extra="allow"`). */
  extra?: JsonDict;
}

/**
 * Parsed telephony handshake data from the provider's first WebSocket messages.
 *
 * Populated by `parseTelephonyWebsocket` (in `@pipedog/runner/utils`). Gives
 * typed attribute access (`callData.toNumber`, `callData.callId`) while staying
 * dict-compatible with the provider's wire keys (`callData.getItem("call_id")`,
 * `callData.get("body", {})`, `callData.has("from")`), as upstream's
 * `call_data["call_id"]`, `.get()` and `in`.
 *
 * Fields are populated per provider; absent ones stay `null`. Provider-specific
 * keys not modeled here remain accessible through the dict-style methods
 * (pydantic's `extra="allow"`).
 *
 * This base holds the fields common to all providers. Provider-specific fields
 * live on subclasses (`TelnyxCallData`, `ExotelCallData`), which
 * `parseTelephonyWebsocket` constructs per provider.
 */
export class CallData {
  /** The model's fields, in upstream's order (base fields first). */
  protected static fields: readonly FieldSpec[] = [
    { prop: "streamId", name: "stream_id", kind: "str" },
    { prop: "callId", name: "call_id", kind: "str" },
    { prop: "fromNumber", name: "from_number", alias: "from", kind: "str" },
    { prop: "toNumber", name: "to_number", alias: "to", kind: "str" },
    { prop: "body", name: "body", kind: "dict" },
  ];

  /** Provider media-stream identifier. */
  streamId: string | null;
  /** Provider call identifier, normalized across providers. */
  callId: string | null;
  /** Caller's number. Wire key `from`. */
  fromNumber: string | null;
  /** Dialed number. Wire key `to`. */
  toNumber: string | null;
  /** Custom parameters sent by the provider (e.g. Twilio TwiML stream parameters). */
  body: JsonDict;
  /** Keys the provider sent that are not modeled as fields. */
  protected _extra: JsonDict;

  constructor(options: CallDataOptions = {}) {
    this.streamId = options.streamId ?? null;
    this.callId = options.callId ?? null;
    this.fromNumber = options.fromNumber ?? null;
    this.toNumber = options.toNumber ?? null;
    this.body = options.body ?? {};
    this._extra = { ...(options.extra ?? {}) };
  }

  /**
   * Build a model from a provider dict (pydantic's `model_validate`). Wire keys
   * (`"from"`, `"to"`) and field names (`"from_number"`) are both accepted
   * (`populate_by_name=True`); unknown keys are kept as extras.
   *
   * @throws CallDataValidationError If a field has the wrong type.
   */
  static modelValidate<T extends CallData>(this: new () => T, data: JsonDict): T {
    const cls = this as unknown as typeof CallData;
    if (!isRecord(data)) {
      throw new CallDataValidationError(
        `1 validation error for ${cls.name}\n  Input should be a valid dictionary`,
      );
    }
    const model = new this();
    const consumed = new Set<string>();
    for (const field of cls.fields) {
      for (const key of field.alias ? [field.alias, field.name] : [field.name]) {
        if (key in data) {
          consumed.add(key);
          (model as unknown as JsonDict)[field.prop] = validateField(field, data[key], cls.name);
          break;
        }
      }
    }
    for (const [key, value] of Object.entries(data)) {
      if (!consumed.has(key) && !cls.fields.some((f) => f.name === key || f.alias === key)) {
        model._extra[key] = value;
      }
    }
    return model;
  }

  /** The original provider dict shape: wire (alias) keys, including extras. */
  protected _wireDict(): JsonDict {
    const cls = this.constructor as typeof CallData;
    const out: JsonDict = {};
    for (const field of cls.fields) {
      out[field.alias ?? field.name] = (this as unknown as JsonDict)[field.prop];
    }
    return Object.assign(out, this._extra);
  }

  /**
   * Dict-style access with the wire keys, e.g. `callData.getItem("call_id")`
   * (upstream's `call_data["call_id"]`). Unset fields are `null`.
   *
   * @throws Error (upstream's `KeyError`) for a key that is neither a field nor an extra.
   */
  getItem(key: string): unknown {
    const wire = this._wireDict();
    if (!(key in wire)) throw new Error(`KeyError: '${key}'`);
    return wire[key];
  }

  /** `"call_id" in call_data`: true only when the provider set the value. */
  has(key: string): boolean {
    const wire = this._wireDict();
    return key in wire && wire[key] !== null && wire[key] !== undefined;
  }

  /** Dict-style `.get`, returning `defaultValue` when the key is missing or unset. */
  get(key: string, defaultValue: unknown = null): unknown {
    const wire = this._wireDict();
    const value = key in wire ? wire[key] : defaultValue;
    return value === null || value === undefined ? defaultValue : value;
  }

  /** The provider dict (`model_dump(by_alias=True)`). */
  toJSON(): JsonDict {
    return this._wireDict();
  }
}

export interface TelnyxCallDataOptions extends CallDataOptions {
  /** Telnyx outbound media encoding. */
  outboundEncoding?: string | null;
}

/** Telnyx-specific parsed telephony handshake data. */
export class TelnyxCallData extends CallData {
  protected static override fields: readonly FieldSpec[] = [
    ...CallData.fields,
    { prop: "outboundEncoding", name: "outbound_encoding", kind: "str" },
  ];

  /** Telnyx outbound media encoding. */
  outboundEncoding: string | null;

  constructor(options: TelnyxCallDataOptions = {}) {
    super(options);
    this.outboundEncoding = options.outboundEncoding ?? null;
  }
}

export interface ExotelCallDataOptions extends CallDataOptions {
  /** Exotel account sid. */
  accountSid?: string | null;
  /** Exotel custom parameters. */
  customParameters?: string | JsonDict | null;
}

/** Exotel-specific parsed telephony handshake data. */
export class ExotelCallData extends CallData {
  protected static override fields: readonly FieldSpec[] = [
    ...CallData.fields,
    { prop: "accountSid", name: "account_sid", kind: "str" },
    { prop: "customParameters", name: "custom_parameters", kind: "str_or_dict" },
  ];

  /** Exotel account sid. */
  accountSid: string | null;
  /** Exotel custom parameters. */
  customParameters: string | JsonDict | null;

  constructor(options: ExotelCallDataOptions = {}) {
    super(options);
    this.accountSid = options.accountSid ?? null;
    this.customParameters = options.customParameters ?? null;
  }
}
