// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Workers AI LLM service, over Workers AI's OpenAI-compatible endpoint
 * (`https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/v1/chat/completions`).
 *
 * The service is `OpenAILLMService` pointed at that endpoint, like the other
 * OpenAI-compatible providers: streaming, function calling and usage metrics
 * work as they do there.
 *
 * It needs an account ID and an API token, also inside a Worker: the `AI`
 * binding answers in Workers AI's own format rather than OpenAI's, so it is
 * not used for chat completions. A Worker reaches the REST endpoint with
 * `fetch` like any other API.
 */

import { logger } from "@pipedog/core/utils/logger";
import {
  type OpenAIClientOptions,
  OpenAILLMSettings,
  type OpenAILLMSettingsOptions,
} from "@pipedog/openai/base_llm";
import { OpenAILLMService, type OpenAILLMServiceOptions } from "@pipedog/openai/llm";
import { CLOUDFLARE_API_URL, type WorkersAIClient } from "./client.ts";

/** The default chat model: fast, with function calling. */
export const DEFAULT_WORKERS_AI_LLM_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

/** Settings for `WorkersAILLMService` (OpenAI's; `model` is a Workers AI model ID). */
export class WorkersAILLMSettings extends OpenAILLMSettings {
  constructor(options: OpenAILLMSettingsOptions = {}) {
    super(options);
  }
}

export interface WorkersAILLMServiceOptions extends Omit<OpenAILLMServiceOptions, "apiKey"> {
  /** Cloudflare account ID. Required unless `client` has one. */
  accountId?: string | null;
  /** Cloudflare API token with Workers AI access. Required unless `client` has one. */
  apiToken?: string | null;
  /** A REST `WorkersAIClient` to take the account ID, token and base URL from. */
  client?: WorkersAIClient | null;
  /**
   * The full OpenAI-compatible base URL. Defaults to
   * `https://api.cloudflare.com/client/v4/accounts/{accountId}/ai/v1`; set it
   * to go through an AI Gateway, for instance.
   */
  baseUrl?: string | null;
  /** Runtime-updatable settings; values override the built-in defaults. */
  settings?: OpenAILLMSettings | null;
}

/**
 * Chat completions from Workers AI models, through the OpenAI-compatible API.
 *
 * @example
 * const llm = new WorkersAILLMService({
 *   accountId: env.CLOUDFLARE_ACCOUNT_ID,
 *   apiToken: env.CLOUDFLARE_API_TOKEN,
 *   settings: new WorkersAILLMService.Settings({
 *     systemInstruction: "You are a helpful voice assistant.",
 *   }),
 * });
 */
export class WorkersAILLMService extends OpenAILLMService {
  static override Settings: typeof WorkersAILLMSettings = WorkersAILLMSettings;
  declare protected _settings: WorkersAILLMSettings;
  static override _requiresApiKey = true;

  constructor(options: WorkersAILLMServiceOptions) {
    const cls = new.target as typeof WorkersAILLMService;
    const client = options.client ?? null;
    if (client && client.mode === "binding" && !options.apiToken) {
      throw new Error(
        "WorkersAILLMService uses the REST API: pass `accountId` and `apiToken` " +
          "(the AI binding does not speak the OpenAI chat format)",
      );
    }
    const accountId = options.accountId ?? client?.accountId ?? null;
    const apiToken = options.apiToken ?? client?.apiToken ?? null;
    let baseUrl = options.baseUrl ?? null;
    if (!baseUrl) {
      if (!accountId) {
        throw new Error("WorkersAILLMService needs a Cloudflare `accountId` (or a `baseUrl`)");
      }
      const apiUrl = client?.baseUrl ?? CLOUDFLARE_API_URL;
      baseUrl = `${apiUrl}/accounts/${accountId}/ai/v1`;
    }

    const defaultSettings = new cls.Settings({ model: DEFAULT_WORKERS_AI_LLM_MODEL });
    if (options.settings !== undefined && options.settings !== null) {
      defaultSettings.applyUpdate(options.settings);
    }

    super({ ...options, apiKey: apiToken ?? "", baseUrl, settings: defaultSettings });
  }

  /** Create the OpenAI client for Workers AI's endpoint. */
  override createClient(
    options: OpenAIClientOptions = {},
  ): ReturnType<OpenAILLMService["createClient"]> {
    logger.debug(`Creating Workers AI client with api ${options.baseUrl}`);
    return super.createClient(options);
  }
}
