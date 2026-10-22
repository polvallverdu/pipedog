// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// A fake Cloudflare Realtime SFU for the end-to-end test: the HTTPS API the Durable Object calls,
// and the WebSocket adapters it creates. Like the real SFU, creating an adapter dials its
// endpoint before answering. The "remote" adapter (the user's microphone) streams a recording
// as 48 kHz stereo PCM packets in real time once `speak()` is called; the "local" adapter (the
// bot's track) collects what the bot sends.
//
// No WebRTC happens here: the SDP is opaque text, and the browser is played by the test.

import { decodePacket, encodePacket } from "@pipedog/transport-cloudflare-realtime/packet";

export interface FakeSfu {
  /** The API base URL, for CLOUDFLARE_REALTIME_API_URL. */
  baseUrl: string;
  /** Each API request: method, path (under the app) and JSON body. */
  requests: { method: string; path: string; body: any; auth: string | null }[];
  /** Bytes of bot PCM the output adapter received. */
  botBytes(): number;
  /** Bytes of bot PCM that weren't silence. */
  botSpeechBytes(): number;
  /** Stream `pcm` (48 kHz stereo) into the input adapter, in real time. */
  speak(pcm: Uint8Array): Promise<void>;
  /** Whether an adapter's socket is open. */
  open(location: "local" | "remote"): boolean;
  stop(): void;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A 16-bit mono WAV as 48 kHz stereo PCM (linear interpolation), with trailing silence. */
export function wavTo48kStereo(wav: Uint8Array, tailSecs = 1.5): Uint8Array {
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  const text = (offset: number) => String.fromCharCode(...wav.subarray(offset, offset + 4));
  if (text(0) !== "RIFF" || text(8) !== "WAVE") throw new Error("not a WAV file");
  let rate = 0;
  let offset = 12;
  while (offset + 8 <= wav.length) {
    const id = text(offset);
    const size = view.getUint32(offset + 4, true);
    if (id === "fmt ") rate = view.getUint32(offset + 12, true);
    if (id === "data") {
      const count = Math.floor(size / 2);
      const length = Math.floor((count * 48000) / rate);
      const out = new Int16Array((length + Math.floor(tailSecs * 48000)) * 2);
      for (let i = 0; i < length; i++) {
        const at = (i * rate) / 48000;
        const index = Math.floor(at);
        const a = view.getInt16(offset + 8 + index * 2, true);
        const b = index + 1 < count ? view.getInt16(offset + 8 + (index + 1) * 2, true) : a;
        const s = Math.round(a + (b - a) * (at - index));
        out[2 * i] = s;
        out[2 * i + 1] = s;
      }
      return new Uint8Array(out.buffer);
    }
    offset += 8 + size + (size % 2);
  }
  throw new Error("WAV file has no data chunk");
}

export function startFakeSfu(): FakeSfu {
  const requests: FakeSfu["requests"] = [];
  const adapters = new Map<string, { location: "local" | "remote"; ws: WebSocket }>();
  let botBytes = 0;
  let botSpeechBytes = 0;
  let sessions = 0;
  let adapterCount = 0;

  async function dial(endpoint: string): Promise<WebSocket> {
    const ws = new WebSocket(endpoint);
    ws.binaryType = "arraybuffer";
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve(), { once: true });
      ws.addEventListener("error", () => reject(new Error(`handshake with ${endpoint} failed`)), {
        once: true,
      });
    });
    return ws;
  }

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const path = url.pathname.replace(/^\/v1\/apps\/[^/]+/, "");
      const body = request.method === "GET" ? null : await request.json().catch(() => null);
      requests.push({
        method: request.method,
        path,
        body,
        auth: request.headers.get("authorization"),
      });

      if (path === "/sessions/new") {
        sessions++;
        return Response.json({ sessionId: `session-${sessions}` }, { status: 201 });
      }
      if (/^\/sessions\/[^/]+\/tracks\/new$/.test(path)) {
        if (body.sessionDescription) {
          return Response.json({
            sessionDescription: { type: "answer", sdp: "fake answer" },
            tracks: body.tracks.map((t: any) => ({ ...t })),
          });
        }
        return Response.json({
          requiresImmediateRenegotiation: true,
          sessionDescription: { type: "offer", sdp: "fake offer" },
          tracks: body.tracks.map((t: any, i: number) => ({ ...t, mid: String(i + 1) })),
        });
      }
      if (/^\/sessions\/[^/]+\/renegotiate$/.test(path)) return Response.json({});
      if (/^\/sessions\/[^/]+\/tracks\/close$/.test(path)) {
        return Response.json({ tracks: body.tracks });
      }
      if (path === "/adapters/websocket/new") {
        const results = [];
        for (const track of body.tracks) {
          try {
            const ws = await dial(track.endpoint);
            const adapterId = `adapter-${++adapterCount}`;
            adapters.set(adapterId, { location: track.location, ws });
            if (track.location === "local") {
              ws.addEventListener("message", (event) => {
                const payload = decodePacket(new Uint8Array(event.data as ArrayBuffer)).payload;
                botBytes += payload.length;
                const samples = new Int16Array(payload.slice().buffer);
                if (samples.some((s) => Math.abs(s) > 100)) botSpeechBytes += payload.length;
              });
              results.push({
                trackName: track.trackName,
                adapterId,
                sessionId: `bot-session-${adapterCount}`,
                endpoint: track.endpoint,
              });
            } else {
              results.push({ trackName: track.trackName, adapterId, endpoint: track.endpoint });
            }
          } catch (e) {
            results.push({
              trackName: track.trackName,
              errorCode: "websocket_handshake_failed",
              errorDescription: String(e),
            });
          }
        }
        const ok = results.some((r) => "adapterId" in r);
        return Response.json({ tracks: results }, { status: ok ? 200 : 503 });
      }
      if (path === "/adapters/websocket/close") {
        for (const { adapterId } of body.tracks) {
          adapters.get(adapterId)?.ws.close(1000, "adapter closed");
          adapters.delete(adapterId);
        }
        return Response.json({ tracks: body.tracks });
      }
      return Response.json({ errorCode: "not_found" }, { status: 404 });
    },
  });

  return {
    baseUrl: `http://127.0.0.1:${server.port}/v1`,
    requests,
    botBytes: () => botBytes,
    botSpeechBytes: () => botSpeechBytes,
    open: (location) =>
      [...adapters.values()].some((a) => a.location === location && a.ws.readyState === 1),
    async speak(pcm) {
      const input = [...adapters.values()].find((a) => a.location === "remote");
      if (!input) throw new Error("no input adapter");
      const chunk = 48000 * 4 * 0.02; // 20 ms
      const started = performance.now();
      for (let i = 0, seq = 0; i < pcm.length; i += chunk, seq++) {
        const payload = pcm.subarray(i, Math.min(pcm.length, i + chunk));
        input.ws.send(encodePacket({ sequenceNumber: seq, timestamp: seq * 960, payload }));
        const due = started + (seq + 1) * 20;
        await sleep(Math.max(0, due - performance.now()));
      }
    },
    stop() {
      for (const { ws } of adapters.values()) ws.close();
      server.stop(true);
    },
  };
}
