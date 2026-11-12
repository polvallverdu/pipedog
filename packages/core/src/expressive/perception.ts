// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/expressive/perception.py

/**
 * Perception: how the user said what they said.
 *
 * Part of expressive conversation, which lets an agent hear how something was
 * said and answer in kind. A perception producer, such as an STT service or a
 * processor after it, reads each user turn and sets what it perceives as the
 * transcription's `perception`: signals, such as a tone with the likeliest
 * labels and how sure it is of each, or a measure such as speech rate. It
 * declares the signals it reports with `PerceptionCapabilities`, and
 * broadcasts them at start in a `PerceptionMetadataFrame`, so the LLM can be
 * told how to read them.
 *
 * **Alpha.** These types are likely to change between releases.
 */

export interface PerceptionSignalOptions {
  /** What is read, such as `"tone"` or `"speech_rate"`. */
  name: string;
  /**
   * The likeliest labels, likeliest first, each with how sure the reading is,
   * from 0 to 1, such as `[["frustrated", 0.86], ["neutral", 0.10]]`. Empty
   * for a signal read as a value.
   */
  labels?: [string, number][];
  /**
   * The measure, for a signal read as a value, such as words per second. Null
   * for a signal read as labels.
   */
  value?: number | null;
}

/**
 * One reading of how the user spoke.
 *
 * A signal is read either as labels or as a value.
 */
export class PerceptionSignal {
  /** What is read, such as `"tone"` or `"speech_rate"`. */
  name: string;
  /** The likeliest labels, likeliest first, each with how sure the reading is. */
  labels: [string, number][];
  /** The measure, for a signal read as a value, or null. */
  value: number | null;

  constructor(options: PerceptionSignalOptions) {
    this.name = options.name;
    this.labels = options.labels ?? [];
    this.value = options.value ?? null;
  }
}

export interface PerceptionTermOptions {
  /** The signal's name, as in `PerceptionSignal.name`. */
  name: string;
  /** A short line on how to read it, such as its unit or range, or empty. */
  description?: string;
  /**
   * The labels it can report, for a signal read as labels, or empty for a
   * signal read as a value.
   */
  labels?: string[];
}

/** One signal a perception producer reports. */
export class PerceptionTerm {
  /** The signal's name, as in `PerceptionSignal.name`. */
  name: string;
  /** A short line on how to read it, or empty. */
  description: string;
  /** The labels it can report, or empty for a signal read as a value. */
  labels: string[];

  constructor(options: PerceptionTermOptions) {
    this.name = options.name;
    this.description = options.description ?? "";
    this.labels = options.labels ?? [];
  }
}

export interface PerceptionCapabilitiesOptions {
  /** Each signal the producer can report. */
  signals?: PerceptionTerm[];
}

/** The signals a perception producer reports. */
export class PerceptionCapabilities {
  /** Each signal the producer can report. */
  signals: PerceptionTerm[];

  constructor(options: PerceptionCapabilitiesOptions = {}) {
    this.signals = options.signals ?? [];
  }
}

/** Python's `format(value, ".2f")`: two decimals, an exact tie rounded to even. */
function formatFixed2(value: number): string {
  // toFixed rounds an exact tie (such as 0.125) away from zero; Python rounds it to
  // even. Only a value in eighths can be an exact tie at two decimals.
  if (Number.isInteger(value * 8)) {
    const scaled = value * 100;
    if (Math.abs(scaled % 1) === 0.5) {
      const down = Math.trunc(scaled);
      const even = down % 2 === 0 ? down : down + Math.sign(scaled);
      return (even / 100).toFixed(2);
    }
  }
  return value.toFixed(2);
}

/** Python's `format(value, "g")`: six significant digits, trailing zeros removed. */
function formatG(value: number): string {
  if (Number.isNaN(value)) return "nan";
  if (!Number.isFinite(value)) return value > 0 ? "inf" : "-inf";
  if (value === 0) return Object.is(value, -0) ? "-0" : "0";
  const [mantissa, exponentText] = value.toExponential(5).split("e") as [string, string];
  const exponent = Number(exponentText);
  const strip = (s: string) => (s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s);
  if (exponent < -4 || exponent >= 6) {
    const sign = exponent < 0 ? "-" : "+";
    return `${strip(mantissa)}e${sign}${String(Math.abs(exponent)).padStart(2, "0")}`;
  }
  return strip(value.toFixed(5 - exponent));
}

/**
 * Format a reading as written at the head of the user's message to the LLM.
 *
 * Each signal is a category in brackets: its labels with their confidences,
 * so the LLM can tell a clear reading from a guess, or its measure as a
 * value. `([tone frustrated=0.86, neutral=0.10],[speech_rate value=4.1])`.
 *
 * @param signals The signals read.
 * @returns The formatted reading.
 */
export function formatPerception(signals: PerceptionSignal[]): string {
  const category = (signal: PerceptionSignal): string => {
    let pairs: string;
    if (signal.labels.length > 0) {
      pairs = signal.labels
        .map(([label, confidence]) => `${label}=${formatFixed2(confidence)}`)
        .join(", ");
    } else {
      if (signal.value === null) {
        throw new TypeError("unsupported format string passed to NoneType.__format__");
      }
      pairs = `value=${formatG(signal.value)}`;
    }
    return `[${signal.name} ${pairs}]`;
  };
  return `(${signals.map((signal) => category(signal)).join(",")})`;
}
