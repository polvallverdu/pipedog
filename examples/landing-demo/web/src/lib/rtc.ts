// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// The WebRTC side of a session. Audio goes over WebRTC to Cloudflare Realtime; the session's
// Durable Object does the signaling (it holds the Realtime app secret) and runs the bot. RTVI
// messages go over a WebSocket to the Durable Object, the "messages" socket. The same flow as
// examples/workers-realtime-voice-agent, with the demo's ticket and call token.
//
// Pipecat's client SDKs have no Cloudflare Realtime transport yet, so this speaks RTVI itself:
// the same JSON messages the WebSocket transport carries, so the page handles both alike.

export interface RtviMessage {
  label?: string;
  type: string;
  id?: string;
  data?: any;
}

export interface RtcStats {
  /** Round trip to the SFU, from the selected ICE candidate pair, in ms. */
  rttMs: number | null;
  /** Jitter of the bot's audio, in ms. */
  jitterMs: number | null;
}

function gathered(pc: RTCPeerConnection): Promise<void> {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      if (pc.iceGatheringState === "complete") resolve();
    };
    pc.addEventListener("icegatheringstatechange", done);
    setTimeout(resolve, 2000);
  });
}

function connected(pc: RTCPeerConnection): Promise<void> {
  if (pc.connectionState === "connected") return Promise.resolve();
  return new Promise((resolve, reject) => {
    pc.addEventListener("connectionstatechange", () => {
      if (pc.connectionState === "connected") resolve();
      if (pc.connectionState === "failed") reject(new Error("The WebRTC connection failed."));
    });
    setTimeout(() => reject(new Error("The WebRTC connection timed out.")), 15_000);
  });
}

/** A level meter (0 to 1) on a media stream. */
export function levelMeter(stream: MediaStream, context: AudioContext): () => number {
  const analyser = context.createAnalyser();
  analyser.fftSize = 512;
  context.createMediaStreamSource(stream).connect(analyser);
  const data = new Uint8Array(analyser.fftSize);
  return () => {
    analyser.getByteTimeDomainData(data);
    let peak = 0;
    for (const v of data) peak = Math.max(peak, Math.abs(v - 128) / 128);
    return Math.min(1, peak * 1.6);
  };
}

export class RtcCall {
  readonly #base: string;
  readonly #onMessage: (message: RtviMessage) => void;
  readonly #onClose: () => void;
  #pc: RTCPeerConnection | null = null;
  #ws: WebSocket | null = null;
  #token = "";
  #mic: MediaStream | null = null;
  #audio: HTMLAudioElement | null = null;
  #context: AudioContext | null = null;
  #pending = new Map<string, (m: RtviMessage) => void>();
  #closed = false;
  userLevel: () => number = () => 0;
  botLevel: () => number = () => 0;

  constructor(rtcUrl: string, onMessage: (m: RtviMessage) => void, onClose: () => void) {
    this.#base = rtcUrl;
    this.#onMessage = onMessage;
    this.#onClose = onClose;
  }

  async #post(action: string, body: unknown, query = ""): Promise<any> {
    const response = await fetch(`${this.#base}/${action}${query}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-demo-call-token": this.#token },
      body: JSON.stringify(body),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.message ?? data.error ?? `${action} failed`);
    return data;
  }

  /** Publish the mic, open the messages socket, subscribe to the bot's track, say client-ready. */
  async start(ticket: string): Promise<void> {
    this.#mic = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    this.#context = new AudioContext();
    this.userLevel = levelMeter(this.#mic, this.#context);
    const pc = new RTCPeerConnection({
      iceServers: [{ urls: "stun:stun.cloudflare.com:3478" }],
      bundlePolicy: "max-bundle",
    });
    this.#pc = pc;
    this.#audio = new Audio();
    this.#audio.autoplay = true;
    pc.addEventListener("track", (event) => {
      const stream = new MediaStream([event.track]);
      this.#audio!.srcObject = stream;
      if (this.#context) this.botLevel = levelMeter(stream, this.#context);
    });
    pc.addEventListener("connectionstatechange", () => {
      if (pc.connectionState === "failed" || pc.connectionState === "closed") void this.close();
    });

    // 1. Publish the microphone. The ticket claims the session.
    const transceiver = pc.addTransceiver(this.#mic.getAudioTracks()[0]!, {
      direction: "sendonly",
    });
    await pc.setLocalDescription(await pc.createOffer());
    await gathered(pc);
    const published = await this.#post(
      "offer",
      { sessionDescription: pc.localDescription, mid: transceiver.mid },
      `?ticket=${encodeURIComponent(ticket)}`,
    );
    this.#token = published.callToken;
    await pc.setRemoteDescription(published.sessionDescription);
    await connected(pc);

    // 2. The messages socket, for RTVI.
    const wsUrl = `${this.#base.replace(/^http/, "ws")}/messages?token=${encodeURIComponent(this.#token)}`;
    const ws = new WebSocket(wsUrl);
    this.#ws = ws;
    ws.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as RtviMessage;
      if (message.label !== "rtvi-ai") return;
      const waiter = message.id ? this.#pending.get(message.id) : undefined;
      if (waiter && (message.type === "server-response" || message.type === "error-response")) {
        this.#pending.delete(message.id!);
        waiter(message);
      }
      this.#onMessage(message);
    });
    ws.addEventListener("close", () => void this.close());
    await new Promise((resolve, reject) => {
      ws.addEventListener("open", resolve, { once: true });
      ws.addEventListener("error", () => reject(new Error("The messages socket failed.")), {
        once: true,
      });
    });

    // 3. The SFU attaches the bot; subscribe to its track.
    const subscription = await this.#post("connect", {});
    await pc.setRemoteDescription(subscription.sessionDescription);
    await pc.setLocalDescription(await pc.createAnswer());
    await gathered(pc);
    await this.#post("answer", { sessionDescription: pc.localDescription });

    // 4. Tell the bot we can hear it: it greets us then.
    this.send({
      label: "rtvi-ai",
      type: "client-ready",
      id: crypto.randomUUID(),
      data: { version: "1.0.0", about: { library: "pipedog-landing-demo (WebRTC)" } },
    });
  }

  send(message: RtviMessage): void {
    if (this.#ws?.readyState === WebSocket.OPEN) this.#ws.send(JSON.stringify(message));
  }

  /** An RTVI client message, resolved with its server response. */
  request(type: string, data: unknown = {}, timeoutMs = 3000): Promise<RtviMessage> {
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error("timeout"));
      }, timeoutMs);
      this.#pending.set(id, (m) => {
        clearTimeout(timer);
        resolve(m);
      });
      this.send({ label: "rtvi-ai", type: "client-message", id, data: { t: type, d: data } });
    });
  }

  /** WebRTC's own view of the connection. */
  async stats(): Promise<RtcStats> {
    const result: RtcStats = { rttMs: null, jitterMs: null };
    if (!this.#pc) return result;
    const report = await this.#pc.getStats();
    report.forEach((s: any) => {
      if (s.type === "candidate-pair" && s.nominated && s.currentRoundTripTime != null) {
        result.rttMs = s.currentRoundTripTime * 1000;
      }
      if (s.type === "inbound-rtp" && s.kind === "audio" && s.jitter != null) {
        result.jitterMs = s.jitter * 1000;
      }
    });
    return result;
  }

  /** Hang up: tell the bot, close the sockets, release the mic. */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#token) {
      void fetch(`${this.#base}/hangup`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-demo-call-token": this.#token },
        body: "{}",
        keepalive: true,
      }).catch(() => {});
    }
    for (const track of this.#mic?.getTracks() ?? []) track.stop();
    this.#pc?.close();
    this.#ws?.close();
    if (this.#audio) this.#audio.srcObject = null;
    void this.#context?.close();
    this.#onClose();
  }
}
