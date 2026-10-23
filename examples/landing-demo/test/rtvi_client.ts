// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// A scripted browser for the end-to-end test: what `@pipecat-ai/client-js` with its WebSocket
// transport puts on the wire (protobuf frames, RTVI messages in `message` frames), without a
// browser. It announces itself with `client-ready`, streams 20 ms of audio at a time as the
// microphone would (a recording first, if given), and records every RTVI message the bot sends.

import {
  InputAudioRawFrame,
  InputTransportMessageFrame,
  OutputAudioRawFrame,
  OutputTransportMessageFrame,
} from "@pipedog/core/frames/frames";
import { logger } from "@pipedog/core/utils/logger";
import { ProtobufFrameSerializer } from "@pipedog/serializer-protobuf/protobuf";
import { websocketConnect } from "@pipedog/transport-websocket/socket";

logger.setLevel("WARNING");

const FRAME_MS = 20;
const SAMPLE_RATE = 16000;

export interface RtviMessage {
  label: string;
  type: string;
  id?: string;
  data?: any;
}

export interface ScriptedBrowser {
  messages: RtviMessage[];
  audioBytes: () => number;
  /** Send an RTVI client message (`client-message`), and resolve with its `server-response`. */
  request(type: string, data?: unknown, timeoutMs?: number): Promise<RtviMessage>;
  /** Resolves when a message matching `match` has arrived. */
  waitFor(match: (m: RtviMessage) => boolean, timeoutMs?: number): Promise<RtviMessage>;
  close(): Promise<void>;
  closed: Promise<void>;
}

export interface ConnectOptions {
  /** Speech to send first (16-bit mono PCM at 16 kHz), then silence. */
  pcm16k?: Uint8Array;
}

export async function connectBrowser(
  url: string,
  origin: string,
  options: ConnectOptions = {},
): Promise<ScriptedBrowser> {
  const serializer = new ProtobufFrameSerializer();
  const connection = await websocketConnect(url, { additionalHeaders: { Origin: origin } });
  const messages: RtviMessage[] = [];
  let audioBytes = 0;
  let open = true;
  let nextId = 0;

  const send = async (message: RtviMessage) => {
    const data = await serializer.serialize(new OutputTransportMessageFrame({ message }));
    if (data !== null) await connection.send(data);
  };

  const closed = (async () => {
    try {
      for await (const data of connection) {
        const frame = await serializer.deserialize(data);
        if (frame instanceof InputTransportMessageFrame) {
          messages.push(frame.message as RtviMessage);
        } else if (frame instanceof InputAudioRawFrame || frame instanceof OutputAudioRawFrame) {
          audioBytes += frame.audio.length;
        }
      }
    } catch {
      // The socket closed.
    } finally {
      open = false;
    }
  })();

  await send({
    label: "rtvi-ai",
    type: "client-ready",
    id: String(nextId++),
    data: { version: "1.0.0", about: { library: "landing-demo-e2e" } },
  });

  // The microphone, in real time: the speech, if any, then silence.
  const chunkBytes = ((SAMPLE_RATE * FRAME_MS) / 1000) * 2;
  const silence = new Uint8Array(chunkBytes);
  const speech = options.pcm16k ?? new Uint8Array(0);
  let at = 0;
  const mic = (async () => {
    while (open) {
      const audio = at < speech.length ? speech.slice(at, at + chunkBytes) : silence;
      at += chunkBytes;
      const data = await serializer.serialize(
        new OutputAudioRawFrame({ audio, sampleRate: SAMPLE_RATE, numChannels: 1 }),
      );
      if (data !== null && open) {
        try {
          await connection.send(data);
        } catch {
          return;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, FRAME_MS));
    }
  })();

  const waitFor = async (match: (m: RtviMessage) => boolean, timeoutMs = 30_000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const found = messages.find(match);
      if (found) return found;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(
      `timed out waiting for an RTVI message; got: ${messages.map((m) => m.type).join(", ")}`,
    );
  };

  return {
    messages,
    audioBytes: () => audioBytes,
    async request(type, data = {}, timeoutMs = 10_000) {
      const id = `req-${nextId++}`;
      await send({ label: "rtvi-ai", type: "client-message", id, data: { t: type, d: data } });
      return await waitFor((m) => m.type === "server-response" && m.id === id, timeoutMs);
    },
    waitFor,
    async close() {
      open = false;
      await connection.close();
      await mic;
      await closed;
    },
    closed,
  };
}
