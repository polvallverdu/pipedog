// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Samples for content/docs/services/tts/rime.mdx. Type-checked on every docs build.

// #region usage
import { TTSUpdateSettingsFrame } from "@pipedog/core/frames/frames";
import { RimeTTSService } from "@pipedog/rime/tts";

const tts = new RimeTTSService({
  apiKey: process.env.RIME_API_KEY ?? "",
  settings: new RimeTTSService.Settings({
    model: "coda",
    voice: "luna",
    timeScaleFactor: 1.0,
  }),
});

// #endregion usage

// #region http
import { RimeHttpTTSService } from "@pipedog/rime/tts";

const httpTts = new RimeHttpTTSService({
  apiKey: process.env.RIME_API_KEY ?? "",
  settings: new RimeHttpTTSService.Settings({ model: "mistv2", voice: "luna", speedAlpha: 1.1 }),
});

// #endregion http

// #region v1
import { TextAggregationMode } from "@pipedog/core/services/tts_service";
import { RimeV1TTSService } from "@pipedog/rime/tts_v1";

const v1 = new RimeV1TTSService({
  apiKey: process.env.RIME_API_KEY ?? "",
  // "binary" (protobuf) or "json" (proto3 JSON). Binary is the default.
  websocketProtocol: "binary",
  // Stream LLM tokens and let Rime accumulate them into sentences.
  textAggregationMode: TextAggregationMode.TOKEN,
  // The model is required: "coda" and "mistv3" select Rime's public endpoints.
  settings: new RimeV1TTSService.Settings({ model: "coda", voice: "luna" }),
});
// #endregion v1

// #region helpers
// Text helpers for Rime's markup, for use in text transforms.
const spelled = RimeTTSService.SPELL("A1B2");
const paused = `One moment.${RimeTTSService.PAUSE_TAG(0.5)} Thanks.`;

// Custom pronunciation and inline speed apply to the next message sent.
const pronounced = tts.PRONOUNCE("Say hello", "hello", "h'El0");
const slow = tts.INLINE_SPEED("slowly", 0.7);
// #endregion helpers

// #region update
// Queue it on the worker, or push it from a processor upstream of the service.
// Every setting of the WebSocket service is a URL parameter, so a change reconnects.
const update = new TTSUpdateSettingsFrame({
  delta: new RimeTTSService.Settings({ voice: "another-voice" }),
});
// #endregion update
