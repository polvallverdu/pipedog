# Core test review

Review of `packages/core/test` (branch `chore/core-test-review`): the tests that looked flaky under
load, and every remaining `test.skip` / `test.todo`, each put in exactly one bucket.

## Part 1: "flaky" tests

`test_service_switcher`, `test_websocket_service`, `test_websocket_service_usable` and
`test_websocket_stt_connect_failure` were reported as failing in full status syncs but passing alone.

**Root cause: the status tool, not the tests.** `bun tools/port/status.ts --sync-tests` counted
failures with `/(\d+) fail/` over the whole output, so a log line such as
`ERROR | ... reconnection attempt 1 failed: ...` (all four files log reconnection failures on
purpose) was read as "1 fail" and the file was marked `in_progress`. That happened on every sync,
not intermittently. The parser now reads only bun's summary lines (`^ *(\d+) fail$`) and also
treats a non-zero exit with no failing test as a failure. No test or source change was needed.

Load: 8 concurrent `bun test <file>` copies per round plus 8 CPU burners (`while :; do :; done`)
on a 12-core machine, 20 rounds per file (160 runs per file).

| File | Runs | Failed runs (bun's own summary) | Marked failed by the old parser | By the new parser |
|---|---|---|---|---|
| test_service_switcher | 160 | 0 | 160 | 0 |
| test_websocket_service | 160 | 0 | 160 | 0 |
| test_websocket_service_usable | 160 | 0 | 160 | 0 |
| test_websocket_stt_connect_failure | 160 | 0 | 160 | 0 |

The same load again on the final branch (another 160 runs per file): 0 failed runs per bun's
summary for all four files, 0 marked failed by the new parser, 160 of 160 by the old one.

Whole suite under load: 3 concurrent `bun test packages` runs plus 8 CPU burners, 5 rounds
(15 full runs): 0 failures in every run, before the changes in Part 2. After them:
2 more rounds (6 full runs), 0 failures in every run.

## Part 2: skip / todo audit

Counted from bun's JUnit report (one entry per test). Bun's own summary counts 6 more skips, 2 in
each of the three OpenTelemetry `describe.skipIf` blocks, which hold 8, 10 and 5 tests.

| | Before | After |
|---|---|---|
| skip | 195 | 236 |
| todo | 166 | 88 |
| total | 361 | 324 |
| pass (`bun test packages`) | 2812 | 2849 |

Skips went up because 40 provider-watch todos became divergence skips (they will never be
ported) and one newly runnable test is a documented divergence.

### Buckets

| Bucket | Meaning | Count |
|---|---|---|
| (a) | skipped upstream too (`pytest.skip`, `importorskip`, `skipif`, FIXME, commented out) | 30 |
| (b) | deprecated upstream API, not ported by convention | 110 |
| (c) | needs a package that isn't ported yet | 87 |
| (d) | needs an optional devDependency (not installed here) | 24 |
| (e) | real gap in core, fixed in this branch: these tests now run | 37 |
| (f) | divergence: behavior intentionally differs | 66 |

### (e) Fixed in this branch (37 tests now run and pass)

- **Sentence splitting (10)**, `test_sentencex_tokenizer`: the todos assumed core still used the
  `Intl.Segmenter` fallback, but `@pipedog/sentencex-wasm` is wired into `utils/string.ts`. The
  initials cases (`Albert I. Jones`) and the retry cases pass as written. Test-only change.
- **YAML include loader (8)**, `test_utils_yaml`: `utils/yaml.ts` was an interface stub. It now
  rebuilds PyYAML's `SafeLoader` (YAML 1.1 implicit resolvers, safe constructors, per-class
  copy-on-write constructors and resolvers, `ConstructorError`, `load()`,
  `addImplicitResolver()`) on the `yaml` package's parser (pure JS, no Node-only APIs), and
  `includeLoader()` / `addIncludeConstructor()` work as upstream. Included files are read with
  an injected synchronous `readFile` (YAML constructors are synchronous); the test passes
  `readFileSync`. Upstream's `FileNotFoundError` is the reader's `ENOENT` error.
- **LocalFileStorage (7)**, `test_file_storage`: save, load, delete and trimming by mtime go
  through an injected `fs` (`LocalFileSystem`, a subset of `node:fs/promises`, which fits as is);
  `ENOENT` on load becomes `FileNotFoundError`. The tests run on a real temporary directory, as
  upstream.
- **JPEG encoding of raw pixels (5)**, `test_base_classifier` (2), `test_llm_context` (1),
  `test_context_aggregators_universal` (2): `utils/jpeg_encoder.ts` is a new dependency-free
  baseline JPEG encoder (Annex K tables, quality 75, 4:4:4), and `encodeImage()` converts
  `L`/`LA`/`RGB`/`RGBA`/`RGBX` like Pillow's `frombytes(...).convert("RGB")`. The tests check
  what Pillow's lazy `Image.open` checks (format, mode, size) by reading the JPEG header
  (`test/jpeg_info.ts`). The encoder output was also decoded with libjpeg's `djpeg` while
  developing (PSNR 41-48 dB on smooth images at quality 75).
- **Resampling (7)**, `test_dtmf_utils` (2), `test_base_output_transport` (5):
  `soxrResample` / `SoxrResampleStream` were stubs that threw, so any rate conversion failed
  (TTS services, output transports and the audio buffer processor all use them). They now run on
  `@pipedog/resampler-wasm`, whose README already described it as their engine. `soxrResample` is
  synchronous and needs `await initSoxr()` first; the async resamplers and Smart Turn's
  `_predictEndpoint` do that themselves.

Wiring the resampler also made `test_resample_48k_to_16k_close_to_vhq` runnable, but it fails on
its own terms: rubato's HQ and VHQ presets differ in cutoff, which soxr's don't. It is listed
under (f) with its assertions unchanged.

### (f) Divergences

| Where | Tests | Divergence |
|---|---|---|
| test_provider_watch_scripts | 40 | Python repository-maintenance scripts (`scripts/provider-watch/*.py`), not part of the library. Converted from todo to skip. |
| test_deprecation_markers | 19 | Python build tooling over the Python source tree (`scripts/deprecations/*.py`, `deprecations.json`, `removals.json`). |
| test_classifiers_openai_decisions, test_classifiers_jev, test_classifiers_clef | 3 | Upstream inspects httpx's pool keep-alive (240 s). The port uses `fetch`, so the runtime owns connection reuse. |
| test_websocket_service | 1 | Bun's client `WebSocket` fires `close` without waiting for the peer's close frame, so a deaf peer looks like a clean close. Bounded close is covered with a stand-in socket. |
| test_krisp_ip_user_turn_start_strategy | 1 | No filesystem in core, so the constructor can't check that the model file exists. |
| test_base_smart_turn_buffer | 1 | No threads, so there is no `_executor` for `cleanup()` to shut down. |
| test_local_smart_turn_v3_resample | 1 | `@pipedog/resampler-wasm`'s HQ preset has a lower cutoff than VHQ (0.895 vs 0.947 of Nyquist); soxr's share a passband. HQ vs VHQ agree to 1e-5 below 5 kHz but not on the chirp's top end. |

Seven more (f) skips were frame-interleaving divergences (test_filters, test_service_switcher,
test_llm_with_backend, test_backend_llm_worker, test_job_group, test_context_aggregators_universal
×2): asyncio's `Queue.put`/`get` on a ready queue never suspends, while every JS `await` let
already-woken tasks run. `@pipedog/asyncio` now schedules like asyncio (wakeups go through a
`call_soon` ready queue drained one callback per macrotask), so they run with upstream's
assertions and pass. The (f) count above is after that change: 73 − 7 = 66.

### (d) Optional devDependencies (not done here)

- `@opentelemetry/api` + `@opentelemetry/sdk-trace-base`: test_tracing_context (8),
  test_turn_trace_observer (10), test_gemini_live_tracing (5). That is the separate tracing task.
- An ONNX runtime (`onnxruntime-node`) and the smart-turn-v3 model file:
  `test_predict_endpoint_on_48k_input_runs`. Upstream bundles the model.

### (c) Backlog: the package that unblocks each test

`test_service_init` has no todo, but its `test_service_settings_complete[...]` cases only cover
classes core can see. Each provider package adds its services to that test automatically.


#### @pipedog/moonshine (14)

| File | Test | Needs |
|---|---|---|
| test_moonshine_stt.test.ts:141 | test_defaults_load_the_english_streaming_model | services/moonshine/stt |
| test_moonshine_stt.test.ts:150 | test_regional_variants_resolve_to_the_base_code | services/moonshine/stt |
| test_moonshine_stt.test.ts:159 | test_unavailable_architecture_falls_back_to_the_language_default | services/moonshine/stt |
| test_moonshine_stt.test.ts:169 | test_requested_architecture_is_kept_when_available | services/moonshine/stt |
| test_moonshine_stt.test.ts:181 | test_unsupported_language_raises | services/moonshine/stt |
| test_moonshine_stt.test.ts:190 | test_unknown_model_raises | services/moonshine/stt |
| test_moonshine_stt.test.ts:199 | test_language_to_moonshine_language | services/moonshine/stt |
| test_moonshine_stt.test.ts:208 | test_moonshine_language_to_frame_language | services/moonshine/stt |
| test_moonshine_stt.test.ts:214 | test_service_exposes_metrics_and_language_mapping | services/moonshine/stt |
| test_moonshine_stt.test.ts:221 | test_run_stt_yields_a_transcription_frame | services/moonshine/stt |
| test_moonshine_stt.test.ts:237 | test_language_update_reloads_the_model | services/moonshine/stt |
| test_moonshine_stt.test.ts:248 | test_failed_reload_keeps_the_loaded_model | services/moonshine/stt |
| test_moonshine_stt.test.ts:273 | test_missing_or_blank_model_is_rejected[none] | services/moonshine/stt |
| test_moonshine_stt.test.ts:273 | test_missing_or_blank_model_is_rejected[blank] | services/moonshine/stt |

#### @pipedog/openai (10)

| File | Test | Needs |
|---|---|---|
| test_websocket_stt_connect_failure.test.ts:214 | test_failed_connect_starts_the_receive_loop[openai.stt-OpenAIRealtimeSTTService] | services/openai/stt |
| test_realtime_service_tool_sync.test.ts:109 | test_the_contexts_own_tools_win_and_built_ins_ride_along | openai/open_ai_realtime_adapter.ts |
| test_realtime_service_tool_sync.test.ts:109 | test_service_schema_handler_registers | openai/realtime/llm.ts, openai/realtime/events.ts |
| test_realtime_service_tool_sync.test.ts:109 | test_service_tool_list_registers | openai/realtime/llm.ts, openai/realtime/events.ts |
| test_realtime_service_tool_sync.test.ts:109 | test_service_async_tool_option_honored | openai/realtime/llm.ts, openai/realtime/events.ts |
| test_realtime_service_tool_sync.test.ts:109 | test_no_service_tools_is_safe | openai/realtime/llm.ts, openai/realtime/events.ts |
| test_realtime_service_tool_sync.test.ts:109 | test_send_session_update_preserves_service_tools | openai/realtime/llm.ts, openai/realtime/events.ts |
| test_realtime_service_tool_sync.test.ts:109 | test_built_in_tools_join_the_service_tools | openai/realtime/llm.ts, openai/realtime/events.ts |
| test_realtime_service_tool_sync.test.ts:109 | test_built_in_tools_are_sent_when_the_service_has_none | openai/realtime/llm.ts, openai/realtime/events.ts |
| test_realtime_service_tool_sync.test.ts:109 | test_session_properties_normalizes_tool_list | openai/realtime/llm.ts, openai/realtime/events.ts |

#### @pipedog/aws (9)

| File | Test | Needs |
|---|---|---|
| test_websocket_stt_connect_failure.test.ts:214 | test_failed_connect_starts_the_receive_loop[aws.stt-AWSTranscribeSTTService] | services/aws/stt |
| test_nova_sonic_usage_metrics.test.ts:44 | test_can_generate_metrics | services/aws/nova_sonic/llm |
| test_nova_sonic_usage_metrics.test.ts:50 | test_usage_event_reports_collapsed_delta | services/aws/nova_sonic/llm |
| test_nova_sonic_usage_metrics.test.ts:81 | test_usage_event_with_no_tokens_is_skipped | services/aws/nova_sonic/llm |
| test_nova_sonic_usage_metrics.test.ts:101 | test_usage_event_with_missing_details_is_safe | services/aws/nova_sonic/llm |
| test_realtime_service_tool_sync.test.ts:109 | test_service_schema_handler_registers | aws/nova_sonic/llm.ts |
| test_realtime_service_tool_sync.test.ts:109 | test_service_tool_list_registers | aws/nova_sonic/llm.ts |
| test_realtime_service_tool_sync.test.ts:109 | test_service_async_tool_option_honored | aws/nova_sonic/llm.ts |
| test_realtime_service_tool_sync.test.ts:109 | test_no_service_tools_is_safe | aws/nova_sonic/llm.ts |

#### @pipedog/funasr (9)

| File | Test | Needs |
|---|---|---|
| test_funasr_stt.test.ts:91 | test_funasr_stt_defaults_use_stt_settings | services/funasr/stt |
| test_funasr_stt.test.ts:104 | test_funasr_stt_applies_settings_overrides | services/funasr/stt |
| test_funasr_stt.test.ts:124 | test_language_to_funasr_language_accepts_enums_and_strings | services/funasr/stt |
| test_funasr_stt.test.ts:132 | test_funasr_language_to_frame_language_maps_supported_codes | services/funasr/stt |
| test_funasr_stt.test.ts:139 | test_funasr_stt_exposes_metrics_and_language_mapping | services/funasr/stt |
| test_funasr_stt.test.ts:146 | test_run_stt_uses_settings_for_generation | services/funasr/stt |
| test_funasr_stt.test.ts:167 | test_run_stt_returns_error_frame_when_model_is_missing | services/funasr/stt |
| test_funasr_stt.test.ts:178 | test_run_stt_returns_error_frame_when_generation_fails | services/funasr/stt |
| test_funasr_stt.test.ts:192 | test_run_stt_skips_empty_transcripts | services/funasr/stt |

#### @pipedog/inworld (9)

| File | Test | Needs |
|---|---|---|
| test_realtime_service_tool_sync.test.ts:109 | test_service_schema_handler_registers | inworld/realtime/llm.ts, inworld/realtime/events.ts |
| test_realtime_service_tool_sync.test.ts:109 | test_service_tool_list_registers | inworld/realtime/llm.ts, inworld/realtime/events.ts |
| test_realtime_service_tool_sync.test.ts:109 | test_service_async_tool_option_honored | inworld/realtime/llm.ts, inworld/realtime/events.ts |
| test_realtime_service_tool_sync.test.ts:109 | test_no_service_tools_is_safe | inworld/realtime/llm.ts, inworld/realtime/events.ts |
| test_realtime_service_tool_sync.test.ts:109 | test_send_session_update_preserves_service_tools | inworld/realtime/llm.ts, inworld/realtime/events.ts |
| test_realtime_service_tool_sync.test.ts:109 | test_built_in_tools_join_the_service_tools | inworld/realtime/llm.ts, inworld/realtime/events.ts |
| test_realtime_service_tool_sync.test.ts:109 | test_built_in_tools_are_sent_when_the_service_has_none | inworld/realtime/llm.ts, inworld/realtime/events.ts |
| test_realtime_service_tool_sync.test.ts:109 | test_session_properties_normalizes_tool_list | inworld/realtime/llm.ts, inworld/realtime/events.ts |
| test_realtime_service_tool_sync.test.ts:109 | test_session_update_serializes_provider_data | inworld/realtime/llm.ts, inworld/realtime/events.ts |

#### @pipedog/xai (9)

| File | Test | Needs |
|---|---|---|
| test_websocket_stt_connect_failure.test.ts:214 | test_failed_connect_starts_the_receive_loop[xai.stt-XAISTTService] | services/xai/stt |
| test_realtime_service_tool_sync.test.ts:109 | test_service_schema_handler_registers | xai/realtime/llm.ts, xai/realtime/events.ts |
| test_realtime_service_tool_sync.test.ts:109 | test_service_tool_list_registers | xai/realtime/llm.ts, xai/realtime/events.ts |
| test_realtime_service_tool_sync.test.ts:109 | test_service_async_tool_option_honored | xai/realtime/llm.ts, xai/realtime/events.ts |
| test_realtime_service_tool_sync.test.ts:109 | test_no_service_tools_is_safe | xai/realtime/llm.ts, xai/realtime/events.ts |
| test_realtime_service_tool_sync.test.ts:109 | test_send_session_update_preserves_service_tools | xai/realtime/llm.ts, xai/realtime/events.ts |
| test_realtime_service_tool_sync.test.ts:109 | test_built_in_tools_join_the_service_tools | xai/realtime/llm.ts, xai/realtime/events.ts |
| test_realtime_service_tool_sync.test.ts:109 | test_built_in_tools_are_sent_when_the_service_has_none | xai/realtime/llm.ts, xai/realtime/events.ts |
| test_realtime_service_tool_sync.test.ts:109 | test_session_properties_normalizes_tool_list | xai/realtime/llm.ts, xai/realtime/events.ts |

#### @pipedog/azure (8)

| File | Test | Needs |
|---|---|---|
| test_realtime_service_tool_sync.test.ts:109 | test_service_schema_handler_registers | azure/voice_live/llm.ts, azure/voice_live/events.ts |
| test_realtime_service_tool_sync.test.ts:109 | test_service_tool_list_registers | azure/voice_live/llm.ts, azure/voice_live/events.ts |
| test_realtime_service_tool_sync.test.ts:109 | test_service_async_tool_option_honored | azure/voice_live/llm.ts, azure/voice_live/events.ts |
| test_realtime_service_tool_sync.test.ts:109 | test_no_service_tools_is_safe | azure/voice_live/llm.ts, azure/voice_live/events.ts |
| test_realtime_service_tool_sync.test.ts:109 | test_send_session_update_preserves_service_tools | azure/voice_live/llm.ts, azure/voice_live/events.ts |
| test_realtime_service_tool_sync.test.ts:109 | test_built_in_tools_join_the_service_tools | azure/voice_live/llm.ts, azure/voice_live/events.ts |
| test_realtime_service_tool_sync.test.ts:109 | test_built_in_tools_are_sent_when_the_service_has_none | azure/voice_live/llm.ts, azure/voice_live/events.ts |
| test_realtime_service_tool_sync.test.ts:109 | test_session_properties_normalizes_tool_list | azure/voice_live/llm.ts, azure/voice_live/events.ts |

#### @pipedog/ultravox (8)

| File | Test | Needs |
|---|---|---|
| test_ultravox_async_tool_results.test.ts:62 | test_sync_result_is_sent_as_client_tool_result | services/ultravox/llm |
| test_ultravox_async_tool_results.test.ts:79 | test_async_result_settled_in_place_is_sent_as_user_text | services/ultravox/llm |
| test_ultravox_async_tool_results.test.ts:96 | test_deferred_async_result_is_sent_as_user_text | services/ultravox/llm |
| test_ultravox_async_tool_results.test.ts:114 | test_result_is_delivered_once_across_context_pushes | services/ultravox/llm |
| test_realtime_service_tool_sync.test.ts:109 | test_service_schema_handler_registers | ultravox/llm.ts |
| test_realtime_service_tool_sync.test.ts:109 | test_service_tool_list_registers | ultravox/llm.ts |
| test_realtime_service_tool_sync.test.ts:109 | test_service_async_tool_option_honored | ultravox/llm.ts |
| test_realtime_service_tool_sync.test.ts:109 | test_no_service_tools_is_safe | ultravox/llm.ts |

#### @pipedog/google (6)

| File | Test | Needs |
|---|---|---|
| test_realtime_service_tool_sync.test.ts:109 | test_service_schema_handler_registers | google/gemini_live/llm.ts |
| test_realtime_service_tool_sync.test.ts:109 | test_service_tool_list_registers | google/gemini_live/llm.ts |
| test_realtime_service_tool_sync.test.ts:109 | test_service_async_tool_option_honored | google/gemini_live/llm.ts |
| test_realtime_service_tool_sync.test.ts:109 | test_no_service_tools_is_safe | google/gemini_live/llm.ts |
| test_realtime_service_tool_sync.test.ts:109 | test_raw_dict_service_tools_register_nothing | google/gemini_live/llm.ts |
| test_realtime_service_tool_sync.test.ts:109 | test_context_tools_take_precedence | google/gemini_live/llm.ts |

#### @pipedog/assemblyai (1)

| File | Test | Needs |
|---|---|---|
| test_websocket_stt_connect_failure.test.ts:214 | test_failed_connect_starts_the_receive_loop[assemblyai.stt-AssemblyAISTTService] | services/assemblyai/stt |

#### @pipedog/gladia (1)

| File | Test | Needs |
|---|---|---|
| test_websocket_stt_connect_failure.test.ts:214 | test_failed_connect_starts_the_receive_loop[gladia.stt-GladiaSTTService] | services/gladia/stt |

#### @pipedog/meta (1)

| File | Test | Needs |
|---|---|---|
| test_websocket_stt_connect_failure.test.ts:214 | test_failed_connect_starts_the_receive_loop[meta.stt-MetaSTTService] | services/meta/stt |

#### @pipedog/soniox (1)

| File | Test | Needs |
|---|---|---|
| test_websocket_stt_connect_failure.test.ts:214 | test_failed_connect_starts_the_receive_loop[soniox.stt-SonioxSTTService] | services/soniox/stt |

#### @pipedog/together (1)

| File | Test | Needs |
|---|---|---|
| test_websocket_stt_connect_failure.test.ts:214 | test_failed_connect_starts_the_receive_loop[together.stt-TogetherSTTService] | services/together/stt |


## Every remaining skip and todo outside (c)

| File | Test | Kind | Bucket | Reason |
|---|---|---|---|---|
| test_classifiers_clef.test.ts:768 | TestClefLive › test_three_questions[clef] | skipIf | (a) | live test, needs an API key (skipped without it upstream too) |
| test_classifiers_clef.test.ts:768 | TestClefLive › test_three_questions[clef-flash] | skipIf | (a) | live test, needs an API key (skipped without it upstream too) |
| test_classifiers_clef.test.ts:809 | TestClefLive › test_a_question_about_an_image[clef] | skipIf | (a) | live test, needs an API key (skipped without it upstream too) |
| test_classifiers_clef.test.ts:809 | TestClefLive › test_a_question_about_an_image[clef-flash] | skipIf | (a) | live test, needs an API key (skipped without it upstream too) |
| test_classifiers_jev.test.ts:667 | TestJevLive › test_three_questions | skipIf | (a) | live test, needs an API key (skipped without it upstream too) |
| test_classifiers_jev.test.ts:715 | TestJevLive › test_a_question_about_an_image | skipIf | (a) | live test, needs an API key (skipped without it upstream too) |
| test_classifiers_openai_decisions.test.ts:904 | TestOpenAIDecisionsLive › test_three_questions | skipIf | (a) | live test, needs an API key (skipped without it upstream too) |
| test_classifiers_openai_decisions.test.ts:937 | TestOpenAIDecisionsLive › test_a_question_about_an_image | skip | (a) | live test, needs an API key (skipped without it upstream too) |
| test_daily_transport_service.test.ts:16 | TestDailyTransport › test_event_handler | skip | (a) | upstream `@unittest.skip("FIXME: This test is failing")` |
| test_local_smart_turn_v3_features.test.ts:106 | test_local_smart_turn_v3_features › test_matches_transformers_numpy_path[True-silence] (transformers (WhisperFeatureExtractor reference) is not available in JS) | skip | (a) | upstream `pytest.importorskip("transformers")`: the reference WhisperFeatureExtractor is a Python library with no JS counterpart |
| test_local_smart_turn_v3_features.test.ts:106 | test_local_smart_turn_v3_features › test_matches_transformers_numpy_path[True-noise] (transformers (WhisperFeatureExtractor reference) is not available in JS) | skip | (a) | upstream `pytest.importorskip("transformers")`: the reference WhisperFeatureExtractor is a Python library with no JS counterpart |
| test_local_smart_turn_v3_features.test.ts:106 | test_local_smart_turn_v3_features › test_matches_transformers_numpy_path[True-sweep] (transformers (WhisperFeatureExtractor reference) is not available in JS) | skip | (a) | upstream `pytest.importorskip("transformers")`: the reference WhisperFeatureExtractor is a Python library with no JS counterpart |
| test_local_smart_turn_v3_features.test.ts:106 | test_local_smart_turn_v3_features › test_matches_transformers_numpy_path[True-partial] (transformers (WhisperFeatureExtractor reference) is not available in JS) | skip | (a) | upstream `pytest.importorskip("transformers")`: the reference WhisperFeatureExtractor is a Python library with no JS counterpart |
| test_local_smart_turn_v3_features.test.ts:106 | test_local_smart_turn_v3_features › test_matches_transformers_numpy_path[False-silence] (transformers (WhisperFeatureExtractor reference) is not available in JS) | skip | (a) | upstream `pytest.importorskip("transformers")`: the reference WhisperFeatureExtractor is a Python library with no JS counterpart |
| test_local_smart_turn_v3_features.test.ts:106 | test_local_smart_turn_v3_features › test_matches_transformers_numpy_path[False-noise] (transformers (WhisperFeatureExtractor reference) is not available in JS) | skip | (a) | upstream `pytest.importorskip("transformers")`: the reference WhisperFeatureExtractor is a Python library with no JS counterpart |
| test_local_smart_turn_v3_features.test.ts:106 | test_local_smart_turn_v3_features › test_matches_transformers_numpy_path[False-sweep] (transformers (WhisperFeatureExtractor reference) is not available in JS) | skip | (a) | upstream `pytest.importorskip("transformers")`: the reference WhisperFeatureExtractor is a Python library with no JS counterpart |
| test_local_smart_turn_v3_features.test.ts:106 | test_local_smart_turn_v3_features › test_matches_transformers_numpy_path[False-partial] (transformers (WhisperFeatureExtractor reference) is not available in JS) | skip | (a) | upstream `pytest.importorskip("transformers")`: the reference WhisperFeatureExtractor is a Python library with no JS counterpart |
| test_local_smart_turn_v3_features.test.ts:134 | test_local_smart_turn_v3_features › test_matches_transformers_public_call[True-silence] (transformers (WhisperFeatureExtractor reference) is not available in JS) | skip | (a) | upstream `pytest.importorskip("transformers")`: the reference WhisperFeatureExtractor is a Python library with no JS counterpart |
| test_local_smart_turn_v3_features.test.ts:134 | test_local_smart_turn_v3_features › test_matches_transformers_public_call[True-noise] (transformers (WhisperFeatureExtractor reference) is not available in JS) | skip | (a) | upstream `pytest.importorskip("transformers")`: the reference WhisperFeatureExtractor is a Python library with no JS counterpart |
| test_local_smart_turn_v3_features.test.ts:134 | test_local_smart_turn_v3_features › test_matches_transformers_public_call[True-sweep] (transformers (WhisperFeatureExtractor reference) is not available in JS) | skip | (a) | upstream `pytest.importorskip("transformers")`: the reference WhisperFeatureExtractor is a Python library with no JS counterpart |
| test_local_smart_turn_v3_features.test.ts:134 | test_local_smart_turn_v3_features › test_matches_transformers_public_call[True-partial] (transformers (WhisperFeatureExtractor reference) is not available in JS) | skip | (a) | upstream `pytest.importorskip("transformers")`: the reference WhisperFeatureExtractor is a Python library with no JS counterpart |
| test_local_smart_turn_v3_features.test.ts:134 | test_local_smart_turn_v3_features › test_matches_transformers_public_call[False-silence] (transformers (WhisperFeatureExtractor reference) is not available in JS) | skip | (a) | upstream `pytest.importorskip("transformers")`: the reference WhisperFeatureExtractor is a Python library with no JS counterpart |
| test_local_smart_turn_v3_features.test.ts:134 | test_local_smart_turn_v3_features › test_matches_transformers_public_call[False-noise] (transformers (WhisperFeatureExtractor reference) is not available in JS) | skip | (a) | upstream `pytest.importorskip("transformers")`: the reference WhisperFeatureExtractor is a Python library with no JS counterpart |
| test_local_smart_turn_v3_features.test.ts:134 | test_local_smart_turn_v3_features › test_matches_transformers_public_call[False-sweep] (transformers (WhisperFeatureExtractor reference) is not available in JS) | skip | (a) | upstream `pytest.importorskip("transformers")`: the reference WhisperFeatureExtractor is a Python library with no JS counterpart |
| test_local_smart_turn_v3_features.test.ts:134 | test_local_smart_turn_v3_features › test_matches_transformers_public_call[False-partial] (transformers (WhisperFeatureExtractor reference) is not available in JS) | skip | (a) | upstream `pytest.importorskip("transformers")`: the reference WhisperFeatureExtractor is a Python library with no JS counterpart |
| test_service_init.test.ts:221 | test_service_settings_complete › test_service_settings_complete[ImageGenService] | skip | (a) | abstract class, skipped like upstream (it can't be built with dummy args; upstream's `_BASE_MODULES` names a nonexistent `image_gen_service` module, so it is discovered and skipped there too) |
| test_websocket_transport.test.ts:22 | TestWebSocketTransportService › test_websocket_handler (commented out upstream (targets removed pipecat.transports.websocket_transport)) | skip | (a) | commented out upstream (targets the removed pipecat.transports.websocket_transport) |
| test_websocket_transport.test.ts:23 | TestWebSocketTransportService › test_on_connection_decorator (commented out upstream (targets removed pipecat.transports.websocket_transport)) | skip | (a) | commented out upstream (targets the removed pipecat.transports.websocket_transport) |
| test_websocket_transport.test.ts:24 | TestWebSocketTransportService › test_frame_processor (commented out upstream (targets removed pipecat.transports.websocket_transport)) | skip | (a) | commented out upstream (targets the removed pipecat.transports.websocket_transport) |
| test_websocket_transport.test.ts:25 | TestWebSocketTransportService › test_serializer_parameter (commented out upstream (targets removed pipecat.transports.websocket_transport)) | skip | (a) | commented out upstream (targets the removed pipecat.transports.websocket_transport) |
| test_app_resources.test.ts:126 | TestFunctionCallParamsAppResources › test_tool_resources_property_warns_and_aliases_app_resources | skip | (b) | `tool_resources` (FunctionCallParams / FrameProcessorSetup / PipelineWorker kwarg) |
| test_app_resources.test.ts:244 | TestLLMServiceFunctionCallReadsAppResources › test_frame_processor_setup_tool_resources_warns_on_read | skip | (b) | `tool_resources` (FunctionCallParams / FrameProcessorSetup / PipelineWorker kwarg) |
| test_app_resources.test.ts:260 | TestPipelineWorkerAppResources › test_tool_resources_kwarg_warns_and_aliases_app_resources | skip | (b) | `tool_resources` (FunctionCallParams / FrameProcessorSetup / PipelineWorker kwarg) |
| test_app_resources.test.ts:263 | TestPipelineWorkerAppResources › test_app_resources_takes_precedence_over_tool_resources | skip | (b) | `tool_resources` (FunctionCallParams / FrameProcessorSetup / PipelineWorker kwarg) |
| test_app_resources.test.ts:287 | TestFrameProcessorSetupToolResourcesBackwardsCompat › test_legacy_processor_receives_value_via_app_resources | skip | (b) | `tool_resources` (FunctionCallParams / FrameProcessorSetup / PipelineWorker kwarg) |
| test_app_resources.test.ts:291 | TestFrameProcessorSetupToolResourcesBackwardsCompat › test_legacy_processor_receives_value_via_deprecated_tool_resources_kwarg | skip | (b) | `tool_resources` (FunctionCallParams / FrameProcessorSetup / PipelineWorker kwarg) |
| test_audio_buffer_processor.test.ts:1194 | TestTurnAudio › test_deprecated_events_still_report_each_run_of_speech | skip | (b) | `on_user_turn_audio_data` / `on_bot_turn_audio_data` events |
| test_auto_register_tools.test.ts:716 | TestDeprecatedExplicitRegistrationApi › test_register_direct_function_warns_and_registers | skip | (b) | `register_direct_function` / `unregister_direct_function` (1.4.0), `tool(timeout=)` alias |
| test_auto_register_tools.test.ts:720 | TestDeprecatedExplicitRegistrationApi › test_unregister_direct_function_warns_and_unregisters | skip | (b) | `register_direct_function` / `unregister_direct_function` (1.4.0), `tool(timeout=)` alias |
| test_auto_register_tools.test.ts:741 | TestToolDecoratorSharesAnnotation › test_tool_timeout_alias_is_deprecated_but_works | skip | (b) | `register_direct_function` / `unregister_direct_function` (1.4.0), `tool(timeout=)` alias |
| test_base_input_transport.test.ts:59 | TestBaseInputTransportFrameAudio › test_start_audio_in_streaming_method_is_deprecated | skip | (b) | `start_audio_in_streaming()` public alias |
| test_bridge_processor.test.ts:211 | TestBusBridgeProcessor › test_target_task_filtering | skip | (b) | `target_task` parameter |
| test_context_aggregators_universal.test.ts:913 | TestLLMUserAggregator › test_filter_incomplete_user_turns_emits_deprecation_warning | skip | (b) | `LLMUserAggregatorParams(filter_incomplete_user_turns=)` |
| test_context_aggregators_universal.test.ts:917 | TestLLMUserAggregator › test_filter_incomplete_user_turns_installs_strategy | skip | (b) | `LLMUserAggregatorParams(filter_incomplete_user_turns=)` |
| test_context_summarization.test.ts:371 | TestLLMContextSummarizationConfigDeprecated › test_emits_deprecation_warning | skip | (b) | `LLMContextSummarizationConfig` |
| test_context_summarization.test.ts:373 | TestLLMContextSummarizationConfigDeprecated › test_to_auto_config | skip | (b) | `LLMContextSummarizationConfig` |
| test_deprecation_markers.test.ts:60 |  › test_pipeline_task_warns | skip | (b) | deprecated alias/shim not ported (`PipelineTask`, `PipelineTaskParams`, `PipelineRunner`, task frame aliases, `StartFrame.enable_metrics`, `warn_deprecated_read`, `renamed_init_field`) |
| test_deprecation_markers.test.ts:62 |  › test_pipeline_task_params_warns | skip | (b) | deprecated alias/shim not ported (`PipelineTask`, `PipelineTaskParams`, `PipelineRunner`, task frame aliases, `StartFrame.enable_metrics`, `warn_deprecated_read`, `renamed_init_field`) |
| test_deprecation_markers.test.ts:64 |  › test_pipeline_runner_warns | skip | (b) | deprecated alias/shim not ported (`PipelineTask`, `PipelineTaskParams`, `PipelineRunner`, task frame aliases, `StartFrame.enable_metrics`, `warn_deprecated_read`, `renamed_init_field`) |
| test_deprecation_markers.test.ts:68 |  › test_task_frame_aliases_warn[EndTaskFrame] | skip | (b) | deprecated alias/shim not ported (`PipelineTask`, `PipelineTaskParams`, `PipelineRunner`, task frame aliases, `StartFrame.enable_metrics`, `warn_deprecated_read`, `renamed_init_field`) |
| test_deprecation_markers.test.ts:68 |  › test_task_frame_aliases_warn[StopTaskFrame] | skip | (b) | deprecated alias/shim not ported (`PipelineTask`, `PipelineTaskParams`, `PipelineRunner`, task frame aliases, `StartFrame.enable_metrics`, `warn_deprecated_read`, `renamed_init_field`) |
| test_deprecation_markers.test.ts:68 |  › test_task_frame_aliases_warn[CancelTaskFrame] | skip | (b) | deprecated alias/shim not ported (`PipelineTask`, `PipelineTaskParams`, `PipelineRunner`, task frame aliases, `StartFrame.enable_metrics`, `warn_deprecated_read`, `renamed_init_field`) |
| test_deprecation_markers.test.ts:68 |  › test_task_frame_aliases_warn[InterruptionTaskFrame] | skip | (b) | deprecated alias/shim not ported (`PipelineTask`, `PipelineTaskParams`, `PipelineRunner`, task frame aliases, `StartFrame.enable_metrics`, `warn_deprecated_read`, `renamed_init_field`) |
| test_deprecation_markers.test.ts:101 |  › test_intercepted_read_warns_once_per_call_site | skip | (b) | deprecated alias/shim not ported (`PipelineTask`, `PipelineTaskParams`, `PipelineRunner`, task frame aliases, `StartFrame.enable_metrics`, `warn_deprecated_read`, `renamed_init_field`) |
| test_deprecation_markers.test.ts:102 |  › test_intercepted_read_warns_for_every_call_site | skip | (b) | deprecated alias/shim not ported (`PipelineTask`, `PipelineTaskParams`, `PipelineRunner`, task frame aliases, `StartFrame.enable_metrics`, `warn_deprecated_read`, `renamed_init_field`) |
| test_deprecation_markers.test.ts:103 |  › test_intercepted_read_reports_the_reading_line | skip | (b) | deprecated alias/shim not ported (`PipelineTask`, `PipelineTaskParams`, `PipelineRunner`, task frame aliases, `StartFrame.enable_metrics`, `warn_deprecated_read`, `renamed_init_field`) |
| test_deprecation_markers.test.ts:105 |  › test_deprecated_warn_deprecated_read_still_names_the_reading_line | skip | (b) | deprecated alias/shim not ported (`PipelineTask`, `PipelineTaskParams`, `PipelineRunner`, task frame aliases, `StartFrame.enable_metrics`, `warn_deprecated_read`, `renamed_init_field`) |
| test_deprecation_markers.test.ts:108 |  › test_intercepted_read_warns_through_an_ignore_filter | skip | (b) | deprecated alias/shim not ported (`PipelineTask`, `PipelineTaskParams`, `PipelineRunner`, task frame aliases, `StartFrame.enable_metrics`, `warn_deprecated_read`, `renamed_init_field`) |
| test_deprecation_markers.test.ts:114 |  › test_renamed_field_reaches_a_constructor_that_passes_it_to_super | skip | (b) | deprecated alias/shim not ported (`PipelineTask`, `PipelineTaskParams`, `PipelineRunner`, task frame aliases, `StartFrame.enable_metrics`, `warn_deprecated_read`, `renamed_init_field`) |
| test_filters.test.ts:133 | TestWakeCheckFilter › test_no_wake_word | skip | (b) | `WakeCheckFilter` (0.0.106) |
| test_filters.test.ts:136 | TestWakeCheckFilter › test_wake_word | skip | (b) | `WakeCheckFilter` (0.0.106) |
| test_frames_interruptible.test.ts:45 | TestInterruptibleFlag › test_the_marker_still_works_and_warns | skip | (b) | `UninterruptibleFrame` marker (1.11.0) |
| test_llm_service.test.ts:1244 | TestCancellationToolBehaviour › test_a_call_covered_only_by_the_deprecated_flag_is_cancelled | skip | (b) | `enable_async_tool_cancellation`; construction-time turn-completion warnings |
| test_llm_service.test.ts:1341 | TestAsyncToolCancellationExposure › test_deprecated_flag_covers_every_async_tool | skip | (b) | `enable_async_tool_cancellation`; construction-time turn-completion warnings |
| test_llm_service.test.ts:1343 | TestAsyncToolCancellationExposure › test_deprecated_flag_needs_an_async_tool | skip | (b) | `enable_async_tool_cancellation`; construction-time turn-completion warnings |
| test_llm_service.test.ts:1431 | TestTurnCompletionSettingsDeprecation › test_filter_incomplete_user_turns_at_construction_warns | skip | (b) | `enable_async_tool_cancellation`; construction-time turn-completion warnings |
| test_llm_service.test.ts:1433 | TestTurnCompletionSettingsDeprecation › test_user_turn_completion_config_at_construction_warns | skip | (b) | `enable_async_tool_cancellation`; construction-time turn-completion warnings |
| test_llm_switcher.test.ts:123 | TestLLMSwitcherDirectFunctions › test_register_direct_function_is_deprecated_but_fans_out | skip | (b) | `LLMSwitcher.register_direct_function` |
| test_llm_switcher.test.ts:190 | TestLLMSwitcherRegisterFunctionOptionPrecedence › test_register_direct_function_decorator_values_used_when_no_explicit_args | skip | (b) | `LLMSwitcher.register_direct_function` |
| test_llm_switcher.test.ts:194 | TestLLMSwitcherRegisterFunctionOptionPrecedence › test_register_direct_function_explicit_arg_overrides_decorator | skip | (b) | `LLMSwitcher.register_direct_function` |
| test_pipeline.test.ts:100 | TestPipeline › test_start_frame_still_carries_the_deprecated_configuration | skip | (b) | deprecated `StartFrame` configuration fields |
| test_processor_unusable_policy.test.ts:241 | TestDeprecatedFatalFlag › test_error_frame_warns_when_fatal | skip | (b) | `fatal` flag (`ErrorFrame(fatal=)`, `FatalErrorFrame`, `push_error(fatal=)`) |
| test_processor_unusable_policy.test.ts:245 | TestDeprecatedFatalFlag › test_error_frame_stays_quiet_without_fatal | skip | (b) | `fatal` flag (`ErrorFrame(fatal=)`, `FatalErrorFrame`, `push_error(fatal=)`) |
| test_processor_unusable_policy.test.ts:249 | TestDeprecatedFatalFlag › test_fatal_error_frame_warns_about_itself_only | skip | (b) | `fatal` flag (`ErrorFrame(fatal=)`, `FatalErrorFrame`, `push_error(fatal=)`) |
| test_processor_unusable_policy.test.ts:253 | TestDeprecatedFatalFlag › test_push_error_warns_when_fatal_and_still_cancels | skip | (b) | `fatal` flag (`ErrorFrame(fatal=)`, `FatalErrorFrame`, `push_error(fatal=)`) |
| test_processor_unusable_policy.test.ts:257 | TestDeprecatedFatalFlag › test_push_error_stays_quiet_when_permanent | skip | (b) | `fatal` flag (`ErrorFrame(fatal=)`, `FatalErrorFrame`, `push_error(fatal=)`) |
| test_resampy_resampler.test.ts:15 |  › test_resampy_resampler_emits_deprecation_warning | skip | (b) | `ResampyResampler` (1.2.0) |
| test_rtvi_observer_pushes.test.ts:302 | TestRTVIObserverPushes › test_a_transcription_is_only_sent_as_user_input_without_user_transcription | skip | (b) | `RTVIObserverParams.user_transcription_enabled` (deprecated 1.13.0) |
| test_rtvi_observer_raw_text.test.ts:216 | TestRTVIObserverParamsUserTranscription › test_turning_user_transcription_off_is_deprecated | skip | (b) | `RTVIObserverParams.user_transcription_enabled` (deprecated 1.13.0) |
| test_rtvi_observer_raw_text.test.ts:220 | TestRTVIObserverParamsUserTranscription › test_leaving_user_transcription_on_is_not_deprecated | skip | (b) | `RTVIObserverParams.user_transcription_enabled` (deprecated 1.13.0) |
| test_rtvi_processor.test.ts:234 | TestRTVIFrameBasedAudio › test_transport_param_is_deprecated | skip | (b) | `RTVIProcessor(transport=)` |
| test_runner.test.ts:44 | TestWorkerRunner › test_pipeline_runner_alias_is_deprecated | skip | (b) | `PipelineRunner` alias |
| test_startup_timing_observer.test.ts:366 | TestStartupTimingObserver › test_the_deprecated_warming_event_extends_the_setup_phase | skip | (b) | `on_startup_warmup` / `StartupWarmup` |
| test_startup_timing_observer.test.ts:369 | TestStartupTimingObserver › test_the_deprecated_warming_event_inside_setup_costs_nothing | skip | (b) | `on_startup_warmup` / `StartupWarmup` |
| test_text_type_deprecations.test.ts:32 | AggregatedTextFrame › test_aggregated_by_keyword_sets_text_type | skip | (b) | `aggregated_by` / `AggregationType` / `skip_aggregator_types` / `aggregation_type` (1.13.0) |
| test_text_type_deprecations.test.ts:32 | TTSTextFrame › test_aggregated_by_keyword_sets_text_type | skip | (b) | `aggregated_by` / `AggregationType` / `skip_aggregator_types` / `aggregation_type` (1.13.0) |
| test_text_type_deprecations.test.ts:38 | _AppTextFrame › test_aggregated_by_keyword_on_a_subclass | skip | (b) | `aggregated_by` / `AggregationType` / `skip_aggregator_types` / `aggregation_type` (1.13.0) |
| test_text_type_deprecations.test.ts:38 | _AbstractAppTextFrame › test_aggregated_by_keyword_on_a_subclass | skip | (b) | `aggregated_by` / `AggregationType` / `skip_aggregator_types` / `aggregation_type` (1.13.0) |
| test_text_type_deprecations.test.ts:48 |  › test_reading_aggregated_by_returns_text_type | skip | (b) | `aggregated_by` / `AggregationType` / `skip_aggregator_types` / `aggregation_type` (1.13.0) |
| test_text_type_deprecations.test.ts:52 |  › test_assigning_aggregated_by_sets_text_type | skip | (b) | `aggregated_by` / `AggregationType` / `skip_aggregator_types` / `aggregation_type` (1.13.0) |
| test_text_type_deprecations.test.ts:56 |  › test_progress_frame_aggregated_by | skip | (b) | `aggregated_by` / `AggregationType` / `skip_aggregator_types` / `aggregation_type` (1.13.0) |
| test_text_type_deprecations.test.ts:60 |  › test_rtvi_observer_params_skip_aggregator_types | skip | (b) | `aggregated_by` / `AggregationType` / `skip_aggregator_types` / `aggregation_type` (1.13.0) |
| test_text_type_deprecations.test.ts:65 |  › test_rtvi_observer_transformer_aggregation_type | skip | (b) | `aggregated_by` / `AggregationType` / `skip_aggregator_types` / `aggregation_type` (1.13.0) |
| test_text_type_deprecations.test.ts:69 |  › test_tts_service_skip_aggregator_types | skip | (b) | `aggregated_by` / `AggregationType` / `skip_aggregator_types` / `aggregation_type` (1.13.0) |
| test_text_type_deprecations.test.ts:74 |  › test_tts_service_transformer_aggregation_type | skip | (b) | `aggregated_by` / `AggregationType` / `skip_aggregator_types` / `aggregation_type` (1.13.0) |
| test_text_type_deprecations.test.ts:91 | pipecat.utils.text.base_text_aggregator › test_aggregation_type_is_text_type | skip | (b) | `aggregated_by` / `AggregationType` / `skip_aggregator_types` / `aggregation_type` (1.13.0) |
| test_text_type_deprecations.test.ts:91 | pipecat.frames.frames › test_aggregation_type_is_text_type | skip | (b) | `aggregated_by` / `AggregationType` / `skip_aggregator_types` / `aggregation_type` (1.13.0) |
| test_ui_job_lifecycle.test.ts:237 | TestLateMessagesAfterTeardown › test_late_cancelled_response_is_not_forwarded | skip | (b) | `BaseUIWorker` (1.12.0) / `UIJobGroupContext`, `ui_job_group` (1.8.0) |
| test_ui_job_lifecycle.test.ts:240 | TestLateMessagesAfterTeardown › test_late_update_is_not_forwarded | skip | (b) | `BaseUIWorker` (1.12.0) / `UIJobGroupContext`, `ui_job_group` (1.8.0) |
| test_ui_job_lifecycle.test.ts:417 | TestUIJobGroupContext › test_label_and_cancellable_read_the_group_params | skip | (b) | `BaseUIWorker` (1.12.0) / `UIJobGroupContext`, `ui_job_group` (1.8.0) |
| test_ui_job_lifecycle.test.ts:421 | TestUIJobGroupContext › test_the_deprecated_wrappers_pass_on_their_arguments | skip | (b) | `BaseUIWorker` (1.12.0) / `UIJobGroupContext`, `ui_job_group` (1.8.0) |
| test_ui_job_lifecycle.test.ts:516 | TestBaseUIWorkerJobGroups › test_constructing_one_warns | skip | (b) | `BaseUIWorker` (1.12.0) / `UIJobGroupContext`, `ui_job_group` (1.8.0) |
| test_ui_job_lifecycle.test.ts:517 | TestBaseUIWorkerJobGroups › test_context_publishes_started_and_completed | skip | (b) | `BaseUIWorker` (1.12.0) / `UIJobGroupContext`, `ui_job_group` (1.8.0) |
| test_ui_job_lifecycle.test.ts:518 | TestBaseUIWorkerJobGroups › test_registered_update_and_response_are_forwarded | skip | (b) | `BaseUIWorker` (1.12.0) / `UIJobGroupContext`, `ui_job_group` (1.8.0) |
| test_ui_job_lifecycle.test.ts:519 | TestBaseUIWorkerJobGroups › test_cancel_event_routes_to_cancel_job_group | skip | (b) | `BaseUIWorker` (1.12.0) / `UIJobGroupContext`, `ui_job_group` (1.8.0) |
| test_ui_job_lifecycle.test.ts:520 | TestBaseUIWorkerJobGroups › test_non_cancellable_group_ignores_cancel_event | skip | (b) | `BaseUIWorker` (1.12.0) / `UIJobGroupContext`, `ui_job_group` (1.8.0) |
| test_ui_job_lifecycle.test.ts:521 | TestBaseUIWorkerJobGroups › test_single_job_with_ui_publishes_envelopes | skip | (b) | `BaseUIWorker` (1.12.0) / `UIJobGroupContext`, `ui_job_group` (1.8.0) |
| test_ui_job_lifecycle.test.ts:522 | TestBaseUIWorkerJobGroups › test_error_response_forwards_worker_envelope_before_group_completes | skip | (b) | `BaseUIWorker` (1.12.0) / `UIJobGroupContext`, `ui_job_group` (1.8.0) |
| test_ui_job_lifecycle.test.ts:523 | TestBaseUIWorkerJobGroups › test_cancel_synthesizes_cancelled_envelopes_for_unreported_workers | skip | (b) | `BaseUIWorker` (1.12.0) / `UIJobGroupContext`, `ui_job_group` (1.8.0) |
| test_ui_job_lifecycle.test.ts:524 | TestBaseUIWorkerJobGroups › test_stream_end_completion_completes_group | skip | (b) | `BaseUIWorker` (1.12.0) / `UIJobGroupContext`, `ui_job_group` (1.8.0) |
| test_ui_job_lifecycle.test.ts:525 | TestBaseUIWorkerJobGroups › test_request_job_group_returns_id_and_publishes | skip | (b) | `BaseUIWorker` (1.12.0) / `UIJobGroupContext`, `ui_job_group` (1.8.0) |
| test_ui_tools.test.ts:174 | TestReplyToolMixin › test_composing_the_mixin_warns | skip | (b) | `ReplyToolMixin` / `respond_to_job(tts_speak=)` (1.12.0) |
| test_ui_tools.test.ts:177 | TestReplyToolMixin › test_mixin_exposes_reply_tool | skip | (b) | `ReplyToolMixin` / `respond_to_job(tts_speak=)` (1.12.0) |
| test_ui_tools.test.ts:188 | TestReplyToolMixin › test_reply_with_answer_only_terminates | skip | (b) | `ReplyToolMixin` / `respond_to_job(tts_speak=)` (1.12.0) |
| test_ui_tools.test.ts:189 | TestReplyToolMixin › test_reply_with_highlight_only | skip | (b) | `ReplyToolMixin` / `respond_to_job(tts_speak=)` (1.12.0) |
| test_ui_tools.test.ts:190 | TestReplyToolMixin › test_reply_with_multiple_highlights | skip | (b) | `ReplyToolMixin` / `respond_to_job(tts_speak=)` (1.12.0) |
| test_ui_tools.test.ts:191 | TestReplyToolMixin › test_reply_with_scroll_and_highlight_runs_in_order | skip | (b) | `ReplyToolMixin` / `respond_to_job(tts_speak=)` (1.12.0) |
| test_ui_tools.test.ts:192 | TestReplyToolMixin › test_reply_with_select_text_only | skip | (b) | `ReplyToolMixin` / `respond_to_job(tts_speak=)` (1.12.0) |
| test_ui_tools.test.ts:193 | TestReplyToolMixin › test_reply_with_scroll_and_select_text | skip | (b) | `ReplyToolMixin` / `respond_to_job(tts_speak=)` (1.12.0) |
| test_ui_tools.test.ts:194 | TestReplyToolMixin › test_reply_with_fills_writes_each_input | skip | (b) | `ReplyToolMixin` / `respond_to_job(tts_speak=)` (1.12.0) |
| test_ui_tools.test.ts:195 | TestReplyToolMixin › test_reply_with_click_clicks_each_in_order | skip | (b) | `ReplyToolMixin` / `respond_to_job(tts_speak=)` (1.12.0) |
| test_ui_tools.test.ts:196 | TestReplyToolMixin › test_reply_with_fills_skips_invalid_entries | skip | (b) | `ReplyToolMixin` / `respond_to_job(tts_speak=)` (1.12.0) |
| test_ui_tools.test.ts:197 | TestReplyToolMixin › test_reply_with_non_dict_fill_entries_does_not_crash | skip | (b) | `ReplyToolMixin` / `respond_to_job(tts_speak=)` (1.12.0) |
| test_ui_tools.test.ts:198 | TestReplyToolMixin › test_reply_with_non_string_highlight_refs_skipped | skip | (b) | `ReplyToolMixin` / `respond_to_job(tts_speak=)` (1.12.0) |
| test_ui_tools.test.ts:199 | TestReplyToolMixin › test_reply_with_non_string_click_refs_skipped | skip | (b) | `ReplyToolMixin` / `respond_to_job(tts_speak=)` (1.12.0) |
| test_ui_tools.test.ts:200 | TestReplyToolMixin › test_reply_dispatches_via_helper_methods | skip | (b) | `ReplyToolMixin` / `respond_to_job(tts_speak=)` (1.12.0) |
| test_user_bot_latency_observer.test.ts:533 | TestLatencyBreakdownChronologicalEvents › test_events_sorted_by_start_time | skip | (b) | `LatencyBreakdown.chronological_events` (1.9.0) |
| test_user_bot_latency_observer.test.ts:534 | TestLatencyBreakdownChronologicalEvents › test_empty_breakdown | skip | (b) | `LatencyBreakdown.chronological_events` (1.9.0) |
| test_user_bot_latency_observer.test.ts:535 | TestLatencyBreakdownChronologicalEvents › test_user_turn_requires_both_fields | skip | (b) | `LatencyBreakdown.chronological_events` (1.9.0) |
| test_user_bot_latency_observer.test.ts:536 | TestLatencyBreakdownChronologicalEvents › test_ttfb_only | skip | (b) | `LatencyBreakdown.chronological_events` (1.9.0) |
| test_user_turn_controller.test.ts:741 | TestUserTurnController › test_start_strategy_not_reset_on_turn_stop | skip | (b) | strategy `reset()` hook and its DeprecationWarning bridge |
| test_user_turn_controller.test.ts:745 | TestUserTurnController › test_stop_strategy_reset_bridged_on_both_callbacks | skip | (b) | strategy `reset()` hook and its DeprecationWarning bridge |
| test_user_turn_controller.test.ts:749 | TestUserTurnController › test_overriding_reset_warns_at_class_definition | skip | (b) | strategy `reset()` hook and its DeprecationWarning bridge |
| test_user_turn_controller.test.ts:753 | TestUserTurnController › test_reset_warning_shows_under_default_filters_at_the_subclass | skip | (b) | strategy `reset()` hook and its DeprecationWarning bridge |
| test_user_turn_controller.test.ts:757 | TestUserTurnController › test_subclass_of_concrete_strategy_overriding_reset_warns_but_is_not_bridged | skip | (b) | strategy `reset()` hook and its DeprecationWarning bridge |
| test_user_turn_controller.test.ts:761 | TestUserTurnController › test_overriding_callbacks_does_not_warn_at_class_definition | skip | (b) | strategy `reset()` hook and its DeprecationWarning bridge |
| test_user_turn_start_strategy.test.ts:231 | TestBaseUserTurnStartStrategyDeprecations › test_enable_user_speaking_frames_warns | skip | (b) | `enable_user_speaking_frames` constructor argument |
| test_user_turn_start_strategy.test.ts:235 | TestBaseUserTurnStartStrategyDeprecations › test_enable_user_speaking_frames_applies | skip | (b) | `enable_user_speaking_frames` constructor argument |
| test_user_turn_stop_strategy.test.ts:1101 | TestBaseUserTurnStopStrategyDeprecations › test_enable_user_speaking_frames_warns | skip | (b) | `enable_user_speaking_frames` constructor argument |
| test_user_turn_stop_strategy.test.ts:1105 | TestBaseUserTurnStopStrategyDeprecations › test_enable_user_speaking_frames_applies | skip | (b) | `enable_user_speaking_frames` constructor argument |
| test_gemini_live_tracing.test.ts:128 | TestGeminiLiveToolResultTracing › test_captures_tool_result_attributes | skip | (d) | needs @opentelemetry/api + @opentelemetry/sdk-trace-base (devDependencies); separate tracing task |
| test_gemini_live_tracing.test.ts:144 | TestGeminiLiveToolResultTracing › test_result_status_error | skip | (d) | needs @opentelemetry/api + @opentelemetry/sdk-trace-base (devDependencies); separate tracing task |
| test_gemini_live_tracing.test.ts:153 | TestGeminiLiveToolResultTracing › test_result_status_success | skip | (d) | needs @opentelemetry/api + @opentelemetry/sdk-trace-base (devDependencies); separate tracing task |
| test_gemini_live_tracing.test.ts:162 | TestGeminiLiveToolResultTracing › test_long_result_is_truncated | skip | (d) | needs @opentelemetry/api + @opentelemetry/sdk-trace-base (devDependencies); separate tracing task |
| test_gemini_live_tracing.test.ts:173 | TestGeminiLiveToolResultTracing › test_non_dict_result_omits_result_attribute | skip | (d) | needs @opentelemetry/api + @opentelemetry/sdk-trace-base (devDependencies); separate tracing task |
| test_local_smart_turn_v3_resample.test.ts:131 | test_local_smart_turn_v3_resample › test_predict_endpoint_on_48k_input_runs | todo | (d) | needs an ONNX runtime (onnxruntime-node as a devDependency) and the smart-turn-v3 model file, which upstream bundles |
| test_tracing_context.test.ts:60 | TestTracingContext › test_initial_state_is_empty | skip | (d) | needs @opentelemetry/api + @opentelemetry/sdk-trace-base (devDependencies); separate tracing task |
| test_tracing_context.test.ts:68 | TestTracingContext › test_set_and_get_conversation_context | skip | (d) | needs @opentelemetry/api + @opentelemetry/sdk-trace-base (devDependencies); separate tracing task |
| test_tracing_context.test.ts:81 | TestTracingContext › test_clear_conversation_context | skip | (d) | needs @opentelemetry/api + @opentelemetry/sdk-trace-base (devDependencies); separate tracing task |
| test_tracing_context.test.ts:95 | TestTracingContext › test_set_and_get_turn_context | skip | (d) | needs @opentelemetry/api + @opentelemetry/sdk-trace-base (devDependencies); separate tracing task |
| test_tracing_context.test.ts:107 | TestTracingContext › test_clear_turn_context | skip | (d) | needs @opentelemetry/api + @opentelemetry/sdk-trace-base (devDependencies); separate tracing task |
| test_tracing_context.test.ts:120 | TestTracingContext › test_generate_conversation_id | skip | (d) | needs @opentelemetry/api + @opentelemetry/sdk-trace-base (devDependencies); separate tracing task |
| test_tracing_context.test.ts:128 | TestTracingContext › test_instances_are_isolated | skip | (d) | needs @opentelemetry/api + @opentelemetry/sdk-trace-base (devDependencies); separate tracing task |
| test_tracing_context.test.ts:145 | TestTracingContext › test_conversation_and_turn_are_independent | skip | (d) | needs @opentelemetry/api + @opentelemetry/sdk-trace-base (devDependencies); separate tracing task |
| test_turn_trace_observer.test.ts:155 | TestTurnTraceObserver › test_conversation_span_created_on_start_frame | skip | (d) | needs @opentelemetry/api + @opentelemetry/sdk-trace-base (devDependencies); separate tracing task |
| test_turn_trace_observer.test.ts:190 | TestTurnTraceObserver › test_turn_spans_created_for_each_turn | skip | (d) | needs @opentelemetry/api + @opentelemetry/sdk-trace-base (devDependencies); separate tracing task |
| test_turn_trace_observer.test.ts:233 | TestTurnTraceObserver › test_turn_spans_are_children_of_conversation | skip | (d) | needs @opentelemetry/api + @opentelemetry/sdk-trace-base (devDependencies); separate tracing task |
| test_turn_trace_observer.test.ts:273 | TestTurnTraceObserver › test_interrupted_turn_marked | skip | (d) | needs @opentelemetry/api + @opentelemetry/sdk-trace-base (devDependencies); separate tracing task |
| test_turn_trace_observer.test.ts:310 | TestTurnTraceObserver › test_tracing_context_updated_during_turn | skip | (d) | needs @opentelemetry/api + @opentelemetry/sdk-trace-base (devDependencies); separate tracing task |
| test_turn_trace_observer.test.ts:341 | TestTurnTraceObserver › test_tracing_context_cleared_after_conversation_end | skip | (d) | needs @opentelemetry/api + @opentelemetry/sdk-trace-base (devDependencies); separate tracing task |
| test_turn_trace_observer.test.ts:376 | TestTurnTraceObserver › test_additional_span_attributes | skip | (d) | needs @opentelemetry/api + @opentelemetry/sdk-trace-base (devDependencies); separate tracing task |
| test_turn_trace_observer.test.ts:421 | TestTurnTraceObserver › test_concurrent_pipelines_are_isolated | skip | (d) | needs @opentelemetry/api + @opentelemetry/sdk-trace-base (devDependencies); separate tracing task |
| test_turn_trace_observer.test.ts:493 | TestTurnTraceObserver › test_end_conversation_closes_active_turn | skip | (d) | needs @opentelemetry/api + @opentelemetry/sdk-trace-base (devDependencies); separate tracing task |
| test_turn_trace_observer.test.ts:517 | TestTurnTraceObserver › test_conversation_id_auto_generated | skip | (d) | needs @opentelemetry/api + @opentelemetry/sdk-trace-base (devDependencies); separate tracing task |
| test_base_smart_turn_buffer.test.ts:290 | cleanup › test_cleanup_releases_the_model_thread | skip | (f) | DIVERGENCE: no threads, so there is no `_executor` for cleanup() to shut down |
| test_classifiers_clef.test.ts:384 | TestClefClient › test_keeps_idle_connections_open_between_questions | skip | (f) | DIVERGENCE: upstream checks httpx's pool keep-alive expiry (240 s); the port uses `fetch`, connection reuse is the runtime's |
| test_classifiers_jev.test.ts:742 | TestJevClientConnection › test_keeps_idle_connections_open_between_questions | skip | (f) | DIVERGENCE: upstream checks httpx's pool keep-alive expiry (240 s); the port uses `fetch`, connection reuse is the runtime's |
| test_classifiers_openai_decisions.test.ts:445 | TestOpenAIDecisionsClient › test_keeps_idle_connections_open_between_questions | skip | (f) | DIVERGENCE: upstream checks httpx's pool keep-alive expiry (240 s); the port uses `fetch`, connection reuse is the runtime's |
| test_deprecation_markers.test.ts:34 |  › test_directives_parse | skip | (f) | DIVERGENCE: Python build tooling (`scripts/deprecations/*.py`, deprecations.json/removals.json) over the Python source tree; not part of the library |
| test_deprecation_markers.test.ts:35 |  › test_directives_state_removal_version | skip | (f) | DIVERGENCE: Python build tooling (`scripts/deprecations/*.py`, deprecations.json/removals.json) over the Python source tree; not part of the library |
| test_deprecation_markers.test.ts:36 |  › test_no_replacement_directive_extracts_no_replacement | skip | (f) | DIVERGENCE: Python build tooling (`scripts/deprecations/*.py`, deprecations.json/removals.json) over the Python source tree; not part of the library |
| test_deprecation_markers.test.ts:37 |  › test_directives_are_attributed_to_the_entry_they_sit_under | skip | (f) | DIVERGENCE: Python build tooling (`scripts/deprecations/*.py`, deprecations.json/removals.json) over the Python source tree; not part of the library |
| test_deprecation_markers.test.ts:38 |  › test_top_level_directive_deprecates_the_symbol | skip | (f) | DIVERGENCE: Python build tooling (`scripts/deprecations/*.py`, deprecations.json/removals.json) over the Python source tree; not part of the library |
| test_deprecation_markers.test.ts:44 |  › test_deprecated_messages_follow_template | skip | (f) | DIVERGENCE: Python build tooling (`scripts/deprecations/*.py`, deprecations.json/removals.json) over the Python source tree; not part of the library |
| test_deprecation_markers.test.ts:45 |  › test_warn_messages_follow_template | skip | (f) | DIVERGENCE: Python build tooling (`scripts/deprecations/*.py`, deprecations.json/removals.json) over the Python source tree; not part of the library |
| test_deprecation_markers.test.ts:46 |  › test_deprecation_warnings_use_the_helper | skip | (f) | DIVERGENCE: Python build tooling (`scripts/deprecations/*.py`, deprecations.json/removals.json) over the Python source tree; not part of the library |
| test_deprecation_markers.test.ts:47 |  › test_deprecated_subject_names_decorated_symbol | skip | (f) | DIVERGENCE: Python build tooling (`scripts/deprecations/*.py`, deprecations.json/removals.json) over the Python source tree; not part of the library |
| test_deprecation_markers.test.ts:48 |  › test_deprecated_version_matches_docstring_directive | skip | (f) | DIVERGENCE: Python build tooling (`scripts/deprecations/*.py`, deprecations.json/removals.json) over the Python source tree; not part of the library |
| test_deprecation_markers.test.ts:49 |  › test_deprecated_replacement_targets_exist | skip | (f) | DIVERGENCE: Python build tooling (`scripts/deprecations/*.py`, deprecations.json/removals.json) over the Python source tree; not part of the library |
| test_deprecation_markers.test.ts:55 |  › test_deprecations_registry_is_up_to_date | skip | (f) | DIVERGENCE: Python build tooling (`scripts/deprecations/*.py`, deprecations.json/removals.json) over the Python source tree; not part of the library |
| test_deprecation_markers.test.ts:120 |  › test_removals_registry_schema_is_valid | skip | (f) | DIVERGENCE: Python build tooling (`scripts/deprecations/*.py`, deprecations.json/removals.json) over the Python source tree; not part of the library |
| test_deprecation_markers.test.ts:121 |  › test_compute_removals_detects_disappeared_symbol | skip | (f) | DIVERGENCE: Python build tooling (`scripts/deprecations/*.py`, deprecations.json/removals.json) over the Python source tree; not part of the library |
| test_deprecation_markers.test.ts:122 |  › test_compute_removals_no_change_when_nothing_removed | skip | (f) | DIVERGENCE: Python build tooling (`scripts/deprecations/*.py`, deprecations.json/removals.json) over the Python source tree; not part of the library |
| test_deprecation_markers.test.ts:123 |  › test_compute_removals_ignores_subject_recorded_by_member | skip | (f) | DIVERGENCE: Python build tooling (`scripts/deprecations/*.py`, deprecations.json/removals.json) over the Python source tree; not part of the library |
| test_deprecation_markers.test.ts:124 |  › test_compute_removals_is_idempotent | skip | (f) | DIVERGENCE: Python build tooling (`scripts/deprecations/*.py`, deprecations.json/removals.json) over the Python source tree; not part of the library |
| test_deprecation_markers.test.ts:125 |  › test_compute_removals_bootstrap_has_no_previous | skip | (f) | DIVERGENCE: Python build tooling (`scripts/deprecations/*.py`, deprecations.json/removals.json) over the Python source tree; not part of the library |
| test_deprecation_markers.test.ts:126 |  › test_compute_removals_records_actual_vs_announced_version | skip | (f) | DIVERGENCE: Python build tooling (`scripts/deprecations/*.py`, deprecations.json/removals.json) over the Python source tree; not part of the library |
| test_krisp_ip_user_turn_start_strategy.test.ts:326 | TestKrispVivaIPUserTurnStartStrategy › test_init_raises_if_file_not_found | skip | (f) | DIVERGENCE: core has no filesystem, so the constructor can't check that the model file exists (the Krisp runtime does) |
| test_local_smart_turn_v3_resample.test.ts:91 | test_local_smart_turn_v3_resample › test_resample_48k_to_16k_close_to_vhq | skip | (f) | DIVERGENCE: resampler-wasm's HQ and VHQ presets differ in cutoff (soxr's share a passband), so HQ vs VHQ differ above ~6 kHz |
| test_provider_watch_scripts.test.ts:31 | TestInventory › test_covers_the_services_tree | skip | (f) | DIVERGENCE: Python repository-maintenance scripts (`scripts/provider-watch/*.py`); not part of the library |
| test_provider_watch_scripts.test.ts:31 | TestInventory › test_unit_ids_are_unique_and_sorted | skip | (f) | DIVERGENCE: Python repository-maintenance scripts (`scripts/provider-watch/*.py`); not part of the library |
| test_provider_watch_scripts.test.ts:31 | TestInventory › test_known_units[openai/llm-OpenAILLMService-True] | skip | (f) | DIVERGENCE: Python repository-maintenance scripts (`scripts/provider-watch/*.py`); not part of the library |
| test_provider_watch_scripts.test.ts:31 | TestInventory › test_known_units[openai/responses-llm-OpenAIResponsesLLMService-True] | skip | (f) | DIVERGENCE: Python repository-maintenance scripts (`scripts/provider-watch/*.py`); not part of the library |
| test_provider_watch_scripts.test.ts:31 | TestInventory › test_known_units[openai/realtime-OpenAIRealtimeLLMService-True] | skip | (f) | DIVERGENCE: Python repository-maintenance scripts (`scripts/provider-watch/*.py`); not part of the library |
| test_provider_watch_scripts.test.ts:31 | TestInventory › test_known_units[cartesia/tts-CartesiaTTSService-True] | skip | (f) | DIVERGENCE: Python repository-maintenance scripts (`scripts/provider-watch/*.py`); not part of the library |
| test_provider_watch_scripts.test.ts:31 | TestInventory › test_known_units[deepgram/stt-DeepgramSTTService-True] | skip | (f) | DIVERGENCE: Python repository-maintenance scripts (`scripts/provider-watch/*.py`); not part of the library |
| test_provider_watch_scripts.test.ts:31 | TestInventory › test_known_units[google/realtime-GeminiLiveLLMService-True] | skip | (f) | DIVERGENCE: Python repository-maintenance scripts (`scripts/provider-watch/*.py`); not part of the library |
| test_provider_watch_scripts.test.ts:31 | TestInventory › test_known_units[openai/live-realtime-OpenAILiveLLMService-True] | skip | (f) | DIVERGENCE: Python repository-maintenance scripts (`scripts/provider-watch/*.py`); not part of the library |
| test_provider_watch_scripts.test.ts:31 | TestInventory › test_known_units[azure/voice_live-realtime-AzureVoiceLiveLLMService-True] | skip | (f) | DIVERGENCE: Python repository-maintenance scripts (`scripts/provider-watch/*.py`); not part of the library |
| test_provider_watch_scripts.test.ts:31 | TestInventory › test_known_units[groq/llm-GroqLLMService-True] | skip | (f) | DIVERGENCE: Python repository-maintenance scripts (`scripts/provider-watch/*.py`); not part of the library |
| test_provider_watch_scripts.test.ts:31 | TestInventory › test_known_units[azure/tts-AzureTTSService-False] | skip | (f) | DIVERGENCE: Python repository-maintenance scripts (`scripts/provider-watch/*.py`); not part of the library |
| test_provider_watch_scripts.test.ts:31 | TestInventory › test_every_settings_model_literal_is_captured | skip | (f) | DIVERGENCE: Python repository-maintenance scripts (`scripts/provider-watch/*.py`); not part of the library |
| test_provider_watch_scripts.test.ts:31 | TestInventory › test_thin_wrappers_are_flagged | skip | (f) | DIVERGENCE: Python repository-maintenance scripts (`scripts/provider-watch/*.py`); not part of the library |
| test_provider_watch_scripts.test.ts:31 | TestInventory › test_base_classes_and_shims_are_excluded | skip | (f) | DIVERGENCE: Python repository-maintenance scripts (`scripts/provider-watch/*.py`); not part of the library |
| test_provider_watch_scripts.test.ts:31 | TestInventory › test_joins | skip | (f) | DIVERGENCE: Python repository-maintenance scripts (`scripts/provider-watch/*.py`); not part of the library |
| test_provider_watch_scripts.test.ts:31 | TestInventory › test_select_and_cli | skip | (f) | DIVERGENCE: Python repository-maintenance scripts (`scripts/provider-watch/*.py`); not part of the library |
| test_provider_watch_scripts.test.ts:31 | TestPlan › test_groups_cover_every_unit_once_in_order | skip | (f) | DIVERGENCE: Python repository-maintenance scripts (`scripts/provider-watch/*.py`); not part of the library |
| test_provider_watch_scripts.test.ts:31 | TestPlan › test_group_names_are_unique_and_artifact_safe | skip | (f) | DIVERGENCE: Python repository-maintenance scripts (`scripts/provider-watch/*.py`); not part of the library |
| test_provider_watch_scripts.test.ts:31 | TestPlan › test_cli_emits_the_matrix_json | skip | (f) | DIVERGENCE: Python repository-maintenance scripts (`scripts/provider-watch/*.py`); not part of the library |
| test_provider_watch_scripts.test.ts:31 | TestDigest › test_render_sections | skip | (f) | DIVERGENCE: Python repository-maintenance scripts (`scripts/provider-watch/*.py`); not part of the library |
| test_provider_watch_scripts.test.ts:31 | TestDigest › test_cli_writes_file | skip | (f) | DIVERGENCE: Python repository-maintenance scripts (`scripts/provider-watch/*.py`); not part of the library |
| test_provider_watch_scripts.test.ts:31 | TestProbe › test_missing_credentials_exit_2_and_name_only | skip | (f) | DIVERGENCE: Python repository-maintenance scripts (`scripts/provider-watch/*.py`); not part of the library |
| test_provider_watch_scripts.test.ts:31 | TestProbe › test_research_only_types_exit_3 | skip | (f) | DIVERGENCE: Python repository-maintenance scripts (`scripts/provider-watch/*.py`); not part of the library |
| test_provider_watch_scripts.test.ts:31 | TestProbe › test_unknown_provider_catalogue_exit_3 | skip | (f) | DIVERGENCE: Python repository-maintenance scripts (`scripts/provider-watch/*.py`); not part of the library |
| test_provider_watch_scripts.test.ts:31 | TestProbe › test_merge_probe_results_medians | skip | (f) | DIVERGENCE: Python repository-maintenance scripts (`scripts/provider-watch/*.py`); not part of the library |
| test_provider_watch_scripts.test.ts:31 | TestProbe › test_setting_values_parse_json_and_scalars | skip | (f) | DIVERGENCE: Python repository-maintenance scripts (`scripts/provider-watch/*.py`); not part of the library |
| test_provider_watch_scripts.test.ts:31 | TestProbe › test_too_many_models_rejected | skip | (f) | DIVERGENCE: Python repository-maintenance scripts (`scripts/provider-watch/*.py`); not part of the library |
| test_provider_watch_scripts.test.ts:31 | TestProbe › test_settings_reach_services_that_forward_kwargs | skip | (f) | DIVERGENCE: Python repository-maintenance scripts (`scripts/provider-watch/*.py`); not part of the library |
| test_provider_watch_scripts.test.ts:31 | TestPublish › test_opens_and_adopts | skip | (f) | DIVERGENCE: Python repository-maintenance scripts (`scripts/provider-watch/*.py`); not part of the library |
| test_provider_watch_scripts.test.ts:31 | TestPublish › test_multi_commit_branch_stitches_pr | skip | (f) | DIVERGENCE: Python repository-maintenance scripts (`scripts/provider-watch/*.py`); not part of the library |
| test_provider_watch_scripts.test.ts:31 | TestPublish › test_renames_changelog_fragments_to_pr_number | skip | (f) | DIVERGENCE: Python repository-maintenance scripts (`scripts/provider-watch/*.py`); not part of the library |
| test_provider_watch_scripts.test.ts:31 | TestPublish › test_sweep_leaves_correct_and_non_bot_prs_alone | skip | (f) | DIVERGENCE: Python repository-maintenance scripts (`scripts/provider-watch/*.py`); not part of the library |
| test_provider_watch_scripts.test.ts:31 | TestPublish › test_second_pass_is_a_no_op | skip | (f) | DIVERGENCE: Python repository-maintenance scripts (`scripts/provider-watch/*.py`); not part of the library |
| test_provider_watch_scripts.test.ts:31 | TestPublish › test_ensure_digest_keeps_the_rendered_digest | skip | (f) | DIVERGENCE: Python repository-maintenance scripts (`scripts/provider-watch/*.py`); not part of the library |
| test_provider_watch_scripts.test.ts:31 | TestPublish › test_ensure_digest_renders_plain_when_missing | skip | (f) | DIVERGENCE: Python repository-maintenance scripts (`scripts/provider-watch/*.py`); not part of the library |
| test_provider_watch_scripts.test.ts:31 | TestPublish › test_worth_an_issue | skip | (f) | DIVERGENCE: Python repository-maintenance scripts (`scripts/provider-watch/*.py`); not part of the library |
| test_provider_watch_scripts.test.ts:31 | TestPublish › test_missing_branch_is_skipped | skip | (f) | DIVERGENCE: Python repository-maintenance scripts (`scripts/provider-watch/*.py`); not part of the library |
| test_provider_watch_scripts.test.ts:31 | TestSdkVersions › test_sdk_requirements_come_from_pyproject_extras | skip | (f) | DIVERGENCE: Python repository-maintenance scripts (`scripts/provider-watch/*.py`); not part of the library |
| test_provider_watch_scripts.test.ts:31 | TestSdkVersions › test_thin_wrappers_fall_back_to_openai | skip | (f) | DIVERGENCE: Python repository-maintenance scripts (`scripts/provider-watch/*.py`); not part of the library |
| test_websocket_service.test.ts:475 |  › test_bounded_close_against_unresponsive_peer | skip | (f) | DIVERGENCE: Bun's client WebSocket reports `close` without waiting for the peer's close frame, so a deaf peer looks like a clean close; bounded close is covered with a stand-in socket |
