// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/services/google/gemini_live/vertex/llm.py

/**
 * Service for accessing Gemini Live via Google Vertex AI.
 *
 * This module provides integration with Google's Gemini Live model via
 * Vertex AI, supporting both text and audio modalities with voice transcription,
 * streaming responses, and tool usage.
 *
 * Porting notes:
 * - Authentication goes through `@google/genai`'s `googleAuthOptions`
 *   (google-auth-library), which only the SDK's Node build supports: this
 *   service runs on Bun, Node and Deno, not on Workers.
 * - DIVERGENCE: upstream loads the credentials and refreshes the access token
 *   in the constructor, raising "No valid credentials provided." when
 *   Application Default Credentials are missing. Loading a key file, finding
 *   ADC and refreshing a token are asynchronous in JS, so they happen on first
 *   connect (google-auth-library refreshes tokens as they expire); inline
 *   `credentials` are still parsed in the constructor.
 * - Deprecated upstream APIs are not ported: the `model`, `voiceId` and
 *   `params` constructor arguments (use `settings`).
 * - The parent constructor calls `createClient()` before this class has
 *   stored its Vertex options (JS cannot set fields before `super()`), so the
 *   override skips that call and the client is created at the end of this
 *   constructor.
 */

import { GoogleGenAI, type GoogleGenAIOptions, type HttpOptions } from "@google/genai";
import { NotImplementedError } from "@pipedog/core/services/llm_service";
import { logger } from "@pipedog/core/utils/logger";
import { pyJsonLoads } from "@pipedog/core/utils/py_json";
import type { GeminiFileAPI } from "../file_api.ts";
import {
  GeminiLiveLLMService,
  type GeminiLiveLLMServiceOptions,
  GeminiLiveLLMSettings,
  type GeminiLiveLLMSettingsOptions,
  GeminiMediaResolution,
  GeminiModalities,
} from "../llm.ts";

/** google-auth-library options, as `GoogleGenAI` takes them. */
export type GoogleAuthOptions = NonNullable<GoogleGenAIOptions["googleAuthOptions"]>;

const CLOUD_PLATFORM_SCOPES = ["https://www.googleapis.com/auth/cloud-platform"];

export interface GeminiLiveVertexLLMSettingsOptions extends GeminiLiveLLMSettingsOptions {}

/** Settings for GeminiLiveVertexLLMService. */
export class GeminiLiveVertexLLMSettings extends GeminiLiveLLMSettings {
  constructor(options: GeminiLiveVertexLLMSettingsOptions = {}) {
    super(options);
    this._assignOptions(options);
  }
}

export interface GeminiLiveVertexLLMServiceOptions
  extends Omit<GeminiLiveLLMServiceOptions, "apiKey" | "settings"> {
  /** JSON string of service account credentials. */
  credentials?: string | null;
  /** Path to the service account JSON file. */
  credentialsPath?: string | null;
  /** GCP region for Vertex AI endpoint (e.g., "us-east4"). */
  location: string;
  /** Google Cloud project ID. */
  projectId: string;
  /** Gemini Live LLM settings. */
  settings?: GeminiLiveVertexLLMSettings | null;
}

/**
 * Provides access to Google's Gemini Live model via Vertex AI.
 *
 * This service enables real-time conversations with Gemini, supporting both
 * text and audio modalities. It handles voice transcription, streaming audio
 * responses, and tool usage.
 */
export class GeminiLiveVertexLLMService extends GeminiLiveLLMService {
  static override Settings = GeminiLiveVertexLLMSettings;
  declare protected _settings: GeminiLiveVertexLLMSettings;

  protected _credentials: GoogleAuthOptions;
  protected _projectId: string;
  protected _location: string;

  /**
   * Initialize the service for accessing Gemini Live via Google Vertex AI.
   *
   * @param options.credentials JSON string of service account credentials.
   * @param options.credentialsPath Path to the service account JSON file.
   * @param options.location GCP region for Vertex AI endpoint (e.g., "us-east4").
   * @param options.projectId Google Cloud project ID.
   * @param options.startAudioPaused Whether to start with audio input paused.
   *   Defaults to false.
   * @param options.startVideoPaused Whether to start with video input paused.
   *   Defaults to false.
   * @param options.systemInstruction System prompt for the model. Defaults to null.
   * @param options.tools Tools/functions available to the model. Defaults to null.
   * @param options.settings Gemini Live LLM settings.
   * @param options.inferenceOnContextInitialization Whether to generate a
   *   response when context is first set. Defaults to true.
   * @param options.fileApiBaseUrl Base URL for the Gemini File API. Defaults
   *   to the official endpoint.
   * @param options.httpOptions HTTP options for the client.
   *   Other options are passed to the parent GeminiLiveLLMService.
   */
  constructor(options: GeminiLiveVertexLLMServiceOptions) {
    // Check if user incorrectly passed apiKey, which is used by parent
    // class but not here.
    if ("apiKey" in options) {
      logger.error(
        "GeminiLiveVertexLLMService does not accept 'api_key' parameter. " +
          "Use 'credentials' or 'credentials_path' instead for Vertex AI authentication.",
      );
      throw new Error(
        "Invalid parameter 'api_key'. Use 'credentials' or 'credentials_path' for Vertex AI authentication.",
      );
    }

    const { credentials, credentialsPath, location, projectId, settings, ...rest } = options;

    // Upstream resolves these before calling the parent constructor, which
    // invokes createClient(); here they are stored right after it.
    const resolvedCredentials = GeminiLiveVertexLLMService._getCredentials(
      credentials ?? null,
      credentialsPath ?? null,
    );

    // 1. Initialize defaultSettings with hardcoded defaults
    const defaultSettings = new GeminiLiveVertexLLMSettings({
      model: "google/gemini-3.8-live",
      voice: "Charon",
      frequencyPenalty: null,
      maxTokens: 4096,
      presencePenalty: null,
      temperature: null,
      topK: null,
      topP: null,
      seed: null,
      filterIncompleteUserTurns: false,
      userTurnCompletionConfig: null,
      modalities: GeminiModalities.AUDIO,
      language: "en-US",
      mediaResolution: GeminiMediaResolution.UNSPECIFIED,
      vad: null,
      contextWindowCompression: {},
      thinking: {},
      enableAffectiveDialog: false,
      proactivity: {},
      extra: {},
    });

    // 2. Apply settings delta (canonical API, always wins)
    if (settings !== undefined && settings !== null) {
      defaultSettings.applyUpdate(settings);
    }

    // Call parent constructor with the obtained settings
    super({
      ...rest,
      // apiKey is required by parent class, but actually not used with
      // Vertex
      apiKey: "dummy",
      settings: defaultSettings,
    });

    this._credentials = resolvedCredentials;
    this._projectId = projectId;
    this._location = location;
    this.createClient();
  }

  /** Vertex AI does not support historyConfig. */
  protected override _getHistoryConfig(): null {
    return null;
  }

  /** Create the Gemini client instance. */
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

  /** Gemini File API is not supported with Vertex AI. */
  override get fileApi(): GeminiFileAPI {
    throw new NotImplementedError(
      "When using Vertex AI, the recommended approach is to use Google Cloud Storage for file handling. The Gemini File API is not directly supported in this context.",
    );
  }

  /**
   * Vertex AI's Gemini Live endpoint does not yet support NON_BLOCKING tool calls.
   *
   * Override the base `GeminiLiveLLMService` getter to disable the
   * NON_BLOCKING `behavior` field on function declarations and the
   * `scheduling` field on FunctionResponse for Vertex sessions —
   * sending either appears to break tool calling against Vertex.
   * Users hitting this on a function registered with
   * `cancelOnInterruption: false` will see the same one-time
   * warning the base class surfaces for unsupported models.
   */
  protected override get _supportsNonBlockingTools(): boolean {
    return false;
  }

  /**
   * Retrieve credentials using Google service account credentials JSON.
   *
   * Supports multiple authentication methods:
   * 1. Direct JSON credentials string
   * 2. Path to service account JSON file
   * 3. Default application credentials (ADC)
   *
   * @param credentials JSON string of service account credentials.
   * @param credentialsPath Path to the service account JSON file.
   * @returns google-auth-library options for the Vertex AI client. The file
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
