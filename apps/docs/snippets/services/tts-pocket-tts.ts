// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Samples for content/docs/services/tts/pocket-tts.mdx. Type-checked on every docs build.

// #region usage
import { TTSUpdateSettingsFrame } from "@pipedog/core/frames/frames";
import { Language } from "@pipedog/core/transcriptions/language";
import { PocketTTSService } from "@pipedog/pocket-tts/tts";

// Downloads the English model (405 MB, or 180 MB with quantize) and the voice on first start.
const tts = new PocketTTSService({
  quantize: true,
  settings: new PocketTTSService.Settings({ voice: "alba", language: Language.EN }),
});
// #endregion usage

// #region modelDir
// Files you already have: bundle.json, the .onnx graphs, tokenizer.model and
// embeddings/<voice>.safetensors in one directory. Anything missing is downloaded.
const fromDisk = new PocketTTSService({
  modelOptions: { modelDir: "/models/pocket-tts/english" },
  settings: new PocketTTSService.Settings({ voice: "alba" }),
});
// #endregion modelDir

// #region update
// Queue it on the worker, or push it from a processor upstream of the service.
// The voice is re-derived on the next utterance; the language can't change at runtime.
const update = new TTSUpdateSettingsFrame({
  delta: new PocketTTSService.Settings({ voice: "marius" }),
});

// #endregion update

// #region engine
import { TTSModel } from "@pipedog/pocket-tts/pocket_tts";

const model = await TTSModel.loadModel({ language: "english", temp: 0.7 });
const voice = await model.getStateForAudioPrompt("alba");
for await (const chunk of model.generateAudioStream(voice, "Hello world.")) {
  // chunk: a Float32Array of 1920 samples at model.sampleRate (24000 Hz)
}
// #endregion engine
