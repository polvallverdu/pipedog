// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// The pacing benchmark's stand-in for Telnyx: connects to the bot, records when each "media"
// message arrives and how much audio it carries, and prints them as JSON when the bot hangs up.
// A process of its own, so its timing doesn't depend on the bot's event loop.
//
//   bun tools/bench/pacing/client.ts ws://127.0.0.1:8765

const url = process.argv[2]!;
const arrivals: Array<{ t: number; samples: number }> = [];

/** Connect, retrying while the bot's server comes up (it says it's ready a little early). */
function connect(attempt = 0): void {
  const ws = new WebSocket(url);
  let opened = false;
  ws.onopen = () => {
    opened = true;
    // What Telnyx sends first: the stream has started.
    ws.send(JSON.stringify({ event: "connected", version: "1.0.0" }));
    ws.send(
      JSON.stringify({
        event: "start",
        stream_id: "pacing-stream",
        start: { media_format: { encoding: "PCMU", sample_rate: 8000, channels: 1 } },
      }),
    );
  };
  ws.onmessage = (event) => {
    const t = performance.now();
    const msg = JSON.parse(String(event.data));
    if (msg.event !== "media") return;
    // base64 of 8 kHz mu-law: one byte per sample.
    const b64: string = msg.media.payload;
    const samples = (b64.length * 3) / 4 - (b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0);
    arrivals.push({ t, samples });
  };
  ws.onclose = () => {
    if (!opened && attempt < 100) {
      setTimeout(() => connect(attempt + 1), 100);
      return;
    }
    console.log(`__PACING_ARRIVALS__${JSON.stringify(arrivals)}`);
    process.exit(0);
  };
  ws.onerror = () => {
    if (!opened) return; // onclose follows and retries
    console.error("websocket error");
    process.exit(1);
  };
}

connect();
