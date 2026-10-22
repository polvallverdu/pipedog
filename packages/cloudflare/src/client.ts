// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/**
 * One client for Workers AI, shared by every service in this package.
 *
 * Workers AI is reachable two ways, and every service works with both:
 *
 * - **The `AI` binding**, inside a Cloudflare Worker (`env.AI`). No token is
 *   needed: requests go through `ai.run(model, input, options)`, and the
 *   realtime models open a WebSocket with `ai.run(model, input, { websocket: true })`,
 *   whose `Response` carries the socket in `webSocket`.
 * - **The REST API**, anywhere (Bun, Node, Deno, or a Worker without the
 *   binding), with an account ID and an API token that has Workers AI access:
 *   `POST https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/run/{model}`,
 *   and `wss://` on the same URL for the realtime models, with the input
 *   parameters in the query string.
 *
 * `WorkersAIClient` hides the difference: `run()` returns the model's result,
 * `runRaw()` returns the raw `Response` (for audio output), and
 * `connectWebSocket()` returns a core `WebsocketClientConnection`.
 */

import { abortable, currentSignal } from "@pipedog/asyncio";
import {
  type WebsocketClientConnection,
  type WebsocketConnectOptions,
  websocketConnect,
} from "@pipedog/core/services/websocket_service";

/** Where Cloudflare's API is served. */
export const CLOUDFLARE_API_URL = "https://api.cloudflare.com/client/v4";

/**
 * The part of the Workers `Ai` binding this package uses.
 *
 * Declared structurally so the package does not depend on
 * `@cloudflare/workers-types`: pass `env.AI` as is.
 */
export interface WorkersAIBinding {
  // The binding's own signature is generic over models; `any` lets `env.AI` be passed as is.
  run(model: any, inputs: any, options?: any): Promise<unknown>;
}

/** Parameters of a WebSocket session: sent as the binding's input or the REST query string. */
export type WorkersAIWebSocketParams = Record<string, string | readonly string[]>;

export interface WorkersAIClientOptions {
  /** The Workers AI binding (`env.AI`), inside a Worker. Takes precedence over the credentials. */
  ai?: WorkersAIBinding | null;
  /** Cloudflare account ID, for the REST API. */
  accountId?: string | null;
  /** Cloudflare API token with Workers AI access, for the REST API. */
  apiToken?: string | null;
  /** Base URL of Cloudflare's API. Defaults to `CLOUDFLARE_API_URL`. */
  baseUrl?: string | null;
  /** `fetch` used for REST requests. Defaults to the global `fetch`. */
  fetch?: typeof fetch | null;
  /**
   * Creates the `WebSocket` for REST sessions, to open it some other way.
   * Defaults to `websocketConnect`'s, which sends the token header on Bun,
   * Node, Deno and Cloudflare Workers.
   */
  webSocketFactory?: WebsocketConnectOptions["webSocketFactory"];
}

/** Options every service in this package accepts to reach Workers AI. */
export interface WorkersAIConnectionOptions extends WorkersAIClientOptions {
  /** A client to share between services. When set, the other connection options are ignored. */
  client?: WorkersAIClient | null;
}

/**
 * Split a service's options into its client and the rest, so the connection
 * options don't reach a parent class that reads options of the same name
 * (`baseUrl`, `fetch`, `webSocketFactory`).
 */
export function splitConnectionOptions<T extends WorkersAIConnectionOptions>(
  options: T,
): [WorkersAIClient, Omit<T, keyof WorkersAIConnectionOptions>] {
  const { client, ai, accountId, apiToken, baseUrl, fetch, webSocketFactory, ...rest } = options;
  const resolved =
    client ?? new WorkersAIClient({ ai, accountId, apiToken, baseUrl, fetch, webSocketFactory });
  return [resolved, rest];
}

/**
 * A Workers AI request that failed.
 *
 * `status` carries the HTTP status (REST) so pipedog's error classification
 * can tell a rejected token (permanent) from a busy model (transient).
 */
export class WorkersAIError extends Error {
  override name = "WorkersAIError";
  readonly status: number | null;

  constructor(message: string, options: { status?: number | null; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.status = options.status ?? null;
  }
}

function isDict(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The reasons Cloudflare gave in an error envelope (`errors[].message`). */
async function describeFailure(response: Response): Promise<string> {
  const status = `HTTP ${response.status}`;
  let text = "";
  try {
    text = await response.text();
  } catch {
    return status;
  }
  try {
    const data: unknown = JSON.parse(text);
    if (isDict(data) && Array.isArray(data.errors)) {
      const reasons = data.errors
        .filter((e): e is Record<string, unknown> => isDict(e) && Boolean(e.message))
        .map((e) => String(e.message));
      if (reasons.length > 0) return `${status}: ${reasons.join("; ")}`;
    }
  } catch {
    // Not JSON: fall through to the raw body.
  }
  return text ? `${status}: ${text.slice(0, 500)}` : status;
}

/**
 * Client for Workers AI, over the `AI` binding or the REST API.
 *
 * @example
 * // Inside a Worker
 * const client = new WorkersAIClient({ ai: env.AI });
 * // Anywhere else
 * const client = new WorkersAIClient({ accountId, apiToken });
 */
export class WorkersAIClient {
  readonly ai: WorkersAIBinding | null;
  readonly accountId: string | null;
  readonly apiToken: string | null;
  readonly baseUrl: string;
  protected _fetch: typeof fetch;
  protected _webSocketFactory: WebsocketConnectOptions["webSocketFactory"];

  constructor(options: WorkersAIClientOptions) {
    this.ai = options.ai ?? null;
    this.accountId = options.accountId ?? null;
    this.apiToken = options.apiToken ?? null;
    this.baseUrl = (options.baseUrl ?? CLOUDFLARE_API_URL).replace(/\/+$/, "");
    this._fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this._webSocketFactory = options.webSocketFactory ?? null;
    if (!this.ai && !(this.accountId && this.apiToken)) {
      throw new Error(
        "Workers AI needs the AI binding (`ai: env.AI`) or an account ID and API token " +
          "(`accountId`, `apiToken`)",
      );
    }
  }

  /** Use the given client, or build one from the connection options. */
  static resolve(options: WorkersAIConnectionOptions): WorkersAIClient {
    return options.client ?? new WorkersAIClient(options);
  }

  /** `"binding"` when requests go through `env.AI`, `"rest"` when through the REST API. */
  get mode(): "binding" | "rest" {
    return this.ai ? "binding" : "rest";
  }

  /** The account's Workers AI REST base URL (`.../accounts/{id}/ai`). */
  get accountUrl(): string {
    if (!this.accountId) {
      throw new Error("Workers AI REST needs an account ID");
    }
    return `${this.baseUrl}/accounts/${this.accountId}/ai`;
  }

  /** The OpenAI-compatible base URL (`.../accounts/{id}/ai/v1`). REST only. */
  get openAIBaseUrl(): string {
    return `${this.accountUrl}/v1`;
  }

  /** The REST URL that runs `model`. */
  runUrl(model: string): string {
    return `${this.accountUrl}/run/${model}`;
  }

  protected _authHeaders(): Record<string, string> {
    return { Authorization: `Bearer ${this.apiToken}` };
  }

  /**
   * Run a model and return its result.
   *
   * Over the binding this is `ai.run(model, input)`; over REST it posts the
   * input as JSON and unwraps Cloudflare's `{ result }` envelope.
   *
   * @throws WorkersAIError If the request failed.
   */
  async run(model: string, input: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (this.ai) {
      const result = await abortable(this.ai.run(model, input));
      if (!isDict(result)) {
        throw new WorkersAIError(`Workers AI ${model} returned no result object`);
      }
      return result;
    }
    const response = await this._post(model, input);
    const data: unknown = await abortable(response.json());
    const result = isDict(data) ? data.result : null;
    if (!isDict(result)) {
      throw new WorkersAIError(`Workers AI ${model} reply has no result`);
    }
    return result;
  }

  /**
   * Run a model and return the raw `Response`, for models that answer with
   * audio. Over the binding this is `ai.run(model, input, { returnRawResponse: true })`.
   *
   * @throws WorkersAIError If the request failed.
   */
  async runRaw(model: string, input: Record<string, unknown>): Promise<Response> {
    if (this.ai) {
      const response = await abortable(this.ai.run(model, input, { returnRawResponse: true }));
      if (!(response instanceof Response)) {
        // Some binding versions ignore returnRawResponse for some models.
        return new Response(
          response instanceof ReadableStream ? response : JSON.stringify(response ?? null),
        );
      }
      if (!response.ok) {
        throw new WorkersAIError(`Workers AI ${model} failed: ${await describeFailure(response)}`, {
          status: response.status,
        });
      }
      return response;
    }
    return await this._post(model, input);
  }

  protected async _post(model: string, input: Record<string, unknown>): Promise<Response> {
    const url = this.runUrl(model);
    const response = await abortable(
      this._fetch(url, {
        method: "POST",
        headers: { ...this._authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify(input),
        signal: currentSignal(),
      }),
    );
    if (!response.ok) {
      throw new WorkersAIError(`Workers AI ${model} failed: ${await describeFailure(response)}`, {
        status: response.status,
      });
    }
    return response;
  }

  /**
   * Open a WebSocket session with a realtime model (Flux, Nova-3, Aura,
   * Smart Turn).
   *
   * Over the binding the session is `ai.run(model, params, { websocket: true })`,
   * whose socket is accepted and wrapped. Over REST the params go in the
   * query string of `wss://.../ai/run/{model}`, with the token as the
   * `Authorization` header of the handshake.
   *
   * @param model The model ID, e.g. `"@cf/deepgram/flux"`.
   * @param params The session parameters (strings, or lists for repeated keys).
   * @param options.openTimeout Seconds to wait for the socket to open.
   */
  async connectWebSocket(
    model: string,
    params: WorkersAIWebSocketParams,
    options: { openTimeout?: number | null } = {},
  ): Promise<WebsocketClientConnection> {
    if (this.ai) {
      const ai = this.ai;
      return await websocketConnect(`workers-ai:${model}`, {
        openTimeout: options.openTimeout,
        webSocketFactory: async () => {
          const response = (await ai.run(model, { ...params }, { websocket: true })) as {
            webSocket?: (WebSocket & { accept?: () => void }) | null;
            status?: number;
          } | null;
          const ws = response?.webSocket;
          if (!ws) {
            throw new WorkersAIError(
              `Workers AI ${model} did not return a WebSocket` +
                (response?.status ? ` (HTTP ${response.status})` : ""),
              { status: response?.status ?? null },
            );
          }
          // A socket from a Workers `fetch` must be accepted before use.
          ws.accept?.();
          return ws;
        },
      });
    }
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (Array.isArray(value)) {
        for (const item of value) query.append(key, String(item));
      } else {
        query.append(key, value as string);
      }
    }
    const qs = query.toString();
    const url = `${this.runUrl(model).replace(/^http(s?):/i, "ws$1:")}${qs ? `?${qs}` : ""}`;
    return await websocketConnect(url, {
      openTimeout: options.openTimeout,
      additionalHeaders: this._authHeaders(),
      webSocketFactory: this._webSocketFactory,
    });
  }
}
