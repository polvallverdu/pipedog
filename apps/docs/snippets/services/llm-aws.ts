// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Samples for content/docs/services/llm/aws.mdx. Type-checked on every docs build.

// #region usage
import { AWSBedrockLLMService } from "@pipedog/aws/llm";
import { LLMUpdateSettingsFrame } from "@pipedog/core/frames/frames";

const llm = new AWSBedrockLLMService({
  // Or leave these out: AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY,
  // AWS_SESSION_TOKEN and AWS_REGION are read from the environment.
  awsAccessKey: process.env.AWS_ACCESS_KEY_ID,
  awsSecretKey: process.env.AWS_SECRET_ACCESS_KEY,
  awsRegion: "us-east-1",
  settings: new AWSBedrockLLMService.Settings({
    model: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
    systemInstruction: "You are a helpful voice assistant. Keep answers short.",
    maxTokens: 1024,
    enablePromptCaching: true,
  }),
});
// #endregion usage

// #region provider
// Temporary credentials that renew themselves, e.g. from the AWS SDK's
// provider chain: the function is called for every request.
declare function fromNodeProviderChain(): () => Promise<{
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}>;

const roleLlm = new AWSBedrockLLMService({
  awsRegion: "eu-west-1",
  credentialsProvider: fromNodeProviderChain(),
});
// #endregion provider

// #region update
// Queue it on the worker, or push it from a processor upstream of the service.
const update = new LLMUpdateSettingsFrame({
  delta: new AWSBedrockLLMService.Settings({ temperature: 0.3, maxTokens: 512 }),
});
// #endregion update
