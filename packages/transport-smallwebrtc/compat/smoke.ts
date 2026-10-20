// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Runtime smoke test for tools/compat: two in-process werift peers (our
// aiortc-shaped adapter) connect over localhost, exchange a data channel
// message, and send Opus audio one way through the real ICE/DTLS/SRTP path.

import { sleep, waitFor } from "@pipedog/asyncio";
import { AudioFrame, AudioStreamTrack } from "@pipedog/transport-smallwebrtc/media";
import { type RTCDataChannel, RTCPeerConnection } from "@pipedog/transport-smallwebrtc/rtc";

/** 20 ms frames of a 440 Hz tone at 16 kHz. */
class ToneTrack extends AudioStreamTrack {
  #n = 0;
  override async recv(): Promise<AudioFrame> {
    await super.recv();
    const data = new Int16Array(320);
    for (let i = 0; i < data.length; i++, this.#n++) {
      data[i] = Math.round(8000 * Math.sin((2 * Math.PI * 440 * this.#n) / 16000));
    }
    const frame = new AudioFrame({ data, sampleRate: 16000 });
    frame.pts = this.#n;
    return frame;
  }
}

export default async function smoke(): Promise<{ audioFrames: number; rms: number }> {
  const host = { werift: { iceAdditionalHostAddresses: ["127.0.0.1"], iceUseIpv6: false } };
  const client = new RTCPeerConnection(host);
  const bot = new RTCPeerConnection(host);
  try {
    client.addTransceiver("audio", { direction: "sendrecv" });
    const clientChannel = client.createDataChannel("chat");
    await client.setLocalDescription(await client.createOffer());

    let botChannel: RTCDataChannel | null = null;
    const received: string[] = [];
    bot.on("datachannel", (channel: RTCDataChannel) => {
      botChannel = channel;
      channel.on("message", (m: unknown) => received.push(String(m)));
    });
    await bot.setRemoteDescription(client.localDescription!);
    for (const t of bot.getTransceivers()) t.direction = "sendrecv";
    await bot.setLocalDescription(await bot.createAnswer());
    await client.setRemoteDescription(bot.localDescription!);

    for (let i = 0; i < 100 && bot.connectionState !== "connected"; i++) await sleep(0.1);
    if (bot.connectionState !== "connected")
      throw new Error(`not connected: ${bot.connectionState}`);

    // Data channel, client -> bot and back.
    for (let i = 0; i < 50 && clientChannel.readyState !== "open"; i++) await sleep(0.1);
    clientChannel.send("hello");
    for (let i = 0; i < 50 && received.length === 0; i++) await sleep(0.05);
    if (received[0] !== "hello") throw new Error(`data channel: got ${JSON.stringify(received)}`);
    const echoed: string[] = [];
    clientChannel.on("message", (m: unknown) => echoed.push(String(m)));
    botChannel!.send("hi back");
    for (let i = 0; i < 50 && echoed.length === 0; i++) await sleep(0.05);
    if (echoed[0] !== "hi back")
      throw new Error(`data channel back: got ${JSON.stringify(echoed)}`);

    // Audio, client -> bot.
    client.getTransceivers()[0]!.sender.replaceTrack(new ToneTrack());
    const receiver = bot.getTransceivers()[0]!.receiver;
    receiver.setAudioOutputFormat(16000, 1);
    let frames = 0;
    let sum = 0;
    let count = 0;
    while (frames < 20) {
      const frame = await waitFor(() => receiver.track.recv(), 5);
      if (!(frame instanceof AudioFrame)) continue;
      frames++;
      if (frames > 5 && frame.sampleRate === 16000) {
        for (const s of frame.data) sum += s * s;
        count += frame.data.length;
      }
    }
    const rms = Math.sqrt(sum / Math.max(1, count));
    if (rms < 1000) throw new Error(`audio too quiet: rms ${rms}`);
    return { audioFrames: frames, rms: Math.round(rms) };
  } finally {
    await client.close();
    await bot.close();
  }
}
