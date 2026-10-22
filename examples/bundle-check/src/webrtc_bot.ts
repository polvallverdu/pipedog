// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Configuration (b): SmallWebRTC (werift). Two peer connections of the
// transport's own wrapper negotiate over loopback, open a data channel and send
// a message; then the transport's default Opus codec (libopus-wasm) encodes and
// decodes a frame. Needs nothing from node_modules when bundled.

import { getOpusCodec } from "@pipedog/transport-smallwebrtc/opus";
import { RTCPeerConnection, RTCSessionDescription } from "@pipedog/transport-smallwebrtc/rtc";
import { OK_MARKER } from "./common.ts";

// The Opus codec first: it loads libopus-wasm, which is the other thing a bundle can break.
const encoder = await getOpusCodec().createEncoder({ sampleRate: 48000, channels: 1 });
const packet = encoder.encode(new Int16Array(960));
console.log(`opus encoded 20 ms into ${packet.length} bytes`);

const a = new RTCPeerConnection();
const b = new RTCPeerConnection();
const channel = a.createDataChannel("check");
const received = new Promise<string>((resolve) => {
  b.on("datachannel", (ch: any) => ch.on("message", (m: string) => resolve(String(m))));
});
channel.on("open", () => channel.send("hello over werift"));

await a.setLocalDescription(await a.createOffer());
await b.setRemoteDescription(new RTCSessionDescription(a.localDescription as any));
await b.setLocalDescription(await b.createAnswer());
await a.setRemoteDescription(new RTCSessionDescription(b.localDescription as any));

const message = await Promise.race([
  received,
  new Promise<string>((_, reject) =>
    setTimeout(() => reject(new Error("no data channel message within 15 s")), 15000),
  ),
]);
console.log(`${OK_MARKER} message=${message}`);
await a.close();
await b.close();
process.exit(0);
