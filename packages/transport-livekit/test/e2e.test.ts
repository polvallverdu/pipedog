// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// End to end against a real LiveKit server: a bot (e2e/bot.ts) running
// LiveKitTransport on Bun, Node and Deno joins a room, and this test joins it
// as the user with @livekit/rtc-node. Checks the room join, participant
// events, RTVI over data messages (client-ready -> bot-ready, an echoed
// client message), and audio both ways (a tone from the user is played back
// by the bot).
//
// The server is a `livekit/livekit-server` container started here with Docker,
// or the one at PIPEDOG_LIVEKIT_URL (with PIPEDOG_LIVEKIT_API_KEY and
// PIPEDOG_LIVEKIT_API_SECRET). Skipped when neither is available, when
// @livekit/rtc-node can't load on this platform, or with PIPEDOG_E2E=0.
// Runtimes that aren't installed are skipped.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type * as Rtc from "@livekit/rtc-node";
import { AccessToken } from "livekit-server-sdk";

const HERE = import.meta.dir;
const IMAGE = "livekit/livekit-server:v1.13.7";
const API_KEY = "devkey";
const API_SECRET = "secretsecretsecretsecretsecretsecret";

interface Server {
  url: string;
  apiKey: string;
  apiSecret: string;
  stop: () => Promise<void>;
}

async function run(cmd: string[]): Promise<{ ok: boolean; out: string }> {
  try {
    const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
    const [out, err] = await Promise.all([
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
    ]);
    return { ok: (await p.exited) === 0, out: out + err };
  } catch {
    return { ok: false, out: "" };
  }
}

async function waitReady(httpUrl: string, seconds: number): Promise<boolean> {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(httpUrl);
      if (r.ok) return true;
    } catch {
      // not up yet
    }
    await Bun.sleep(250);
  }
  return false;
}

async function startServer(): Promise<Server | null> {
  if (process.env.PIPEDOG_E2E === "0") return null;
  const url = process.env.PIPEDOG_LIVEKIT_URL;
  if (url) {
    return {
      url,
      apiKey: process.env.PIPEDOG_LIVEKIT_API_KEY ?? API_KEY,
      apiSecret: process.env.PIPEDOG_LIVEKIT_API_SECRET ?? API_SECRET,
      stop: async () => {},
    };
  }
  if (!Bun.which("docker") || !(await run(["docker", "info"])).ok) return null;

  // The container's ports are mapped to the same host ports, so the
  // addresses the server advertises (127.0.0.1:<port>) work from the host.
  const port = 20000 + Math.floor(Math.random() * 20000);
  const config = [
    `port: ${port}`,
    "rtc:",
    `  tcp_port: ${port + 1}`,
    `  udp_port: ${port + 2}`,
    "  use_external_ip: false",
    "  node_ip: 127.0.0.1",
    "keys:",
    `  ${API_KEY}: ${API_SECRET}`,
    "logging:",
    "  level: warn",
  ].join("\n");
  const name = `pipedog-livekit-e2e-${port}`;
  const started = await run([
    "docker",
    "run",
    "-d",
    "--rm",
    "--name",
    name,
    "-p",
    `${port}:${port}`,
    "-p",
    `${port + 1}:${port + 1}`,
    "-p",
    `${port + 2}:${port + 2}/udp`,
    "-e",
    `LIVEKIT_CONFIG=${config}`,
    IMAGE,
  ]);
  if (!started.ok) {
    console.log(`e2e: skipping: could not start ${IMAGE}: ${started.out.trim()}`);
    return null;
  }
  const stop = async () => {
    await run(["docker", "rm", "-f", name]);
  };
  if (!(await waitReady(`http://127.0.0.1:${port}/`, 60))) {
    await stop();
    throw new Error(`${IMAGE} did not become ready`);
  }
  return { url: `ws://127.0.0.1:${port}`, apiKey: API_KEY, apiSecret: API_SECRET, stop };
}

let rtc: typeof Rtc | null = null;
try {
  rtc = await import("@livekit/rtc-node");
} catch (e) {
  console.log(`e2e: skipping: @livekit/rtc-node does not load here (${e})`);
}

let server: Server | null = null;
beforeAll(async () => {
  if (rtc) server = await startServer();
  if (rtc && !server) {
    console.log(
      "e2e: skipping: no LiveKit server (Docker unavailable and PIPEDOG_LIVEKIT_URL unset)",
    );
  }
}, 180_000);

afterAll(async () => {
  await server?.stop();
});

async function token(s: Server, room: string, identity: string): Promise<string> {
  const at = new AccessToken(s.apiKey, s.apiSecret, { identity });
  at.addGrant({ roomJoin: true, room, canPublish: true, canSubscribe: true });
  return await at.toJwt();
}

const RUNTIMES: { name: string; cmd: string[] | null }[] = [
  { name: "bun", cmd: [process.execPath] },
  { name: "node", cmd: Bun.which("node") ? [Bun.which("node")!] : null },
  { name: "deno", cmd: Bun.which("deno") ? [Bun.which("deno")!, "run", "-A"] : null },
];

interface Bot {
  proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
  output: string[];
  connected: Promise<void>;
}

function startBot(cmd: string[], env: Record<string, string>): Bot {
  const proc = Bun.spawn([...cmd, join(HERE, "e2e", "bot.ts")], {
    cwd: join(HERE, ".."),
    env: { ...process.env, ...env, PIPECAT_LOG_LEVEL: process.env.PIPECAT_LOG_LEVEL ?? "WARNING" },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const output: string[] = [];
  const decoder = new TextDecoder();
  let resolveConnected!: () => void;
  const connected = new Promise<void>((r) => {
    resolveConnected = r;
  });
  const drain = async (stream: ReadableStream<Uint8Array>) => {
    const reader = stream.getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      for (const line of decoder.decode(value).split("\n")) {
        output.push(line);
        if (line.includes("CONNECTED")) resolveConnected();
      }
    }
  };
  void drain(proc.stdout);
  void drain(proc.stderr);
  return { proc, output, connected };
}

async function until(cond: () => boolean, seconds: number): Promise<boolean> {
  const deadline = Date.now() + seconds * 1000;
  while (!cond() && Date.now() < deadline) await Bun.sleep(50);
  return cond();
}

describe("LiveKit end to end against livekit-server", () => {
  for (const runtime of RUNTIMES) {
    test(`user <-> bot on ${runtime.name}`, async () => {
      if (!rtc || !server || !runtime.cmd) {
        if (rtc && server) console.log(`e2e: ${runtime.name} not installed, skipped`);
        return;
      }
      const lk = rtc;
      const room = `e2e-${runtime.name}-${Date.now()}`;
      const bot = startBot(runtime.cmd, {
        LIVEKIT_URL: server.url,
        LIVEKIT_TOKEN: await token(server, room, "pipedog-bot"),
        LIVEKIT_ROOM: room,
      });

      const user = new lk.Room();
      const messages: Record<string, unknown>[] = [];
      let loudFrames = 0;
      let botAudioTrack = false;
      try {
        const ready = await Promise.race([
          bot.connected.then(() => true),
          Bun.sleep(45_000).then(() => false),
        ]);
        expect(ready, bot.output.join("\n")).toBe(true);

        user.on("dataReceived", (payload) => {
          messages.push(JSON.parse(new TextDecoder().decode(payload)));
        });
        user.on("trackSubscribed", (track) => {
          if (track.kind !== lk.TrackKind.KIND_AUDIO) return;
          botAudioTrack = true;
          void (async () => {
            const stream = new lk.AudioStream(track, { sampleRate: 16000, numChannels: 1 });
            for await (const frame of stream) {
              let sum = 0;
              for (const s of frame.data) sum += s * s;
              if (Math.sqrt(sum / Math.max(1, frame.data.length)) > 1500) loudFrames++;
              if (loudFrames > 20) break;
            }
          })();
        });
        await user.connect(server.url, await token(server, room, "e2e-user"), {
          autoSubscribe: true,
          dynacast: false,
        });

        const send = (msg: Record<string, unknown>) =>
          user.localParticipant!.publishData(new TextEncoder().encode(JSON.stringify(msg)), {
            reliable: true,
          });
        await send({
          label: "rtvi-ai",
          type: "client-ready",
          id: "1",
          data: { version: "1.0.0", about: { library: "e2e" } },
        });
        expect(await until(() => messages.some((m) => m.type === "bot-ready"), 15)).toBe(true);
        await send({
          label: "rtvi-ai",
          type: "client-message",
          id: "2",
          data: { t: "echo", d: { n: 7 } },
        });
        expect(
          await until(
            () =>
              messages.some(
                (m) =>
                  m.type === "server-message" && (m.data as { kind?: string; n?: number })?.n === 7,
              ),
            15,
          ),
        ).toBe(true);

        // A 440 Hz tone into the room; the bot plays it back.
        const source = new lk.AudioSource(48000, 1, 1000);
        const track = lk.LocalAudioTrack.createAudioTrack("mic", source);
        await user.localParticipant!.publishTrack(
          track,
          new lk.TrackPublishOptions({ source: lk.TrackSource.SOURCE_MICROPHONE }),
        );
        let n = 0;
        const deadline = Date.now() + 20_000;
        while (loudFrames <= 20 && Date.now() < deadline) {
          const data = new Int16Array(480);
          for (let i = 0; i < data.length; i++, n++) {
            data[i] = Math.round(8000 * Math.sin((2 * Math.PI * 440 * n) / 48000));
          }
          await source.captureFrame(new lk.AudioFrame(data, 48000, 1, 480));
        }
        expect(botAudioTrack).toBe(true);
        expect(loudFrames).toBeGreaterThan(20);
        await source.close();
      } finally {
        await user.disconnect();
      }

      // The bot leaves when the user does, and reports what it saw.
      const exited = await Promise.race([bot.proc.exited, Bun.sleep(20_000).then(() => null)]);
      if (exited === null) bot.proc.kill();
      const line = bot.output.find((l) => l.startsWith("SUMMARY "));
      expect(line, bot.output.join("\n")).toBeDefined();
      const summary = JSON.parse(line!.slice("SUMMARY ".length));
      console.log(`e2e ${runtime.name}: ${JSON.stringify(summary)}`);
      expect(summary.connected).toBe(1);
      expect(summary.participants).toEqual(["e2e-user"]);
      expect(summary.clientReady).toBe(1);
      expect(summary.echoes).toBe(1);
      expect(summary.userIds).toEqual(["e2e-user"]);
      expect(summary.loudFrames).toBeGreaterThan(20);
    }, 120_000);
  }
});
