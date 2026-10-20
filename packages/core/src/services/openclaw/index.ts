// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipecat-ts contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/services/openclaw/__init__.py

/**
 * OpenClaw Gateway support.
 *
 * The Gateway is the websocket an OpenClaw agent publishes for other programs
 * to drive it. `OpenClawGatewayClient` (`services/openclaw/client`) starts runs
 * on it, streams their output, redirects work already in flight, and stops it.
 * `OpenClawGatewayService` (`services/openclaw/gateway`) is the pipeline half,
 * translating between that traffic and frames.
 *
 * The split leaves the decision of what an agent's output should sound like to
 * a service wrapping it.
 */

export {};
