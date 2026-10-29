// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/adapters/tts/base_expression_adapter.py

/**
 * How a TTS service performs expression tags.
 *
 * Part of expressive conversation (alpha). Each TTS service has an expression
 * adapter, a `BaseExpressionAdapter`, the way each LLM service has an LLM
 * adapter. The adapter declares what the service can perform and formats it
 * into the text sent to the service: words in their delivery, and sounds and
 * pauses. The base adapter performs nothing, so a service without one speaks
 * only the words.
 *
 * **Alpha.** The tag syntax and these types are likely to change between releases.
 */

import { EMPHASIS_DELIVERY, type ExpressionCapabilities } from "../../expressive/expression.ts";

/**
 * Formats expression for one TTS service. The base performs nothing.
 *
 * Its capabilities are what the service can perform: the service broadcasts
 * them at start, and reads and formats tags by them. The service calls the
 * adapter only with what they say it supports: other delivery is taken off
 * the words first, and other sounds are never formatted. Each name reaches the
 * adapter as the service's own: a universal name is translated by the
 * capabilities' `serviceVocabulary` first, so `warm` reaches ElevenLabs'
 * adapter as `warmly`.
 *
 * Markup is set apart from the words by spaces, so the words a service with
 * word timestamps reports line up with the text it was sent.
 */
export class BaseExpressionAdapter {
  /**
   * The expression the service can perform, or null for none.
   *
   * @returns The capabilities, which the service broadcasts at start.
   */
  capabilities(): ExpressionCapabilities | null {
    return null;
  }

  /**
   * Format words to speak in their delivery.
   *
   * @param text The words, as prepared for the service.
   * @param delivery The supported delivery to speak them in, by the service's
   *   names, empty for the voice's baseline.
   * @param previousDelivery The delivery of the words before them in the
   *   response, or null for its first words, so markup can be emitted only
   *   where the delivery changes.
   * @returns The text to send to the service.
   */
  formatText(text: string, _delivery: string[], _previousDelivery: string[] | null): string {
    return text;
  }

  /**
   * Settings to send beside a request's text, for its delivery.
   *
   * For a service that takes some of its expression as request settings
   * rather than as markup in the text, such as a speed. The service merges
   * them into its request; each adapter documents where.
   *
   * @param delivery The supported delivery the request's first words are
   *   spoken in, by the service's names, empty for the voice's baseline.
   * @returns The settings, empty for none.
   */
  requestSettings(_delivery: string[]): Record<string, unknown> {
    return {};
  }

  /**
   * Close a sentence's request, given the delivery its last words are spoken in.
   *
   * For a service whose markup lasts past the request it is sent in, so the
   * request can set the delivery back for the text after it.
   *
   * @param delivery The delivery of the request's last words, by the service's names.
   * @returns The text to end the request with, or an empty string.
   */
  formatEnd(_delivery: string[]): string {
    return "";
  }

  /**
   * Format a supported sound, such as a laugh, at its place in the text.
   *
   * @param name The sound, by the service's name for it.
   * @returns The text to send to the service.
   */
  formatSound(_name: string): string {
    return "";
  }

  /**
   * Format a pause at its place in the text.
   *
   * @param durationMs How long, in milliseconds, within the service's pause range.
   * @returns The text to send to the service.
   */
  formatPause(_durationMs: number): string {
    return "";
  }
}

/**
 * A delivery's names as a provider's tags, for an adapter that writes each as one.
 *
 * Emphasis is left out, since such a provider stresses words its own way.
 *
 * @param delivery The delivery, or null.
 * @param renames The provider's tag for a name it calls something else, such
 *   as `slowly` for `slow`.
 * @returns The tags, in order.
 */
export function deliveryTags(
  delivery: readonly string[] | null,
  renames: Readonly<Record<string, string>>,
): string[] {
  return (delivery ?? [])
    .filter((name) => name !== EMPHASIS_DELIVERY)
    .map((name) => (Object.hasOwn(renames, name) ? (renames[name] as string) : name));
}
