// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Samples for content/docs/services/tts/cloudflare.mdx. Type-checked on every docs build.

import type { WorkersAIBinding } from "@pipedog/cloudflare/client";
import { TTSUpdateSettingsFrame } from "@pipedog/core/frames/frames";
import { Language } from "@pipedog/core/transcriptions/language";

declare const env: { AI: WorkersAIBinding };

// #region aura
import { WorkersAIAuraModel, WorkersAIAuraTTSService } from "@pipedog/cloudflare/tts";

const tts = new WorkersAIAuraTTSService({
  ai: env.AI,
  sampleRate: 24000,
  settings: new WorkersAIAuraTTSService.Settings({
    model: WorkersAIAuraModel.AURA_2_EN,
    voice: "asteria",
  }),
});
// #endregion aura

// #region aura-rest
const ttsRest = new WorkersAIAuraTTSService({
  accountId: process.env.CLOUDFLARE_ACCOUNT_ID ?? "",
  apiToken: process.env.CLOUDFLARE_API_TOKEN ?? "",
  settings: new WorkersAIAuraTTSService.Settings({
    model: WorkersAIAuraModel.AURA_2_ES,
    voice: "celeste",
  }),
});

// #endregion aura-rest

// #region aura-http
import { WorkersAIAuraHttpTTSService } from "@pipedog/cloudflare/tts";

const ttsHttp = new WorkersAIAuraHttpTTSService({ ai: env.AI, sampleRate: 24000 });

// #endregion aura-http

// #region melotts
import { WorkersAIMeloTTSService } from "@pipedog/cloudflare/melotts";

// Any MP3 decoder that returns per-channel Float32Arrays and a sample rate,
// e.g. mpg123-decoder's MPEGDecoder (bun add mpg123-decoder):
//   const decoder = new MPEGDecoder(); await decoder.ready;
//   decodeAudio: (mp3) => { decoder.reset(); return decoder.decode(mp3); }
declare function decodeMp3(mp3: Uint8Array): Promise<{
  channelData: Float32Array[];
  sampleRate: number;
}>;

const melo = new WorkersAIMeloTTSService({
  ai: env.AI,
  decodeAudio: decodeMp3,
  settings: new WorkersAIMeloTTSService.Settings({ language: Language.FR }),
});
// #endregion melotts

// #region update
// Queue it on the worker, or push it from a processor upstream of the service.
const update = new TTSUpdateSettingsFrame({
  delta: new WorkersAIAuraTTSService.Settings({ voice: "orion" }),
});
// #endregion update

void [tts, ttsRest, ttsHttp, melo, update];
