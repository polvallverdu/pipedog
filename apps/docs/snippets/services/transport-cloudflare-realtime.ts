// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Samples for content/docs/transports/cloudflare-realtime.mdx. Type-checked on every docs build.

// #region transport
import { Pipeline } from "@pipedog/core/pipeline/pipeline";
import { PipelineParams, PipelineWorker } from "@pipedog/core/pipeline/worker";
import { WorkerRunner } from "@pipedog/core/workers/runner";
import {
  CloudflareRealtimeAPI,
  CloudflareRealtimeCall,
  type SessionDescription,
} from "@pipedog/transport-cloudflare-realtime/api";
import {
  CloudflareRealtimeParams,
  CloudflareRealtimeTransport,
} from "@pipedog/transport-cloudflare-realtime/transport";

/** Starts a bot on `transport`; it runs until the user leaves. */
async function runBot(transport: CloudflareRealtimeTransport): Promise<void> {
  const pipeline = new Pipeline([
    transport.input(),
    // ... STT, LLM context aggregators, LLM, TTS
    transport.output(),
  ]);
  const worker = new PipelineWorker(pipeline, {
    // The transport converts to and from the SFU's 48 kHz stereo.
    params: new PipelineParams({ audioInSampleRate: 16000, audioOutSampleRate: 24000 }),
  });
  const runner = new WorkerRunner({ handleSigint: false, handleSigterm: false });

  transport.eventHandler("on_client_connected", async () => {
    console.log("the SFU attached both adapters");
  });
  transport.eventHandler("on_client_disconnected", async () => {
    await runner.cancel();
  });

  await runner.addWorkers(worker);
  await runner.run();
}
// #endregion transport

interface Env {
  CLOUDFLARE_REALTIME_APP_ID: string;
  CLOUDFLARE_REALTIME_APP_SECRET: string;
}

// #region server
/** One call, e.g. a Durable Object: signaling, the sockets the SFU dials, and the bot. */
class VoiceCall {
  readonly #env: Env;
  #call: CloudflareRealtimeCall | null = null;
  #transport: CloudflareRealtimeTransport | null = null;
  #token = crypto.randomUUID();

  constructor(env: Env) {
    this.#env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const action = url.pathname.split("/").slice(4).join("/"); // /api/call/<id>/<action>

    if (action === "offer") {
      // 1. The browser's microphone offer: publish it, and start the bot.
      const { sessionDescription, mid } = (await request.json()) as {
        sessionDescription: SessionDescription;
        mid: string;
      };
      const api = new CloudflareRealtimeAPI({
        appId: this.#env.CLOUDFLARE_REALTIME_APP_ID,
        appSecret: this.#env.CLOUDFLARE_REALTIME_APP_SECRET,
      });
      this.#call = new CloudflareRealtimeCall(api);
      this.#transport = new CloudflareRealtimeTransport(
        new CloudflareRealtimeParams({ audioInEnabled: true, audioOutEnabled: true }),
      );
      void runBot(this.#transport).finally(() => this.#call?.close());
      const answer = await this.#call.publishUser(sessionDescription, mid);
      return Response.json({ sessionDescription: answer.sessionDescription });
    }

    if (action === "connect" && this.#call) {
      // 2. The browser is connected: the SFU dials both endpoints during this call.
      const media = `wss://${url.host}${url.pathname.replace(/connect$/, "media")}`;
      const offer = await this.#call.connectBot({
        input: `${media}/input?token=${this.#token}`,
        output: `${media}/output?token=${this.#token}`,
      });
      return Response.json({ sessionDescription: offer.sessionDescription });
    }

    if (action === "answer" && this.#call) {
      // 3. The browser's answer to the bot's track.
      const { sessionDescription } = (await request.json()) as {
        sessionDescription: SessionDescription;
      };
      await this.#call.renegotiate(sessionDescription);
      return Response.json({ ok: true });
    }

    if (this.#transport && (action === "media/input" || action === "media/output")) {
      // The SFU can't send headers: check the token from the URL.
      if (url.searchParams.get("token") !== this.#token) {
        return new Response("forbidden", { status: 403 });
      }
      return this.#transport.acceptSocket(action === "media/input" ? "input" : "output", request);
    }

    if (this.#transport && action === "messages") {
      // The browser's RTVI messages.
      return this.#transport.acceptSocket("messages", request);
    }

    return new Response("not found", { status: 404 });
  }
}
// #endregion server

// #region browser
/** The browser: publish the microphone, play the bot, and speak RTVI over the messages socket. */
async function call(base: string): Promise<{ pc: RTCPeerConnection; messages: WebSocket }> {
  const post = async (action: string, body: unknown = {}) => {
    const response = await fetch(`${base}/${action}`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    return (await response.json()) as { sessionDescription: RTCSessionDescriptionInit };
  };
  const gathered = (pc: RTCPeerConnection) =>
    new Promise<void>((resolve) => {
      if (pc.iceGatheringState === "complete") return resolve();
      pc.addEventListener("icegatheringstatechange", () => {
        if (pc.iceGatheringState === "complete") resolve();
      });
      setTimeout(resolve, 2000);
    });

  const mic = await navigator.mediaDevices.getUserMedia({ audio: true });
  const pc = new RTCPeerConnection({
    iceServers: [{ urls: "stun:stun.cloudflare.com:3478" }],
    bundlePolicy: "max-bundle",
  });
  const audio = new Audio();
  audio.autoplay = true;
  pc.addEventListener("track", (event) => {
    audio.srcObject = new MediaStream([event.track]);
  });

  // 1. Publish the microphone.
  const transceiver = pc.addTransceiver(mic.getAudioTracks()[0]!, { direction: "sendonly" });
  await pc.setLocalDescription(await pc.createOffer());
  await gathered(pc);
  const published = await post("offer", {
    sessionDescription: pc.localDescription,
    mid: transceiver.mid,
  });
  await pc.setRemoteDescription(published.sessionDescription);
  await new Promise<void>((resolve) => {
    pc.addEventListener("connectionstatechange", () => {
      if (pc.connectionState === "connected") resolve();
    });
  });

  // 2. The messages socket (RTVI), then the bot's track.
  const messages = new WebSocket(`${base.replace(/^http/, "ws")}/messages`);
  await new Promise((resolve) => messages.addEventListener("open", resolve, { once: true }));
  const subscription = await post("connect");
  await pc.setRemoteDescription(subscription.sessionDescription);
  await pc.setLocalDescription(await pc.createAnswer());
  await gathered(pc);
  await post("answer", { sessionDescription: pc.localDescription });

  // 3. Ready: the bot can greet the user now.
  messages.send(
    JSON.stringify({
      label: "rtvi-ai",
      type: "client-ready",
      id: crypto.randomUUID(),
      data: { version: "2.0.0", about: { library: "my-app" } },
    }),
  );
  return { pc, messages };
}

// #endregion browser

export { call, VoiceCall };
