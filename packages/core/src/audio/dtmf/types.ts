// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/audio/dtmf/types.py

/**
 * This module defines generic type for DTMS.
 *
 * It defines the `KeypadEntry` enumeration, representing dual-tone
 * multi-frequency (DTMF) keypad entries for phone system integration. Each
 * entry corresponds to a key on the telephone keypad, facilitating the
 * handling of input in telecommunication applications.
 */

/**
 * DTMF keypad entries for phone system integration.
 *
 * - ONE..NINE, ZERO: number keys.
 * - POUND: pound/hash key (#).
 * - STAR: star/asterisk key (*).
 */
export const KeypadEntry = {
  ONE: "1",
  TWO: "2",
  THREE: "3",
  FOUR: "4",
  FIVE: "5",
  SIX: "6",
  SEVEN: "7",
  EIGHT: "8",
  NINE: "9",
  ZERO: "0",

  POUND: "#",
  STAR: "*",
} as const;
export type KeypadEntry = (typeof KeypadEntry)[keyof typeof KeypadEntry];
