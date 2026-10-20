// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/turns/user_start/__init__.py

// Upstream imports KrispVivaIPUserTurnStartStrategy inside a try/except and
// sets it to None when krisp_audio is not installed. Here the module is always
// importable; its Krisp runtime is injected (see its own module).

export {
  BaseUserTurnStartStrategy,
  UserTurnStartedParams,
} from "./base_user_turn_start_strategy.ts";
export { ExternalUserTurnStartStrategy } from "./external_user_turn_start_strategy.ts";
export { KrispVivaIPUserTurnStartStrategy } from "./krisp_viva_ip_user_turn_start_strategy.ts";
export { MinWordsUserTurnStartStrategy } from "./min_words_user_turn_start_strategy.ts";
export { TranscriptionUserTurnStartStrategy } from "./transcription_user_turn_start_strategy.ts";
export { VADUserTurnStartStrategy } from "./vad_user_turn_start_strategy.ts";
export { WakePhraseUserTurnStartStrategy } from "./wake_phrase_user_turn_start_strategy.ts";
