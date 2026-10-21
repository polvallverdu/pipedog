// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// A scripted stand-in for Twilio's side of a Media Streams call, for the tests.
// It speaks the protocol as Twilio does: `connected`, then `start` with the
// stream and call SIDs and the TwiML parameters, then the caller's audio as
// 20 ms μ-law `media` events in real time, and `stop` when the caller hangs up.
// It records what the bot sends back.

/** What the fake client needs from a socket: a standard WebSocket's surface. */
export interface ClientSocket {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: string, listener: (event: any) => void): void;
}

export interface CallOptions {
  streamSid: string;
  callSid: string;
  accountSid: string;
  from: string;
  to: string;
  /** The caller's question: 8 kHz 16-bit mono PCM, silence included. */
  question: Int16Array;
  /**
   * How the call ends after the answer: the caller hangs up (`stop`, then the
   * socket closes), or presses `#` and waits for the bot to end the call.
   */
  hangUp?: "caller" | "pound";
}

/** A message the bot sent, with when it arrived (ms since the call started). */
export interface Received {
  at: number;
  message: any;
}

export interface CallResult {
  /** Every message the bot sent. */
  received: Received[];
  /** μ-law bytes of bot audio before the caller asked the question. */
  greetingBytes: number;
  /** μ-law bytes of bot audio after the question started. */
  answerBytes: number;
}

const FRAME_MS = 20;
const FRAME_SAMPLES = 160; // 20 ms at 8 kHz

/** G.711 μ-law encoding of one 16-bit sample. */
function linearToUlaw(sample: number): number {
  const BIAS = 0x84;
  const CLIP = 32635;
  const sign = sample < 0 ? 0x80 : 0;
  let s = Math.min(Math.abs(sample), CLIP) + BIAS;
  let exponent = 7;
  for (let mask = 0x4000; (s & mask) === 0 && exponent > 0; mask >>= 1) exponent--;
  const mantissa = (s >> (exponent + 3)) & 0x0f;
  s = ~(sign | (exponent << 4) | mantissa);
  return s & 0xff;
}

function encodeUlaw(pcm: Int16Array): Uint8Array {
  const out = new Uint8Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) out[i] = linearToUlaw(pcm[i] as number);
  return out;
}

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The PCM samples of a 16-bit mono WAV file at 8 kHz, as a phone line carries
 * them, with `tailSecs` of silence appended so the bot's turn detection ends
 * the caller's turn.
 */
export function wavToPcm8k(wav: Uint8Array, tailSecs = 1.5): Int16Array {
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
      const length = Math.floor((count * 8000) / rate);
      const out = new Int16Array(length + Math.floor(tailSecs * 8000));
      // Linear interpolation: plenty for a scripted caller.
      for (let i = 0; i < length; i++) {
        const at = (i * rate) / 8000;
        const index = Math.floor(at);
        const a = index < count ? view.getInt16(offset + 8 + index * 2, true) : 0;
        const b = index + 1 < count ? view.getInt16(offset + 8 + (index + 1) * 2, true) : a;
        out[i] = Math.round(a + (b - a) * (at - index));
      }
      return out;
    }
    offset += 8 + size + (size % 2);
  }
  throw new Error("WAV file has no data chunk");
}

/** Resolve once `cond()` holds, polling; reject after `timeoutMs`. */
async function until(cond: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(25);
  }
}

/**
 * Place one call over `socket` (already open): wait for the bot's greeting,
 * ask the question, wait for the answer, then end the call (`hangUp`).
 */
export async function placeCall(socket: ClientSocket, options: CallOptions): Promise<CallResult> {
  const started = Date.now();
  const received: Received[] = [];
  let closed = false;
  let questionAt = Number.POSITIVE_INFINITY;
  let greetingBytes = 0;
  let answerBytes = 0;
  let lastMediaAt = 0;

  socket.addEventListener("message", (event: { data: unknown }) => {
    const message = JSON.parse(String(event.data));
    const at = Date.now() - started;
    received.push({ at, message });
    if (message.event === "media") {
      const bytes = atob(message.media.payload).length;
      if (at < questionAt) greetingBytes += bytes;
      else answerBytes += bytes;
      lastMediaAt = Date.now();
    }
  });
  socket.addEventListener("close", () => {
    closed = true;
  });

  const send = (message: unknown) => socket.send(JSON.stringify(message));
  const { streamSid, callSid, accountSid } = options;
  let sequence = 1;

  send({ event: "connected", protocol: "Call", version: "1.0.0" });
  send({
    event: "start",
    sequenceNumber: String(sequence++),
    start: {
      accountSid,
      streamSid,
      callSid,
      tracks: ["inbound"],
      mediaFormat: { encoding: "audio/x-mulaw", sampleRate: 8000, channels: 1 },
      customParameters: { from_number: options.from, to_number: options.to },
    },
    streamSid,
  });

  // The greeting: wait for audio, then for it to finish.
  await until(() => greetingBytes > 0, 20_000, "the greeting");
  await until(() => Date.now() - lastMediaAt > 800, 20_000, "the greeting to end");

  // The question, in real time, as 20 ms media events.
  questionAt = Date.now() - started;
  const ulaw = encodeUlaw(options.question);
  for (let i = 0, chunk = 1; i < ulaw.length; i += FRAME_SAMPLES, chunk++) {
    if (closed) break;
    send({
      event: "media",
      sequenceNumber: String(sequence++),
      media: {
        track: "inbound",
        chunk: String(chunk),
        timestamp: String((chunk - 1) * FRAME_MS),
        payload: toBase64(ulaw.subarray(i, i + FRAME_SAMPLES)),
      },
      streamSid,
    });
    await sleep(FRAME_MS);
  }

  // The answer: wait for audio, then for it to finish.
  await until(() => answerBytes > 0, 20_000, "the answer");
  await until(() => Date.now() - lastMediaAt > 800, 20_000, "the answer to end");

  if (options.hangUp === "pound") {
    // Press # and let the bot end the call: it closes the stream.
    send({
      event: "dtmf",
      streamSid,
      sequenceNumber: String(sequence++),
      dtmf: { track: "inbound_track", digit: "#" },
    });
    await until(() => closed, 20_000, "the bot to end the call");
    return { received, greetingBytes, answerBytes };
  }

  // Hang up.
  send({
    event: "stop",
    sequenceNumber: String(sequence++),
    stop: { accountSid, callSid },
    streamSid,
  });
  socket.close(1000, "call ended");
  return { received, greetingBytes, answerBytes };
}
