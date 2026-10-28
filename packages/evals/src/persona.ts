// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/evals/persona.py

/**
 * The simulated caller: who they are, what they want, and how they end the call.
 *
 * An `EvalPersona` is the instruction the persona LLM runs under, the
 * LLM service itself, which rides in the eval pipeline, and the context it
 * runs on, where the bot's turns are the `user` messages and its own the
 * `assistant` ones. The context offers one tool, `end_call`, which the
 * persona calls once its goal is achieved or clearly out of reach; its
 * `success` claim is its own view, and the judge decides the outcome.
 */

import { FunctionSchema } from "@pipedog/core/adapters/llm/schemas/function_schema";
import { ToolsSchema } from "@pipedog/core/adapters/llm/schemas/tools_schema";
import { LLMContextFrame } from "@pipedog/core/frames/frames";
import { LLMContext } from "@pipedog/core/processors/aggregators/llm_context";
import type { FunctionCallParams, LLMService } from "@pipedog/core/services/llm_service";

export const END_CALL_FUNCTION = "end_call";

export const END_CALL_SCHEMA = new FunctionSchema({
  name: END_CALL_FUNCTION,
  description:
    "Hang up the phone. This is the only way to end the call; saying goodbye " +
    "does not end it. Call it as soon as your goal is achieved, or as soon as " +
    "it is clear the assistant cannot help you achieve it. A short goodbye may " +
    "be spoken in the same turn.",
  properties: {
    success: {
      type: "boolean",
      description: "Whether you achieved your goal on this call.",
    },
    reason: {
      type: "string",
      description: "One sentence on why you are ending the call.",
    },
  },
  required: ["success", "reason"],
});

function instructionTemplate(persona: string, goal: string, endCall: string): string {
  return (
    "You are playing a person on a phone call with a voice assistant. Stay in " +
    "character throughout; never mention being simulated, a test, or an AI.\n" +
    "\n" +
    `Who you are: ${persona}\n` +
    "\n" +
    `What you want from this call: ${goal}\n` +
    "\n" +
    "The assistant's words arrive as the user's messages. Reply with only what you " +
    "would say next: one short spoken turn, in the first person, in plain sentences " +
    "(no lists, markdown, or stage directions). Ask for or give one thing at a time, " +
    "as a real caller would, and do not repeat what the assistant has already " +
    "understood.\n" +
    "\n" +
    "Saying goodbye does not hang up: the call ends only when you call the " +
    `${endCall} tool. As soon as your goal is achieved, or it is clear the ` +
    `assistant cannot help, call ${endCall} with whether you succeeded and why. You ` +
    "may say one short goodbye sentence in the same turn, but you must make the call."
  );
}

/** The simulated caller: its instruction, its LLM, and the context it runs on. */
export class EvalPersona {
  protected _description: string;
  protected _goal: string;
  protected _llm: LLMService;
  protected _context: LLMContext;
  // What the persona has heard of the bot's current turn (text mode).
  protected _heard: string[] = [];
  protected _callsInProgress = 0;
  protected _hungUp = false;

  /**
   * Initialize the persona.
   *
   * @param description Who the caller is, as free text.
   * @param goal What the caller wants from the call.
   * @param llm The LLM service that plays the caller, run inside the eval pipeline.
   */
  constructor(description: string, goal: string, llm: LLMService) {
    this._description = description;
    this._goal = goal;
    this._llm = llm;
    this._context = new LLMContext({
      tools: new ToolsSchema({ standardTools: [END_CALL_SCHEMA] }),
    });
  }

  /** The system instruction the persona LLM runs under. */
  get instruction(): string {
    return instructionTemplate(this._description, this._goal, END_CALL_FUNCTION);
  }

  /** The LLM service that plays the caller, a processor in the eval pipeline. */
  get llm(): LLMService {
    return this._llm;
  }

  /** The context the persona runs on, with the `end_call` tool; empty until the call starts. */
  get context(): LLMContext {
    return this._context;
  }

  /** Whether the persona has ended its part of the call. */
  get hungUp(): boolean {
    return this._hungUp;
  }

  /** End the persona's part of the call: it answers nothing more. */
  hangUp(): void {
    this._hungUp = true;
  }

  /**
   * Take in one of the bot's events; the frame that has the persona answer, once the bot's turn is done.
   *
   * A response the bot gives while one of its function calls is still
   * running is held and joined with the response after the call, so the
   * persona answers the bot's whole turn rather than its "let me check".
   * In audio mode the aggregator does this instead.
   *
   * @param event An event from the stream.
   * @returns The context frame to push to the persona LLM, or null.
   */
  hear(event: Record<string, unknown>): LLMContextFrame | null {
    if (this._hungUp) {
      return null;
    }
    switch (event.type) {
      case "function_call":
        this._callsInProgress += 1;
        break;
      case "function_call_stopped":
        this._callsInProgress = Math.max(0, this._callsInProgress - 1);
        break;
      case "llm_response": {
        const text = event.text as string | null | undefined;
        if (text) {
          this._heard.push(text);
        }
        if (this._callsInProgress || this._heard.length === 0) {
          return null;
        }
        const heard = this._heard.join(" ");
        this._heard = [];
        this._context.addMessage({ role: "user", content: heard });
        return new LLMContextFrame({ context: this._context });
      }
    }
    return null;
  }

  /**
   * Register what happens when the persona calls `end_call`.
   *
   * @param handler Awaited with the call's params; its `success` and `reason`
   *   arguments are the persona's own claim.
   */
  onEndCall(handler: (params: FunctionCallParams) => Promise<void>): void {
    this._llm.registerFunction(END_CALL_FUNCTION, handler);
  }
}
