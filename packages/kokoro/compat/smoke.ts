// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Runtime smoke test for tools/compat: runs the Kokoro engine (real eSpeak NG
// phonemization, batching, style lookup, trimming) on a fake ONNX session,
// and KokoroTTSService on top of it through a pipeline, so nothing is
// downloaded. Real inference is covered by test/e2e_kokoro_onnx.test.ts.

import { TTSAudioRawFrame, TTSSpeakFrame } from "@pipedog/core/frames/frames";
import { runTest } from "@pipedog/core/tests/utils";
import { Language } from "@pipedog/core/transcriptions/language";
import {
  Kokoro,
  KokoroTTSService,
  languageToKokoroLanguage,
  SAMPLE_RATE,
  type VoiceStyle,
} from "@pipedog/kokoro";
import type { OnnxSession } from "@pipedog/onnx";

function check(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(`kokoro smoke: ${message}`);
}

function fakeKokoro(): Kokoro {
  const session: OnnxSession = {
    inputNames: ["tokens", "style", "speed"],
    outputNames: ["audio"],
    async run(feeds) {
      const n = (feeds.tokens?.dims[1] as number) * 600;
      const audio = Float32Array.from({ length: n }, (_, i) => 0.3 * Math.sin(i / 7));
      return { audio: { type: "float32", data: audio, dims: [n] } };
    },
    async dispose() {},
  };
  const voice: VoiceStyle = { data: new Float32Array(510 * 256), shape: [510, 1, 256] };
  return new Kokoro(session, new Map([["af_heart", voice]]));
}

class SmokeKokoroTTSService extends KokoroTTSService {
  override async _loadKokoro(): Promise<Kokoro> {
    this._kokoro ??= fakeKokoro();
    return this._kokoro;
  }
}

export default async function smoke(): Promise<void> {
  check(languageToKokoroLanguage(Language.ZH) === "cmn", "language map");

  const kokoro = fakeKokoro();
  let samples = 0;
  for await (const [audio, rate] of kokoro.createStream("Hello world. How are you?", {
    voice: "af_heart",
  })) {
    check(rate === SAMPLE_RATE, `rate ${rate}`);
    samples += audio.length;
  }
  check(samples > 0, "no audio");

  const tts = new SmokeKokoroTTSService({
    sampleRate: 16000,
    settings: new KokoroTTSService.Settings({ voice: "af_heart" }),
  });
  const [down] = await runTest(tts, {
    framesToSend: [new TTSSpeakFrame({ text: "Hello.", appendToContext: false })],
  });
  const audio = down.filter((f) => f instanceof TTSAudioRawFrame) as TTSAudioRawFrame[];
  check(audio.length > 0 && audio.every((f) => f.sampleRate === 16000), "service audio frames");
}
