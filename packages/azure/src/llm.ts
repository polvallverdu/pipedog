// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/services/azure/llm.py

/**
 * Azure OpenAI service implementation for the Pipecat AI framework.
 *
 * Porting notes:
 * - The clients are the `openai` JS SDK's `OpenAI` (v1 surface) and
 *   `AzureOpenAI` (dated surface), which talk through `fetch` and run on
 *   every runtime.
 * - `createClient()` runs inside the parent constructor, before this class's
 *   fields exist (upstream sets them before calling `super().__init__`), so
 *   it reads the endpoint and token provider from the constructor options it
 *   is handed.
 * - Deprecated APIs are not ported: the `model` and `apiVersion` constructor
 *   options. Endpoints outside the v1 surface use `DATED_API_VERSION`.
 */

import { logger } from "@pipedog/core/utils/logger";
import {
  type OpenAIClientOptions,
  OpenAILLMSettings,
  setOpenAINotGiven,
} from "@pipedog/openai/base_llm";
import { OpenAILLMService, type OpenAILLMServiceOptions } from "@pipedog/openai/llm";
import OpenAI, { AzureOpenAI } from "openai";

import type { AzureTokenProvider } from "./common.ts";

/** Endpoint path suffix identifying Azure's v1 API surface. */
export const V1_ENDPOINT_PATH = "/openai/v1";

/**
 * Dated API version used for endpoints outside the v1 API surface.
 *
 * Azure stopped issuing dated versions after this one; the v1 surface tracks
 * new features in its place.
 */
export const DATED_API_VERSION = "2025-04-01-preview";

/** Settings for AzureLLMService. */
export class AzureLLMSettings extends OpenAILLMSettings {}

export interface AzureLLMServiceOptions extends OpenAILLMServiceOptions {
  /**
   * The Azure endpoint URL. Ending it in `/openai/v1` selects the v1 API
   * surface.
   */
  endpoint: string;
  /** Async callable supplying a Microsoft Entra ID bearer token, used instead of `apiKey`. */
  tokenProvider?: AzureTokenProvider | null;
  /** Runtime-updatable settings. */
  settings?: OpenAILLMSettings | null;
}

function trimTrailingSlashes(s: string): string {
  return s.replace(/\/+$/, "");
}

/**
 * A service for interacting with Azure OpenAI using the OpenAI-compatible
 * interface.
 *
 * This service extends OpenAILLMService to connect to Azure's OpenAI endpoint
 * while maintaining full compatibility with OpenAI's interface and
 * functionality.
 *
 * The shape of `endpoint` selects the API surface. An endpoint ending in
 * `/openai/v1` uses Azure's v1 API, which tracks new features without a dated
 * `api-version`; any other endpoint routes through a dated version of the
 * API. Both key-based and Microsoft Entra ID authentication work on either
 * surface.
 *
 * @example
 * ```ts
 * const service = new AzureLLMService({
 *   apiKey: process.env.AZURE_CHATGPT_API_KEY,
 *   endpoint: "https://my-resource.openai.azure.com/openai/v1",
 *   settings: new AzureLLMService.Settings({ model: "my-deployment" }),
 * });
 * ```
 */
export class AzureLLMService extends OpenAILLMService {
  static override Settings: typeof OpenAILLMSettings = AzureLLMSettings;

  protected _endpoint: string;
  protected _apiVersion: string;
  protected _tokenProvider: AzureTokenProvider | null;
  protected _useV1Api: boolean;

  /**
   * Initialize the Azure LLM service.
   *
   * @param options.endpoint The Azure endpoint URL. Ending it in `/openai/v1`
   *   selects the v1 API surface.
   * @param options.apiKey The API key for accessing Azure OpenAI. Required
   *   unless `tokenProvider` is given.
   * @param options.tokenProvider Async callable supplying a Microsoft Entra ID
   *   bearer token, used instead of `apiKey` when given. Build one with
   *   `getBearerTokenProvider()` from `@azure/identity` and the
   *   `https://ai.azure.com/.default` scope.
   * @param options.settings Runtime-updatable settings (model "gpt-4.1" by
   *   default; on Azure it names the deployment).
   *   Other options are passed to OpenAILLMService.
   * @throws Error If neither `apiKey` nor `tokenProvider` is given
   *   (upstream: ValueError).
   */
  constructor(options: AzureLLMServiceOptions) {
    const tokenProvider = options.tokenProvider ?? null;
    if ((options.apiKey === undefined || options.apiKey === null) && tokenProvider === null) {
      throw new Error("Either `api_key` or `token_provider` is required.");
    }

    const cls = new.target as typeof AzureLLMService;

    // 1. Initialize default_settings with hardcoded defaults
    const defaultSettings = new cls.Settings({ model: "gpt-4.1" });
    setOpenAINotGiven(defaultSettings);

    // 2. Apply settings delta (canonical API, always wins)
    if (options.settings !== undefined && options.settings !== null) {
      defaultSettings.applyUpdate(options.settings);
    }

    super({ ...options, settings: defaultSettings });
    this._endpoint = options.endpoint;
    this._apiVersion = DATED_API_VERSION;
    this._tokenProvider = tokenProvider;
    this._useV1Api = trimTrailingSlashes(options.endpoint).endsWith(V1_ENDPOINT_PATH);
  }

  /**
   * Create OpenAI-compatible client for Azure OpenAI endpoint.
   *
   * @param options The service's constructor options. `baseUrl` is ignored
   *   for the Azure implementation.
   * @returns Configured client for the API surface the endpoint selects.
   */
  override createClient(options: OpenAIClientOptions = {}): OpenAI {
    const { endpoint, tokenProvider } = options as Partial<AzureLLMServiceOptions>;
    if (endpoint === undefined) {
      // Only reached if a subclass calls this without the Azure options.
      throw new Error("AzureLLMService.createClient() needs the `endpoint` option.");
    }
    const apiKey = options.apiKey ?? undefined;
    const useV1Api = trimTrailingSlashes(endpoint).endsWith(V1_ENDPOINT_PATH);

    if (useV1Api) {
      logger.debug(`Creating Azure OpenAI v1 client with endpoint ${endpoint}`);
      // The v1 surface is reached with the plain OpenAI client: AzureOpenAI
      // appends its own `/openai` path segment, which the endpoint already carries.
      return new OpenAI({
        apiKey: tokenProvider ?? apiKey,
        baseURL: `${trimTrailingSlashes(endpoint)}/`,
      });
    }

    logger.debug(`Creating Azure OpenAI client with endpoint ${endpoint}`);
    // The JS client rejects an API key together with a token provider (and an
    // unset key falls back to AZURE_OPENAI_API_KEY), so with a token provider
    // the key is passed as null: the token provider wins, as it does upstream.
    return new AzureOpenAI({
      apiKey: tokenProvider ? (null as unknown as undefined) : apiKey,
      endpoint,
      apiVersion: DATED_API_VERSION,
      azureADTokenProvider: tokenProvider ?? undefined,
    });
  }
}
