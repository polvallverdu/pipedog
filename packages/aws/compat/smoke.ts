// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Runtime smoke test for tools/compat.
//
// Everywhere (bun, node, deno, workerd):
// - imports every module. The AWS SDK clients (`@aws-sdk/client-bedrock-runtime`,
//   `@aws-sdk/client-sagemaker-runtime-http2`) are optional peers that tools/compat
//   hides, so a static import of either anywhere in the graph fails this test;
// - checks SigV4 on WebCrypto against the AWS test-suite vector;
// - runs `AWSBedrockLLMService` (ConverseStream event stream), `AWSPollyTTSService` and
//   `AWSAgentCoreProcessor` against in-process fake `fetch` functions;
// - constructs `AWSTranscribeSTTService`, `AWSNovaSonicLLMService` and
//   `SageMakerBidiClient` (the last two load their SDK lazily, on first connect).

import { AWSAgentCoreProcessor } from "@pipedog/aws/agent_core";
import { encodeEventStreamMessage } from "@pipedog/aws/event_stream";
import { AWSBedrockLLMService } from "@pipedog/aws/llm";
import { AWSNovaSonicLLMService } from "@pipedog/aws/nova_sonic/llm";
import { SageMakerBidiClient } from "@pipedog/aws/sagemaker/bidi_client";
import { signRequest } from "@pipedog/aws/sigv4";
import { AWSTranscribeSTTService } from "@pipedog/aws/stt";
import { AWSPollyTTSService } from "@pipedog/aws/tts";
import {
  type Frame,
  LLMContextFrame,
  LLMTextFrame,
  TTSAudioRawFrame,
  TTSSpeakFrame,
} from "@pipedog/core/frames/frames";
import { LLMContext } from "@pipedog/core/processors/aggregators/llm_context";
import { runTest } from "@pipedog/core/tests/utils";

function check(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(`aws smoke: ${message}`);
}

const KEYS = { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "SECRET" };
const enc = new TextEncoder();

function event(type: string, body: object): Uint8Array {
  return encodeEventStreamMessage({
    headers: { ":message-type": "event", ":event-type": type, ":content-type": "application/json" },
    body: enc.encode(JSON.stringify(body)),
  });
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function urls(): { seen: string[]; fetch: (u: string | URL | Request) => string } {
  const seen: string[] = [];
  return {
    seen,
    fetch: (u) => {
      seen.push(String(u));
      return String(u);
    },
  };
}

async function sigv4(): Promise<void> {
  const headers = await signRequest({
    method: "GET",
    url: "https://example.amazonaws.com/",
    service: "service",
    region: "us-east-1",
    credentials: {
      accessKeyId: "AKIDEXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
    },
    date: new Date("2015-08-30T12:36:00Z"),
  });
  check(
    headers.authorization?.endsWith(
      "Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31",
    ),
    "sigv4 vector",
  );
}

async function bedrock(): Promise<void> {
  const u = urls();
  const llm = new AWSBedrockLLMService({
    awsAccessKey: KEYS.accessKeyId,
    awsSecretKey: KEYS.secretAccessKey,
    awsRegion: "us-east-1",
    fetch: async (input) => {
      u.fetch(input);
      const body = concat([
        event("messageStart", { role: "assistant" }),
        event("contentBlockDelta", { contentBlockIndex: 0, delta: { text: "Hello" } }),
        event("messageStop", { stopReason: "end_turn" }),
        event("metadata", { usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }),
      ]);
      return new Response(body, {
        headers: { "content-type": "application/vnd.amazon.eventstream" },
      });
    },
  });
  const context = new LLMContext({ messages: [{ role: "user", content: "Hi" }] });
  const [down] = await runTest(llm, { framesToSend: [new LLMContextFrame({ context })] });
  check(u.seen[0]?.endsWith("/model/us.amazon.nova-lite-v1%3A0/converse-stream"), "bedrock url");
  check(
    down.some((f: Frame) => f instanceof LLMTextFrame && f.text === "Hello"),
    "bedrock text",
  );
}

async function polly(): Promise<void> {
  const u = urls();
  const tts = new AWSPollyTTSService({
    awsAccessKeyId: KEYS.accessKeyId,
    apiKey: KEYS.secretAccessKey,
    region: "us-east-1",
    sampleRate: 16000,
    fetch: async (input) => {
      u.fetch(input);
      return new Response(new Uint8Array(3200), { headers: { "content-type": "audio/pcm" } });
    },
  });
  const [down] = await runTest(tts, { framesToSend: [new TTSSpeakFrame({ text: "Hello." })] });
  check(u.seen[0] === "https://polly.us-east-1.amazonaws.com/v1/speech", "polly url");
  check(
    down.some((f: Frame) => f instanceof TTSAudioRawFrame),
    "polly audio",
  );
}

async function agentCore(): Promise<void> {
  const u = urls();
  const agent = new AWSAgentCoreProcessor({
    agentArn: "arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/smoke",
    awsAccessKey: KEYS.accessKeyId,
    awsSecretKey: KEYS.secretAccessKey,
    fetch: async (input) => {
      u.fetch(input);
      return new Response('data: {"response": "Hi there"}\n\n', {
        headers: { "content-type": "text/event-stream" },
      });
    },
  });
  const context = new LLMContext({ messages: [{ role: "user", content: "Hi" }] });
  const [down] = await runTest(agent, { framesToSend: [new LLMContextFrame({ context })] });
  check(u.seen[0]?.includes("/runtimes/arn%3Aaws%3Abedrock-agentcore"), "agentcore url");
  check(
    down.some((f: Frame) => f instanceof LLMTextFrame && f.text === "Hi there"),
    "agentcore text",
  );
}

export default async function smoke(): Promise<Record<string, string>> {
  new AWSTranscribeSTTService({ awsAccessKeyId: "a", apiKey: "b" });
  new AWSNovaSonicLLMService({ accessKeyId: "a", secretAccessKey: "b" });
  new SageMakerBidiClient({ endpointName: "smoke", region: "us-east-1" });
  await sigv4();
  await bedrock();
  await polly();
  await agentCore();
  return { bedrock: "ok", polly: "ok", agentcore: "ok" };
}
