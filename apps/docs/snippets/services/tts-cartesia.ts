// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Samples for content/docs/services/tts/cartesia.mdx. Type-checked on every docs build.

// #region usage
import {
  CartesiaEmotion,
  CartesiaHttpTTSService,
  CartesiaTTSService,
  GenerationConfig,
} from "@pipedog/cartesia/tts";
import { TTSUpdateSettingsFrame } from "@pipedog/core/frames/frames";
import { TextAggregationMode } from "@pipedog/core/services/tts_service";
import { Language } from "@pipedog/core/transcriptions/language";

const tts = new CartesiaTTSService({
  apiKey: process.env.CARTESIA_API_KEY ?? "",
  settings: new CartesiaTTSService.Settings({
    voice: "your-voice-id",
    model: "sonic-3.6",
    language: Language.EN,
  }),
});
// #endregion usage

// #region generation
const expressive = new CartesiaTTSService({
  apiKey: process.env.CARTESIA_API_KEY ?? "",
  // Stream LLM tokens straight to Cartesia instead of waiting for whole sentences.
  textAggregationMode: TextAggregationMode.TOKEN,
  settings: new CartesiaTTSService.Settings({
    voice: "your-voice-id",
    generationConfig: new GenerationConfig({ speed: 1.1, emotion: CartesiaEmotion.EXCITED }),
  }),
});
// #endregion generation

// #region tags
// Helpers that build Cartesia SSML tags, for use in text transforms.
const spelled = CartesiaTTSService.SPELL("A1B2");
const tagged = `${CartesiaTTSService.EMOTION_TAG(CartesiaEmotion.CALM)} One moment.${CartesiaTTSService.PAUSE_TAG(0.5)}`;

// Say words as IPA describes. Register it last in textTransforms.
const pronounce = CartesiaTTSService.pronunciationTransformIpa({ Metformin: "mɛtˈfɔɹmɪn" });
const withPronunciations = new CartesiaTTSService({
  apiKey: process.env.CARTESIA_API_KEY ?? "",
  settings: new CartesiaTTSService.Settings({ voice: "your-voice-id" }),
  textTransforms: [["*", pronounce]],
});
// #endregion tags

// #region http
const httpTts = new CartesiaHttpTTSService({
  apiKey: process.env.CARTESIA_API_KEY ?? "",
  settings: new CartesiaHttpTTSService.Settings({ voice: "your-voice-id" }),
});
// #endregion http

// #region update
// Queue it on the worker, or push it from a processor upstream of the service.
const update = new TTSUpdateSettingsFrame({
  delta: new CartesiaTTSService.Settings({ voice: "another-voice-id", language: Language.ES }),
});
// #endregion update
