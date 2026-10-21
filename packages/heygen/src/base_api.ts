// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/services/heygen/base_api.py

/**
 * Base API for HeyGen avatar services.
 *
 * Base class defining the common interface for HeyGen avatar service APIs.
 */

export interface StandardSessionResponseOptions {
  sessionId: string;
  accessToken: string;
  /**
   * DIVERGENCE: optional. LiveAvatar's start-session response documents
   * `livekit_agent_token` as optional (upstream's model requires it).
   */
  livekitAgentToken?: string | null;
  livekitUrl: string;
  /**
   * DIVERGENCE: optional. LiveAvatar documents `ws_url` as optional
   * ("Custom Mode only"); upstream's model requires it.
   */
  wsUrl?: string | null;
  rawResponse: unknown;
}

/**
 * Standardized session response that all HeyGen avatar services will provide.
 *
 * This contains the common fields that the client needs to operate,
 * while also storing the raw response for service-specific data access.
 */
export class StandardSessionResponse {
  /** Unique identifier for the streaming session. */
  sessionId: string;
  /** Token for accessing the session securely. */
  accessToken: string;
  /** Token for HeyGen's audio agents (Pipecat), or null if the API returned none. */
  livekitAgentToken: string | null;
  /** LiveKit server URL for the session. */
  livekitUrl: string;
  /** WebSocket URL for the session, or null if the API returned none. */
  wsUrl: string | null;
  /** The service's raw response. */
  rawResponse: unknown;

  constructor(options: StandardSessionResponseOptions) {
    this.sessionId = options.sessionId;
    this.accessToken = options.accessToken;
    this.livekitAgentToken = options.livekitAgentToken ?? null;
    this.livekitUrl = options.livekitUrl;
    this.wsUrl = options.wsUrl ?? null;
    this.rawResponse = options.rawResponse;
  }
}

/** Base class for avatar service APIs. */
export abstract class BaseAvatarApi {
  /**
   * Create a new avatar session.
   *
   * @param requestData Service-specific session request data.
   * @returns Standardized session information.
   */
  abstract newSession(requestData: unknown): Promise<StandardSessionResponse>;

  /**
   * Close an avatar session.
   *
   * @param sessionId ID of the session to close.
   * @returns Response data from the close session API call.
   */
  abstract closeSession(sessionId: string): Promise<unknown>;
}

/**
 * Validation error for an API response that lacks a required field, the
 * counterpart of pydantic's `ValidationError` from `model_validate`.
 */
export class ResponseValidationError extends Error {
  override name = "ResponseValidationError";
}

/** Read a required string field of `obj` (pydantic `str`). */
export function requireString(obj: unknown, field: string, model: string): string {
  const value = (obj as Record<string, unknown> | null | undefined)?.[field];
  if (typeof value !== "string") {
    throw new ResponseValidationError(`${model}: field "${field}" must be a string`);
  }
  return value;
}

/** Read an optional string field of `obj` (pydantic `str | None`). */
export function optionalString(obj: unknown, field: string, model: string): string | null {
  const value = (obj as Record<string, unknown> | null | undefined)?.[field];
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    throw new ResponseValidationError(`${model}: field "${field}" must be a string`);
  }
  return value;
}

/** Read a required integer field of `obj` (pydantic `int`). */
export function requireInt(obj: unknown, field: string, model: string): number {
  const value = (obj as Record<string, unknown> | null | undefined)?.[field];
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new ResponseValidationError(`${model}: field "${field}" must be an integer`);
  }
  return value;
}

/** Read an optional integer field of `obj` (pydantic `int | None`). */
export function optionalInt(obj: unknown, field: string, model: string): number | null {
  const value = (obj as Record<string, unknown> | null | undefined)?.[field];
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new ResponseValidationError(`${model}: field "${field}" must be an integer`);
  }
  return value;
}
