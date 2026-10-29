// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/**
 * AWS services for pipedog. Subpaths mirror `pipecat.services.aws.*` (`/llm`, `/stt`, `/tts`,
 * `/agent_core`, `/nova_sonic/llm`, `/nova_sonic/session_continuation`,
 * `/sagemaker/bidi_client`, `/utils`) and `pipecat.adapters.llm.services.*` (`/bedrock_adapter`,
 * `/aws_nova_sonic_adapter`). `/aws_session`, `/sigv4`, `/event_stream` and
 * `/bidirectional_stream` hold the SigV4 signing and event-stream plumbing.
 */

export * from "./agent_core.ts";
// Both adapters export a `ConvertedMessages`; import those from the adapter subpaths.
export {
  AWSNovaSonicConversationHistoryMessage,
  AWSNovaSonicLLMAdapter,
  type AWSNovaSonicLLMInvocationParams,
  Role,
} from "./aws_nova_sonic_adapter.ts";
export * from "./aws_session.ts";
export { AWSBedrockLLMAdapter, type AWSBedrockLLMInvocationParams } from "./bedrock_adapter.ts";
export * from "./llm.ts";
export * from "./nova_sonic/llm.ts";
export * from "./nova_sonic/session_continuation.ts";
export * from "./sagemaker/bidi_client.ts";
export * from "./stt.ts";
export * from "./tts.ts";
export * from "./utils.ts";
