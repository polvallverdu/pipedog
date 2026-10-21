// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// A scripted user for a voice session: streams a recording to the agent in real
// time (20 ms frames at 16 kHz), and counts the audio the agent speaks back.
//
//   bun client/client.ts ws://localhost:8787/api/session/alice recording.wav

import { readFileSync } from "node:fs";
import { InputAudioRawFrame, OutputAudioRawFrame } from "@pipedog/core/frames/frames";
import { ProtobufFrameSerializer } from "@pipedog/serializer-protobuf/protobuf";
import { websocketConnect } from "@pipedog/transport-websocket/socket";
import { wavToPcm16k } from "./wav.ts";

const FRAME_MS = 20;
const SAMPLE_RATE = 16000;

export interface ScriptedUserResult {
  /** Bytes of the agent's speech received, as 24 kHz PCM. */
  spokenBytes: number;
  /** When the session started and ended, in milliseconds since the epoch. */
  startedAt: number;
  endedAt: number;
}

export interface ScriptedUserOptions {
  /** The longest to listen for the reply after the recording ends, in seconds. Defaults to 10. */
  listenSecs?: number;
  /**
   * Hang up as soon as this returns true (checked while listening), after a
   * short wait for the last audio to arrive. Without it, listen for `listenSecs`.
   */
  until?: () => boolean;
}

/** After `until` is met, how long to wait for the audio still in flight, in seconds. */
const TAIL_SECS = 1.5;

/**
 * Stream `pcm16k` (16-bit mono, 16 kHz) to the agent at `url` in real time, then
 * listen for the reply.
 */
export async function runScriptedUser(
  url: string,
  pcm16k: Uint8Array,
  options: ScriptedUserOptions = {},
): Promise<ScriptedUserResult> {
  const listenSecs = options.listenSecs ?? 10;
  const serializer = new ProtobufFrameSerializer();
  const connection = await websocketConnect(url);
  const startedAt = Date.now();
  let spokenBytes = 0;

  const listening = (async () => {
    for await (const data of connection) {
      const frame = await serializer.deserialize(data);
      // The protobuf "audio" message is decoded as input audio on either end.
      if (frame instanceof InputAudioRawFrame || frame instanceof OutputAudioRawFrame) {
        spokenBytes += frame.audio.length;
      }
    }
  })();

  const chunkBytes = ((SAMPLE_RATE * FRAME_MS) / 1000) * 2;
  for (let at = 0; at < pcm16k.length; at += chunkBytes) {
    const audio = pcm16k.slice(at, at + chunkBytes);
    // The wire format carries audio as one message type either way; the server
    // reads these as input audio.
    const message = await serializer.serialize(
      new OutputAudioRawFrame({ audio, sampleRate: SAMPLE_RATE, numChannels: 1 }),
    );
    if (message !== null) await connection.send(message);
    await new Promise((resolve) => setTimeout(resolve, FRAME_MS));
  }

  // Let the reply arrive, then hang up.
  const deadline = Date.now() + listenSecs * 1000;
  if (options.until) {
    while (!options.until() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await new Promise((resolve) => setTimeout(resolve, TAIL_SECS * 1000));
  } else {
    await new Promise((resolve) => setTimeout(resolve, listenSecs * 1000));
  }
  await connection.close();
  await listening.catch(() => {});
  return { spokenBytes, startedAt, endedAt: Date.now() };
}

if (import.meta.main) {
  const [url, wavPath] = process.argv.slice(2);
  if (!url || !wavPath) throw new Error("usage: bun client/client.ts <ws-url> <recording.wav>");
  const result = await runScriptedUser(url, wavToPcm16k(readFileSync(wavPath)));
  console.log(`agent spoke ${result.spokenBytes} bytes of audio`);
}
