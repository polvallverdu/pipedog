// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Wire compatibility with upstream: replays AudioHook sessions recorded from
 * upstream's GenesysAudioHookSerializer (tools/golden/telephony.py) step by
 * step, and checks every response, frame and state change. The pipeline runs
 * at 8 kHz, so the μ-law audio in both directions is byte-identical.
 */

import { describe, expect, test } from "bun:test";
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
import { type AudioHookChannel, GenesysAudioHookSerializer } from "../src/genesys.ts";
import golden from "./fixtures/golden.json";

type Any = any;

const fromHex = (hex: string) => Uint8Array.from(hex.match(/../g) ?? [], (b) => parseInt(b, 16));
const toHex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

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

/** Upstream's snake_case `create_*` keyword arguments, as our calls. */
function call(s: GenesysAudioHookSerializer, name: string, kwargs: Any): Any {
  if (name === "create_resumed_response") return s.createResumedResponse();
  if (name === "create_error_message") {
    return s.createErrorMessage(kwargs.code, kwargs.message, kwargs.retryable);
  }
  if (name === "create_disconnect_message") {
    return s.createDisconnectMessage({
      reason: kwargs.reason,
      action: kwargs.action,
      outputVariables: kwargs.output_variables,
      info: kwargs.info,
    });
  }
  throw new Error(`no mapping for ${name}`);
}

describe("genesys golden vectors: AudioHook sessions", () => {
  for (const session of golden.sessions as Any[]) {
    test(session.label, async () => {
      const s = new GenesysAudioHookSerializer({
        params: new GenesysAudioHookSerializer.InputParams({
          channel: session.params.channel as AudioHookChannel,
          supportedLanguages: session.params.supported_languages,
          selectedLanguage: session.params.selected_language,
          startPaused: session.params.start_paused,
        }),
      });
      await s.setup(
        new FrameProcessorSetup({
          clock: new SystemClock(),
          pipelineWorker: null,
          taskManager: null as unknown as BaseTaskManager,
          audioInSampleRate: 8000,
        }),
      );
      let opened = false;
      for (const [i, step] of (session.steps as Any[]).entries()) {
        const where = `step ${i}: ${JSON.stringify(step).slice(0, 80)}`;
        if ("in" in step || "in_audio" in step) {
          const data = "in" in step ? step.in : fromHex(step.in_audio);
          if (step.error) {
            await expect(s.deserialize(data), where).rejects.toThrow();
          } else {
            expect(summarize(await s.deserialize(data)), where).toEqual(step.frame);
          }
        } else if ("out_audio" in step || "out_frame" in step) {
          const frame =
            "out_audio" in step
              ? new OutputAudioRawFrame({
                  audio: fromHex(step.out_audio),
                  sampleRate: 8000,
                  numChannels: 1,
                })
              : outFrame(step.out_frame);
          if (step.out !== null && typeof step.out === "object" && step.out.error) {
            await expect(s.serialize(frame), where).rejects.toThrow(
              "object has no attribute 'get'",
            );
          } else {
            const out = await s.serialize(frame);
            const ours = out instanceof Uint8Array ? { hex: toHex(out) } : out;
            expect(ours, where).toEqual(step.out);
          }
        } else if ("set_output_variables" in step) {
          s.setOutputVariables(step.set_output_variables);
        } else if ("call" in step) {
          expect(call(s, step.call, step.kwargs), where).toEqual(step.result);
        }
        if ("in" in step && step.in.includes('"type": "open"')) opened = true;
        // Before the first `open`, the session id is a random UUID.
        const sessionId = opened ? s.sessionId : step.state.session_id;
        expect(s.sessionId).toHaveLength(opened ? s.sessionId.length : 36);
        expect(
          {
            session_id: sessionId,
            conversation_id: s.conversationId,
            is_open: s.isOpen,
            is_paused: s.isPaused,
            participant: s.participant,
            input_variables: s.inputVariables,
            channel: (s as Any)._params.channel,
          },
          where,
        ).toEqual(step.state);
      }
    });
  }
});
