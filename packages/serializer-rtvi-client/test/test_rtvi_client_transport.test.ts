// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_rtvi_client_transport.py

/**
 * Tests for `RTVIClientTransport` (transports/websocket/rtvi_client).
 *
 * `TestRTVIClientTransportHandshake` covers the RTVI-specific bits added on top of
 * the WebSocket client transport (the `client-ready` handshake message and
 * `bot-ready` detection). `TestRTVIClientTransportIntegration` runs the transport
 * in a real pipeline against a tiny RTVI WebSocket server and asserts the bot's
 * server messages arrive as the right frames.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import {
  type Frame,
  LLMFullResponseEndFrame,
  LLMFullResponseStartFrame,
  LLMTextFrame,
  OutputAudioRawFrame,
  TranscriptionFrame,
} from "@pipedog/core/frames/frames";
import * as RTVI from "@pipedog/core/processors/frameworks/rtvi/models";
import { runTest, SleepFrame } from "@pipedog/core/tests/utils";
import { RTVIClientTransport } from "../../transport-websocket/src/rtvi_client.ts";
import { type WebsocketServer, websocketServe } from "../../transport-websocket/src/serve.ts";
import type { WebsocketConnection } from "../../transport-websocket/src/socket.ts";
import { RTVIClientSerializer } from "../src/rtvi_client.ts";

type Any = any;

function _rtvi(msgType: string, data: Record<string, unknown> | null = null): string {
  return JSON.stringify({ label: RTVI.MESSAGE_LABEL, type: msgType, id: "x", data });
}

function _freePort(): number {
  const s = Bun.listen({ hostname: "localhost", port: 0, socket: { data() {} } });
  const port = s.port;
  s.stop(true);
  return port;
}

function b64decode(s: string): Uint8Array {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

describe("TestRTVIClientTransportHandshake", () => {
  let transport: Any;

  beforeEach(() => {
    transport = new RTVIClientTransport("ws://localhost:0");
  });

  test("test_defaults_to_rtvi_client_serializer", () => {
    expect(transport._params.serializer).toBeInstanceOf(RTVIClientSerializer);
  });

  test("test_raw_audio_carries_bare_pcm", async () => {
    // The audio write path sends the PCM as given: no WAV header on the wire.
    const pcm = new Uint8Array(256 * 4);
    for (let i = 0; i < pcm.length; i++) pcm[i] = i % 256;
    const output: Any = transport.output();
    const send = mock(async (_message: unknown) => true);
    output._session = { isClosing: false, isConnected: true, send };
    output._sampleRate = 16000;

    expect(
      await output.writeAudioFrame(
        new OutputAudioRawFrame({ audio: pcm, sampleRate: 16000, numChannels: 1 }),
      ),
    ).toBe(true);

    const sent = JSON.parse(send.mock.calls.at(-1)![0] as string);
    expect(sent.type).toEqual("raw-audio");
    expect(b64decode(sent.data.base64Audio)).toEqual(pcm);
    expect(sent.data.sampleRate).toEqual(16000);
    expect(sent.data.numChannels).toEqual(1);
  });

  test("test_send_client_ready_message", async () => {
    const send = mock(async (_message: unknown) => true);
    transport._session.send = send;
    await transport._sendClientReady();

    expect(send).toHaveBeenCalledTimes(1);
    const sent = JSON.parse(send.mock.calls.at(-1)![0] as string);
    expect(sent.label).toEqual(RTVI.MESSAGE_LABEL);
    expect(sent.type).toEqual("client-ready");
    expect(sent.data.version).toEqual(RTVI.PROTOCOL_VERSION);
    expect(sent.data.about).toHaveProperty("library");
  });

  test("test_is_bot_ready", () => {
    const botReady = JSON.stringify({
      label: RTVI.MESSAGE_LABEL,
      type: "bot-ready",
      id: "1",
      data: { version: "2.0.0" },
    });
    const notReady = JSON.stringify({ label: RTVI.MESSAGE_LABEL, type: "bot-llm-text" });
    const noLabel = JSON.stringify({ type: "bot-ready" });

    const isBotReady = (RTVIClientTransport as Any)._isBotReady;
    expect(isBotReady(botReady)).toBe(true);
    expect(isBotReady(notReady)).toBe(false);
    expect(isBotReady(noLabel)).toBe(false);
    expect(isBotReady("not json")).toBe(false);
  });

  test("test_bot_ready_flag_set_on_message", async () => {
    expect(transport.botReady).toBe(false);
    const msg = JSON.stringify({
      label: RTVI.MESSAGE_LABEL,
      type: "bot-ready",
      id: "1",
      data: { version: "2.0.0" },
    });
    await transport._onMessage(null, msg);
    expect(transport.botReady).toBe(true);
  });
});

/** A tiny RTVI server: on client-ready, reply bot-ready then a scripted turn. */
class _BotServer {
  port: number;
  #replies: string[];
  received: Record<string, unknown>[] = [];
  #server: WebsocketServer | null = null;

  constructor(port: number, replies: string[]) {
    this.port = port;
    this.#replies = replies;
  }

  async #handler(ws: WebsocketConnection): Promise<void> {
    for await (const raw of ws) {
      const text = typeof raw === "string" ? raw : new TextDecoder().decode(raw);
      this.received.push(JSON.parse(text));
      if (JSON.parse(text).type === "client-ready") {
        await ws.send(_rtvi("bot-ready", { version: RTVI.PROTOCOL_VERSION }));
        for (const reply of this.#replies) {
          await ws.send(reply);
        }
      }
    }
  }

  async enter(): Promise<this> {
    this.#server = await websocketServe({
      handler: (ws) => this.#handler(ws),
      host: "localhost",
      port: this.port,
    });
    return this;
  }

  async exit(): Promise<void> {
    await this.#server?.close();
  }

  get url(): string {
    return `ws://localhost:${this.port}`;
  }
}

describe("TestRTVIClientTransportIntegration", () => {
  // Run the transport in a pipeline against a real RTVI server.

  test("test_bot_messages_become_frames", async () => {
    const replies = [
      _rtvi("bot-llm-started"),
      _rtvi("bot-llm-text", { text: "Paris" }),
      _rtvi("bot-llm-stopped"),
      _rtvi("user-transcription", { text: "hello", user_id: "u", timestamp: "t", final: true }),
    ];
    const server = await new _BotServer(_freePort(), replies).enter();
    let down: Frame[];
    let transport: RTVIClientTransport;
    try {
      transport = new RTVIClientTransport(server.url);
      [down] = await runTest(transport.input(), {
        framesToSend: [new SleepFrame({ sleep: 0.5 })], // let connect/handshake/replies flow
        startTimeout: 5.0, // the input transport connects before the pipeline starts
      });
    } finally {
      await server.exit();
    }

    // The bot's server messages arrived as the expected pipeline frames, in order.
    const kinds = down
      .filter(
        (f) =>
          f instanceof LLMFullResponseStartFrame ||
          f instanceof LLMTextFrame ||
          f instanceof LLMFullResponseEndFrame ||
          f instanceof TranscriptionFrame,
      )
      .map((f) => f.constructor);
    expect(kinds).toEqual([
      LLMFullResponseStartFrame,
      LLMTextFrame,
      LLMFullResponseEndFrame,
      TranscriptionFrame,
    ]);
    const text = down.find((f) => f instanceof LLMTextFrame) as LLMTextFrame;
    expect(text.text).toEqual("Paris");

    // The transport completed the handshake (the server saw client-ready).
    expect(server.received.some((m) => m.type === "client-ready")).toBe(true);
    expect(transport.botReady).toBe(true);
  });
});
