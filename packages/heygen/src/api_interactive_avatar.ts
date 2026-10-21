// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/services/heygen/api_interactive_avatar.py

/**
 * HeyGen API.
 *
 * API to communicate with HeyGen Streaming API.
 *
 * Porting notes: requests go through `fetch` (upstream: an aiohttp session),
 * so this module runs on every runtime, Cloudflare Workers included.
 */

import { abortable, currentSignal, rethrowIfCancelled } from "@pipedog/asyncio";
import { logger } from "@pipedog/core/utils/logger";
import { pyJsonDumps } from "@pipedog/core/utils/py_json";
import { BaseAvatarApi, requireString, StandardSessionResponse } from "./base_api.ts";

/** Enum representing different avatar quality levels. */
export const AvatarQuality = {
  low: "low",
  medium: "medium",
  high: "high",
} as const;
export type AvatarQuality = (typeof AvatarQuality)[keyof typeof AvatarQuality];

/** Enum representing the video encoding. */
export const VideoEncoding = {
  H264: "H264",
  VP8: "VP8",
} as const;
export type VideoEncoding = (typeof VideoEncoding)[keyof typeof VideoEncoding];

/** Enum representing different voice emotion types. */
export const VoiceEmotion = {
  EXCITED: "excited",
  SERIOUS: "serious",
  FRIENDLY: "friendly",
  SOOTHING: "soothing",
  BROADCASTER: "broadcaster",
} as const;
export type VoiceEmotion = (typeof VoiceEmotion)[keyof typeof VoiceEmotion];

export interface ElevenLabsSettingsOptions {
  /** Stability of the voice synthesis. */
  stability?: number | null;
  /** Adjustment for similarity in voice performance. */
  similarityBoost?: number | null;
  /** Identifier for the ElevenLabs model to use. */
  modelId?: string | null;
  /** Style metric to apply for the voice. */
  style?: number | null;
  /** Flag to enable speaker boost. */
  useSpeakerBoost?: boolean | null;
}

/** Settings for ElevenLabs voice configuration. */
export class ElevenLabsSettings {
  stability: number | null;
  similarityBoost: number | null;
  modelId: string | null;
  style: number | null;
  useSpeakerBoost: boolean | null;

  constructor(options: ElevenLabsSettingsOptions = {}) {
    this.stability = options.stability ?? null;
    this.similarityBoost = options.similarityBoost ?? null;
    this.modelId = options.modelId ?? null;
    this.style = options.style ?? null;
    this.useSpeakerBoost = options.useSpeakerBoost ?? null;
  }

  /** The settings with their wire (snake_case) keys. */
  toDict(): Record<string, unknown> {
    return {
      stability: this.stability,
      similarity_boost: this.similarityBoost,
      model_id: this.modelId,
      style: this.style,
      use_speaker_boost: this.useSpeakerBoost,
    };
  }
}

export interface VoiceSettingsOptions {
  /** ID of the voice to be used. */
  voiceId?: string | null;
  /** Speaking rate for the voice. */
  rate?: number | null;
  /** Emotion tone for the voice. */
  emotion?: VoiceEmotion | null;
  /** Details for ElevenLabs configuration. */
  elevenlabsSettings?: ElevenLabsSettings | null;
}

/** Voice configuration settings. */
export class VoiceSettings {
  voiceId: string | null;
  rate: number | null;
  emotion: VoiceEmotion | null;
  elevenlabsSettings: ElevenLabsSettings | null;

  constructor(options: VoiceSettingsOptions = {}) {
    this.voiceId = options.voiceId ?? null;
    this.rate = options.rate ?? null;
    this.emotion = options.emotion ?? null;
    this.elevenlabsSettings = options.elevenlabsSettings ?? null;
  }
}

export interface NewSessionRequestOptions {
  /** Desired quality of the avatar. */
  quality?: AvatarQuality | null;
  /** Unique identifier for the avatar. */
  avatarId?: string | null;
  /** Voice configurations for the session. */
  voice?: VoiceSettings | null;
  /** Desired encoding for the video stream. */
  videoEncoding?: VideoEncoding | null;
  /** Identifier for the knowledge base (if applicable). */
  knowledgeId?: string | null;
  /** Details of any external knowledge base. */
  knowledgeBase?: string | null;
  /** API version to use. */
  version?: "v2";
  /** Flag to disable automatic idle timeout. */
  disableIdleTimeout?: boolean | null;
  /** Timeout in seconds for activity-based idle detection. */
  activityIdleTimeout?: number | null;
}

/** Requesting model for creating a new HeyGen session. */
export class NewSessionRequest {
  quality: AvatarQuality | null;
  avatarId: string | null;
  voice: VoiceSettings | null;
  videoEncoding: VideoEncoding | null;
  knowledgeId: string | null;
  knowledgeBase: string | null;
  version: "v2";
  disableIdleTimeout: boolean | null;
  activityIdleTimeout: number | null;

  constructor(options: NewSessionRequestOptions = {}) {
    this.quality = options.quality ?? null;
    this.avatarId = options.avatarId ?? null;
    this.voice = options.voice ?? null;
    this.videoEncoding = options.videoEncoding ?? null;
    this.knowledgeId = options.knowledgeId ?? null;
    this.knowledgeBase = options.knowledgeBase ?? null;
    this.version = options.version ?? "v2";
    this.disableIdleTimeout = options.disableIdleTimeout ?? null;
    this.activityIdleTimeout = options.activityIdleTimeout ?? null;
  }
}

export interface HeyGenSessionOptions {
  sessionId: string;
  accessToken: string;
  livekitAgentToken: string;
  realtimeEndpoint: string;
  url: string;
}

/** Response model for a HeyGen session. */
export class HeyGenSession {
  /** Unique identifier for the streaming session. */
  sessionId: string;
  /** Token for accessing the session securely. */
  accessToken: string;
  /** Token for HeyGen's audio agents (Pipecat). */
  livekitAgentToken: string;
  /** Real-time communication endpoint URL. */
  realtimeEndpoint: string;
  /** Direct URL for the session. */
  url: string;

  constructor(options: HeyGenSessionOptions) {
    this.sessionId = options.sessionId;
    this.accessToken = options.accessToken;
    this.livekitAgentToken = options.livekitAgentToken;
    this.realtimeEndpoint = options.realtimeEndpoint;
    this.url = options.url;
  }

  /** Validate an API response (pydantic `model_validate`). */
  static modelValidate(data: unknown): HeyGenSession {
    const m = "HeyGenSession";
    return new HeyGenSession({
      sessionId: requireString(data, "session_id", m),
      accessToken: requireString(data, "access_token", m),
      livekitAgentToken: requireString(data, "livekit_agent_token", m),
      realtimeEndpoint: requireString(data, "realtime_endpoint", m),
      url: requireString(data, "url", m),
    });
  }
}

/** Custom exception for HeyGen API errors. */
export class HeygenApiError extends Error {
  override name = "HeygenApiError";
  /** HTTP status code. */
  status: number;
  /** Raw response text from the API. */
  responseText: string;

  /**
   * Initialize the HeyGen API error.
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

export interface HeyGenApiOptions {
  /**
   * `fetch` used for HTTP requests. Defaults to the global `fetch`.
   *
   * DIVERGENCE: replaces upstream's required aiohttp `session`.
   */
  fetch?: typeof fetch | null;
  /** API base URL (default `HeyGenApi.BASE_URL`). pipedog addition, for tests and proxies. */
  baseUrl?: string | null;
}

/** HeyGen Streaming API client. */
export class HeyGenApi extends BaseAvatarApi {
  static BASE_URL = "https://api.heygen.com/v1";

  apiKey: string;
  protected _fetch: typeof fetch;
  protected _baseUrl: string;

  /**
   * Initialize the HeyGen API.
   *
   * @param apiKey HeyGen API key.
   * @param options.fetch `fetch` used for HTTP requests (upstream: an aiohttp session).
   */
  constructor(apiKey: string, options: HeyGenApiOptions = {}) {
    super();
    this.apiKey = apiKey;
    this._fetch = options.fetch ?? (((input, init) => fetch(input, init)) as typeof fetch);
    this._baseUrl = options.baseUrl ?? (this.constructor as typeof HeyGenApi).BASE_URL;
  }

  /**
   * Make a POST request to the HeyGen API.
   *
   * @param path API endpoint path.
   * @param params JSON-serializable parameters.
   * @param expectData Whether to expect and extract the 'data' field from the response.
   * @returns Parsed JSON response data.
   * @throws HeygenApiError If the API response is not successful.
   */
  protected async _request(
    path: string,
    params: Record<string, unknown>,
    expectData = true,
  ): Promise<unknown> {
    const url = `${this._baseUrl}${path}`;
    const headers = {
      "x-api-key": this.apiKey,
      "Content-Type": "application/json",
    };

    logger.debug(`HeyGen API request: ${url}`);

    let response: Response;
    try {
      response = await abortable(
        this._fetch(url, {
          method: "POST",
          headers,
          body: pyJsonDumps(params),
          signal: currentSignal(),
        }),
      );
    } catch (e) {
      rethrowIfCancelled(e);
      logger.error(`Network error while calling HeyGen API: ${e instanceof Error ? e.message : e}`);
      throw e;
    }
    if (!response.ok) {
      const responseText = await abortable(response.text());
      logger.error(`HeyGen API error: ${responseText}`);
      throw new HeygenApiError(
        `API request failed with status ${response.status}`,
        response.status,
        responseText,
      );
    }
    if (expectData) {
      const jsonData = (await abortable(response.json())) as Record<string, unknown> | null;
      return jsonData?.data ?? null;
    }
    return await abortable(response.text());
  }

  /**
   * Create a new streaming session and start it immediately.
   *
   * https://docs.heygen.com/reference/new-session
   *
   * @param requestData Session configuration parameters.
   * @returns Standardized session information with HeyGen raw response.
   */
  async newSession(requestData: NewSessionRequest): Promise<StandardSessionResponse> {
    const voice = requestData.voice;
    const params = {
      quality: requestData.quality,
      avatar_id: requestData.avatarId,
      voice: {
        voice_id: voice ? voice.voiceId : null,
        rate: voice ? voice.rate : null,
        emotion: voice ? voice.emotion : null,
        // Upstream hands aiohttp the pydantic model here; we send its fields.
        elevenlabs_settings: voice?.elevenlabsSettings ? voice.elevenlabsSettings.toDict() : null,
      },
      knowledge_id: requestData.knowledgeId,
      knowledge_base: requestData.knowledgeBase,
      version: requestData.version,
      video_encoding: requestData.videoEncoding,
      disable_idle_timeout: requestData.disableIdleTimeout,
      activity_idle_timeout: requestData.activityIdleTimeout,
    };
    const sessionInfo = await this._request("/streaming.new", params);
    logger.debug(`HeyGen session info: ${pyJsonDumps(sessionInfo)}`);

    const heygenSession = HeyGenSession.modelValidate(sessionInfo);

    await this._startSession(heygenSession.sessionId);

    // Convert to standardized response
    return new StandardSessionResponse({
      sessionId: heygenSession.sessionId,
      accessToken: heygenSession.accessToken,
      livekitUrl: heygenSession.url,
      livekitAgentToken: heygenSession.livekitAgentToken,
      wsUrl: heygenSession.realtimeEndpoint,
      rawResponse: heygenSession,
    });
  }

  /**
   * Start the streaming session.
   *
   * https://docs.heygen.com/reference/start-session
   *
   * @param sessionId ID of the session to start.
   * @returns Response data from the start session API call.
   * @throws Error If session ID is not set.
   */
  protected async _startSession(sessionId: string): Promise<unknown> {
    if (!sessionId) {
      throw new Error("Session ID is not set. Call new_session first.");
    }

    const params = {
      session_id: sessionId,
    };
    return await this._request("/streaming.start", params);
  }

  /**
   * Terminate an active streaming session.
   *
   * https://docs.heygen.com/reference/close-session
   *
   * @param sessionId ID of the session to stop.
   * @returns Response data from the stop session API call.
   * @throws Error If session ID is not set.
   */
  async closeSession(sessionId: string): Promise<unknown> {
    if (!sessionId) {
      throw new Error("Session ID is not set. Call new_session first.");
    }

    const params = {
      session_id: sessionId,
    };
    return await this._request("/streaming.stop", params, false);
  }

  /**
   * Create a streaming token.
   *
   * https://docs.heygen.com/reference/streaming-token
   *
   * @returns The generated access token for the streaming session.
   */
  async createToken(): Promise<string> {
    const tokenInfo = (await this._request("/streaming.create_token", {})) as Record<
      string,
      unknown
    >;
    return tokenInfo.token as string;
  }
}
