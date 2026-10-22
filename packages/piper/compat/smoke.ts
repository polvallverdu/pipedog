// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Runtime smoke test for tools/compat:
// - everywhere: PiperHttpTTSService through a pipeline against a fake `fetch`
//   returning a WAV stream;
// - on Bun, Node and Deno: PiperTTSService with the real engine (eSpeak NG
//   phonemization, phoneme ids) on a fake ONNX session, so nothing is
//   downloaded. Real inference is covered by test/e2e_piper_voice.test.ts.

import { TTSAudioRawFrame, TTSSpeakFrame } from "@pipedog/core/frames/frames";
import { runTest } from "@pipedog/core/tests/utils";
import { PiperHttpTTSService, PiperTTSService, type PiperVoice } from "@pipedog/piper";

function check(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(`piper smoke: ${message}`);
}

function wav(samples: number, sampleRate: number): Uint8Array {
  const out = new Uint8Array(44 + samples * 2);
  const view = new DataView(out.buffer);
  out.set(new TextEncoder().encode("RIFF"), 0);
  view.setUint32(4, 36 + samples * 2, true);
  out.set(new TextEncoder().encode("WAVEfmt "), 8);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  out.set(new TextEncoder().encode("data"), 36);
  view.setUint32(40, samples * 2, true);
  for (let i = 0; i < samples; i++)
    view.setInt16(44 + i * 2, Math.round(8000 * Math.sin(i / 5)), true);
  return out;
}

async function http(): Promise<void> {
  let body: { text?: string; voice?: string } = {};
  const tts = new PiperHttpTTSService({
    baseUrl: "http://piper.invalid/",
    sampleRate: 22050,
    settings: new PiperHttpTTSService.Settings({ voice: "en_US-ryan-high" }),
    fetch: (async (_url: unknown, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return new Response(wav(11025, 22050));
    }) as typeof fetch,
  });
  const [down] = await runTest(tts, {
    framesToSend: [new TTSSpeakFrame({ text: "Hello.", appendToContext: false })],
  });
  check(
    body.text === "Hello." && body.voice === "en_US-ryan-high",
    `request ${JSON.stringify(body)}`,
  );
  const audio = down.filter((f) => f instanceof TTSAudioRawFrame) as TTSAudioRawFrame[];
  const bytes = audio.reduce((n, f) => n + f.audio.length, 0);
  check(bytes === 11025 * 2, `http audio bytes ${bytes}`);
}

async function local(): Promise<void> {
  const {
    PiperConfig,
    PiperVoice: Voice,
    DEFAULT_PHONEME_ID_MAP,
  } = await import("@pipedog/piper/piper_voice");
  const voice = new Voice({
    config: PiperConfig.fromDict({
      audio: { sample_rate: 16000 },
      espeak: { voice: "en-us" },
      phoneme_id_map: DEFAULT_PHONEME_ID_MAP,
      num_symbols: 256,
      num_speakers: 1,
    }),
    session: {
      inputNames: ["input", "input_lengths", "scales"],
      outputNames: ["output"],
      async run(feeds) {
        const n = (feeds.input?.dims[1] as number) * 256;
        const data = Float32Array.from({ length: n }, (_, i) => 0.2 * Math.sin(i / 9));
        return { output: { type: "float32", data, dims: [1, 1, n] } };
      },
      async dispose() {},
    },
  });

  class SmokePiperTTSService extends PiperTTSService {
    override async _loadVoice(): Promise<PiperVoice> {
      return voice;
    }
  }
  const tts = new SmokePiperTTSService({
    sampleRate: 16000,
    settings: new PiperTTSService.Settings({ voice: "en_US-amy-low" }),
  });
  const [down] = await runTest(tts, {
    framesToSend: [new TTSSpeakFrame({ text: "Hello world. Bye.", appendToContext: false })],
  });
  const audio = down.filter((f) => f instanceof TTSAudioRawFrame) as TTSAudioRawFrame[];
  check(audio.length > 0, "local audio frames");
}

export default async function smoke(): Promise<void> {
  await http();
  if (globalThis.navigator?.userAgent !== "Cloudflare-Workers") await local();
}
