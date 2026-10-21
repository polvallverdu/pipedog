// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Cloudflare Workers stand-in for `connection.ts`: there is no WebRTC on Workers (werift
 * needs UDP sockets), so answering a call fails with a clear error. Webhook verification,
 * signature checks and the API calls work.
 */

import type { IceServer, SmallWebRTCConnection } from "@pipedog/transport-smallwebrtc/connection";

export function createSmallWebRTCConnection(
  _iceServers: string[] | IceServer[],
): SmallWebRTCConnection {
  throw new Error(
    "Answering a WhatsApp call needs WebRTC (SmallWebRTC on werift), which Cloudflare Workers do not have: run the call on Node, Bun or Deno, or pass `createConnection`.",
  );
}
