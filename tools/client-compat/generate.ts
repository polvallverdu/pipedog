// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Records wire fixtures between ProtobufFrameSerializer and the official
// Pipecat browser client (@pipecat-ai/websocket-transport), for
// packages/serializer-protobuf/test/client_js_compat.test.ts.
//
//   bun tools/client-compat/generate.ts <dir with node_modules/@pipecat-ai/{websocket-transport,client-js}>
//
// Install the client in a scratch directory first (no install scripts needed):
//
//   npm install --ignore-scripts @pipecat-ai/websocket-transport@1.7.2 @pipecat-ai/client-js@1.13.1
//
// Client to server: the client's own serializer encodes what the client sends
// (mic audio, RTVI messages); the test decodes those bytes with ours.
// Server to client: our serializer encodes what a bot sends; the client's
// serializer decodes it here, and the fixture records both the bytes and what
// the client made of them. The test checks that ours still produces exactly
// those bytes.

import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  type Frame,
  InterruptionFrame,
  OutputAudioRawFrame,
  OutputTransportMessageUrgentFrame,
  TextFrame,
  TranscriptionFrame,
} from "../../packages/core/src/frames/frames.ts";
import { ProtobufFrameSerializer } from "../../packages/serializer-protobuf/src/protobuf.ts";

const dir = process.argv[2];
if (!dir) {
  console.error("usage: bun tools/client-compat/generate.ts <client install dir>");
  process.exit(2);
}
const root = resolve(dir);
const pkgVersion = async (name: string): Promise<string> =>
  (await Bun.file(join(root, "node_modules", name, "package.json")).json()).version;
const importFrom = (name: string, file: string) =>
  import(pathToFileURL(join(root, "node_modules", name, file)).href);

const wt = await importFrom("@pipecat-ai/websocket-transport", "dist/index.module.js");
const cj = await importFrom("@pipecat-ai/client-js", "dist/index.module.js");
const clientSerializer = new wt.ProtobufFrameSerializer();

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

function pcm(samples: number[]): Uint8Array {
  return new Uint8Array(Int16Array.from(samples).buffer);
}

function withIds<T extends Frame>(frame: T, id: number, name: string): T {
  frame.id = id;
  frame.name = name;
  return frame;
}

const message = (type: string, data: unknown, id: string) => new cj.RTVIMessage(type, data, id);

// --- client -> server -------------------------------------------------------

const clientToServer = [
  {
    name: "audio_16k_mono",
    bytes: hex(
      clientSerializer.serializeAudio(
        pcm([0, 1, -1, 32767, -32768, 1234, -4321, 7]).buffer,
        16000,
        1,
      ),
    ),
    expect: {
      kind: "audio",
      sampleRate: 16000,
      numChannels: 1,
      samples: [0, 1, -1, 32767, -32768, 1234, -4321, 7],
    },
  },
  ...[
    message(
      "client-ready",
      { version: "1.2.0", about: { library: "@pipecat-ai/client-js", library_version: "1.13.1" } },
      "c0ffee01",
    ),
    message(
      "send-text",
      {
        content: "Hola, ¿qué tal? 👋 日本語",
        options: { run_immediately: true, audio_response: false },
      },
      "c0ffee02",
    ),
    message(
      "client-message",
      {
        t: "custom",
        d: { n: 1.5, big: 12345678901, nested: [1, { a: null, b: true }], s: 'é\u0000\n"' },
      },
      "c0ffee03",
    ),
    message("disconnect-bot", {}, "c0ffee04"),
  ].map((msg) => ({
    name: `message_${msg.type}`,
    bytes: hex(clientSerializer.serializeMessage(msg)),
    expect: { kind: "message", message: JSON.parse(JSON.stringify(msg)) },
  })),
];

// --- server -> client -------------------------------------------------------

const ours = new ProtobufFrameSerializer();
const botReady = {
  label: "rtvi-ai",
  type: "bot-ready",
  id: "c0ffee01",
  data: { version: "1.2.0", about: { library: "pipedog", note: "ünïcödé 🐶", ratio: 0.1 } },
};
const serverFrames: [string, Frame][] = [
  [
    "audio_24k_mono",
    withIds(
      new OutputAudioRawFrame({
        audio: pcm([0, 100, -100, 32767, -32768, 42]),
        sampleRate: 24000,
        numChannels: 1,
      }),
      7,
      "OutputAudioRawFrame#3",
    ),
  ],
  [
    "message_bot_ready",
    withIds(new OutputTransportMessageUrgentFrame({ message: botReady }), 8, "x"),
  ],
  [
    "message_server_message",
    withIds(
      new OutputTransportMessageUrgentFrame({
        message: {
          label: "rtvi-ai",
          type: "server-message",
          data: { score: 3.25, items: ["a", "ß"] },
        },
      }),
      9,
      "y",
    ),
  ],
  ["text", withIds(new TextFrame({ text: "hello ✓" }), 10, "TextFrame#1")],
  [
    "transcription",
    withIds(
      new TranscriptionFrame({ text: "héllo", userId: "u1", timestamp: "2026-01-01T00:00:00Z" }),
      11,
      "TranscriptionFrame#1",
    ),
  ],
  ["interruption", withIds(new InterruptionFrame(), 12, "InterruptionFrame#1")],
];

const serverToClient = [];
for (const [name, frame] of serverFrames) {
  const bytes = (await ours.serialize(frame)) as Uint8Array;
  let client: unknown;
  try {
    const parsed = await clientSerializer.deserialize(new Blob([bytes]));
    client =
      parsed.type === "audio"
        ? { type: "audio", samples: Array.from(parsed.audio as Int16Array) }
        : { type: "message", message: parsed.message };
  } catch (e) {
    client = { error: e instanceof Error ? e.message : String(e) };
  }
  serverToClient.push({ name, bytes: hex(bytes), client });
}

const fixtures = {
  generator: "tools/client-compat/generate.ts",
  client: {
    "@pipecat-ai/websocket-transport": await pkgVersion("@pipecat-ai/websocket-transport"),
    "@pipecat-ai/client-js": await pkgVersion("@pipecat-ai/client-js"),
    "@protobuf-ts/runtime": await pkgVersion("@protobuf-ts/runtime"),
  },
  clientToServer,
  serverToClient,
};

const out = join(import.meta.dir, "fixtures.json");
await Bun.write(out, `${JSON.stringify(fixtures, null, 2)}\n`);
console.log(`wrote ${out}`);
