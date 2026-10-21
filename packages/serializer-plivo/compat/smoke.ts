// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Runtime smoke test for tools/compat: replays the upstream golden vectors
// (test/fixtures/golden.json) on each runtime: 8 kHz μ-law byte-exact,
// resampling to the pipeline rate (core's WASM resampler, which Workers must
// load as a module), DTMF and other events, transport messages, and the
// hang-up REST call through a stand-in `fetch`.

import { SystemClock } from "@pipedog/core/clocks/system_clock";
import {
  EndFrame,
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

import { PlivoFrameSerializer } from "../src/plivo.ts";
import golden from "../test/fixtures/golden.json" with { type: "json" };

type Any = any;

const fromHex = (hex: string) => Uint8Array.from(hex.match(/../g) ?? [], (b) => parseInt(b, 16));
const toHex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

function check(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(`serializer-plivo smoke: ${message}`);
}

async function makeSerializer(rate: number): Promise<PlivoFrameSerializer> {
  const serializer = new PlivoFrameSerializer({
    streamId: "stream-1",
    params: new PlivoFrameSerializer.InputParams({ autoHangUp: false }),
  });
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

const asMedia = (playAudio: string) =>
  JSON.stringify({ event: "media", media: { payload: JSON.parse(playAudio).media.payload } });

async function audio(): Promise<void> {
  for (const c of golden.audio as Any[]) {
    const name = `pipeline ${c.rate} Hz`;
    const encoder = await makeSerializer(8000);
    const src = fromHex(c.source8k);
    for (let i = 0, k = 0; i < src.length; i += 320, k++) {
      const out = await encoder.serialize(
        new OutputAudioRawFrame({ audio: src.slice(i, i + 320), sampleRate: 8000, numChannels: 1 }),
      );
      check(out === c.mediaMessages[k], `${name}: playAudio message ${k}`);
    }
    const serializer = await makeSerializer(c.rate);
    let samples = 0;
    for (const [k, message] of (c.mediaMessages as string[]).entries()) {
      const frame = await serializer.deserialize(asMedia(message));
      if (c.rate === 8000) {
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
    const expected = (c.mediaMessages.length * 160 * c.rate) / 8000;
    check(samples > expected * 0.8 && samples <= expected, `${name}: ${samples} samples decoded`);
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
    if (out !== null && typeof out === "object") continue;
    let frame: Frame;
    if (input.kind === "interruption") frame = new InterruptionFrame();
    else if (input.kind === "end") frame = new EndFrame();
    else if (input.kind === "message")
      frame = new OutputTransportMessageFrame({ message: input.message });
    else frame = new OutputTransportMessageUrgentFrame({ message: input.message });
    const got = await serializer.serialize(frame);
    check(got === out, `serialize ${input.kind}: ${got} != ${out}`);
  }
}

async function hangUp(): Promise<void> {
  const want = (golden.hangup as Any[])[0];
  const realFetch = globalThis.fetch;
  let captured: { url: string; method: string; headers: Headers } | null = null;
  globalThis.fetch = (async (input: Any, init?: Any) => {
    captured = {
      url: String(input),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
    };
    return new Response(null, { status: 204 });
  }) as typeof fetch;
  try {
    const serializer = new PlivoFrameSerializer({
      streamId: "stream-1",
      callId: "call/1 x",
      authId: "MA_AUTH",
      authToken: "tok:en",
    });
    check((await serializer.serialize(new EndFrame())) === null, "EndFrame serializes to null");
  } finally {
    globalThis.fetch = realFetch;
  }
  const req = captured as { url: string; method: string; headers: Headers } | null;
  check(req !== null, "no hang-up request");
  check(req.method === want.request.method, `hang-up method ${req.method}`);
  check(new URL(req.url).pathname === want.request.path, `hang-up path ${req.url}`);
  check(
    req.headers.get("authorization") === want.request.headers.authorization,
    "hang-up authorization",
  );
}

export default async function smoke(): Promise<void> {
  logger.setLevel("CRITICAL");
  await audio();
  await events();
  await hangUp();
}
