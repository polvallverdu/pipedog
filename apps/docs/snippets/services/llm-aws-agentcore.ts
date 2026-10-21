// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Samples for content/docs/services/llm/aws-agentcore.mdx. Type-checked on every docs build.

// #region usage
import { AWSAgentCoreProcessor } from "@pipedog/aws/agent_core";
import type { LLMContext } from "@pipedog/core/processors/aggregators/llm_context";

const agent = new AWSAgentCoreProcessor({
  agentArn: "arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/my-agent",
  awsRegion: "us-east-1",
});
// new Pipeline([transport.input(), stt, userAggregator, agent, tts, transport.output(), ...])
// #endregion usage

// #region transformers
const customAgent = new AWSAgentCoreProcessor({
  agentArn: "arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/my-agent",
  // Send the whole conversation instead of the last user message.
  contextToPayloadTransformer: (context: LLMContext) =>
    JSON.stringify({ messages: context.getMessages() }),
  // The agent streams `data: {"text": "..."}` lines; the processor strips `data: `.
  responseToOutputTransformer: (line: string) => {
    try {
      return (JSON.parse(line) as { text?: string }).text ?? null;
    } catch {
      return null;
    }
  },
});
// #endregion transformers
