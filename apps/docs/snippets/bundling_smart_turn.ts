// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Sample for content/docs/deployment/bundling.mdx. Type-checked on every docs build; the same
// recipe runs, bundled, in examples/bundle-check.

// #region smart-turn
import { createLocalSmartTurnAnalyzerV3 } from "@pipedog/audio-smart-turn";
import smartTurnPath from "@pipedog/audio-smart-turn/smart-turn-v3.2-cpu.onnx" with {
  type: "file",
};
import { TurnAnalyzerUserTurnStopStrategy } from "@pipedog/core/turns/user_stop/turn_analyzer_user_turn_stop_strategy";
import { UserTurnStrategies } from "@pipedog/core/turns/user_turn_strategies";

// Pass the analyzer to the strategy yourself. By default core finds @pipedog/audio-smart-turn
// by name at run time, which a bundler can't see.
export const turnStrategies = new UserTurnStrategies({
  stop: [
    new TurnAnalyzerUserTurnStopStrategy({
      turnAnalyzer: createLocalSmartTurnAnalyzerV3({
        model: new URL(smartTurnPath, import.meta.url),
      }),
    }),
  ],
});
// #endregion
