// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/runner/types.py

/**
 * Runner session argument types for the development runner.
 *
 * These types are used by the development runner to pass transport-specific
 * information to bot functions.
 *
 * The deprecated `EvalRunnerArguments` is not ported. The Daily, LiveKit,
 * Vonage and MOQ argument classes are kept for API parity; their transports
 * are not ported, so `createTransport` rejects them.
 */

import type { Event as AsyncioEvent } from "@pipedog/asyncio";
import type { FileStorage } from "@pipedog/core/utils/file_storage";
import { logger } from "@pipedog/core/utils/logger";
import type { SmallWebRTCConnection } from "@pipedog/transport-smallwebrtc/connection";
import type { FastAPIWebSocket } from "@pipedog/transport-websocket/fastapi";

import type { TelephonyHandshake, TelephonyWebsocket } from "./utils.ts";

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

// ---------------------------------------------------------------------------
// Dial-in models and runner arguments.
// ---------------------------------------------------------------------------

/** A JSON value from a request body. */
type WireDict = Record<string, unknown>;

export interface DialinSettingsOptions {
  /** Unique identifier for the call (UUID representing sessionId in SIP Network). */
  callId: string;
  /** Daily domain for the call (UUID representing Daily Domain on SIP Network). */
  callDomain: string;
  /** The dialed phone number. */
  To?: string | null;
  /** The caller's phone number. */
  From?: string | null;
  /** SIP headers from the call. */
  sipHeaders?: Record<string, string> | null;
}

/**
 * Dial-in settings from the Daily webhook.
 *
 * This model matches the structure sent by Pipecat Cloud and Daily.co webhooks
 * for incoming PSTN/SIP calls. `fromDict()` / `toDict()` use the wire keys
 * (`call_id`, `call_domain`, `To`, `From`, `sip_headers`).
 */
export class DialinSettings {
  callId: string;
  callDomain: string;
  To: string | null;
  From: string | null;
  sipHeaders: Record<string, string> | null;

  constructor(options: DialinSettingsOptions) {
    this.callId = options.callId;
    this.callDomain = options.callDomain;
    this.To = options.To ?? null;
    this.From = options.From ?? null;
    this.sipHeaders = options.sipHeaders ?? null;
  }

  /** Build from the wire dict. */
  static fromDict(data: WireDict): DialinSettings {
    return new DialinSettings({
      callId: data.call_id as string,
      callDomain: data.call_domain as string,
      To: (data.To as string | null | undefined) ?? null,
      From: (data.From as string | null | undefined) ?? null,
      sipHeaders: (data.sip_headers as Record<string, string> | null | undefined) ?? null,
    });
  }

  /** The wire dict (`model_dump()`). */
  toDict(): WireDict {
    return {
      call_id: this.callId,
      call_domain: this.callDomain,
      To: this.To,
      From: this.From,
      sip_headers: this.sipHeaders,
    };
  }
}

export interface DailyDialinRequestOptions {
  /** Dial-in configuration including call_id, call_domain, To, From. */
  dialinSettings: DialinSettings;
  /** Daily API key for pinlessCallUpdate (required for dial-in). */
  dailyApiKey: string;
  /** Daily API URL (staging or production). */
  dailyApiUrl: string;
}

/**
 * Request data for Daily PSTN dial-in requests.
 *
 * This is the structure passed in `runnerArgs.body` for dial-in calls. It
 * matches the payload structure from Pipecat Cloud's dial-in webhook handler.
 */
export class DailyDialinRequest {
  dialinSettings: DialinSettings;
  dailyApiKey: string;
  dailyApiUrl: string;

  constructor(options: DailyDialinRequestOptions) {
    this.dialinSettings = options.dialinSettings;
    this.dailyApiKey = options.dailyApiKey;
    this.dailyApiUrl = options.dailyApiUrl;
  }

  /** Build from the wire dict. */
  static fromDict(data: WireDict): DailyDialinRequest {
    return new DailyDialinRequest({
      dialinSettings: DialinSettings.fromDict(data.dialin_settings as WireDict),
      dailyApiKey: data.daily_api_key as string,
      dailyApiUrl: data.daily_api_url as string,
    });
  }

  /** The wire dict (`model_dump()`). */
  toDict(): WireDict {
    return {
      dialin_settings: this.dialinSettings.toDict(),
      daily_api_key: this.dailyApiKey,
      daily_api_url: this.dailyApiUrl,
    };
  }
}

/** The parsed command line the development runner was started with (argparse's `Namespace`). */
export type RunnerCliArgs = Record<string, any>;

export interface RunnerArgumentsOptions {
  /** Request body data passed from the runner entry point. Defaults to `{}`. */
  body?: unknown;
  /** Parsed telephony handshake (see `RunnerArguments.callData`). */
  callData?: CallData | null;
  /** Identifier for this bot session. */
  sessionId?: string | null;
  /** The storage backend serving the host's upload endpoints. */
  fileStorage?: FileStorage | null;
}

/**
 * Base class for runner session arguments.
 *
 * - `handleSigint` / `handleSigterm`: whether the bot should install signal
 *   handlers (`new WorkerRunner({ handleSigint: runnerArgs.handleSigint })`).
 * - `pipelineIdleTimeoutSecs`: seconds the pipeline may stay idle before
 *   shutting down; `null` disables the idle timeout.
 * - `body`: request body data passed from the runner entry point.
 * - `callData`: the parsed telephony handshake as a `CallData` model, typed
 *   (`callData.toNumber`) and dict-compatible (`callData.getItem("call_id")`).
 *   Populated by `createTransport` (or a direct `parseTelephonyWebsocket` call)
 *   for telephony connections; `null` otherwise. Lives on the base so any bot
 *   can read `runnerArgs.callData` uniformly, mirroring `body`.
 * - `sessionId`: identifier for this bot session.
 * - `cliArgs`: parsed CLI arguments, when launched via the development runner.
 * - `fileStorage`: the storage backend serving the host's upload endpoints,
 *   injected by whichever host runs the bot: the one returned by the bot
 *   module's `createFileStorage()` if it exports one, otherwise the host's
 *   default (the development runner's `-u/--uploads-folder` local storage).
 *   Hand it to the LLM service's `FileResolver`. `null` when uploads are
 *   disabled.
 */
export class RunnerArguments {
  handleSigint = false;
  handleSigterm = false;
  pipelineIdleTimeoutSecs: number | null = 300;
  body: unknown;
  callData: CallData | null;
  sessionId: string | null;
  cliArgs: RunnerCliArgs | null = null;
  fileStorage: FileStorage | null;

  constructor(options: RunnerArgumentsOptions = {}) {
    // `field(default_factory=dict)`: an explicit `null` stays `null`.
    this.body = options.body === undefined ? {} : options.body;
    this.callData = options.callData ?? null;
    this.sessionId = options.sessionId ?? null;
    this.fileStorage = options.fileStorage ?? null;
  }
}

export interface DailyRunnerArgumentsOptions extends RunnerArgumentsOptions {
  /** Daily room URL to join. */
  roomUrl: string;
  /** Authentication token for the room. */
  token?: string | null;
}

/**
 * Daily transport session arguments for the runner.
 *
 * Kept for API parity: the Daily transport is not ported to pipedog yet, so
 * `createTransport` and the development runner reject these arguments.
 */
export class DailyRunnerArguments extends RunnerArguments {
  roomUrl: string;
  token: string | null;

  constructor(options: DailyRunnerArgumentsOptions) {
    super(options);
    this.roomUrl = options.roomUrl;
    this.token = options.token ?? null;
  }
}

export interface VonageRunnerArgumentsOptions extends RunnerArgumentsOptions {
  /** Vonage application ID. */
  applicationId: string;
  /** Vonage session ID. */
  vonageSessionId: string;
  /** Vonage session token. */
  token: string;
}

/**
 * Vonage (Video Connector) transport session arguments for the runner.
 *
 * Kept for API parity: the Vonage Video Connector transport is not ported to
 * pipedog yet.
 */
export class VonageRunnerArguments extends RunnerArguments {
  applicationId: string;
  vonageSessionId: string;
  token: string;

  constructor(options: VonageRunnerArgumentsOptions) {
    super(options);
    this.applicationId = options.applicationId;
    this.vonageSessionId = options.vonageSessionId;
    this.token = options.token;
  }
}

/**
 * The socket a WebSocket session runs on: what `FastAPIWebsocketTransport`
 * needs plus Starlette's `receive()` for the telephony handshake. A
 * `WebsocketConnection` from `@pipedog/transport-websocket` is one.
 */
export type RunnerWebSocket = FastAPIWebSocket & TelephonyWebsocket;

export interface WebSocketRunnerArgumentsOptions extends RunnerArgumentsOptions {
  /** WebSocket connection for audio streaming. */
  websocket: RunnerWebSocket;
  /**
   * `"websocket"` for plain WebSocket connections; `null` (the default)
   * detects the telephony provider from its first messages.
   */
  transportType?: string | null;
}

/**
 * WebSocket transport session arguments for the runner.
 *
 * The parsed telephony handshake is available on the inherited `callData`
 * field, populated by `createTransport`. After auto-detection,
 * `createTransport` overwrites `transportType` with the detected provider
 * (e.g. `"telnyx"`).
 *
 * pipedog: `handshake` holds the handshake's typed outcome once
 * `createTransport` has read it, including a caller who hung up before the
 * provider's `start` message (`{ status: "closed", messagesReceived }`).
 */
export class WebSocketRunnerArguments extends RunnerArguments {
  websocket: RunnerWebSocket;
  transportType: string | null;
  /** pipedog: the telephony handshake's outcome, set by `createTransport`. */
  handshake: TelephonyHandshake | null = null;

  constructor(options: WebSocketRunnerArgumentsOptions) {
    super(options);
    this.websocket = options.websocket;
    this.transportType = options.transportType ?? null;
  }
}

export interface SmallWebRTCRunnerArgumentsOptions extends RunnerArgumentsOptions {
  /** Pre-configured WebRTC peer connection. */
  webrtcConnection: SmallWebRTCConnection;
}

/** Small WebRTC transport session arguments for the runner. */
export class SmallWebRTCRunnerArguments extends RunnerArguments {
  webrtcConnection: SmallWebRTCConnection;

  constructor(options: SmallWebRTCRunnerArgumentsOptions) {
    super(options);
    this.webrtcConnection = options.webrtcConnection;
  }
}

export interface LiveKitRunnerArgumentsOptions extends RunnerArgumentsOptions {
  /** LiveKit room name to join. */
  roomName: string;
  /** LiveKit server URL to connect to. */
  url: string;
  /** Authentication token for the room. */
  token: string;
}

/**
 * LiveKit transport session arguments for the runner.
 *
 * Kept for API parity: the LiveKit transport is not ported to pipedog yet.
 */
export class LiveKitRunnerArguments extends RunnerArguments {
  roomName: string;
  url: string;
  token: string;

  constructor(options: LiveKitRunnerArgumentsOptions) {
    super(options);
    this.roomName = options.roomName;
    this.url = options.url;
    this.token = options.token;
  }
}

export interface MOQRunnerArgumentsOptions extends RunnerArgumentsOptions {
  /** MOQ relay/server hostname. */
  host?: string | null;
  /** MOQ relay/server port. */
  port?: number | null;
  /** MOQ endpoint path on the relay when the URL is composed from host and port. */
  path?: string;
  /** Full relay URL to dial in client mode; takes precedence over host/port/path. */
  relayUrl?: string | null;
  /** MOQ namespace (like a room identifier). */
  namespace?: string;
  /** This bot's participant id. */
  participantId?: string;
  /** The peer's participant id. */
  peerId?: string;
  /** Whether to verify SSL certificates (client mode). */
  verifySsl?: boolean;
  /** When true, the bot binds its own MOQ server instead of dialing a relay. */
  serve?: boolean;
  /** Local UDP bind address. */
  bind?: string | null;
  /** Hostname used for the generated self-signed cert. */
  serveTlsHost?: string;
  /** Path to a PEM-encoded TLS cert chain. */
  serveTlsCert?: string | null;
  /** Path to the matching PEM-encoded private key. */
  serveTlsKey?: string | null;
  /** Event the bot fires once it has finished MOQ bring-up. */
  readyEvent?: AsyncioEvent | null;
  /** SHA-256 fingerprints (hex) of the bot's TLS cert chain. */
  certFingerprints?: string[];
}

/**
 * MOQ (Media over QUIC) transport session arguments for the runner.
 *
 * Kept for API parity: the MOQ transport is not ported to pipedog yet. The
 * deprecated `serve_bind` field is not ported.
 *
 * @throws Error (upstream's `ValueError`) in client mode without `relayUrl`,
 *   or `host` and `port`.
 */
export class MOQRunnerArguments extends RunnerArguments {
  host: string | null;
  port: number | null;
  path: string;
  relayUrl: string | null;
  namespace: string;
  participantId: string;
  peerId: string;
  verifySsl: boolean;
  serve: boolean;
  bind: string | null;
  serveTlsHost: string;
  serveTlsCert: string | null;
  serveTlsKey: string | null;
  readyEvent: AsyncioEvent | null;
  certFingerprints: string[];

  constructor(options: MOQRunnerArgumentsOptions = {}) {
    super(options);
    this.host = options.host ?? null;
    this.port = options.port ?? null;
    this.path = options.path ?? "/moq";
    this.relayUrl = options.relayUrl ?? null;
    this.namespace = options.namespace ?? "pipecat";
    this.participantId = options.participantId ?? "response";
    this.peerId = options.peerId ?? "request";
    this.verifySsl = options.verifySsl ?? true;
    this.serve = options.serve ?? false;
    this.bind = options.bind ?? null;
    this.serveTlsHost = options.serveTlsHost ?? "localhost";
    this.serveTlsCert = options.serveTlsCert ?? null;
    this.serveTlsKey = options.serveTlsKey ?? null;
    this.readyEvent = options.readyEvent ?? null;
    this.certFingerprints = options.certFingerprints ?? [];

    if (!this.serve && this.relayUrl === null && (this.host === null || this.port === null)) {
      throw new Error(
        "MOQRunnerArguments needs `relay_url`, or `host` and `port`, to dial a relay",
      );
    }
    if (!this.serve && this.relayUrl !== null) {
      if (this.host !== null || this.port !== null) {
        logger.warning(
          "MOQRunnerArguments: `relay_url` is set, so `host`, `port` and `path` are ignored",
        );
      }
    }
  }
}
