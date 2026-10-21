// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Runtime smoke test for tools/compat: replays the AudioHook sessions recorded
// from upstream (test/fixtures/golden.json) on each runtime: the protocol
// responses (opened, pong, closed, disconnect, barge-in), DTMF, pause, and
// μ-law audio both ways at 8 kHz, byte-exact. Also resamples one chunk to a
// 16 kHz pipeline (core's WASM resampler, which Workers must load as a module).

import { SystemClock } from "@pipedog/core/clocks/system_clock";
import {
  CancelFrame,
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

import { type AudioHookChannel, GenesysAudioHookSerializer } from "../src/genesys.ts";
import golden from "../test/fixtures/golden.json" with { type: "json" };

type Any = any;

const fromHex = (hex: string) => Uint8Array.from(hex.match(/../g) ?? [], (b) => parseInt(b, 16));
const toHex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

function check(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(`serializer-genesys smoke: ${message}`);
}

/** Key order matters on the wire, so compare serialized JSON. */
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function summarize(frame: Frame | null): Any {
  if (frame === null) return null;
  if (frame instanceof InputDTMFFrame) return { type: "InputDTMFFrame", button: frame.button };
  if (frame instanceof InputAudioRawFrame) {
    return { type: "InputAudioRawFrame", hex: toHex(frame.audio), sample_rate: frame.sampleRate };
  }
  if (frame instanceof OutputTransportMessageUrgentFrame) {
    return { type: "OutputTransportMessageUrgentFrame", message: frame.message };
  }
  return { type: frame.constructor.name };
}

function outFrame(spec: Any): Frame {
  if (spec.kind === "interruption") return new InterruptionFrame();
  if (spec.kind === "end") return new EndFrame();
  if (spec.kind === "cancel") return new CancelFrame();
  if (spec.kind === "message") return new OutputTransportMessageFrame({ message: spec.message });
  return new OutputTransportMessageUrgentFrame({ message: spec.message });
}

async function makeSerializer(params: Any, rate: number): Promise<GenesysAudioHookSerializer> {
  const s = new GenesysAudioHookSerializer({
    params: new GenesysAudioHookSerializer.InputParams({
      channel: params.channel as AudioHookChannel,
      supportedLanguages: params.supported_languages,
      selectedLanguage: params.selected_language,
      startPaused: params.start_paused,
    }),
  });
  await s.setup(
    new FrameProcessorSetup({
      clock: new SystemClock(),
      pipelineWorker: null,
      taskManager: null as unknown as BaseTaskManager,
      audioInSampleRate: rate,
    }),
  );
  return s;
}

async function sessions(): Promise<void> {
  for (const session of golden.sessions as Any[]) {
    const s = await makeSerializer(session.params, 8000);
    for (const [i, step] of (session.steps as Any[]).entries()) {
      const where = `${session.label} step ${i}`;
      if (("in" in step || "in_audio" in step) && !step.error) {
        const data = "in" in step ? step.in : fromHex(step.in_audio);
        check(same(summarize(await s.deserialize(data)), step.frame), where);
      } else if ("out_audio" in step || "out_frame" in step) {
        if (step.out !== null && typeof step.out === "object" && step.out.error) continue;
        const frame =
          "out_audio" in step
            ? new OutputAudioRawFrame({
                audio: fromHex(step.out_audio),
                sampleRate: 8000,
                numChannels: 1,
              })
            : outFrame(step.out_frame);
        const out = await s.serialize(frame);
        check(same(out instanceof Uint8Array ? { hex: toHex(out) } : out, step.out), where);
      } else if ("set_output_variables" in step) {
        s.setOutputVariables(step.set_output_variables);
      } else if ("call" in step) {
        const k = step.kwargs;
        const result =
          step.call === "create_resumed_response"
            ? s.createResumedResponse()
            : step.call === "create_error_message"
              ? s.createErrorMessage(k.code, k.message, k.retryable)
              : s.createDisconnectMessage({
                  reason: k.reason,
                  action: k.action,
                  outputVariables: k.output_variables,
                  info: k.info,
                });
        check(same(result, step.result), where);
      }
    }
  }
}

async function resampled(): Promise<void> {
  const session = (golden.sessions as Any[])[0];
  const s = await makeSerializer(session.params, 16000);
  const open = session.steps.find((step: Any) => "in" in step && step.in.includes('"open"'));
  await s.deserialize(open.in);
  const audio = session.steps.find((step: Any) => "in_audio" in step).in_audio;
  let samples = 0;
  for (let k = 0; k < 5; k++) {
    const frame = await s.deserialize(fromHex(audio));
    if (frame) {
      check(frame instanceof InputAudioRawFrame && frame.sampleRate === 16000, "16 kHz rate");
      samples += frame.audio.length / 2;
    }
  }
  const expected = 5 * (audio.length / 2) * 2;
  check(samples > expected * 0.8 && samples <= expected, `${samples} samples resampled`);
}

export default async function smoke(): Promise<void> {
  logger.setLevel("CRITICAL");
  await sessions();
  await resampled();
}
