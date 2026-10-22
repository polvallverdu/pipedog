// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Shared by the sample bots: a scripted caller that sends the recorded question
// over a protobuf WebSocket and waits for the bot's spoken answer. Each bot is
// a self-test: it starts its own mock provider and server, makes one call and
// prints `BUNDLE_CHECK_OK` (or fails with a non-zero exit code).

import { SOXRAudioResampler } from "@pipedog/core/audio/resamplers/soxr_resampler";
import { InputAudioRawFrame, OutputAudioRawFrame } from "@pipedog/core/frames/frames";
import { ProtobufFrameSerializer } from "@pipedog/serializer-protobuf/protobuf";
import { WebsocketConnection } from "@pipedog/transport-websocket/socket";

/** Printed by a bot that worked; the harness looks for it. */
export const OK_MARKER = "BUNDLE_CHECK_OK";

/** The recorded question, 24 kHz mono 16-bit PCM, padded with silence on both sides. */
export function questionPcm24k(wav: Uint8Array): Uint8Array {
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  let at = 12;
  while (at + 8 <= wav.length) {
    const id = String.fromCharCode(...wav.subarray(at, at + 4));
    const size = view.getUint32(at + 4, true);
    if (id === "data") {
      const speech = wav.subarray(at + 8, at + 8 + size);
      const out = new Uint8Array(24000 * 2 * 1 + speech.length + 24000 * 2 * 2);
      out.set(speech, 24000 * 2);
      return out;
    }
    at += 8 + size + (size % 2);
  }
  throw new Error("no data chunk in the WAV");
}

/**
 * Accept a Bun WebSocket as a `WebsocketConnection`, as a host's server does.
 * `onConnection` runs once per connection.
 */
export function serveProtobuf(onConnection: (connection: WebsocketConnection) => Promise<void>): {
  url: string;
  stop(): void;
} {
  const server = Bun.serve<{ connection: WebsocketConnection | null }>({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req, srv) {
      return srv.upgrade(req, { data: { connection: null } })
        ? undefined
        : new Response("upgrade required", { status: 426 });
    },
    websocket: {
      open(ws) {
        const connection = new WebsocketConnection({
          send: (m) => ws.send(m),
          close: (code, reason) => ws.close(code, reason),
        });
        ws.data.connection = connection;
        void onConnection(connection).catch((e) => {
          console.error("bot failed:", e);
          process.exit(1);
        });
      },
      message(ws, message) {
        ws.data.connection?.feedMessage(message);
      },
      close(ws, code, reason) {
        ws.data.connection?.feedClose(code, reason);
      },
    },
  });
  return { url: `ws://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}

/**
 * Play the question to the bot at `url` (16 kHz, resampled with core's SOXR
 * resampler) and resolve once the bot has sent `minAudioBytes` of speech after
 * the question ended.
 */
export async function askQuestion(
  url: string,
  wav: Uint8Array,
  minAudioBytes = 20000,
  timeoutSecs = 15,
): Promise<{ audioBytes: number }> {
  const serializer = new ProtobufFrameSerializer();
  const pcm16k = await new SOXRAudioResampler().resample(questionPcm24k(wav), 24000, 16000);
  const ws = new WebSocket(url);
  ws.binaryType = "arraybuffer";
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error(`cannot connect to ${url}`));
  });

  let audioBytes = 0;
  let questionSentAt = Number.POSITIVE_INFINITY;
  const answered = new Promise<void>((resolve) => {
    ws.onmessage = async (event) => {
      const frame = await serializer.deserialize(new Uint8Array(event.data as ArrayBuffer));
      if (frame instanceof InputAudioRawFrame && Date.now() >= questionSentAt) {
        audioBytes += frame.audio.length;
        if (audioBytes >= minAudioBytes) resolve();
      }
    };
  });

  // Real time, 20 ms chunks, as a microphone would send them.
  const chunk = 16000 * 2 * 0.02;
  const speechStart = 16000 * 2 * 1;
  for (let i = 0; i < pcm16k.length; i += chunk) {
    if (i >= speechStart && questionSentAt === Number.POSITIVE_INFINITY)
      questionSentAt = Date.now();
    const data = await serializer.serialize(
      new OutputAudioRawFrame({
        audio: pcm16k.subarray(i, i + chunk),
        sampleRate: 16000,
        numChannels: 1,
      }),
    );
    ws.send(data as Uint8Array<ArrayBuffer>);
    await new Promise((r) => setTimeout(r, 20));
  }

  const timeout = new Promise<never>((_, reject) =>
    setTimeout(
      () => reject(new Error(`the bot did not answer within ${timeoutSecs} s`)),
      timeoutSecs * 1000,
    ),
  );
  await Promise.race([answered, timeout]);
  ws.close();
  return { audioBytes };
}
