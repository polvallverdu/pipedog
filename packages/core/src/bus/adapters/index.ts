// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipecat-ts contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/bus/adapters/__init__.py

/**
 * Type adapters for bus message serialization.
 *
 * Provides ready-made `TypeAdapter` implementations for common Pipecat types
 * (`LLMContext`, `ToolsSchema`) used in bus messages.
 */

export { TypeAdapter } from "./base.ts";
export { LLMContextAdapter } from "./llm_context_adapter.ts";
export { ToolsSchemaAdapter } from "./tools_schema_adapter.ts";
