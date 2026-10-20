// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/turns/user_stop/eager_match_policy.py

/** Policies deciding whether an eager transcript still matches the committed one. */

// Apostrophes are dropped rather than spaced out, so a service that writes
// "it's" matches one that writes "its".
const APOSTROPHES = /['’ʼ]/gu;
// Python's `[^\w\s]` with re.UNICODE.
const PUNCTUATION = /[^\p{L}\p{N}\p{M}_\s]/gu;
const WHITESPACE = /\s+/gu;

/**
 * Decides whether a speculative response is still the right answer.
 *
 * A speculative response is generated from an eager transcript, before the
 * service commits one. This decides whether the committed transcript is close
 * enough to the eager one for that response to stand.
 */
export abstract class EagerMatchPolicy {
  /**
   * Report whether the committed transcript still matches the eager one.
   *
   * @param eager The transcript the speculative response was generated from.
   * @param final The transcript the service committed to.
   * @returns True to keep the speculative response, false to discard it and
   *   answer the committed transcript instead.
   */
  abstract matches(eager: string, final: string): boolean;
}

/** Keep the response only when the two transcripts are identical. */
export class ExactMatch extends EagerMatchPolicy {
  /** Report whether the two transcripts are identical. */
  matches(eager: string, final: string): boolean {
    return eager === final;
  }
}

/**
 * Keep the response when the transcripts differ only in formatting.
 *
 * Compares with case, punctuation and whitespace removed. Services commonly
 * format the committed transcript — capitalizing it, punctuating it — while
 * leaving the eager one raw, which `ExactMatch` counts as a difference.
 */
export class NormalizedMatch extends EagerMatchPolicy {
  /** Report whether the two transcripts match once formatting is removed. */
  matches(eager: string, final: string): boolean {
    return NormalizedMatch._normalize(eager) === NormalizedMatch._normalize(final);
  }

  protected static _normalize(text: string): string {
    // NFKC + full case folding (Python's casefold); toLowerCase after an
    // uppercase pass approximates folding for the common special cases (ß).
    let normalized = text.normalize("NFKC").toUpperCase().toLowerCase();
    normalized = normalized.replace(APOSTROPHES, "");
    normalized = normalized.replace(PUNCTUATION, " ");
    return normalized.replace(WHITESPACE, " ").trim();
  }
}
