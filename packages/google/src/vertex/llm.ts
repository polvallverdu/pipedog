// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/services/google/vertex/llm.py

/**
 * Google Vertex AI LLM service implementation.
 *
 * This module provides integration with Google's AI models via Vertex AI,
 * extending the GoogleLLMService with Vertex AI authentication.
 *
 * Porting notes:
 * - Upstream sets `GRPC_ENABLE_FORK_SUPPORT=false` to silence gRPC fork
 *   warnings; `@google/genai` uses `fetch`, so there is nothing to silence.
 * - Authentication goes through `@google/genai`'s `googleAuthOptions`
 *   (google-auth-library), which only the SDK's Node build supports: this
 *   service runs on Bun, Node and Deno, not on Workers.
 * - DIVERGENCE: upstream loads the credentials and refreshes the access token
 *   in the constructor, raising "No valid credentials provided." when
 *   Application Default Credentials are missing. Loading a key file, finding
 *   ADC and refreshing a token are asynchronous in JS, so they happen on the
 *   first request (google-auth-library refreshes tokens as they expire);
 *   inline `credentials` are still parsed in the constructor.
 * - Deprecated upstream APIs are not ported: the `model`, `params` and
 *   `systemInstruction` constructor arguments (use `settings`).
 * - The parent constructor calls `createClient()` before this class has
 *   stored its Vertex options (JS cannot set fields before `super()`), so the
 *   override skips that call and the client is created at the end of this
 *   constructor.
 */

import { GoogleGenAI, type GoogleGenAIOptions, type HttpOptions } from "@google/genai";
import { logger } from "@pipedog/core/utils/logger";
import { pyJsonLoads } from "@pipedog/core/utils/py_json";
import { GeminiVertexLLMAdapter } from "../gemini_adapter.ts";
import {
  GoogleLLMService,
  type GoogleLLMServiceOptions,
  GoogleLLMSettings,
  type GoogleLLMSettingsOptions,
} from "../llm.ts";

/** google-auth-library options, as `GoogleGenAI` takes them. */
export type GoogleAuthOptions = NonNullable<GoogleGenAIOptions["googleAuthOptions"]>;

const CLOUD_PLATFORM_SCOPES = ["https://www.googleapis.com/auth/cloud-platform"];

export interface GoogleVertexLLMSettingsOptions extends GoogleLLMSettingsOptions {}

/** Settings for GoogleVertexLLMService. */
export class GoogleVertexLLMSettings extends GoogleLLMSettings {
  constructor(options: GoogleVertexLLMSettingsOptions = {}) {
    super(options);
    this._assignOptions(options);
  }
}

export interface GoogleVertexLLMServiceOptions
  extends Omit<GoogleLLMServiceOptions, "apiKey" | "settings"> {
  /** JSON string of service account credentials. */
  credentials?: string | null;
  /** Path to the service account JSON file. */
  credentialsPath?: string | null;
  /**
   * Location for the Vertex AI endpoint. Defaults to "global", the only
   * location that serves the Gemini 3 series; the regional endpoints serve
   * the 2.5 series.
   */
  location?: string;
  /** Google Cloud project ID. */
  projectId: string;
  /** Runtime-updatable settings for this service. */
  settings?: GoogleVertexLLMSettings | null;
}

/**
 * Google Vertex AI LLM service extending GoogleLLMService.
 *
 * Provides access to Google's AI models via Vertex AI while using the same
 * Google AI client and message format as GoogleLLMService. Handles authentication
 * using Google service account credentials and configures the client for
 * Vertex AI endpoints.
 *
 * Reference:
 *   https://cloud.google.com/vertex-ai/generative-ai/docs/model-reference/inference
 */
export class GoogleVertexLLMService extends GoogleLLMService {
  static override adapterClass = GeminiVertexLLMAdapter;

  static override Settings = GoogleVertexLLMSettings;
  declare protected _settings: GoogleVertexLLMSettings;

  protected _credentials: GoogleAuthOptions;
  protected _projectId: string;
  protected _location: string;

  /**
   * Initializes the VertexLLMService.
   *
   * @param options.credentials JSON string of service account credentials.
   * @param options.credentialsPath Path to the service account JSON file.
   * @param options.location Location for the Vertex AI endpoint. Defaults to
   *   "global", the only location that serves the Gemini 3 series; the
   *   regional endpoints serve the 2.5 series.
   * @param options.projectId Google Cloud project ID.
   * @param options.settings Runtime-updatable settings for this service.
   * @param options.tools List of available tools/functions.
   * @param options.toolConfig Configuration for tool usage.
   * @param options.httpOptions HTTP options for the client.
   *   Other options are passed to GoogleLLMService.
   */
  constructor(options: GoogleVertexLLMServiceOptions) {
    // Check if user incorrectly passed apiKey, which is used by parent
    // class but not here.
    if ("apiKey" in options) {
      logger.error(
        "GoogleVertexLLMService does not accept 'api_key' parameter. " +
          "Use 'credentials' or 'credentials_path' instead for Vertex AI authentication.",
      );
      throw new Error(
        "Invalid parameter 'api_key'. Use 'credentials' or 'credentials_path' for Vertex AI authentication.",
      );
    }

    const { credentials, credentialsPath, location, projectId, settings, ...rest } = options;

    // Upstream resolves these before calling the parent constructor, which
    // invokes createClient(); here they are stored right after it.
    const resolvedCredentials = GoogleVertexLLMService._getCredentials(
      credentials ?? null,
      credentialsPath ?? null,
    );

    // 1. Initialize defaultSettings with hardcoded defaults
    const defaultSettings = new GoogleVertexLLMSettings({
      model: "gemini-3.8-flash",
      systemInstruction: null,
      maxTokens: 4096,
      temperature: null,
      topK: null,
      topP: null,
      frequencyPenalty: null,
      presencePenalty: null,
      seed: null,
      filterIncompleteUserTurns: false,
      userTurnCompletionConfig: null,
      thinking: null,
      safetySettings: null,
      extra: {},
    });

    // 2. Apply settings delta (canonical API, always wins)
    if (settings !== undefined && settings !== null) {
      defaultSettings.applyUpdate(settings);
    }

    // Call parent constructor with dummy apiKey
    // (apiKey is required by parent class, but not actually used with Vertex)
    super({
      ...rest,
      apiKey: "dummy",
      settings: defaultSettings,
    });

    this._credentials = resolvedCredentials;
    this._projectId = projectId;
    this._location = location ?? "global";
    this.createClient();
  }

  /** Create the Gemini client instance configured for Vertex AI. */
  override createClient(): void {
    // Called once by the parent constructor, before the Vertex options are
    // stored; the constructor calls it again once they are.
    if (this._location === undefined) {
      return;
    }
    this._client = new GoogleGenAI({
      vertexai: true,
      googleAuthOptions: this._credentials,
      project: this._projectId,
      location: this._location,
      httpOptions: this._httpOptions as HttpOptions,
    });
  }

  /**
   * Retrieve credentials using Google service account credentials.
   *
   * Supports multiple authentication methods:
   * 1. Direct JSON credentials string
   * 2. Path to service account JSON file
   * 3. Default application credentials (ADC)
   *
   * @param credentials JSON string of service account credentials.
   * @param credentialsPath Path to the service account JSON file.
   * @returns google-auth-library options for API authentication. The file
   *   and ADC are loaded, and the access token refreshed, by the client.
   */
  static _getCredentials(
    credentials: string | null,
    credentialsPath: string | null,
  ): GoogleAuthOptions {
    if (credentials) {
      // Parse and load credentials from JSON string
      return {
        credentials: pyJsonLoads(credentials) as GoogleAuthOptions["credentials"],
        scopes: CLOUD_PLATFORM_SCOPES,
      };
    }
    if (credentialsPath) {
      // Load credentials from JSON file
      return { keyFilename: credentialsPath, scopes: CLOUD_PLATFORM_SCOPES };
    }
    // Application Default Credentials, resolved by the client on first use.
    return { scopes: CLOUD_PLATFORM_SCOPES };
  }
}
