// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// The browser side of the end-to-end test, bundled for headless Chromium: the
// unchanged Pipecat browser SDK (@pipecat-ai/client-js +
// @pipecat-ai/small-webrtc-transport) against the bot in bot.ts. The
// microphone is a WebAudio tone gated on and off, the camera an animated
// canvas. `window.runTest()` returns the measurements.

import { PipecatClient } from "@pipecat-ai/client-js";
import { SmallWebRTCTransport } from "@pipecat-ai/small-webrtc-transport";

const w = window as any;

// ---- synthetic mic/cam: a 1 kHz oscillator gated by a gain node, and an animated canvas
const ac = new AudioContext({ sampleRate: 48000 });
const osc = ac.createOscillator();
osc.frequency.value = 1000;
const gate = ac.createGain();
gate.gain.value = 0;
const dest = ac.createMediaStreamDestination();
osc.connect(gate).connect(dest);
osc.start();
const canvas = document.createElement("canvas");
canvas.width = 320;
canvas.height = 240;
const ctx2d = canvas.getContext("2d")!;
let fc = 0;
setInterval(() => {
  ctx2d.fillStyle = `hsl(${(fc++ * 7) % 360},80%,50%)`;
  ctx2d.fillRect(0, 0, 320, 240);
}, 33);
const camStream = canvas.captureStream(30);
navigator.mediaDevices.getUserMedia = async (c?: MediaStreamConstraints) => {
  const s = new MediaStream();
  if (c?.audio) s.addTrack(dest.stream.getAudioTracks()[0]!.clone());
  if (c?.video) s.addTrack(camStream.getVideoTracks()[0]!.clone());
  return s;
};

// ---- capture every RTCPeerConnection the SDK makes
const pcs: RTCPeerConnection[] = [];
const logs: string[] = [];
const log = (...a: unknown[]) => logs.push(`${performance.now() | 0} ${a.join(" ")}`);
const OrigPC = window.RTCPeerConnection;
w.RTCPeerConnection = class extends OrigPC {
  constructor(...args: ConstructorParameters<typeof RTCPeerConnection>) {
    super(...args);
    pcs.push(this);
    this.addEventListener("track", onRemoteTrack);
    this.addEventListener("connectionstatechange", () => log("pc", this.connectionState));
  }
};

let analyser: AnalyserNode | null = null;
const buf = new Float32Array(240);
function onRemoteTrack(ev: RTCTrackEvent): void {
  if (ev.track.kind !== "audio") return;
  const ms = new MediaStream([ev.track]);
  const el = new Audio();
  el.srcObject = ms;
  el.muted = true;
  el.play().catch(() => {});
  const src = ac.createMediaStreamSource(ms);
  analyser = ac.createAnalyser();
  analyser.fftSize = 256;
  src.connect(analyser);
  log("remote audio track attached");
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function rms(): number {
  if (!analyser) return 0;
  analyser.getFloatTimeDomainData(buf);
  let s = 0;
  for (const v of buf) s += v * v;
  return Math.sqrt(s / buf.length);
}

/** Tone bursts into the mic; the time until each is heard back from the bot (ms, or null). */
async function burst(n: number): Promise<(number | null)[]> {
  const res: (number | null)[] = [];
  for (let i = 0; i < n; i++) {
    const q0 = performance.now();
    while (rms() > 0.02 && performance.now() - q0 < 2000) await sleep(2);
    await sleep(300);
    const emit = performance.now();
    gate.gain.setValueAtTime(0.5, ac.currentTime);
    gate.gain.setValueAtTime(0, ac.currentTime + 0.15);
    let got: number | null = null;
    while (performance.now() - emit < 2000) {
      if (rms() > 0.05) {
        got = Math.round(performance.now() - emit);
        break;
      }
      await sleep(1);
    }
    res.push(got);
    await sleep(400);
  }
  return res;
}

async function inboundAudio(
  pc: RTCPeerConnection,
): Promise<{ packets: number; lost: number } | null> {
  let found: { packets: number; lost: number } | null = null;
  (await pc.getStats()).forEach((r: any) => {
    if (r.type === "inbound-rtp" && r.kind === "audio")
      found = { packets: r.packetsReceived, lost: r.packetsLost };
  });
  return found;
}

w.runTest = async () => {
  await ac.resume();
  const waiters = new Map<string, (m: any) => void>();
  const wait = (key: string, ms = 3000) =>
    new Promise<any>((resolve) => {
      waiters.set(key, resolve);
      setTimeout(() => resolve(null), ms);
    });
  let botReady: unknown = null;
  const transport = new SmallWebRTCTransport({
    webrtcRequestParams: { endpoint: "/api/offer" },
  } as any);
  const client = new PipecatClient({
    transport,
    enableMic: true,
    enableCam: true,
    callbacks: {
      onServerMessage: (m: any) => {
        const key = m?.kind === "echo" ? `echo:${m.n}` : m?.kind;
        waiters.get(key)?.(m);
      },
      onBotReady: (d: unknown) => {
        botReady = d;
        log("bot-ready");
      },
      onError: (e: any) => log("error", JSON.stringify(e?.data ?? e)),
    },
  });
  const out: Record<string, unknown> = { logs };
  const t0 = performance.now();
  await client.connect();
  out.connectToReadyMs = Math.round(performance.now() - t0);
  out.botReady = botReady;

  // Data channel RTVI round trips.
  const rtts: (number | null)[] = [];
  for (let n = 0; n < 20; n++) {
    const sent = performance.now();
    const p = wait(`echo:${n}`);
    client.sendClientMessage("echo", { n });
    rtts.push((await p) ? Math.round(performance.now() - sent) : null);
  }
  out.dcRttMs = rtts;

  // A message larger than an SCTP chunk.
  const big = wait("big");
  client.sendClientMessage("big", { size: 64 * 1024 });
  out.bigMessageLength = ((await big)?.payload ?? "").length;

  // Audio both ways: bursts into the mic, played back by the bot.
  out.mediaRttMs = await burst(5);

  // Renegotiation requested by the bot over the data channel.
  client.sendClientMessage("please-renegotiate", {});
  await sleep(3500);
  out.afterRenegotiateRttMs = await burst(3);

  // restart_pc: the SDK replaces its peer connection, the bot its own.
  {
    analyser = null;
    await (transport as any).attemptReconnection(true);
    const w0 = performance.now();
    while (!analyser && performance.now() - w0 < 8000) await sleep(50);
    // The SDK stops the old local track when it tears the old pc down; feed a fresh one.
    const sender = pcs[pcs.length - 1]!.getTransceivers()[0]!.sender;
    if (!sender.track || sender.track.readyState === "ended") {
      await sender.replaceTrack(dest.stream.getAudioTracks()[0]!.clone());
    }
    await sleep(1000);
    out.afterRestartPcRttMs = await burst(3);
  }

  out.inboundBeforeIceRestart = await inboundAudio(pcs[pcs.length - 1]!);

  // ICE restart: same pc, new ufrag/pwd, through the renegotiation path (pc_id, restart_pc false).
  {
    const pc = pcs[pcs.length - 1]!;
    const ufragOf = (sdp: string) => /a=ice-ufrag:(\S+)/.exec(sdp)?.[1];
    try {
      const oldRemote = ufragOf(pc.remoteDescription!.sdp);
      pc.restartIce();
      const offer = await pc.createOffer({ iceRestart: true });
      await pc.setLocalDescription(offer);
      const r = await fetch("/api/offer", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sdp: pc.localDescription!.sdp,
          type: "offer",
          pc_id: (transport as any).pc_id,
          restart_pc: false,
        }),
      });
      if (!r.ok) throw new Error(`offer http ${r.status} ${await r.text()}`);
      const ans = await r.json();
      await pc.setRemoteDescription({ type: "answer", sdp: ans.sdp });
      const states: string[] = [];
      const w0 = performance.now();
      while (performance.now() - w0 < 3000) {
        states.push(pc.iceConnectionState);
        await sleep(250);
      }
      out.iceRestart = {
        oldRemoteUfrag: oldRemote,
        newRemoteUfrag: ufragOf(ans.sdp),
        iceStates: [...new Set(states)],
      };
      out.afterIceRestartRttMs = await burst(3);
    } catch (e) {
      out.iceRestart = { error: String((e as Error)?.message ?? e) };
    }
  }

  // getStats on the bot.
  const stats = wait("stats");
  client.sendClientMessage("stats", {});
  out.botStats = (await stats)?.types ?? null;

  // Browser-side stats.
  const pc = pcs[pcs.length - 1]!;
  const summary: Record<string, unknown> = {};
  (await pc.getStats()).forEach((r: any) => {
    if ((r.type === "inbound-rtp" || r.type === "outbound-rtp") && r.kind === "audio") {
      summary[r.type] = {
        packets: r.packetsReceived ?? r.packetsSent,
        lost: r.packetsLost,
        jitter: r.jitter,
      };
    }
  });
  out.browserAudioStats = summary;
  out.pcCount = pcs.length;
  await client.disconnect();
  return out;
};
w.__ready = true;
