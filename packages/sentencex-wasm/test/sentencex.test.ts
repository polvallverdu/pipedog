// Copyright (c) 2026, pipecat-ts contributors
// SPDX-License-Identifier: BSD-2-Clause

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  get_sentence_boundaries,
  getSentenceBoundaries,
  getSentencex,
  initSentencex,
  SentencexEngine,
  segment,
} from "../src/index.ts";
import { WASM_BASE64, WASM_SIZE } from "../src/wasm_bytes.ts";

const wasmFile = new URL("../wasm/sentencex.wasm", import.meta.url);

describe("segment", () => {
  test("English abbreviations, times and quotes", () => {
    expect(segment("en", "Dr. Smith arrived at 5 p.m. He was late.")).toEqual([
      "Dr. Smith arrived at 5 p.m. ",
      "He was late.",
    ]);
    expect(segment("en", '"Stop!" he said. The car halted.')).toEqual([
      '"Stop!" he said. ',
      "The car halted.",
    ]);
  });

  test("is synchronous and lossless", () => {
    const text = "One. Two!\n\nThree? 👋 Four… five.";
    const out = segment("en", text);
    expect(Array.isArray(out)).toBe(true);
    expect(out.join("")).toBe(text);
  });

  test("empty and whitespace-only input", () => {
    expect(segment("en", "")).toEqual([]);
    expect(getSentenceBoundaries("en", "")).toEqual([]);
    expect(segment("en", "   ").join("")).toBe("   ");
  });

  test("unknown languages fall back (to English)", () => {
    expect(segment("xx", "Hello. Next")).toEqual(segment("en", "Hello. Next"));
  });

  test("rejects non-strings", () => {
    expect(() => segment("en", 42 as unknown as string)).toThrow(TypeError);
  });
});

describe("getSentenceBoundaries", () => {
  test("indices are JavaScript (UTF-16) string indices", () => {
    const text = "Hi 👋. 𝔘𝔫𝔦. Café é.\n\n日本語。😀 end";
    const bounds = getSentenceBoundaries("en", text);
    let at = 0;
    for (const b of bounds) {
      expect(b.start_index).toBe(at);
      expect(text.slice(b.start_index, b.end_index)).toBe(b.text);
      at = b.end_index;
    }
    expect(at).toBe(text.length);
    expect(bounds.map((b) => b.text)).toEqual([
      "Hi 👋. ",
      "𝔘𝔫𝔦. ",
      "Café é.",
      "\n\n",
      "日本語。",
      "😀 end",
    ]);
    expect(bounds[1]).toEqual({
      start_index: 7,
      end_index: 15,
      text: "𝔘𝔫𝔦. ",
      boundary_symbol: ".",
      is_paragraph_break: false,
    });
    expect(bounds[3]!.is_paragraph_break).toBe(true);
    expect(bounds[3]!.boundary_symbol).toBeNull();
    expect(bounds[4]!.boundary_symbol).toBe("。");
  });

  test("get_sentence_boundaries is the same function", () => {
    expect(get_sentence_boundaries).toBe(getSentenceBoundaries);
  });
});

describe("module loading", () => {
  test("embedded bytes match the committed wasm/sentencex.wasm", () => {
    const file = readFileSync(wasmFile);
    expect(WASM_SIZE).toBe(file.length);
    expect(WASM_BASE64).toBe(file.toString("base64"));
  });

  test("the module has no imports and exports only the C ABI (plus linker symbols)", () => {
    const module = new WebAssembly.Module(readFileSync(wasmFile));
    expect(WebAssembly.Module.imports(module)).toEqual([]);
    expect(
      WebAssembly.Module.exports(module)
        .map((e) => e.name)
        .filter((n) => !n.startsWith("__"))
        .sort(),
    ).toEqual(["memory", "sx_alloc", "sx_boundaries", "sx_free", "sx_out", "sx_segment"]);
  });

  test("initSentencex accepts bytes or a Module and keeps the API synchronous", () => {
    const before = getSentencex();
    try {
      const fromBytes = initSentencex(readFileSync(wasmFile));
      expect(fromBytes).toBeInstanceOf(SentencexEngine);
      expect(getSentencex()).toBe(fromBytes);
      const fromModule = initSentencex(new WebAssembly.Module(readFileSync(wasmFile)));
      expect(fromModule.segment("en", "One. Two.")).toEqual(["One. ", "Two."]);
      expect(initSentencex()).toBe(fromModule);
    } finally {
      initSentencex(before.module);
    }
  });

  test("many calls do not leak linear memory", () => {
    const engine = new SentencexEngine(getSentencex().module);
    const text = "Dr. Smith arrived at 5 p.m. He was late. 👋 ".repeat(50);
    for (let i = 0; i < 20; i++) {
      engine.segment("en", text);
      engine.getSentenceBoundaries("en", text);
    }
    const warm = engine.memoryBytes;
    for (let i = 0; i < 2000; i++) {
      engine.segment("en", text);
      engine.getSentenceBoundaries("en", text);
    }
    expect(engine.memoryBytes).toBe(warm);
  });
});
