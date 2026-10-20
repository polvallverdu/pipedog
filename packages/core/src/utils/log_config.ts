// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/utils/log_config.py

/**
 * Process-wide controls for Pipecat's debug logging.
 *
 * Some debug output grows with the length of a session, such as the LLM context
 * logged on every inference. The settings here choose how much of it to write,
 * and each is read from an environment variable once, on first use.
 *
 * - `PIPECAT_LOG_LLM_CONTEXT`: how much of the context LLM services include
 *   in their DEBUG log lines. `full` (the default) logs every message;
 *   `off` logs the line without the context.
 *
 * @example
 * // PIPECAT_LOG_LLM_CONTEXT=off bun bot.ts
 */

import { getEnv, InvalidEnvVarValueError } from "./env.ts";

export const _LLM_CONTEXT_LOG_ENV_VAR = "PIPECAT_LOG_LLM_CONTEXT";

/**
 * How much of the context LLM services include in their DEBUG log lines.
 *
 * LLM services log a DEBUG line each time they generate a response, and
 * realtime services when they set up their server-side conversation. The
 * context is built only when DEBUG is enabled.
 *
 * - FULL: Every message of the context.
 * - OFF: None of it; the line is logged without the context.
 */
export const _LLMContextLogMode = {
  FULL: "full",
  OFF: "off",
} as const;
export type _LLMContextLogMode = (typeof _LLMContextLogMode)[keyof typeof _LLMContextLogMode];

let llmContextLogMode: _LLMContextLogMode | null = null;

/**
 * Return how LLM services log the context.
 *
 * The mode named by `PIPECAT_LOG_LLM_CONTEXT`, or `full` when it is unset
 * or empty. The environment variable is read once, on first use.
 *
 * @returns The current LLM context log mode.
 * @throws InvalidEnvVarValueError If `PIPECAT_LOG_LLM_CONTEXT` is set to an unknown mode.
 */
export function _getLlmContextLogMode(): _LLMContextLogMode {
  if (llmContextLogMode === null) {
    llmContextLogMode = _llmContextLogModeFromEnv();
  }
  return llmContextLogMode;
}

/**
 * Forget the cached mode so the next `_getLlmContextLogMode()` reads the
 * environment again. Python tests assign `_llm_context_log_mode = None`; a
 * module variable can't be assigned from outside in JS.
 */
export function _resetLlmContextLogMode(): void {
  llmContextLogMode = null;
}

export function _llmContextLogModeFromEnv(): _LLMContextLogMode {
  const raw = getEnv(_LLM_CONTEXT_LOG_ENV_VAR);
  if (raw === undefined || !raw.trim()) {
    return _LLMContextLogMode.FULL;
  }
  const value = raw.trim().toLowerCase();
  const modes = Object.values(_LLMContextLogMode) as string[];
  if (modes.includes(value)) {
    return value as _LLMContextLogMode;
  }
  throw new InvalidEnvVarValueError({
    name: _LLM_CONTEXT_LOG_ENV_VAR,
    value: raw,
    expected: modes.join(" or "),
  });
}
