// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/services/azure/realtime/llm.py

/**
 * Azure OpenAI Realtime LLM service implementation.
 *
 * Porting note: the websocket is `websocketConnect()` from core, which sends
 * the `api-key` / `Authorization` header on Bun, Node, Deno and Cloudflare
 * Workers.
 */

import { rethrowIfCancelled } from "@pipedog/asyncio";
import { websocketConnect } from "@pipedog/core/services/websocket_service";
import { logger } from "@pipedog/core/utils/logger";
import {
  OpenAIRealtimeLLMService,
  type OpenAIRealtimeLLMServiceOptions,
  OpenAIRealtimeLLMSettings,
} from "@pipedog/openai/realtime/llm";

import type { AzureTokenProvider } from "../common.ts";

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Settings for AzureRealtimeLLMService. */
export class AzureRealtimeLLMSettings extends OpenAIRealtimeLLMSettings {}

export interface AzureRealtimeLLMServiceOptions
  extends Omit<OpenAIRealtimeLLMServiceOptions, "apiKey" | "baseUrl"> {
  /**
   * The Azure Realtime WebSocket endpoint URL, on Azure's v1 API surface. The
   * deployment is appended as `?model=<Settings.model>`, so `Settings.model`
   * must name the deployment:
   *
   *     wss://my-resource.openai.azure.com/openai/v1/realtime
   *
   * A URL that already carries a query string is used verbatim, leaving the
   * deployment for the caller to name.
   */
  baseUrl: string;
  /** The API key for the Azure OpenAI service. Required unless `tokenProvider` is given. */
  apiKey?: string | null;
  /** Async callable supplying a Microsoft Entra ID bearer token, used instead of `apiKey`. */
  tokenProvider?: AzureTokenProvider | null;
  /** Runtime-updatable settings for this service. */
  settings?: AzureRealtimeLLMSettings | null;
}

/**
 * Azure OpenAI Realtime LLM service with Azure-specific authentication.
 *
 * Extends the OpenAI Realtime service to work with Azure OpenAI endpoints,
 * using Azure's authentication headers and endpoint format. Provides the same
 * real-time audio and text communication capabilities as the base OpenAI
 * service.
 *
 * Reaches Azure over its v1 API surface, whose realtime protocol is the one
 * the base service speaks. Endpoints carrying a dated `api-version` serve the
 * superseded preview protocol, which rejects the session configuration and
 * names its events differently, so they aren't usable here.
 *
 * Supports both key-based and Microsoft Entra ID authentication.
 *
 * @example
 * ```ts
 * const service = new AzureRealtimeLLMService({
 *   apiKey: process.env.AZURE_REALTIME_API_KEY,
 *   baseUrl: "wss://my-resource.openai.azure.com/openai/v1/realtime",
 *   settings: new AzureRealtimeLLMService.Settings({ model: "my-deployment" }),
 * });
 * ```
 */
export class AzureRealtimeLLMService extends OpenAIRealtimeLLMService {
  static override Settings = AzureRealtimeLLMSettings;
  declare protected _settings: AzureRealtimeLLMSettings;

  protected _tokenProvider: AzureTokenProvider | null;

  /**
   * Initialize Azure Realtime LLM service.
   *
   * @param options.baseUrl The Azure Realtime WebSocket endpoint URL, on
   *   Azure's v1 API surface.
   * @param options.apiKey The API key for the Azure OpenAI service. Required
   *   unless `tokenProvider` is given.
   * @param options.tokenProvider Async callable supplying a Microsoft Entra ID
   *   bearer token, used instead of `apiKey` when given. Build one with
   *   `getBearerTokenProvider()` from `@azure/identity` and the
   *   `https://ai.azure.com/.default` scope.
   *   Other options are passed to parent OpenAIRealtimeLLMService.
   * @throws Error If neither `apiKey` nor `tokenProvider` is given
   *   (upstream: ValueError).
   */
  constructor(options: AzureRealtimeLLMServiceOptions) {
    const tokenProvider = options.tokenProvider ?? null;
    if ((options.apiKey === undefined || options.apiKey === null) && tokenProvider === null) {
      throw new Error("Either `api_key` or `token_provider` is required.");
    }

    super({ ...options, baseUrl: options.baseUrl, apiKey: options.apiKey || "" });
    this._tokenProvider = tokenProvider;

    // A caller-supplied query string already names a deployment, so keep the URL
    // as given rather than letting the base class append a second `?model=`.
    if (options.baseUrl.includes("?")) {
      this.baseUrl = options.baseUrl;
    }

    // The preview surface rejects the session configuration and names its events
    // differently, so it fails partway through a connection that opens cleanly.
    // Say so up front, where the URL that caused it is still in view.
    if (options.baseUrl.includes("api-version=")) {
      logger.warning(
        `${this}: \`base_url\` selects Azure's preview realtime API, whose protocol ` +
          "this service doesn't implement. Use an `/openai/v1/realtime` URL instead.",
      );
    }
  }

  protected override async _connect(): Promise<void> {
    try {
      if (this._websocket) {
        // Here we assume that if we have a websocket, we are connected. We
        // handle disconnections in the send/recv code paths.
        return;
      }

      let headers: Record<string, string>;
      if (this._tokenProvider) {
        headers = { Authorization: `Bearer ${await this._tokenProvider()}` };
      } else {
        headers = { "api-key": this.apiKey };
      }

      logger.info(`Connecting to ${this.baseUrl}`);
      this._websocket = await websocketConnect(this.baseUrl, {
        additionalHeaders: headers,
      });
      this._receiveTask = this.createTask(
        () => this._receiveTaskHandler(),
        "_receive_task_handler",
      );
    } catch (e) {
      rethrowIfCancelled(e);
      await this.pushError(`initialization error: ${errorMessage(e)}`, { exception: e });
      this._websocket = null;
    }
  }
}
