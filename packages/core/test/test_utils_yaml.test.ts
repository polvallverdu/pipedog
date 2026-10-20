// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_utils_yaml.py

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  addImplicitResolver,
  addIncludeConstructor,
  ConstructorError,
  includeLoader,
  load,
  SafeLoader,
} from "../src/utils/yaml.ts";

// Core has no filesystem access: included files are read with an injected reader.
const readFile = (path: string) => readFileSync(path, "utf8");

function _tmpdir(): string {
  return mkdtempSync(join(tmpdir(), "pipecat-test-"));
}

describe("TestIncludeLoader", () => {
  test("test_include_resolves_relative_to_base_dir", () => {
    const d = _tmpdir();
    writeFileSync(join(d, "fragment.yaml"), "a: 1\nb: two\n", "utf8");

    const data = load("top: !include fragment.yaml\n", includeLoader(d, { readFile }));
    expect(data).toEqual({ top: { a: 1, b: "two" } });
  });

  test("test_nested_include_uses_same_loader", () => {
    const d = _tmpdir();
    mkdirSync(join(d, "sub"));
    writeFileSync(join(d, "leaf.yaml"), "leaf: true\n", "utf8");
    writeFileSync(join(d, "sub", "middle.yaml"), "inner: !include leaf.yaml\n", "utf8");

    // Nested includes resolve against the same base_dir as the top-level
    // document, not against the including file.
    const data = load("outer: !include sub/middle.yaml\n", includeLoader(d, { readFile }));
    expect(data).toEqual({ outer: { inner: { leaf: true } } });
  });

  test("test_include_scalar_document", () => {
    const d = _tmpdir();
    writeFileSync(join(d, "prompt.yaml"), "Say hello, then ask for the order.\n", "utf8");

    const data = load("content: !include prompt.yaml\n", includeLoader(d, { readFile }));
    expect(data).toEqual({ content: "Say hello, then ask for the order." });
  });

  test("test_missing_file_raises", () => {
    const d = _tmpdir();
    // Python's FileNotFoundError is the reader's ENOENT error here.
    let error: unknown;
    try {
      load("x: !include nope.yaml\n", includeLoader(d, { readFile }));
    } catch (e) {
      error = e;
    }
    expect((error as { code?: string } | undefined)?.code).toEqual("ENOENT");
  });

  test("test_non_scalar_node_raises", () => {
    const d = _tmpdir();
    expect(() => load("x: !include [a, b]\n", includeLoader(d, { readFile }))).toThrow(
      ConstructorError,
    );
    expect(() => load("x: !include [a, b]\n", includeLoader(d, { readFile }))).toThrow(
      "expects a file path",
    );
  });

  test("test_base_loader_is_not_mutated", () => {
    const d = _tmpdir();
    includeLoader(d, { readFile });
    expect(() => load("x: !include fragment.yaml\n", SafeLoader)).toThrow(ConstructorError);
  });

  test("test_custom_base_loader_keeps_its_resolvers", () => {
    // A subclass that keeps leading-zero tokens as strings, like the evals
    // scenario loader does for DTMF digits.
    class _DecimalOnly extends SafeLoader {}

    _DecimalOnly.yamlImplicitResolvers = new Map(
      [...SafeLoader.yamlImplicitResolvers].map(([ch, resolvers]) => [
        ch,
        resolvers.filter(([tag]) => tag !== "tag:yaml.org,2002:int"),
      ]),
    );
    addImplicitResolver("tag:yaml.org,2002:int", /^[-+]?(?:0|[1-9][0-9_]*)$/, [..."-+0123456789"], {
      Loader: _DecimalOnly,
    });

    const d = _tmpdir();
    writeFileSync(join(d, "digits.yaml"), "dtmf: 012\n", "utf8");

    const data = load(
      "t: !include digits.yaml\n",
      includeLoader(d, { base: _DecimalOnly, readFile }),
    );
    expect(data).toEqual({ t: { dtmf: "012" } });
  });

  test("test_add_include_constructor_on_explicit_subclass", () => {
    const d = _tmpdir();
    writeFileSync(join(d, "fragment.yaml"), "k: v\n", "utf8");

    class _Loader extends SafeLoader {}

    addIncludeConstructor(_Loader, d, { readFile });
    expect(load("x: !include fragment.yaml\n", _Loader)).toEqual({ x: { k: "v" } });
  });
});
