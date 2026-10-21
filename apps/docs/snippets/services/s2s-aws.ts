// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Samples for content/docs/services/s2s/aws.mdx. Type-checked on every docs build.

// #region usage
import { AudioConfig, AWSNovaSonicLLMService } from "@pipedog/aws/nova_sonic/llm";
import { SessionContinuationParams } from "@pipedog/aws/nova_sonic/session_continuation";

const llm = new AWSNovaSonicLLMService({
  // Or leave these out to read the AWS_* environment variables.
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  region: "us-east-1",
  settings: new AWSNovaSonicLLMService.Settings({
    voice: "tiffany",
    systemInstruction: "You are a friendly voice assistant. Keep answers short.",
    endpointingSensitivity: "MEDIUM",
  }),
  audioConfig: new AudioConfig({ inputSampleRate: 16000, outputSampleRate: 24000 }),
  // Hand the conversation to a fresh session before Nova Sonic's time limit.
  sessionContinuation: new SessionContinuationParams({ enabled: true }),
});
// #endregion usage

// #region http2
// Upstream's transport: HTTP/2 through the AWS SDK (Node and Bun only).
// Needs `@aws-sdk/client-bedrock-runtime`.
const http2Llm = new AWSNovaSonicLLMService({
  region: "us-east-1",
  transport: "http2",
});
// #endregion http2
