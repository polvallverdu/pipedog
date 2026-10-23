// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Samples for content/docs/services/stt/cloudflare.mdx. Type-checked on every docs build.

import type { WorkersAIBinding } from "@pipedog/cloudflare/client";
import { STTUpdateSettingsFrame } from "@pipedog/core/frames/frames";
import { Language } from "@pipedog/core/transcriptions/language";

declare const env: { AI: WorkersAIBinding };

// #region flux-binding
import { WorkersAIFluxSTTService } from "@pipedog/cloudflare/flux_stt";

// Inside a Worker or Durable Object: the AI binding, no token.
const flux = new WorkersAIFluxSTTService({
  ai: env.AI,
  settings: new WorkersAIFluxSTTService.Settings({
    eotThreshold: 0.75,
    keyterm: ["pipedog", "Cloudflare"],
  }),
});
// #endregion flux-binding

// #region flux-rest
// Anywhere else: an account ID and an API token with Workers AI access.
const fluxRest = new WorkersAIFluxSTTService({
  accountId: process.env.CLOUDFLARE_ACCOUNT_ID ?? "",
  apiToken: process.env.CLOUDFLARE_API_TOKEN ?? "",
});

// #endregion flux-rest

// #region client
import { WorkersAIClient } from "@pipedog/cloudflare/client";

// One client shared by several services.
const client = new WorkersAIClient({ ai: env.AI });
const fluxShared = new WorkersAIFluxSTTService({ client });

// #endregion client

// #region nova
import { WorkersAINova3STTService } from "@pipedog/cloudflare/stt";

const nova = new WorkersAINova3STTService({
  ai: env.AI,
  settings: new WorkersAINova3STTService.Settings({ language: Language.EN, smartFormat: true }),
});

// #endregion nova

// #region whisper
import { WorkersAIWhisperModel, WorkersAIWhisperSTTService } from "@pipedog/cloudflare/whisper";

const whisper = new WorkersAIWhisperSTTService({
  ai: env.AI,
  settings: new WorkersAIWhisperSTTService.Settings({
    model: WorkersAIWhisperModel.LARGE_V3_TURBO,
    language: Language.EN,
    prompt: "A conversation about Cloudflare Workers.",
  }),
});
// #endregion whisper

// #region update
// Queue it on the worker, or push it from a processor upstream of the service.
const update = new STTUpdateSettingsFrame({
  delta: new WorkersAIFluxSTTService.Settings({ eotThreshold: 0.85 }),
});
// #endregion update

void [flux, fluxRest, fluxShared, nova, whisper, update];
