// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/processors/aggregators/async_tool_messages.py

/**
 * Helpers for the async-tool message protocol used in LLM contexts.
 *
 * When a function is registered with `cancelOnInterruption: false`, the
 * `LLMUserContextAggregator` / `LLMAssistantContextAggregator` pair appends
 * async-tool messages to the conversation context as the underlying task
 * progresses:
 *
 * - A `started` message (`role="tool"`) is appended immediately when the tool
 *   starts running.
 * - An `intermediate` message (`role="developer"`) is appended each time an
 *   intermediate result is reported via
 *   `resultCallback(..., new FunctionCallResultProperties({ isFinal: false }))`.
 * - A `final` message (`role="developer"`) is appended when the task
 *   finishes. A task that is cancelled instead of finishing settles the same
 *   way, carrying a cancellation notice in place of a result.
 *
 * The `final` message exists so a result that arrives after the LLM has moved
 * on still reaches it. When the result arrives first, before any model
 * response or any new user or assistant message, there is nothing to catch up
 * on: the `started` message is overwritten with the result, as for a
 * synchronous call, and no `final` message is written. A cancellation always
 * gets a `final` message, because it has to tell the LLM the task did not
 * complete.
 *
 * This module is the single source of truth for the on-the-wire payload shape:
 *
 * - The aggregator uses the `build*Message` functions when injecting messages.
 * - Realtime LLM services use `parseMessage` to detect async-tool messages
 *   while iterating the context, then read `payload.result` and deliver it via
 *   their formal tool-result channel.
 *
 * Internally, `AsyncToolMessagePayload` is the canonical structured form; the
 * on-the-wire JSON string is always derived from it (never stored) so the two
 * representations can't drift.
 *
 * Consumers are expected to import the module rather than its individual
 * functions.
 *
 * @example
 * import * as asyncToolMessages from "@pipedog/core/processors/aggregators/async_tool_messages";
 * asyncToolMessages.buildStartedMessage(toolCallId);
 * asyncToolMessages.parseMessage(msg);
 */

import type { LLMStandardMessage } from "./llm_context.ts";

export type AsyncToolMessageKind = "started" | "intermediate" | "final";

// --- Payload shape (private; canonical source of truth) ---------------------

// The `type` field that identifies an async-tool message payload. Both the
// builders and the parser use this constant; do not duplicate the literal.
const _PAYLOAD_TYPE = "async_tool";

// Status value for started / intermediate messages (task still running).
const _STATUS_RUNNING = "running";

// Status value for the final message (task complete).
const _STATUS_FINISHED = "finished";

// Description shipped on the started message. It says only what the model has
// to act on (wait, and don't answer from nothing) and deliberately does not
// describe the message the result will arrive in. A model told the shape of a
// message it should expect will try to produce one, and a function call is the
// only structured channel it has, so it calls the tool again with the protocol
// payload as the arguments. The payload's own fields are read by parseMessage,
// never by the model, so describing them buys nothing either.
const _STARTED_DESCRIPTION =
  "This tool is still running. You will be given its result later. Do not call it " +
  "again and do not invent a result in the meantime.";

// Description shipped on each intermediate-result message. Names no message
// shape either, for the same reason as the started message above.
const _INTERMEDIATE_DESCRIPTION =
  "This is a partial result and the task is still running. More may follow. Do not " +
  "call this tool again and do not treat this as the final answer.";

// Result shipped on the message that settles a cancelled task. It names the
// tool call as the thing that was cancelled: a bare "CANCELLED" reads as a
// statement about whatever the tool looks up, and a model relaying it will
// tell the user their flight, order, or booking was cancelled.
const _CANCELLED_RESULT = "CANCELLED: this tool call was cancelled before it returned a result";

// Description shipped on the message that settles a cancelled task.
const _CANCELLED_DESCRIPTION =
  "The asynchronous task associated with this tool_call_id was cancelled " +
  "before it produced a result, either because it ran past its deadline or " +
  "because cancellation was requested. No further results will arrive for " +
  "this tool_call_id. If the user is still waiting on it, tell them it did " +
  "not complete rather than leaving it unanswered.";

/**
 * Standing guidance composed into the system instruction whenever an async
 * tool is registered. The per-result message says the same thing, but it
 * arrives buried in a context whose most recent turn may be the user asking
 * for something else; a model weighing the two follows the nearer, louder
 * request. This states the policy before any result exists, so it is in force
 * when one arrives.
 */
export const ASYNC_TOOL_INSTRUCTIONS =
  "ASYNC TOOLS:\n" +
  "Some of your tools keep running after you have replied. Their results arrive later as " +
  "messages in the conversation, on whatever turn happens to be in progress by then.\n" +
  "\n" +
  "A result that has arrived is owed to the user, whatever the conversation has moved on to. " +
  "If the user has said something you have not answered yet, answer that first, then add the " +
  "result at the end of that same reply — never before your answer. If you have already " +
  "answered everything the user said, deliver just the result — do not repeat or rephrase " +
  "your earlier reply. State a short result outright; for a long one, say what came back and " +
  "offer the details. Say it once, and do not repeat it in later replies.";

// Description shipped on the final-result message.
const _FINAL_DESCRIPTION =
  "This is the final result for the asynchronous task associated with this " +
  "tool_call_id. The task has completed. No further results will arrive for " +
  "this tool_call_id. You must convey this result to the user, even if the " +
  "conversation has moved on. Never leave it unsaid. If the user has said " +
  "something you have not answered yet, first finish responding to that, " +
  "then deliver the result at the end of your response; if you have already " +
  "answered, deliver just the result and do not repeat your earlier reply. " +
  "How you deliver it depends on its size: if the result is short, simply " +
  "state it; if it is long or complex, name what has come back and offer " +
  "the details. Convey it once; do not repeat it in later responses.";

export interface AsyncToolMessagePayloadOptions {
  kind: AsyncToolMessageKind;
  toolCallId: string;
  status: "running" | "finished";
  description: string;
  result: string | null;
}

/**
 * The structured contents of an async-tool message in an LLM context.
 *
 * - `kind`: which of the three async-tool message stages this is.
 * - `toolCallId`: the id of the tool invocation this payload relates to.
 * - `status`: `"running"` for started/intermediate, `"finished"` for the
 *   final message.
 * - `description`: human-readable description from the payload. May be empty.
 * - `result`: for `intermediate` and `final` messages, the JSON-encoded result
 *   string (or the literal `"COMPLETED"` if the function returned no value).
 *   `null` for `started` messages.
 */
export class AsyncToolMessagePayload {
  readonly kind: AsyncToolMessageKind;
  readonly toolCallId: string;
  readonly status: "running" | "finished";
  readonly description: string;
  readonly result: string | null;

  constructor(options: AsyncToolMessagePayloadOptions) {
    this.kind = options.kind;
    this.toolCallId = options.toolCallId;
    this.status = options.status;
    this.description = options.description;
    this.result = options.result;
    Object.freeze(this);
  }
}

// --- Internal: payload <-> on-the-wire forms ---------------------------------

/**
 * Serialize a payload to its on-the-wire JSON string form.
 *
 * Fields that don't apply to the payload's kind are omitted (notably `result`
 * is left out of `started` payloads, since the task hasn't produced a result
 * yet).
 *
 * The string matches Python's `json.dumps(obj, ensure_ascii=False)` byte for
 * byte (`", "` and `": "` separators), so contexts are identical across ports.
 */
function _payloadToJson(payload: AsyncToolMessagePayload): string {
  const obj: Record<string, string> = {
    type: _PAYLOAD_TYPE,
    status: payload.status,
    tool_call_id: payload.toolCallId,
    description: payload.description,
  };
  if (payload.result !== null) {
    obj.result = payload.result;
  }
  const entries = Object.entries(obj).map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`);
  return `{${entries.join(", ")}}`;
}

/**
 * Wrap a payload in the LLM context message shape that matches its kind.
 *
 * - `started`: `role="tool"` plus `tool_call_id` at the top level (so the
 *   message can sit alongside other regular tool-result messages).
 * - `intermediate` / `final`: `role="developer"`; `tool_call_id` lives only
 *   inside the JSON payload.
 */
function _payloadToMessage(payload: AsyncToolMessagePayload): LLMStandardMessage {
  const content = _payloadToJson(payload);
  if (payload.kind === "started") {
    return {
      role: "tool",
      content,
      tool_call_id: payload.toolCallId,
    };
  }
  return {
    role: "developer",
    content,
  };
}

// --- Builders ----------------------------------------------------------------

/**
 * Build a `started` async-tool message for an LLM context.
 *
 * Append the returned message to the LLM context immediately when an async
 * function call (registered with `cancelOnInterruption: false`) starts
 * running. The message lets the model know a task is in flight and that its
 * results will arrive later in subsequent `developer`-role messages.
 *
 * @param toolCallId The id of the tool invocation this message is for.
 * @returns A message ready to pass to `LLMContext.addMessage`.
 */
export function buildStartedMessage(toolCallId: string): LLMStandardMessage {
  return _payloadToMessage(
    new AsyncToolMessagePayload({
      kind: "started",
      toolCallId,
      status: _STATUS_RUNNING,
      description: _STARTED_DESCRIPTION,
      result: null,
    }),
  );
}

/**
 * Build an intermediate-result async-tool message for an LLM context.
 *
 * Append the returned message to the LLM context each time the running async
 * function reports a non-final result via
 * `resultCallback(..., new FunctionCallResultProperties({ isFinal: false }))`.
 *
 * @param toolCallId The id of the tool invocation the result is for.
 * @param result The JSON-encoded result string (caller is responsible for
 *   encoding the function's actual return value, typically via
 *   `JSON.stringify`).
 * @returns A message ready to pass to `LLMContext.addMessage`.
 */
export function buildIntermediateResultMessage(
  toolCallId: string,
  result: string,
): LLMStandardMessage {
  return _payloadToMessage(
    new AsyncToolMessagePayload({
      kind: "intermediate",
      toolCallId,
      status: _STATUS_RUNNING,
      description: _INTERMEDIATE_DESCRIPTION,
      result,
    }),
  );
}

/**
 * Build a final-result async-tool message for an LLM context.
 *
 * Append the returned message to the LLM context when the async function
 * finishes. After this message no further async-tool messages will arrive for
 * this `tool_call_id`.
 *
 * @param toolCallId The id of the tool invocation the result is for.
 * @param result The JSON-encoded result string, or the literal `"COMPLETED"`
 *   sentinel when the function returned nothing (matching the same convention
 *   used for synchronous tool calls).
 * @returns A message ready to pass to `LLMContext.addMessage`.
 */
export function buildFinalResultMessage(toolCallId: string, result: string): LLMStandardMessage {
  return _payloadToMessage(
    new AsyncToolMessagePayload({
      kind: "final",
      toolCallId,
      status: _STATUS_FINISHED,
      description: _FINAL_DESCRIPTION,
      result,
    }),
  );
}

/**
 * Build a message settling a cancelled async-tool call in an LLM context.
 *
 * Append the returned message to the LLM context when an async function call
 * is cancelled (by a timeout or at the model's request) instead of running to
 * completion. It settles the `tool_call_id` the same way a final result does,
 * carrying a cancellation notice in place of a result.
 *
 * @param toolCallId The id of the tool invocation that was cancelled.
 * @returns A message ready to pass to `LLMContext.addMessage`.
 */
export function buildCancelledMessage(toolCallId: string): LLMStandardMessage {
  return _payloadToMessage(
    new AsyncToolMessagePayload({
      kind: "final",
      toolCallId,
      status: _STATUS_FINISHED,
      description: _CANCELLED_DESCRIPTION,
      result: _CANCELLED_RESULT,
    }),
  );
}

// --- Parsing -----------------------------------------------------------------

/**
 * Decode an async-tool message payload, or return null if not async-tool.
 *
 * @param message A standard message from the LLM context. Callers iterating
 *   over `LLMContext.getMessages()` should filter out `LLMSpecificMessage`
 *   entries first; only `LLMStandardMessage` values can carry async-tool
 *   payloads.
 * @returns An `AsyncToolMessagePayload` if the message is a recognized
 *   async-tool payload, otherwise `null`.
 */
export function parseMessage(message: LLMStandardMessage): AsyncToolMessagePayload | null {
  const role = message.role;
  if (role !== "tool" && role !== "developer") {
    return null;
  }
  const content = message.content;
  if (typeof content !== "string") {
    return null;
  }
  let payload: unknown;
  try {
    payload = JSON.parse(content);
  } catch {
    return null;
  }
  if (
    typeof payload !== "object" ||
    payload === null ||
    Array.isArray(payload) ||
    (payload as Record<string, unknown>).type !== _PAYLOAD_TYPE
  ) {
    return null;
  }
  const obj = payload as Record<string, unknown>;
  const toolCallId = obj.tool_call_id;
  const status = obj.status;
  if (
    typeof toolCallId !== "string" ||
    (status !== _STATUS_RUNNING && status !== _STATUS_FINISHED)
  ) {
    return null;
  }
  let description = "description" in obj ? obj.description : "";
  if (typeof description !== "string") {
    description = "";
  }
  let result = obj.result ?? null;
  if (result !== null && typeof result !== "string") {
    result = null;
  }
  let kind: AsyncToolMessageKind;
  if (result === null) {
    kind = "started";
  } else if (status === _STATUS_FINISHED) {
    kind = "final";
  } else {
    kind = "intermediate";
  }
  return new AsyncToolMessagePayload({
    kind,
    toolCallId,
    status,
    description: description as string,
    result: result as string | null,
  });
}
