// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Samples for content/docs/services/stt/moonshine.mdx. Type-checked on every docs build.

// #region usage
import { STTUpdateSettingsFrame } from "@pipedog/core/frames/frames";
import { Language } from "@pipedog/core/transcriptions/language";
import { Model, MoonshineSTTService } from "@pipedog/moonshine/stt";

// Downloads small-streaming (142 MB) from download.moonshine.ai on first start.
const stt = new MoonshineSTTService({
  settings: new MoonshineSTTService.Settings({
    model: Model.SMALL_STREAMING,
    language: Language.EN,
  }),
});
// #endregion usage

// #region cacheRoot
// Models already on disk, in <cacheRoot>/download.moonshine.ai/model/<model>/...
// (the layout moonshine_voice uses, so a moonshine_voice cache can be copied over).
const fromDisk = new MoonshineSTTService({
  cacheRoot: "/models/moonshine",
  settings: new MoonshineSTTService.Settings({ model: Model.TINY }),
});
// #endregion cacheRoot

// #region update
// Queue it on the worker, or push it from a processor upstream of the service.
// A model or language change reloads the model.
const update = new STTUpdateSettingsFrame({
  delta: new MoonshineSTTService.Settings({ language: Language.ES }),
});

// #endregion update

// #region engine
import { ModelArch, Transcriber } from "@pipedog/moonshine/moonshine_voice";

const transcriber = new Transcriber("/models/tiny-en", ModelArch.TINY);
const samples = new Float32Array(16000); // mono audio in [-1, 1]
const transcript = await transcriber.transcribeWithoutStreaming(samples, 16000);
console.log(transcript.lines.map((line) => line.text).join(" "));
// #endregion engine
