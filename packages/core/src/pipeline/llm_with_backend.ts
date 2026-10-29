// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/pipeline/llm_with_backend.py

/**
 * An LLM with a backend: a conversational frontend delegating the rest.
 *
 * The frontend is any LLM service, text or speech-to-speech, and holds the
 * conversation. The backend is a `BackendLLMWorker` running a heavier model
 * with the tools, and does the work the frontend hands off. `LLMWithBackend`
 * wraps the frontend so the pair drops into a pipeline where an LLM goes, and
 * installs the tools that join them.
 *
 * The two exchange messages. The frontend's `delegate` tool puts a message to
 * the backend and returns at once; what the backend has to say comes back as a
 * stream of outputs, each appended to the frontend's conversation as a message
 * marked `Backend:`, spoken or silent as the backend's flag says. A second
 * request joins the first, and a correction changes or stops it. How a request
 * is worded is the `BackendRequestStrategy`'s business, and the
 * `BackendConnector` owns the tools, the session with the backend, and how
 * each output is rendered into the conversation.
 */

import { Event, rethrowIfCancelled, type Task, TimeoutError, waitFor } from "@pipedog/asyncio";
import { FunctionSchema } from "../adapters/llm/schemas/function_schema.ts";
import { FunctionCallResultProperties, LLMMessagesAppendFrame } from "../frames/frames.ts";
import {
  type LLMContextMessage,
  LLMSpecificMessage,
  type LLMStandardMessage,
} from "../processors/aggregators/llm_context.ts";
import type { FrameProcessorSetup } from "../processors/frame_processor.ts";
import { RTVIServerMessageFrame } from "../processors/frameworks/rtvi/frames.ts";
import {
  type FunctionCallHandler,
  type FunctionCallParams,
  type LLMService,
  NotImplementedError,
} from "../services/llm_service.ts";
import { logger } from "../utils/logger.ts";
import type { BaseWorker } from "../workers/base_worker.ts";
import {
  _BackendSession,
  _renderExplicitRequest,
  _renderTranscriptRequest,
  BackendError,
  type BackendEvent,
  BackendIdle,
  BackendLLMWorker,
  BackendOutput,
  BackendToolCall,
  EXPLICIT_REQUEST_INSTRUCTION,
  TRANSCRIPT_REQUEST_INSTRUCTION,
} from "../workers/llm/backend_llm_worker.ts";
import { Pipeline } from "./pipeline.ts";
import type { PipelineWorker } from "./worker.ts";

type AnyLLMService = LLMService<any>;

/** Name of the tool the frontend calls to delegate. */
export const DELEGATE_TOOL_NAME = "delegate";

/** How a backend output is marked in the frontend's conversation. */
export const BACKEND_MESSAGE_PREFIX = "Backend: ";

/** How a backend reasoning summary is marked in the frontend's conversation. */
export const BACKEND_THOUGHT_PREFIX = "Backend (thinking): ";

/**
 * How a backend note, text its model wrote without the mark that asks for the
 * user to be told it, is marked in the frontend's conversation.
 */
export const BACKEND_NOTE_PREFIX = "Backend (note): ";

/** How a function call the backend is making is marked in the frontend's conversation. */
export const BACKEND_WORKING_PREFIX = "Backend (working): ";

/** Every mark a rendered backend message can open with. */
export const BACKEND_PREFIXES: readonly string[] = [
  BACKEND_MESSAGE_PREFIX,
  BACKEND_THOUGHT_PREFIX,
  BACKEND_NOTE_PREFIX,
  BACKEND_WORKING_PREFIX,
];

/**
 * Carried on each spoken backend message, so the frontend relays it on
 * whatever turn it lands on, a user's turn included, where the standing
 * instruction alone leaves it unsaid.
 */
export const RELAY_NOTE =
  "(Relay this to the user now, in your own words, once, even if the conversation has " +
  "moved on. If the user has just said something you have not answered yet, answer that " +
  "first and relay this at the end of the same reply.)";

/** Where the request strategy's own guidance goes in `FRONTEND_PAIRING_INSTRUCTION`. */
export const STRATEGY_PLACEHOLDER = "{strategy}";

/**
 * How the frontend's model works with a backend, appended to its system
 * instruction: when and how to delegate, that to the user there is one
 * assistant, what to do after delegating, and what to do with the backend's
 * messages. The request strategy's guidance (how the request is worded) goes
 * where `STRATEGY_PLACEHOLDER` stands, inside the delegating paragraph. The
 * frontend's own system instruction says what the backend is for.
 * `new BackendConnector({ frontendPairingInstruction })` replaces it.
 *
 * The order of the paragraphs matters, and the placeholder's place inside the
 * first one: with the one-assistant paragraph first, or the strategy's
 * guidance in a paragraph of its own, gpt-4.1 answers a user's "never mind"
 * with "I won't make any changes" and no delegate call in nearly every run,
 * where this order delegates the stop every time.
 */
export const FRONTEND_PAIRING_INSTRUCTION =
  "DELEGATING: Delegate to the backend when any part of what the user asks needs a backend " +
  "tool or careful reasoning, and whenever the user says anything about work already " +
  "handed over: a change, a narrowing, or calling it off, in any words, even in passing. " +
  "Whether that work goes on is not yours to decide: hand the message over and the " +
  "backend decides. You cannot stop or change that work yourself, and nothing you say " +
  "reaches the backend: only a delegate call does, so saying you will stop without one " +
  "leaves the work running. A request that arrives while the backend is already working " +
  "is delegated like any other. Do not delegate only when the message neither needs " +
  "backend work nor concerns work already handed over: small talk, or a question you can " +
  "answer from a result you already have, or when you need a brief clarification first. " +
  "Delegate before giving any answer that depends on backend work, and do not guess the " +
  "result while waiting. To delegate, call the delegate tool at once, in that same reply, " +
  `and do the rest of the reply yourself around it. ${STRATEGY_PLACEHOLDER}\n\n` +
  "ONE ASSISTANT: To the user there is one assistant, you: never mention the backend, " +
  "delegation, a handoff or tools. Say what is being done as your own doing, such as \"I'm " +
  'checking" or "I\'ve fixed it", never "the backend is checking". A stop or a change you ' +
  "hand over is your own doing too: never say that you passed it along, relayed it, handed " +
  "it over or told anyone.\n\n" +
  "AFTER DELEGATING: Acknowledge briefly, without offering updates or asking whether to " +
  "go ahead, and do whatever else the user asked that you can do yourself. The result says " +
  "whether the backend was idle or already working; if it was working, your request joins " +
  "that work. The backend sees nothing of the conversation but what you delegate, so every " +
  "new request that needs it takes a delegate call of its own, even while it is still " +
  "working on an earlier one; that includes the user saying yes to something you or the " +
  "backend offered to do, and the user calling off or changing work already under way, " +
  "which the backend keeps doing until you hand that over. Saying you will check " +
  "or look into something is not doing it: " +
  "the backend hears nothing until you call delegate, so a reply that promises backend " +
  "work calls delegate in that same reply. When the user asks whether work is under way, " +
  "look at the conversation: if you never delegated it, say it is not started yet and delegate " +
  "it then. When you hand over a stop or a change, the backend stops or changes the work as " +
  "told: tell the user plainly that you are stopping or changing it, and do not promise results " +
  "from work the user called off.\n\n" +
  "BACKEND MESSAGES: The backend works on its own after you delegate and may be doing " +
  "several things at once. What it has to say arrives as messages in the conversation " +
  `marked "${BACKEND_MESSAGE_PREFIX.trim()}": a result, a question for the user, or news ` +
  "worth an update, on whatever turn happens to be in progress by then. Such a message is " +
  "owed to the user, whatever the conversation has moved on to: small talk, other " +
  "questions or a long wait do not make it unwanted. If the user has said something you " +
  "have not answered yet, answer that first, then relay the message at the end of that " +
  "same reply, in your own words. If you have already answered everything the user said, " +
  "relay just the message; do not repeat or rephrase your earlier reply. Relay each " +
  "message once. Only when the user has cancelled or changed what they asked for does a " +
  "message go unsaid, and then say only what still helps. Messages marked " +
  `"${BACKEND_WORKING_PREFIX.trim()}", "${BACKEND_NOTE_PREFIX.trim()}" and ` +
  `"${BACKEND_THOUGHT_PREFIX.trim()}" are what the backend is doing and thinking. They ` +
  "carry no results: what a call found reaches you only in a message marked " +
  `"${BACKEND_MESSAGE_PREFIX.trim()}", so never describe or guess what a call found. Never ` +
  "relay them on their own, but when the user asks how the work is going, answer from the " +
  "latest of them, concretely: name the step, such as which file it is reading or that it " +
  "is running the tests, rather than saying only that it is still working. Never state a " +
  "result you have not received from the backend, and never say work is done that the " +
  "backend has not said is done.";

/** The transcript strategy's guidance, in the pairing instruction's delegating paragraph. */
export const TRANSCRIPT_FRONTEND_INSTRUCTION =
  "A delegation hands over the whole conversation, not one item: the backend reads it and " +
  "does everything in it that is its job, so delegate once per reply however many things " +
  "the user asked for, and do not word the request.";

/** How the transcript strategy describes the `delegate` tool. */
export const TRANSCRIPT_TOOL_DESCRIPTION =
  "Hand the conversation over to the backend, which reads it and does everything in it " +
  "that needs a backend tool or careful reasoning. Call this as soon as any part of what " +
  "the user asks needs that, and do the rest yourself. One handoff per reply, however " +
  "many things the user asked for: two questions, or one question about two places, is " +
  "one handoff. The backend sees nothing but what is handed over, so a request the user " +
  "makes after your last handoff needs a handoff of its own, even while the backend is " +
  "still working, and so does anything the user says about work already handed over: a " +
  "change, a narrowing, or calling it off, in any words. It takes no arguments. Keep " +
  "talking with the user while it works.";

/** The explicit strategy's guidance, in the pairing instruction's delegating paragraph. */
export const EXPLICIT_FRONTEND_INSTRUCTION =
  "Word the request so it stands on its own: the user's goal, the exact " +
  "details they gave and their latest correction, with everything new they asked for in " +
  "the one request, so you delegate once per reply however many things that is. Work " +
  "already handed over stays with the backend: a new request joins it, so do not restate " +
  "earlier requests; a correction names what changes, and a stop names what to stop.";

/** How the explicit strategy describes the `delegate` tool. */
export const EXPLICIT_TOOL_DESCRIPTION =
  "Hand a request to the backend, which does everything in it that needs a backend tool " +
  "or careful reasoning. Call this as soon as any part of what the user asks needs that, " +
  "with the request worded to stand on its own, and do the rest yourself. One call per " +
  "reply, however many things the user asked for: two questions, or one question about " +
  "two places, go in one request. Work already handed over stays with the backend, so " +
  "send only what is new, including anything the user says about that work, such as to " +
  "stop or change it. Keep talking with the user while it works.";

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

/** Approximation of Python's `repr()` for log lines and rendered arguments. */
function repr(value: unknown): string {
  if (value === null || value === undefined) return "None";
  if (typeof value === "string") return reprStr(value);
  if (typeof value === "boolean") return value ? "True" : "False";
  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
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

// ---------------------------------------------------------------------------
// Request strategies: frontend → backend
//
// Two ways for a delegate call to become the backend's request, chosen by
// frontend kind when the app gives none. TranscriptBackendRequestStrategy
// hands over the conversation since the previous delegation: the default for
// a text frontend, whose context is current when the tool runs.
// ExplicitBackendRequestStrategy has the frontend model word the request
// itself: the default for a speech-to-speech frontend, which responds to audio
// before the transcript of that audio reaches its context, so the turns that
// prompted a handoff may not be in the context yet, and a transcript taken
// then would miss them.
// ---------------------------------------------------------------------------

/**
 * Defines the `delegate` tool the frontend calls, and turns a call into the
 * request the backend receives.
 *
 * The tool's parameters are this strategy's to declare, so the connector's
 * handler has one signature and reads whatever was declared back from
 * `params.arguments` in `composeRequest`.
 */
export class BackendRequestStrategy {
  /** JSON-schema properties of the `delegate` tool; empty when it takes none. */
  toolParameters: Record<string, unknown> = {};
  /** Which of the properties are required. */
  toolRequired: string[] = [];
  /**
   * The strategy's guidance to the frontend model, if any: how the request is
   * worded. It goes where the pairing instruction's `STRATEGY_PLACEHOLDER`
   * stands.
   */
  frontendInstruction: string | null = null;
  /** How the `delegate` tool is described to the frontend model. */
  toolDescription = "";
  /**
   * Whether the strategy reads the conversation from the frontend's context,
   * so it needs that context to be current when the `delegate` tool runs. A
   * speech-to-speech frontend's context lags the audio, so the connector
   * refuses such a strategy there.
   */
  requiresContext = false;

  /**
   * Turn a `delegate` call into the text put to the backend.
   *
   * @param params The call, carrying the arguments the tool declared and the
   *   frontend's context.
   * @returns The request text, or null when the call carries nothing new for
   *   the backend, in which case nothing is sent.
   */
  async composeRequest(_params: FunctionCallParams): Promise<string | null> {
    throw new NotImplementedError();
  }
}

export interface TranscriptBackendRequestStrategyOptions {
  /**
   * The strategy's guidance to the frontend model, placed in the pairing
   * instruction: that a delegation hands over the whole conversation, unworded.
   */
  frontendInstruction?: string | null;
  /** How the `delegate` tool is described. */
  toolDescription?: string;
  /** What the backend should do with the transcript, placed after it. */
  requestInstruction?: string;
}

/**
 * Hands the backend the conversation and lets it work out the request.
 *
 * The frontend model calls the tool with no arguments; the request is the
 * transcript of what was said since the previous delegation (the whole
 * conversation the first time), rendered by `_renderTranscriptRequest`. The
 * backend's own messages in the conversation are left out: the backend
 * already has what it said. The default for a text frontend, whose context is
 * current when the tool runs.
 *
 * The cursor assumes the conversation accrues. A rewritten context or a failed
 * delegation's turns are not re-sent; the user's next request carries what
 * matters. A call that finds no new turn since the previous delegation sends
 * nothing.
 */
export class TranscriptBackendRequestStrategy extends BackendRequestStrategy {
  override requiresContext = true;
  protected _requestInstruction: string;
  protected _delegatedThrough = 0;

  /** Initialize the strategy. */
  constructor(options: TranscriptBackendRequestStrategyOptions = {}) {
    super();
    this.frontendInstruction =
      options.frontendInstruction === undefined
        ? TRANSCRIPT_FRONTEND_INSTRUCTION
        : options.frontendInstruction;
    this.toolDescription = options.toolDescription ?? TRANSCRIPT_TOOL_DESCRIPTION;
    this._requestInstruction = options.requestInstruction ?? TRANSCRIPT_REQUEST_INSTRUCTION;
  }

  /** Render the turns since the previous delegation as the request. */
  override async composeRequest(params: FunctionCallParams): Promise<string | null> {
    const messages = params.context.getMessages();
    if (this._delegatedThrough > messages.length) {
      // The context holds fewer messages than the previous delegation read:
      // it was reset since, so the transcript starts from the top.
      this._delegatedThrough = 0;
    }
    // An LLMSpecificMessage, in a service's own format, is not a user or
    // assistant turn, so the transcript leaves it out.
    const conversation = messages
      .slice(this._delegatedThrough)
      .filter((m) => isStandardMessage(m) && !_isBackendMessage(m)) as LLMStandardMessage[];
    const first = this._delegatedThrough === 0;
    this._delegatedThrough = messages.length;
    if (!conversation.some((m) => m.role === "user" || m.role === "assistant")) {
      return null;
    }
    return _renderTranscriptRequest(conversation, {
      instruction: this._requestInstruction,
      first,
    });
  }
}

export interface ExplicitBackendRequestStrategyOptions {
  /**
   * The strategy's guidance to the frontend model, placed in the pairing
   * instruction: how to word the request.
   */
  frontendInstruction?: string | null;
  /** How the `delegate` tool is described. */
  toolDescription?: string;
  /** What the backend should do with the request, placed after it. */
  requestInstruction?: string;
}

/**
 * Has the frontend model word the request itself.
 *
 * The tool takes a `request` argument, which is sent to the backend as it
 * stands. The default for a speech-to-speech frontend, which responds to audio
 * before the transcript of that audio reaches its context, so the turns that
 * prompted a handoff may not be recorded when the tool runs.
 */
export class ExplicitBackendRequestStrategy extends BackendRequestStrategy {
  override toolParameters: Record<string, unknown> = {
    request: {
      type: "string",
      description:
        "What the user is asking for now, self-contained: their goal, the details " +
        "they gave (places, dates, names) and their latest correction, or what they " +
        "said about work already under way, such as to stop it or change it. Work " +
        "already handed over stays with the backend; a new request joins it, so do " +
        "not restate earlier requests.",
    },
  };
  override toolRequired: string[] = ["request"];
  protected _requestInstruction: string;

  /** Initialize the strategy. */
  constructor(options: ExplicitBackendRequestStrategyOptions = {}) {
    super();
    this.frontendInstruction =
      options.frontendInstruction === undefined
        ? EXPLICIT_FRONTEND_INSTRUCTION
        : options.frontendInstruction;
    this.toolDescription = options.toolDescription ?? EXPLICIT_TOOL_DESCRIPTION;
    this._requestInstruction = options.requestInstruction ?? EXPLICIT_REQUEST_INSTRUCTION;
  }

  /** Send the model's request as it stands, with the reporting expectation after it. */
  override async composeRequest(params: FunctionCallParams): Promise<string | null> {
    const raw = params.arguments.request;
    const request = String(raw || "").trim();
    if (!request) {
      return null;
    }
    return _renderExplicitRequest(request, { instruction: this._requestInstruction });
  }
}

/** Whether a context message is a plain (dict) message rather than an LLM-specific one. */
function isStandardMessage(message: LLMContextMessage): message is LLMStandardMessage {
  return (
    message !== null && typeof message === "object" && !(message instanceof LLMSpecificMessage)
  );
}

/** Whether a context message is one the connector rendered from a backend output. */
export function _isBackendMessage(message: LLMContextMessage): boolean {
  if (!isStandardMessage(message)) {
    return false;
  }
  const content = message.content;
  return (
    message.role === "developer" &&
    typeof content === "string" &&
    BACKEND_PREFIXES.some((prefix) => content.startsWith(prefix))
  );
}

// ---------------------------------------------------------------------------
// The connector
// ---------------------------------------------------------------------------

export interface BackendConnectorOptions {
  /** How a `delegate` call becomes the backend's request. Picked by frontend kind when omitted. */
  requestStrategy?: BackendRequestStrategy | null;
  /**
   * How the model works with a backend, appended to its system instruction:
   * `FRONTEND_PAIRING_INSTRUCTION` unless given. One of its own has to say
   * what that one says: when and how to delegate, that to the user there is
   * one assistant, what to do after delegating, and what to do with the
   * backend's messages. The request strategy's guidance goes where
   * `STRATEGY_PLACEHOLDER` stands, or after the text when it has none.
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

  /** Initialize the connector. */
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
    if (pairing.includes(STRATEGY_PLACEHOLDER)) {
      return pairing.replaceAll(STRATEGY_PLACEHOLDER, guidance).replaceAll(" \n", "\n").trim();
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
              content: `${BACKEND_MESSAGE_PREFIX}The work could not be completed.\n\n${RELAY_NOTE}`,
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
   * with `RELAY_NOTE` after it, a silent one as `Backend (note):`, a reasoning
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
      content: `${BACKEND_MESSAGE_PREFIX}${output.text}\n\n${RELAY_NOTE}`,
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

// ---------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------

export interface LLMWithBackendOptions {
  /** The conversational LLM service, text or speech-to-speech. */
  frontend: AnyLLMService;
  /**
   * The backend worker, or the name of one registered elsewhere (in the app,
   * or in another process on a shared bus). A worker given here is added to
   * the pipeline worker at setup.
   */
  backend: BackendLLMWorker | string;
  /** How delegation works. A default `BackendConnector` when omitted. */
  connector?: BackendConnector | null;
}

/**
 * A conversational LLM, kept fast and light, with a backend that does the
 * work it hands off.
 *
 * **Alpha.** The API is unstable: names, arguments, the strategies and the job
 * contract are likely to change between releases.
 *
 * Put it where the LLM goes in a pipeline. It is a `Pipeline`, not an
 * `LLMService`: functions, settings updates, event handlers and a
 * `FlowManager` go on `frontend`. It wraps the frontend service, installs the
 * connector's tools on it as built-in tools, appends the connector's guidance
 * to the frontend's system instruction, adds a local backend worker to the
 * pipeline worker so the app never wires it up, and holds the session with
 * the backend for the pipeline's life. A built-in tool is sent on every
 * inference beside whatever tools the frontend has, and never enters the
 * context's tool set, so a tool change announced to the model never mentions
 * it. The tools are the backend's; the frontend has `delegate` and no more,
 * though a tool it must keep, in its context or configured on the service,
 * stays.
 *
 * The guidance is the connector's pairing instruction (how to work with a
 * backend: when and how to delegate, and what to do with the backend's
 * messages) with the strategy's (how the request is worded) in place. The
 * frontend's own system instruction is the place to say what the backend is
 * for, in plain words, as the backend's own instruction does: no tool names,
 * nothing to update when a tool changes.
 *
 * @example
 * const llm = new LLMWithBackend({
 *   frontend: new OpenAILLMService({ ... }),
 *   backend: new BackendLLMWorker({
 *     llm: new AnthropicLLMService({ ... }),
 *     context: new LLMContext({ tools: [getWeather] }),
 *   }),
 * });
 * const pipeline = new Pipeline([transport.input(), stt, userAgg, llm, tts, transport.output(), assistantAgg]);
 */
export class LLMWithBackend extends Pipeline {
  protected _frontend: AnyLLMService;
  protected _backend: BackendLLMWorker | string;
  protected _connector: BackendConnector;
  protected _sessionTask: Task<unknown> | null = null;

  /**
   * Initialize the service.
   *
   * @throws Error If the frontend service declines the role, or the
   *   connector's request strategy reads the frontend's context and the
   *   frontend is speech-to-speech.
   */
  constructor(options: LLMWithBackendOptions) {
    const { frontend, backend } = options;
    logger.warning("LLMWithBackend is alpha: its API is likely to change between releases.");
    const objection = frontend.llmWithBackendRoleObjection("frontend");
    if (objection) {
      throw new Error(objection);
    }
    const connector = options.connector || new BackendConnector();
    connector.bind(
      new ConnectorContext({
        backendName: typeof backend === "string" ? backend : backend.name,
        frontendIsRealtime: frontend.serviceMetadataFrame().isRealtimeService,
      }),
    );
    const instruction = connector.frontendInstruction;
    if (instruction) {
      frontend.appendSystemInstruction(instruction);
    }
    for (const tool of connector.tools) {
      frontend.registerFunction(tool.name, tool.handler as FunctionCallHandler, {
        cancelOnInterruption: false,
      });
      frontend.getLlmAdapter().builtinTools[tool.name] = tool;
    }
    super([frontend]);
    this._frontend = frontend;
    this._backend = backend;
    this._connector = connector;
  }

  /** The frontend LLM service. */
  get frontend(): AnyLLMService {
    return this._frontend;
  }

  /** The backend worker, or its name. */
  get backend(): BackendLLMWorker | string {
    return this._backend;
  }

  /** The connector joining the two layers. */
  get connector(): BackendConnector {
    return this._connector;
  }

  /** The `delegate` tool installed on the frontend. */
  get tool(): FunctionSchema {
    return this._connector.tool;
  }

  /**
   * Register a local backend worker as a child of the pipeline worker, set up
   * the frontend, and open the session.
   */
  override async setup(setup: FrameProcessorSetup): Promise<void> {
    // Before setting the frontend up: it gets the StartFrame as soon as its
    // own setup is done, and can delegate from then on.
    if (this._backend instanceof BackendLLMWorker) {
      await (setup.pipelineWorker as PipelineWorker).addWorkers(this._backend);
    }
    await super.setup(setup);
    this._sessionTask = this.createTask(
      () => this._connector.runSession(this.pipelineWorker, this._frontend),
      `${this}::backend_session`,
    );
  }

  /** Close the session with the backend, then clean up the frontend. */
  override async cleanup(): Promise<void> {
    if (this._sessionTask !== null) {
      await this.cancelTask(this._sessionTask);
      this._sessionTask = null;
    }
    await super.cleanup();
  }
}
