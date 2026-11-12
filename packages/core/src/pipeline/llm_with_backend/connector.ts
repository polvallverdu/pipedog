// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/pipeline/llm_with_backend/connector.py

/**
 * The connector, which joins a frontend to its backend.
 *
 * `BackendConnector` owns the tools the frontend calls, the session with the
 * backend, and how each backend output is rendered into the frontend's
 * conversation.
 */

import { Event, rethrowIfCancelled, TimeoutError, waitFor } from "@pipedog/asyncio";
import { FunctionSchema } from "../../adapters/llm/schemas/function_schema.ts";
import { FunctionCallResultProperties, LLMMessagesAppendFrame } from "../../frames/frames.ts";
import type { LLMContextMessage } from "../../processors/aggregators/llm_context.ts";
import { RTVIServerMessageFrame } from "../../processors/frameworks/rtvi/frames.ts";
import type { FunctionCallParams, LLMService } from "../../services/llm_service.ts";
import { logger } from "../../utils/logger.ts";
import { pyNumberRepr } from "../../utils/py_json.ts";
import type { BaseWorker } from "../../workers/base_worker.ts";
import {
  _BackendSession,
  BackendError,
  type BackendEvent,
  BackendIdle,
  BackendOutput,
  BackendToolCall,
} from "../../workers/llm/backend_llm_worker.ts";
import {
  BACKEND_MESSAGE_PREFIX,
  BACKEND_MESSAGE_RELAY_INSTRUCTION,
  BACKEND_NOTE_PREFIX,
  BACKEND_THOUGHT_PREFIX,
  BACKEND_WORKING_PREFIX,
  FRONTEND_PAIRING_INSTRUCTION,
  PAIRING_INSTRUCTION_STRATEGY_PLACEHOLDER,
} from "./prompts.ts";
import {
  type BackendRequestStrategy,
  ExplicitBackendRequestStrategy,
  TranscriptBackendRequestStrategy,
} from "./request_strategies.ts";

type AnyLLMService = LLMService<any>;

/** Name of the tool the frontend calls to delegate. */
export const DELEGATE_TOOL_NAME = "delegate";

/** Python's `repr()` of a string: single-quoted unless it holds only single quotes. */
function reprStr(s: string): string {
  const quote = s.includes("'") && !s.includes('"') ? '"' : "'";
  let out = "";
  for (const ch of s) {
    if (ch === "\\") out += "\\\\";
    else if (ch === quote) out += `\\${ch}`;
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (ch < " " || ch === "\x7f")
      out += `\\x${ch.charCodeAt(0).toString(16).padStart(2, "0")}`;
    else out += ch;
  }
  return `${quote}${out}${quote}`;
}

/** Python's `repr()` of JSON-like values, for log lines and rendered arguments. */
function repr(value: unknown): string {
  if (value === null || value === undefined) return "None";
  if (typeof value === "string") return reprStr(value);
  if (typeof value === "boolean") return value ? "True" : "False";
  if (typeof value === "number") {
    if (Number.isNaN(value)) return "nan";
    if (value === Number.POSITIVE_INFINITY) return "inf";
    if (value === Number.NEGATIVE_INFINITY) return "-inf";
    return pyNumberRepr(value);
  }
  if (Array.isArray(value)) return `[${value.map((v) => repr(v)).join(", ")}]`;
  if (typeof value === "object") {
    const proto = Object.getPrototypeOf(value);
    if (proto === Object.prototype || proto === null) {
      const items = Object.entries(value as Record<string, unknown>).map(
        ([k, v]) => `${reprStr(k)}: ${repr(v)}`,
      );
      return `{${items.join(", ")}}`;
    }
  }
  return String(value);
}

export interface ConnectorContextOptions {
  /** Name of the backend worker, local or registered elsewhere. */
  backendName: string;
  /** Whether the frontend is a speech-to-speech service. */
  frontendIsRealtime: boolean;
}

/**
 * What a connector needs to know about the layers it joins.
 *
 * - `backendName`: name of the backend worker, local or registered elsewhere.
 * - `frontendIsRealtime`: whether the frontend is a speech-to-speech service,
 *   whose context can lag the audio, which changes how a delegation words its
 *   request.
 */
export class ConnectorContext {
  backendName: string;
  frontendIsRealtime: boolean;

  constructor(options: ConnectorContextOptions) {
    this.backendName = options.backendName;
    this.frontendIsRealtime = options.frontendIsRealtime;
  }
}

export interface BackendConnectorOptions {
  /** How a `delegate` call becomes the backend's request. Picked by frontend kind when omitted. */
  requestStrategy?: BackendRequestStrategy | null;
  /**
   * How the model works with a backend, appended to its system instruction:
   * `FRONTEND_PAIRING_INSTRUCTION` unless given (both constants named here
   * are in `pipeline/llm_with_backend/prompts`). One of its own has to say
   * what that one says: when and how to delegate, that to the user there is
   * one assistant, what to do after delegating, and what to do with the
   * backend's messages. The request strategy's guidance goes where
   * `PAIRING_INSTRUCTION_STRATEGY_PLACEHOLDER` stands, or after the text when it has none.
   */
  frontendPairingInstruction?: string;
  /**
   * Whether the frontend runs again as soon as a delegation is sent, which is
   * where its acknowledgement comes from: a text model's tool-call turn
   * carries no prose. Off for a frontend that announces a handoff itself.
   * Defaults to true.
   */
  respondOnDelegate?: boolean;
  /**
   * How long the backend may take to acknowledge a message, including the
   * wait for it to become ready. Defaults to 30.
   */
  timeoutSecs?: number | null;
  /**
   * Whether to send every exchange with the backend to the client as an RTVI
   * server message (`type` `"llm-with-backend"`): each request, output,
   * tool-call phase, error and idle. For debugging; a client's event log shows
   * them. Defaults to false.
   */
  clientTrace?: boolean;
}

/**
 * Joins the two layers: the tools the frontend calls, the session with the
 * backend, and what each output becomes.
 *
 * A request strategy defines the `delegate` tool and composes the request. It
 * may be given, or left to the connector to pick by frontend kind once bound:
 * `TranscriptBackendRequestStrategy` for a text frontend,
 * `ExplicitBackendRequestStrategy` for a speech-to-speech one, whose context
 * lags the audio. A given strategy that reads the frontend's context
 * (`BackendRequestStrategy.requiresContext`) is refused for a speech-to-speech
 * frontend.
 *
 * The connector holds the session with the backend for the frontend's life,
 * and turns each output the backend sends into a message appended to the
 * frontend's conversation with `renderOutput`, run or not as the output's
 * `prefersSpoken` flag says. The function calls the backend makes on the way
 * are reported in the frontend's pipeline for clients to show; nothing else in
 * the pipeline sees them.
 *
 * @example
 * const connector = new BackendConnector({ respondOnDelegate: false });
 */
export class BackendConnector {
  protected _requestStrategy: BackendRequestStrategy | null;
  protected _frontendPairingInstruction: string;
  protected _respondOnDelegate: boolean;
  protected _timeoutSecs: number | null;
  protected _clientTrace: boolean;
  protected _context: ConnectorContext | null = null;
  protected _tools: FunctionSchema[] = [];
  protected _session: _BackendSession | null = null;
  protected _sessionOpen = new Event();

  /**
   * Initialize the connector.
   *
   * @param options See `BackendConnectorOptions`.
   */
  constructor(options: BackendConnectorOptions = {}) {
    this._requestStrategy = options.requestStrategy ?? null;
    this._frontendPairingInstruction =
      options.frontendPairingInstruction ?? FRONTEND_PAIRING_INSTRUCTION;
    this._respondOnDelegate = options.respondOnDelegate ?? true;
    this._timeoutSecs = options.timeoutSecs === undefined ? 30 : options.timeoutSecs;
    this._clientTrace = options.clientTrace ?? false;
  }

  /** The request strategy in use. Available once bound. */
  get requestStrategy(): BackendRequestStrategy {
    if (this._requestStrategy === null) throw new Error("connector not bound");
    return this._requestStrategy;
  }

  /** The tools to install on the frontend. Available once bound. */
  get tools(): FunctionSchema[] {
    if (this._tools.length === 0) throw new Error("connector not bound");
    return this._tools;
  }

  /** The `delegate` tool. Available once bound. */
  get tool(): FunctionSchema {
    return this.tools[0] as FunctionSchema;
  }

  /**
   * What is appended to the frontend's system instruction: the pairing
   * instruction with the strategy's guidance in place. Available once bound.
   */
  get frontendInstruction(): string | null {
    const pairing = this._frontendPairingInstruction;
    const guidance = this.requestStrategy.frontendInstruction || "";
    if (pairing.includes(PAIRING_INSTRUCTION_STRATEGY_PLACEHOLDER)) {
      return pairing
        .replaceAll(PAIRING_INSTRUCTION_STRATEGY_PLACEHOLDER, guidance)
        .replaceAll(" \n", "\n")
        .trim();
    }
    return [pairing, guidance].filter((p) => p).join("\n\n") || null;
  }

  /** The session with the backend, while one is open. */
  get session(): _BackendSession | null {
    return this._session;
  }

  /**
   * Settle the strategy for the layers being joined and build the tools.
   *
   * @param context The layers.
   * @throws Error If the frontend is speech-to-speech and the strategy reads
   *   the frontend's context, which lags the audio there.
   */
  bind(context: ConnectorContext): void {
    this._context = context;
    if (this._requestStrategy === null) {
      this._requestStrategy = context.frontendIsRealtime
        ? new ExplicitBackendRequestStrategy()
        : new TranscriptBackendRequestStrategy();
    }
    if (context.frontendIsRealtime && this._requestStrategy.requiresContext) {
      throw new Error(
        `${this._requestStrategy.constructor.name} reads the conversation from the ` +
          "frontend's context, which lags the audio on a speech-to-speech frontend. " +
          "Use a request strategy that doesn't read the context, such as " +
          "ExplicitBackendRequestStrategy.",
      );
    }
    this._tools = this.buildTools();
  }

  /**
   * Build the tools to install on the frontend: `delegate`.
   *
   * Override to install tools of another shape entirely; the service reads
   * nothing else from the connector but `frontendInstruction`.
   *
   * @returns The tools, each carrying its handler.
   */
  buildTools(): FunctionSchema[] {
    const delegate = async (params: FunctionCallParams): Promise<void> => {
      await this.delegate(params);
    };

    return [
      new FunctionSchema({
        name: DELEGATE_TOOL_NAME,
        description: this.requestStrategy.toolDescription,
        properties: this.requestStrategy.toolParameters,
        required: this.requestStrategy.toolRequired,
        handler: delegate,
      }),
    ];
  }

  /**
   * Hold the session with the backend, delivering what it produces, until cancelled.
   *
   * @param worker The pipeline worker the frontend runs in.
   * @param frontend The frontend service, which takes the deliveries.
   */
  async runSession(worker: BaseWorker, frontend: AnyLLMService): Promise<void> {
    const context = this._context;
    if (context === null) throw new Error("connector not bound");
    try {
      const session = new _BackendSession(worker, context.backendName, {
        timeoutSecs: this._timeoutSecs,
      });
      await session.run(async (session) => {
        this._session = session;
        this._sessionOpen.set();
        for await (const event of session) {
          await this.deliver(frontend, event);
        }
        if (!session.detached) {
          logger.warning(`Backend '${context.backendName}' went away`);
        }
      });
    } catch (e) {
      rethrowIfCancelled(e);
      logger.error(
        `The session with backend '${context.backendName}' failed: ${e instanceof Error ? e.message : e}`,
      );
    } finally {
      this._session = null;
      this._sessionOpen.clear();
    }
  }

  /** The session, once it is open; waits for it up to the timeout. */
  protected async _openSession(): Promise<_BackendSession> {
    if (this._session === null) {
      try {
        await waitFor(() => this._sessionOpen.wait(), this._timeoutSecs);
      } catch (e) {
        if (e instanceof TimeoutError) {
          throw new Error("the backend is not attached");
        }
        throw e;
      }
    }
    if (this._session === null) throw new Error("the backend is not attached");
    return this._session;
  }

  /**
   * Put the request a `delegate` call carries to the backend, and settle the call at once.
   *
   * @param params The `delegate` call.
   */
  async delegate(params: FunctionCallParams): Promise<void> {
    const context = this._context;
    if (context === null) throw new Error("connector not bound");
    const request = await this.requestStrategy.composeRequest(params);
    if (request === null) {
      // No turns since the previous delegation: the backend already has
      // everything the transcript would carry, so nothing is sent.
      logger.debug(`Delegate call ${params.toolCallId} carries nothing new; not sent`);
      await params.resultCallback(
        { status: "already_delegated" },
        { properties: new FunctionCallResultProperties({ runLlm: false }) },
      );
      return;
    }
    logger.debug(`Delegating to '${context.backendName}': ${repr(request)}`);
    const session = await this._openSession();
    const status = await session.send(request);
    await this._trace(params.llm, { event: "request", text: request, backend: status });
    await params.resultCallback(
      { status: "delegated", backend: status },
      { properties: new FunctionCallResultProperties({ runLlm: this._respondOnDelegate }) },
    );
  }

  /**
   * Deliver one thing the backend produced to the frontend.
   *
   * An output becomes a message appended to the frontend's conversation, which
   * runs the frontend when the output asks to be spoken. A function call phase
   * is reported as the `ExternalFunctionCall*Frame` for it, which the RTVI
   * observer turns into function-call events. An error becomes a spoken
   * message, so the user hears the work stopped. The appended messages are
   * uninterruptible: one queued while the bot speaks waits behind that speech,
   * and an interruption clears the speech but must leave the message to be
   * recorded.
   *
   * @param frontend The frontend service.
   * @param event What the backend produced.
   */
  async deliver(frontend: AnyLLMService, event: BackendEvent): Promise<void> {
    if (event instanceof BackendOutput) {
      await this._trace(frontend, {
        event: "output",
        text: event.text,
        spoken: event.prefersSpoken,
        thought: event.isThought,
      });
      logger.debug(
        `Backend output (${event.prefersSpoken ? "spoken" : "silent"}` +
          `${event.isThought ? ", thought" : ""}): ${repr(event.text)}`,
      );
      const message = this.renderOutput(event);
      if (message !== null) {
        await this._append(
          frontend,
          new LLMMessagesAppendFrame({ messages: [message], runLlm: event.prefersSpoken }),
        );
      }
    } else if (event instanceof BackendToolCall) {
      await this._trace(frontend, {
        event: "tool_call",
        phase: event.phase,
        name: event.functionName,
        arguments: event.arguments,
        result: event.result,
      });
      await frontend.pushFrame(event.toFrame());
      const message = this.renderToolCall(event);
      if (message !== null) {
        await this._append(
          frontend,
          new LLMMessagesAppendFrame({ messages: [message], runLlm: false }),
        );
      }
    } else if (event instanceof BackendError) {
      await this._trace(frontend, { event: "error", error: event.error });
      logger.warning(`Backend error: ${event.error}`);
      await this._append(
        frontend,
        new LLMMessagesAppendFrame({
          messages: [
            {
              role: "developer",
              content: `${BACKEND_MESSAGE_PREFIX}The work could not be completed.\n\n${BACKEND_MESSAGE_RELAY_INSTRUCTION}`,
            },
          ],
          runLlm: true,
        }),
      );
    } else if (event instanceof BackendIdle) {
      await this._trace(frontend, { event: "idle" });
      logger.debug("Backend is idle");
    }
  }

  /** Send one exchange with the backend to the client, when tracing is on. */
  protected async _trace(frontend: AnyLLMService, data: Record<string, unknown>): Promise<void> {
    if (this._clientTrace) {
      await frontend.pushFrame(
        new RTVIServerMessageFrame({ data: { type: "llm-with-backend", ...data } }),
      );
    }
  }

  /** Queue a message into the frontend's conversation, past any interruption on the way. */
  protected async _append(frontend: AnyLLMService, frame: LLMMessagesAppendFrame): Promise<void> {
    frame.interruptible = false;
    await frontend.queueFrame(frame);
  }

  /**
   * Render a backend output as the message the frontend's conversation takes in.
   *
   * Override for another wording, role, or to leave some outputs out by
   * returning null. The default marks the message so the frontend can tell it
   * from the user's and its own, and so the transcript request strategy can
   * leave it out of what it sends the backend: a spoken output as `Backend:`
   * with `BACKEND_MESSAGE_RELAY_INSTRUCTION` after it, a silent one as `Backend (note):`, a reasoning
   * summary as `Backend (thinking):`.
   *
   * @param output The output.
   * @returns The message, or null to deliver nothing for this output.
   */
  renderOutput(output: BackendOutput): LLMContextMessage | null {
    if (!output.text) {
      return null;
    }
    if (output.isThought) {
      return { role: "developer", content: `${BACKEND_THOUGHT_PREFIX}${output.text}` };
    }
    if (!output.prefersSpoken) {
      return { role: "developer", content: `${BACKEND_NOTE_PREFIX}${output.text}` };
    }
    return {
      role: "developer",
      content: `${BACKEND_MESSAGE_PREFIX}${output.text}\n\n${BACKEND_MESSAGE_RELAY_INSTRUCTION}`,
    };
  }

  /**
   * Render a phase of a backend function call as a message the frontend's
   * conversation takes in, silently.
   *
   * The default records each call as it starts, with its arguments, so the
   * frontend can say what the backend is doing if asked; the other phases are
   * not recorded. Override to record more, less, or nothing.
   *
   * @param call The phase of the call.
   * @returns The message, or null to record nothing for this phase.
   */
  renderToolCall(call: BackendToolCall): LLMContextMessage | null {
    if (call.phase !== "in_progress") {
      return null;
    }
    const args = Object.entries(call.arguments ?? {})
      .map(([k, v]) => `${k}=${repr(v)}`)
      .join(", ");
    return {
      role: "developer",
      content: `${BACKEND_WORKING_PREFIX}${call.functionName}(${args})`,
    };
  }
}
