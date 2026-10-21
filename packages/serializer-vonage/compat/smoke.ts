// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Runtime smoke test for tools/compat: replays the upstream golden vectors
// (test/fixtures/golden.json) on each runtime: 16 kHz binary PCM byte-exact,
// resampling to and from the pipeline rate (core's WASM resampler, which
// Workers must load as a module), JSON events, and transport messages.

import { SystemClock } from "@pipedog/core/clocks/system_clock";
import {
  type Frame,
  InputAudioRawFrame,
  InputDTMFFrame,
  InterruptionFrame,
  OutputAudioRawFrame,
  OutputTransportMessageFrame,
  OutputTransportMessageUrgentFrame,
} from "@pipedog/core/frames/frames";
import { FrameProcessorSetup } from "@pipedog/core/processors/frame_processor";
import type { BaseTaskManager } from "@pipedog/core/utils/asyncio/task_manager";
import { logger } from "@pipedog/core/utils/logger";

import { VonageFrameSerializer } from "../src/vonage.ts";
import golden from "../test/fixtures/golden.json" with { type: "json" };

type Any = any;

const fromHex = (hex: string) => Uint8Array.from(hex.match(/../g) ?? [], (b) => parseInt(b, 16));
const toHex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

function check(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(`serializer-vonage smoke: ${message}`);
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

async function audio(): Promise<void> {
  for (const c of golden.audio as Any[]) {
    const name = `pipeline ${c.rate} Hz`;
    const serializer = await makeSerializer(c.rate);
    let samples = 0;
    for (const [k, hex] of (c.inbound as string[]).entries()) {
      const frame = await serializer.deserialize(fromHex(hex));
      if (c.rate === 16000) {
        check(
          (frame ? toHex((frame as InputAudioRawFrame).audio) : null) === c.deserialized[k],
          `${name}: decoded chunk ${k}`,
        );
      }
      if (frame) {
        check(frame instanceof InputAudioRawFrame && frame.sampleRate === c.rate, `${name}: rate`);
        samples += frame.audio.length / 2;
      }
    }
    const expected = (c.inbound.length * 320 * c.rate) / 16000;
    check(samples > expected * 0.8 && samples <= expected, `${name}: ${samples} samples decoded`);
    if (c.rate === 16000) {
      const pcm = fromHex(c.pipelinePcm);
      for (let i = 0, k = 0; i < pcm.length; i += 640, k++) {
        const out = await serializer.serialize(
          new OutputAudioRawFrame({
            audio: pcm.slice(i, i + 640),
            sampleRate: 16000,
            numChannels: 1,
          }),
        );
        check(
          out instanceof Uint8Array && toHex(out) === c.serialized[k],
          `${name}: binary audio ${k}`,
        );
      }
    }
  }
}

async function events(): Promise<void> {
  const serializer = await makeSerializer(16000);
  for (const e of golden.events as Any[]) {
    if (e.error) continue;
    const frame = await serializer.deserialize(e.input);
    if (e.frame === null) check(frame === null, `event ${e.input} should be ignored`);
    else
      check(
        frame instanceof InputDTMFFrame && frame.button === e.frame.button,
        `event ${e.input}: DTMF`,
      );
  }
  for (const { input, out } of golden.serializeMisc as Any[]) {
    if ((out !== null && typeof out === "object") || input.kind === "end") continue;
    let frame: Frame;
    if (input.kind === "interruption") frame = new InterruptionFrame();
    else if (input.kind === "message")
      frame = new OutputTransportMessageFrame({ message: input.message });
    else frame = new OutputTransportMessageUrgentFrame({ message: input.message });
    const got = await serializer.serialize(frame);
    check(got === out, `serialize ${input.kind}: ${got} != ${out}`);
  }
}

export default async function smoke(): Promise<void> {
  logger.setLevel("CRITICAL");
  await audio();
  await events();
}
