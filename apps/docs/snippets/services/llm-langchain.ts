// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Samples for content/docs/services/llm/langchain.mdx. Type-checked on every docs build.
// The docs app does not depend on @langchain/core, so the chain itself is declared here;
// the page builds it in a separate, unchecked block.

// #region usage
import { LangchainProcessor } from "@pipedog/langchain/langchain";

// Any @langchain/core Runnable: a prompt piped into a chat model, a compiled LangGraph, ...
declare const chain: ConstructorParameters<typeof LangchainProcessor>[0];

const langchain = new LangchainProcessor(chain, { transcriptKey: "input" });

// Sent to the chain as `config.configurable.session_id`, for message history.
langchain.setParticipantId("participant-123");
// #endregion usage
