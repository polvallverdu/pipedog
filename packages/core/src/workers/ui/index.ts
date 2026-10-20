// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipecat-ts contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/workers/ui/__init__.py

/**
 * UI worker: an LLM worker that observes and drives a client GUI over RTVI.
 *
 * Composes the RTVI UI wire protocol (client events, accessibility snapshots,
 * server UI commands) with `screenTools`, the tool a voice LLM uses to ask a
 * `UIWorker` about the screen. `PipelineWorker` connects a `UIWorker` to the
 * client automatically whenever RTVI is enabled — no decorator or separate
 * component to wire up.
 *
 * Built-in UI command payload models (Toast, Navigate, ScrollTo, Highlight,
 * Focus, Click, SetInputValue, SelectText) live in
 * `processors/frameworks/rtvi/models`. Import them from there directly.
 *
 * Porting notes: the deprecated `BaseUIWorker` and `ReplyToolMixin`
 * re-exports are not ported.
 */

export {
  BusUICommandMessage,
  BusUIEventMessage,
  BusUIJobCompletedMessage,
  BusUIJobGroupCompletedMessage,
  BusUIJobGroupStartedMessage,
  BusUIJobUpdateMessage,
} from "../../bus/ui/messages.ts";
export { uiEvent } from "./ui_event_decorator.ts";
export { UI_STATE_PROMPT_GUIDE } from "./ui_prompts.ts";
export { screenTools } from "./ui_tools.ts";
export { UISelection, UIWorker } from "./ui_worker.ts";
