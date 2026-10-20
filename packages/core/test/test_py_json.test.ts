// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Expected strings were produced by CPython's json.dumps.

import { describe, expect, test } from "bun:test";
import { pyJsonDumps, pyNumberRepr } from "../src/utils/py_json.ts";

const CASES: [unknown, string, string][] = [
  [null, "null", "null"],
  [true, "true", "true"],
  [0, "0", "0"],
  [-3, "-3", "-3"],
  [1.5, "1.5", "1.5"],
  [0.1, "0.1", "0.1"],
  [1e-5, "1e-05", "1e-05"],
  [1.5e-7, "1.5e-07", "1.5e-07"],
  [123456789.125, "123456789.125", "123456789.125"],
  [Number.NaN, "NaN", "NaN"],
  [Number.POSITIVE_INFINITY, "Infinity", "Infinity"],
  [Number.NEGATIVE_INFINITY, "-Infinity", "-Infinity"],
  [
    'h\u00e9llo \u007f \u2028 \ud83d\ude00 "q" \\ \n\t\u0001',
    '"h\\u00e9llo \\u007f \\u2028 \\ud83d\\ude00 \\"q\\" \\\\ \\n\\t\\u0001"',
    '"héllo    😀 \\"q\\" \\\\ \\n\\t\\u0001"',
  ],
  [[1, [2, {}]], "[1, [2, {}]]", "[1, [2, {}]]"],
  [
    { a: 1, ñ: "ü", n: null, l: [true, 1.25] },
    '{"a": 1, "\\u00f1": "\\u00fc", "n": null, "l": [true, 1.25]}',
    '{"a": 1, "ñ": "ü", "n": null, "l": [true, 1.25]}',
  ],
];

describe("pyJsonDumps", () => {
  test("matches json.dumps", () => {
    for (const [value, ascii] of CASES) expect(pyJsonDumps(value)).toBe(ascii);
  });

  test("matches json.dumps(ensure_ascii=False)", () => {
    for (const [value, , unicode] of CASES) {
      expect(pyJsonDumps(value, { ensureAscii: false })).toBe(unicode);
    }
  });

  test("drops undefined dict values and encodes toJSON()", () => {
    expect(pyJsonDumps({ a: undefined, b: { toJSON: () => [1] } })).toBe('{"b": [1]}');
  });

  test("raises TypeError for non-JSON values unless default is given", () => {
    class Thing {}
    expect(() => pyJsonDumps({ t: new Thing() })).toThrow(
      "Object of type Thing is not JSON serializable",
    );
    expect(pyJsonDumps({ t: new Thing() }, { default: () => "thing" })).toBe('{"t": "thing"}');
  });

  test("rejects circular references", () => {
    const a: unknown[] = [];
    a.push(a);
    expect(() => pyJsonDumps(a)).toThrow("Circular reference detected");
  });

  test("pyNumberRepr uses float.__repr__ exponents", () => {
    expect(pyNumberRepr(1.5e300)).toBe("1.5e+300");
    expect(pyNumberRepr(0.0001)).toBe("0.0001");
    expect(pyJsonDumps(2n ** 60n)).toBe("1152921504606846976");
  });
});
