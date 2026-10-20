// Copyright (c) 2026, pipecat-ts contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Runtime smoke test for tools/compat. Imports the package by name, so on
// workerd the "workerd" export condition (pre-compiled .wasm module import) is
// what gets exercised; elsewhere the default entry compiles the embedded bytes
// synchronously.

import { getSentenceBoundaries, segment } from "@pipecat-ts/sentencex-wasm";

function check(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(`sentencex-wasm smoke: ${message}`);
}

export default async function smoke(): Promise<void> {
  // Synchronous on first use: no init call, no await.
  const text =
    'Dr. Smith met J. R. R. Tolkien at 5 p.m. Then he left. "Stop!" he said. 👋 Ok?\n\nNext.';
  const sentences = segment("en", text);
  const expected = [
    "Dr. Smith met J. R. R. Tolkien at 5 p.m. ",
    "Then he left. ",
    '"Stop!" he said. ',
    "👋 Ok?",
    "\n\n",
    "Next.",
  ];
  check(
    JSON.stringify(sentences) === JSON.stringify(expected),
    `segment: ${JSON.stringify(sentences)}`,
  );

  const bounds = getSentenceBoundaries("en", text);
  check(bounds.length === expected.length, "boundary count");
  for (const b of bounds) {
    check(text.slice(b.start_index, b.end_index) === b.text, `UTF-16 indices for ${b.text}`);
  }
  check(bounds[3]!.boundary_symbol === "?" && bounds[4]!.is_paragraph_break, "boundary fields");
  check(JSON.stringify(segment("ja", "こんにちは。次")) === '["こんにちは。","次"]', "ja");
}
