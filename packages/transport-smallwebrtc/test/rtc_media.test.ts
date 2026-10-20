// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Tests for the pieces this package adds around werift: the audio reorder
// buffer, candidate parsing, RTP (de)packetization, pixel formats, Opus
// packet sizes and ESP32 SDP munging.

import { describe, expect, test } from "bun:test";
import { AudioJitterBuffer, type JitterPacket } from "@pipedog/transport-smallwebrtc/jitter_buffer";
import { AudioFrame, AudioResampler } from "@pipedog/transport-smallwebrtc/media";
import { libopusWasmCodec, opusPacketSamples } from "@pipedog/transport-smallwebrtc/opus";
import { smallwebrtcSdpMunging } from "@pipedog/transport-smallwebrtc/request_handler";
import { candidateFromSdp, candidateToSdp } from "@pipedog/transport-smallwebrtc/rtc";
import {
  convertToRgb,
  h264Depayload,
  h264Packetize,
  vp8Depayload,
  vp8Packetize,
} from "@pipedog/transport-smallwebrtc/video";

const pkt = (sequenceNumber: number, timestamp = sequenceNumber * 960): JitterPacket => ({
  sequenceNumber,
  timestamp,
});

describe("AudioJitterBuffer", () => {
  test("releases in-order packets at once", () => {
    const jb = new AudioJitterBuffer(2880);
    const out = [0, 1, 2].flatMap((s) => jb.add(pkt(s)));
    expect(out.map((o) => o.packet?.sequenceNumber)).toEqual([0, 1, 2]);
  });

  test("reorders a late packet", () => {
    const jb = new AudioJitterBuffer(2880);
    const out = [0, 2, 1, 3].flatMap((s) => jb.add(pkt(s)));
    expect(out.map((o) => o.packet?.sequenceNumber)).toEqual([0, 1, 2, 3]);
  });

  test("reports a gap once the held audio spans the latency", () => {
    const jb = new AudioJitterBuffer(2880); // 3 packets
    const out = [0, 3, 4, 5, 6].flatMap((s) => jb.add(pkt(s)));
    expect(out).toEqual([
      { packet: pkt(0) },
      { lost: 2 },
      { packet: pkt(3) },
      { packet: pkt(4) },
      { packet: pkt(5) },
      { packet: pkt(6) },
    ]);
  });

  test("drops duplicates and wraps sequence numbers", () => {
    const jb = new AudioJitterBuffer(2880);
    const out = [65534, 65535, 65535, 0, 1].flatMap((s) => jb.add(pkt(s)));
    expect(out.map((o) => o.packet?.sequenceNumber)).toEqual([65534, 65535, 0, 1]);
  });
});

describe("ICE candidates", () => {
  test("parse with or without the prefix", () => {
    const c = candidateFromSdp(
      "candidate:842163049 1 udp 1677729535 1.2.3.4 46154 typ srflx raddr 10.0.0.1 rport 46154",
    );
    expect(c).toMatchObject({
      foundation: "842163049",
      component: 1,
      ip: "1.2.3.4",
      port: 46154,
      type: "srflx",
    });
    expect(c.relatedAddress).toEqual("10.0.0.1");
    expect(candidateToSdp(c)).toEqual(
      "842163049 1 udp 1677729535 1.2.3.4 46154 typ srflx raddr 10.0.0.1 rport 46154",
    );
    expect(candidateFromSdp("1 1 UDP 1 abc.local 9 typ host").ip).toEqual("abc.local");
    expect(() => candidateFromSdp("")).toThrow();
  });
});

describe("RTP packetization", () => {
  test("VP8 round trip", () => {
    const frame = new Uint8Array(3000).map((_, i) => i & 0xff);
    const payloads = vp8Packetize(frame);
    expect(payloads.length).toEqual(3);
    expect(payloads[0]![0]).toEqual(0x10);
    const back = payloads.flatMap((p) => [...vp8Depayload(p)]);
    expect(new Uint8Array(back)).toEqual(frame);
  });

  test("VP8 depayload skips the extended descriptor", () => {
    // X, then I with a 15-bit picture id
    expect(vp8Depayload(new Uint8Array([0x90, 0x80, 0x81, 0x23, 7, 8]))).toEqual(
      new Uint8Array([7, 8]),
    );
  });

  test("H264 round trip with FU-A", () => {
    const sps = new Uint8Array([0x67, 1, 2, 3]);
    const idr = new Uint8Array(4000).map((_, i) => (i === 0 ? 0x65 : (i % 250) + 1));
    const au = new Uint8Array([0, 0, 0, 1, ...sps, 0, 0, 0, 1, ...idr]);
    const payloads = h264Packetize(au);
    expect(payloads[0]).toEqual(sps);
    expect(payloads.slice(1).every((p) => (p[0]! & 0x1f) === 28)).toBe(true);
    const back = new Uint8Array(payloads.flatMap((p) => [...h264Depayload(p)]));
    expect(back).toEqual(au);
  });
});

describe("pixel formats", () => {
  test("yuv420p, nv12 and gray become RGB", () => {
    // 2x2 white (Y=235, U=V=128 in limited range)
    expect(
      convertToRgb(
        { data: new Uint8Array([235, 235, 235, 235, 128, 128]), width: 2, height: 2 },
        "yuv420p",
      ),
    ).toEqual(new Uint8Array(12).fill(255));
    expect(
      convertToRgb(
        { data: new Uint8Array([235, 235, 235, 235, 128, 128]), width: 2, height: 2 },
        "nv12",
      ),
    ).toEqual(new Uint8Array(12).fill(255));
    expect(convertToRgb({ data: new Uint8Array([7]), width: 1, height: 1 }, "gray")).toEqual(
      new Uint8Array([7, 7, 7]),
    );
    expect(() => convertToRgb({ data: new Uint8Array(1), width: 1, height: 1 }, "bgr0x")).toThrow();
  });
});

describe("Opus", () => {
  test("packet sizes, PLC and FEC decode at the pipeline rate", async () => {
    const encoder = await libopusWasmCodec.createEncoder({
      sampleRate: 16000,
      channels: 1,
      bitrate: 32000,
    });
    const decoder = await libopusWasmCodec.createDecoder({ sampleRate: 16000, channels: 1 });
    const pcm = new Int16Array(320).map((_, i) => Math.round(8000 * Math.sin(i / 3)));
    const packet = encoder.encode(pcm);
    expect(opusPacketSamples(packet, 16000)).toEqual(320);
    expect(opusPacketSamples(packet, 48000)).toEqual(960);
    expect(decoder.decode(packet).length).toEqual(320);
    expect(decoder.decodePacketLoss(320).length).toEqual(320);
    expect(decoder.decode(packet, { fec: true, frameSize: 320 }).length).toEqual(320);
    encoder.free();
    decoder.free();
  });
});

describe("AudioResampler", () => {
  test("mixes stereo down and resamples", async () => {
    const resampler = new AudioResampler("s16", "mono", 16000);
    const stereo = new AudioFrame({
      data: new Int16Array(960 * 2).fill(1000),
      sampleRate: 48000,
      layout: "stereo",
    });
    let samples = 0;
    for (let i = 0; i < 5; i++)
      for (const f of await resampler.resample(stereo)) samples += f.samples;
    expect(samples).toBeGreaterThan(1200);
    expect(samples).toBeLessThanOrEqual(1600);
  });
});

describe("smallwebrtcSdpMunging", () => {
  test("drops sha-384/512 fingerprints and filters candidates by host", () => {
    const sdp = [
      "v=0",
      "a=fingerprint:sha-256 AA",
      "a=fingerprint:sha-512 BB",
      "a=candidate:1 1 udp 1 192.168.1.5 9 typ host",
      "a=candidate:2 1 udp 1 10.0.0.1 9 typ host",
      "a=candidate:3 1 udp 1 192.168.1.5 9 typ srflx raddr 1.1.1.1 rport 9",
      "",
    ].join("\r\n");
    expect(smallwebrtcSdpMunging(sdp, "192.168.1.5")).toEqual(
      ["v=0", "a=fingerprint:sha-256 AA", "a=candidate:1 1 udp 1 192.168.1.5 9 typ host", ""].join(
        "\r\n",
      ),
    );
  });
});
