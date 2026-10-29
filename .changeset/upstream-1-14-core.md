---
"@pipedog/core": minor
---

Core brought up to pipecat main after 1.14 (see `porting/UPSTREAM_BUMP.md`):

- Expressive conversation (alpha, pipecat-ai/pipecat#6303, #6315, #6319, #6385, #6439, #6442): the
  new `expressive/*` modules (`ExpressionDelivery`, `ExpressionSound`, `ExpressionPolicy`,
  `ExpressionGuidance`, the formatter, perception, instructions) and `adapters/tts/base_expression_adapter`,
  turned on with `new PipelineParams({ enableExpressiveConversation: true })`. TTS services perform
  the expression tags the LLM writes; `TTSTextFrame.delivery`, perception on transcription frames,
  and the new `TTSMetadataFrame`, `PerceptionMetadataFrame` and `ExpressionMetadataFrame`. Provider
  expression adapters come with their packages.
- ⚠️ `pipeline/llm_with_backend` is now a package, as upstream (#6435): `LLMWithBackend`,
  `BackendConnector`, `PredictiveDelegation` (new, #6174) and the request strategies are exported
  from it; prompts and connector internals live in `llm_with_backend/prompts`, `.../connector`.
  `RELAY_NOTE` is now `BACKEND_MESSAGE_RELAY_INSTRUCTION` and `STRATEGY_PLACEHOLDER` is
  `PAIRING_INSTRUCTION_STRATEGY_PLACEHOLDER`. Shorter delegation acknowledgements (#6267, #6314).
- ⚠️ TTS text filters are removed (deprecated upstream in 1.14): the `textFilters` option of
  `TTSService` and `MarkdownTextFilter`. Use text transforms instead (`LLMTextProcessor` takes
  `textTransforms`; `stripMarkdown` / `new StripMarkdown({ stripUrls })`).
- ⚠️ `WebsocketService` bounds each send by `wsSendTimeout` and adds `_receiveUntilConfirmed`;
  `sendWithRetry` is deprecated upstream and kept only until the Cartesia turns STT and Inworld TTS
  ports drop it.
- `ServiceSwitcher` hands metadata from a service outside it to its inactive members (#6365).
- Fixed: TTS services without word timestamps joining streamed sentences with two spaces (#6366);
  closing tags written against a word (#6368); `SkipTagsAggregator` with several tag pairs or
  identical start/end tags (#6367); classifier clients surfacing a broken TLS connection as a
  `ClassifierError` (#6409); `nanosecondsToStr` dropping a microsecond (#6411); secret redaction of
  chained pairs (#6308).
- Pipeline flush probes are tracked per leg (`PipelineFlushFrame.flushId`, #6268).
- `LLMService` logs the context in Python's repr format, as upstream does.
