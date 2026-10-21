// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/services/heygen/api_liveavatar.py

/**
 * LiveAvatar API.
 *
 * API to communicate with LiveAvatar Streaming API.
 *
 * Porting notes: requests go through `fetch` (upstream: an aiohttp session),
 * so this module runs on every runtime, Cloudflare Workers included.
 */

import { abortable, currentSignal, rethrowIfCancelled } from "@pipedog/asyncio";
import { logger } from "@pipedog/core/utils/logger";
import { pyJsonDumps } from "@pipedog/core/utils/py_json";
import {
  BaseAvatarApi,
  optionalInt,
  optionalString,
  ResponseValidationError,
  requireInt,
  requireString,
  StandardSessionResponse,
} from "./base_api.ts";

export interface AvatarPersonaOptions {
  /** ID of the voice to be used. */
  voiceId?: string | null;
  /** Context ID for the avatar. */
  contextId?: string | null;
  /** Language code for the avatar (default: "en"). */
  language?: string;
}

/** Avatar persona settings for LiveAvatar. */
export class AvatarPersona {
  voiceId: string | null;
  contextId: string | null;
  language: string;

  constructor(options: AvatarPersonaOptions = {}) {
    this.voiceId = options.voiceId ?? null;
    this.contextId = options.contextId ?? null;
    this.language = options.language ?? "en";
  }
}

export interface CustomSDKLiveKitConfigOptions {
  /** LiveKit server URL. */
  livekitUrl: string;
  /** LiveKit room name. */
  livekitRoom: string;
  /** LiveKit client access token. */
  livekitClientToken: string;
}

/** Custom LiveKit configuration. */
export class CustomSDKLiveKitConfig {
  livekitUrl: string;
  livekitRoom: string;
  livekitClientToken: string;

  constructor(options: CustomSDKLiveKitConfigOptions) {
    this.livekitUrl = options.livekitUrl;
    this.livekitRoom = options.livekitRoom;
    this.livekitClientToken = options.livekitClientToken;
  }
}

/** Enum representing the video encoding. */
export const VideoEncoding = {
  H264: "H264",
  VP8: "VP8",
} as const;
export type VideoEncoding = (typeof VideoEncoding)[keyof typeof VideoEncoding];

/** Enum representing different avatar quality levels. */
export const VideoQuality = {
  low: "low",
  medium: "medium",
  high: "high",
  very_high: "very_high",
} as const;
export type VideoQuality = (typeof VideoQuality)[keyof typeof VideoQuality];

export interface VideoSettingsOptions {
  /**
   * Video codec the avatar stream is encoded with. LiveAvatar has deprecated
   * `VP8`, so prefer `H264`.
   */
  encoding: VideoEncoding;
  /** Rendering quality of the avatar stream. */
  quality?: VideoQuality;
}

/** Video encoding settings for session configuration. */
export class VideoSettings {
  encoding: VideoEncoding;
  quality: VideoQuality;

  constructor(options: VideoSettingsOptions) {
    this.encoding = options.encoding;
    this.quality = options.quality ?? VideoQuality.high;
  }
}

export interface LiveAvatarNewSessionRequestOptions {
  /** Session mode (default: "LITE"). */
  mode?: string;
  /** Unique identifier for the avatar. */
  avatarId: string;
  /** Video encoding settings (default: H264, high quality). */
  videoSettings?: VideoSettings | null;
  /** Enable sandbox mode (default: false). */
  isSandbox?: boolean | null;
  /** Avatar persona configuration. */
  avatarPersona?: AvatarPersona | null;
  /** Custom LiveKit configuration. */
  livekitConfig?: CustomSDKLiveKitConfig | null;
  /**
   * Maximum session duration in seconds. The ceiling is set by the LiveAvatar
   * subscription tier, which also supplies the default when this is unset.
   */
  maxSessionDuration?: number | null;
}

/** Request model for creating a LiveAvatar session token. */
export class LiveAvatarNewSessionRequest {
  mode: string;
  avatarId: string;
  videoSettings: VideoSettings | null;
  isSandbox: boolean | null;
  avatarPersona: AvatarPersona | null;
  livekitConfig: CustomSDKLiveKitConfig | null;
  maxSessionDuration: number | null;

  constructor(options: LiveAvatarNewSessionRequestOptions) {
    this.mode = options.mode ?? "LITE";
    this.avatarId = options.avatarId;
    this.videoSettings =
      options.videoSettings === undefined
        ? new VideoSettings({ encoding: VideoEncoding.H264 })
        : options.videoSettings;
    this.isSandbox = options.isSandbox === undefined ? false : options.isSandbox;
    this.avatarPersona = options.avatarPersona ?? null;
    this.livekitConfig = options.livekitConfig ?? null;
    this.maxSessionDuration = options.maxSessionDuration ?? null;
  }
}

/** Data model for session token response. */
export class SessionTokenData {
  /** Unique identifier for the session. */
  sessionId: string;
  /** Session token for authentication. */
  sessionToken: string;

  constructor(options: { sessionId: string; sessionToken: string }) {
    this.sessionId = options.sessionId;
    this.sessionToken = options.sessionToken;
  }

  /** Validate an API response (pydantic `model_validate`). */
  static modelValidate(data: unknown): SessionTokenData {
    const m = "SessionTokenData";
    return new SessionTokenData({
      sessionId: requireString(data, "session_id", m),
      sessionToken: requireString(data, "session_token", m),
    });
  }
}

function requireObject(obj: unknown, field: string, model: string): unknown {
  const value = (obj as Record<string, unknown> | null | undefined)?.[field];
  if (value === null || typeof value !== "object") {
    throw new ResponseValidationError(`${model}: field "${field}" must be an object`);
  }
  return value;
}

/** Response model for LiveAvatar session token. */
export class SessionTokenResponse {
  /** Response status code. */
  code: number;
  /** Session token data containing session_id and session_token. */
  data: SessionTokenData;
  /** Response message. */
  message: string;

  constructor(options: { code: number; data: SessionTokenData; message: string }) {
    this.code = options.code;
    this.data = options.data;
    this.message = options.message;
  }

  /** Validate an API response (pydantic `model_validate`). */
  static modelValidate(response: unknown): SessionTokenResponse {
    const m = "SessionTokenResponse";
    return new SessionTokenResponse({
      code: requireInt(response, "code", m),
      data: SessionTokenData.modelValidate(requireObject(response, "data", m)),
      message: requireString(response, "message", m),
    });
  }
}

export interface LiveAvatarSessionDataOptions {
  sessionId: string;
  livekitUrl: string;
  livekitClientToken: string;
  livekitAgentToken?: string | null;
  maxSessionDuration?: number | null;
  wsUrl?: string | null;
}

/**
 * Data model for LiveAvatar session response.
 *
 * DIVERGENCE: `livekitAgentToken`, `maxSessionDuration` and `wsUrl` are
 * optional, as LiveAvatar's API reference documents them
 * (`StartSessionResponseSchema`); upstream's model requires them, so a
 * response without them fails validation there.
 */
export class LiveAvatarSessionData {
  /** Unique identifier for the streaming session. */
  sessionId: string;
  /** LiveKit server URL for the session. */
  livekitUrl: string;
  /** Access token for LiveKit user. */
  livekitClientToken: string;
  /** Access token for LiveKit Agent (Pipecat), if returned. */
  livekitAgentToken: string | null;
  /** Maximum session duration in seconds, if returned. */
  maxSessionDuration: number | null;
  /** WebSocket URL for the session, if returned. */
  wsUrl: string | null;

  constructor(options: LiveAvatarSessionDataOptions) {
    this.sessionId = options.sessionId;
    this.livekitUrl = options.livekitUrl;
    this.livekitClientToken = options.livekitClientToken;
    this.livekitAgentToken = options.livekitAgentToken ?? null;
    this.maxSessionDuration = options.maxSessionDuration ?? null;
    this.wsUrl = options.wsUrl ?? null;
  }

  /** Validate an API response (pydantic `model_validate`). */
  static modelValidate(data: unknown): LiveAvatarSessionData {
    const m = "LiveAvatarSessionData";
    return new LiveAvatarSessionData({
      sessionId: requireString(data, "session_id", m),
      livekitUrl: requireString(data, "livekit_url", m),
      livekitClientToken: requireString(data, "livekit_client_token", m),
      livekitAgentToken: optionalString(data, "livekit_agent_token", m),
      maxSessionDuration: optionalInt(data, "max_session_duration", m),
      wsUrl: optionalString(data, "ws_url", m),
    });
  }
}

/** Response model for LiveAvatar session start. */
export class LiveAvatarSessionResponse {
  /** Response status code. */
  code: number;
  /** Session data containing connection details. */
  data: LiveAvatarSessionData;
  /** Response message. */
  message: string;

  constructor(options: { code: number; data: LiveAvatarSessionData; message: string }) {
    this.code = options.code;
    this.data = options.data;
    this.message = options.message;
  }

  /** Validate an API response (pydantic `model_validate`). */
  static modelValidate(response: unknown): LiveAvatarSessionResponse {
    const m = "LiveAvatarSessionResponse";
    return new LiveAvatarSessionResponse({
      code: requireInt(response, "code", m),
      data: LiveAvatarSessionData.modelValidate(requireObject(response, "data", m)),
      message: requireString(response, "message", m),
    });
  }
}

/** Custom exception for LiveAvatar API errors. */
export class LiveAvatarApiError extends Error {
  override name = "LiveAvatarApiError";
  /** HTTP status code. */
  status: number;
  /** Raw response text from the API. */
  responseText: string;

  /**
   * Initialize the LiveAvatar API error.
   *
   * @param message Error message.
   * @param status HTTP status code.
   * @param responseText Raw response text from the API.
   */
  constructor(message: string, status: number, responseText: string) {
    super(message);
    this.status = status;
    this.responseText = responseText;
  }
}

export interface LiveAvatarApiOptions {
  /**
   * `fetch` used for HTTP requests. Defaults to the global `fetch`.
   *
   * DIVERGENCE: replaces upstream's required aiohttp `session`.
   */
  fetch?: typeof fetch | null;
  /** API base URL (default `LiveAvatarApi.BASE_URL`). pipedog addition, for tests and proxies. */
  baseUrl?: string | null;
}

/** LiveAvatar Streaming API client. */
export class LiveAvatarApi extends BaseAvatarApi {
  static BASE_URL = "https://api.liveavatar.com/v1";

  protected _apiKey: string;
  protected _fetch: typeof fetch;
  protected _baseUrl: string;
  protected _sessionToken: string | null = null;

  /**
   * Initialize the LiveAvatar API.
   *
   * @param apiKey LiveAvatar API key.
   * @param options.fetch `fetch` used for HTTP requests (upstream: an aiohttp session).
   */
  constructor(apiKey: string, options: LiveAvatarApiOptions = {}) {
    super();
    this._apiKey = apiKey;
    this._fetch = options.fetch ?? (((input, init) => fetch(input, init)) as typeof fetch);
    this._baseUrl = options.baseUrl ?? (this.constructor as typeof LiveAvatarApi).BASE_URL;
  }

  /**
   * Make a request to the LiveAvatar API.
   *
   * @param method HTTP method (GET, POST, etc.).
   * @param path API endpoint path.
   * @param params JSON-serializable parameters.
   * @param bearerToken Optional bearer token for authorization.
   * @returns Parsed JSON response data.
   * @throws LiveAvatarApiError If the API response is not successful.
   */
  protected async _request(
    method: string,
    path: string,
    params: Record<string, unknown> | null = null,
    bearerToken: string | null = null,
  ): Promise<unknown> {
    const url = `${this._baseUrl}${path}`;
    const headers: Record<string, string> = {
      accept: "application/json",
    };

    if (bearerToken) {
      headers.authorization = `Bearer ${bearerToken}`;
    } else {
      headers["X-API-KEY"] = this._apiKey;
    }

    if (params !== null) {
      headers["content-type"] = "application/json";
    }

    logger.debug(`LiveAvatar API request: ${method} ${url}`);

    let response: Response;
    try {
      response = await abortable(
        this._fetch(url, {
          method,
          headers,
          body: params !== null ? pyJsonDumps(params) : undefined,
          signal: currentSignal(),
        }),
      );
    } catch (e) {
      rethrowIfCancelled(e);
      logger.error(
        `Network error while calling LiveAvatar API: ${e instanceof Error ? e.message : e}`,
      );
      throw e;
    }
    if (!response.ok) {
      const responseText = await abortable(response.text());
      logger.error(`LiveAvatar API error: ${responseText}`);
      throw new LiveAvatarApiError(
        `API request failed with status ${response.status}`,
        response.status,
        responseText,
      );
    }
    return await abortable(response.json());
  }

  /**
   * Create a session token for LiveAvatar.
   *
   * https://docs.liveavatar.com/reference/create_session_token_v1_sessions_token_post
   *
   * @param requestData Session token configuration parameters.
   * @returns Session token information.
   */
  async createSessionToken(
    requestData: LiveAvatarNewSessionRequest,
  ): Promise<SessionTokenResponse> {
    const params: Record<string, unknown> = {
      mode: requestData.mode ?? "LITE",
      avatar_id: requestData.avatarId,
    };

    // Only include avatar_persona if it exists and has non-None values
    if (requestData.avatarPersona !== null) {
      const persona: Record<string, unknown> = {
        voice_id: requestData.avatarPersona.voiceId,
        context_id: requestData.avatarPersona.contextId,
        language: requestData.avatarPersona.language,
      };
      // Remove None values from avatar_persona
      params.avatar_persona = Object.fromEntries(
        Object.entries(persona).filter(([, v]) => v !== null && v !== undefined),
      );
    }

    if (requestData.isSandbox !== null) {
      params.is_sandbox = requestData.isSandbox;
    }

    if (requestData.maxSessionDuration !== null) {
      params.max_session_duration = requestData.maxSessionDuration;
    }

    if (requestData.videoSettings !== null) {
      params.video_settings = {
        encoding: requestData.videoSettings.encoding,
        quality: requestData.videoSettings.quality,
      };
    } else {
      // Fall back to H264 encoding if video_settings is not provided
      params.video_settings = { encoding: VideoEncoding.H264 };
    }

    if (requestData.livekitConfig !== null) {
      params.livekit_config = {
        livekit_url: requestData.livekitConfig.livekitUrl,
        livekit_room: requestData.livekitConfig.livekitRoom,
        livekit_client_token: requestData.livekitConfig.livekitClientToken,
      };
    }

    logger.debug(`Creating LiveAvatar session token with params: ${pyJsonDumps(params)}`);
    const response = await this._request("POST", "/sessions/token", params);
    logger.debug("LiveAvatar session token created");

    return SessionTokenResponse.modelValidate(response);
  }

  /**
   * Start a new LiveAvatar session.
   *
   * https://docs.liveavatar.com/reference/start_session_v1_sessions_start_post
   *
   * @param sessionToken Session token obtained from createSessionToken.
   * @returns Session information including room URL and session ID.
   */
  async startSession(sessionToken: string): Promise<LiveAvatarSessionResponse> {
    const response = await this._request("POST", "/sessions/start", null, sessionToken);
    logger.debug("LiveAvatar session started");

    return LiveAvatarSessionResponse.modelValidate(response);
  }

  /**
   * Stop an active LiveAvatar session.
   *
   * https://docs.liveavatar.com/reference/stop_session_v1_sessions_stop_post
   *
   * @param sessionId ID of the session to stop.
   * @param sessionToken Session token for authentication.
   * @returns Response data from the stop session API call.
   * @throws Error If session ID is not set.
   */
  async stopSession(sessionId: string, sessionToken: string): Promise<unknown> {
    if (!sessionId) {
      throw new Error("Session ID is not set.");
    }

    const params = { session_id: sessionId };

    return await this._request("POST", "/sessions/stop", params, sessionToken);
  }

  /**
   * Create and start a new LiveAvatar session (convenience method).
   *
   * This combines createSessionToken and startSession into a single call.
   *
   * @param requestData Session token configuration parameters.
   * @returns Standardized session information with LiveAvatar raw response.
   */
  async newSession(requestData: LiveAvatarNewSessionRequest): Promise<StandardSessionResponse> {
    // Create session token
    const tokenResponse = await this.createSessionToken(requestData);
    this._sessionToken = tokenResponse.data.sessionToken;

    // Start the session using the session_token from the data field
    const sessionResponse = await this.startSession(tokenResponse.data.sessionToken);

    // Convert to standardized response
    return new StandardSessionResponse({
      sessionId: sessionResponse.data.sessionId,
      accessToken: sessionResponse.data.livekitClientToken,
      livekitUrl: sessionResponse.data.livekitUrl,
      livekitAgentToken: sessionResponse.data.livekitAgentToken,
      wsUrl: sessionResponse.data.wsUrl,
      rawResponse: sessionResponse,
    });
  }

  /**
   * Close an active LiveAvatar session (convenience method).
   *
   * Closes a session using the stored session token from the most recent
   * `newSession()` call. For more control over session tokens, use
   * `stopSession()` directly with an explicit token.
   *
   * @param sessionId ID of the session to close.
   * @returns Response data from the stop session API call.
   * @throws Error If no session token is available (`newSession()` hasn't
   *   been called yet).
   */
  async closeSession(sessionId: string): Promise<unknown> {
    if (!this._sessionToken) {
      throw new Error("Session token is not set. Call new_session first.");
    }

    return await this.stopSession(sessionId, this._sessionToken);
  }
}
