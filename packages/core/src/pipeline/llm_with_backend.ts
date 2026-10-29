// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/pipeline/llm_with_backend/__init__.py

/**
 * An LLM with a backend: a conversational frontend delegating the rest.
 *
 * The frontend is any LLM service, text or speech-to-speech, and holds the
 * conversation. The backend is a `BackendLLMWorker` running a heavier model
 * with the tools, and does the work the frontend hands off. `LLMWithBackend`
 * wraps the frontend so the pair drops into a pipeline where an LLM goes, and
 * installs the tools that join them.
 *
 * The two exchange messages. The frontend's `delegate` tool puts a message
 * to the backend and returns at once; what the backend has to say comes back
 * as a stream of outputs, each appended to the frontend's conversation as a
 * message marked `Backend:`, spoken or silent as the backend's flag says. A
 * second request joins the first, and a correction changes or stops it. How a
 * request is worded is the `BackendRequestStrategy`'s business, and the
 * `BackendConnector` owns the tools, the session with the backend, and how
 * each output is rendered into the conversation.
 *
 * The classes an app builds with import from this module. The rest, such as
 * the prompt texts an app may start from to write its own, import from the
 * module that defines them:
 *
 * - `pipeline/llm_with_backend/prompts`: what the frontend's model reads, from
 *   the pairing instruction to the marks on the backend's messages.
 * - `pipeline/llm_with_backend/request_strategies`: how a `delegate` call
 *   becomes the backend's request.
 * - `pipeline/llm_with_backend/connector`: `BackendConnector`, which joins a
 *   frontend to its backend.
 * - `pipeline/llm_with_backend/predictive_delegation`: `PredictiveDelegation`,
 *   an optional speed-up for a text frontend.
 * - `pipeline/llm_with_backend/llm_with_backend`: `LLMWithBackend`, which puts
 *   the pair where an LLM goes.
 *
 * Porting note: upstream turned this module into a package whose
 * `__init__.py` only re-exports. The package's modules live under
 * `pipeline/llm_with_backend/`, and this file keeps the package's import path
 * (`@pipedog/core/pipeline/llm_with_backend`) for its main classes.
 */

export { BackendConnector } from "./llm_with_backend/connector.ts";
export { LLMWithBackend } from "./llm_with_backend/llm_with_backend.ts";
export { PredictiveDelegation } from "./llm_with_backend/predictive_delegation.ts";
export {
  BackendRequestStrategy,
  ExplicitBackendRequestStrategy,
  TranscriptBackendRequestStrategy,
} from "./llm_with_backend/request_strategies.ts";
