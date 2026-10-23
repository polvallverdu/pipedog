// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// The voice agent: the user's audio from Cloudflare Realtime, OpenAI realtime transcription,
// chat and speech synthesis, and the bot's audio back to Cloudflare Realtime.
//
// Turn detection runs on OpenAI's side (server VAD), so the Worker loads no local models, as in
// the workers-durable-voice-agent example.

import { LLMRunFrame } from "@pipedog/core/frames/frames";
import { Pipeline } from "@pipedog/core/pipeline/pipeline";
import { PipelineParams, PipelineWorker } from "@pipedog/core/pipeline/worker";
import { LLMContext } from "@pipedog/core/processors/aggregators/llm_context";
import { LLMContextAggregatorPair } from "@pipedog/core/processors/aggregators/llm_response_universal";
import { WorkerRunner } from "@pipedog/core/workers/runner";
import { OpenAILLMSettings } from "@pipedog/openai/base_llm";
import { OpenAILLMService } from "@pipedog/openai/llm";
import { OpenAIRealtimeSTTService } from "@pipedog/openai/stt";
import { OpenAITTSService } from "@pipedog/openai/tts";
import type { CloudflareRealtimeTransport } from "@pipedog/transport-cloudflare-realtime/transport";
import type { Env } from "./worker.ts";

export const SYSTEM_INSTRUCTION =
  "You are a helpful assistant in a voice conversation. Your responses will be spoken aloud, so avoid emojis, bullet points, or other formatting that can't be spoken. Respond to what the user said in a creative, helpful, and brief way.";

/** OpenAI's transcription takes 16 kHz; its speech comes at 24 kHz. The transport converts. */
const INPUT_SAMPLE_RATE = 16000;
const OUTPUT_SAMPLE_RATE = 24000;

/** A running voice agent. */
export interface VoiceAgent {
  /** Settles when the agent has stopped. */
  done: Promise<void>;
  /** Stop the agent. */
  stop(): Promise<void>;
}

/**
 * Starts one voice agent on `transport`. It runs until the user leaves or `stop()` is called.
 *
 * The bot greets the user once their browser reports, with RTVI's `client-ready` on the messages
 * socket, that it is playing the bot's track: audio sent earlier would go unheard.
 */
export function startVoiceAgent(transport: CloudflareRealtimeTransport, env: Env): VoiceAgent {
  const runner = new WorkerRunner({ handleSigint: false, handleSigterm: false });
  const done = runVoiceAgent(transport, env, runner);
  return { done, stop: () => runner.cancel() };
}

async function runVoiceAgent(
  transport: CloudflareRealtimeTransport,
  env: Env,
  runner: WorkerRunner,
): Promise<void> {
  const apiKey = env.OPENAI_API_KEY;
  const baseUrl = env.OPENAI_BASE_URL ?? null;

  const stt = new OpenAIRealtimeSTTService({
    apiKey,
    baseUrl: env.OPENAI_REALTIME_URL,
    turnDetection: { type: "server_vad" },
  });
  const context = new LLMContext();
  const aggregators = new LLMContextAggregatorPair(context);

  const pipeline = new Pipeline([
    transport.input(),
    stt,
    aggregators.user(),
    new OpenAILLMService({
      apiKey,
      baseUrl,
      settings: new OpenAILLMSettings({ systemInstruction: SYSTEM_INSTRUCTION }),
    }),
    new OpenAITTSService({ apiKey, baseUrl, sampleRate: OUTPUT_SAMPLE_RATE }),
    transport.output(),
    aggregators.assistant(),
  ]);

  const worker = new PipelineWorker(pipeline, {
    cancelOnIdleTimeout: false,
    params: new PipelineParams({
      audioInSampleRate: INPUT_SAMPLE_RATE,
      audioOutSampleRate: OUTPUT_SAMPLE_RATE,
    }),
  });

  await runner.addWorkers(worker);

  // RTVI is on by default; its messages travel over the transport's messages socket.
  worker.rtvi.eventHandler("on_client_ready", async () => {
    context.addMessage({ role: "developer", content: "Please introduce yourself to the user." });
    await worker.queueFrames([new LLMRunFrame()]);
  });
  transport.eventHandler("on_client_disconnected", async () => {
    await runner.cancel();
  });

  await runner.run();
}
