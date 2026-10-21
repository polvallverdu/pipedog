// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/services/grok/llm.py

/**
 * Grok LLM service implementation.
 *
 * @deprecated Deprecated upstream since 0.0.108 (removed in 2.0.0): import
 *   from `@pipedog/xai/llm` instead. This module re-exports it.
 *
 * DIVERGENCE: upstream logs a deprecation warning when the module is
 * imported. This package is side-effect free (`sideEffects: false`), so the
 * deprecation is only marked in the types (`@deprecated`), which editors and
 * linters show.
 */

export {
  /** @deprecated Import from `@pipedog/xai/llm` instead. */
  GrokLLMService,
  /** @deprecated Import from `@pipedog/xai/llm` instead. */
  type GrokLLMServiceOptions,
  /** @deprecated Import from `@pipedog/xai/llm` instead. */
  GrokLLMSettings,
  /** @deprecated Import from `@pipedog/xai/llm` instead. */
  type GrokLLMSettingsOptions,
  /** @deprecated Import from `@pipedog/xai/llm` instead. */
  type GrokReasoningEffort,
} from "@pipedog/xai/llm";
