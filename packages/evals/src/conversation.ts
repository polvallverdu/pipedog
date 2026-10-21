// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/evals/conversation.py

/**
 * A conversation between a user and a bot, as a conversation file holds it.
 *
 * A conversation file is a JSON list of messages, in the order they happened:
 *
 * - `{"role": "user", "content": ...}`: what the user said in one turn.
 * - `{"role": "assistant", "content": ...}`: everything the bot said between
 *   two user turns, however turn detection or a function call split it. A turn
 *   in which the bot said nothing is not a turn, so the Nth assistant message is
 *   bot turn N, the turn a metric's verdict names.
 * - `{"role": "tool_call", "name": ..., "arguments": {...}, "cancelled": ...}`:
 *   a function the bot called, placed before the bot turn it was made in.
 *
 * The file holds what each side said and the calls the bot made, which is what
 * the judge reads. It has no system prompt, no tool results, and no timing. The
 * harness saves one for every simulation run, and `EvalConversationObserver`
 * records one from a bot's own pipeline.
 *
 * @example
 * ```json
 * [
 *   {"role": "assistant", "content": "Hi, how can I help?"},
 *   {"role": "user", "content": "A table for four on Friday, please."},
 *   {"role": "tool_call", "name": "check_availability",
 *    "arguments": {"day": "Friday", "party_size": 4}, "cancelled": false},
 *   {"role": "assistant", "content": "Let me check. Friday at seven works."}
 * ]
 * ```
 */

/** One message of a conversation file (see the module docs for its shapes). */
export type EvalConversationMessage = Record<string, unknown> & { role: string };

// Python's `str.isspace()` characters (JS `\s` adds U+FEFF and lacks U+001C-U+001F, U+0085).
const PY_WHITESPACE =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: Python's isspace() includes U+001C-U+001F.
  /^[\t\n\v\f\r \x1c-\x1f\x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+|[\t\n\v\f\r \x1c-\x1f\x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/g;

/** Python's `str.strip()` with no argument. */
function pyStrip(text: string): string {
  return text.replace(PY_WHITESPACE, "");
}

/**
 * Builds a conversation's messages as the conversation happens.
 *
 * The user's turns and the bot's calls are added as they come. What the bot
 * says gathers into its current turn, which the next user turn, or
 * `endBotTurn`, closes.
 */
export class EvalConversation {
  protected _messages: EvalConversationMessage[] = [];
  protected _botSaid: string[] = [];

  /** The messages so far, without the bot's turn in progress. */
  get messages(): EvalConversationMessage[] {
    return [...this._messages];
  }

  /** Whether a user turn is the last thing said, with nothing from the bot since. */
  get userSpokeLast(): boolean {
    const said = this._messages.filter((m) => m.role !== "tool_call");
    return this._botSaid.length === 0 && said.length > 0 && said[said.length - 1]!.role === "user";
  }

  /** Add a user turn, which ends the bot's turn; empty text only ends the bot's turn. */
  addUserMessage(text: string): void {
    this.endBotTurn();
    const stripped = pyStrip(text);
    if (stripped) {
      this._messages.push({ role: "user", content: stripped });
    }
  }

  /** Add a segment of what the bot said to its current turn. */
  addAssistantMessage(text: string): void {
    const stripped = pyStrip(text);
    if (stripped) {
      this._botSaid.push(stripped);
    }
  }

  /** Add a function the bot called. */
  addToolCall(name: string, args: Record<string, unknown>): void {
    this._messages.push({ role: "tool_call", name, arguments: { ...args }, cancelled: false });
  }

  /** Mark the bot's latest call to `name` that is not cancelled yet as cancelled. */
  cancelToolCall(name: string): void {
    for (let i = this._messages.length - 1; i >= 0; i--) {
      const message = this._messages[i]!;
      if (message.role === "tool_call" && message.name === name && !message.cancelled) {
        message.cancelled = true;
        break;
      }
    }
  }

  /** End the bot's turn: what it said since the user last spoke becomes one message. */
  endBotTurn(): void {
    const text = this._botSaid.join(" ");
    this._botSaid.length = 0;
    if (text) {
      this._messages.push({ role: "assistant", content: text });
    }
  }
}
