// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_resembleai_tts.py

/**
 * Tests for ResembleAITTSService.
 *
 * Porting notes:
 * - `websockets.asyncio.server.serve` is a `Bun.serve` WebSocket server on a free local port.
 * - `asyncio.wait_for(..., timeout=2)` is `waitFor(..., 2)`.
 * - The pipeline test at the end is not in upstream: it drives the service through
 *   `runTest` against a fake that follows the documented message flow.
 */

import { expect, test } from "bun:test";
import { waitFor } from "@pipedog/asyncio";
import { TTSAudioRawFrame, TTSSpeakFrame, TTSStoppedFrame } from "@pipedog/core/frames/frames";
import { runTest, SleepFrame } from "@pipedog/core/tests/utils";
import { ResembleAITTSService } from "../src/tts.ts";

type Dict = Record<string, any>;

function b64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

interface Captured {
  authHeader: string | null;
  messages: Dict[];
}

async function withWsServer<T>(
  handlers: {
    open?: (ws: { send(data: string): void; close(): void }) => void;
    message?: (ws: { send(data: string): void; close(): void }, msg: Dict) => void;
  },
  fn: (url: string, captured: Captured) => Promise<T>,
): Promise<T> {
  const captured: Captured = { authHeader: null, messages: [] };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, srv) {
      captured.authHeader = request.headers.get("Authorization");
      if (srv.upgrade(request, { data: {} })) return undefined;
      return new Response("upgrade failed", { status: 400 });
    },
    websocket: {
      open(ws) {
        handlers.open?.(ws);
      },
      message(ws, raw) {
        const msg = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
        captured.messages.push(msg);
        handlers.message?.(ws, msg);
      },
    },
  });
  try {
    return await fn(`ws://127.0.0.1:${server.port}`, captured);
  } finally {
    server.stop(true);
  }
}

test("test_resembleai_receive_returns_when_server_closes", async () => {
  // A clean server close ends the receive loop so the base class can reconnect.
  await withWsServer(
    {
      open(ws) {
        ws.close();
      },
    },
    async (url) => {
      const service = new ResembleAITTSService({
        apiKey: "test-key",
        settings: new ResembleAITTSService.Settings({ voice: "test-voice" }),
        url,
      });
      await service._connectWebsocket();

      await waitFor(() => service._receiveMessages(), 2);

      await service._disconnectWebsocket();
    },
  );
});

test("test_resembleai_streams_jitter_buffered_audio_and_word_times", async () => {
  // Not in upstream. Audio is held until the 44100-byte jitter buffer fills, then sent in
  // 2208-byte frames; audio_end flushes the even-length remainder and closes the context.
  const audio = Uint8Array.from({ length: 50001 }, (_, i) => i & 0xff);

  await withWsServer(
    {
      message(ws, msg) {
        ws.send(
          JSON.stringify({
            type: "audio",
            request_id: msg.request_id,
            audio_content: b64(audio),
            audio_timestamps: {
              graph_chars: ["H", "i"],
              graph_times: [
                [0.0, 0.1],
                [0.1, 0.2],
              ],
            },
          }),
        );
        ws.send(JSON.stringify({ type: "audio_end", request_id: msg.request_id }));
      },
    },
    async (url, captured) => {
      const service = new ResembleAITTSService({
        apiKey: "test-key",
        url,
        projectUuid: "proj-1",
        settings: new ResembleAITTSService.Settings({ voice: "voice-1" }),
      });
      const [down] = await runTest(service, {
        framesToSend: [new TTSSpeakFrame({ text: "Hi" }), new SleepFrame({ sleep: 0.3 })],
      });

      expect(captured.authHeader).toBe("Bearer test-key");
      expect(captured.messages).toEqual([
        {
          voice_uuid: "voice-1",
          data: "Hi",
          binary_response: false,
          request_id: 0,
          output_format: "wav",
          sample_rate: 22050,
          precision: "PCM_16",
          no_audio_header: true,
          project_uuid: "proj-1",
        },
      ]);
      const frames = down.filter((f) => f instanceof TTSAudioRawFrame) as TTSAudioRawFrame[];
      const total = frames.reduce((n, f) => n + f.audio.length, 0);
      // 50001 bytes arrive; the odd trailing byte is dropped for PCM_16 alignment.
      expect(total).toBe(50000);
      expect(frames.every((f) => f.audio.length % 2 === 0)).toBe(true);
      expect(frames[0]!.audio.length).toBe(2208);
      expect(down.some((f) => f instanceof TTSStoppedFrame)).toBe(true);
    },
  );
});
