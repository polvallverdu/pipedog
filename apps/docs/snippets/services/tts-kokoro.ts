// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Samples for content/docs/services/tts/kokoro.mdx. Type-checked on every docs build.

// #region usage
import { TTSUpdateSettingsFrame } from "@pipedog/core/frames/frames";
import { Language } from "@pipedog/core/transcriptions/language";
import { KokoroTTSService } from "@pipedog/kokoro/tts";

// Downloads kokoro-v1.0.onnx (310 MiB) and voices-v1.0.bin (27 MiB) on first start.
const tts = new KokoroTTSService({
  settings: new KokoroTTSService.Settings({ voice: "af_heart", language: Language.EN, speed: 1.0 }),
});
// #endregion usage

// #region paths
// Files you already have, or the smaller int8 model from the same release.
const int8 = new KokoroTTSService({
  modelPath: "/models/kokoro-v1.0.int8.onnx", // used as is if present...
  modelUrl:
    "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.int8.onnx", // ...else downloaded from here
  voicesPath: "/models/voices-v1.0.bin",
  settings: new KokoroTTSService.Settings({ voice: "af_heart" }),
});
// #endregion paths

// #region update
// Queue it on the worker, or push it from a processor upstream of the service.
const update = new TTSUpdateSettingsFrame({
  delta: new KokoroTTSService.Settings({ voice: "bf_emma", language: Language.EN_GB, speed: 1.1 }),
});

// #endregion update

// #region engine
import { Kokoro } from "@pipedog/kokoro/kokoro_onnx";

const kokoro = await Kokoro.load("/models/kokoro-v1.0.onnx", "/models/voices-v1.0.bin");
for await (const [samples, sampleRate] of kokoro.createStream("Hello there!", {
  voice: "af_heart",
  lang: "en-us",
})) {
  // samples: a Float32Array at sampleRate (24000 Hz), one chunk per phoneme batch
}
// #endregion engine
