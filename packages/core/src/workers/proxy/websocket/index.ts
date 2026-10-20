// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/workers/proxy/websocket/__init__.py

/** WebSocket proxy workers for forwarding bus messages. */

export { WebSocketProxyClient } from "./client.ts";
// WebSocketProxyServer depends on a server framework (Starlette upstream), so it
// lives in its own package: import it from `@pipedog/worker-proxy`.
