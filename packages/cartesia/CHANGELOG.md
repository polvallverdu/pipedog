# @pipedog/cartesia

## 0.11.0

### Minor Changes

- [#103](https://github.com/polvallverdu/pipedog/pull/103) [`3fe7566`](https://github.com/polvallverdu/pipedog/commit/3fe756637d4a7364c095d40c877d89ba456fd44e) Thanks [@polvallverdu](https://github.com/polvallverdu)! - Speech providers brought up to pipecat main after 1.14:
  
  - Expression adapters for expressive conversation (alpha): `CartesiaExpressionAdapter`
    (`@pipedog/cartesia/cartesia_adapter`, `CartesiaEmotion` now lives there),
    `ElevenLabsAudioTagExpressionAdapter`, Fish Audio S2 and MiniMax adapters. With
    `enableExpressiveConversation`, the TTS services perform the tags the LLM writes.
  - Cartesia: `accent` setting ([#6429](https://github.com/polvallverdu/pipedog/issues/6429)), regional locales and CJK punctuation tokens; the turns STT
    reconnects from its receive loop and ends a turn cut short by a dropped connection with the
    transcript so far ([#6242](https://github.com/polvallverdu/pipedog/issues/6242)).
  - ElevenLabs: audio tags reported as words, and the word clock advances on wordless alignment
    ([#6297](https://github.com/polvallverdu/pipedog/issues/6297)).
  - Deepgram: the TTS and Flux services report the `dg-error` reason of a refused connection, and
    Flux STT waits for `Connected` through the core `_receiveUntilConfirmed`.
  - Inworld TTS reconnects from its receive loop ([#6300](https://github.com/polvallverdu/pipedog/issues/6300)); Sarvam STT reconnects ([#6342](https://github.com/polvallverdu/pipedog/issues/6342)).
  - Smallest: `dateFormat` and the `"redact"` content filter ([#6431](https://github.com/polvallverdu/pipedog/issues/6431)). Speechify: `pronunciations`
    ([#6436](https://github.com/polvallverdu/pipedog/issues/6436)) and `simba-3.5` as the default model. Google Vertex defaults to `gemini-3.8-flash`.

- [#101](https://github.com/polvallverdu/pipedog/pull/101) [`f57c63e`](https://github.com/polvallverdu/pipedog/commit/f57c63e8b670789bb15574e4ebe3a4ede1eb61c8) Thanks [@polvallverdu](https://github.com/polvallverdu)! - User turn strategies redesign, as in pipecat-ai/pipecat#6346:
  
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

### Patch Changes

- Updated dependencies [[`96b2e45`](https://github.com/polvallverdu/pipedog/commit/96b2e4550f18d47a683ea635c33db458b0acb5dd), [`c23ef57`](https://github.com/polvallverdu/pipedog/commit/c23ef572ea1dd9c8a1ac81a83bf6337df7e1c191), [`c23ef57`](https://github.com/polvallverdu/pipedog/commit/c23ef572ea1dd9c8a1ac81a83bf6337df7e1c191), [`bddb1c5`](https://github.com/polvallverdu/pipedog/commit/bddb1c568cfd5b0e9818bc19538b73d5fc83cd40), [`a25889f`](https://github.com/polvallverdu/pipedog/commit/a25889fdb51beffacee1e5e26404dafad662b7d2), [`f57c63e`](https://github.com/polvallverdu/pipedog/commit/f57c63e8b670789bb15574e4ebe3a4ede1eb61c8), [`c23ef57`](https://github.com/polvallverdu/pipedog/commit/c23ef572ea1dd9c8a1ac81a83bf6337df7e1c191)]:
  - @pipedog/core@0.11.0
  - @pipedog/asyncio@0.11.0

## 0.10.0

### Patch Changes

- Updated dependencies [[`1840a07`](https://github.com/polvallverdu/pipedog/commit/1840a07cff7db6baaab583286f94c1368eba2c3e), [`1840a07`](https://github.com/polvallverdu/pipedog/commit/1840a07cff7db6baaab583286f94c1368eba2c3e)]:
  - @pipedog/core@0.10.0
  - @pipedog/asyncio@0.10.0

## 0.9.0

### Patch Changes

- Updated dependencies [[`72c00c8`](https://github.com/polvallverdu/pipedog/commit/72c00c876904bd26adb007678179f35e57822557), [`f7dc044`](https://github.com/polvallverdu/pipedog/commit/f7dc044b41e91f3d7d504fb0ae43a7af7fc0ac7d)]:
  - @pipedog/core@0.9.0
  - @pipedog/asyncio@0.9.0

## 0.8.0

### Patch Changes

- Updated dependencies [[`d6e6f45`](https://github.com/polvallverdu/pipedog/commit/d6e6f45c41c7a0aff8f8bdf551f43a8222dc90a8)]:
  - @pipedog/core@0.8.0
  - @pipedog/asyncio@0.8.0

## 0.7.0

### Patch Changes

- Updated dependencies [[`20a84e7`](https://github.com/polvallverdu/pipedog/commit/20a84e741d546e66e0eb7ad9a163c3968a4c042f)]:
  - @pipedog/core@0.7.0
  - @pipedog/asyncio@0.7.0

## 0.6.1

### Patch Changes

- Updated dependencies [[`9f1ce7a`](https://github.com/polvallverdu/pipedog/commit/9f1ce7aea9ae80195d7ff8da0cb591f7910641ac)]:
  - @pipedog/asyncio@0.6.1
  - @pipedog/core@0.6.1

## 0.6.0

### Patch Changes

- Updated dependencies [[`b53032d`](https://github.com/polvallverdu/pipedog/commit/b53032d6a46103d5a1c1fd16b3b61dfd38a7bc2b), [`dd4712b`](https://github.com/polvallverdu/pipedog/commit/dd4712bcedc3ac408918651673743fe90520f8db)]:
  - @pipedog/asyncio@0.6.0
  - @pipedog/core@0.6.0

## 0.5.0

### Patch Changes

- [#20](https://github.com/polvallverdu/pipedog/pull/20) [`566fb45`](https://github.com/polvallverdu/pipedog/commit/566fb45374cac73be72f2a83510a12b6b8041301) Thanks [@polvallverdu](https://github.com/polvallverdu)! - Package READMEs on npm. `@pipedog/core`, `@pipedog/asyncio`, `@pipedog/openai`,
  `@pipedog/anthropic`, `@pipedog/deepgram`, `@pipedog/cartesia`, `@pipedog/elevenlabs`,
  `@pipedog/tracing` and `@pipedog/whisper` now ship a README with install steps, a usage snippet,
  runtimes and links to the docs. Every package gains npm `keywords`, and the `@pipedog/elevenlabs`
  description no longer lists Text-to-Dialogue, which is not ported yet.
- Updated dependencies [[`70dce6f`](https://github.com/polvallverdu/pipedog/commit/70dce6fcf5ffefa49ef2c21f87bac6377f0d5a09), [`566fb45`](https://github.com/polvallverdu/pipedog/commit/566fb45374cac73be72f2a83510a12b6b8041301)]:
  - @pipedog/core@0.5.0
  - @pipedog/asyncio@0.5.0

## 0.4.0

### Minor Changes

- [#19](https://github.com/polvallverdu/pipedog/pull/19) [`f24da7d`](https://github.com/polvallverdu/pipedog/commit/f24da7d0426ff2237579f8b7a4374271d474c45d) Thanks [@polvallverdu](https://github.com/polvallverdu)! - Speech providers: Deepgram, Cartesia and ElevenLabs.
  
  - `@pipedog/deepgram`: `DeepgramSTTService`, `DeepgramTTSService`, `DeepgramHttpTTSService`, and Flux
    (`DeepgramFluxSTTService` with Deepgram's turn detection, `DeepgramFluxTTSService`).
  - `@pipedog/cartesia`: `CartesiaSTTService`, `CartesiaTTSService`, `CartesiaHttpTTSService`, and
    `CartesiaTurnsSTTService` with Cartesia's turn detection.
  - `@pipedog/elevenlabs`: ElevenLabs STT (batch and realtime) and TTS.
  
  All run on Bun, Node, Deno and Cloudflare Workers.

### Patch Changes

- Updated dependencies [[`b88231a`](https://github.com/polvallverdu/pipedog/commit/b88231af79d984e191b54c30965fa062a60ec8c3)]:
  - @pipedog/core@0.4.0
  - @pipedog/asyncio@0.4.0
