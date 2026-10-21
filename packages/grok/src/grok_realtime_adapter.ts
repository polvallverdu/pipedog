// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/adapters/services/grok_realtime_adapter.py

/**
 * Grok Realtime LLM adapter for Pipecat.
 *
 * DIVERGENCE: the adapter lives in `@pipedog/xai/grok_realtime_adapter`, next
 * to the service that uses it (`@pipedog/xai/realtime/llm`), since this
 * package depends on `@pipedog/xai` and not the other way round. This module
 * re-exports it under its upstream module name.
 */

export * from "@pipedog/xai/grok_realtime_adapter";
