// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// A voice assistant over a WebSocket: the user's speech arrives as protobuf
// frames (the format @pipecat-ai/websocket-transport speaks), goes to a
// speech-to-text service, a chat model writes a reply, and a speech synthesis
// service speaks it back. The same bot as examples/smallwebrtc-voice-bot, with
// the transport swapped. The services are OpenAI's, or Google Gemini's, chosen
// by `provider`.

import { SileroVADAnalyzer } from "@pipedog/audio-silero";
import { LLMRunFrame } from "@pipedog/core/frames/frames";
import { Pipeline } from "@pipedog/core/pipeline/pipeline";
import { PipelineParams, PipelineWorker } from "@pipedog/core/pipeline/worker";
import { LLMContext } from "@pipedog/core/processors/aggregators/llm_context";
import {
  LLMContextAggregatorPair,
  LLMUserAggregatorParams,
} from "@pipedog/core/processors/aggregators/llm_response_universal";
import { WorkerRunner } from "@pipedog/core/workers/runner";
import { GeminiSTTService } from "@pipedog/google/gemini_live/stt";
import { GoogleLLMService, GoogleLLMSettings } from "@pipedog/google/llm";
import { GeminiTTSService } from "@pipedog/google/tts";
import { OpenAILLMSettings } from "@pipedog/openai/base_llm";
import { OpenAILLMService } from "@pipedog/openai/llm";
import { OpenAISTTService } from "@pipedog/openai/stt";
import { OpenAITTSService } from "@pipedog/openai/tts";
import { ProtobufFrameSerializer } from "@pipedog/serializer-protobuf/protobuf";
import {
  FastAPIWebsocketParams,
  FastAPIWebsocketTransport,
} from "@pipedog/transport-websocket/fastapi";
import type { WebsocketConnection } from "@pipedog/transport-websocket/socket";
import { reportErrors, startTracing } from "./observability.ts";

export const SYSTEM_INSTRUCTION =
  "You are a helpful assistant in a voice conversation. Your responses will be spoken aloud, so avoid emojis, bullet points, or other formatting that can't be spoken. Respond to what the user said in a creative, helpful, and brief way.";

/** Input audio from the browser is 16 kHz (the client's `recorderSampleRate`). */
const INPUT_SAMPLE_RATE = 16000;
/** Both providers' speech synthesis returns 24 kHz PCM. */
const OUTPUT_SAMPLE_RATE = 24000;

export type VoiceProvider = "openai" | "google";

export interface VoiceBotOptions {
  /** Which services to use: OpenAI (default) or Google Gemini. */
  provider?: VoiceProvider;
  /**
   * API key. Defaults to `OPENAI_API_KEY` or `GOOGLE_API_KEY`, depending on the
   * provider.
   */
  apiKey?: string;
  /**
   * Base URL of the provider's API. Defaults to `OPENAI_BASE_URL` for OpenAI, and
   * to Google's own endpoint for Gemini.
   */
  baseUrl?: string;
}

/** Speech-to-text, chat and speech synthesis services for one provider. */
function createServices(options: VoiceBotOptions) {
  if (options.provider === "google") {
    const apiKey = options.apiKey ?? process.env.GOOGLE_API_KEY ?? "";
    const httpOptions = options.baseUrl ? { baseUrl: options.baseUrl } : null;
    return {
      stt: new GeminiSTTService({ apiKey, httpOptions }),
      llm: new GoogleLLMService({
        apiKey,
        httpOptions,
        settings: new GoogleLLMSettings({ systemInstruction: SYSTEM_INSTRUCTION }),
      }),
      tts: new GeminiTTSService({ apiKey, httpOptions, sampleRate: OUTPUT_SAMPLE_RATE }),
    };
  }

  const apiKey = options.apiKey ?? process.env.OPENAI_API_KEY ?? null;
  const baseUrl = options.baseUrl ?? process.env.OPENAI_BASE_URL ?? null;
  return {
    stt: new OpenAISTTService({ apiKey, baseUrl }),
    llm: new OpenAILLMService({
      apiKey,
      baseUrl,
      settings: new OpenAILLMSettings({ systemInstruction: SYSTEM_INSTRUCTION }),
    }),
    tts: new OpenAITTSService({ apiKey, baseUrl, sampleRate: OUTPUT_SAMPLE_RATE }),
  };
}

/** Runs one voice conversation over `connection`, until the client disconnects. */
export async function runVoiceBot(
  connection: WebsocketConnection,
  options: VoiceBotOptions = {},
): Promise<void> {
  // Audio and RTVI messages travel as protobuf frames, both ways.
  const transport = new FastAPIWebsocketTransport(
    connection,
    new FastAPIWebsocketParams({
      audioInEnabled: true,
      audioOutEnabled: true,
      serializer: new ProtobufFrameSerializer(),
    }),
  );

  const { stt, llm, tts } = createServices(options);

  const context = new LLMContext();
  // Silero detects speech; the default turn strategies end the turn with Smart
  // Turn (from @pipedog/audio-smart-turn).
  const aggregators = new LLMContextAggregatorPair(context, {
    userParams: new LLMUserAggregatorParams({ vadAnalyzer: new SileroVADAnalyzer() }),
  });

  const pipeline = new Pipeline([
    transport.input(),
    stt,
    aggregators.user(),
    llm,
    tts,
    transport.output(),
    aggregators.assistant(),
  ]);

  const conversationId = crypto.randomUUID();
  const worker = new PipelineWorker(pipeline, {
    cancelOnIdleTimeout: false,
    // Traced when OTEL_EXPORTER_OTLP_ENDPOINT is set; see observability.ts.
    enableTracing: startTracing(),
    conversationId,
    params: new PipelineParams({
      audioInSampleRate: INPUT_SAMPLE_RATE,
      audioOutSampleRate: OUTPUT_SAMPLE_RATE,
      enableMetrics: true,
      enableUsageMetrics: true,
    }),
  });

  reportErrors(worker, conversationId);

  const runner = new WorkerRunner({ handleSigint: false, handleSigterm: false });
  await runner.addWorkers(worker);

  transport.eventHandler("on_client_connected", async () => {
    // Kick off the conversation.
    context.addMessage({
      role: "developer",
      content: "Please introduce yourself to the user.",
    });
    await worker.queueFrames([new LLMRunFrame()]);
  });
  transport.eventHandler("on_client_disconnected", async () => {
    await runner.cancel();
  });

  await runner.run();
}
