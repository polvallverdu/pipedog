---
"@pipedog/core": minor
"@pipedog/cartesia": minor
---

User turn strategies redesign, as in pipecat-ai/pipecat#6346:

- Added `UserTurnStrategiesParams` (`@pipedog/core/turns/user_turn_strategies`), passed as
  `userTurnStrategiesParams` to `LLMUserAggregatorParams`, `UserTurnProcessor` or
  `UserTurnController`. `startMode` and `stopMode` take a `StrategyMode`: with `FIRST` the first
  strategy to decide wins, with `ALL` every strategy has to agree (`startMode` defaults to `FIRST`,
  `stopMode` to `ALL`). `startMergeMode` and `stopMergeMode` take a `MergeMode`: `REPLACE`, the
  default, uses your strategies instead of the ones a service recommends, and `EXTEND` adds them to
  the service's, e.g. `new FilterIncompleteUserTurnStrategies()` with
  `new UserTurnStrategiesParams({ stopMergeMode: MergeMode.EXTEND })` filters incomplete turns on
  top of an STT service's turn detection.
- ⚠️ Several stop strategies in one `UserTurnStrategies.stop` list now all have to agree before a
  turn ends (`stopMode` defaults to `StrategyMode.ALL`). Pass
  `new UserTurnStrategiesParams({ stopMode: StrategyMode.FIRST })` to end the turn on the first
  stop strategy that decides, as before. A list with a single stop strategy behaves as before.
- ⚠️ Strategies report decisions and the turn controller decides when the turn starts and ends:
  `triggerUserTurnStarted()` is now `reportUserTurnStarted()`, `triggerUserTurnStopped()` is now
  `reportUserTurnStopped()` (it fires `on_user_turn_stopped` only; the controller runs the turn's
  inference itself), and a stop strategy starts and withdraws a speculation with
  `startUserTurnSpeculation()` and `cancelUserTurnSpeculation()`. `triggerUserTurnFinalized()`,
  `triggerUserTurnInferenceTriggered()` and `triggerUserTurnSpeculationCancelled()` are removed.
- ⚠️ `processFrame()` of a user turn strategy returns nothing, and every strategy sees every frame.
  `ProcessFrameResult` is removed (upstream deprecates it); use `StrategyMode` instead.
- ⚠️ `deferred()`, `DeferredUserTurnStopStrategy` and `ExternalUserTurnCompletionStopStrategy` are
  removed (upstream deprecates them). Pass the wrapped strategy itself; use
  `ExternalUserTurnStopStrategy` with a `ProposedUserStoppedSpeakingFrame`, or
  `LLMTurnCompletionUserTurnStopStrategy` for the LLM's markers.
- ⚠️ `EagerEndOfTurnCancelFrame` is renamed `UserTurnResponseCancelFrame` (the deprecated alias is
  not ported). `CartesiaTurnsSTTService` pushes it on `turn.resume`.
- Added `BaseUserTurnStopStrategy.waitsForInference` and `decisionScheduled`. A stop strategy that
  decides from the turn's inference rather than from the user returns `true` from
  `waitsForInference` (⚠️ a custom one that relied on `deferred()` strategies must now do so), and
  the stop timeout waits while a strategy reports `decisionScheduled`.
- Added `UserTurnCompletionFrame`, which an LLM service using turn-completion markers pushes upstream
  once per inference (`kind` is `"complete"`, `"short"`, `"long"` or `null`, with the
  `contextFrameId` of the `LLMContextFrame` that started it). `LLMTurnCompletionUserTurnStopStrategy`
  decides on it, and now owns the re-prompt after ◐ or ○: a turn the LLM marks incomplete stays open
  until the user is re-prompted, instead of being ended by `userTurnStopTimeout`.
- `FilterIncompleteUserTurnStrategies` works with an eager end of turn and, with
  `stopMergeMode: MergeMode.EXTEND`, with the stop strategies a service recommends.
- When the user speaks again after a turn's answer has started but before the turn ended, that
  answer is cancelled: the user aggregator interrupts the bot, or broadcasts a
  `UserTurnResponseCancelFrame` when the turn doesn't interrupt the bot. `UserTurnController` and
  `UserTurnProcessor` have a new `on_user_turn_resumed` event (`UserTurnResumedParams`).
- ⚠️ `WakePhraseUserTurnStartStrategy` starts turns on its own once awake (when the user speaks or a
  final transcript arrives). Use it as the only start strategy, or combine it with others such as
  `MinWordsUserTurnStartStrategy` with `startMode: StrategyMode.ALL`. It no longer holds back the
  strategies after it in a `FIRST` list.
- `ExternalUserTurnStopStrategy` decides once per round, with a one-shot transcription timer instead
  of a loop polling every 0.5 s.
