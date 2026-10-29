// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/serializers/twilio.py

/** Twilio Media Streams WebSocket protocol serializer for Pipecat. */

import { abortable, currentSignal, rethrowIfCancelled } from "@pipedog/asyncio";
import { KeypadEntry } from "@pipedog/core/audio/dtmf/types";
import type { BaseAudioResampler } from "@pipedog/core/audio/resamplers/base_audio_resampler";
import { createStreamResampler, pcmToUlaw, ulawToPcm } from "@pipedog/core/audio/utils";
import {
  AudioRawFrame,
  CancelFrame,
  EndFrame,
  type Frame,
  InputAudioRawFrame,
  InputDTMFFrame,
  InterruptionFrame,
  OutputTransportMessageFrame,
  OutputTransportMessageUrgentFrame,
} from "@pipedog/core/frames/frames";
import type { FrameProcessorSetup } from "@pipedog/core/processors/frame_processor";
import {
  FrameSerializer,
  FrameSerializerInputParams,
  type FrameSerializerInputParamsOptions,
  type FrameSerializerOptions,
  type SerializedData,
} from "@pipedog/core/serializers/base_serializer";
import { base64ToBytes, bytesToBase64 } from "@pipedog/core/utils/base64";
import { logger } from "@pipedog/core/utils/logger";
import { pyJsonDumps as jsonDumps, pyJsonLoads } from "@pipedog/core/utils/py_json";

/** Options for `_buildCallResourceUrl`. */
export interface BuildCallResourceUrlOptions {
  /** API root (scheme + host), used verbatim when set. */
  baseUrl?: string | null;
  /** Twilio region (e.g. "au1"). */
  region?: string | null;
  /** Twilio edge location (e.g. "sydney"). */
  edge?: string | null;
}

/**
 * Build the REST URL for a Call resource (used by auto hang-up).
 *
 * When `baseUrl` is provided it is used verbatim as the API root (scheme +
 * host, e.g. `https://api.twilio.com`), which lets the serializer target a
 * Twilio-API-compatible backend or a self-hosted server. Otherwise the host is
 * derived from Twilio's `region`/`edge` FQDN format, preserving the prior
 * default behavior.
 */
export function _buildCallResourceUrl(
  accountSid: string,
  callSid: string,
  options: BuildCallResourceUrlOptions = {},
): string {
  const { baseUrl, region, edge } = options;
  let root: string;
  if (baseUrl) {
    root = baseUrl.replace(/\/+$/, "");
  } else {
    const regionPrefix = region ? `${region}.` : "";
    const edgePrefix = edge ? `${edge}.` : "";
    root = `https://api.${edgePrefix}${regionPrefix}twilio.com`;
  }
  return `${root}/2010-04-01/Accounts/${accountSid}/Calls/${callSid}.json`;
}

export interface TwilioFrameSerializerInputParamsOptions extends FrameSerializerInputParamsOptions {
  /** Sample rate used by Twilio, defaults to 8000 Hz. */
  twilioSampleRate?: number;
  /** Optional override for pipeline input sample rate. */
  sampleRate?: number | null;
  /** Whether to automatically terminate call on EndFrame. */
  autoHangUp?: boolean;
}

/**
 * Configuration parameters for TwilioFrameSerializer.
 *
 * - `twilioSampleRate`: Sample rate used by Twilio, defaults to 8000 Hz.
 * - `sampleRate`: Optional override for pipeline input sample rate.
 * - `autoHangUp`: Whether to automatically terminate call on EndFrame.
 * - `ignoreRtviMessages`: Inherited from base FrameSerializer, defaults to true.
 */
export class TwilioFrameSerializerInputParams extends FrameSerializerInputParams {
  twilioSampleRate: number;
  sampleRate: number | null;
  autoHangUp: boolean;

  constructor(options: TwilioFrameSerializerInputParamsOptions = {}) {
    super(options);
    this.twilioSampleRate = options.twilioSampleRate ?? 8000;
    this.sampleRate = options.sampleRate ?? null;
    this.autoHangUp = options.autoHangUp ?? true;
  }
}

export interface TwilioFrameSerializerOptions extends FrameSerializerOptions {
  /** The Twilio Media Stream SID. */
  streamSid: string;
  /** The associated Twilio Call SID (optional, but required for auto hang-up). */
  callSid?: string | null;
  /** Twilio account SID (required for auto hang-up). */
  accountSid?: string | null;
  /**
   * Twilio Auth Token for auto hang-up. Mutually exclusive with
   * apiKeySid/apiKeySecret.
   */
  authToken?: string | null;
  /**
   * Twilio API key SID (starts with "SK"). Alternative to authToken for auto
   * hang-up. Must be provided with apiKeySecret.
   */
  apiKeySid?: string | null;
  /** Twilio API key secret. Must be provided with apiKeySid. */
  apiKeySecret?: string | null;
  /** Twilio region (e.g., "au1", "ie1"). Must be specified with edge. */
  region?: string | null;
  /** Twilio edge location (e.g., "sydney", "dublin"). Must be specified with region. */
  edge?: string | null;
  /**
   * Optional REST API base URL (scheme + host, e.g. `https://api.twilio.com`)
   * used for auto hang-up. Defaults to the host derived from region/edge. Set
   * this to target a Twilio-API-compatible backend or a self-hosted server.
   */
  baseUrl?: string | null;
  /** Configuration parameters. */
  params?: TwilioFrameSerializerInputParams | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pyTypeName(value: unknown): string {
  if (value === null || value === undefined) return "NoneType";
  if (Array.isArray(value)) return "list";
  if (typeof value === "string") return "str";
  if (typeof value === "number") return Number.isInteger(value) ? "int" : "float";
  if (typeof value === "boolean") return "bool";
  return typeof value;
}

/** Python `obj.get(key, default)`: raises when `obj` is not a dict. */
function dictGet(obj: unknown, key: string, defaultValue: unknown = null): unknown {
  if (!isRecord(obj)) {
    throw new TypeError(`'${pyTypeName(obj)}' object has no attribute 'get'`);
  }
  return key in obj ? obj[key] : defaultValue;
}

/**
 * aiohttp's `response.json()` raises unless the response's content type is
 * JSON (`application/json` or `application/*+json`).
 */
function isJsonContentType(response: Response): boolean {
  const mimetype = (response.headers.get("content-type") ?? "").split(";")[0]?.trim() ?? "";
  return /^application\/(?:[\w.+-]+?\+)?json$/i.test(mimetype);
}

/** `aiohttp.BasicAuth(login, password).encode()`. */
function basicAuth(login: string, password: string): string {
  return `Basic ${bytesToBase64(new TextEncoder().encode(`${login}:${password}`))}`;
}

const KEYPAD_VALUES: readonly string[] = Object.values(KeypadEntry);

/**
 * Serializer for Twilio Media Streams WebSocket protocol.
 *
 * This serializer handles converting between Pipecat frames and Twilio's
 * WebSocket media streams protocol. It supports audio conversion, DTMF events,
 * and automatic call termination.
 *
 * When `autoHangUp` is enabled (default), the serializer will automatically
 * terminate the Twilio call when an EndFrame or CancelFrame is processed, but
 * requires Twilio credentials: either `authToken` or an API key (`apiKeySid` +
 * `apiKeySecret`). Credentials must belong to the configured region: each
 * Twilio region has its own Auth Token and API keys.
 */
export class TwilioFrameSerializer extends FrameSerializer {
  /** Upstream's nested `TwilioFrameSerializer.InputParams`. */
  static override InputParams = TwilioFrameSerializerInputParams;

  declare protected _params: TwilioFrameSerializerInputParams;

  protected _streamSid: string;
  protected _callSid: string | null;
  protected _accountSid: string | null;
  protected _authToken: string | null;
  protected _apiKeySid: string | null;
  protected _apiKeySecret: string | null;
  protected _region: string | null;
  protected _edge: string | null;
  protected _baseUrl: string | null;
  protected _twilioSampleRate: number;
  protected _sampleRate: number;
  protected _inputResampler: BaseAudioResampler;
  protected _outputResampler: BaseAudioResampler;
  protected _hangupAttempted: boolean;

  /**
   * Initialize the TwilioFrameSerializer.
   *
   * @param options.streamSid The Twilio Media Stream SID.
   * @param options.callSid The associated Twilio Call SID (optional, but required for auto hang-up).
   * @param options.accountSid Twilio account SID (required for auto hang-up).
   * @param options.authToken Twilio Auth Token for auto hang-up. Mutually
   *   exclusive with apiKeySid/apiKeySecret.
   * @param options.apiKeySid Twilio API key SID (starts with "SK"). Alternative
   *   to authToken for auto hang-up. Must be provided with apiKeySecret.
   * @param options.apiKeySecret Twilio API key secret. Must be provided with apiKeySid.
   * @param options.region Twilio region (e.g., "au1", "ie1"). Must be specified with edge.
   * @param options.edge Twilio edge location (e.g., "sydney", "dublin"). Must be specified with region.
   * @param options.baseUrl Optional REST API base URL used for auto hang-up.
   * @param options.params Configuration parameters.
   * @throws Error If auto hang-up is on and credentials are missing, both an
   *   auth token and an API key are given, the API key pair is incomplete, or
   *   only one of region and edge is set without `baseUrl`.
   */
  constructor(options: TwilioFrameSerializerOptions) {
    const params = options.params || new TwilioFrameSerializerInputParams();
    super({ ...options, params });
    this._params = params;

    // Validate hangup-related parameters if auto_hang_up is enabled
    if (this._params.autoHangUp) {
      // Validate required credentials
      const missingCredentials: string[] = [];
      if (!options.callSid) {
        missingCredentials.push("call_sid");
      }
      if (!options.accountSid) {
        missingCredentials.push("account_sid");
      }
      if (!options.authToken && !options.apiKeySid && !options.apiKeySecret) {
        missingCredentials.push("auth_token or api_key_sid + api_key_secret");
      }

      if (missingCredentials.length > 0) {
        throw new Error(
          `auto_hang_up is enabled but missing required parameters: ${missingCredentials.join(", ")}`,
        );
      }

      // Reject an auth_token alongside any part of an API key. Accepting both
      // would let a leftover auth_token stay deployed without anyone noticing.
      if (options.authToken && (options.apiKeySid || options.apiKeySecret)) {
        throw new Error("Provide either auth_token or api_key_sid + api_key_secret, not both.");
      }

      // Validate the API key pair is complete. auth_token is ruled out above,
      // so this only sees a lone api_key_sid or api_key_secret.
      if (
        (options.apiKeySid && !options.apiKeySecret) ||
        (options.apiKeySecret && !options.apiKeySid)
      ) {
        const missing = options.apiKeySid ? "api_key_secret" : "api_key_sid";
        throw new Error(
          "Both api_key_sid and api_key_secret parameters are required if one is set. " +
            `Missing: ${missing}`,
        );
      }

      // Validate region and edge are both provided if either is specified.
      // Only applies when deriving Twilio's FQDN host; base_url is used
      // verbatim and ignores region/edge, so the pairing requirement is moot.
      const { region, edge } = options;
      if (!options.baseUrl && ((region && !edge) || (edge && !region))) {
        throw new Error(
          "Both edge and region parameters are required if one is set. " +
            "Twilio's FQDN format requires both: api.{edge}.{region}.twilio.com. " +
            `Got: region='${region ?? "None"}', edge='${edge ?? "None"}'`,
        );
      }
    }

    this._streamSid = options.streamSid;
    this._callSid = options.callSid ?? null;
    this._accountSid = options.accountSid ?? null;
    this._authToken = options.authToken ?? null;
    this._apiKeySid = options.apiKeySid ?? null;
    this._apiKeySecret = options.apiKeySecret ?? null;
    this._region = options.region ?? null;
    this._edge = options.edge ?? null;
    this._baseUrl = options.baseUrl ?? null;

    this._twilioSampleRate = this._params.twilioSampleRate;
    this._sampleRate = 0; // Pipeline input rate

    this._inputResampler = createStreamResampler({
      clearAfterSecs: this._params.resamplerClearAfterSecs,
    });
    this._outputResampler = createStreamResampler({
      clearAfterSecs: this._params.resamplerClearAfterSecs,
    });
    this._hangupAttempted = false;
  }

  /**
   * Sets up the serializer with pipeline configuration.
   *
   * @param setup Configuration object containing setup parameters.
   */
  override async setup(setup: FrameProcessorSetup | unknown): Promise<void> {
    // `||` on purpose: upstream uses Python `or`, so a 0 sample rate falls through.
    this._sampleRate = this._params.sampleRate || (setup as FrameProcessorSetup).audioInSampleRate;
  }

  /**
   * Serializes a Pipecat frame to Twilio WebSocket format.
   *
   * Handles conversion of various frame types to Twilio WebSocket messages.
   * For EndFrames, initiates call termination if `autoHangUp` is enabled.
   *
   * @param frame The Pipecat frame to serialize.
   * @returns Serialized data as string or bytes, or null if the frame isn't handled.
   */
  async serialize(frame: Frame): Promise<SerializedData | null> {
    if (
      this._params.autoHangUp &&
      !this._hangupAttempted &&
      (frame instanceof EndFrame || frame instanceof CancelFrame)
    ) {
      this._hangupAttempted = true;
      await this._hangUpCall();
      return null;
    } else if (frame instanceof InterruptionFrame) {
      const answer = { event: "clear", streamSid: this._streamSid };
      return jsonDumps(answer);
    } else if (frame instanceof AudioRawFrame) {
      const data = frame.audio;

      // Output: Convert PCM at frame's rate to 8kHz μ-law for Twilio
      const serializedData = await pcmToUlaw(
        data,
        frame.sampleRate,
        this._twilioSampleRate,
        this._outputResampler,
      );
      if (serializedData == null || serializedData.length === 0) {
        // Ignoring in case we don't have audio
        return null;
      }

      const payload = bytesToBase64(serializedData);
      const answer = {
        event: "media",
        streamSid: this._streamSid,
        media: { payload },
      };

      return jsonDumps(answer);
    } else if (
      frame instanceof OutputTransportMessageFrame ||
      frame instanceof OutputTransportMessageUrgentFrame
    ) {
      if (this.shouldIgnoreFrame(frame)) {
        return null;
      }
      return jsonDumps(frame.message);
    }

    // Return None for unhandled frames
    return null;
  }

  /** Hang up the Twilio call using Twilio's REST API. */
  protected async _hangUpCall(): Promise<void> {
    try {
      // The constructor guarantees accountSid, callSid and exactly one
      // credential type (authToken or the API key pair) are set whenever
      // autoHangUp is true, which is the only path that reaches this method.
      const accountSid = this._accountSid as string;
      const callSid = this._callSid as string;
      // REST endpoint for updating the call. Derived from base_url when set
      // (Twilio-API-compatible / self-hosted), else Twilio's region/edge FQDN.
      const endpoint = _buildCallResourceUrl(accountSid, callSid, {
        baseUrl: this._baseUrl,
        region: this._region,
        edge: this._edge,
      });

      // Basic Auth pair: account_sid + auth_token, or api_key_sid + api_key_secret.
      let login: string;
      let password: string;
      if (this._authToken) {
        login = accountSid;
        password = this._authToken;
      } else {
        login = this._apiKeySid as string;
        password = this._apiKeySecret as string;
      }

      // Parameters to set the call status to "completed" (hang up),
      // form-encoded as aiohttp does.
      const headers = {
        Authorization: basicAuth(login, password),
        "Content-Type": "application/x-www-form-urlencoded",
      };
      const body = new URLSearchParams({ Status: "completed" }).toString();

      // Make the POST request to update the call
      const response = await abortable(
        fetch(endpoint, { method: "POST", headers, body, signal: currentSignal() }),
      );
      if (response.status === 200) {
        logger.info(`Successfully terminated Twilio call ${callSid}`);
        // Release the connection: aiohttp does when its context exits.
        await abortable(response.body?.cancel() ?? Promise.resolve());
      } else if (response.status === 404) {
        // A fetch body can only be read once (aiohttp caches it), so read the
        // text first and parse the JSON from it.
        const errorText = await abortable(response.text());

        // Handle the case where the call has already ended
        // Error code 20404: "The requested resource was not found"
        // Source: https://www.twilio.com/docs/errors/20404
        try {
          if (!isJsonContentType(response)) {
            throw new TypeError("Attempt to decode JSON with unexpected mimetype");
          }
          const errorData: unknown = pyJsonLoads(errorText.trim());
          if (dictGet(errorData, "code") === 20404) {
            logger.debug(`Twilio call ${callSid} was already terminated`);
            return;
          }
        } catch (e) {
          rethrowIfCancelled(e);
          // Fall through to log the raw error
        }

        // Log other 404 errors
        logger.error(
          `Failed to terminate Twilio call ${callSid}: ` +
            `Status ${response.status}, Response: ${errorText}`,
        );
      } else {
        // Log other errors
        const errorText = await abortable(response.text());
        logger.error(
          `Failed to terminate Twilio call ${callSid}: ` +
            `Status ${response.status}, Response: ${errorText}`,
        );
      }
    } catch (e) {
      rethrowIfCancelled(e);
      logger.error(`Failed to hang up Twilio call: ${e instanceof Error ? e.message : e}`);
    }
  }

  /**
   * Deserializes Twilio WebSocket data to Pipecat frames.
   *
   * Handles conversion of Twilio media events to appropriate Pipecat frames.
   *
   * @param data The raw WebSocket data from Twilio.
   * @returns A Pipecat frame corresponding to the Twilio event, or null if unhandled.
   */
  async deserialize(data: SerializedData): Promise<Frame | null> {
    let message: unknown;
    try {
      const text = typeof data === "string" ? data : new TextDecoder().decode(data);
      message = pyJsonLoads(text);
    } catch (e) {
      rethrowIfCancelled(e);
      logger.warning(`Failed to parse JSON message: ${String(data)}`);
      return null;
    }

    // `dictGet` raises on a non-dict, as upstream's `.get()` does.
    const event = dictGet(message, "event");

    if (event === "media") {
      const payloadBase64 = dictGet(dictGet(message, "media", {}), "payload") as string | null;
      if (!payloadBase64) {
        return null;
      }
      const payload = base64ToBytes(payloadBase64);

      // Input: Convert Twilio's 8kHz μ-law to PCM at pipeline input rate
      const deserializedData = await ulawToPcm(
        payload,
        this._twilioSampleRate,
        this._sampleRate,
        this._inputResampler,
      );
      if (deserializedData == null || deserializedData.length === 0) {
        // Ignoring in case we don't have audio
        return null;
      }

      const audioFrame = new InputAudioRawFrame({
        audio: deserializedData,
        numChannels: 1,
        sampleRate: this._sampleRate,
      });
      return audioFrame;
    } else if (event === "dtmf") {
      const digit = dictGet(dictGet(message, "dtmf", {}), "digit");

      if (typeof digit !== "string" || !KEYPAD_VALUES.includes(digit)) {
        // Handle case where string doesn't match any enum value
        return null;
      }
      return new InputDTMFFrame({ button: digit as KeypadEntry });
    } else {
      return null;
    }
  }
}
