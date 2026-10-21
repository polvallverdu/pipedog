// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/transports/livekit/utils.py

/**
 * LiveKit REST Helpers.
 *
 * Methods that wrap the LiveKit API for room management.
 *
 * The access token is signed with LiveKit's `livekit-server-sdk` (upstream:
 * PyJWT) and requests go through `fetch` (upstream: aiohttp). Neither loads the
 * native media SDK, so this module runs on every runtime.
 */

import { pyJsonDumps } from "@pipedog/core/utils/py_json";
import { AccessToken } from "livekit-server-sdk";

export interface LiveKitRESTHelperOptions {
  /** Your LiveKit API key. */
  apiKey: string;
  /** Your LiveKit API secret. */
  apiSecret: string;
  /** LiveKit server URL (e.g. "https://your-livekit-host.com"). */
  apiUrl?: string;
  /**
   * `fetch` used for HTTP requests. Defaults to the global `fetch`.
   *
   * DIVERGENCE: replaces upstream's required `aiohttp_session`.
   */
  fetch?: typeof fetch | null;
}

/**
 * Helper class for interacting with LiveKit's REST API.
 *
 * Provides methods for managing LiveKit rooms.
 */
export class LiveKitRESTHelper {
  apiKey: string;
  apiSecret: string;
  apiUrl: string;
  protected _fetch: typeof fetch;

  /**
   * Initialize the LiveKit REST helper.
   *
   * @param options.apiKey Your LiveKit API key.
   * @param options.apiSecret Your LiveKit API secret.
   * @param options.apiUrl LiveKit server URL (e.g. "https://your-livekit-host.com").
   * @param options.fetch `fetch` used for HTTP requests (upstream: an aiohttp session).
   */
  constructor(options: LiveKitRESTHelperOptions) {
    this.apiKey = options.apiKey;
    this.apiSecret = options.apiSecret;
    this.apiUrl = (options.apiUrl ?? "https://your-livekit-host.com").replace(/\/+$/, "");
    this._fetch =
      options.fetch ?? (((input, init) => globalThis.fetch(input, init)) as typeof fetch);
  }

  /**
   * Create a signed access token for LiveKit API authentication.
   *
   * DIVERGENCE: async, because `livekit-server-sdk` signs with WebCrypto.
   *
   * @param roomCreate Whether to grant roomCreate permission.
   * @returns Signed JWT access token.
   */
  async _createAccessToken(roomCreate = true): Promise<string> {
    // Token valid for 60 seconds
    const token = new AccessToken(this.apiKey, this.apiSecret, { ttl: 60 });
    token.addGrant({ roomCreate });
    return await token.toJwt();
  }

  /**
   * Delete a LiveKit room by name.
   *
   * This will forcibly disconnect all participants currently in the room.
   *
   * @param roomName Name of the room to delete.
   * @returns True if deletion was successful.
   * @throws Error If deletion fails.
   */
  async deleteRoomByName(roomName: string): Promise<boolean> {
    const token = await this._createAccessToken(true);
    const headers = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    };

    const r = await this._fetch(`${this.apiUrl}/twirp/livekit.RoomService/DeleteRoom`, {
      method: "POST",
      headers,
      body: pyJsonDumps({ room: roomName }),
    });
    if (r.status !== 200) {
      const text = await r.text();
      throw new Error(`Failed to delete room [${roomName}] (status: ${r.status}): ${text}`);
    }

    return true;
  }
}
