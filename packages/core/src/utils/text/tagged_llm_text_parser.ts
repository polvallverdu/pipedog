// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/utils/text/tagged_llm_text_parser.py

/**
 * Parse tagged thoughts, such as `<think>...</think>`, out of streamed LLM text.
 *
 * Some models write their reasoning into the answer text, wrapped in tags, ahead
 * of the answer itself. `TaggedLLMTextParser` separates that reasoning
 * from the text that follows so a service can emit it as thoughts rather than as
 * text to speak.
 */

import { isSpace } from "./alnum_utils.ts";

/**
 * The kind of a `TaggedLLMTextParsedOutputChunk`.
 *
 * - `TEXT`: Text outside the thought.
 * - `THOUGHT_START`: The thought began. Its text is empty.
 * - `THOUGHT_TEXT`: Text inside the thought.
 * - `THOUGHT_END`: The thought ended. Its text is empty.
 */
export const TaggedLLMTextParsedOutputChunkKind = {
  TEXT: "text",
  THOUGHT_START: "thought_start",
  THOUGHT_TEXT: "thought_text",
  THOUGHT_END: "thought_end",
} as const;
export type TaggedLLMTextParsedOutputChunkKind =
  (typeof TaggedLLMTextParsedOutputChunkKind)[keyof typeof TaggedLLMTextParsedOutputChunkKind];

export interface TaggedLLMTextParsedOutputChunkOptions {
  /** What the piece is. */
  kind: TaggedLLMTextParsedOutputChunkKind;
  /** The piece's text; empty for `THOUGHT_START` and `THOUGHT_END`. */
  text?: string;
}

/** A categorized piece of text produced by `TaggedLLMTextParser`. */
export class TaggedLLMTextParsedOutputChunk {
  /** What the piece is. */
  kind: TaggedLLMTextParsedOutputChunkKind;
  /** The piece's text; empty for `THOUGHT_START` and `THOUGHT_END`. */
  text: string;

  constructor(options: TaggedLLMTextParsedOutputChunkOptions) {
    this.kind = options.kind;
    this.text = options.text ?? "";
  }
}

const _Kind = TaggedLLMTextParsedOutputChunkKind;

function _chunk(
  kind: TaggedLLMTextParsedOutputChunkKind,
  text = "",
): TaggedLLMTextParsedOutputChunk {
  return new TaggedLLMTextParsedOutputChunk({ kind, text });
}

const _State = {
  DETECTING: "detecting",
  IN_THOUGHT: "in_thought",
  AFTER_THOUGHT: "after_thought",
  CONTENT: "content",
} as const;
type _State = (typeof _State)[keyof typeof _State];

/** Python `str.lstrip()`. */
function lstrip(text: string): string {
  let start = 0;
  while (start < text.length && isSpace(text[start])) start++;
  return text.slice(start);
}

/**
 * Parse a tagged thought out of streamed LLM text.
 *
 * Feed the text chunk by chunk to `parseNextChunk`, which returns the
 * categorized pieces each chunk completes: answer text, or a thought's start,
 * text and end.
 *
 * A thought is recognized only at the start of the text, optionally after
 * whitespace; tags later in the text are passed on as text. Tags may be split
 * across chunks, so the start of the text is held back until it is clear
 * whether it opens a thought, and inside a thought, a possible start of the
 * closing tag is held back. Text that doesn't open with a thought passes
 * through from the first chunk that rules one out, and whitespace between a
 * thought and the text after it is dropped.
 *
 * Call `flush` when the text ends, or `reset` when it is cut
 * short. Either readies the parser for the next text.
 *
 * @example
 * ```ts
 * const parser = new TaggedLLMTextParser("<think>", "</think>");
 * for (const text of ["<thi", "nk>Hmm.</th", "ink> ", "Hello!"]) {
 *   for (const chunk of parser.parseNextChunk(text)) {
 *     // ...
 *   }
 * }
 * for (const chunk of parser.flush()) {
 *   // ...
 * }
 * ```
 */
export class TaggedLLMTextParser {
  protected _openTag: string;
  protected _closeTag: string;
  protected _state: _State;
  protected _buffer: string;

  /**
   * Initialize the parser.
   *
   * @param thoughtOpenTag The tag that opens a thought, e.g. `"<think>"`.
   * @param thoughtCloseTag The tag that closes a thought, e.g. `"</think>"`.
   */
  constructor(thoughtOpenTag: string, thoughtCloseTag: string) {
    this._openTag = thoughtOpenTag;
    this._closeTag = thoughtCloseTag;
    this._state = _State.DETECTING;
    this._buffer = "";
  }

  /**
   * Parse the next chunk of streamed text.
   *
   * @param text The next chunk of streamed text.
   * @returns The pieces this chunk completes, in order.
   */
  parseNextChunk(text: string): TaggedLLMTextParsedOutputChunk[] {
    if (this._state === _State.CONTENT) {
      return [_chunk(_Kind.TEXT, text)];
    }

    const output: TaggedLLMTextParsedOutputChunk[] = [];

    if (this._state === _State.DETECTING) {
      this._buffer += text;
      const head = lstrip(this._buffer);
      if (head.length < this._openTag.length && this._openTag.startsWith(head)) {
        return output;
      }
      if (!head.startsWith(this._openTag)) {
        const passthrough = this._buffer;
        this._buffer = "";
        this._state = _State.CONTENT;
        return [_chunk(_Kind.TEXT, passthrough)];
      }
      output.push(_chunk(_Kind.THOUGHT_START));
      this._buffer = "";
      this._state = _State.IN_THOUGHT;
      text = head.slice(this._openTag.length);
    }

    if (this._state === _State.IN_THOUGHT) {
      this._buffer += text;
      const idx = this._buffer.indexOf(this._closeTag);
      if (idx === -1) {
        // Hold back what could be the start of the closing tag. Counted in
        // code points, as Python's len(), so a surrogate pair is never split.
        const bufferChars = Array.from(this._buffer);
        const safeEnd = bufferChars.length - Array.from(this._closeTag).length + 1;
        if (safeEnd > 0) {
          output.push(_chunk(_Kind.THOUGHT_TEXT, bufferChars.slice(0, safeEnd).join("")));
          this._buffer = bufferChars.slice(safeEnd).join("");
        }
        return output;
      }
      const thought = this._buffer.slice(0, idx);
      if (thought) {
        output.push(_chunk(_Kind.THOUGHT_TEXT, thought));
      }
      output.push(_chunk(_Kind.THOUGHT_END));
      text = this._buffer.slice(idx + this._closeTag.length);
      this._buffer = "";
      this._state = _State.AFTER_THOUGHT;
    }

    // After the thought: drop whitespace until the text resumes.
    text = lstrip(text);
    if (text) {
      this._state = _State.CONTENT;
      output.push(_chunk(_Kind.TEXT, text));
    }
    return output;
  }

  /**
   * End the text, releasing what was held back and closing an open thought.
   *
   * @returns The remaining pieces, in order.
   */
  flush(): TaggedLLMTextParsedOutputChunk[] {
    return this._end({ release: true });
  }

  /**
   * End text that was cut short, e.g. by an interruption or an error.
   *
   * Text still held back is discarded.
   *
   * @returns A `THOUGHT_END` piece if a thought was open, so the caller can
   *   close it; otherwise nothing.
   */
  reset(): TaggedLLMTextParsedOutputChunk[] {
    return this._end({ release: false });
  }

  protected _end(options: { release: boolean }): TaggedLLMTextParsedOutputChunk[] {
    const { release } = options;
    const output: TaggedLLMTextParsedOutputChunk[] = [];
    if (this._state === _State.IN_THOUGHT) {
      if (this._buffer && release) {
        output.push(_chunk(_Kind.THOUGHT_TEXT, this._buffer));
      }
      output.push(_chunk(_Kind.THOUGHT_END));
    } else if (this._state === _State.DETECTING && this._buffer && release) {
      output.push(_chunk(_Kind.TEXT, this._buffer));
    }
    this._buffer = "";
    this._state = _State.DETECTING;
    return output;
  }
}
