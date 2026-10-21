// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Wire compatibility with upstream: replays what upstream's
 * TwilioFrameSerializer produced for the same inputs
 * (tools/golden/telephony.py).
 *
 * Without resampling (pipeline at 8 kHz) the audio must be byte-identical. With
 * resampling, upstream runs libsoxr and we run `@pipedog/resampler-wasm`, whose
 * presets carry libsoxr's names but are not bit-identical, so the resampled
 * audio is compared after aligning the two streams, by signal-to-noise ratio.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SystemClock } from "@pipedog/core/clocks/system_clock";
import {
  CancelFrame,
  EndFrame,
  InputAudioRawFrame,
  InputDTMFFrame,
  InterruptionFrame,
  OutputAudioRawFrame,
  OutputTransportMessageFrame,
  OutputTransportMessageUrgentFrame,
} from "@pipedog/core/frames/frames";
import { FrameProcessorSetup } from "@pipedog/core/processors/frame_processor";
import type { BaseTaskManager } from "@pipedog/core/utils/asyncio/task_manager";
import { type LogRecord, logger } from "@pipedog/core/utils/logger";
import { TwilioFrameSerializer, type TwilioFrameSerializerOptions } from "../src/twilio.ts";
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

/** SNR (dB) of `ours` against `ref` at the lag that maximizes it. */
function alignedSnr(ref: Int16Array, ours: Int16Array, maxLag = 400): number {
  let best = Number.NEGATIVE_INFINITY;
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
    best = Math.max(best, 10 * Math.log10(signal / Math.max(noise, 1e-9)));
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

async function makeSerializer(rate: number): Promise<TwilioFrameSerializer> {
  const serializer = new TwilioFrameSerializer({
    streamSid: "MZ123",
    params: new TwilioFrameSerializer.InputParams({ autoHangUp: false }),
  });
  await serializer.setup(setupFor(rate));
  return serializer;
}

describe("twilio golden vectors: audio", () => {
  for (const c of golden.audio as Any[]) {
    const name = `pipeline ${c.rate} Hz`;
    const resampled = c.rate !== 8000;

    test(`${name}: encode 8 kHz source`, async () => {
      const encoder = await makeSerializer(8000);
      const src = fromHex(c.source8k);
      const messages: (string | null)[] = [];
      for (let i = 0; i < src.length; i += 320) {
        messages.push(
          (await encoder.serialize(
            new OutputAudioRawFrame({
              audio: src.slice(i, i + 320),
              sampleRate: 8000,
              numChannels: 1,
            }),
          )) as string | null,
        );
      }
      expect(messages).toEqual(c.mediaMessages);
    });

    test(`${name}: deserialize media events`, async () => {
      const serializer = await makeSerializer(c.rate);
      const chunks: Uint8Array[] = [];
      const ours: (string | null)[] = [];
      for (const message of c.mediaMessages as string[]) {
        const frame = (await serializer.deserialize(message)) as InputAudioRawFrame | null;
        ours.push(frame ? toHex(frame.audio) : null);
        if (frame) {
          expect(frame).toBeInstanceOf(InputAudioRawFrame);
          expect(frame.sampleRate).toEqual(c.rate);
          expect(frame.numChannels).toEqual(1);
          chunks.push(frame.audio);
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
      expect(alignedSnr(ref, int16(concat(chunks)))).toBeGreaterThan(45);
    });

    test(`${name}: serialize pipeline audio`, async () => {
      const serializer = await makeSerializer(c.rate);
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
      for (const m of ours) {
        if (m !== null) expect(Object.keys(JSON.parse(m))).toEqual(["event", "streamSid", "media"]);
      }
      if (!resampled) {
        expect(ours).toEqual(c.serialized);
        return;
      }
      const decoder = await makeSerializer(8000);
      const decode = async (messages: (string | null)[]) => {
        const out: Uint8Array[] = [];
        for (const m of messages) {
          if (m === null) continue;
          out.push(((await decoder.deserialize(m)) as InputAudioRawFrame).audio);
        }
        return int16(concat(out));
      };
      expect(alignedSnr(await decode(c.serialized), await decode(ours))).toBeGreaterThan(35);
    });
  }
});

describe("twilio golden vectors: events and messages", () => {
  for (const e of golden.events as Any[]) {
    test(`deserialize ${e.input}`, async () => {
      const serializer = await makeSerializer(16000);
      if (e.error) {
        // Upstream raises AttributeError from `.get()` on a value that is not a dict.
        await expect(serializer.deserialize(e.input)).rejects.toThrow(
          "object has no attribute 'get'",
        );
        return;
      }
      const frame = await serializer.deserialize(e.input);
      if (e.frame === null) {
        expect(frame).toBeNull();
      } else {
        expect(frame).toBeInstanceOf(InputDTMFFrame);
        expect((frame as InputDTMFFrame).button).toEqual(e.frame.button);
      }
    });
  }

  for (const { input, out } of golden.serializeMisc as Any[]) {
    test(`serialize ${input.kind} ${JSON.stringify(input.message ?? "").slice(0, 40)}`, async () => {
      const serializer = await makeSerializer(16000);
      let frame: Any;
      if (input.kind === "interruption") frame = new InterruptionFrame();
      else if (input.kind === "end") frame = new EndFrame();
      else if (input.kind === "message")
        frame = new OutputTransportMessageFrame({ message: input.message });
      else frame = new OutputTransportMessageUrgentFrame({ message: input.message });
      if (out !== null && typeof out === "object") {
        await expect(serializer.serialize(frame)).rejects.toThrow("object has no attribute 'get'");
      } else {
        expect(await serializer.serialize(frame)).toEqual(out);
      }
    });
  }
});

describe("twilio golden vectors: hang-up REST call", () => {
  let server: ReturnType<typeof Bun.serve>;
  let captured: Any = null;
  let requestedUrl = "";
  let response = { status: 200, body: "", contentType: "application/json" };
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
          headers: { "Content-Type": response.contentType },
        });
      },
    });
    // The endpoint is derived from region/edge; point it at the local server.
    globalThis.fetch = ((input: Any, init?: Any) => {
      requestedUrl = String(input);
      return realFetch(
        requestedUrl.replace(/^https:\/\/api\.[^/]+/, `http://127.0.0.1:${server.port}`),
        init,
      );
    }) as typeof fetch;
  });

  afterAll(() => {
    globalThis.fetch = realFetch;
    server.stop(true);
  });

  const cases: [string, Any, Partial<TwilioFrameSerializerOptions>, string][] = [
    ...(golden.hangup as Any[]).map(
      (h) =>
        [`status ${h.status} ${h.contentType} ${h.responseBody}`, h, {}, "api.twilio.com"] as [
          string,
          Any,
          Partial<TwilioFrameSerializerOptions>,
          string,
        ],
    ),
    ...(golden.hangupRegional as Any[]).map(
      (h) =>
        [
          `region au1, edge sydney: status ${h.status}`,
          h,
          { region: "au1", edge: "sydney" },
          "api.sydney.au1.twilio.com",
        ] as [string, Any, Partial<TwilioFrameSerializerOptions>, string],
    ),
  ];

  for (const [name, h, extra, host] of cases) {
    test(name, async () => {
      response = { status: h.status, body: h.responseBody, contentType: h.contentType };
      captured = null;
      const logs: [string, string][] = [];
      const remove = logger.addSink((r: LogRecord) => logs.push([r.level, r.message]));
      try {
        const serializer = new TwilioFrameSerializer({
          streamSid: "MZ123",
          callSid: "CA/call id",
          accountSid: "AC_acct",
          authToken: "tok:en",
          ...extra,
        });
        expect(await serializer.serialize(new EndFrame())).toEqual(h.serializeEnd);
        expect(await serializer.serialize(new CancelFrame())).toEqual(h.serializeCancelAfter);
      } finally {
        remove();
      }
      expect(new URL(requestedUrl).host).toEqual(host);
      const want = h.request;
      expect(captured.method).toEqual(want.method);
      expect(captured.path).toEqual(want.path);
      expect(captured.body).toEqual(want.body);
      // The protocol headers; Host, User-Agent, Accept and Accept-Encoding
      // belong to the HTTP client.
      for (const header of ["content-type", "authorization", "content-length"]) {
        expect(captured.headers[header]).toEqual(want.headers[header]);
      }
      expect(logs).toEqual(h.logs);
    });
  }
});
