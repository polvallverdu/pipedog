// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/workers/llm/backend_llm_worker.py

/**
 * Backend LLM worker for two-tier voice agents.
 *
 * A frontend holds the conversation and hands off requests that need tools or
 * careful reasoning. What the frontend is does not matter to this contract: a
 * speech-to-speech model delegating on its own, or a pipeline calling a tool.
 * A `BackendLLMWorker` runs any Pipecat LLM service, with its own context and
 * multi-step tool calling, to do that work.
 *
 * The frontend and the backend exchange messages. A frontend *attaches* to the
 * worker once, for as long as it lives, and from then on hears everything the
 * backend produces as a stream: each of its model's turns and reasoning
 * summaries as a `BackendOutput`, each phase of the function calls it makes as
 * a `BackendToolCall`, and when it has run out of things to do, that it is
 * idle. Requests go the other way as messages appended to the backend's
 * conversation, each answered at once; a message that arrives while the
 * backend is working joins that work, and the backend's model sorts out what
 * it means. `_BackendSession` is the caller side of that contract.
 *
 * A request is text, so how a frontend words one is its own business.
 * `_renderTranscriptRequest` renders the conversation as a labelled
 * transcript, which is what a frontend hands over when its model signals a
 * handoff without wording a request; a frontend whose model does word one
 * sends that instead. `OpenAILiveLLMService`'s client delegation and
 * `LLMWithBackend` both drive the worker this way.
 *
 * Porting notes:
 * - DIVERGENCE: upstream overrides `PipelineWorker.capabilities` with a plain
 *   dict. TypeScript does not allow an override of a different type, so the
 *   backend's capabilities are exposed as `backendCapabilities`, and
 *   `PipelineWorker.capabilities` keeps its meaning.
 * - `_BackendSession`'s `async with` is `enter()` / `exit()` (or `run(fn)`),
 *   and its `async for` is `for await`.
 */

import { Event, Queue, rethrowIfCancelled, shield } from "@pipedog/asyncio";
import type { BusJobCancelMessage, BusJobRequestMessage } from "../../bus/messages.ts";
import {
  type ErrorFrame,
  ExternalFunctionCall,
  ExternalFunctionCallCancelFrame,
  ExternalFunctionCallInProgressFrame,
  ExternalFunctionCallResultFrame,
  ExternalFunctionCallsStartedFrame,
  type Frame,
  FunctionCallCancelFrame,
  FunctionCallInProgressFrame,
  FunctionCallResultFrame,
  FunctionCallsStartedFrame,
  InterruptionFrame,
  LLMContextFrame,
  LLMMessagesAppendFrame,
  LLMRunFrame,
} from "../../frames/frames.ts";
import {
  JobError,
  JobEvent,
  type JobGroup,
  JobGroupError,
  JobGroupParams,
  JobParams,
  JobStatus,
} from "../../pipeline/job_context.ts";
import { job } from "../../pipeline/job_decorator.ts";
import {
  type LLMContext,
  type LLMContextMessage,
  LLMSpecificMessage,
  standardMessageText,
} from "../../processors/aggregators/llm_context.ts";
import {
  type AssistantThoughtMessage,
  type AssistantTurnStoppedMessage,
  type LLMAssistantAggregatorParams,
  LLMUserAggregatorParams,
} from "../../processors/aggregators/llm_response_universal.ts";
import type { LLMService } from "../../services/llm_service.ts";
import { LLMSettings } from "../../services/settings.ts";
import { ExternalUserTurnStrategies } from "../../turns/user_turn_strategies.ts";
import { ErrorCategory } from "../../utils/errors.ts";
import { logger } from "../../utils/logger.ts";
import type { BaseWorker } from "../base_worker.ts";
import { LLMContextWorker } from "./llm_context_worker.ts";

type Dict = Record<string, unknown>;

/** Name of the job that attaches a frontend to a `BackendLLMWorker`. */
export const ATTACH_JOB_NAME = "attach";

/** Name of the job that puts a message to an attached `BackendLLMWorker`. */
export const MESSAGE_JOB_NAME = "message";

/** The `type` of a job update that carries a `BackendOutput`. */
export const OUTPUT_UPDATE_TYPE = "output";

/** The `type` of a job update that carries a `BackendToolCall`. */
export const TOOL_CALL_UPDATE_TYPE = "tool_call";

/** The `type` of the update that opens an `attach` job's stream. */
export const ATTACHED_UPDATE_TYPE = "attached";

/** The `type` of the update that says the backend has nothing left to do. */
export const IDLE_UPDATE_TYPE = "idle";

/** The `type` of the update that says the backend could not go on. */
export const ERROR_UPDATE_TYPE = "error";

/**
 * The mark the backend's model puts at the start of a message it wants the
 * user told. The message is sent with `prefersSpoken: true`, mark stripped; a
 * message without it is a note (`prefersSpoken: false`). Strict prompt,
 * flexible parsing: the model is told to put the mark first, but sometimes
 * writes a note paragraph and then a marked one, so a mark at the start of a
 * later line splits the message, a note before it and a spoken message from it
 * on, rather than losing the result. The turn-completion markers are read the
 * same way (`user_turn_completion_mixin`).
 */
export const SPOKEN_MARK = ">>";

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Where a message's spoken part starts: the first line that begins with the mark. */
const SPOKEN_MARK_LINE_SOURCE = `^[ \\t]*${escapeRegExp(SPOKEN_MARK)}[ \\t]*`;

/**
 * How the backend's model works with the assistant, appended to its system
 * instruction: who it is, which of what it writes the user hears, and how it
 * takes requests. The backend's own system instruction says what it does;
 * this says how what it writes reaches the user.
 * `new BackendLLMWorker({ pairingInstruction })` replaces it.
 */
export const BACKEND_PAIRING_INSTRUCTION =
  "You are the backend of a voice assistant. The assistant talks with the user and sends " +
  "you requests: the conversation it is having, or a request it worded for you. Do the " +
  "parts that need your tools or careful reasoning; the assistant handles the rest of the " +
  "conversation itself, such as small talk, jokes and stories, so leave those to it.\n\n" +
  `WHAT THE USER HEARS: Begin a message with ${SPOKEN_MARK} and the whole of it is told to ` +
  "the user, in the assistant's own words, tool calls or not. Anything you write without " +
  "the mark is not told to the user: the assistant keeps it as notes on your work, and " +
  "draws on them only if the user asks how the work is going. " +
  "Mark a message to give a result, to ask a question you cannot proceed without, or for " +
  "news the user should have now. A result you do not mark is " +
  `lost: the message that gives it begins with ${SPOKEN_MARK}. Never say again what you ` +
  "have already marked, and never mark that you have stopped or that there is nothing to " +
  "do: the assistant has already told the user. Write a marked message as plain spoken " +
  "sentences the assistant can say as they are: no headings, lists, Markdown or raw " +
  "JSON.\n\n" +
  "REQUESTS: A request may arrive while you are working on an earlier one. It may add " +
  "work, change it, or stop some or all of it: follow the latest, cancel the tools whose " +
  "results are no longer wanted, and do not repeat work already done. With several " +
  "requests in hand, do the newest first unless it depends on an earlier one, and give " +
  "each one's result as soon as you have it, not when everything is done.";

export interface BackendOutputOptions {
  /** The text the backend produced. */
  text: string;
  /** Whether this is a reasoning summary rather than a response. Defaults to false. */
  isThought?: boolean;
  /** Whether the backend would like the user to hear this. Defaults to true. */
  prefersSpoken?: boolean;
}

/**
 * One piece of output from a backend, on its way to the frontend.
 *
 * - `text`: the text the backend produced.
 * - `isThought`: whether this is a reasoning summary rather than a response.
 * - `prefersSpoken`: whether the backend would like the user to hear this.
 *   This is just a hint to the frontend: it may choose to follow it or not.
 *   `OpenAILiveLLMService`'s live model takes it into consideration, but
 *   ultimately decides what to speak (or not) based on the conversation.
 */
export class BackendOutput {
  text: string;
  isThought: boolean;
  prefersSpoken: boolean;

  constructor(options: BackendOutputOptions) {
    this.text = options.text;
    this.isThought = options.isThought ?? false;
    this.prefersSpoken = options.prefersSpoken ?? true;
  }

  /**
   * Render the output as a job update payload.
   *
   * @returns The payload.
   */
  toPayload(): Dict {
    return {
      type: OUTPUT_UPDATE_TYPE,
      text: this.text,
      is_thought: this.isThought,
      prefers_spoken: this.prefersSpoken,
    };
  }

  /**
   * Rebuild an output from a job update payload.
   *
   * @param payload The update payload.
   * @returns The output.
   */
  static fromPayload(payload: Dict): BackendOutput {
    // A flag the payload omits is left to the field's default, so the
    // defaults live in one place; one it carries is coerced, since a payload
    // can arrive from another process.
    const options: BackendOutputOptions = { text: String(payload.text || "") };
    if ("is_thought" in payload) options.isThought = Boolean(payload.is_thought);
    if ("prefers_spoken" in payload) options.prefersSpoken = Boolean(payload.prefers_spoken);
    return new BackendOutput(options);
  }
}

/** The phases of a `BackendToolCall`. */
export type BackendToolCallPhase = "started" | "in_progress" | "result" | "cancelled";

export interface BackendToolCallOptions {
  /** `started`, `in_progress`, `result` or `cancelled`. */
  phase: BackendToolCallPhase;
  /** Name of the function called. */
  functionName: string;
  /** Unique identifier of the call. */
  toolCallId: string;
  /** Arguments passed to the function, once known. */
  arguments?: Record<string, unknown> | null;
  /** The result, for the `result` phase. */
  result?: unknown;
  /**
   * For the `result` phase, whether the result completes the call rather
   * than being one of a stream of intermediate results. Defaults to true.
   */
  isFinal?: boolean;
}

/**
 * One phase of a function call the backend made while working, on its way to
 * the frontend.
 *
 * The call ran in the backend's own pipeline; the frontend reports it to
 * clients, as the `ExternalFunctionCall*Frame` `toFrame` builds, and does
 * nothing else with it. The phases mirror the pipeline's own function-call
 * frames.
 *
 * - `phase`: `started`, `in_progress`, `result` or `cancelled`.
 * - `functionName`: name of the function called.
 * - `toolCallId`: unique identifier of the call.
 * - `arguments`: arguments passed to the function, once known.
 * - `result`: the result, for the `result` phase.
 * - `isFinal`: for the `result` phase, whether the result completes the call
 *   rather than being one of a stream of intermediate results.
 */
export class BackendToolCall {
  phase: BackendToolCallPhase;
  functionName: string;
  toolCallId: string;
  arguments: Record<string, unknown> | null;
  result: unknown;
  isFinal: boolean;

  constructor(options: BackendToolCallOptions) {
    this.phase = options.phase;
    this.functionName = options.functionName;
    this.toolCallId = options.toolCallId;
    this.arguments = options.arguments ?? null;
    this.result = options.result ?? null;
    this.isFinal = options.isFinal ?? true;
  }

  /**
   * Render the call phase as a job update payload.
   *
   * @returns The payload.
   */
  toPayload(): Dict {
    return {
      type: TOOL_CALL_UPDATE_TYPE,
      phase: this.phase,
      function_name: this.functionName,
      tool_call_id: this.toolCallId,
      arguments: this.arguments !== null ? { ...this.arguments } : null,
      result: this.result,
      is_final: this.isFinal,
    };
  }

  /**
   * Rebuild a call phase from a job update payload.
   *
   * @param payload The update payload.
   * @returns The call phase.
   */
  static fromPayload(payload: Dict): BackendToolCall {
    return new BackendToolCall({
      phase: (payload.phase || "in_progress") as BackendToolCallPhase,
      functionName: String(payload.function_name || ""),
      toolCallId: String(payload.tool_call_id || ""),
      arguments: (payload.arguments as Record<string, unknown> | null | undefined) ?? null,
      result: payload.result ?? null,
      isFinal: Boolean("is_final" in payload ? payload.is_final : true),
    });
  }

  /**
   * Build the frame that reports this phase in the frontend's pipeline.
   *
   * @returns The frame for the phase.
   */
  toFrame(): Frame {
    if (this.phase === "started") {
      // The frame can announce several calls at once, as the pipeline's own
      // FunctionCallsStartedFrame does; a backend reports its calls one at a
      // time, so here it carries one.
      return new ExternalFunctionCallsStartedFrame({
        functionCalls: [
          new ExternalFunctionCall({
            functionName: this.functionName,
            toolCallId: this.toolCallId,
          }),
        ],
      });
    }
    if (this.phase === "in_progress") {
      return new ExternalFunctionCallInProgressFrame({
        functionName: this.functionName,
        toolCallId: this.toolCallId,
        arguments: this.arguments,
      });
    }
    if (this.phase === "result") {
      return new ExternalFunctionCallResultFrame({
        functionName: this.functionName,
        toolCallId: this.toolCallId,
        arguments: this.arguments,
        result: this.result,
        isFinal: this.isFinal,
      });
    }
    return new ExternalFunctionCallCancelFrame({
      functionName: this.functionName,
      toolCallId: this.toolCallId,
    });
  }
}

/** The backend has nothing left to do: no run outstanding, no call in flight. */
export class BackendIdle {}

/**
 * The backend could not go on with what it was doing.
 *
 * - `error`: what went wrong.
 */
export class BackendError {
  error: string;

  constructor(options: { error: string }) {
    this.error = options.error;
  }
}

/** What a `_BackendSession` yields. */
export type BackendEvent = BackendOutput | BackendToolCall | BackendIdle | BackendError;

/**
 * Shapes one of the backend model's outputs before it is sent.
 *
 * Returns the output to send in place of `output`, or null to send nothing.
 */
export type BackendOutputTransform = (output: BackendOutput) => Promise<BackendOutput | null>;

/** What `_renderTranscriptRequest` tells the backend to do with a transcript. */
export const TRANSCRIPT_REQUEST_INSTRUCTION =
  "Act on the user's most recent request in the conversation above. If it asks for " +
  "something, tell the user the result as soon as you have it, before going on with other " +
  `work, in a message that begins with ${SPOKEN_MARK}. If it only stops or changes work ` +
  "already under way, tell them nothing: the assistant already has.";

/**
 * Appended to a request the frontend worded itself, so the backend tells the
 * user its result on its own rather than with whatever else it is doing.
 */
export const EXPLICIT_REQUEST_INSTRUCTION =
  "If this request asks for something, tell the user the result as soon as you have it, " +
  `before going on with other work, in a message that begins with ${SPOKEN_MARK}. If it ` +
  "only stops or changes work already under way, tell them nothing: the assistant already " +
  "has.";

/**
 * Render a request the frontend worded itself, with what the backend should do
 * with it after.
 *
 * @param request The request, as the frontend's model worded it.
 * @param options.instruction What the backend should do with the request,
 *   placed after it.
 * @returns The rendered request.
 */
export function _renderExplicitRequest(
  request: string,
  options: { instruction?: string } = {},
): string {
  const instruction = options.instruction ?? EXPLICIT_REQUEST_INSTRUCTION;
  return `${request}\n\n${instruction}`;
}

/** Strip like Python's `str.strip()` (whitespace at both ends). */
function strip(text: string): string {
  return text.trim();
}

/**
 * Split a message the model wrote into its note and its spoken part, by the
 * mark.
 *
 * @param text The message, stripped.
 * @returns The note (what precedes the first line that begins with the mark,
 *   or the whole message when no line does) and the spoken part (what follows
 *   the mark, with any later mark removed, or empty), each stripped.
 */
export function _splitSpoken(text: string): [string, string] {
  const match = new RegExp(SPOKEN_MARK_LINE_SOURCE, "m").exec(text);
  if (match === null) {
    return [text, ""];
  }
  // From the first marked line on, the whole of it is spoken; a mark the model
  // put on a later line is not meant for the user's ear.
  const end = match.index + match[0].length;
  const spoken = text.slice(end).replace(new RegExp(SPOKEN_MARK_LINE_SOURCE, "gm"), "");
  return [strip(text.slice(0, match.index)), strip(spoken)];
}

/** Python-style `repr()` of a role, for log lines. */
function reprRole(role: unknown): string {
  if (role === undefined || role === null) return "None";
  if (typeof role === "string") return `'${role}'`;
  return String(role);
}

/**
 * Render a conversation as a labelled transcript for the backend to act on.
 *
 * Flattening the conversation into one message keeps the two conversations
 * apart: the backend's context holds only what the backend itself said as
 * assistant messages, so it never mistakes the frontend's speech for its own.
 *
 * Only user and assistant text crosses today: tool calls, tool results,
 * images, other non-text content and messages in a service's own format are
 * skipped, and say so at debug level. Carrying more is a question of how to
 * render it.
 *
 * @param conversation The conversation the user is having with the frontend,
 *   as standard context messages.
 * @param options.instruction What the backend should do with the transcript,
 *   placed after it.
 * @param options.first Whether this is the backend's first request in the
 *   conversation. It decides how the transcript is introduced: as the
 *   conversation so far, or as what has been said since the previous
 *   delegation. Defaults to true.
 * @returns The rendered request.
 */
export function _renderTranscriptRequest(
  conversation: readonly LLMContextMessage[],
  options: { instruction?: string; first?: boolean } = {},
): string {
  const instruction = options.instruction ?? TRANSCRIPT_REQUEST_INSTRUCTION;
  const first = options.first ?? true;
  const lines: string[] = [];
  if (conversation.length > 0) {
    lines.push(
      first ? "Voice conversation so far:" : "Voice conversation since the previous delegation:",
    );
    for (const message of conversation) {
      if (message instanceof LLMSpecificMessage) {
        logger.debug(`Skipping delegated message in ${message.llm} format`);
        continue;
      }
      const role = (message as Dict).role;
      const text = standardMessageText(message);
      if ((role === "user" || role === "assistant") && text) {
        lines.push(`${String(role).toUpperCase()}: ${text}`);
      } else {
        logger.debug(`Skipping delegated message with no transcript form: role=${reprRole(role)}`);
      }
    }
    lines.push("");
  }
  lines.push(instruction);
  return lines.join("\n");
}

/** The frontend attached to the worker, for as long as its `attach` job lives. */
class _AttachedFrontend {
  jobId: string;
  detached: Event = new Event();

  constructor(options: { jobId: string; detached?: Event }) {
    this.jobId = options.jobId;
    if (options.detached) this.detached = options.detached;
  }
}

export interface BackendLLMWorkerOptions {
  /** The backend LLM service. */
  llm: LLMService;
  /**
   * The backend's context, typically carrying its tools. A fresh empty
   * context when omitted.
   */
  context?: LLMContext | null;
  /**
   * Unique name for this worker on the bus. Auto-generated when omitted; give
   * one when the backend runs in another process, where the frontend
   * addresses it by name.
   */
  name?: string | null;
  /**
   * Called with each `BackendOutput` the model produces before it is sent, to
   * adjust its text or whether the user may hear it, or to return null and
   * send nothing. Outputs the app sends itself are not passed through it
   * unless the call asks.
   */
  transformOutput?: BackendOutputTransform | null;
  /**
   * How the model works with the assistant, appended to the LLM's system
   * instruction: `BACKEND_PAIRING_INSTRUCTION` unless given. One of its own
   * has to say what that one says: that the assistant sends it requests, that
   * the user hears what it marks with `SPOKEN_MARK` and nothing else, and how
   * to take requests that arrive while it works.
   */
  pairingInstruction?: string;
  /**
   * Optional parameters for the user aggregator. Defaults to external turn
   * strategies: the backend has no audio, so the default VAD and
   * turn-analysis strategies (and the model the latter loads) have nothing to
   * do here.
   */
  userParams?: LLMUserAggregatorParams | null;
  /** Optional parameters for the assistant aggregator. */
  assistantParams?: LLMAssistantAggregatorParams | null;
}

/**
 * A worker that runs an LLM service as the backend a frontend delegates to.
 *
 * The worker owns the backend's conversation: an `LLMContext` plus the
 * aggregator pair, so multi-step tool calling works as it does in any
 * pipeline. A frontend attaches once, for as long as it lives, and from then
 * on hears everything the backend produces; requests it sends are appended to
 * that conversation as user messages and run the model. `_BackendSession` is
 * the caller side.
 *
 * The worker's LLM does the reasoning its frontend hands off, so it runs at
 * its provider's default thinking unless its settings configure thinking (see
 * `LLMSettings.useProviderThinkingDefault`).
 *
 * Job contract:
 *
 * - `attach`: no payload. Its first update is
 *   `{"type": "attached", "capabilities": {...}}`; after that, a
 *   `BackendOutput` payload for each of the model's turns and reasoning
 *   summaries and each output the app sends with `sendOutput`, a
 *   `BackendToolCall` payload for each phase of each function call the
 *   backend makes, `{"type": "idle"}` when the backend has nothing left to
 *   do, and `{"type": "error", "error": ...}` when it could not go on. The job
 *   lives until the requester cancels it, which stops the backend's work.
 *   Refused while another frontend is attached.
 * - `message`: `{"request": str}`, appended as a user message; responds at
 *   once with `{"backend": "idle" | "working"}`, what the backend was doing
 *   when the message arrived. A message that arrives mid-run is taken up
 *   after the current step, with everything that came before it in view.
 *
 * The model decides what the user hears: a message it begins with
 * `SPOKEN_MARK` asks to be spoken, whether or not the turn also calls tools,
 * and the mark is stripped; anything else it writes, reasoning summaries
 * included, is a note that the frontend keeps but does not speak. A mark at
 * the start of a later line splits the message into a note and a spoken part,
 * since the model sometimes writes it that way. The backend's own system
 * instruction says what it does and, in plain words, what the user should be
 * told; the pairing instruction the worker appends
 * (`BACKEND_PAIRING_INSTRUCTION`, or the `pairingInstruction` given) is the
 * only place the mark is named. `transformOutput` can change the flag, or the
 * text, or drop the output.
 *
 * @example
 * const backend = new BackendLLMWorker({
 *   llm: new AnthropicLLMService({ apiKey: ... }),
 *   context: new LLMContext({
 *     messages: [{ role: "system", content: BACKEND_INSTRUCTIONS }],
 *     tools: [getWeather],
 *   }),
 * });
 */
export class BackendLLMWorker extends LLMContextWorker {
  protected _attached: _AttachedFrontend | null = null;
  protected _transformOutput: BackendOutputTransform | null;

  // Whether the backend is working is read off its pipeline: requests queued
  // but not yet taken up, LLM runs picked up but not yet ended, function calls
  // in flight, and context frames queued for the LLM. A request takes one or
  // more runs: the first for the request itself, then one per round of tool
  // results (the assistant aggregator pushes an LLMContextFrame back to the
  // LLM after each). Runs are counted as the LLM picks them up and as their
  // turns end; an interruption cancels whatever was outstanding.
  protected _requestsPending = 0;
  protected _runsRequested = 0;
  protected _runsCompleted = 0;
  // Whether the idle update has been sent for the current lull, so a call
  // that settles after the last turn stopped does not send it twice.
  protected _idleAnnounced = false;
  // The index in the context of a request appended while the model was busy,
  // as an LLMMessagesAppendFrame with runLlm=false: the run that follows the
  // current step takes it up, and the model sees the request alongside
  // whatever that step produced. Running it separately would run the model
  // twice on the same context, the second time with nothing new to react to.
  // Cleared once an LLMContextFrame that holds the request reaches the LLM.
  protected _requestAwaitingRun: number | null = null;

  /**
   * Initialize the backend worker.
   *
   * @throws Error If the LLM service declines the role.
   */
  constructor(options: BackendLLMWorkerOptions) {
    const llm = options.llm;
    const objection = llm.llmWithBackendRoleObjection("backend");
    if (objection) {
      throw new Error(objection);
    }
    llm.settings.applyUpdate(new LLMSettings({ useProviderThinkingDefault: true }));
    let userParams = options.userParams ?? null;
    if (userParams === null) {
      userParams = new LLMUserAggregatorParams({
        userTurnStrategies: new ExternalUserTurnStrategies(),
      });
    }
    super({
      name: options.name ?? null,
      llm,
      active: true,
      context: options.context ?? null,
      userParams,
      assistantParams: options.assistantParams ?? null,
    });
    this._transformOutput = options.transformOutput ?? null;
    this.llm.appendSystemInstruction(options.pairingInstruction ?? BACKEND_PAIRING_INSTRUCTION);

    this.llm.addEventHandler("on_before_process_frame", async (_llm: unknown, frame: Frame) => {
      if (frame instanceof LLMContextFrame) {
        this._runsRequested += 1;
        if (
          this._requestAwaitingRun !== null &&
          frame.context.messages.length > this._requestAwaitingRun
        ) {
          this._requestAwaitingRun = null;
        }
      } else if (frame instanceof InterruptionFrame) {
        // The run in progress, if any, is cancelled by this frame and ends as
        // an interrupted turn, which is not counted as completed; a run queued
        // behind it is dropped. A run that starts after the frame has passed
        // is a new one, so the counters are reset here, as the LLM sees the
        // interruption, and not later at the assistant aggregator, where a
        // reset could erase a run that had just started.
        this._runsRequested = 0;
        this._runsCompleted = 0;
      }
    });

    this.userAggregator.addEventHandler(
      "on_before_process_frame",
      async (_aggregator: unknown, frame: Frame) => {
        if (frame instanceof LLMMessagesAppendFrame && this._requestsPending) {
          this._requestsPending -= 1;
          if (!frame.runLlm) {
            this._requestAwaitingRun = this.context.messages.length;
            // The synchronous call the request was held for may have settled
            // by the time the request lands in the context, as when the model
            // cancelled it with its cancel_<tool> tool meanwhile, so check
            // again whether the request can run now.
            await this._runAwaitingRequest();
          }
        }
      },
    );

    // The backend's function calls are relayed as they pass the assistant
    // aggregator, which every phase of a call reaches.
    this.assistantAggregator.addEventHandler(
      "on_before_process_frame",
      async (_aggregator: unknown, frame: Frame) => {
        await this._onFunctionCallFrame(frame);
      },
    );

    this.assistantAggregator.addEventHandler(
      "on_after_process_frame",
      async (_aggregator: unknown, frame: Frame) => {
        // A FunctionCallResultFrame with runLlm=false may have settled the last
        // synchronous call a waiting request was held for, so the request runs
        // now; one with runLlm=true brings the run itself.
        if (
          (frame instanceof FunctionCallResultFrame &&
            frame.properties !== null &&
            frame.properties.runLlm === false) ||
          frame instanceof FunctionCallCancelFrame
        ) {
          await this._runAwaitingRequest();
          // A call that settles (its result or cancellation arrives) after the
          // last turn stopped may have been the last thing the backend had in
          // flight, so the idle update is sent from here as well as from the
          // end of a turn.
          await this._announceIdleIfDone();
        }
      },
    );

    this.assistantAggregator.addEventHandler(
      "on_assistant_turn_stopped",
      async (_aggregator: unknown, message: AssistantTurnStoppedMessage) => {
        await this._onAssistantTurnStopped(message);
      },
    );

    this.assistantAggregator.addEventHandler(
      "on_assistant_thought",
      async (_aggregator: unknown, message: AssistantThoughtMessage) => {
        await this._onAssistantThought(message);
      },
    );

    this.addEventHandler("on_pipeline_error", async (_worker: unknown, frame: ErrorFrame) => {
      await this._onPipelineError(frame);
    });
  }

  /** Whether the backend has work in hand: a request or run outstanding, or a call in flight. */
  get working(): boolean {
    return (
      this._requestsPending > 0 ||
      this._modelBusy ||
      this.assistantAggregator.hasFunctionCallsInProgress
    );
  }

  /** Whether a run is in progress or queued for the model. */
  protected get _modelBusy(): boolean {
    return this._runsRequested > this._runsCompleted || this.llm.hasQueuedFrame(LLMContextFrame);
  }

  /**
   * What an attached frontend can count on; all of it, for a backend that is
   * an LLM.
   *
   * DIVERGENCE: `capabilities` upstream (see the module notes).
   */
  get backendCapabilities(): Record<string, boolean> {
    return { steering: true, progress: true };
  }

  // -----------------------------------------------------------------------
  // The attached contract
  // -----------------------------------------------------------------------

  /**
   * Attach a frontend: stream everything the backend produces until the job
   * is cancelled.
   *
   * @param message The job request.
   */
  async attachFrontend(message: BusJobRequestMessage): Promise<void> {
    if (this._attached !== null) {
      await this._refuse(message.jobId, "a frontend is already attached");
      return;
    }
    const attached = new _AttachedFrontend({ jobId: message.jobId });
    this._attached = attached;
    await this.sendJobUpdate(message.jobId, {
      type: ATTACHED_UPDATE_TYPE,
      capabilities: this.backendCapabilities,
    });
    try {
      // The attach job ends only when the frontend cancels it, which is how
      // the frontend detaches.
      await attached.detached.wait();
    } finally {
      if (this._attached === attached) {
        this._attached = null;
      }
    }
  }

  /**
   * Put a message to the backend, and say what it was doing when it arrived.
   *
   * @param message The job request; see the class docs for the payload.
   */
  async handleMessage(message: BusJobRequestMessage): Promise<void> {
    if (this._attached === null) {
      await this._refuse(message.jobId, "no frontend is attached; open an attach job first");
      return;
    }
    const request = String(message.payload?.request || "").trim();
    if (!request) {
      await this._refuse(message.jobId, "the message has no request");
      return;
    }
    const status = this.working ? "working" : "idle";
    await this._queueRequest(request);
    await this.sendJobResponse(message.jobId, { backend: status });
  }

  static {
    job({ name: ATTACH_JOB_NAME })(BackendLLMWorker.prototype.attachFrontend);
    job({ name: MESSAGE_JOB_NAME })(BackendLLMWorker.prototype.handleMessage);
  }

  protected async _refuse(jobId: string, reason: string): Promise<void> {
    logger.warning(`Worker '${this.name}': refusing job ${jobId}: ${reason}`);
    await this.sendJobResponse(jobId, { error: reason }, { status: JobStatus.ERROR });
  }

  /**
   * Append a request to the backend's conversation, and run the model on it
   * if it is idle.
   *
   * While a run is in progress or queued, or a synchronous call is in flight,
   * the request asks for no run of its own: the run that follows the current
   * step takes it up (see `_requestAwaitingRun`). A run while a synchronous
   * call is in flight would see the call without its result, which the
   * adapter cannot send as it is.
   */
  protected async _queueRequest(request: string): Promise<void> {
    this._requestsPending += 1;
    this._idleAnnounced = false;
    const runLlm = !this._modelBusy && !this._synchronousCallInFlight;
    if (runLlm) {
      logger.debug(`Worker '${this.name}': running the model on the request`);
    } else {
      logger.debug(
        `Worker '${this.name}': holding the request for the current step ` +
          `(model busy=${pyBool(this._modelBusy)}, synchronous call in flight=${pyBool(this._synchronousCallInFlight)})`,
      );
    }
    const frame = new LLMMessagesAppendFrame({
      messages: [{ role: "user", content: request }],
      runLlm,
    });
    await this.queueFrame(frame);
  }

  /** Whether a synchronous call is in flight, whose result will bring the next run. */
  protected get _synchronousCallInFlight(): boolean {
    return this.assistantAggregator.hasSynchronousFunctionCallsInProgress;
  }

  /** Run the model on a request that was waiting for the current step, if nothing else will. */
  protected async _runAwaitingRequest(): Promise<void> {
    if (this._requestAwaitingRun !== null && !this._modelBusy && !this._synchronousCallInFlight) {
      logger.debug(`Worker '${this.name}': running the model on the request that was held`);
      await this.queueFrame(new LLMRunFrame());
    }
  }

  /**
   * Interrupt the pipeline and cancel every function call in flight.
   *
   * An interruption stops the run in progress and the calls that opt into
   * cancellation on interruption; the async ones, which an interruption
   * leaves running by design, are cancelled on their own. A request not yet
   * taken up is dropped with the interruption, and one held for the current
   * step is let go of, so that neither runs the model on work the frontend
   * has abandoned: the cancellations that follow would otherwise run a held
   * request as they settle.
   */
  protected async _stopWork(reason: string): Promise<void> {
    this._requestsPending = 0;
    this._requestAwaitingRun = null;
    await this.queueFrame(new InterruptionFrame());
    await this.llm.cancelFunctionCalls({ reason });
  }

  // -----------------------------------------------------------------------
  // Outputs
  // -----------------------------------------------------------------------

  /**
   * Send one output of the app's own to the frontend.
   *
   * It reaches the frontend as the model's outputs do, but as given unless
   * asked: `transformOutput` is not applied to it by default. With no
   * frontend attached there is nowhere for it to go, and it is dropped with a
   * warning.
   *
   * @param output The output.
   * @param options.applyTransformOutput Whether to run the output through
   *   `transformOutput` as the model's outputs are. Defaults to false.
   */
  async sendOutput(
    output: BackendOutput,
    options: { applyTransformOutput?: boolean } = {},
  ): Promise<void> {
    if (this._attached === null) {
      logger.warning(`Worker '${this.name}': no frontend to send output to`);
      return;
    }
    // Not passed through transformOutput by default (applyTransformOutput:
    // false), so an app can silence the model's outputs with a
    // transformOutput that drops them and still send outputs of its own, such
    // as from a tool the model calls to talk to the user.
    await this._emit(output, { applyTransformOutput: options.applyTransformOutput ?? false });
  }

  protected async _onAssistantTurnStopped(message: AssistantTurnStoppedMessage): Promise<void> {
    if (message.interrupted) {
      // Text from an interrupted turn is not sent, and the run counters were
      // reset as the LLM saw the InterruptionFrame.
      return;
    }
    this._runsCompleted += 1;
    const text = (message.content || "").trim();
    if (this._attached === null) {
      return;
    }
    try {
      const [note, spoken] = _splitSpoken(text);
      if (note) {
        await this._emit(new BackendOutput({ text: note, prefersSpoken: false }));
      }
      if (spoken) {
        await this._emit(new BackendOutput({ text: spoken, prefersSpoken: true }));
      }
    } catch (e) {
      rethrowIfCancelled(e);
      const error = e instanceof Error ? e.message : String(e);
      logger.error(`Worker '${this.name}': transform_output failed: ${error}`);
      await this._sendUpdate({ type: ERROR_UPDATE_TYPE, error });
    }
    await this._runAwaitingRequest();
    await this._announceIdleIfDone();
  }

  /** Send the idle update once the backend has nothing left to do, once per lull. */
  protected async _announceIdleIfDone(): Promise<void> {
    if (this._attached === null || this.working || this._idleAnnounced) {
      return;
    }
    this._idleAnnounced = true;
    await this._sendUpdate({ type: IDLE_UPDATE_TYPE });
  }

  /** Relay a phase of one of the backend's own function calls as a job update. */
  protected async _onFunctionCallFrame(frame: Frame): Promise<void> {
    let calls: BackendToolCall[] = [];
    if (frame instanceof FunctionCallsStartedFrame) {
      calls = frame.functionCalls.map(
        (call) =>
          new BackendToolCall({
            phase: "started",
            functionName: call.functionName,
            toolCallId: call.toolCallId,
          }),
      );
    } else if (frame instanceof FunctionCallInProgressFrame) {
      calls = [
        new BackendToolCall({
          phase: "in_progress",
          functionName: frame.functionName,
          toolCallId: frame.toolCallId,
          arguments: frame.arguments as Record<string, unknown> | null,
        }),
      ];
    } else if (frame instanceof FunctionCallResultFrame) {
      calls = [
        new BackendToolCall({
          phase: "result",
          functionName: frame.functionName,
          toolCallId: frame.toolCallId,
          arguments: frame.arguments as Record<string, unknown> | null,
          result: frame.result,
          isFinal: frame.properties === null || frame.properties.isFinal,
        }),
      ];
    } else if (frame instanceof FunctionCallCancelFrame) {
      calls = [
        new BackendToolCall({
          phase: "cancelled",
          functionName: frame.functionName,
          toolCallId: frame.toolCallId,
        }),
      ];
    }
    for (const call of calls) {
      await this._sendUpdate(call.toPayload());
    }
  }

  /**
   * Stop the model: the frontend that was attached is gone.
   *
   * The `attach` job's handler is already cancelled by the time this runs,
   * and has let go of the attachment; the work in flight stops too, so none
   * of it is reported after the frontend has let go of it.
   */
  override async onJobCancelled(message: BusJobCancelMessage): Promise<void> {
    const request = this.activeJobs.get(message.jobId);
    if (request !== undefined && request.jobName === ATTACH_JOB_NAME) {
      await this._stopWork("frontend detached");
    }
  }

  /**
   * Tell the frontend the backend cannot go on with what it was doing.
   *
   * A tool handler that raises is the exception. The LLM service reports that
   * as `ErrorCategory.APPLICATION`, settles the call with an error result and
   * carries on, so the model still has something coming.
   */
  protected async _onPipelineError(frame: ErrorFrame): Promise<void> {
    if (frame.category === ErrorCategory.APPLICATION) {
      return;
    }
    if (this._attached !== null) {
      await this._sendUpdate({ type: ERROR_UPDATE_TYPE, error: frame.error });
    }
  }

  protected async _onAssistantThought(message: AssistantThoughtMessage): Promise<void> {
    const text = (message.content || "").trim();
    if (text && this._attached !== null) {
      await this._emit(new BackendOutput({ text, isThought: true, prefersSpoken: false }));
    }
  }

  /** Run an output through `transformOutput`, if there is one. */
  protected async _shape(output: BackendOutput): Promise<BackendOutput | null> {
    if (this._transformOutput === null) {
      return output;
    }
    return await this._transformOutput(output);
  }

  /** Send one output as a job update, after any configured transform. */
  protected async _emit(
    output: BackendOutput,
    options: { applyTransformOutput?: boolean } = {},
  ): Promise<void> {
    const applyTransformOutput = options.applyTransformOutput ?? true;
    const shaped = applyTransformOutput ? await this._shape(output) : output;
    if (shaped !== null) {
      await this._sendUpdate(shaped.toPayload());
    }
  }

  /** Send a job update to the attached frontend. */
  protected async _sendUpdate(payload: Dict): Promise<void> {
    if (this._attached !== null) {
      await this.sendJobUpdate(this._attached.jobId, payload);
    }
  }
}

/** Python-style bool for log lines. */
function pyBool(value: boolean): string {
  return value ? "True" : "False";
}

/** Turn an `attach` stream update into the event it carries, if it carries one. */
export function _eventFromPayload(payload: Dict): BackendEvent | null {
  const updateType = "type" in payload ? payload.type : OUTPUT_UPDATE_TYPE;
  if (updateType === OUTPUT_UPDATE_TYPE) {
    return BackendOutput.fromPayload(payload);
  }
  if (updateType === TOOL_CALL_UPDATE_TYPE) {
    return BackendToolCall.fromPayload(payload);
  }
  if (updateType === IDLE_UPDATE_TYPE) {
    return new BackendIdle();
  }
  if (updateType === ERROR_UPDATE_TYPE) {
    return new BackendError({ error: String(payload.error || "") });
  }
  return null;
}

/**
 * A frontend's side of the attached contract: one worker, attached for the
 * session's life.
 *
 * Opening the session sends the `attach` job; closing it cancels the job,
 * which stops the backend's work. In between, the session is an async
 * iterator over what the backend produces, and `send` puts messages to it.
 * The iteration ends when the backend goes away, with a `JobError` if it
 * failed.
 *
 * @example
 * const session = new _BackendSession(worker, "backend");
 * await session.run(async (session) => {
 *   await session.send(request);
 *   for await (const event of session) {
 *     ...
 *   }
 * });
 */
export class _BackendSession implements AsyncIterableIterator<BackendEvent> {
  protected _worker: BaseWorker;
  protected _backendName: string;
  protected _timeoutSecs: number | null;
  protected _group: JobGroup | null = null;
  protected _capabilities: Record<string, boolean> = {};
  /**
   * Whether the stream ended because this side let go of the backend (the
   * session was closed, or the attaching worker stopped), as opposed to the
   * backend going away.
   */
  detached = false;

  /**
   * Initialize the session.
   *
   * @param worker The worker attaching (for a pipeline processor,
   *   `this.pipelineWorker`).
   * @param backendName Name of the backend worker.
   * @param options.timeoutSecs How long a message may take to be
   *   acknowledged, including the wait for the backend to become ready. The
   *   attachment itself has no timeout. Defaults to 30.
   */
  constructor(
    worker: BaseWorker,
    backendName: string,
    options: { timeoutSecs?: number | null } = {},
  ) {
    this._worker = worker;
    this._backendName = backendName;
    this._timeoutSecs = options.timeoutSecs === undefined ? 30 : options.timeoutSecs;
  }

  /** Name of the backend worker. */
  get backendName(): string {
    return this._backendName;
  }

  /** What the backend said it can do, once its stream has opened. */
  get capabilities(): Record<string, boolean> {
    return this._capabilities;
  }

  /** Open the session (`__aenter__`): send the `attach` job. */
  async enter(): Promise<this> {
    this._group = await this._worker.createJobGroupAndRequestJob([this._backendName], {
      params: new JobGroupParams({ name: ATTACH_JOB_NAME }),
    });
    this._group.eventQueue = new Queue();
    return this;
  }

  /** Leave the session (`__aexit__`): close it. */
  async exit(_error?: unknown): Promise<void> {
    await this.close();
  }

  /**
   * Run `fn` inside the session, as `async with` does: open, run the block,
   * then close (whether or not the block threw).
   */
  async run<R>(fn: (session: this) => Promise<R> | R): Promise<R> {
    await this.enter();
    try {
      return await fn(this);
    } finally {
      await this.exit();
    }
  }

  /** Detach: cancel the `attach` job, which stops the backend's work. */
  async close(): Promise<void> {
    if (this._group && this._worker.jobGroups.has(this._group.jobId)) {
      const jobId = this._group.jobId;
      await shield(() => this._worker.cancelJobGroup(jobId, { reason: "frontend detached" }));
    }
  }

  [Symbol.asyncIterator](): this {
    return this;
  }

  /** The next event from the backend (`__anext__`). */
  async next(): Promise<IteratorResult<BackendEvent>> {
    if (this._group === null || this._group.eventQueue === null) {
      throw new Error("not open");
    }
    const group = this._group;
    const queue = group.eventQueue as NonNullable<JobGroup["eventQueue"]>;
    while (true) {
      const event = await queue.get();
      if (event === null) {
        try {
          await group.wait();
        } catch (e) {
          if (e instanceof JobGroupError) {
            const response = group.responses[this._backendName];
            if (response === undefined) {
              // Cancelled from this side: the session was closed, or the
              // requester's worker stopped.
              this.detached = true;
              return { done: true, value: undefined };
            }
            throw new JobError(_withReason(e.message, response), { cause: e });
          }
          throw e;
        }
        return { done: true, value: undefined };
      }
      if (event.type !== JobEvent.UPDATE || !event.data || Object.keys(event.data).length === 0) {
        continue;
      }
      if (event.data.type === ATTACHED_UPDATE_TYPE) {
        this._capabilities = { ...((event.data.capabilities as Record<string, boolean>) || {}) };
        continue;
      }
      const parsed = _eventFromPayload(event.data);
      if (parsed !== null) {
        return { done: false, value: parsed };
      }
    }
  }

  /**
   * Put a message to the backend.
   *
   * @param request The text to append to the backend's conversation.
   * @returns What the backend was doing when the message arrived: `"idle"` or
   *   `"working"`.
   * @throws JobError If the backend refused the message or did not answer in
   *   time.
   */
  async send(request: string): Promise<string> {
    const params = new JobParams({
      name: MESSAGE_JOB_NAME,
      payload: { request },
      timeout: this._timeoutSecs,
    });
    const response = await this._ask(params);
    return String(response.backend || "idle");
  }

  /**
   * Run one short job on the backend and return its response.
   *
   * @throws JobError If the backend refused, naming its reason, or did not
   *   answer in time.
   */
  protected async _ask(params: JobParams): Promise<Dict> {
    const shortJob = this._worker.job(this._backendName, { params });
    try {
      await shortJob.run(async () => {});
    } catch (e) {
      if (e instanceof JobError) {
        // The job may have failed before it started (no response to read).
        let response: Dict | null = null;
        try {
          response = shortJob.response;
        } catch {
          response = null;
        }
        throw new JobError(_withReason(e.message, response), { cause: e });
      }
      throw e;
    }
    return shortJob.response;
  }
}

/** The job error with the backend's own reason for it, when its response gave one. */
export function _withReason(error: string, response: Dict | null | undefined): string {
  const reason = response?.error;
  return reason ? `${error}: ${reason}` : error;
}
