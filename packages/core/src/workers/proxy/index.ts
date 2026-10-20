// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/workers/proxy/__init__.py

/** Proxy workers for forwarding bus messages over network transports. */

// WebSocketProxyServer lives in `@pipedog/worker-proxy` (it needs a server framework).
export { WebSocketProxyClient } from "./websocket/index.ts";
