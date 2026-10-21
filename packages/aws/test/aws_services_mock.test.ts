// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

// Mock tests for the Transcribe STT, Polly TTS and AgentCore services: a fake
// Transcribe WebSocket server (`Bun.serve`) and fake `fetch` functions stand in
// for AWS, so no network or keys are needed.

import { describe, expect, test } from "bun:test";
import {
  type Frame,
  InputAudioRawFrame,
  InterimTranscriptionFrame,
  LLMContextFrame,
  LLMFullResponseEndFrame,
  LLMFullResponseStartFrame,
  LLMTextFrame,
  TranscriptionFrame,
  TTSAudioRawFrame,
  TTSSpeakFrame,
} from "@pipedog/core/frames/frames";
import { LLMContext } from "@pipedog/core/processors/aggregators/llm_context";
import { runTest, SleepFrame } from "@pipedog/core/tests/utils";
import { Language } from "@pipedog/core/transcriptions/language";
import { AWSAgentCoreProcessor, defaultContextToPayloadTransformer } from "../src/agent_core.ts";
import { decodeEventStreamMessage, encodeEventStreamMessage } from "../src/event_stream.ts";
import { AWSTranscribeSTTService } from "../src/stt.ts";
import { AWSPollyTTSService, AWSPollyTTSSettings } from "../src/tts.ts";

type Any = any;

const KEYS = { awsAccessKeyId: "AKIDTEST", apiKey: "SECRET", awsSessionToken: "TOKEN" };

function transcriptEvent(transcript: string, isPartial: boolean): Uint8Array {
  return encodeEventStreamMessage({
    headers: {
      ":message-type": "event",
      ":event-type": "TranscriptEvent",
      ":content-type": "application/json",
    },
    body: new TextEncoder().encode(
      JSON.stringify({
        Transcript: {
          Results: [
            {
              ResultId: "r1",
              IsPartial: isPartial,
              Alternatives: [{ Transcript: transcript, Items: [] }],
            },
          ],
        },
      }),
    ),
  });
}

describe("AWSTranscribeSTTService", () => {
  test("streams audio events and pushes transcripts", async () => {
    const received: {
      url: string | null;
      protocol: string | null;
      audio: Uint8Array[];
      text: string[];
    } = { url: null, protocol: null, audio: [], text: [] };
    let replied = false;
    const server = Bun.serve({
      port: 0,
      fetch(request, srv) {
        received.url = request.url;
        received.protocol = request.headers.get("sec-websocket-protocol");
        if (srv.upgrade(request, { headers: { "Sec-WebSocket-Protocol": "mqtt" } })) return;
        return new Response("upgrade required", { status: 426 });
      },
      websocket: {
        message(ws, message) {
          if (typeof message === "string") {
            received.text.push(message);
            return;
          }
          const decoded = decodeEventStreamMessage(new Uint8Array(message));
          expect(decoded.headers[":event-type"]).toEqual({ type: "string", value: "AudioEvent" });
          received.audio.push(decoded.body);
          if (!replied) {
            replied = true;
            ws.send(transcriptEvent("hello", true));
            ws.send(transcriptEvent("hello world", false));
          }
        },
      },
    });

    let down: Frame[];
    try {
      const stt = new AWSTranscribeSTTService({
        ...KEYS,
        region: "eu-west-1",
        endpointUrl: `ws://127.0.0.1:${server.port}`,
        settings: new AWSTranscribeSTTService.Settings({ language: Language.EN_GB }),
      });
      const pcm = new Uint8Array(640).fill(1);
      [down] = await runTest(stt, {
        framesToSend: [
          new InputAudioRawFrame({ audio: pcm, sampleRate: 16000, numChannels: 1 }),
          new SleepFrame({ sleep: 0.2 }),
        ],
      });
    } finally {
      server.stop(true);
    }

    const url = new URL(received.url as string);
    expect(url.pathname).toEqual("/stream-transcription-websocket");
    expect(url.searchParams.get("language-code")).toEqual("en-GB");
    expect(url.searchParams.get("media-encoding")).toEqual("pcm");
    expect(url.searchParams.get("sample-rate")).toEqual("16000");
    expect(url.searchParams.get("partial-results-stability")).toEqual("high");
    expect(url.searchParams.get("X-Amz-Security-Token")).toEqual("TOKEN");
    expect(url.searchParams.get("X-Amz-Credential")).toStartWith("AKIDTEST/");
    expect(url.searchParams.get("X-Amz-Credential")).toContain(
      "/eu-west-1/transcribe/aws4_request",
    );
    expect(url.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
    expect(received.protocol).toEqual("mqtt");
    expect(received.audio[0]).toEqual(new Uint8Array(640).fill(1));
    expect(received.text).toContain('{"message-type": "event", "event": "end"}');

    const interim = down.filter((f) => f instanceof InterimTranscriptionFrame) as Any[];
    const finals = down.filter((f) => f instanceof TranscriptionFrame) as Any[];
    expect(interim.map((f) => f.text)).toEqual(["hello"]);
    expect(finals.map((f) => f.text)).toEqual(["hello world"]);
    expect(finals[0].language).toEqual("en-GB");
    expect(finals[0].result.ResultId).toEqual("r1");
  });
});

describe("AWSPollyTTSService", () => {
  test("synthesizes with a signed request and yields audio frames", async () => {
    const calls: { url: string; headers: Headers; body: Record<string, unknown> }[] = [];
    const audio = new Uint8Array(3200);
    for (let i = 0; i < audio.length; i++) audio[i] = i % 251;
    const fakeFetch = async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: String(input),
        headers: new Headers(init?.headers),
        body: JSON.parse(String(init?.body)),
      });
      return new Response(audio, { headers: { "Content-Type": "audio/pcm" } });
    };

    const tts = new AWSPollyTTSService({
      ...KEYS,
      region: "us-west-2",
      sampleRate: 16000,
      fetch: fakeFetch,
      settings: new AWSPollyTTSSettings({ voice: "Matthew", engine: "neural", rate: "fast" }),
    });
    const [down] = await runTest(tts, {
      framesToSend: [new TTSSpeakFrame({ text: "Fish & chips <now>" })],
    });

    expect(calls).toHaveLength(1);
    const call = calls[0] as (typeof calls)[number];
    expect(call.url).toEqual("https://polly.us-west-2.amazonaws.com/v1/speech");
    expect(call.body).toEqual({
      Text: "<speak><lang xml:lang='en-US'><prosody rate='fast'>Fish &amp; chips &lt;now&gt;</prosody></lang></speak>",
      TextType: "ssml",
      OutputFormat: "pcm",
      VoiceId: "Matthew",
      Engine: "neural",
      SampleRate: "16000",
    });
    expect(call.headers.get("authorization")).toContain("Credential=AKIDTEST/");
    expect(call.headers.get("authorization")).toContain("/us-west-2/polly/aws4_request");
    expect(call.headers.get("x-amz-security-token")).toEqual("TOKEN");

    const frames = down.filter((f) => f instanceof TTSAudioRawFrame) as TTSAudioRawFrame[];
    const total = frames.reduce((n, f) => n + f.audio.length, 0);
    expect(total).toEqual(audio.length);
    expect(frames.every((f) => f.sampleRate === 16000)).toBe(true);
  });

  test("yields an ErrorFrame on an AWS error response", async () => {
    const tts = new AWSPollyTTSService({
      ...KEYS,
      sampleRate: 16000,
      fetch: async () =>
        new Response(JSON.stringify({ message: "Voice is invalid" }), {
          status: 400,
          headers: { "x-amzn-ErrorType": "InvalidParameterValueException:http://internal" },
        }),
    });
    const [, up] = await runTest(tts, {
      framesToSend: [new TTSSpeakFrame({ text: "Hi" })],
    });
    const errors = up.filter((f) => f.constructor.name === "ErrorFrame") as Any[];
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(errors[0].error).toContain("AWS Polly TTS error: InvalidParameterValueException");
  });
});

describe("AWSAgentCoreProcessor", () => {
  const ARN = "arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/test";

  function context(): LLMContext {
    return new LLMContext({ messages: [{ role: "user", content: "What is up?" }] });
  }

  test("default payload transformer", () => {
    expect(defaultContextToPayloadTransformer(context())).toEqual('{"prompt": "What is up?"}');
    expect(
      defaultContextToPayloadTransformer(
        new LLMContext({ messages: [{ role: "assistant", content: "x" }] }),
      ),
    ).toBeNull();
    expect(
      defaultContextToPayloadTransformer(
        new LLMContext({
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: "a" },
                { type: "text", text: "b" },
              ],
            },
          ],
        }),
      ),
    ).toEqual('{"prompt": "a b"}');
  });

  test("streams event-stream lines as text frames", async () => {
    const calls: { url: string; headers: Headers; body: string }[] = [];
    const fakeFetch = async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: String(input),
        headers: new Headers(init?.headers),
        body: new TextDecoder().decode(init?.body as Uint8Array),
      });
      const chunks = ['data: {"response": "Hel', 'lo"}\n\ndata: {"response": " there"}\n', "\n"];
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          for (const chunk of chunks) c.enqueue(new TextEncoder().encode(chunk));
          c.close();
        },
      });
      return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
    };
    const processor = new AWSAgentCoreProcessor({
      agentArn: ARN,
      awsAccessKey: "AKIDTEST",
      awsSecretKey: "SECRET",
      awsRegion: "us-east-1",
      fetch: fakeFetch,
    });
    const [down] = await runTest(processor, {
      framesToSend: [new LLMContextFrame({ context: context() })],
    });

    expect(calls).toHaveLength(1);
    const call = calls[0] as (typeof calls)[number];
    expect(call.url).toEqual(
      "https://bedrock-agentcore.us-east-1.amazonaws.com/runtimes/arn%3Aaws%3Abedrock-agentcore%3Aus-east-1%3A123456789012%3Aruntime%2Ftest/invocations",
    );
    expect(call.body).toEqual('{"prompt": "What is up?"}');
    expect(call.headers.get("x-amzn-bedrock-agentcore-runtime-session-id")).toMatch(
      /^[0-9a-f-]{36}$/,
    );
    expect(call.headers.get("authorization")).toContain(
      "/us-east-1/bedrock-agentcore/aws4_request",
    );

    expect(down.map((f) => f.constructor.name)).toEqual([
      "LLMFullResponseStartFrame",
      "LLMTextFrame",
      "LLMTextFrame",
      "LLMFullResponseEndFrame",
    ]);
    expect(down[0]).toBeInstanceOf(LLMFullResponseStartFrame);
    expect(down[3]).toBeInstanceOf(LLMFullResponseEndFrame);
    expect((down.filter((f) => f instanceof LLMTextFrame) as Any[]).map((f) => f.text)).toEqual([
      "Hello",
      " there",
    ]);
  });

  test("single-part JSON response", async () => {
    const processor = new AWSAgentCoreProcessor({
      agentArn: ARN,
      awsAccessKey: "AKIDTEST",
      awsSecretKey: "SECRET",
      fetch: async () =>
        new Response('{"response": "Done."}', { headers: { "Content-Type": "application/json" } }),
    });
    const [down] = await runTest(processor, {
      framesToSend: [new LLMContextFrame({ context: context() })],
    });
    expect((down.filter((f) => f instanceof LLMTextFrame) as Any[]).map((f) => f.text)).toEqual([
      "Done.",
    ]);
    expect(down.at(-1)).toBeInstanceOf(LLMFullResponseEndFrame);
  });
});
