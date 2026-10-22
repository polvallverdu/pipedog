// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/**
 * The Cloudflare Realtime SFU HTTPS API (`https://rtc.live.cloudflare.com/v1`), and
 * `CloudflareRealtimeCall`, which runs the calls a voice bot needs in order.
 *
 * Every request carries the app secret, so this runs on your backend (a Worker, a Durable
 * Object, a server), never in a browser. It uses only `fetch`, so it runs on Bun, Node, Deno
 * and Cloudflare Workers.
 *
 * The flow for one user talking to one bot (see `CloudflareRealtimeCall`):
 *
 * 1. The browser publishes its microphone: it sends an SDP offer, the backend creates a session
 *    and publishes the track (`publishUser`), and the browser applies the answer.
 * 2. Once the browser is connected, the backend creates two WebSocket adapters (`attachBot`).
 *    The SFU dials both of your endpoints: one streams the user's microphone to the bot as PCM,
 *    the other takes the bot's PCM and publishes it as a new WebRTC track.
 * 3. The backend subscribes the browser's session to the bot's track (`subscribeUser`), the
 *    browser answers the SFU's offer, and the backend submits that answer (`renegotiate`).
 * 4. At the end, `close()` closes the adapters and the browser's tracks.
 */

import { rethrowIfCancelled, waitFor } from "@pipedog/asyncio";

/** The Realtime SFU API base URL. */
export const DEFAULT_API_BASE_URL = "https://rtc.live.cloudflare.com/v1";

/** An SDP offer or answer. */
export interface SessionDescription {
  type: "offer" | "answer";
  sdp: string;
}

/** A track to publish (`local`) or subscribe to (`remote`). */
export interface TrackObject {
  location: "local" | "remote";
  /** The transceiver's mid in this session's SDP. */
  mid?: string;
  /** The publisher's session, for a remote track. */
  sessionId?: string;
  trackName?: string;
  bidirectionalMediaStream?: boolean;
  kind?: string;
}

/** A per-item result: the request item plus an error, if this item failed. */
export interface ItemError {
  errorCode?: string;
  errorDescription?: string;
}

/** The result of `sessions/new`. */
export interface NewSessionResponse extends ItemError {
  sessionId: string;
  sessionDescription?: SessionDescription;
}

/** The result of `tracks/new`, `tracks/close` and `renegotiate`. */
export interface TracksResponse extends ItemError {
  requiresImmediateRenegotiation?: boolean;
  sessionDescription?: SessionDescription;
  tracks?: (TrackObject & ItemError)[];
}

/** A WebSocket adapter to create. */
export type WebSocketAdapterRequest =
  | {
      /** Audio into the SFU: your endpoint sends PCM, the SFU publishes it as a new track. */
      location: "local";
      trackName: string;
      endpoint: string;
      inputCodec: "pcm";
    }
  | {
      /** Media out of the SFU: the SFU streams an existing publication to your endpoint. */
      location: "remote";
      sessionId: string;
      trackName: string;
      endpoint: string;
      outputCodec: "pcm" | "jpeg";
    };

/** One adapter's result from `adapters/websocket/new` or `/close`. */
export interface WebSocketAdapterResult extends ItemError {
  trackName?: string;
  adapterId?: string;
  /** For a `local` adapter: the session that publishes its track. */
  sessionId?: string;
  endpoint?: string;
  bytesProcessed?: number;
}

/** The result of `adapters/websocket/new` and `/close`. */
export interface WebSocketAdaptersResponse extends ItemError {
  tracks?: WebSocketAdapterResult[];
}

/** A failed API request. */
export class CloudflareRealtimeError extends Error {
  override name = "CloudflareRealtimeError";
  /** The HTTP status, or 0 if the request didn't complete. */
  readonly status: number;
  /** The API's error code, if it sent one. */
  readonly errorCode: string | null;
  /** The response body, if it was JSON. It never contains the app secret. */
  readonly body: unknown;

  constructor(message: string, status: number, errorCode: string | null, body: unknown) {
    super(message);
    this.status = status;
    this.errorCode = errorCode;
    this.body = body;
  }
}

/** The `fetch` the API client calls. */
export type FetchFn = (input: string, init: RequestInit) => Promise<Response>;

export interface CloudflareRealtimeAPIOptions {
  /** The Realtime SFU app ID. */
  appId: string;
  /** The app secret (the API token shown with the app). Keep it on the backend. */
  appSecret: string;
  /** The API base URL. Defaults to `https://rtc.live.cloudflare.com/v1`. */
  baseUrl?: string;
  /** The `fetch` to use. Defaults to the global `fetch`. */
  fetch?: FetchFn;
  /** Seconds before a request times out. Defaults to 15. */
  timeout?: number;
}

/**
 * A client for the Realtime SFU HTTPS API: sessions, tracks and WebSocket adapters.
 *
 * Batch operations can partly succeed: an HTTP 200 (or a 503 when every item failed) carries a
 * result per item, and those are returned as they are, for the caller to inspect. Other HTTP
 * errors, and responses without item results, throw `CloudflareRealtimeError`.
 */
export class CloudflareRealtimeAPI {
  readonly appId: string;
  readonly baseUrl: string;
  readonly #appSecret: string;
  readonly #fetch: FetchFn;
  readonly #timeout: number;

  constructor(options: CloudflareRealtimeAPIOptions) {
    if (!options.appId) throw new Error("CloudflareRealtimeAPI: appId is required");
    if (!options.appSecret) throw new Error("CloudflareRealtimeAPI: appSecret is required");
    this.appId = options.appId;
    this.#appSecret = options.appSecret;
    this.baseUrl = (options.baseUrl ?? DEFAULT_API_BASE_URL).replace(/\/+$/, "");
    // Workers' fetch must be called with the global object as `this`.
    this.#fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.#timeout = options.timeout ?? 15;
  }

  /**
   * Send one request to `/apps/{appId}{path}`.
   *
   * @param method The HTTP method.
   * @param path The path under the app, starting with `/`.
   * @param body The JSON body, if any.
   * @param itemsKey A response key holding per-item results: when present, a non-2xx response
   *   is returned instead of thrown, so partial results are not lost.
   */
  async request<T>(
    method: string,
    path: string,
    body?: unknown,
    itemsKey: string | null = null,
  ): Promise<T> {
    const url = `${this.baseUrl}/apps/${encodeURIComponent(this.appId)}${path}`;
    const init: RequestInit = {
      method,
      headers: {
        Authorization: `Bearer ${this.#appSecret}`,
        "Content-Type": "application/json",
      },
    };
    if (body !== undefined) init.body = JSON.stringify(body);
    let response: Response;
    try {
      response = await waitFor(this.#fetch(url, init), this.#timeout);
    } catch (e) {
      rethrowIfCancelled(e);
      throw new CloudflareRealtimeError(
        `${method} ${path} failed: ${e instanceof Error ? e.message : String(e)}`,
        0,
        null,
        null,
      );
    }
    const text = await response.text();
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    const record = (data && typeof data === "object" ? data : {}) as Record<string, unknown>;
    const errorCode = typeof record.errorCode === "string" ? record.errorCode : null;
    const hasItems = itemsKey !== null && Array.isArray(record[itemsKey]);
    if (!response.ok && !hasItems) {
      const description =
        typeof record.errorDescription === "string" ? `: ${record.errorDescription}` : "";
      throw new CloudflareRealtimeError(
        `${method} ${path} failed with HTTP ${response.status}${errorCode ? ` (${errorCode})` : ""}${description}`,
        response.status,
        errorCode,
        data,
      );
    }
    if (data === null || typeof data !== "object") {
      throw new CloudflareRealtimeError(
        `${method} ${path} returned no JSON body (HTTP ${response.status})`,
        response.status,
        null,
        null,
      );
    }
    return data as T;
  }

  /**
   * Create a session: one WebRTC PeerConnection's worth of tracks.
   *
   * @param options.sessionDescription An offer to negotiate right away (optional).
   * @param options.correlationId A diagnostic label (not an idempotency key).
   */
  async createSession(
    options: { sessionDescription?: SessionDescription; correlationId?: string } = {},
  ): Promise<NewSessionResponse> {
    const query = options.correlationId
      ? `?correlationId=${encodeURIComponent(options.correlationId)}`
      : "";
    const body = options.sessionDescription
      ? { sessionDescription: options.sessionDescription }
      : undefined;
    const result = await this.request<NewSessionResponse>("POST", `/sessions/new${query}`, body);
    if (typeof result.sessionId !== "string") {
      throw new CloudflareRealtimeError(
        "POST /sessions/new returned no sessionId",
        200,
        result.errorCode ?? null,
        result,
      );
    }
    return result;
  }

  /**
   * Publish (`local`) or subscribe to (`remote`) tracks on a session.
   *
   * @param sessionId The session.
   * @param request The tracks, and the endpoint's offer when publishing.
   */
  async newTracks(
    sessionId: string,
    request: { tracks: TrackObject[]; sessionDescription?: SessionDescription },
  ): Promise<TracksResponse> {
    return this.request<TracksResponse>(
      "POST",
      `/sessions/${encodeURIComponent(sessionId)}/tracks/new`,
      request,
      "tracks",
    );
  }

  /**
   * Submit the endpoint's answer to an offer the SFU made.
   *
   * @param sessionId The session.
   * @param sessionDescription The endpoint's answer.
   */
  async renegotiate(
    sessionId: string,
    sessionDescription: SessionDescription,
  ): Promise<TracksResponse> {
    return this.request<TracksResponse>(
      "PUT",
      `/sessions/${encodeURIComponent(sessionId)}/renegotiate`,
      { sessionDescription },
    );
  }

  /**
   * Close tracks on a session.
   *
   * @param sessionId The session.
   * @param mids The transceivers to close.
   * @param options.force Stop forwarding without an SDP exchange (the default here).
   * @param options.sessionDescription The endpoint's offer, for a negotiated close.
   */
  async closeTracks(
    sessionId: string,
    mids: string[],
    options: { force?: boolean; sessionDescription?: SessionDescription } = {},
  ): Promise<TracksResponse> {
    const body: Record<string, unknown> = {
      tracks: mids.map((mid) => ({ mid })),
      force: options.force ?? !options.sessionDescription,
    };
    if (options.sessionDescription) body.sessionDescription = options.sessionDescription;
    return this.request<TracksResponse>(
      "PUT",
      `/sessions/${encodeURIComponent(sessionId)}/tracks/close`,
      body,
      "tracks",
    );
  }

  /** Read a session's tracks and DataChannels. */
  async getSession(sessionId: string): Promise<TracksResponse & { dataChannels?: unknown[] }> {
    return this.request("GET", `/sessions/${encodeURIComponent(sessionId)}`);
  }

  /**
   * Create one to four WebSocket adapters. The SFU dials each endpoint before answering, so the
   * endpoints must already accept WebSocket upgrades.
   */
  async createWebSocketAdapters(
    tracks: WebSocketAdapterRequest[],
  ): Promise<WebSocketAdaptersResponse> {
    return this.request<WebSocketAdaptersResponse>(
      "POST",
      "/adapters/websocket/new",
      { tracks },
      "tracks",
    );
  }

  /** Close one to four WebSocket adapters. Closing is idempotent. */
  async closeWebSocketAdapters(adapterIds: string[]): Promise<WebSocketAdaptersResponse> {
    return this.request<WebSocketAdaptersResponse>(
      "POST",
      "/adapters/websocket/close",
      { tracks: adapterIds.map((adapterId) => ({ adapterId })) },
      "tracks",
    );
  }
}

/**
 * What a `CloudflareRealtimeCall` has allocated. Plain JSON: keep it in Durable Object storage
 * to clean up after a restart (`new CloudflareRealtimeCall(api, { state })`).
 */
export interface CloudflareRealtimeCallState {
  /** The user's session (their PeerConnection). */
  userSessionId: string | null;
  /** Transceiver mids open on the user's session. */
  userMids: string[];
  /** The user's microphone track name. */
  userTrackName: string;
  /** The session that publishes the bot's track (allocated by the ingest adapter). */
  botSessionId: string | null;
  /** The bot's track name. */
  botTrackName: string;
  /** Adapters to close. */
  adapterIds: string[];
}

export interface CloudflareRealtimeCallOptions {
  /** A state saved earlier, to resume or clean up. */
  state?: CloudflareRealtimeCallState | null;
  /** The user's microphone track name. Defaults to `user-<random>`. */
  userTrackName?: string;
  /** The bot's track name. Defaults to `bot-<random>`. */
  botTrackName?: string;
}

/** Where the SFU dials, for `attachBot`. */
export interface BotEndpoints {
  /**
   * The bot's input endpoint (`wss://`): the SFU streams the user's microphone here. Serve it
   * with `CloudflareRealtimeTransport.acceptSocket("input", request)`.
   */
  input: string;
  /**
   * The bot's output endpoint (`wss://`): the SFU takes the bot's audio from here. Serve it with
   * `CloudflareRealtimeTransport.acceptSocket("output", request)`.
   */
  output: string;
}

function itemsFailed(items: ItemError[] | undefined): string | null {
  const failed = (items ?? []).find((t) => t.errorCode);
  return failed
    ? `${failed.errorCode}${failed.errorDescription ? `: ${failed.errorDescription}` : ""}`
    : null;
}

function randomName(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

/**
 * The SFU calls for one user talking to one bot, in order, keeping track of what was allocated
 * so `close()` can release it. See the module docs for the flow.
 *
 * Each step sends a request whose answer depends on the previous one: call them one at a time
 * (the Realtime API requires a session's SDP exchange to finish before its next change).
 */
export class CloudflareRealtimeCall {
  readonly api: CloudflareRealtimeAPI;
  #state: CloudflareRealtimeCallState;

  constructor(api: CloudflareRealtimeAPI, options: CloudflareRealtimeCallOptions = {}) {
    this.api = api;
    this.#state = options.state
      ? {
          ...options.state,
          userMids: [...options.state.userMids],
          adapterIds: [...options.state.adapterIds],
        }
      : {
          userSessionId: null,
          userMids: [],
          userTrackName: options.userTrackName ?? randomName("user"),
          botSessionId: null,
          botTrackName: options.botTrackName ?? randomName("bot"),
          adapterIds: [],
        };
  }

  /** A copy of what the call has allocated. */
  get state(): CloudflareRealtimeCallState {
    return {
      ...this.#state,
      userMids: [...this.#state.userMids],
      adapterIds: [...this.#state.adapterIds],
    };
  }

  /** The user's session, once `publishUser` created it. */
  get userSessionId(): string | null {
    return this.#state.userSessionId;
  }

  #recordMids(response: TracksResponse): void {
    for (const track of response.tracks ?? []) {
      if (track.mid !== undefined && track.mid !== null) {
        const mid = String(track.mid);
        if (!this.#state.userMids.includes(mid)) this.#state.userMids.push(mid);
      }
    }
  }

  /**
   * Step 1: create the user's session and publish their microphone.
   *
   * @param offer The browser's offer (`pc.localDescription` after ICE gathering).
   * @param mid The microphone transceiver's mid.
   * @returns The user's session ID and the SFU's answer, for `pc.setRemoteDescription()`.
   */
  async publishUser(
    offer: SessionDescription,
    mid: string,
  ): Promise<{ sessionId: string; sessionDescription: SessionDescription }> {
    if (offer?.type !== "offer" || typeof offer.sdp !== "string") {
      throw new Error("publishUser: expected an SDP offer");
    }
    if (this.#state.userSessionId) throw new Error("publishUser: the user already published");
    const session = await this.api.createSession();
    this.#state.userSessionId = session.sessionId;
    const result = await this.api.newTracks(session.sessionId, {
      sessionDescription: offer,
      tracks: [{ location: "local", mid, trackName: this.#state.userTrackName }],
    });
    this.#recordMids(result);
    const failed = result.errorCode ?? itemsFailed(result.tracks);
    if (failed || !result.sessionDescription) {
      throw new CloudflareRealtimeError(
        `publishing the user's track failed: ${failed ?? "no answer"}`,
        200,
        result.errorCode ?? null,
        result,
      );
    }
    return { sessionId: session.sessionId, sessionDescription: result.sessionDescription };
  }

  /**
   * Step 2: create the two adapters. The SFU dials both endpoints during this call, so the
   * transport must be ready to accept them (it can be created before the pipeline starts).
   * Call it once the browser's PeerConnection is connected.
   *
   * @param endpoints The bot's input and output WebSocket URLs.
   * @returns The bot's track: its publishing session and name.
   */
  async attachBot(endpoints: BotEndpoints): Promise<{ sessionId: string; trackName: string }> {
    const userSessionId = this.#state.userSessionId;
    if (!userSessionId) throw new Error("attachBot: call publishUser first");
    const result = await this.api.createWebSocketAdapters([
      {
        location: "local",
        trackName: this.#state.botTrackName,
        endpoint: endpoints.output,
        inputCodec: "pcm",
      },
      {
        location: "remote",
        sessionId: userSessionId,
        trackName: this.#state.userTrackName,
        endpoint: endpoints.input,
        outputCodec: "pcm",
      },
    ]);
    // Either adapter can be allocated before the other fails: keep every ID for close().
    for (const item of result.tracks ?? []) {
      if (item.adapterId && !this.#state.adapterIds.includes(item.adapterId)) {
        this.#state.adapterIds.push(item.adapterId);
      }
    }
    const output = (result.tracks ?? []).find((t) => t.trackName === this.#state.botTrackName);
    const failed = result.errorCode ?? itemsFailed(result.tracks);
    if (failed || (result.tracks ?? []).length !== 2 || !output?.sessionId) {
      throw new CloudflareRealtimeError(
        `creating the WebSocket adapters failed: ${failed ?? "incomplete result"}`,
        200,
        result.errorCode ?? null,
        result,
      );
    }
    this.#state.botSessionId = output.sessionId;
    return { sessionId: output.sessionId, trackName: this.#state.botTrackName };
  }

  /**
   * Step 3: subscribe the user's session to the bot's track.
   *
   * @returns The SFU's offer: apply it with `pc.setRemoteDescription()`, create an answer and
   *   pass it to `renegotiate`.
   */
  async subscribeUser(): Promise<{
    sessionDescription: SessionDescription;
    requiresImmediateRenegotiation: boolean;
  }> {
    const userSessionId = this.#state.userSessionId;
    const botSessionId = this.#state.botSessionId;
    if (!userSessionId || !botSessionId) throw new Error("subscribeUser: call attachBot first");
    const result = await this.api.newTracks(userSessionId, {
      tracks: [
        { location: "remote", sessionId: botSessionId, trackName: this.#state.botTrackName },
      ],
    });
    this.#recordMids(result);
    const failed = result.errorCode ?? itemsFailed(result.tracks);
    if (failed || !result.sessionDescription) {
      throw new CloudflareRealtimeError(
        `subscribing to the bot's track failed: ${failed ?? "no offer"}`,
        200,
        result.errorCode ?? null,
        result,
      );
    }
    return {
      sessionDescription: result.sessionDescription,
      requiresImmediateRenegotiation: result.requiresImmediateRenegotiation ?? false,
    };
  }

  /** Steps 2 and 3 together: attach the bot, then subscribe the user to it. */
  async connectBot(endpoints: BotEndpoints): Promise<{
    sessionDescription: SessionDescription;
    requiresImmediateRenegotiation: boolean;
  }> {
    await this.attachBot(endpoints);
    return this.subscribeUser();
  }

  /**
   * Step 4: submit the browser's answer to the subscription offer.
   *
   * @param answer The browser's answer (`pc.localDescription`).
   */
  async renegotiate(answer: SessionDescription): Promise<void> {
    const userSessionId = this.#state.userSessionId;
    if (!userSessionId) throw new Error("renegotiate: call publishUser first");
    if (answer?.type !== "answer" || typeof answer.sdp !== "string") {
      throw new Error("renegotiate: expected an SDP answer");
    }
    const result = await this.api.renegotiate(userSessionId, answer);
    if (result.errorCode) {
      throw new CloudflareRealtimeError(
        `renegotiation failed: ${result.errorCode}`,
        200,
        result.errorCode,
        result,
      );
    }
  }

  /**
   * Close the adapters and force-close the user's tracks. What fails stays in `state`, so you
   * can retry later (e.g. from a Durable Object alarm).
   *
   * @returns Whether everything was released.
   */
  async close(): Promise<boolean> {
    if (this.#state.adapterIds.length > 0) {
      try {
        const ids = [...this.#state.adapterIds];
        const closed = new Set<string>();
        for (let i = 0; i < ids.length; i += 4) {
          const result = await this.api.closeWebSocketAdapters(ids.slice(i, i + 4));
          for (const item of result.tracks ?? []) {
            if (item.adapterId && !item.errorCode) closed.add(item.adapterId);
          }
        }
        this.#state.adapterIds = this.#state.adapterIds.filter((id) => !closed.has(id));
      } catch (e) {
        rethrowIfCancelled(e);
      }
    }
    const userSessionId = this.#state.userSessionId;
    if (userSessionId && this.#state.userMids.length > 0) {
      try {
        const result = await this.api.closeTracks(userSessionId, this.#state.userMids, {
          force: true,
        });
        // close_track_error: the track is already gone.
        const closed = new Set(
          (result.tracks ?? [])
            .filter((t) => !t.errorCode || t.errorCode === "close_track_error")
            .map((t) => String(t.mid)),
        );
        this.#state.userMids = this.#state.userMids.filter((mid) => !closed.has(mid));
      } catch (e) {
        rethrowIfCancelled(e);
        // 410: the session is gone; 425: it never connected. Neither can be closed again.
        if (e instanceof CloudflareRealtimeError && (e.status === 410 || e.status === 425)) {
          this.#state.userMids = [];
        }
      }
    }
    return this.#state.adapterIds.length === 0 && this.#state.userMids.length === 0;
  }
}
