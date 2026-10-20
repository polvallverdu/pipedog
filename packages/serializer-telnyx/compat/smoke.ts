// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Runtime smoke test for tools/compat: replays the upstream golden vectors
// (test/fixtures/golden.json) on each runtime: 8 kHz PCMU/PCMA byte-exact,
// resampling to and from the pipeline rate (core's WASM resampler, which
// Workers must load as a module), DTMF and other events, transport messages,
// and the hang-up REST call through a stand-in `fetch`.

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

import { TelnyxFrameSerializer } from "../src/telnyx.ts";
import golden from "../test/fixtures/golden.json" with { type: "json" };

type Any = any;

const fromHex = (hex: string) => Uint8Array.from(hex.match(/../g) ?? [], (b) => parseInt(b, 16));
const toHex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

function check(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(`serializer-telnyx smoke: ${message}`);
}

async function makeSerializer(encoding: string, rate: number): Promise<TelnyxFrameSerializer> {
  const serializer = new TelnyxFrameSerializer({
    streamId: "s",
    outboundEncoding: encoding,
    inboundEncoding: encoding,
    params: new TelnyxFrameSerializer.InputParams({ autoHangUp: false }),
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

async function audio(): Promise<void> {
  for (const c of golden.audio as Any[]) {
    const name = `${c.encoding} @ ${c.rate} Hz`;
    // Encode the 8 kHz source: byte-identical to upstream.
    const encoder = await makeSerializer(c.encoding, 8000);
    const src = fromHex(c.source8k);
    for (let i = 0, k = 0; i < src.length; i += 320, k++) {
      const out = await encoder.serialize(
        new OutputAudioRawFrame({ audio: src.slice(i, i + 320), sampleRate: 8000, numChannels: 1 }),
      );
      check(out === c.mediaMessages[k], `${name}: media message ${k}`);
    }
    // Decode the media events to the pipeline rate.
    const serializer = await makeSerializer(c.encoding, c.rate);
    let samples = 0;
    for (const [k, message] of (c.mediaMessages as string[]).entries()) {
      const frame = await serializer.deserialize(message);
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
    // Encode pipeline-rate audio back to 8 kHz.
    const pcm = fromHex(c.pipelinePcm);
    const step = ((c.rate * 20) / 1000) * 2;
    let encoded = 0;
    for (let i = 0; i < pcm.length; i += step) {
      const out = await serializer.serialize(
        new OutputAudioRawFrame({
          audio: pcm.slice(i, i + step),
          sampleRate: c.rate,
          numChannels: 1,
        }),
      );
      if (out !== null) encoded += atob(JSON.parse(out as string).media.payload).length;
    }
    const expectedOut = (pcm.length / 2) * (8000 / c.rate);
    check(
      encoded > expectedOut * 0.8 && encoded <= expectedOut,
      `${name}: ${encoded} bytes encoded`,
    );
  }
}

async function events(): Promise<void> {
  const serializer = await makeSerializer("PCMU", 16000);
  for (const { input, frame: expected } of golden.events as Any[]) {
    const frame = await serializer.deserialize(input);
    if (expected === null) {
      check(frame === null, `event ${input} should be ignored`);
    } else if (expected.type === "InputDTMFFrame") {
      check(
        frame instanceof InputDTMFFrame && frame.button === expected.button,
        `event ${input}: DTMF`,
      );
    } else {
      check(frame instanceof InputAudioRawFrame, `event ${input}: ${expected.type}`);
    }
  }
  for (const { input, out } of golden.serializeMisc as Any[]) {
    // Upstream raises for these (see test/golden.test.ts).
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
    return new Response(want.responseBody, { status: want.status });
  }) as typeof fetch;
  try {
    const serializer = new TelnyxFrameSerializer({
      streamId: "s",
      outboundEncoding: "PCMU",
      inboundEncoding: "PCMU",
      callControlId: "v3:call/ctrl id",
      apiKey: "KEY_123",
    });
    check((await serializer.serialize(new EndFrame())) === null, "EndFrame serializes to null");
  } finally {
    globalThis.fetch = realFetch;
  }
  const req = captured as { url: string; method: string; headers: Headers } | null;
  check(req !== null, "no hang-up request");
  check(req.method === want.request.method, `hang-up method ${req.method}`);
  check(new URL(req.url).pathname === want.request.path, `hang-up path ${req.url}`);
  for (const name of ["content-type", "authorization"]) {
    check(req.headers.get(name) === want.request.headers[name], `hang-up header ${name}`);
  }
}

export default async function smoke(): Promise<void> {
  logger.setLevel("CRITICAL");
  await audio();
  await events();
  await hangUp();
}
