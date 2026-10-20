// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/** The public functions, shared by both entries; each entry supplies its own module loader. */

import { compileSync, type SentenceBoundary, SentencexEngine } from "./engine.ts";

export interface SentencexApi {
  segment(language: string, text: string): string[];
  getSentenceBoundaries(language: string, text: string): SentenceBoundary[];
  initSentencex(source?: WebAssembly.Module | BufferSource): SentencexEngine;
  getSentencex(): SentencexEngine;
}

/** @internal */
export function createApi(loadDefault: () => WebAssembly.Module): SentencexApi {
  let engine: SentencexEngine | null = null;

  const getSentencex = (): SentencexEngine => {
    engine ??= new SentencexEngine(loadDefault());
    return engine;
  };

  return {
    segment: (language, text) => getSentencex().segment(language, text),
    getSentenceBoundaries: (language, text) => getSentencex().getSentenceBoundaries(language, text),
    initSentencex(source) {
      if (source === undefined) return getSentencex();
      engine = new SentencexEngine(compileSync(source));
      return engine;
    },
    getSentencex,
  };
}
