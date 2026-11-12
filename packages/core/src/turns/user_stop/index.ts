// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/turns/user_stop/__init__.py
//
// The deprecated DeferredUserTurnStopStrategy, deferred() and
// ExternalUserTurnCompletionStopStrategy are not ported.

export {
  BaseUserTurnStopStrategy,
  UserTurnStoppedParams,
} from "./base_user_turn_stop_strategy.ts";
export { EagerMatchPolicy, ExactMatch, NormalizedMatch } from "./eager_match_policy.ts";
export { EagerUserTurnStopStrategy } from "./eager_user_turn_stop_strategy.ts";
export { ExternalUserTurnStopStrategy } from "./external_user_turn_stop_strategy.ts";
export { LLMTurnCompletionUserTurnStopStrategy } from "./llm_turn_completion_user_turn_stop_strategy.ts";
export { SpeechTimeoutUserTurnStopStrategy } from "./speech_timeout_user_turn_stop_strategy.ts";
export { TurnAnalyzerUserTurnStopStrategy } from "./turn_analyzer_user_turn_stop_strategy.ts";
