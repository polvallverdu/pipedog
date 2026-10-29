// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/expressive/spoken.py

/**
 * The expression of the words a TTS service reports speaking.
 *
 * Part of expressive conversation (alpha). A TTS service that reports word
 * timestamps tells which words it has spoken, and Pipecat's word tracking gives
 * each word the stretch of the LLM's text it covers, tags included, as its
 * `rawText`. A word covers the text from the end of the word before it, so
 * tags written between two words arrive with the second.
 *
 * `SpokenExpression` keeps the text sent in one audio context, with the
 * `ExpressionSpan` list `ExpressionFormatter.format` returned for it. Looking
 * up each spoken word's text in it gives the delivery the word is spoken in
 * and the sounds performed before it, which the TTS service reports to clients
 * as the word is spoken.
 *
 * **Alpha.** The tag syntax and these types are likely to change between releases.
 */

import type { TextType } from "../frames/frames.ts";
import { isAlnum } from "../utils/text/alnum_utils.ts";
import { ExpressionSpan } from "./formatter.ts";

/**
 * Tells the delivery and sounds of the words a TTS service reports speaking in one audio context.
 *
 * Each `TTSContext` holds one, so it lasts as long as its audio context.
 * Units are added as they are sent, and words are looked up as they are
 * spoken, in order: each lookup searches from where the last one ended.
 *
 * @example
 * const spoken = new SpokenExpression();
 * spoken.add("<<warm>> It's [[laugh]] ^^back^^ up.", spans);
 *
 * spoken.spoken("<<warm>> It's");
 * // [["warm"], []]
 * spoken.spoken("[[laugh]] ^^back");
 * // [["warm", "emphasis"], [[TextType.EXPRESSION_SOUND, "laugh"]]]
 * spoken.spoken("up.");
 * // [["warm"], []]
 */
export class SpokenExpression {
  protected _text = "";
  protected _spans: ExpressionSpan[] = [];
  // The sounds and pauses already reported, by their index in the spans.
  protected _reported = new Set<number>();
  // How far into the text the service has reported speaking.
  protected _position = 0;
  protected _delivery: string[] = [];

  /** The delivery of the text last reported spoken, or null when no text was added. */
  get delivery(): string[] | null {
    return this._text ? this._delivery : null;
  }

  /**
   * Keep a unit sent to the service, for the words it reports later.
   *
   * Units follow one another in the context's text, and the spans are
   * moved to where the unit falls in it.
   *
   * @param text The unit, as the LLM wrote it.
   * @param spans What each stretch of the unit performs.
   */
  add(text: string, spans: ExpressionSpan[]): void {
    const offset = this._text.length;
    this._text += text;
    for (const span of spans) {
      this._spans.push(
        new ExpressionSpan({
          start: offset + span.start,
          end: offset + span.end,
          delivery: span.delivery,
          sound: span.sound,
        }),
      );
    }
  }

  /**
   * Read the delivery of text the service reports speaking, and the sounds before it.
   *
   * The text's delivery is that of its first letter that falls in words,
   * so a delivery tag's own name, such as `warm` in `"<<warm>> It's"`, isn't
   * taken for a word. A sound already reported by `spokenMarkup` isn't
   * reported again, and one written after the text's last word, such as the
   * laugh in `"back [[laugh]]!"`, is left for the service's markup or the next
   * text to report, since it is performed after the word.
   *
   * @param text The LLM's text it covers, tags included, such as a word's
   *   `rawText`, or a whole sentence's from a service without word timestamps.
   * @returns Its delivery, or null when no text was added, and the sounds and
   *   pauses performed since the text before it, each with its text type and
   *   its text. Text that can't be found keeps the delivery of the text before it.
   */
  spoken(text: string | null): [string[] | null, [TextType, string][]] {
    if (!this._text || !text) {
      return [null, []];
    }
    const start =
      this._position > this._text.length ? -1 : this._text.indexOf(text, this._position);
    if (start < 0) {
      return [this._delivery, []];
    }
    const end = start + text.length;
    let lastWord: number | null = null;
    for (let i = end - 1; i > start - 1; i--) {
      if (this._inWords(i)) {
        lastWord = i;
        break;
      }
    }
    let position = end;
    const sounds: [TextType, string][] = [];
    this._spans.forEach((span, i) => {
      if (
        span.sound &&
        !this._reported.has(i) &&
        this._position <= span.start &&
        span.start < end
      ) {
        if (lastWord !== null && span.start > lastWord) {
          position = Math.min(position, span.start);
          return;
        }
        this._reported.add(i);
        sounds.push(span.sound);
      }
    });
    for (let i = start; i < end; i++) {
      if (!isAlnum(this._text[i])) {
        continue;
      }
      const words = this._spans.find((s) => s.delivery !== null && s.start <= i && i < s.end);
      if (words !== undefined) {
        this._delivery = words.delivery ?? [];
        break;
      }
    }
    this._position = position;
    return [this._delivery, sounds];
  }

  /**
   * Read the sounds and pauses not yet reported, once the context's audio has ended.
   *
   * A sound after the last words, such as the laugh in `"Bye [[laugh]]"`, has
   * no later text to report it, and a service may not report its markup.
   *
   * @returns Each such sound or pause, with its text type and its text.
   */
  unreported(): [TextType, string][] {
    const sounds: [TextType, string][] = [];
    this._spans.forEach((span, i) => {
      if (span.sound && !this._reported.has(i) && span.start >= this._position) {
        this._reported.add(i);
        sounds.push(span.sound);
      }
    });
    return sounds;
  }

  /** Whether the character at `i` is a letter or digit of words, not of a tag. */
  protected _inWords(i: number): boolean {
    return (
      isAlnum(this._text[i]) &&
      this._spans.some((s) => s.delivery !== null && s.start <= i && i < s.end)
    );
  }

  /**
   * Read markup the service reports speaking as a word, such as `[laughs]`.
   *
   * Some services include their markup in their word timestamps. It covers
   * none of the LLM's text, so it has no `rawText`, and is matched by position
   * instead: it stands for the next sound or pause still to be spoken, which
   * is reported with it, at its time, as written in its tag. Markup reached
   * before any sound, such as a delivery's `[warmly]`, stands for none, and
   * isn't spoken:
   *
   * ```
   * spoken.spoken("<<warm>> It's");
   * spoken.spokenMarkup();       // "[laughs]" reported as a word
   * // [TextType.EXPRESSION_SOUND, "laugh"]
   * spoken.spoken("[[laugh]] ^^back");
   * // [["warm", "emphasis"], []]: already reported
   * ```
   *
   * @returns The sound or pause, with its text type, or null when the markup
   *   stands for none.
   */
  spokenMarkup(): [TextType, string] | null {
    for (let i = 0; i < this._spans.length; i++) {
      const span = this._spans[i] as ExpressionSpan;
      if (span.end <= this._position || this._reported.has(i)) {
        continue;
      }
      if (span.sound) {
        this._reported.add(i);
        return span.sound;
      }
      const words = this._text.slice(Math.max(this._position, span.start), span.end);
      if ([...words].some((c) => isAlnum(c))) {
        return null;
      }
    }
    return null;
  }
}
