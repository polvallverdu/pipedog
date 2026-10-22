// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Samples for content/docs/services/tts/piper.mdx. Type-checked on every docs build.

// #region usage
import { PiperHttpTTSService, PiperTTSService } from "@pipedog/piper/tts";

// Downloads en_US-ryan-high.onnx and .onnx.json from rhasspy/piper-voices on first start.
const tts = new PiperTTSService({
  settings: new PiperTTSService.Settings({ voice: "en_US-ryan-high" }),
});
// #endregion usage

// #region downloadDir
// Voices already on disk: put <voice>.onnx and <voice>.onnx.json in downloadDir.
const fromDisk = new PiperTTSService({
  downloadDir: "/models/piper",
  settings: new PiperTTSService.Settings({ voice: "en_US-lessac-medium" }),
});
// #endregion downloadDir

// #region http
// A Piper HTTP server: python -m piper.http_server -m en_US-ryan-high
const remote = new PiperHttpTTSService({
  baseUrl: "http://localhost:5000",
  settings: new PiperHttpTTSService.Settings({ voice: "en_US-ryan-high" }),
});

// #endregion http

// #region engine
import { downloadVoice, PiperVoice } from "@pipedog/piper/piper_voice";

await downloadVoice("en_US-lessac-medium", "/models");
const voice = await PiperVoice.load("/models/en_US-lessac-medium.onnx");
for await (const chunk of voice.synthesize("Hello world. How are you?")) {
  chunk.audioInt16Bytes; // one sentence, 16-bit PCM at voice.config.sampleRate
}
// #endregion engine
