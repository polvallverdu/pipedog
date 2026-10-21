// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// A phone bot on one Twilio Media Streams WebSocket: the caller's μ-law audio
// comes in, OpenAI transcribes it (realtime transcription, with turn detection
// on OpenAI's side), a chat model writes the reply, OpenAI speech speaks it,
// and TwilioFrameSerializer sends it back to the call as μ-law.
//
// No local models (no Silero, no Smart Turn, no ONNX runtime), so the same code
// runs on Deno, Bun, Node and Cloudflare Workers.

import {
  EndWorkerFrame,
  type Frame,
  InputDTMFFrame,
  LLMRunFrame,
} from "@pipedog/core/frames/frames";
import { Pipeline } from "@pipedog/core/pipeline/pipeline";
import { PipelineParams, PipelineWorker } from "@pipedog/core/pipeline/worker";
import { LLMContext } from "@pipedog/core/processors/aggregators/llm_context";
import { LLMContextAggregatorPair } from "@pipedog/core/processors/aggregators/llm_response_universal";
import { type FrameDirection, FrameProcessor } from "@pipedog/core/processors/frame_processor";
import { logger } from "@pipedog/core/utils/logger";
import { WorkerRunner } from "@pipedog/core/workers/runner";
import { OpenAILLMSettings } from "@pipedog/openai/base_llm";
import { OpenAILLMService } from "@pipedog/openai/llm";
import { OpenAIRealtimeSTTService } from "@pipedog/openai/stt";
import { OpenAITTSService } from "@pipedog/openai/tts";
import { telephonyHandshake } from "@pipedog/runner/utils";
import { TwilioFrameSerializer } from "@pipedog/serializer-twilio/twilio";
import {
  FastAPIWebsocketParams,
  FastAPIWebsocketTransport,
} from "@pipedog/transport-websocket/fastapi";
import type { WebsocketConnection } from "@pipedog/transport-websocket/socket";

export const SYSTEM_INSTRUCTION =
  "You are a helpful assistant on a phone call. Your responses will be spoken aloud, so avoid emojis, bullet points, or other formatting that can't be spoken. Respond to what the caller said in a creative, helpful, and brief way.";

/**
 * The pipeline's rates. Twilio's 8 kHz μ-law is resampled to 16 kHz on the way
 * in, and OpenAI's 24 kHz speech down to 8 kHz on the way out, by the serializer.
 */
const INPUT_SAMPLE_RATE = 16000;
const OUTPUT_SAMPLE_RATE = 24000;

export interface PhoneBotOptions {
  /** OpenAI API key. */
  openaiApiKey: string;
  /** An OpenAI-compatible API base URL (chat and speech). */
  openaiBaseUrl?: string | null;
  /** The realtime transcription WebSocket URL. */
  openaiRealtimeUrl?: string | null;
  /**
   * Twilio account SID and auth token. With both, the serializer hangs up the
   * call through Twilio's REST API when the pipeline ends; without, the call is
   * left to the caller.
   */
  twilioAccountSid?: string | null;
  twilioAuthToken?: string | null;
  /** Base URL of Twilio's REST API (for a Twilio-compatible backend or a test double). */
  twilioApiBaseUrl?: string | null;
}

/**
 * Ends the call when the caller presses `#`: the pipeline ends gracefully
 * (queued speech is flushed first), and the serializer hangs up the call
 * through Twilio's REST API.
 */
export class HangUpOnPound extends FrameProcessor {
  override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
    await super.processFrame(frame, direction);
    if (frame instanceof InputDTMFFrame && frame.button === "#") {
      await this.pushFrame(new EndWorkerFrame({ reason: "caller pressed #" }));
    }
    await this.pushFrame(frame, direction);
  }
}

/** Answers one call on `connection` and returns when the call ends. */
export async function runPhoneBot(
  connection: WebsocketConnection,
  options: PhoneBotOptions,
): Promise<void> {
  // Twilio sends `connected`, then `start` with the stream and call SIDs and
  // the TwiML <Parameter>s (here the caller's and the dialed numbers).
  const handshake = await telephonyHandshake(connection);
  if (handshake.status === "closed") {
    logger.info("The caller hung up before the media stream started");
    return;
  }
  if (handshake.status !== "started" || handshake.transportType !== "twilio") {
    logger.error("Not a Twilio media stream");
    return;
  }
  const { callData } = handshake;
  if (!callData.streamId) {
    logger.error("Twilio's start message has no streamSid");
    return;
  }
  logger.info(`Call ${callData.callId} from ${callData.fromNumber} to ${callData.toNumber}`);

  const canHangUp = Boolean(options.twilioAccountSid && options.twilioAuthToken);
  const serializer = new TwilioFrameSerializer({
    streamSid: callData.streamId,
    callSid: callData.callId,
    accountSid: options.twilioAccountSid,
    authToken: options.twilioAuthToken,
    baseUrl: options.twilioApiBaseUrl,
    params: new TwilioFrameSerializer.InputParams({ autoHangUp: canHangUp }),
  });

  const transport = new FastAPIWebsocketTransport(
    connection,
    new FastAPIWebsocketParams({
      audioInEnabled: true,
      audioOutEnabled: true,
      // Twilio takes raw μ-law, no WAV header.
      addWavHeader: false,
      serializer,
    }),
  );

  const apiKey = options.openaiApiKey;
  const baseUrl = options.openaiBaseUrl ?? null;

  // OpenAI detects when the caller starts and stops speaking. With no VAD
  // analyzer, the user aggregator follows the service's turn signals.
  const stt = new OpenAIRealtimeSTTService({
    apiKey,
    baseUrl: options.openaiRealtimeUrl ?? undefined,
    turnDetection: { type: "server_vad" },
  });

  const context = new LLMContext();
  const aggregators = new LLMContextAggregatorPair(context);

  const pipeline = new Pipeline([
    transport.input(),
    new HangUpOnPound(),
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

  const runner = new WorkerRunner({ handleSigint: false, handleSigterm: false });
  await runner.addWorkers(worker);

  transport.eventHandler("on_client_connected", async () => {
    // Greet the caller.
    context.addMessage({ role: "developer", content: "Please introduce yourself to the caller." });
    await worker.queueFrames([new LLMRunFrame()]);
  });
  transport.eventHandler("on_client_disconnected", async () => {
    // The caller hung up (Twilio sends `stop` and closes the socket).
    await runner.cancel();
  });

  await runner.run();
}
