// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/pipeline/llm_with_backend/request_strategies.py

/**
 * Request strategies: how a `delegate` call becomes the backend's request.
 *
 * A `BackendRequestStrategy` defines the `delegate` tool the frontend calls
 * and turns each call into the request the backend receives. There are two,
 * chosen by frontend kind when the app gives none.
 * `TranscriptBackendRequestStrategy` hands over the conversation since the
 * previous delegation: the default for a text frontend, whose context is
 * current when the tool runs. `ExplicitBackendRequestStrategy` has the
 * frontend model word the request itself: the default for a speech-to-speech
 * frontend, which responds to audio before the transcript of that audio
 * reaches its context, so the turns that prompted a handoff may not be in the
 * context yet, and a transcript taken then would miss them.
 */

import type { LLMStandardMessage } from "../../processors/aggregators/llm_context.ts";
import { type FunctionCallParams, NotImplementedError } from "../../services/llm_service.ts";
import {
  _renderExplicitRequest,
  _renderTranscriptRequest,
  EXPLICIT_REQUEST_INSTRUCTION,
  TRANSCRIPT_REQUEST_INSTRUCTION,
} from "../../workers/llm/backend_llm_worker.ts";
import {
  _isBackendMessage,
  _isStandardMessage,
  EXPLICIT_FRONTEND_INSTRUCTION,
  EXPLICIT_TOOL_DESCRIPTION,
  TRANSCRIPT_FRONTEND_INSTRUCTION,
  TRANSCRIPT_TOOL_DESCRIPTION,
} from "./prompts.ts";

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
   * worded. It goes where the pairing instruction's
   * `PAIRING_INSTRUCTION_STRATEGY_PLACEHOLDER` stands.
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
   * Whether a `delegate` call has to carry arguments for the request to be
   * built. Predictive delegation makes its `delegate` call with none, so it
   * works only with a strategy that sets this false.
   */
  delegateNeedsArguments = true;

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
  override delegateNeedsArguments = false;
  protected _requestInstruction: string;
  protected _delegatedThrough = 0;

  /**
   * Initialize the strategy.
   *
   * @param options See `TranscriptBackendRequestStrategyOptions`.
   */
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
      .filter((m) => _isStandardMessage(m) && !_isBackendMessage(m)) as LLMStandardMessage[];
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

  /**
   * Initialize the strategy.
   *
   * @param options See `ExplicitBackendRequestStrategyOptions`.
   */
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
