# Upstream bump: `5558d26dca` → `8c3558bd69`

Moves the pinned pipecat from `5558d26dca636e09b768cfb7f70b87e259f7c188` to `8c3558bd6955e06a8e95a748569db9c71b1f9ab3`
(upstream `main`, 94 merges: pipecat 1.14.0 plus what landed after it). This file is the triage of that bump and the
plan for porting it. It is written by hand (from a scripted triage); `porting/manifest.json` stays the source of truth for status.

## How the triage was done

- `bun run upstream bump` moved the pin and reset every ported module/test whose upstream file changed to `todo`.
- Each changed file was diffed old pin → new pin. A file whose AST is identical once docstrings, comments, type
  annotations and imports are stripped is a no-op candidate; the import-only ones were checked by hand (they only
  follow the `adapters.llm` move). Every other diff was read and classified, using the upstream PR messages.
- Classes: **a** no-op (comments, typing, formatting, docstrings, import paths, or deprecation shims, which pipedog
  does not port); **b** small behavioural delta; **c** large rewrite or new functionality; **d** part of a
  cross-cutting refactor other ports depend on.
- Class **a** entries were set back to their previous status with `bun tools/port/status.ts --set`. Everything
  else stays `todo` with an `upstream changed …; re-port the diff` note.

Modules: 50 a, 54 b, 9 c, 43 d, plus 12 that were never ported and changed upstream. Tests: 25 a, 37 b, 8 c, 12 d, 10 never ported. New upstream: 63 modules, 31 test files.

## Cross-cutting refactors (port first, in this order)

1. **LLM adapters moved to `pipecat.adapters.llm`** ([#6331](https://github.com/pipecat-ai/pipecat/pull/6331)).
   `adapters/base_llm_adapter`, `adapters/schemas/*` and `adapters/services/*` moved under `adapters/llm/`; the old
   paths are deprecated re-export shims. Pipedog moves the TS files, updates every import, and does not port the
   shims (deprecated). Provider adapters stay in their provider package (`tools/port/graph.py` now maps
   `adapters.llm.services.*` and `adapters.tts.services.*` to the provider).
2. **User turn strategies redesign** ([#6346](https://github.com/pipecat-ai/pipecat/pull/6346)). Start strategies
   `report_user_turn_started()`, stop strategies `report_user_turn_stopped()`, the controller decides; `StrategyMode`
   (`FIRST`/`ALL`), `MergeMode`, `UserTurnStrategiesParams`; `waits_for_inference`, `decision_scheduled`;
   `UserTurnCompletionFrame`, `UserTurnResponseCancelFrame`, `on_user_turn_resumed`; `LLMTurnCompletionUserTurnStopStrategy`
   rewrite. Deprecated and not ported: `ProcessFrameResult`, `trigger_*` methods, `deferred()`/`DeferredUserTurnStopStrategy`,
   `ExternalUserTurnCompletionStopStrategy`, `EagerEndOfTurnCancelFrame`. Pipedog-only extensions to keep:
   `MinWordsUserTurnStartStrategy` `isBackchannel` / `requireVadWithinSeconds`.
3. **Expressive conversation** ([#6303](https://github.com/pipecat-ai/pipecat/pull/6303), [#6315](https://github.com/pipecat-ai/pipecat/pull/6315),
   [#6319](https://github.com/pipecat-ai/pipecat/pull/6319), [#6377](https://github.com/pipecat-ai/pipecat/pull/6377),
   [#6418](https://github.com/pipecat-ai/pipecat/pull/6418), [#6439](https://github.com/pipecat-ai/pipecat/pull/6439),
   [#6442](https://github.com/pipecat-ai/pipecat/pull/6442)). New `pipecat.expressive` and `pipecat.adapters.tts`
   packages; `TTSService`, `llm_response_universal`, the text aggregators (`protected_end`), `WordCompletionTracker`,
   `AggregatedFrameSequencer` and the RTVI observer use them, and the Cartesia/ElevenLabs/Fish/MiniMax TTS changes
   build on them. Not one of the two refactors planned up front, but most core (b)/(c) entries depend on it, so it
   goes first in the core module batch.

Smaller shared pieces other modules need: `WebsocketService._receive_until_confirmed` (Deepgram Flux, Cartesia
turns, Sarvam STT), `services/deepgram/_errors.py` (Deepgram TTS/Flux, Cloudflare Flux), the OpenAI realtime
`_auth_headers()` hook (#6329, Azure realtime), `utils/text/transforms/text_transform.py` (`LLMTextProcessor`),
and the `StripMarkdown` class (`voice_formatter`).

## Plan

1. This PR: bump + triage (`upstream-bump/triage`).
2. `upstream-bump/adapters-llm`: refactor 1.
3. `upstream-bump/user-turn-strategies`: refactor 2.
4. Module batches, one PR per package batch, each stacked on the previous: core (expressive first), then
   providers, then the new providers (NVIDIA Omni, Zoom STT, AssemblyAI TTS, Tone) last.

Progress is tracked in the [Progress](#progress) section at the end.

## Changed modules

| Package | Module | Class | Reason | Upstream PRs |
|---|---|---|---|---|
| `core` | `pipecat.adapters.base_llm_adapter` | d | moved to pipecat.adapters.llm.* (#6331); old path is a deprecated re-export shim | [#6331](https://github.com/pipecat-ai/pipecat/pull/6331) |
| `core` | `pipecat.adapters.schemas.direct_function` | d | moved to pipecat.adapters.llm.* (#6331); old path is a deprecated re-export shim | [#6331](https://github.com/pipecat-ai/pipecat/pull/6331) |
| `core` | `pipecat.adapters.schemas.function_schema` | d | moved to pipecat.adapters.llm.* (#6331); old path is a deprecated re-export shim | [#6331](https://github.com/pipecat-ai/pipecat/pull/6331) |
| `core` | `pipecat.adapters.schemas.tools_schema` | d | moved to pipecat.adapters.llm.* (#6331); old path is a deprecated re-export shim | [#6331](https://github.com/pipecat-ai/pipecat/pull/6331) |
| `core` | `pipecat.adapters.services.open_ai_adapter` | d | moved to pipecat.adapters.llm.* (#6331); old path is a deprecated re-export shim | [#6331](https://github.com/pipecat-ai/pipecat/pull/6331) |
| `core` | `pipecat.pipeline.llm_with_backend` | d | removed upstream (became the pipeline/llm_with_backend/ package) | [#6435](https://github.com/pipecat-ai/pipecat/pull/6435), [#6314](https://github.com/pipecat-ai/pipecat/pull/6314), [#6267](https://github.com/pipecat-ai/pipecat/pull/6267), [#6174](https://github.com/pipecat-ai/pipecat/pull/6174), [#6331](https://github.com/pipecat-ai/pipecat/pull/6331) |
| `core` | `pipecat.processors.aggregators.llm_response_universal` | d | Turn rework (strategies_params merge, on_user_turn_resumed, UserTurnResponseCancelFrame, inference frame to controller) plus expressive bits | [#6385](https://github.com/pipecat-ai/pipecat/pull/6385), [#6319](https://github.com/pipecat-ai/pipecat/pull/6319), [#6346](https://github.com/pipecat-ai/pipecat/pull/6346), [#6303](https://github.com/pipecat-ai/pipecat/pull/6303), [#6331](https://github.com/pipecat-ai/pipecat/pull/6331) |
| `core` | `pipecat.turns.eager_end_of_turn_mixin` | d | EagerEndOfTurnCancelFrame replaced by UserTurnResponseCancelFrame (user-turn strategy rework) | [#6346](https://github.com/pipecat-ai/pipecat/pull/6346) |
| `core` | `pipecat.turns.speculation_gate` | d | Discards speculation on UserTurnResponseCancelFrame instead of EagerEndOfTurnCancelFrame (user-turn strategy rework) | [#6346](https://github.com/pipecat-ai/pipecat/pull/6346) |
| `core` | `pipecat.turns.types` | d | ProcessFrameResult deprecated; UserTurnSpeculation gains perception; new UserTurnResumedParams dataclass | [#6319](https://github.com/pipecat-ai/pipecat/pull/6319), [#6346](https://github.com/pipecat-ai/pipecat/pull/6346) |
| `core` | `pipecat.turns.user_start.base_user_turn_start_strategy` | d | trigger_user_turn_started renamed to report_user_turn_started (old one deprecated w/ override-compat via ContextVar); ProcessFrameResult return deprecated | [#6346](https://github.com/pipecat-ai/pipecat/pull/6346) |
| `core` | `pipecat.turns.user_start.external_user_turn_start_strategy` | d | Turn-start rework: process_frame no longer returns ProcessFrameResult; trigger_user_turn_started -> report_user_turn_started | [#6346](https://github.com/pipecat-ai/pipecat/pull/6346) |
| `core` | `pipecat.turns.user_start.krisp_viva_ip_user_turn_start_strategy` | d | User-turn-start rework: process_frame no longer returns ProcessFrameResult; trigger_user_turn_started -> report_user_turn_started | [#6346](https://github.com/pipecat-ai/pipecat/pull/6346) |
| `core` | `pipecat.turns.user_start.min_words_user_turn_start_strategy` | d | User-turn-start rework: drops ProcessFrameResult returns, uses report_user_turn_started (else trigger_reset_aggregation) | [#6346](https://github.com/pipecat-ai/pipecat/pull/6346) |
| `core` | `pipecat.turns.user_start.transcription_user_turn_start_strategy` | d | process_frame no longer returns ProcessFrameResult; calls report_user_turn_started instead of trigger_user_turn_started | [#6346](https://github.com/pipecat-ai/pipecat/pull/6346) |
| `core` | `pipecat.turns.user_start.vad_user_turn_start_strategy` | d | process_frame returns nothing and calls report_user_turn_started() instead of trigger + STOP (user-turn strategy rework) | [#6346](https://github.com/pipecat-ai/pipecat/pull/6346) |
| `core` | `pipecat.turns.user_start.wake_phrase_user_turn_start_strategy` | d | User-turn-start rework: when awake it starts turns itself on VAD/User/ProposedUserStarted/Transcription; uses report_user_turn_started | [#6346](https://github.com/pipecat-ai/pipecat/pull/6346) |
| `core` | `pipecat.turns.user_stop.base_user_turn_stop_strategy` | d | Stop strategies now report decisions: report_user_turn_stopped, start/cancel_user_turn_speculation, waits_for_inference, decision_scheduled | [#6346](https://github.com/pipecat-ai/pipecat/pull/6346) |
| `core` | `pipecat.turns.user_stop.deferred_user_turn_stop_strategy` | d | deferred()/DeferredUserTurnStopStrategy deprecated by the turn-strategy redesign; drop them in that refactor | [#6346](https://github.com/pipecat-ai/pipecat/pull/6346) |
| `core` | `pipecat.turns.user_stop.eager_user_turn_stop_strategy` | d | Moves to report_user_turn_stopped/start_/cancel_user_turn_speculation; EagerEndOfTurnCancelFrame->UserTurnResponseCancelFrame; _confirmed state; perception | [#6319](https://github.com/pipecat-ai/pipecat/pull/6319), [#6346](https://github.com/pipecat-ai/pipecat/pull/6346) |
| `core` | `pipecat.turns.user_stop.external_user_turn_completion_stop_strategy` | d | Whole class deprecated (use ExternalUserTurnStopStrategy); waits_for_inference=True; report_user_turn_stopped | [#6346](https://github.com/pipecat-ai/pipecat/pull/6346) |
| `core` | `pipecat.turns.user_stop.external_user_turn_stop_strategy` | d | Background loop replaced by per-transcription timer; _decided flag; reacts to VAD start/stop; report_* renames | [#6346](https://github.com/pipecat-ai/pipecat/pull/6346) |
| `core` | `pipecat.turns.user_stop.llm_turn_completion_user_turn_stop_strategy` | d | Rewritten on BaseUserTurnStopStrategy: tracks awaited inference, decides on UserTurnCompletionFrame, owns re-prompt timers | [#6346](https://github.com/pipecat-ai/pipecat/pull/6346) |
| `core` | `pipecat.turns.user_stop.speech_timeout_user_turn_stop_strategy` | d | Turns rework: process_frame returns None; trigger_user_turn_stopped -> report_user_turn_stopped | [#6346](https://github.com/pipecat-ai/pipecat/pull/6346) |
| `core` | `pipecat.turns.user_stop.turn_analyzer_user_turn_stop_strategy` | d | process_frame no longer returns ProcessFrameResult; trigger_user_turn_stopped renamed report_user_turn_stopped | [#6346](https://github.com/pipecat-ai/pipecat/pull/6346) |
| `core` | `pipecat.turns.user_turn_completion_mixin` | d | Turns rework (large): drops incomplete-timeout re-prompt, voiced latch and VAD tracking; reports UserTurnCompletionFrame upstream once per inference | [#6346](https://github.com/pipecat-ai/pipecat/pull/6346) |
| `core` | `pipecat.turns.user_turn_controller` | d | Core of the turn rework: StrategyMode FIRST/ALL decision tracking, inference state, on_user_turn_resumed, response cancel, deferred stops | [#6346](https://github.com/pipecat-ai/pipecat/pull/6346) |
| `core` | `pipecat.turns.user_turn_processor` | d | Adds user_turn_strategies_params param and on_user_turn_resumed event; EagerEndOfTurnCancelFrame becomes UserTurnResponseCancelFrame | [#6346](https://github.com/pipecat-ai/pipecat/pull/6346) |
| `core` | `pipecat.turns.user_turn_strategies` | d | Turn-start rework: adds MergeMode, StrategyMode (ALL/FIRST), UserTurnStrategiesParams, merge_with(); FilterIncomplete no longer wraps deferred() | [#6346](https://github.com/pipecat-ai/pipecat/pull/6346) |
| `core` | `pipecat.frames.frames` | c | Many new frames/fields: expressive delivery/perception fields, UserTurnResponseCancelFrame, UserTurnCompletionFrame, TTS/Perception/Expression metadata, flush_id | [#6442](https://github.com/pipecat-ai/pipecat/pull/6442), [#6439](https://github.com/pipecat-ai/pipecat/pull/6439), [#6385](https://github.com/pipecat-ai/pipecat/pull/6385), [#6319](https://github.com/pipecat-ai/pipecat/pull/6319), [#6346](https://github.com/pipecat-ai/pipecat/pull/6346), [#6303](https://github.com/pipecat-ai/pipecat/pull/6303), [#6331](https://github.com/pipecat-ai/pipecat/pull/6331), [#6268](https://github.com/pipecat-ai/pipecat/pull/6268) |
| `core` | `pipecat.processors.aggregators.llm_text_processor` | c | Adds text_transforms (per-type async transforms, drop on whitespace/error, raw_text splice) and flushes held text on TTSStoppedFrame | [#6290](https://github.com/pipecat-ai/pipecat/pull/6290) |
| `core` | `pipecat.services.llm_service` | c | Expressive conversation (TTS/Perception/Expression metadata -> system instruction), _OutputGate hook, EagerEndOfTurnCancel->UserTurnResponseCancel | [#6435](https://github.com/pipecat-ai/pipecat/pull/6435), [#6174](https://github.com/pipecat-ai/pipecat/pull/6174), [#6385](https://github.com/pipecat-ai/pipecat/pull/6385), [#6319](https://github.com/pipecat-ai/pipecat/pull/6319), [#6346](https://github.com/pipecat-ai/pipecat/pull/6346), [#6315](https://github.com/pipecat-ai/pipecat/pull/6315), [#6331](https://github.com/pipecat-ai/pipecat/pull/6331), [#6197](https://github.com/pipecat-ai/pipecat/pull/6197) |
| `core` | `pipecat.services.tts_service` | c | Expressive conversation (expression adapter/formatter, delivery, sound frames), text_filters moved into transform stage, context-order fixes | [#6442](https://github.com/pipecat-ai/pipecat/pull/6442), [#6315](https://github.com/pipecat-ai/pipecat/pull/6315), [#6303](https://github.com/pipecat-ai/pipecat/pull/6303), [#6366](https://github.com/pipecat-ai/pipecat/pull/6366) |
| `core` | `pipecat.classifiers.cloudflare.clef.client` | b | Connection/request failures now also catch OSError (TLS ssl.SSLError) and wrap them in ClassifierError | [#6409](https://github.com/pipecat-ai/pipecat/pull/6409) |
| `core` | `pipecat.classifiers.openai.decisions.client` | b | connect() and ask() now also wrap OSError (e.g. ssl.SSLError from a broken TLS connection) into ClassifierError | [#6409](https://github.com/pipecat-ai/pipecat/pull/6409) |
| `core` | `pipecat.classifiers.typesafe.jev.client` | b | Connection/request failures now also catch OSError (TLS ssl.SSLError) and wrap them in ClassifierError | [#6409](https://github.com/pipecat-ai/pipecat/pull/6409) |
| `core` | `pipecat.pipeline.service_switcher` | b | ServiceMetadataFrame from outside the switcher is now shared with inactive members; their copies are suppressed on the way out | [#6385](https://github.com/pipecat-ai/pipecat/pull/6385), [#6365](https://github.com/pipecat-ai/pipecat/pull/6365) |
| `core` | `pipecat.pipeline.worker` | b | PipelineParams gains enable_expressive_conversation/expression_policy (passed into setup); flush probe re-created per leg, keyed by flush_id | [#6315](https://github.com/pipecat-ai/pipecat/pull/6315), [#6303](https://github.com/pipecat-ai/pipecat/pull/6303), [#6268](https://github.com/pipecat-ai/pipecat/pull/6268) |
| `core` | `pipecat.processors.frame_processor` | b | FrameProcessorSetup gains enable_expressive_conversation and expression_policy; new _cancel_frame_in_progress(frame) | [#6174](https://github.com/pipecat-ai/pipecat/pull/6174), [#6315](https://github.com/pipecat-ai/pipecat/pull/6315), [#6303](https://github.com/pipecat-ai/pipecat/pull/6303) |
| `core` | `pipecat.processors.frameworks.rtvi.models` | b | Protocol 2.3.0: bot-output output_type (text_type now deprecated alias), delivery field; user perception models on UserInputMessageData | [#6442](https://github.com/pipecat-ai/pipecat/pull/6442), [#6319](https://github.com/pipecat-ai/pipecat/pull/6319), [#6303](https://github.com/pipecat-ai/pipecat/pull/6303), [#6351](https://github.com/pipecat-ai/pipecat/pull/6351) |
| `core` | `pipecat.processors.frameworks.rtvi.observer` | b | Transcriptions wait for perceivers to add perception; expression sounds/pauses hidden from <2.3.0 clients; delivery | [#6418](https://github.com/pipecat-ai/pipecat/pull/6418), [#6319](https://github.com/pipecat-ai/pipecat/pull/6319), [#6303](https://github.com/pipecat-ai/pipecat/pull/6303), [#6351](https://github.com/pipecat-ai/pipecat/pull/6351) |
| `core` | `pipecat.services.websocket_service` | b | New ws_send_timeout (default 5s) bounding sends (abort on stall); new _receive_until_confirmed helper; send_with_retry deprecated | [#6300](https://github.com/pipecat-ai/pipecat/pull/6300), [#6242](https://github.com/pipecat-ai/pipecat/pull/6242), [#6251](https://github.com/pipecat-ai/pipecat/pull/6251) |
| `core` | `pipecat.utils.context.aggregated_frame_sequencer` | b | New llm_markup pattern passed to trackers; tag-only sentences reach context; force-complete compares words sans markup; trimmed no-tracker text | [#6303](https://github.com/pipecat-ai/pipecat/pull/6303), [#6366](https://github.com/pipecat-ai/pipecat/pull/6366) |
| `core` | `pipecat.utils.context.text_segment_map` | b | New llm_markup regex: extra LLM-only tags (expression tags) blanked to <...> in a scan copy that the LLM cursors walk | [#6303](https://github.com/pipecat-ai/pipecat/pull/6303) |
| `core` | `pipecat.utils.context.word_completion_tracker` | b | Passes llm_markup through to TextSegmentMap; a markup-only frame (e.g. a pause tag) never claims a word | [#6303](https://github.com/pipecat-ai/pipecat/pull/6303) |
| `core` | `pipecat.utils.security.redaction` | b | Pair redaction rewritten as an iterative scanner (no recursion); exception names (KeyError:) are skipped; chained credential names handled | [#6308](https://github.com/pipecat-ai/pipecat/pull/6308), [#6283](https://github.com/pipecat-ai/pipecat/pull/6283), [#6282](https://github.com/pipecat-ai/pipecat/pull/6282) |
| `core` | `pipecat.utils.string` | b | parse_start_end_tags rewritten as a scanning loop: earliest start tag, handles identical start/end tags and multiple pairs | [#6367](https://github.com/pipecat-ai/pipecat/pull/6367) |
| `core` | `pipecat.utils.text.alnum_utils` | b | advance_by_alnums now skips over a tag after consumed alnums (e.g. '4111</card>.') instead of stopping at '<' | [#6368](https://github.com/pipecat-ai/pipecat/pull/6368) |
| `core` | `pipecat.utils.text.base_text_aggregator` | b | TextType gains EXPRESSION_SOUND and EXPRESSION_PAUSE values for expressive conversation | [#6439](https://github.com/pipecat-ai/pipecat/pull/6439), [#6303](https://github.com/pipecat-ai/pipecat/pull/6303) |
| `core` | `pipecat.utils.text.pattern_pair_aggregator` | b | Identical start/end delimiters fixed via shared _unmatched_start(); sentence boundaries inside closed KEEP patterns ignored |  |
| `core` | `pipecat.utils.text.simple_text_aggregator` | b | _check_sentence_with_lookahead gains protected_end: punctuation before that offset is blanked so it can't end a sentence |  |
| `core` | `pipecat.utils.text.skip_tags_aggregator` | b | New `tags` property; sentence detection ignores boundaries inside closed tags (protected_end) and resets the tag scan index after a yield | [#6303](https://github.com/pipecat-ai/pipecat/pull/6303) |
| `core` | `pipecat.utils.text.transforms` | b | Exports new TextTransform type (text_transform.py) and StripMarkdown class alongside strip_markdown |  |
| `core` | `pipecat.utils.text.transforms.strip_markdown` | b | strip_markdown becomes StripMarkdown class (strip_urls option); strips links/images URLs, strikethrough, bullets; keeps content asterisks |  |
| `core` | `pipecat.utils.text.transforms.voice_formatter` | b | New strip_urls option (default True), passed to a StripMarkdown(strip_urls=...) instance instead of the strip_markdown function |  |
| `core` | `pipecat.utils.time` | b | nanoseconds_to_str now uses integer arithmetic to avoid float microsecond precision errors | [#6411](https://github.com/pipecat-ai/pipecat/pull/6411) |
| `core` | `pipecat.audio.volume` | a | Measures bytes(self._buffer) copy instead of a bytearray view (Python buffer-resize/threading issue); no TS behaviour change | [#6425](https://github.com/pipecat-ai/pipecat/pull/6425) |
| `core` | `pipecat.bus.adapters.tools_schema_adapter` | a | import paths only (adapters moved to adapters.llm) / annotations; AST-identical otherwise | [#6331](https://github.com/pipecat-ai/pipecat/pull/6331) |
| `core` | `pipecat.bus.messages` | a | docstrings/comments/annotations only (AST-identical) | [#6268](https://github.com/pipecat-ai/pipecat/pull/6268) |
| `core` | `pipecat.bus.serializers.json` | a | import paths only (adapters moved to adapters.llm) / annotations; AST-identical otherwise | [#6331](https://github.com/pipecat-ai/pipecat/pull/6331) |
| `core` | `pipecat.pipeline.llm_switcher` | a | import paths only (adapters moved to adapters.llm) / annotations; AST-identical otherwise | [#6331](https://github.com/pipecat-ai/pipecat/pull/6331) |
| `core` | `pipecat.processors.aggregators.llm_context` | a | import paths only (adapters moved to adapters.llm) / annotations; AST-identical otherwise | [#6331](https://github.com/pipecat-ai/pipecat/pull/6331) |
| `core` | `pipecat.processors.audio.audio_buffer_processor` | a | docstrings/comments/annotations only (AST-identical) | [#6197](https://github.com/pipecat-ai/pipecat/pull/6197) |
| `core` | `pipecat.processors.frameworks.rtvi.processor` | a | docstrings/comments/annotations only (AST-identical) | [#6197](https://github.com/pipecat-ai/pipecat/pull/6197) |
| `core` | `pipecat.utils.async_tool_cancellation` | a | import paths only (adapters moved to adapters.llm) / annotations; AST-identical otherwise | [#6331](https://github.com/pipecat-ai/pipecat/pull/6331) |
| `core` | `pipecat.utils.file_resolver` | a | docstrings/comments/annotations only (AST-identical) | [#6331](https://github.com/pipecat-ai/pipecat/pull/6331) |
| `core` | `pipecat.utils.text.base_text_filter` | a | docstrings/comments/annotations only (AST-identical) |  |
| `core` | `pipecat.utils.text.markdown_text_filter` | a | Only adds @deprecated (use strip_markdown transform) plus self.InputParams() instead of class ref; no behaviour change |  |
| `core` | `pipecat.utils.text.transforms.numbers` | a | import paths only (adapters moved to adapters.llm) / annotations; AST-identical otherwise |  |
| `core` | `pipecat.utils.text.transforms.replacements` | a | import paths only (adapters moved to adapters.llm) / annotations; AST-identical otherwise |  |
| `core` | `pipecat.workers.llm.backend_llm_worker` | a | docstrings/comments/annotations only (AST-identical) | [#6435](https://github.com/pipecat-ai/pipecat/pull/6435), [#6174](https://github.com/pipecat-ai/pipecat/pull/6174) |
| `core` | `pipecat.workers.llm.llm_worker` | a | import paths only (adapters moved to adapters.llm) / annotations; AST-identical otherwise | [#6331](https://github.com/pipecat-ai/pipecat/pull/6331) |
| `core` | `pipecat.workers.llm.tool_decorator` | a | import paths only (adapters moved to adapters.llm) / annotations; AST-identical otherwise | [#6331](https://github.com/pipecat-ai/pipecat/pull/6331) |
| `core` | `pipecat.workers.ui.ui_tools` | a | import paths only (adapters moved to adapters.llm) / annotations; AST-identical otherwise | [#6331](https://github.com/pipecat-ai/pipecat/pull/6331) |
| `anthropic` | `pipecat.adapters.services.anthropic_adapter` | d | moved to pipecat.adapters.llm.* (#6331); old path is a deprecated re-export shim | [#6331](https://github.com/pipecat-ai/pipecat/pull/6331) |
| `anthropic` | `pipecat.services.anthropic.llm` | a | import paths only (adapters moved to adapters.llm) / annotations; AST-identical otherwise | [#6331](https://github.com/pipecat-ai/pipecat/pull/6331) |
| `assemblyai` | `pipecat.services.assemblyai.stt` | a | docstrings/comments/annotations only (AST-identical) | [#6197](https://github.com/pipecat-ai/pipecat/pull/6197) |
| `audio-aic-filter` | `pipecat.audio.filters.aic_filter` | todo | not ported yet; upstream changed too (port from scratch later) | [#6181](https://github.com/pipecat-ai/pipecat/pull/6181) |
| `audio-aic-quail-vad` | `pipecat.audio.vad.aic_quail_vad` | todo | not ported yet; upstream changed too (port from scratch later) | [#6181](https://github.com/pipecat-ai/pipecat/pull/6181) |
| `aws` | `pipecat.adapters.services.aws_nova_sonic_adapter` | d | moved to pipecat.adapters.llm.* (#6331); old path is a deprecated re-export shim | [#6331](https://github.com/pipecat-ai/pipecat/pull/6331) |
| `aws` | `pipecat.adapters.services.bedrock_adapter` | d | moved to pipecat.adapters.llm.* (#6331); old path is a deprecated re-export shim | [#6331](https://github.com/pipecat-ai/pipecat/pull/6331) |
| `aws` | `pipecat.services.aws.llm` | b | Bedrock streams reasoningContent as LLMThought frames (with signature) and parses Nova <thinking> text via new TaggedLLMTextParser | [#6229](https://github.com/pipecat-ai/pipecat/pull/6229), [#6331](https://github.com/pipecat-ai/pipecat/pull/6331) |
| `aws` | `pipecat.services.aws.nova_sonic.llm` | a | import paths only (adapters moved to adapters.llm) / annotations; AST-identical otherwise | [#6331](https://github.com/pipecat-ai/pipecat/pull/6331) |
| `azure` | `pipecat.adapters.services.azure_voice_live_adapter` | d | moved to pipecat.adapters.llm.* (#6331); old path is a deprecated re-export shim | [#6331](https://github.com/pipecat-ai/pipecat/pull/6331) |
| `azure` | `pipecat.services.azure.realtime.llm` | b | _connect override removed; replaced by _auth_headers() hook (token provider Bearer or api-key) used by OpenAI realtime base | [#6329](https://github.com/pipecat-ai/pipecat/pull/6329) |
| `azure` | `pipecat.services.azure.voice_live.events` | a | import paths only (adapters moved to adapters.llm) / annotations; AST-identical otherwise | [#6331](https://github.com/pipecat-ai/pipecat/pull/6331) |
| `azure` | `pipecat.services.azure.voice_live.llm` | a | import paths only (adapters moved to adapters.llm) / annotations; AST-identical otherwise | [#6331](https://github.com/pipecat-ai/pipecat/pull/6331) |
| `cartesia` | `pipecat.services.cartesia.tts` | c | Expressive-conversation adapter (CartesiaEmotion moved to adapters.tts), new accent setting, ~70 regional locale codes, CJK pre_merge_tokens | [#6429](https://github.com/pipecat-ai/pipecat/pull/6429), [#6303](https://github.com/pipecat-ai/pipecat/pull/6303), [#6275](https://github.com/pipecat-ai/pipecat/pull/6275), [#6261](https://github.com/pipecat-ai/pipecat/pull/6261) |
| `cartesia` | `pipecat.services.cartesia.turns.stt` | c | Connection lifecycle rework: receive loop owns reconnects, connected-frame wait moved into it, mid-turn drop ends the turn, new request error | [#6346](https://github.com/pipecat-ai/pipecat/pull/6346), [#6242](https://github.com/pipecat-ai/pipecat/pull/6242) |
| `cli` | `pipecat.cli.registry._configs` | b | New CLI service templates: smallest_stt, zoom_ai_stt, smallest_llm, assemblyai_tts; perplexity_llm now PerplexityAgentHttpLLMService w/ default model | [#6322](https://github.com/pipecat-ai/pipecat/pull/6322), [#6339](https://github.com/pipecat-ai/pipecat/pull/6339), [#6280](https://github.com/pipecat-ai/pipecat/pull/6280), [#5985](https://github.com/pipecat-ai/pipecat/pull/5985) |
| `cli` | `pipecat.cli.registry._imports` | b | Registry gains smallest_llm, zoom_ai_stt, assemblyai_tts entries; perplexity_llm now imports PerplexityAgentHttpLLMService | [#6322](https://github.com/pipecat-ai/pipecat/pull/6322), [#6339](https://github.com/pipecat-ai/pipecat/pull/6339), [#6280](https://github.com/pipecat-ai/pipecat/pull/6280), [#5985](https://github.com/pipecat-ai/pipecat/pull/5985) |
| `cli` | `pipecat.cli.registry.service_metadata` | b | New ServiceDefinitions (Smallest STT/LLM, Zoom AI STT, AssemblyAI TTS); Perplexity class -> PerplexityAgentHttpLLMService + param_defaults | [#6322](https://github.com/pipecat-ai/pipecat/pull/6322), [#6339](https://github.com/pipecat-ai/pipecat/pull/6339), [#6280](https://github.com/pipecat-ai/pipecat/pull/6280), [#5985](https://github.com/pipecat-ai/pipecat/pull/5985) |
| `cli` | `pipecat.cli.generators.project` | a | Only the printed Pipecat Cloud docs URL changed (deployment/pipecat-cloud -> pipecat-cloud/introduction) | [#6387](https://github.com/pipecat-ai/pipecat/pull/6387) |
| `deepgram` | `pipecat.services.deepgram.flux.stt` | b | Refusal helper moved to deepgram/_errors.describe_refusal; confirm loop moved to WebsocketService._receive_until_confirmed | [#6242](https://github.com/pipecat-ai/pipecat/pull/6242), [#6248](https://github.com/pipecat-ai/pipecat/pull/6248) |
| `deepgram` | `pipecat.services.deepgram.flux.tts` | b | Handshake failure now reports Deepgram's dg-error refusal reason (describe_refusal) in ErrorFrame and on_connection_error | [#6248](https://github.com/pipecat-ai/pipecat/pull/6248) |
| `deepgram` | `pipecat.services.deepgram.tts` | b | Connect failure now reports Deepgram's handshake refusal reason (dg-error header) via new _errors.describe_refusal | [#6248](https://github.com/pipecat-ai/pipecat/pull/6248) |
| `deepseek` | `pipecat.adapters.services.deepseek_adapter` | d | moved to pipecat.adapters.llm.* (#6331); old path is a deprecated re-export shim | [#6331](https://github.com/pipecat-ai/pipecat/pull/6331) |
| `deepseek` | `pipecat.services.deepseek.llm` | a | import paths only (adapters moved to adapters.llm) / annotations; AST-identical otherwise | [#6331](https://github.com/pipecat-ai/pipecat/pull/6331) |
| `elevenlabs` | `pipecat.services.elevenlabs.tts` | c | WS word clock advances per chunk even without words; HTTP service gets audio-tag expression adapter for eleven_v3/v4 and tag-aware word timing | [#6385](https://github.com/pipecat-ai/pipecat/pull/6385), [#6303](https://github.com/pipecat-ai/pipecat/pull/6303), [#6297](https://github.com/pipecat-ai/pipecat/pull/6297) |
| `elevenlabs` | `pipecat.services.elevenlabs.dialogue.tts` | b | Sets expression_adapter_class=ElevenLabsAudioTagExpressionAdapter; passes audio_tags=bool(expression_formatter) to calculate_word_times | [#6385](https://github.com/pipecat-ai/pipecat/pull/6385), [#6303](https://github.com/pipecat-ai/pipecat/pull/6303) |
| `elevenlabs` | `pipecat.services.elevenlabs.tts_base` | b | calculate_word_times gains keyword audio_tags: keeps bracketed [audio tags] (with spaces) as a single word, across chunk boundaries | [#6385](https://github.com/pipecat-ai/pipecat/pull/6385), [#6303](https://github.com/pipecat-ai/pipecat/pull/6303) |
| `evals` | `pipecat.evals.conversation_observer` | b | Skips LLMContextUserTurnFrame with speculation=True; the turn is recorded once it ends | [#6385](https://github.com/pipecat-ai/pipecat/pull/6385) |
| `evals` | `pipecat.evals.events` | b | bot-output backchannel check now uses output_type (RTVI rename); new 'expression' eval event from expressive-conversation bot-output | [#6303](https://github.com/pipecat-ai/pipecat/pull/6303), [#6351](https://github.com/pipecat-ai/pipecat/pull/6351) |
| `evals` | `pipecat.evals.fastapi_transport` | b | A UserImageRequestFrame with no registered eval image is now answered with an error, not just logged and dropped | [#6350](https://github.com/pipecat-ai/pipecat/pull/6350) |
| `evals` | `pipecat.evals.matcher` | b | New `text_matches` regex expectation check (_text_unmatched) on aggregate and event text, failure kind text_unmatched | [#5991](https://github.com/pipecat-ai/pipecat/pull/5991) |
| `evals` | `pipecat.evals.results` | b | New failure kind 'text_unmatched' for the new text_matches expectation | [#5991](https://github.com/pipecat-ai/pipecat/pull/5991) |
| `evals` | `pipecat.evals.script` | b | New text_matches expectation (regex list, validated at parse) and new judgeable/aggregating 'expression' event | [#5991](https://github.com/pipecat-ai/pipecat/pull/5991), [#6303](https://github.com/pipecat-ai/pipecat/pull/6303) |
| `evals` | `pipecat.evals.transport` | b | With no eval image registered, UserImageRequestFrame is now answered with an error via _answer_image_requests instead of being dropped | [#6350](https://github.com/pipecat-ai/pipecat/pull/6350) |
| `evals` | `pipecat.evals.persona` | a | import paths only (adapters moved to adapters.llm) / annotations; AST-identical otherwise | [#6331](https://github.com/pipecat-ai/pipecat/pull/6331) |
| `fal` | `pipecat.services.fal.stt` | todo | not ported yet; upstream changed too (port from scratch later) | [#6253](https://github.com/pipecat-ai/pipecat/pull/6253) |
| `fireworks` | `pipecat.services.fireworks.llm` | a | import paths only (adapters moved to adapters.llm) / annotations; AST-identical otherwise | [#6331](https://github.com/pipecat-ai/pipecat/pull/6331) |
| `fish` | `pipecat.services.fish.tts` | b | Adds get_expression_adapter(): FishAudioS2ExpressionAdapter for s2* models, else base default | [#6303](https://github.com/pipecat-ai/pipecat/pull/6303) |
| `flows` | `pipecat.flows.manager` | a | import paths only (adapters moved to adapters.llm) / annotations; AST-identical otherwise | [#6331](https://github.com/pipecat-ai/pipecat/pull/6331) |
| `flows` | `pipecat.flows.types` | a | import paths only (adapters moved to adapters.llm) / annotations; AST-identical otherwise | [#6331](https://github.com/pipecat-ai/pipecat/pull/6331) |
| `google` | `pipecat.adapters.services.gemini_adapter` | d | moved to pipecat.adapters.llm.* (#6331); old path is a deprecated re-export shim | [#6331](https://github.com/pipecat-ai/pipecat/pull/6331) |
| `google` | `pipecat.adapters.services.gemini_live_adapter` | d | moved to pipecat.adapters.llm.* (#6331); old path is a deprecated re-export shim | [#6331](https://github.com/pipecat-ai/pipecat/pull/6331) |
| `google` | `pipecat.services.google.vertex.llm` | b | Default model bumped gemini-3.6-flash -> gemini-3.8-flash; adapter import moved to adapters.llm | [#6331](https://github.com/pipecat-ai/pipecat/pull/6331), [#6259](https://github.com/pipecat-ai/pipecat/pull/6259) |
| `google` | `pipecat.services.google.gemini_live.llm` | a | import paths only (adapters moved to adapters.llm) / annotations; AST-identical otherwise | [#6331](https://github.com/pipecat-ai/pipecat/pull/6331) |
| `google` | `pipecat.services.google.gemini_live.vertex.llm` | a | import paths only (adapters moved to adapters.llm) / annotations; AST-identical otherwise | [#6331](https://github.com/pipecat-ai/pipecat/pull/6331) |
| `google` | `pipecat.services.google.llm` | a | import paths only (adapters moved to adapters.llm) / annotations; AST-identical otherwise | [#6331](https://github.com/pipecat-ai/pipecat/pull/6331) |
| `google` | `pipecat.services.google.tts` | a | docstrings/comments/annotations only (AST-identical) | [#6430](https://github.com/pipecat-ai/pipecat/pull/6430) |
| `grok` | `pipecat.adapters.services.grok_realtime_adapter` | d | moved to pipecat.adapters.llm.* (#6331); old path is a deprecated re-export shim | [#6331](https://github.com/pipecat-ai/pipecat/pull/6331) |
| `groq` | `pipecat.services.groq.llm` | a | import paths only (adapters moved to adapters.llm) / annotations; AST-identical otherwise | [#6331](https://github.com/pipecat-ai/pipecat/pull/6331) |
| `inception` | `pipecat.services.inception.llm` | b | Default model changed mercury-2 -> mercury-3 (plus adapter import path move) | [#6397](https://github.com/pipecat-ai/pipecat/pull/6397), [#6331](https://github.com/pipecat-ai/pipecat/pull/6331) |
| `inworld` | `pipecat.adapters.services.inworld_realtime_adapter` | d | moved to pipecat.adapters.llm.* (#6331); old path is a deprecated re-export shim | [#6331](https://github.com/pipecat-ai/pipecat/pull/6331) |
| `inworld` | `pipecat.services.inworld.tts` | b | Send path reworked: direct ws sends (no send_with_retry), receive-loop-owned reconnect, skip TTS while reconnecting, safer disconnect/flush | [#6300](https://github.com/pipecat-ai/pipecat/pull/6300) |
| `inworld` | `pipecat.services.inworld.realtime.events` | a | import paths only (adapters moved to adapters.llm) / annotations; AST-identical otherwise | [#6331](https://github.com/pipecat-ai/pipecat/pull/6331) |
| `inworld` | `pipecat.services.inworld.realtime.llm` | a | import paths only (adapters moved to adapters.llm) / annotations; AST-identical otherwise | [#6331](https://github.com/pipecat-ai/pipecat/pull/6331) |
| `keenable` | `pipecat.services.keenable.search` | todo | not ported yet; upstream changed too (port from scratch later) | [#6331](https://github.com/pipecat-ai/pipecat/pull/6331) |
| `mcp-client` | `pipecat.services.mcp_service` | a | import paths only (adapters moved to adapters.llm) / annotations; AST-identical otherwise | [#6331](https://github.com/pipecat-ai/pipecat/pull/6331) |
| `minimax` | `pipecat.services.minimax.tts` | b | Adds 'calm'/'whisper' to supported emotions; speech-2.8 models get MiniMaxExpressionAdapter; expression_settings merged into voice_setting | [#6303](https://github.com/pipecat-ai/pipecat/pull/6303), [#6302](https://github.com/pipecat-ai/pipecat/pull/6302) |
| `mistral` | `pipecat.adapters.services.mistral_adapter` | d | moved to pipecat.adapters.llm.* (#6331); old path is a deprecated re-export shim | [#6331](https://github.com/pipecat-ai/pipecat/pull/6331) |
| `mistral` | `pipecat.services.mistral.llm` | a | import paths only (adapters moved to adapters.llm) / annotations; AST-identical otherwise | [#6331](https://github.com/pipecat-ai/pipecat/pull/6331) |
| `nvidia` | `pipecat.services.nvidia.llm` | todo | not ported yet; upstream changed too (port from scratch later) | [#6229](https://github.com/pipecat-ai/pipecat/pull/6229), [#6354](https://github.com/pipecat-ai/pipecat/pull/6354) |
| `nvidia` | `pipecat.services.nvidia.tts` | todo | not ported yet; upstream changed too (port from scratch later) | [#5580](https://github.com/pipecat-ai/pipecat/pull/5580) |
| `openai` | `pipecat.adapters.services.open_ai_live_adapter` | d | moved to pipecat.adapters.llm.* (#6331); old path is a deprecated re-export shim | [#6331](https://github.com/pipecat-ai/pipecat/pull/6331) |
| `openai` | `pipecat.adapters.services.open_ai_realtime_adapter` | d | moved to pipecat.adapters.llm.* (#6331); old path is a deprecated re-export shim | [#6331](https://github.com/pipecat-ai/pipecat/pull/6331) |
| `openai` | `pipecat.adapters.services.open_ai_responses_adapter` | d | moved to pipecat.adapters.llm.* (#6331); old path is a deprecated re-export shim | [#6331](https://github.com/pipecat-ai/pipecat/pull/6331) |
| `openai` | `pipecat.services.openai.responses.llm` | c | WS service rewritten to use 16 stream_id lanes (abandon cancelled responses, no drain); empty-response warning+error; _token_usage hook; terra default | [#6174](https://github.com/pipecat-ai/pipecat/pull/6174), [#6434](https://github.com/pipecat-ai/pipecat/pull/6434), [#6348](https://github.com/pipecat-ai/pipecat/pull/6348), [#6331](https://github.com/pipecat-ai/pipecat/pull/6331), [#5985](https://github.com/pipecat-ai/pipecat/pull/5985) |
| `openai` | `pipecat.services.openai.image` | b | New moderation setting ("low"/"auto", default None) passed to images.generate | [#6432](https://github.com/pipecat-ai/pipecat/pull/6432) |
| `openai` | `pipecat.services.openai.realtime.events` | b | Imports moved to adapters.llm.schemas; Usage/Response fields all optional; unknown server event types parse to None, no raise | [#6329](https://github.com/pipecat-ai/pipecat/pull/6329), [#6331](https://github.com/pipecat-ai/pipecat/pull/6331) |
| `openai` | `pipecat.services.openai.realtime.llm` | b | Protocol tolerance: _auth_headers() hook, skip unparsed (None) events, None-safe usage/status_details/output in response.done | [#6329](https://github.com/pipecat-ai/pipecat/pull/6329), [#6331](https://github.com/pipecat-ai/pipecat/pull/6331) |
| `openai` | `pipecat.services.openai.base_llm` | a | import paths only (adapters moved to adapters.llm) / annotations; AST-identical otherwise | [#6331](https://github.com/pipecat-ai/pipecat/pull/6331) |
| `openai` | `pipecat.services.openai.live.llm` | a | import paths only (adapters moved to adapters.llm) / annotations; AST-identical otherwise | [#6331](https://github.com/pipecat-ai/pipecat/pull/6331) |
| `openai` | `pipecat.services.openai.llm` | a | import paths only (adapters moved to adapters.llm) / annotations; AST-identical otherwise | [#6331](https://github.com/pipecat-ai/pipecat/pull/6331) |
| `openrouter` | `pipecat.services.openrouter.llm` | a | import paths only (adapters moved to adapters.llm) / annotations; AST-identical otherwise | [#6331](https://github.com/pipecat-ai/pipecat/pull/6331) |
| `perplexity` | `pipecat.adapters.services.perplexity_adapter` | d | moved to pipecat.adapters.llm.* (#6331); old path is a deprecated re-export shim | [#6331](https://github.com/pipecat-ai/pipecat/pull/6331) |
| `perplexity` | `pipecat.services.perplexity.llm` | c | New PerplexityAgentHttpLLMService (Agent API via OpenAI Responses: preset, web_search, max_steps); Sonar deprecated | [#6331](https://github.com/pipecat-ai/pipecat/pull/6331), [#5985](https://github.com/pipecat-ai/pipecat/pull/5985) |
| `runner` | `pipecat.runner.utils` | b | Twilio serializer in the runner now gets api_key_sid/api_key_secret/region/edge from TWILIO_API_KEY/SECRET/REGION/EDGE env vars | [#6293](https://github.com/pipecat-ai/pipecat/pull/6293) |
| `sambanova` | `pipecat.services.sambanova.llm` | a | import paths only (adapters moved to adapters.llm) / annotations; AST-identical otherwise | [#6331](https://github.com/pipecat-ai/pipecat/pull/6331) |
| `sarvam` | `pipecat.services.sarvam.stt` | b | Waits for session.begin before on_connected, close code 4000 becomes INVALID_REQUEST, a dropped utterance pushes its last partial as final | [#6342](https://github.com/pipecat-ai/pipecat/pull/6342) |
| `sarvam` | `pipecat.services.sarvam.llm` | a | import paths only (adapters moved to adapters.llm) / annotations; AST-identical otherwise | [#6331](https://github.com/pipecat-ai/pipecat/pull/6331) |
| `serializer-twilio` | `pipecat.serializers.twilio` | b | Auto hang-up accepts API key auth (api_key_sid + api_key_secret) as an alternative to auth_token, with exclusivity/pair validation | [#6270](https://github.com/pipecat-ai/pipecat/pull/6270) |
| `smallest` | `pipecat.services.smallest.tts` | b | New date_format setting (EU/US) sent in msg; content_filter accepts 'redact' | [#6431](https://github.com/pipecat-ai/pipecat/pull/6431) |
| `speechify` | `pipecat.services.speechify.tts` | b | Default model simba-3.2 -> simba-3.5; new pronunciations setting added to payload | [#6436](https://github.com/pipecat-ai/pipecat/pull/6436), [#6298](https://github.com/pipecat-ai/pipecat/pull/6298) |
| `speechmatics` | `pipecat.services.speechmatics.stt` | a | docstrings/comments/annotations only (AST-identical) | [#6197](https://github.com/pipecat-ai/pipecat/pull/6197) |
| `tavus` | `pipecat.services.tavus.video` | todo | not ported yet; upstream changed too (port from scratch later) | [#6291](https://github.com/pipecat-ai/pipecat/pull/6291) |
| `together` | `pipecat.services.together.llm` | b | New reasoning_effort setting (default None) sent as reasoning_effort param when set; adapter import moved | [#6437](https://github.com/pipecat-ai/pipecat/pull/6437), [#6331](https://github.com/pipecat-ai/pipecat/pull/6331) |
| `transport-daily` | `pipecat.transports.daily.transport` | todo | not ported yet; upstream changed too (port from scratch later) | [#6341](https://github.com/pipecat-ai/pipecat/pull/6341), [#6321](https://github.com/pipecat-ai/pipecat/pull/6321), [#6197](https://github.com/pipecat-ai/pipecat/pull/6197) |
| `transport-lemonslice` | `pipecat.transports.lemonslice.api` | todo | not ported yet; upstream changed too (port from scratch later) | [#6310](https://github.com/pipecat-ai/pipecat/pull/6310) |
| `transport-lemonslice` | `pipecat.transports.lemonslice.transport` | todo | not ported yet; upstream changed too (port from scratch later) | [#6310](https://github.com/pipecat-ai/pipecat/pull/6310) |
| `transport-livekit` | `pipecat.transports.livekit.transport` | a | docstrings/comments/annotations only (AST-identical) | [#6197](https://github.com/pipecat-ai/pipecat/pull/6197) |
| `transport-moq` | `pipecat.transports.moq.transport` | todo | not ported yet; upstream changed too (port from scratch later) | [#6243](https://github.com/pipecat-ai/pipecat/pull/6243), [#6262](https://github.com/pipecat-ai/pipecat/pull/6262) |
| `transport-tavus` | `pipecat.transports.tavus.transport` | todo | not ported yet; upstream changed too (port from scratch later) | [#6291](https://github.com/pipecat-ai/pipecat/pull/6291) |
| `ultravox` | `pipecat.services.ultravox.llm` | a | import paths only (adapters moved to adapters.llm) / annotations; AST-identical otherwise | [#6331](https://github.com/pipecat-ai/pipecat/pull/6331) |
| `xai` | `pipecat.services.xai.llm` | a | import paths only (adapters moved to adapters.llm) / annotations; AST-identical otherwise | [#6331](https://github.com/pipecat-ai/pipecat/pull/6331) |
| `xai` | `pipecat.services.xai.realtime.events` | a | import paths only (adapters moved to adapters.llm) / annotations; AST-identical otherwise | [#6331](https://github.com/pipecat-ai/pipecat/pull/6331) |
| `xai` | `pipecat.services.xai.realtime.llm` | a | import paths only (adapters moved to adapters.llm) / annotations; AST-identical otherwise | [#6331](https://github.com/pipecat-ai/pipecat/pull/6331) |

## Changed tests

| Package | Module | Class | Reason | Upstream PRs |
|---|---|---|---|---|
| `core` | `test_context_aggregators_universal.py` | d | Adapter import path changes plus new turn-rework tests (extending strategy lists, resumed/interrupt/cancel); one LLM completion test removed | [#6346](https://github.com/pipecat-ai/pipecat/pull/6346), [#6331](https://github.com/pipecat-ai/pipecat/pull/6331) |
| `core` | `test_eager_end_of_turn_mixin.py` | d | EagerEndOfTurnCancelFrame -> UserTurnResponseCancelFrame rename (turn-strategy redesign) | [#6346](https://github.com/pipecat-ai/pipecat/pull/6346) |
| `core` | `test_eager_user_turn_strategies.py` | d | Frame renames plus new tests: a speculated turn passes the LLM before its response, and speech voids a pending confirmation | [#6385](https://github.com/pipecat-ai/pipecat/pull/6385), [#6346](https://github.com/pipecat-ai/pipecat/pull/6346) |
| `core` | `test_krisp_ip_user_turn_start_strategy.py` | d | Drops all ProcessFrameResult return assertions since start strategies no longer return a result | [#6346](https://github.com/pipecat-ai/pipecat/pull/6346) |
| `core` | `test_speculation_gate.py` | d | EagerEndOfTurnCancelFrame renamed UserTurnResponseCancelFrame throughout; name-only, but from refactor (2) | [#6346](https://github.com/pipecat-ai/pipecat/pull/6346) |
| `core` | `test_user_bot_latency_observer.py` | d | Test marker processor must call _track_pushed_frame from push_frame; mixin no longer hooks push_frame itself | [#6346](https://github.com/pipecat-ai/pipecat/pull/6346) |
| `core` | `test_user_turn_completion_mixin.py` | d | Latch/timeout tests removed; new TestUserTurnCompletionReports: markers reported upstream as UserTurnCompletionFrame with context id | [#6346](https://github.com/pipecat-ai/pipecat/pull/6346) |
| `core` | `test_user_turn_controller.py` | d | Turn-start rework: ~700 lines of new tests for StrategyMode ALL/FIRST, merge modes, report_user_turn_started | [#6346](https://github.com/pipecat-ai/pipecat/pull/6346) |
| `core` | `test_user_turn_processor.py` | d | Adds test_user_turn_resumed for the new on_user_turn_resumed event | [#6346](https://github.com/pipecat-ai/pipecat/pull/6346) |
| `core` | `test_user_turn_start_strategy.py` | d | trigger_user_turn_started -> report_user_turn_started; new tests for overrides of the deprecated trigger | [#6346](https://github.com/pipecat-ai/pipecat/pull/6346) |
| `core` | `test_user_turn_stop_strategy.py` | d | Stop-strategy votes rework: report_* API, decide-once semantics, deprecated trigger override compat, speculation warnings | [#6346](https://github.com/pipecat-ai/pipecat/pull/6346) |
| `core` | `test_wake_phrase_user_turn_start_strategy.py` | d | Turn-start rework: ProcessFrameResult asserts -> None; new TestWakePhraseWithAllStartMode suite (StrategyMode.ALL) | [#6346](https://github.com/pipecat-ai/pipecat/pull/6346) |
| `core` | `test_llm_with_backend.py` | c | ~14 new PredictiveDelegation tests (classifier races frontend), package split imports, renamed prompt constants | [#6435](https://github.com/pipecat-ai/pipecat/pull/6435), [#6174](https://github.com/pipecat-ai/pipecat/pull/6174) |
| `core` | `test_websocket_service.py` | c | New tests for _receive_until_confirmed and bounded send (ws_send_timeout default 5s aborts the transport as ConnectionClosed 1006) | [#6242](https://github.com/pipecat-ai/pipecat/pull/6242), [#6251](https://github.com/pipecat-ai/pipecat/pull/6251) |
| `core` | `test_aggregated_frame_sequencer.py` | b | One new no-tracker trimming test; resync-with-markup test split/renamed with new raw_text expectations | [#6368](https://github.com/pipecat-ai/pipecat/pull/6368), [#6366](https://github.com/pipecat-ai/pipecat/pull/6366) |
| `core` | `test_audio_volume.py` | b | New test: AudioVolumeTracker update works while a numpy view of measured buffer is held (Python buffer-export bug) | [#6425](https://github.com/pipecat-ai/pipecat/pull/6425) |
| `core` | `test_base_worker.py` | b | New test: worker answering a foreign flush probe releases it once settled (one flush id across legs) | [#6268](https://github.com/pipecat-ai/pipecat/pull/6268) |
| `core` | `test_classifiers_clef.py` | b | Two tests: ssl.SSLError during ask/connect surfaces as ClassifierError ('failed' / 'could not connect') | [#6409](https://github.com/pipecat-ai/pipecat/pull/6409) |
| `core` | `test_classifiers_jev.py` | b | Two tests: ssl.SSLError during ask/connect surfaces as ClassifierError ('failed' / 'could not connect') | [#6409](https://github.com/pipecat-ai/pipecat/pull/6409) |
| `core` | `test_classifiers_openai_decisions.py` | b | Two tests: TLS error at ask() and connect() becomes ClassifierError | [#6409](https://github.com/pipecat-ai/pipecat/pull/6409) |
| `core` | `test_frame_processor.py` | b | Three tests for new FrameProcessor._cancel_frame_in_progress(target) keeping the queue | [#6174](https://github.com/pipecat-ai/pipecat/pull/6174) |
| `core` | `test_pattern_pair_aggregator.py` | b | New KEEP-content-not-split test and TestPatternPairAggregatorSameDelimiter class (code fences, 5 cases) |  |
| `core` | `test_pipeline.py` | b | New flush tests (parallel pipeline, nested ServiceSwitchers); idle-timeout quiet-user test rewritten; startup tests use setup_waits_for | [#6409](https://github.com/pipecat-ai/pipecat/pull/6409), [#6356](https://github.com/pipecat-ai/pipecat/pull/6356), [#6268](https://github.com/pipecat-ai/pipecat/pull/6268) |
| `core` | `test_provider_watch_scripts.py` | b | Python repo-script tests (skipped stubs in TS): FakeShell pr_files gains changeType; new test_renames_only_fragments_the_pr_adds | [#6441](https://github.com/pipecat-ai/pipecat/pull/6441) |
| `core` | `test_redaction.py` | b | 12 new cases: long pair chains without recursion, exception names, chained credential pairs | [#6308](https://github.com/pipecat-ai/pipecat/pull/6308), [#6283](https://github.com/pipecat-ai/pipecat/pull/6283), [#6282](https://github.com/pipecat-ai/pipecat/pull/6282) |
| `core` | `test_rtvi_observer_pushes.py` | b | New tests for expression sounds/modes in bot-output segments and skipping text with no words | [#6303](https://github.com/pipecat-ai/pipecat/pull/6303), [#6351](https://github.com/pipecat-ai/pipecat/pull/6351) |
| `core` | `test_service_switcher.py` | b | New test: metadata frame from outside the switcher reaches all member services, passed on once | [#6385](https://github.com/pipecat-ai/pipecat/pull/6385), [#6365](https://github.com/pipecat-ai/pipecat/pull/6365) |
| `core` | `test_skip_tags_aggregator.py` | b | Two new tests: punctuation inside closed <spell> tags isn't a sentence boundary |  |
| `core` | `test_text_segment_map.py` | b | Expectation changed: llm_pos now advances past a closing tag written against the last word (9 -> 16) | [#6368](https://github.com/pipecat-ai/pipecat/pull/6368) |
| `core` | `test_text_type_deprecations.py` | b | BotOutputMessageData now also accepts/serializes output_type alongside text_type and aggregated_by | [#6351](https://github.com/pipecat-ai/pipecat/pull/6351) |
| `core` | `test_tts_frame_ordering.py` | b | New tests: skipped frame ordering, context keeps LLM text, transform-stripped text not pausing, filter reset across replies | [#6303](https://github.com/pipecat-ai/pipecat/pull/6303), [#6366](https://github.com/pipecat-ai/pipecat/pull/6366) |
| `core` | `test_utils_string.py` | b | parse_start_end_tags returns the opening tag's position (not the end); supports several pairs and identical start/end delimiters | [#6367](https://github.com/pipecat-ai/pipecat/pull/6367) |
| `core` | `test_voice_formatting.py` | b | New strip_markdown cases (content asterisks, bullets, strikethrough, links, rules) and StripMarkdown/strip_urls option |  |
| `core` | `test_word_completion_tracker.py` | b | Closing tag now attributed to the word it touches; new TestTagsOnlyTheLLMTextCarries (llm_markup) cases | [#6303](https://github.com/pipecat-ai/pipecat/pull/6303), [#6368](https://github.com/pipecat-ai/pipecat/pull/6368) |
| `core` | `test_app_resources.py` | a | import paths only (adapters moved to adapters.llm) / annotations; AST-identical otherwise | [#6331](https://github.com/pipecat-ai/pipecat/pull/6331) |
| `core` | `test_auto_register_tools.py` | a | import paths only (adapters moved to adapters.llm) / annotations; AST-identical otherwise | [#6331](https://github.com/pipecat-ai/pipecat/pull/6331) |
| `core` | `test_backend_llm_worker.py` | a | import paths only (adapters moved to adapters.llm) / annotations; AST-identical otherwise | [#6331](https://github.com/pipecat-ai/pipecat/pull/6331) |
| `core` | `test_bus_json_serializer.py` | a | import paths only (adapters moved to adapters.llm) / annotations; AST-identical otherwise | [#6331](https://github.com/pipecat-ai/pipecat/pull/6331) |
| `core` | `test_deprecation_markers.py` | a | Only adds deprecation-warning tests (EagerEndOfTurnCancelFrame alias, deferred(), ExternalUserTurnCompletionStopStrategy) | [#6346](https://github.com/pipecat-ai/pipecat/pull/6346) |
| `core` | `test_direct_functions.py` | a | import paths only (adapters moved to adapters.llm) / annotations; AST-identical otherwise | [#6331](https://github.com/pipecat-ai/pipecat/pull/6331) |
| `core` | `test_frame_adapters.py` | a | import paths only (adapters moved to adapters.llm) / annotations; AST-identical otherwise | [#6331](https://github.com/pipecat-ai/pipecat/pull/6331) |
| `core` | `test_llm_context.py` | a | import paths only (adapters moved to adapters.llm) / annotations; AST-identical otherwise | [#6331](https://github.com/pipecat-ai/pipecat/pull/6331) |
| `core` | `test_llm_service.py` | a | import paths only (adapters moved to adapters.llm) / annotations; AST-identical otherwise | [#6331](https://github.com/pipecat-ai/pipecat/pull/6331) |
| `core` | `test_llm_switcher.py` | a | import paths only (adapters moved to adapters.llm) / annotations; AST-identical otherwise | [#6331](https://github.com/pipecat-ai/pipecat/pull/6331) |
| `core` | `test_markdown_text_filter.py` | a | Only adds a test asserting MarkdownTextFilter() warns DeprecationWarning (deprecation-only, not ported) |  |
| `core` | `test_realtime_service_tool_sync.py` | a | Import paths only (adapters.schemas/services -> adapters.llm.*), refactor (1) | [#6331](https://github.com/pipecat-ai/pipecat/pull/6331) |
| `core` | `test_websocket_service_usable.py` | a | Only wraps send_with_retry in assertWarns(DeprecationWarning); deprecation-only, not ported | [#6300](https://github.com/pipecat-ai/pipecat/pull/6300) |
| `anthropic` | `test_file_resolver.py` | todo | not ported yet; upstream changed too (port from scratch later) | [#6331](https://github.com/pipecat-ai/pipecat/pull/6331) |
| `anthropic` | `test_function_calling_adapters.py` | todo | not ported yet; upstream changed too (port from scratch later) | [#6331](https://github.com/pipecat-ai/pipecat/pull/6331) |
| `anthropic` | `test_get_llm_invocation_params.py` | todo | not ported yet; upstream changed too (port from scratch later) | [#6229](https://github.com/pipecat-ai/pipecat/pull/6229), [#6331](https://github.com/pipecat-ai/pipecat/pull/6331) |
| `anthropic` | `test_llm_token_usage_live.py` | todo | not ported yet; upstream changed too (port from scratch later) | [#6339](https://github.com/pipecat-ai/pipecat/pull/6339), [#6331](https://github.com/pipecat-ai/pipecat/pull/6331) |
| `anthropic` | `test_run_inference.py` | todo | not ported yet; upstream changed too (port from scratch later) | [#6331](https://github.com/pipecat-ai/pipecat/pull/6331) |
| `anthropic` | `test_anthropic_llm_context_conversion.py` | a | import paths only (adapters moved to adapters.llm) / annotations; AST-identical otherwise | [#6331](https://github.com/pipecat-ai/pipecat/pull/6331) |
| `audio-aic-filter` | `test_aic_filter.py` | todo | not ported yet; upstream changed too (port from scratch later) | [#6181](https://github.com/pipecat-ai/pipecat/pull/6181) |
| `audio-krisp-viva-filter` | `test_krisp_viva_filter.py` | todo | not ported yet; upstream changed too (port from scratch later) | [#6317](https://github.com/pipecat-ai/pipecat/pull/6317) |
| `aws` | `test_realtime_intermediate_results.py` | todo | not ported yet; upstream changed too (port from scratch later) | [#6329](https://github.com/pipecat-ai/pipecat/pull/6329) |
| `aws` | `test_aws_bedrock_llm_context_conversion.py` | a | import paths only (adapters moved to adapters.llm) / annotations; AST-identical otherwise | [#6331](https://github.com/pipecat-ai/pipecat/pull/6331) |
| `azure` | `test_openai_compatible_api_key.py` | b | Adds SmallestLLMService to provider list and NvidiaOmniLLMService to key-optional set | [#6339](https://github.com/pipecat-ai/pipecat/pull/6339), [#6085](https://github.com/pipecat-ai/pipecat/pull/6085) |
| `azure` | `test_azure_voice_live_adapter.py` | a | import paths only (adapters moved to adapters.llm) / annotations; AST-identical otherwise | [#6331](https://github.com/pipecat-ai/pipecat/pull/6331) |
| `azure` | `test_azure_voice_live_service.py` | a | import paths only (adapters moved to adapters.llm) / annotations; AST-identical otherwise | [#6331](https://github.com/pipecat-ai/pipecat/pull/6331) |
| `cartesia` | `test_cartesia_tts.py` | c | Large additions: locale/accent mapping tests, Cartesia expression adapter suite, word-timestamp/marks tests | [#6429](https://github.com/pipecat-ai/pipecat/pull/6429), [#6315](https://github.com/pipecat-ai/pipecat/pull/6315), [#6303](https://github.com/pipecat-ai/pipecat/pull/6303), [#6275](https://github.com/pipecat-ai/pipecat/pull/6275), [#6261](https://github.com/pipecat-ai/pipecat/pull/6261) |
| `cartesia` | `test_stt_send_retry_first_connect.py` | c | removed upstream (merged into test_cartesia_turns_stt_reconnect) | [#6242](https://github.com/pipecat-ai/pipecat/pull/6242) |
| `deepgram` | `test_deepgram_flux_tts.py` | b | Two tests: 400 with dg-error header makes Flux TTS unusable with refusal text; 503 leaves it usable | [#6248](https://github.com/pipecat-ai/pipecat/pull/6248) |
| `deepgram` | `test_deepgram_tts.py` | b | Rejection helper takes a dg-error reason; new test that refusal reason reaches on_connection_error | [#6248](https://github.com/pipecat-ai/pipecat/pull/6248) |
| `deepseek` | `test_openai_compatible_extra_body.py` | a | import paths only (adapters moved to adapters.llm) / annotations; AST-identical otherwise | [#6331](https://github.com/pipecat-ai/pipecat/pull/6331) |
| `elevenlabs` | `test_elevenlabs_dialogue_tts.py` | c | New audio-tag word-timestamp tests and ElevenLabs audio-tag expression adapter suite | [#6442](https://github.com/pipecat-ai/pipecat/pull/6442), [#6385](https://github.com/pipecat-ai/pipecat/pull/6385), [#6303](https://github.com/pipecat-ai/pipecat/pull/6303) |
| `elevenlabs` | `test_elevenlabs_tts.py` | b | ~7 new tests: wordless alignment advances clock, HTTP expression adapter per model, audio tags as words in HTTP word timestamps | [#6385](https://github.com/pipecat-ai/pipecat/pull/6385), [#6315](https://github.com/pipecat-ai/pipecat/pull/6315), [#6303](https://github.com/pipecat-ai/pipecat/pull/6303), [#6297](https://github.com/pipecat-ai/pipecat/pull/6297) |
| `evals` | `test_evals_conversation_observer.py` | b | Existing test now pushes a speculative LLMContextUserTurnFrame first, which must not be reported twice | [#6385](https://github.com/pipecat-ai/pipecat/pull/6385) |
| `evals` | `test_evals_scenario.py` | b | Tests for new text_matches expectation (string or list, bad regex/non-str rejected, invalid with absent) | [#5991](https://github.com/pipecat-ai/pipecat/pull/5991) |
| `evals` | `test_evals_session.py` | b | text_matches checks, expression (delivery/sounds/pauses) events from bot-output, bot-output text_type->output_type | [#5991](https://github.com/pipecat-ai/pipecat/pull/5991), [#6303](https://github.com/pipecat-ai/pipecat/pull/6303), [#6351](https://github.com/pipecat-ai/pipecat/pull/6351) |
| `evals` | `test_evals_transport.py` | b | New TestUserImageRequests: a request with no image gets an error callback; with an image it is served | [#6350](https://github.com/pipecat-ai/pipecat/pull/6350) |
| `evals` | `test_runner_utils.py` | b | New TestTwilioSerializerFromEnv: auth token, API key/secret, region/edge from env; token+key together rejected | [#6293](https://github.com/pipecat-ai/pipecat/pull/6293) |
| `fish` | `test_fish_tts.py` | c | New TestS2ExpressionAdapter suite + model-to-adapter parametrized test for expressive conversation | [#6442](https://github.com/pipecat-ai/pipecat/pull/6442), [#6303](https://github.com/pipecat-ai/pipecat/pull/6303) |
| `google` | `test_google_thinking_defaults.py` | b | Vertex default model expectation changed gemini-3.6-flash -> gemini-3.8-flash | [#6259](https://github.com/pipecat-ai/pipecat/pull/6259) |
| `google` | `test_google_stream_timeout.py` | a | import paths only (adapters moved to adapters.llm) / annotations; AST-identical otherwise | [#6331](https://github.com/pipecat-ai/pipecat/pull/6331) |
| `minimax` | `test_minimax_tts_language.py` | b | Parametrized test: InputParams accept documented emotions (calm, whisper, happy, neutral) | [#6302](https://github.com/pipecat-ai/pipecat/pull/6302) |
| `mistral` | `test_mistral_llm.py` | a | import paths only (adapters moved to adapters.llm) / annotations; AST-identical otherwise | [#6331](https://github.com/pipecat-ai/pipecat/pull/6331) |
| `openai` | `test_openai_responses_websocket.py` | c | Drain tests replaced by response 'lanes' (stream_id) suite + new empty-response error tests | [#6174](https://github.com/pipecat-ai/pipecat/pull/6174), [#6348](https://github.com/pipecat-ai/pipecat/pull/6348) |
| `openai` | `test_openai_image_gen.py` | b | New test: moderation setting forwarded to images.generate | [#6432](https://github.com/pipecat-ai/pipecat/pull/6432) |
| `openai` | `test_openai_realtime_usage_metrics.py` | b | Two tests: response.done without usage skips usage metrics; failed response without status_details pushes error | [#6329](https://github.com/pipecat-ai/pipecat/pull/6329) |
| `openai` | `test_openai_responses_http.py` | b | New TestHttpEmptyResponse class: empty/reasoning-only/refusal responses push a non-fatal error | [#6348](https://github.com/pipecat-ai/pipecat/pull/6348) |
| `openai` | `test_openai_live_service.py` | a | import paths only (adapters moved to adapters.llm) / annotations; AST-identical otherwise | [#6331](https://github.com/pipecat-ai/pipecat/pull/6331) |
| `openai` | `test_openai_llm_timeout.py` | a | import paths only (adapters moved to adapters.llm) / annotations; AST-identical otherwise | [#6331](https://github.com/pipecat-ai/pipecat/pull/6331) |
| `openai` | `test_openai_responses_logging.py` | a | import paths only (adapters moved to adapters.llm) / annotations; AST-identical otherwise | [#6331](https://github.com/pipecat-ai/pipecat/pull/6331) |
| `openai` | `test_sarvam_llm.py` | a | import paths only (adapters moved to adapters.llm) / annotations; AST-identical otherwise | [#6331](https://github.com/pipecat-ai/pipecat/pull/6331) |
| `openai` | `test_ui_worker.py` | a | import paths only (adapters moved to adapters.llm) / annotations; AST-identical otherwise | [#6331](https://github.com/pipecat-ai/pipecat/pull/6331) |
| `runner` | `test_moq_transport.py` | b | New tests: 'moq: no error' close counts as peer-gone/normal; publish_audio pacing reset/teardown mid-sleep, late-wake clock | [#6243](https://github.com/pipecat-ai/pipecat/pull/6243), [#6262](https://github.com/pipecat-ai/pipecat/pull/6262) |
| `sarvam` | `test_sarvam_stt.py` | c | New reconnect suite with fake Sarvam realtime: partial transcripts on drop, unconfirmed-connection retries, give-up after three | [#6342](https://github.com/pipecat-ai/pipecat/pull/6342) |
| `serializer-twilio` | `test_twilio_serializer.py` | b | ~10 tests for API-key auth: credential validation combinations and Basic auth login/password on hang-up | [#6270](https://github.com/pipecat-ai/pipecat/pull/6270) |
| `soniox` | `test_soniox_tts.py` | b | fixture sets service._expression_formatter = None; needs the TTSService expression formatter (expressive work) | [#6315](https://github.com/pipecat-ai/pipecat/pull/6315) |
| `transport-daily` | `test_daily_transport.py` | todo | not ported yet; upstream changed too (port from scratch later) | [#6341](https://github.com/pipecat-ai/pipecat/pull/6341), [#6321](https://github.com/pipecat-ai/pipecat/pull/6321) |
| `transport-tavus` | `test_tavus_transport.py` | todo | not ported yet; upstream changed too (port from scratch later) | [#6291](https://github.com/pipecat-ai/pipecat/pull/6291) |

## New upstream modules (all `todo`)

| Package | Module | Lines |
|---|---|---|
| `aic-tyto-observer` | `pipecat.observers.aic_tyto_observer` | 413 |
| `anthropic` | `pipecat.adapters.llm.services.anthropic_adapter` | 606 |
| `assemblyai` | `pipecat.services.assemblyai.tts` | 660 |
| `aws` | `pipecat.adapters.llm.services.aws_nova_sonic_adapter` | 252 |
| `aws` | `pipecat.adapters.llm.services.bedrock_adapter` | 573 |
| `azure` | `pipecat.adapters.llm.services.azure_voice_live_adapter` | 274 |
| `cartesia` | `pipecat.adapters.tts.services.cartesia_adapter` | 160 |
| `core` | `pipecat.adapters.llm` | 0 |
| `core` | `pipecat.adapters.llm.base_llm_adapter` | 569 |
| `core` | `pipecat.adapters.llm.schemas` | 0 |
| `core` | `pipecat.adapters.llm.schemas.direct_function` | 349 |
| `core` | `pipecat.adapters.llm.schemas.function_schema` | 120 |
| `core` | `pipecat.adapters.llm.schemas.tools_schema` | 109 |
| `core` | `pipecat.adapters.llm.services` | 0 |
| `core` | `pipecat.adapters.llm.services.open_ai_adapter` | 318 |
| `core` | `pipecat.adapters.tts` | 0 |
| `core` | `pipecat.adapters.tts.base_expression_adapter` | 132 |
| `core` | `pipecat.adapters.tts.services` | 0 |
| `core` | `pipecat.expressive` | 0 |
| `core` | `pipecat.expressive.expression` | 374 |
| `core` | `pipecat.expressive.formatter` | 732 |
| `core` | `pipecat.expressive.instructions` | 219 |
| `core` | `pipecat.expressive.perception` | 94 |
| `core` | `pipecat.expressive.policy` | 88 |
| `core` | `pipecat.expressive.spoken` | 189 |
| `core` | `pipecat.pipeline.llm_with_backend.connector` | 417 |
| `core` | `pipecat.pipeline.llm_with_backend.llm_with_backend` | 173 |
| `core` | `pipecat.pipeline.llm_with_backend.predictive_delegation` | 485 |
| `core` | `pipecat.pipeline.llm_with_backend.prompts` | 180 |
| `core` | `pipecat.pipeline.llm_with_backend.request_strategies` | 195 |
| `core` | `pipecat.processors.tone` | 7 |
| `core` | `pipecat.processors.tone._models` | 49 |
| `core` | `pipecat.processors.tone.reader` | 20 |
| `core` | `pipecat.processors.tone.reader.processor` | 155 |
| `core` | `pipecat.processors.tone.tagger` | 22 |
| `core` | `pipecat.processors.tone.tagger._input` | 256 |
| `core` | `pipecat.processors.tone.tagger._labels` | 261 |
| `core` | `pipecat.processors.tone.tagger.processor` | 295 |
| `core` | `pipecat.services.zoom_ai` | 5 |
| `core` | `pipecat.utils.text.tagged_llm_text_parser` | 182 |
| `core` | `pipecat.utils.text.transforms.text_transform` | 20 |
| `deepgram` | `pipecat.services.deepgram._errors` | 32 |
| `deepseek` | `pipecat.adapters.llm.services.deepseek_adapter` | 87 |
| `elevenlabs` | `pipecat.adapters.tts.services.elevenlabs_adapter` | 168 |
| `fish` | `pipecat.adapters.tts.services.fish_adapter` | 132 |
| `google` | `pipecat.adapters.llm.services.gemini_adapter` | 915 |
| `google` | `pipecat.adapters.llm.services.gemini_live_adapter` | 128 |
| `grok` | `pipecat.adapters.llm.services.grok_realtime_adapter` | 278 |
| `inworld` | `pipecat.adapters.llm.services.inworld_realtime_adapter` | 274 |
| `minimax` | `pipecat.adapters.tts.services.minimax_adapter` | 95 |
| `mistral` | `pipecat.adapters.llm.services.mistral_adapter` | 138 |
| `nvidia` | `pipecat.adapters.llm.services.nvidia_omni_adapter` | 86 |
| `nvidia` | `pipecat.adapters.services.nvidia_omni_adapter` | 21 |
| `nvidia` | `pipecat.services.nvidia.omni` | 6 |
| `nvidia` | `pipecat.services.nvidia.omni.llm` | 1070 |
| `openai` | `pipecat.adapters.llm.services.open_ai_live_adapter` | 193 |
| `openai` | `pipecat.adapters.llm.services.open_ai_realtime_adapter` | 260 |
| `openai` | `pipecat.adapters.llm.services.open_ai_responses_adapter` | 360 |
| `perplexity` | `pipecat.adapters.llm.services.perplexity_adapter` | 176 |
| `smallest` | `pipecat.services.smallest.llm` | 103 |
| `tone` | `pipecat.processors.tone.reader.model` | 168 |
| `tone` | `pipecat.processors.tone.tagger.model` | 230 |
| `zoom-ai` | `pipecat.services.zoom_ai.stt` | 727 |

`pipecat.adapters.services.nvidia_omni_adapter` is a new deprecated shim (not ported). `pipecat.pipeline.llm_with_backend`
became a package (`__init__.py` + `connector`, `llm_with_backend`, `predictive_delegation`, `prompts`, `request_strategies`).

## New upstream tests (all `todo`)

- `tests/test_adapters_llm_shims.py` (55 lines, `core`)
- `tests/test_aic_tyto_observer.py` (350 lines, `aic-tyto-observer`)
- `tests/test_assemblyai_tts.py` (610 lines, `assemblyai`)
- `tests/test_aws_bedrock_llm_thinking.py` (253 lines, `aws`)
- `tests/test_azure_realtime.py` (28 lines, `azure`)
- `tests/test_cartesia_turns_stt_reconnect.py` (292 lines, `cartesia`)
- `tests/test_expression_formatter.py` (493 lines, `cartesia`)
- `tests/test_expression_instructions.py` (284 lines, `core`)
- `tests/test_fal_stt.py` (73 lines, `fal`)
- `tests/test_inworld_tts_reconnect.py` (202 lines, `inworld`)
- `tests/test_llm_expression.py` (318 lines, `openai`)
- `tests/test_llm_text_processor.py` (209 lines, `core`)
- `tests/test_llm_turn_completion_user_turn_stop_strategy.py` (447 lines, `core`)
- `tests/test_minimax_tts_expression.py` (112 lines, `minimax`)
- `tests/test_nvidia_omni_llm.py` (1170 lines, `nvidia`)
- `tests/test_openai_realtime_events.py` (27 lines, `openai`)
- `tests/test_perplexity_agent_llm.py` (413 lines, `perplexity`)
- `tests/test_pipecat_tone_reader.py` (210 lines, `tone`)
- `tests/test_pipecat_tone_tagger.py` (728 lines, `cartesia`)
- `tests/test_rtvi_observer_perception.py` (145 lines, `core`)
- `tests/test_smallest_llm.py` (94 lines, `smallest`)
- `tests/test_spoken_expression.py` (86 lines, `core`)
- `tests/test_tagged_llm_text_parser.py` (116 lines, `core`)
- `tests/test_tavus_video.py` (75 lines, `tavus`)
- `tests/test_time_utils.py` (35 lines, `core`)
- `tests/test_tts_expression.py` (894 lines, `core`)
- `tests/test_tts_metadata.py` (124 lines, `core`)
- `tests/test_universal_names.py` (169 lines, `cartesia`)
- `tests/test_user_perception.py` (234 lines, `core`)
- `tests/test_user_turn_strategies.py` (125 lines, `core`)
- `tests/test_zoom_ai_stt.py` (939 lines, `zoom-ai`)

Removed upstream: `tests/test_stt_send_retry_first_connect.py` (its cases moved to `test_cartesia_turns_stt_reconnect.py`;
the TS port stays until the Cartesia batch replaces it).

## What to port, per entry

Notes from the triage for each b/c/d entry, for whoever ports it.

- `pipecat.adapters.services.anthropic_adapter` (d): Relocate to the adapters/llm/services path per the adapter-move refactor; body unchanged except imports.
- `pipecat.adapters.services.aws_nova_sonic_adapter` (d): Relocate/rename import paths in line with the adapters.llm move (only BaseLLMAdapter/FunctionSchema/ToolsSchema imports changed); no shim.
- `pipecat.adapters.services.bedrock_adapter` (d): Part of the adapters move (refactor 1): relocate the TS port to the adapters/llm/services path along with the other adapters. Don't port the shim. Port any body edits from the new upstream file.
- `pipecat.services.aws.llm` (b): Handle reasoningContent deltas -> LLMThoughtStart/Text/End frames (signature on end, closed in finally); route text deltas through TaggedLLMTextParser('<thinking>','</thinking>') per content block. Requires porting new utils/text/tagged_llm_text_parser first. Adapter import path change is (d).
- `pipecat.adapters.services.azure_voice_live_adapter` (d): Relocate/rename the TS adapter to match pipecat.adapters.llm.services.* and diff its logic against the new upstream file; no shim needed.
- `pipecat.services.azure.realtime.llm` (b): Requires the OpenAI realtime base to expose an async _auth_headers() used in its connect (#6329); then replace the Azure _connect override with an _auth_headers override.
- `pipecat.services.cartesia.tts` (c): Add an `accent` setting (sent when set) and the regional entries in the language map (e.g. es-MX, NB->no, FIL->tl). Merge expression_settings into generation_config via _generation_config. Set expression_adapter_class = CartesiaExpressionAdapter (needs the new adapters/tts framework from #6303, which CartesiaEmotion moves to). Pass pre_merge_tokens=cjk to addWordTimestamps.
- `pipecat.services.cartesia.turns.stt` (c): Drop reconnect_on_error=False. _connect always starts the receive loop. The close/drain logic moves into _disconnect, and audio sends only when the socket is open (no send_with_retry). _receive_messages uses _receive_until_confirmed, then starts the watchdog. Add _process_message, _end_turn_cut_short with a _turn_transcript buffer, and CartesiaTurnsRequestError raised for an error before `connected`. The doc rename to UserTurnResponseCancelFrame is a docstring change only.
- `pipecat.cli.registry._configs` (b): Add the 4 new SERVICE_CONFIGS entries and switch perplexity_llm to PerplexityAgentHttpLLMService with model default 'openai/gpt-5.6-luna' (adapt to TS class names / which services exist in pipedog).
- `pipecat.cli.registry._imports` (b): Add import entries for services that exist in pipedog (smallest LLM, AssemblyAI TTS, Zoom AI STT once ported) and switch perplexity_llm to PerplexityAgentHttpLLMService if/when that service is ported.
- `pipecat.cli.registry.service_metadata` (b): Add the 4 ServiceDefinition entries and update the perplexity_llm entry (class_name + param_defaults model). Mirror _configs.ts changes.
- `pipecat.adapters.base_llm_adapter` (d): Part of the adapters move (refactor 1). Move the TS module to adapters/llm/base_llm_adapter and update imports. Don't port the deprecated shim.
- `pipecat.adapters.schemas.direct_function` (d): Move the TS module to the adapters/llm/schemas location (content identical apart from imports) and update importers; do not port the deprecated shim.
- `pipecat.adapters.schemas.function_schema` (d): Move the TS module to the adapters/llm/schemas location (and update imports); drop the old path rather than porting the deprecation shim. Content diff should be checked against the new upstream file.
- `pipecat.adapters.schemas.tools_schema` (d): Move TS module to adapters/llm/schemas/tools_schema (content unchanged apart from import paths); drop old path, no shim needed.
- `pipecat.adapters.services.open_ai_adapter` (d): Part of the adapters move (refactor 1). Relocate to adapters/llm/services/open_ai_adapter and fix imports. Don't port the shim.
- `pipecat.classifiers.cloudflare.clef.client` (b): Make sure TLS/network-level errors (not only HttpError) from the schema GET and the run POST are wrapped as ClassifierError ('could not connect to Clef' / 'Clef request failed'). TS currently only wraps HttpError.
- `pipecat.classifiers.openai.decisions.client` (b): TS client only converts HttpError; also convert low-level network/TLS failures (fetch TypeError etc., after rethrowIfCancelled) into ClassifierError with the 'could not connect' / 'request failed' messages.
- `pipecat.classifiers.typesafe.jev.client` (b): Wrap TLS/network-level errors from GET /v1/models and POST /v1/systemone as ClassifierError, same as HTTP errors.
- `pipecat.frames.frames` (c): Add delivery to TTSTextFrame/AggregatedTextProgressFrame, perception to Transcription/Interim/EagerTranscriptionFrame, perception+speculation to LLMContextUserTurnFrame; rename EagerEndOfTurnCancelFrame->UserTurnResponseCancelFrame (no alias); add UserTurnCompletionFrame(kind, marker, context_frame_id), TTSMetadataFrame, PerceptionMetadataFrame, ExpressionMetadataFrame; PipelineFlushFrame.flush_id + toString. Depends on new expressive types (ExpressionCapabilities, PerceptionSignal/Capabilities).
- `pipecat.pipeline.service_switcher` (b): Add _inactive_service_metadata ring (64) and _share_metadata() that queues a copy to each inactive service; in the output filter drop frames whose id is in that ring, and drop metadata only when it's an inactive member's own (service_name matches a member and isn't the active one).
- `pipecat.pipeline.worker` (b): Add the `enable_expressive_conversation` and `expression_policy` params, with a warning when a policy is set without the flag, and pass both to FrameProcessorSetup. This depends on the new expressive module. Key the flush bookkeeping by `probe.flush_id`, and push a new PipelineFlushFrame (same event/origin/flush_id) on each leg instead of reusing the frame.
- `pipecat.processors.aggregators.llm_response_universal` (d): Turn refactor: add user_turn_strategies_params with merge_with/replaces_service_strategies logic, handle on_user_turn_resumed (interrupt or UserTurnResponseCancelFrame), feed pushed LLMContextFrames to the controller, broadcast the speculated LLMContextUserTurnFrame, and return the frame from push_context_frame. Expressive: perception in the user message and UserTurnStoppedMessage, ExpressionMetadataFrame, and strip_expression_tags for the context/transcript. Use raw_text for the empty check.
- `pipecat.processors.aggregators.llm_text_processor` (c): Add the textTransforms ctor option plus addTextTransformer/removeTextTransformer. Add _transformText: run the type or '*' transforms, drop on whitespace-only output, and on error pushError with APPLICATION category and drop. Add _rawText, which splices the rewritten text into PatternMatch.full_match. Track _skipTts and flush the aggregator on TTSStoppedFrame before pushing it. Depends on the new utils/text/transforms/text_transform TextTransform type.
- `pipecat.processors.frame_processor` (b): Add setup fields enableExpressiveConversation (default false) and expressionPolicy (ExpressionPolicy|null, from new pipecat.expressive.policy). Add _cancelFrameInProgress(frame): if it is the frame being processed, cancel the process task and restart it, without dropping queued frames or calling its callback; returns bool.
- `pipecat.processors.frameworks.rtvi.models` (b): Bump PROTOCOL_VERSION to 2.3.0. BotOutputMessageData: add required outputType, make textType optional, add delivery: string[]|null; the sync validator fills whichever of output_type/text_type/aggregated_by is missing from the first given (keep text_type on the wire for old clients). Add UserPerceptionLabel {label, confidence} and UserPerceptionSignal {name, labels=[], value}, and UserInputMessageData.perception.
- `pipecat.processors.frameworks.rtvi.observer` (b): Needs the expressive conversation port (PerceptionMetadataFrame, PerceptionSignal, TextType.EXPRESSION_SOUND/PAUSE, frame.delivery/perception). Track perceivers and defer transcription handling until pushed past a perceiver (_handle_transcription_push). Skip expression types for <2.3.0 clients. Send output_type and delivery. Skip whitespace-only aggregated text. Keep sounds/pauses out of tts raw/bot-tts messages. Map perception into user-input.
- `pipecat.services.llm_service` (c): Add setup() reading enable_expressive_conversation/expression_policy, handle TTSMetadataFrame/PerceptionMetadataFrame/ExpressionMetadataFrame and compose expression_instructions into the system instruction (needs pipecat.expressive.* port). Add _OutputGate (process_frame/allow_push/allow_function_calls) checks and _track_pushed_frame call in push_frame; rename EagerEndOfTurnCancelFrame handling to UserTurnResponseCancelFrame (turns refactor) and drop _filter_incomplete_user_turns init; adapter imports move.
- `pipecat.services.tts_service` (c): Large: add expression_adapter_class/getExpressionAdapter/expressionSettings/serviceMetadataFrame, ExpressionFormatter setup (SkipTagsAggregator with EXPRESSION_TAGS) and _speakExpression/_reportExpression/sound frames, plus TTSContext.spokenExpression. Filters now run inside _transformText (the context keeps the original text, whitespace-only output is dropped) and reset on interruption. Skipped/promoted frames go through the audio-context queue whenever it is available. TTSTextFrame carries raw_text. Depends on the pipecat.expressive and adapters.tts ports.
- `pipecat.services.websocket_service` (b): Add wsSendTimeout ctor option (default 5.0, null=unbounded) applied to sends on connections from _websocketConnect, dropping the connection and raising a closed error on timeout; add _receiveUntilConfirmed(messages, confirmed, handleMessage, timeout) that throws ConnectionError on timeout and sets _lastConnectTime. send_with_retry deprecation not ported.
- `pipecat.turns.eager_end_of_turn_mixin` (d): Push UserTurnResponseCancelFrame instead of EagerEndOfTurnCancelFrame when withdrawing an eager end of turn.
- `pipecat.turns.speculation_gate` (d): Swap the frame type checked in the gate to UserTurnResponseCancelFrame.
- `pipecat.turns.types` (d): Add UserTurnResumedParams {enableInterruptions, inferenceTriggered}; add optional perception: PerceptionSignal[] | null to UserTurnSpeculation (needs expressive perception types). ProcessFrameResult deprecation is not ported (drop or keep per refactor plan).
- `pipecat.turns.user_start.base_user_turn_start_strategy` (d): User-turn-start rework (refactor 2): rename triggerUserTurnStarted to reportUserTurnStarted, firing on_user_turn_started via _fireUserTurnStarted. processFrame returns nothing, and ProcessFrameResult goes away. Skip the deprecated trigger alias and override-compat logic.
- `pipecat.turns.user_start.external_user_turn_start_strategy` (d): Port as part of the user-turn-start rework: drop ProcessFrameResult return, call reportUserTurnStarted (with enableInterruptions/enableUserSpeakingFrames false when adopting UserStartedSpeakingFrame).
- `pipecat.turns.user_start.krisp_viva_ip_user_turn_start_strategy` (d): Make processFrame return void, drop ProcessFrameResult returns from helpers, call reportUserTurnStarted() instead of triggerUserTurnStarted().
- `pipecat.turns.user_start.min_words_user_turn_start_strategy` (d): processFrame returns void; on threshold call reportUserTurnStarted(), otherwise triggerResetAggregation().
- `pipecat.turns.user_start.transcription_user_turn_start_strategy` (d): Refactor (2): drop the ProcessFrameResult return and use reportUserTurnStarted().
- `pipecat.turns.user_start.vad_user_turn_start_strategy` (d): Call reportUserTurnStarted() on VADUserStartedSpeakingFrame; drop ProcessFrameResult return.
- `pipecat.turns.user_start.wake_phrase_user_turn_start_strategy` (d): Use reportUserTurnStarted(); in AWAKE state call it on VADUserStartedSpeaking/UserStartedSpeaking/ProposedUserStartedSpeaking/TranscriptionFrame and return nothing; IDLE path still returns STOP (deprecated FIRST-list gating) - decide whether pipedog keeps that.
- `pipecat.turns.user_stop.base_user_turn_stop_strategy` (d): Add reportUserTurnStopped({enableUserSpeakingFrames, confirmsSpeculation}), startUserTurnSpeculation, cancelUserTurnSpeculation, waitsForInference/decisionScheduled getters; on_user_turn_stopped now only signals this strategy's decision (controller runs inference). Old trigger_* methods and override-compat shim are deprecated, not ported.
- `pipecat.turns.user_stop.eager_user_turn_stop_strategy` (d): Part of the turn-strategy rework (refactor 2): processFrame returns nothing. Handle UserTurnResponseCancelFrame, and clear _confirmed on VAD/User/ProposedUserStartedSpeaking frames. Override reportUserTurnStopped({confirmsSpeculation}), which reuses _confirmed. Use startUserTurnSpeculation/cancelUserTurnSpeculation, and pass frame.perception into UserTurnSpeculation (#6319).
- `pipecat.turns.user_stop.external_user_turn_completion_stop_strategy` (d): Class is deprecated upstream; per conventions drop it or, if kept, set waitsForInference=true and call reportUserTurnStopped() with no return value.
- `pipecat.turns.user_stop.external_user_turn_stop_strategy` (d): Replace the event-loop task with a transcript timer restarted on each final TranscriptionFrame; add _decided flag (reset on speech/new text/reset) to avoid repeat decisions; handle VADUserStarted (clear decided) and VADUserStopped (maybe report); remove setup() task; use reportUserTurnStopped.
- `pipecat.turns.user_stop.llm_turn_completion_user_turn_stop_strategy` (d): Refactor (2): now extends BaseUserTurnStopStrategy, no longer External...CompletionStopStrategy. Tracks the awaited LLMContextFrame and handles UserTurnCompletionFrame by context_frame_id: complete/tool/no marker -> reportUserTurnStopped, short/long -> cancel speculation or start the re-prompt timer (pushes LLMMessagesAppendFrame developer prompt). Cancels on user speech, new inference or UserTurnResponseCancelFrame. Adds decisionScheduled/waitsForInference properties and handleUserTurnStarted/Stopped hooks.
- `pipecat.turns.user_stop.speech_timeout_user_turn_stop_strategy` (d): processFrame returns void; rename _maybeTriggerUserTurnStopped -> _maybeReportUserTurnStopped and call reportUserTurnStopped().
- `pipecat.turns.user_stop.turn_analyzer_user_turn_stop_strategy` (d): Part of the turn-strategy rework (refactor 2). Drop the ProcessFrameResult return and rename the calls to reportUserTurnStopped/_maybeReportUserTurnStopped.
- `pipecat.turns.user_turn_completion_mixin` (d): Remove timeout/re-prompt, _user_turn_completion_voiced, _user_speaking and push_frame override; add _filter_incomplete_user_turns, _context_frame_id (from LLMContextFrame), _track_pushed_frame(frame) called by LLMService.push_frame, _report_turn_completion pushing UserTurnCompletionFrame upstream (+broadcast UserTurnInferenceCompletedFrame on complete); LLMMarkerFrame append_immediately = kind!='complete'. Sizeable (~1-2h).
- `pipecat.turns.user_turn_controller` (d): Refactor 2 core. Add user_turn_strategies_params, start/stop decision maps, the _UserTurnInference state, StrategyMode.ALL aggregation, controller-run inference, and the on_user_turn_resumed event. Also handle UserTurnResponseCancelFrame and DeferredUserTurnStopStrategy. Drop the ProcessFrameResult deprecation warning.
- `pipecat.turns.user_turn_processor` (d): Part of refactor 2. Add the userTurnStrategiesParams constructor option passed to the controller, register and forward on_user_turn_resumed, and broadcast UserTurnResponseCancelFrame on speculation cancel.
- `pipecat.turns.user_turn_strategies` (d): Add MergeMode/StrategyMode enums, UserTurnStrategiesParams (start/stop merge modes REPLACE, start_mode FIRST, stop_mode ALL, replacesServiceStrategies), _start/_stop_extension tracking and merge_with/_merge_list; FilterIncompleteUserTurnStrategies appends the LLM gate without deferred() and to the stop extension.
- `pipecat.utils.context.aggregated_frame_sequencer` (b): Add public llmMarkup (RegExp|null) passed into WordCompletionTracker; flush/register keep tag-only LLM text (no user-facing frame emitted); force-complete compares strip_complete_markup'd remaining words against LLM text with llmMarkup removed; trim user/raw text on no-tracker TTSTextFrame. Depends on tracker llm_markup support (#6303).
- `pipecat.utils.context.text_segment_map` (b): Add an optional llmMarkup RegExp. Build _llmScan by replacing each match plus trailing spaces/tabs with '<' + spaces + '>' of the same length, and use _llmScan instead of _llmText in advance_by_chars/advance_by_alnums.
- `pipecat.utils.context.word_completion_tracker` (b): Add the llmMarkup option and forward it. In the word-belongs check, return false when strip_complete_markup(tts_text).trim() is empty.
- `pipecat.utils.security.redaction` (b): Replace _PAIR/_redact_pair with the _PAIR_START and _VALUE regexes and a while-loop _redactPairs: only a credential name takes its value whole, an exception-class name with ':' is exempt, and a credential whose value is the next credential's name yields to that one. Add the _EXCEPTION_NAME regex.
- `pipecat.utils.string` (b): Replace parseStartEndTags body with the new loop (find end of current tag, then earliest start tag among pairs, repeat) returning [currentTag|null, resumeIndex].
- `pipecat.utils.text.alnum_utils` (b): In the trailing-punctuation loop, on '<' jump past the next '>' when count>0 and a '>' exists; otherwise break as before.
- `pipecat.utils.text.base_text_aggregator` (b): Add EXPRESSION_SOUND='expression_sound' and EXPRESSION_PAUSE='expression_pause' to TextType (used by the expressive conversation feature).
- `pipecat.utils.text.pattern_pair_aggregator` (b): Extract _unmatchedStart (regex-pairing) and use it in incomplete-pattern detection and _findEarliestDroppableStart; add _keptPatternsOffset() and pass it as protectedEnd to _checkSentenceWithLookahead. (Direct commits 158f0772d, 99a2ee3cf, 4c7785eff; no PR.)
- `pipecat.utils.text.simple_text_aggregator` (b): Add optional protectedEnd param; before match_endofsentence replace sentence-ending punctuation in candidate[:protectedEnd] with spaces (same width). (Direct commit 99a2ee3cf.)
- `pipecat.utils.text.skip_tags_aggregator` (b): Add a `tags` getter and _closedTagsOffset(). Pass protected_end to the parent's _check_sentence_with_lookahead, which needs the matching SimpleTextAggregator change, and reset _currentTagIndex=0 after yielding.
- `pipecat.utils.text.transforms` (b): Re-export the TextTransform type ((text, textType) => Promise<string>, new module text_transform) and the StripMarkdown class from index.ts. The strip_markdown.ts rework (strip_markdown becomes a StripMarkdown instance with a strip_urls option) and LLMTextProcessor transforms belong to their own files.
- `pipecat.utils.text.transforms.strip_markdown` (b): Add StripMarkdown class with stripUrls (default true) and export stripMarkdown = new instance; port the new regex sequence (fences, links/images, inline code, strikethrough, spaced hrules, list bullets, content-asterisk placeholder, hugging italic). PR inferred from changelog 6295 (direct commits da7b49d58, 4dc52fc96).
- `pipecat.utils.text.transforms.voice_formatter` (b): Add the stripUrls constructor option and use a StripMarkdown instance with stripUrls (needs the strip_markdown StripMarkdown class from commit 4dc52fc96, which is not a first-parent PR).
- `pipecat.utils.time` (b): Rewrite nanosecondsToStr in packages/core/src/utils/time.ts to use integer math: totalUs = Math.trunc(ns/1000), then divmod into hours, minutes, seconds and µs (BigInt if values can exceed 2^53). Today it uses float seconds.
- `pipecat.services.deepgram.flux.stt` (b): Move _describeRefusal to a shared deepgram _errors module (cloudflare flux_stt imports it too). Replace the inline confirm loop with the new WebsocketService._receiveUntilConfirmed helper. The timeout message now uses `{self}`.
- `pipecat.services.deepgram.flux.tts` (b): In the connect catch, compute describeRefusal(e). Push ErrorFrame(refusal ?? `${this} error: ${e}`, exception e) and pass refusal ?? msg to on_connection_error.
- `pipecat.services.deepgram.tts` (b): Port the new services/deepgram/_errors.py describe_refusal helper (32 lines). In _connectWebsocket's catch, use `refusal ?? `${this} error: ${e}`` for both the ErrorFrame and on_connection_error, and drop the logger.error.
- `pipecat.adapters.services.deepseek_adapter` (d): Refactor (1): remap the TS port's upstream source to src/pipecat/adapters/llm/services/deepseek_adapter.py (content unchanged apart from the OpenAILLMAdapter import path). Don't port the shim.
- `pipecat.services.elevenlabs.dialogue.tts` (b): Add expression adapter class and audio_tags flag to word-time calculation. Depends on the expressive-conversation TTS expression adapter framework (adapters/tts/*, _expression_formatter in TTSService), which is new upstream.
- `pipecat.services.elevenlabs.tts` (c): WS receive loop: move the cumulative-time update out of the word branch so every alignment chunk advances it, falling back to the last word time only when words exist. HTTP: add getExpressionAdapter, which returns ElevenLabsAudioTagExpressionAdapter for eleven_v3/v4 models. Add an audioTags option to calculateWordTimes so a bracketed tag counts as one word (uses _ends_in_audio_tag from tts_base). Depends on the #6303 adapters/tts framework.
- `pipecat.services.elevenlabs.tts_base` (b): Add audio_tags option to calculateWordTimes plus _ends_in_audio_tag helper; when on, spaces inside [...] don't split words and in_tag state is seeded from the carried partial word.
- `pipecat.evals.conversation_observer` (b): In the observer, return early for an LLMContextUserTurnFrame whose `speculation` flag is set. This needs the new `speculation` field on LLMContextUserTurnFrame.
- `pipecat.evals.events` (b): Change backchannel check to data.output_type; add _expression_event (sound/pause segments deduped by segment_id, delivery changes -> <<...>>) with state reset on llm_started. Depends on RTVI bot-output fields (output_type, delivery, segment_id) from #6303/#6351.
- `pipecat.evals.fastapi_transport` (b): When no image is registered, call `_answer_image_requests([request], "No user image is registered.")` (base input-transport helper) instead of warning and returning.
- `pipecat.evals.matcher` (b): Add `_textUnmatched()`: each pattern in expectation.text_matches must re.search the content, otherwise fail with 'text_unmatched'. Call it after an aggregate passes and after the text_excluded check for events. Needs the `text_matches` field on EvalExpectation.
- `pipecat.evals.results` (b): Add 'text_unmatched' to FAILURE_KINDS; meaningful only together with the text_matches regex expectation from #5991 in the evals expectation/matcher modules.
- `pipecat.evals.script` (b): Add EvalExpectation.textMatches (string or string[] normalized to list; each compiled at parse, error names the bad pattern; disallowed with absent). Add 'expression' to JUDGEABLE_EVENTS and to the aggregates() reply-event set. The harness that checks text_matches is likely elsewhere.
- `pipecat.evals.transport` (b): In EvalInputTransport.processFrame, when no image is registered, call this._answerImageRequests([request], 'No user image is registered.') instead of warning and returning. Needs _answerImageRequests on the base input transport (exists in livekit TS; check it is on the websocket base).
- `pipecat.services.fish.tts` (b): Override getExpressionAdapter() returning a FishAudioS2ExpressionAdapter when settings.model starts with 's2'. Requires the expressive-conversation infra (BaseExpressionAdapter, adapters/tts/services/fish_adapter) from #6303 first.
- `pipecat.adapters.services.gemini_adapter` (d): Relocate the TS gemini adapter per the adapters.llm layout and re-diff against the new upstream file for any changes carried in the move; no shim.
- `pipecat.adapters.services.gemini_live_adapter` (d): Part of the adapters move (refactor 1): relocate/rename the module in the TS port to match the new path. Diff the new upstream file for body changes. No shim needed.
- `pipecat.services.google.vertex.llm` (b): Change default model to gemini-3.8-flash and update the GeminiVertexLLMAdapter import path per the adapters.llm move.
- `pipecat.adapters.services.grok_realtime_adapter` (d): Relocate/rename import paths in line with the adapters.llm move (only imports changed); no shim.
- `pipecat.services.inception.llm` (b): Change default model to 'mercury-3' (trivial); adapter import path follows the adapter-move refactor.
- `pipecat.adapters.services.inworld_realtime_adapter` (d): Part of the adapters move (refactor 1): relocate the TS module to the adapters/llm/services path. Check the new upstream file for body edits. No shim needed.
- `pipecat.services.inworld.tts` (b): Replace send_with_retry with direct websocket sends; mark context sent only after create succeeds; add _receive_loop_running and use it in _connect and run_tts (push error and return if ws not OPEN while the loop runs); catch errors in flush and in close-context during disconnect.
- `pipecat.services.minimax.tts` (b): Add 'calm' and 'whisper' to the supportedEmotions list. Add getExpressionAdapter, which returns MiniMaxExpressionAdapter for models starting with speech-2.8. Spread this.expressionSettings into voice_setting. The adapter part depends on the #6303 expressive-conversation framework.
- `pipecat.adapters.services.mistral_adapter` (d): Part of the adapters move (refactor 1). Relocate/rename the module path to match adapters/llm/services and fix imports. Don't port the shim.
- `pipecat.adapters.services.open_ai_live_adapter` (d): Relocate the TS adapter per the adapters.llm layout and re-diff against the new upstream file; no shim.
- `pipecat.adapters.services.open_ai_realtime_adapter` (d): Relocate to the adapters/llm/services path per the adapter-move refactor; body unchanged except imports.
- `pipecat.adapters.services.open_ai_responses_adapter` (d): Relocate to the adapters/llm/services path per the adapter-move refactor; body unchanged except imports.
- `pipecat.services.openai.image` (b): Add OpenAIImageModeration type and moderation field to OpenAIImageGenSettings (default null) and pass it to images.generate.
- `pipecat.services.openai.realtime.events` (b): Make Usage fields and Response id/object/status/status_details/output optional (default null). parseServerEvent returns null for unknown event types instead of throwing, and callers must handle null. Update the schema import paths for refactor (1).
- `pipecat.services.openai.realtime.llm` (b): Extract auth header building into overridable async _authHeaders(); skip events parse_server_event returns null for; guard null usage (default token counts 0), status_details error message fallback 'Response failed', and null output list. Requires events.parse_server_event to return None for unknown events.
- `pipecat.services.openai.responses.llm` (c): Replace the cancel/drain state (_currentResponseId, _needsDrain, _drainCancelledResponse) with lane tracking: _chooseNextResponseLane, _drainingLanes, _previousResponseLane, a stream_id on response.create, and discarding other lanes' events. Add _reportEmptyResponse, called on completion with no text or function call, in both WS and HTTP. Extract the HTTP _tokenUsage(usage) hook, add the gpt-6.1-terra thinking default 'none', and update the adapter import to the adapters/llm path (refactor 1).
- `pipecat.adapters.services.perplexity_adapter` (d): Refactor (1): remap the TS port's upstream source to src/pipecat/adapters/llm/services/perplexity_adapter.py (content unchanged apart from the import path). Don't port the shim.
- `pipecat.services.perplexity.llm` (c): Port PerplexityAgentLLMSettings (preset, webSearch, maxSteps) and PerplexityAgentHttpLLMService on top of the OpenAI Responses HTTP service. Default model openai/gpt-5.6-luna, needs a model or a preset, injects the web_search tool, sends preset/max_steps in the body, 'fast' preset as the thinking default, cache_creation token usage. Add the _WithoutServerToolCalls stream wrapper. Requires the Responses service port; the Sonar deprecation is not ported.
- `pipecat.runner.utils` (b): Pass the four new optional env-derived args to TwilioFrameSerializer in the telephony transport factory. The serializer must support them.
- `pipecat.services.sarvam.stt` (b): Add _connection_established_event, set on session.begin, and wait for it with _receive_until_confirmed (10s) before on_connected. Turn ConnectionClosedError code 4000 into a push_error with category INVALID_REQUEST. Track _pending_partial and add _end_utterance_cut_short in the finally of _receive_messages, removing the old _complete_active_utterance calls from the task handler and reconnect.
- `pipecat.serializers.twilio` (b): Add apiKeySid/apiKeySecret options. Validate: need auth_token or the key pair, reject auth_token alongside any key part, require both halves of the pair. Hang-up Basic auth uses account_sid:auth_token or api_key_sid:api_key_secret.
- `pipecat.services.smallest.tts` (b): Add a dateFormat setting ('EU'|'US'|string|null, default null), sent as msg.date_format when not null. Widen the content_filter type to include 'redact'.
- `pipecat.services.speechify.tts` (b): Change the default model to 'simba-3.5'. Add a pronunciations setting (list of dicts, default null), included in the payload when non-empty.
- `pipecat.services.together.llm` (b): Add reasoning_effort to TogetherLLMSettings (default null) and setdefault params.reasoning_effort when given and non-null in build params; update adapter import path.
- `tests/test_openai_compatible_api_key.py` (b): Add the new SmallestLLMService and NvidiaOmniLLMService to the lists once those services are ported (new modules).
- `tests/test_cartesia_tts.py` (c): Port new parametrized language/accent/locale-rotation tests, laughter-token test, CartesiaExpressionAdapter suite and word-mark tests; needs the expressive adapter and accent/locale support in the Cartesia port.
- `tests/test_aggregated_frame_sequencer.py` (b): Add test_no_tracker_sentence_text_is_trimmed_for_the_context and the closing-delimiter-with-word test; update resync expectation raw_text to 'when it is'.
- `tests/test_audio_volume.py` (b): One test case; likely N/A in TS (Python bytearray buffer-export issue) - port only if TS tracker reuses/resizes a buffer that a view could alias.
- `tests/test_base_worker.py` (b): Add one test asserting single tracked flush_id and empty _foreign_probes on holder after flush_pipeline; requires the per-leg flush probe behaviour change in base worker.
- `tests/test_classifiers_clef.py` (b): Add two cases where the mock transport throws a TLS error and expect ClassifierError matching 'failed' or 'could not connect'. Check that the clef client wraps the error (module change in #6409).
- `tests/test_classifiers_jev.py` (b): Add two tests: a TLS-level transport error during ask() and during connect() maps to ClassifierError. In TS, simulate with a fetch/transport error.
- `tests/test_classifiers_openai_decisions.py` (b): Add two cases where the mocked transport throws a TLS-like network error and expect ClassifierError matching 'failed' / 'could not connect'.
- `tests/test_context_aggregators_universal.py` (d): Update the adapter imports (refactor 1). Add tests for MergeMode/UserTurnStrategiesParams merging with service and default strategies and for on_user_turn_resumed interruption/cancel behaviour. Drop test_llm_completion_strategy_finalizes_on_complete_marker.
- `tests/test_eager_user_turn_strategies.py` (d): Rename to UserTurnResponseCancelFrame and VAD frames. Add TestTheSpeculatedTurnPassesTheLLM and TestSpeechVoidsTheConfirmation, which depend on the turn rework and on LLMContextUserTurnFrame speculation.
- `tests/test_frame_processor.py` (b): Port the 3 cases once FrameProcessor gains cancelFrameInProgress(target) -> bool (from #6174, not yet in TS core).
- `tests/test_krisp_ip_user_turn_start_strategy.py` (d): With refactor 2, remove the ProcessFrameResult assertions and just await processFrame.
- `tests/test_llm_with_backend.py` (c): Port the PredictiveDelegation suite (early delegation on classifier yes, interruption, queued turns, metrics, validation). Update imports to the split llm_with_backend package (connector, prompts) and rename RELAY_NOTE to BACKEND_MESSAGE_RELAY_INSTRUCTION. Update the guidance string assertion.
- `tests/test_pattern_pair_aggregator.py` (b): Port test_keep_pattern_content_not_split and the 5 same-delimiter tests (text before fence, no split inside fence, fence across chunks, two blocks, unclosed fence dropped at flush).
- `tests/test_pipeline.py` (b): Add FlushRecorder + TestPipelineFlush (2 cases); rewrite test_idle_task_event_handler_quiet_user to assert gaps >= idle timeout; add setup_waits_for/started event to StartRecorder and relax startup assertions.
- `tests/test_provider_watch_scripts.py` (b): Trivial: TS only has skipped stubs, so add a skipped entry for test_renames_only_fragments_the_pr_adds.
- `tests/test_redaction.py` (b): Port the 12 new redaction tests along with the redaction.ts rewrite.
- `tests/test_rtvi_observer_pushes.py` (b): Port 5 new cases (per-word modes in segment, expression sound as own segment/output, kept from older clients, no-words text not sent); depends on expressive-conversation RTVI support.
- `tests/test_service_switcher.py` (b): Add one test (both directions) asserting every member processes the external metadata frame once and only one copy leaves; needs ServiceSwitcher metadata fan-out change.
- `tests/test_skip_tags_aggregator.py` (b): Port test_closed_tag_content_not_split and test_tag_after_emitted_sentence_not_split (needs protectedEnd support in SkipTagsAggregator).
- `tests/test_speculation_gate.py` (d): Rename EagerEndOfTurnCancelFrame to UserTurnResponseCancelFrame in the tests once refactor (2) frames land.
- `tests/test_text_segment_map.py` (b): Update the test and port the TextSegmentMap change: the trailing advance consumes a closing tag that directly follows the consumed alnums.
- `tests/test_text_type_deprecations.py` (b): Update parametrized test to include output_type and expect it in the dump; needs RTVI BotOutputMessageData.output_type from #6351.
- `tests/test_tts_frame_ordering.py` (b): Add the tests for a skipped frame following the text spoken before it, the context recording the text as the LLM wrote it, and transform-stripped text not pausing processing. The text_filters variants use the deprecated filters; port them only if TS keeps text_filters.
- `tests/test_user_bot_latency_observer.py` (d): Consequence of the turn rework (refactor 2): the UserTurnCompletionLLMServiceMixin exposes _trackPushedFrame. Update the test's marker processor to call it in pushFrame.
- `tests/test_user_turn_completion_mixin.py` (d): Refactor (2): drop the completion-latch and incomplete-timeout tests (that logic moved to the stop strategy). Add the report tests: each marker reported upstream once per inference with context_frame_id, tool call reported complete, no marker reported with no kind, nothing while filtering is off.
- `tests/test_user_turn_controller.py` (d): Port alongside the user-turn-start rework: new suites covering start/stop modes, MergeMode merging with service-recommended strategies, and ProcessFrameResult removal.
- `tests/test_user_turn_processor.py` (d): Add one test: VAD start, transcription, stop, then start again in the open turn fires on_user_turn_resumed with inference_triggered=False.
- `tests/test_user_turn_start_strategy.py` (d): Refactor (2): rename the calls to reportUserTurnStarted. Skip the two tests about deprecated trigger overrides (deprecation shims are not ported).
- `tests/test_user_turn_stop_strategy.py` (d): Part of refactor 2: port the new decide-once and new-text cases for ExternalUserTurnStopStrategy, and TestInferenceWithoutSpeculation (warns once). Add setup/cleanup to test_external_strategy. Skip the deprecated trigger-override tests.
- `tests/test_utils_string.py` (b): Update the expected indices (the end of the last closed pair, or the start of the open tag) and add the several-pairs and one-delimiter ('**') tests, with the matching parse_start_end_tags change in utils/string.
- `tests/test_voice_formatting.py` (b): Port 6 strip_markdown tests and VoiceFormatter strip_urls test; requires StripMarkdown class with strip_urls option and new stripping rules (direct commits da7b49d58, 4dc52fc96, no PR merge).
- `tests/test_wake_phrase_user_turn_start_strategy.py` (d): Update asserts to expect undefined result and add the StrategyMode.ALL wake-phrase suite with EndOnDemandStopStrategy, after the rework lands.
- `tests/test_websocket_service.py` (c): Port the tests for WebsocketService._receiveUntilConfirmed (stops on confirmation, false if closed, timeout counts as a quick failure, propagates errors) and for the bounded send (default/override send timeout, abort on stall). Requires the matching websocket_service features.
- `tests/test_word_completion_tracker.py` (b): Update resync expectation ('when it is'), add closing-tag-with-word test, and the 2 llm_markup tests; requires tracker llm_markup param.
- `tests/test_deepgram_flux_tts.py` (b): Add a _websocketRejection(status, reason) helper and two tests: a refusal sets isUsable false and emits 'Deepgram refused the connection (HTTP 400): <reason>', while 503 stays usable.
- `tests/test_deepgram_tts.py` (b): Extend the rejection helper with an optional dg-error header. Add a test asserting the on_connection_error payload is 'Deepgram refused the connection (HTTP 400): <reason>'.
- `tests/test_elevenlabs_dialogue_tts.py` (c): Port audio-tag alignment tests (tag as one word, split across chunks, word timestamps) and ElevenLabsAudioTagExpressionAdapter tests; depends on expressive conversation infra.
- `tests/test_elevenlabs_tts.py` (b): Add the WS wordless-alignment clock test and the HTTP audio-tag/expression adapter tests; most depend on the expressive-conversation expression adapter + audio_tags support in ElevenLabs HTTP service.
- `tests/test_evals_conversation_observer.py` (b): Add the speculation=True LLMContextUserTurnFrame push to the conversation test (needs speculation field on the frame and observer ignoring it).
- `tests/test_evals_scenario.py` (b): Add the text_matches parser tests: a string or list normalises to a list, a bad regex or non-string raises, and it is rejected together with absent. Needs the text_matches field in scenario parsing.
- `tests/test_evals_session.py` (b): Rename text_type to output_type in the bot_output helper. Add text_matches tests (failure kind 'text_unmatched'). Add test_expression_from_messages, which needs expression-event extraction in frame_to_event (#6303).
- `tests/test_evals_transport.py` (b): Add the two image-request tests for both the server and accepted-socket eval input transports (via _serve_user_image).
- `tests/test_runner_utils.py` (b): Add four tests for _createTelephonyTransport building the Twilio serializer from TWILIO_* env vars (API key, region and edge; error 'not both'). Needs the runner util change from #6293.
- `tests/test_fish_tts.py` (c): Port the S2 expression adapter tests (speaking tags for pace, delivery changes, emphasis, sounds/pauses, model mapping); needs the Fish expression adapter from the expressive-conversation feature first.
- `tests/test_google_thinking_defaults.py` (b): Update the expected Vertex default model to gemini-3.8-flash, with the matching default change in the Google Vertex service.
- `tests/test_minimax_tts_language.py` (b): Add a test that the documented emotions are accepted and reach settings.emotion. InputParams is deprecated, so use settings in TS. Needs the widened MiniMax emotion list.
- `tests/test_openai_image_gen.py` (b): Add a test that a moderation='low' setting reaches the Images API call, together with the new moderation setting on the OpenAI image service.
- `tests/test_openai_realtime_usage_metrics.py` (b): Add both cases; requires the matching tolerance changes in the OpenAI realtime LLM service (#6329).
- `tests/test_openai_responses_http.py` (b): Port the 5 cases; requires the responses LLM service to warn+push_error on completions with no text and no function call (#6348).
- `tests/test_openai_responses_websocket.py` (c): Replace TestDrainCancelledResponse with TestResponseLanes (alternating stream_id lanes, cancel keeps connection, abandoned responses' errors ignored, all lanes taken -> reconnect) and add TestReceiveResponseEventsEmpty (reasoning/refusal/whitespace-only -> push_error). Requires the responses websocket service lane rework and incremental flag.
- `tests/test_moq_transport.py` (b): Add 2 close-classification cases and 4 pacing tests; _client_with_audio takes optional params. Requires matching MOQ transport fixes (no-error close, pacing re-anchor/teardown handling).
- `tests/test_sarvam_stt.py` (c): Port the _FakeSarvamRealtime harness and about 11 tests covering the Sarvam STT reconnect rework: partial/finalized utterances across drops, retrying unconfirmed connections (give up after 3), no retry of rejected settings, connected event timing, skipping undecodable messages. Requires the sarvam/stt.py changes.
- `tests/test_twilio_serializer.py` (b): Add tests for auth_token vs api_key pair validation (alone ok, half pair rejected, both rejected, none rejected) and for hang-up Basic auth plus the URL with API key and base_url.

## Progress

Each PR is stacked on the one before it; review and merge them in this order.

| # | Step | Branch | PR |
|---|---|---|---|
| 1 | Bump + triage (this file, tooling) | `upstream-bump/triage` | #99 |
| 2 | Refactor 1: LLM adapters move to `adapters/llm` | `upstream-bump/adapters-llm` | #100 |
| 3 | Refactor 2: user turn strategies redesign (#6346) | `upstream-bump/user-turn-strategies` | #101 |
| 4 | `@pipedog/core` modules (expressive conversation first, `llm_with_backend`, text/TTS) | `upstream-bump/core` | #102 |
| 5 | Speech providers (Cartesia, ElevenLabs, Fish, MiniMax, Deepgram, Inworld, Smallest, Speechify, Sarvam, Google) | `upstream-bump/providers-speech` | #103 |
| 6 | LLM and other providers (OpenAI, AWS, Azure, Perplexity, Smallest LLM, Together, Inception, evals, CLI, runner, Twilio) | `upstream-bump/providers-llm` | #104 |
| 7 | New providers: NVIDIA LLM + Omni, Zoom AI STT, AssemblyAI TTS, Pipecat Tone | `upstream-bump/new-providers` | #105 |

Tooling fixed along the way: `--sync-tests` no longer marks a stale test as done (#103), and the
port workflow single-quotes the notes it records (#104).

## What's left

Every module and test that this bump changed and that pipedog had ported is ported again at
`8c3558bd69`. What remains:

- **New upstream, not ported:** `pipecat.observers.aic_tyto_observer` and its test. It needs
  ai-coustics' native `aic-sdk` (Tyto model), like the AIC filter and Quail VAD, which are unported
  for the same reason.
- **Changed upstream, blocked on transports pipedog hasn't ported:** `tests/test_runner_utils.py`
  and `tests/test_moq_transport.py` (they import the Daily, MoQ and Vonage transports).
- **Changed upstream, never ported** (they stay `todo` and get ported from scratch at the current
  pin): the AIC filter and Quail VAD, Fal STT, Keenable search, NVIDIA Riva TTS (and STT), Tavus
  video and transport (now with replica emotions, #6291), the Daily, LemonSlice and MoQ transports,
  and their tests (`test_aic_filter`, `test_krisp_viva_filter`, `test_daily_transport`,
  `test_tavus_transport`, `test_fal_stt`, `test_tavus_video`).
- **Follow-ups noted in the PRs:** a docs page for expressive conversation (alpha); a Deno run of
  the compat harness for the new packages (`@pipedog/nvidia`, `@pipedog/zoom-ai`, `@pipedog/tone`
  list bun, node and workerd only because Deno wasn't available); `@pipedog/perplexity` keywords.
