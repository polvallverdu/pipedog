// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Wire compatibility with upstream: replays what upstream's
 * TelnyxFrameSerializer produced for the same inputs
 * (tools/golden/serializers.py).
 *
 * Without resampling (pipeline at 8 kHz) the audio must be byte-identical. With
 * resampling, upstream runs libsoxr and we run `@pipedog/resampler-wasm`, whose
 * presets carry libsoxr's names but are not bit-identical, so the resampled
 * audio is compared after aligning the two streams (their filter delays
 * differ), by signal-to-noise ratio.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SystemClock } from "@pipedog/core/clocks/system_clock";
import {
  CancelFrame,
  EndFrame,
  InputDTMFFrame,
  InterruptionFrame,
  OutputAudioRawFrame,
  OutputTransportMessageFrame,
  OutputTransportMessageUrgentFrame,
} from "@pipedog/core/frames/frames";
import { FrameProcessorSetup } from "@pipedog/core/processors/frame_processor";
import type { BaseTaskManager } from "@pipedog/core/utils/asyncio/task_manager";
import { base64ToBytes } from "@pipedog/core/utils/base64";
import { type LogRecord, logger } from "@pipedog/core/utils/logger";
import { TelnyxFrameSerializer } from "../src/telnyx.ts";
import golden from "./fixtures/golden.json";

type Any = any;

const fromHex = (hex: string) => Uint8Array.from(hex.match(/../g) ?? [], (b) => parseInt(b, 16));
const toHex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

function concat(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

const int16 = (bytes: Uint8Array) => new Int16Array(bytes.slice().buffer);

/**
 * SNR (dB) of `ours` against `ref` at the lag (ours shifted by `lag`
 * samples) that maximizes it, over the samples both streams cover.
 */
function alignedSnr(ref: Int16Array, ours: Int16Array, maxLag = 400): { snr: number; lag: number } {
  let best = { snr: Number.NEGATIVE_INFINITY, lag: 0 };
  for (let lag = -maxLag; lag <= maxLag; lag++) {
    let signal = 0;
    let noise = 0;
    for (let i = 0; i < ref.length; i++) {
      const j = i + lag;
      if (j < 0 || j >= ours.length) continue;
      const r = ref[i] as number;
      const d = r - (ours[j] as number);
      signal += r * r;
      noise += d * d;
    }
    if (signal === 0) continue;
    const snr = 10 * Math.log10(signal / Math.max(noise, 1e-9));
    if (snr > best.snr) best = { snr, lag };
  }
  return best;
}

function setupFor(rate: number): FrameProcessorSetup {
  return new FrameProcessorSetup({
    clock: new SystemClock(),
    pipelineWorker: null,
    taskManager: null as unknown as BaseTaskManager,
    audioInSampleRate: rate,
  });
}

async function makeSerializer(encoding: string, rate: number): Promise<TelnyxFrameSerializer> {
  const serializer = new TelnyxFrameSerializer({
    streamId: "s",
    outboundEncoding: encoding,
    inboundEncoding: encoding,
    params: new TelnyxFrameSerializer.InputParams({ autoHangUp: false }),
  });
  await serializer.setup(setupFor(rate));
  return serializer;
}

const ulawOrAlawPayload = (message: string) => base64ToBytes(JSON.parse(message).media.payload);

describe("telnyx golden vectors: audio", () => {
  for (const c of golden.audio as Any[]) {
    const name = `${c.encoding} pipeline ${c.rate} Hz`;
    const resampled = c.rate !== 8000;

    test(`${name}: encode 8 kHz source`, async () => {
      // The 8 kHz source, encoded without resampling: byte-identical.
      const encoder = await makeSerializer(c.encoding, 8000);
      const src = fromHex(c.source8k);
      const step = 320;
      const messages: (string | null)[] = [];
      for (let i = 0; i < src.length; i += step) {
        const out = await encoder.serialize(
          new OutputAudioRawFrame({
            audio: src.slice(i, i + step),
            sampleRate: 8000,
            numChannels: 1,
          }),
        );
        messages.push(out as string | null);
      }
      expect(messages).toEqual(c.mediaMessages);
    });

    test(`${name}: deserialize media events`, async () => {
      const serializer = await makeSerializer(c.encoding, c.rate);
      const chunks: Uint8Array[] = [];
      const ours: (string | null)[] = [];
      for (const message of c.mediaMessages as string[]) {
        const frame = await serializer.deserialize(message);
        ours.push(frame ? toHex((frame as Any).audio) : null);
        if (frame) {
          expect((frame as Any).sampleRate).toEqual(c.rate);
          expect((frame as Any).numChannels).toEqual(1);
          chunks.push((frame as Any).audio);
        }
      }
      if (!resampled) {
        expect(ours).toEqual(c.deserialized);
        return;
      }
      const ref = int16(
        concat(
          (c.deserialized as (string | null)[]).filter((x) => x).map((x) => fromHex(x as string)),
        ),
      );
      const { snr } = alignedSnr(ref, int16(concat(chunks)));
      // Two VHQ-class resamplers of the same 8 kHz input agree to well
      // 50 dB here; the mu-law/A-law decode itself is exact.
      expect(snr).toBeGreaterThan(45);
    });

    test(`${name}: serialize pipeline audio`, async () => {
      const serializer = await makeSerializer(c.encoding, c.rate);
      const pcm = fromHex(c.pipelinePcm);
      const step = ((c.rate * 20) / 1000) * 2;
      const ours: (string | null)[] = [];
      for (let i = 0; i < pcm.length; i += step) {
        ours.push(
          (await serializer.serialize(
            new OutputAudioRawFrame({
              audio: pcm.slice(i, i + step),
              sampleRate: c.rate,
              numChannels: 1,
            }),
          )) as string | null,
        );
      }
      for (const m of ours)
        if (m !== null) expect(Object.keys(JSON.parse(m))).toEqual(["event", "media"]);
      if (!resampled) {
        expect(ours).toEqual(c.serialized);
        return;
      }
      // Decode both encoded streams back to PCM with the 8 kHz deserializer
      // (exact, no resampling) and compare them.
      const decoder = await makeSerializer(c.encoding, 8000);
      const decode = async (messages: (string | null)[]) => {
        const out: Uint8Array[] = [];
        for (const m of messages) {
          if (m === null) continue;
          expect(ulawOrAlawPayload(m).length).toBeGreaterThan(0);
          out.push(((await decoder.deserialize(m)) as Any).audio);
        }
        return int16(concat(out));
      };
      const { snr } = alignedSnr(await decode(c.serialized), await decode(ours));
      // About 39 dB, bounded by the 8-bit companding noise of the two encodings.
      expect(snr).toBeGreaterThan(35);
    });
  }
});

describe("telnyx golden vectors: events and messages", () => {
  for (const { input, frame: expected } of golden.events as Any[]) {
    test(`deserialize ${input}`, async () => {
      const serializer = await makeSerializer("PCMU", 16000);
      const frame = await serializer.deserialize(input);
      if (expected === null) {
        expect(frame).toBeNull();
      } else if (expected.type === "InputDTMFFrame") {
        expect(frame).toBeInstanceOf(InputDTMFFrame);
        expect((frame as InputDTMFFrame).button).toEqual(expected.button);
      } else {
        expect(frame?.constructor.name).toEqual(expected.type);
      }
    });
  }

  for (const { input, out } of golden.serializeMisc as Any[]) {
    const isError = out !== null && typeof out === "object";
    // Upstream's base `FrameSerializer.should_ignore_frame` calls
    // `message.get("label")`, which raises for a non-dict message.
    const t = test;
    t(`serialize ${input.kind} ${JSON.stringify(input.message ?? "").slice(0, 40)}`, async () => {
      const serializer = await makeSerializer("PCMU", 16000);
      let frame: Any;
      if (input.kind === "interruption") frame = new InterruptionFrame();
      else if (input.kind === "end") frame = new EndFrame();
      else if (input.kind === "message")
        frame = new OutputTransportMessageFrame({ message: input.message });
      else frame = new OutputTransportMessageUrgentFrame({ message: input.message });
      if (isError) {
        await expect(serializer.serialize(frame)).rejects.toThrow("object has no attribute 'get'");
      } else {
        expect(await serializer.serialize(frame)).toEqual(out);
      }
    });
  }
});

describe("telnyx golden vectors: hang-up REST call", () => {
  let server: ReturnType<typeof Bun.serve>;
  let captured: Any = null;
  let response = { status: 200, body: "" };
  const realFetch = globalThis.fetch;

  beforeAll(() => {
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        captured = {
          method: req.method,
          path: url.pathname + url.search,
          headers: Object.fromEntries([...req.headers].map(([k, v]) => [k.toLowerCase(), v])),
          body: await req.text(),
        };
        return new Response(response.body, {
          status: response.status,
          headers: { "Content-Type": "application/json" },
        });
      },
    });
    // The endpoint is hard-coded; point it at the local server.
    globalThis.fetch = ((input: Any, init?: Any) =>
      realFetch(
        String(input).replace("https://api.telnyx.com", `http://127.0.0.1:${server.port}`),
        init,
      )) as typeof fetch;
  });

  afterAll(() => {
    globalThis.fetch = realFetch;
    server.stop(true);
  });

  for (const h of golden.hangup as Any[]) {
    test(`status ${h.status} ${h.responseBody}`, async () => {
      response = { status: h.status, body: h.responseBody };
      captured = null;
      const logs: [string, string][] = [];
      const remove = logger.addSink((r: LogRecord) => logs.push([r.level, r.message]));
      try {
        const serializer = new TelnyxFrameSerializer({
          streamId: "s",
          outboundEncoding: "PCMU",
          inboundEncoding: "PCMU",
          callControlId: "v3:call/ctrl id",
          apiKey: "KEY_123",
        });
        expect(await serializer.serialize(new EndFrame())).toEqual(h.serializeEnd);
        expect(await serializer.serialize(new CancelFrame())).toEqual(h.serializeCancelAfter);
      } finally {
        remove();
      }
      const want = h.request;
      expect(captured.method).toEqual(want.method);
      expect(captured.path).toEqual(want.path);
      expect(captured.body).toEqual(want.body);
      // The protocol headers; Host, User-Agent, Accept and Accept-Encoding
      // belong to the HTTP client.
      for (const name of ["content-type", "authorization"]) {
        expect(captured.headers[name]).toEqual(want.headers[name]);
      }
      expect(captured.headers["content-length"] ?? "0").toEqual(want.headers["content-length"]);
      expect(logs).toEqual(h.logs);
    });
  }
});
