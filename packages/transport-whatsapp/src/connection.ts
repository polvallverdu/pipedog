// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/**
 * The default WebRTC connection for a call: a `SmallWebRTCConnection` (werift).
 *
 * Kept in its own module, reached through the package's `./connection` export, so that
 * Cloudflare Workers builds (the "workerd" condition resolves to `connection.workerd.ts`)
 * never pull in werift, which needs UDP sockets.
 */

import { type IceServer, SmallWebRTCConnection } from "@pipedog/transport-smallwebrtc/connection";

/** Create the connection for one call. */
export function createSmallWebRTCConnection(
  iceServers: string[] | IceServer[],
): SmallWebRTCConnection {
  return new SmallWebRTCConnection({ iceServers });
}
