// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Samples for content/docs/services/stt/funasr.mdx. Type-checked on every docs build.

// #region usage
import { STTUpdateSettingsFrame } from "@pipedog/core/frames/frames";
import { Language } from "@pipedog/core/transcriptions/language";
import { FunASRSTTService } from "@pipedog/funasr/stt";

// Downloads SenseVoiceSmall (model.int8.onnx, 239 MB, and tokens.txt) on first start.
const stt = new FunASRSTTService({
  settings: new FunASRSTTService.Settings({ language: Language.ZH, useItn: true }),
});
// #endregion usage

// #region paths
// A directory holding model.int8.onnx (or model.onnx) and tokens.txt...
const fromDir = new FunASRSTTService({
  settings: new FunASRSTTService.Settings({ model: "/models/sense-voice" }),
});
// ...or explicit files.
const fromFiles = new FunASRSTTService({
  modelOptions: { modelFile: "/models/model.int8.onnx", tokens: "/models/tokens.txt" },
});
// #endregion paths

// #region update
// Queue it on the worker, or push it from a processor upstream of the service.
const update = new STTUpdateSettingsFrame({
  delta: new FunASRSTTService.Settings({ language: Language.JA }),
});

// #endregion update

// #region engine
import { AutoModel, richTranscriptionPostprocess } from "@pipedog/funasr/funasr";

const model = new AutoModel({ model: "iic/SenseVoiceSmall" });
const samples = new Float32Array(16000); // 16 kHz mono audio in [-1, 1]
const [result] = await model.generate({ input: samples, language: "auto", useItn: true });
if (result) {
  console.log(result.text); // "<|en|><|NEUTRAL|><|Speech|><|withitn|>..."
  console.log(richTranscriptionPostprocess(result.text)); // the text without the tags
}
// #endregion engine
