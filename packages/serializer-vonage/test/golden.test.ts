// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Wire compatibility with upstream: replays what upstream's
 * VonageFrameSerializer produced for the same inputs
 * (tools/golden/telephony.py).
 *
 * Vonage's Audio Connector streams raw 16-bit PCM (16 kHz by default) in
 * binary messages, and JSON events in text messages. With the pipeline at
 * 16 kHz the audio is byte-identical; at other rates it is resampled (libsoxr
 * upstream, `@pipedog/resampler-wasm` here) and compared after alignment, by
 * signal-to-noise ratio.
 */

import { describe, expect, test } from "bun:test";
import { SystemClock } from "@pipedog/core/clocks/system_clock";
import {
  EndFrame,
  type InputAudioRawFrame,
  InputDTMFFrame,
  InterruptionFrame,
  OutputAudioRawFrame,
  OutputTransportMessageFrame,
  OutputTransportMessageUrgentFrame,
} from "@pipedog/core/frames/frames";
import { FrameProcessorSetup } from "@pipedog/core/processors/frame_processor";
import type { BaseTaskManager } from "@pipedog/core/utils/asyncio/task_manager";
import { type LogRecord, logger } from "@pipedog/core/utils/logger";
import { VonageFrameSerializer } from "../src/vonage.ts";
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

async function makeSerializer(rate: number): Promise<VonageFrameSerializer> {
  const serializer = new VonageFrameSerializer();
  await serializer.setup(
    new FrameProcessorSetup({
      clock: new SystemClock(),
      pipelineWorker: null,
      taskManager: null as unknown as BaseTaskManager,
      audioInSampleRate: rate,
    }),
  );
  return serializer;
}

describe("vonage golden vectors: audio", () => {
  for (const c of golden.audio as Any[]) {
    const name = `pipeline ${c.rate} Hz`;
    const resampled = c.rate !== 16000;

    test(`${name}: deserialize binary audio`, async () => {
      const serializer = await makeSerializer(c.rate);
      const chunks: Uint8Array[] = [];
      const ours: (string | null)[] = [];
      for (const hex of c.inbound as string[]) {
        const frame = (await serializer.deserialize(fromHex(hex))) as InputAudioRawFrame | null;
        ours.push(frame ? toHex(frame.audio) : null);
        if (frame) {
          expect(frame.sampleRate).toEqual(c.rate);
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

    test(`${name}: serialize pipeline audio as binary`, async () => {
      const serializer = await makeSerializer(c.rate);
      const pcm = fromHex(c.pipelinePcm);
      const step = ((c.rate * 20) / 1000) * 2;
      const ours: (string | null)[] = [];
      for (let i = 0; i < pcm.length; i += step) {
        const out = await serializer.serialize(
          new OutputAudioRawFrame({
            audio: pcm.slice(i, i + step),
            sampleRate: c.rate,
            numChannels: 1,
          }),
        );
        if (out !== null) expect(out).toBeInstanceOf(Uint8Array);
        ours.push(out === null ? null : toHex(out as Uint8Array));
      }
      if (!resampled) {
        expect(ours).toEqual(c.serialized);
        return;
      }
      const decode = (chunks: (string | null)[]) =>
        int16(concat(chunks.filter((m): m is string => m !== null).map(fromHex)));
      expect(alignedSnr(decode(c.serialized), decode(ours))).toBeGreaterThan(45);
    });
  }
});

describe("vonage golden vectors: events and messages", () => {
  test("deserialize events, with upstream's log lines", async () => {
    const serializer = await makeSerializer(16000);
    const logs: [string, string][] = [];
    const remove = logger.addSink((r: LogRecord) => logs.push([r.level, r.message]));
    try {
      for (const e of golden.events as Any[]) {
        if (e.error) {
          await expect(serializer.deserialize(e.input)).rejects.toThrow(
            "object has no attribute 'get'",
          );
          continue;
        }
        const frame = await serializer.deserialize(e.input);
        if (e.frame === null) {
          expect(frame).toBeNull();
        } else {
          expect(frame).toBeInstanceOf(InputDTMFFrame);
          expect((frame as InputDTMFFrame).button).toEqual(e.frame.button);
        }
      }
    } finally {
      remove();
    }
    expect(logs).toEqual(golden.eventLogs as [string, string][]);
  });

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
