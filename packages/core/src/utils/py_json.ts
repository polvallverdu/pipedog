// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Python's `json.dumps`, for output that must match upstream byte for byte
 * (wire formats, logged payloads, LLM contexts).
 *
 * `JSON.stringify` differs from Python's defaults in three ways that show up
 * on the wire: separators (`","` vs `", "`, `":"` vs `": "`), `ensure_ascii`
 * (Python escapes everything outside `" "`..`"~"`, DEL included) and float
 * formatting (`1e-05`, `1e+16`). This module reproduces all three.
 *
 * Mapping from Python values:
 * - `None` ↔ `null`/`undefined`; a dict key whose value is `undefined` is
 *   absent (the Python dict would not have it).
 * - `dict` ↔ plain objects (prototype `Object.prototype` or `null`).
 * - An object with `toJSON()` is encoded as what `toJSON()` returns.
 * - Anything else goes to `default` (as `json.dumps(default=...)`) or raises
 *   `TypeError`, as Python does.
 *
 * JS numbers do not distinguish `int` from `float`: integral values are
 * written as ints (`1.0` is written `1`) up to `Number.MAX_SAFE_INTEGER`, and as
 * floats beyond it (pass a `bigint` for a large `int`).
 */

export interface PyJsonDumpsOptions {
  /** Escape non-ASCII characters as `\uXXXX` (Python's default: true). */
  ensureAscii?: boolean;
  /** Called for values that are not JSON; its result is encoded instead. */
  default?: (value: unknown) => unknown;
}

/** A number as Python writes it: `str(int)` for integral values, else `float.__repr__`. */
export function pyNumberRepr(value: number): string {
  if (Number.isNaN(value)) return "NaN";
  if (value === Number.POSITIVE_INFINITY) return "Infinity";
  if (value === Number.NEGATIVE_INFINITY) return "-Infinity";
  // Safe integers print the same as `int` and `float`. Beyond 2**53 a JS number
  // is almost always a float that lost its int-ness; use `bigint` for big ints.
  if (Number.isSafeInteger(value)) return String(value);
  // float.__repr__: fixed notation for exponents in [-4, 16), else `1.5e-05` / `1e+16`.
  const [mantissa, expStr] = value.toExponential().split("e") as [string, string];
  const exp = Number(expStr);
  if (exp >= -4 && exp < 16) return String(value);
  const absExp = Math.abs(exp);
  return `${mantissa}e${exp < 0 ? "-" : "+"}${absExp < 10 ? "0" : ""}${absExp}`;
}

function encodeString(s: string, ensureAscii: boolean): string {
  const json = JSON.stringify(s);
  if (!ensureAscii) return json;
  // Surrogate pairs are escaped one code unit at a time, as Python does.
  return json.replace(/[\u007f-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

function isDict(value: object): value is Record<string, unknown> {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function typeName(value: unknown): string {
  if (typeof value === "object" && value !== null) return value.constructor?.name ?? "object";
  return typeof value;
}

/** `json.dumps(value, ensure_ascii=..., default=...)` with Python's default separators. */
export function pyJsonDumps(value: unknown, options: PyJsonDumpsOptions = {}): string {
  const ensureAscii = options.ensureAscii ?? true;
  const fallback = options.default;
  const seen = new Set<object>();

  const encode = (v: unknown): string => {
    if (v === null || v === undefined) return "null";
    switch (typeof v) {
      case "boolean":
        return v ? "true" : "false";
      case "number":
        return pyNumberRepr(v);
      case "bigint":
        return v.toString();
      case "string":
        return encodeString(v, ensureAscii);
    }
    if (typeof v === "object") {
      const withToJson = v as { toJSON?: () => unknown };
      if (typeof withToJson.toJSON === "function") return encode(withToJson.toJSON());
      if (Array.isArray(v) || isDict(v)) {
        if (seen.has(v)) throw new Error("Circular reference detected");
        seen.add(v);
        try {
          if (Array.isArray(v)) return `[${v.map(encode).join(", ")}]`;
          const entries = Object.entries(v)
            .filter(([, x]) => x !== undefined)
            .map(([k, x]) => `${encodeString(k, ensureAscii)}: ${encode(x)}`);
          return `{${entries.join(", ")}}`;
        } finally {
          seen.delete(v);
        }
      }
    }
    if (fallback) return encode(fallback(v));
    throw new TypeError(`Object of type ${typeName(v)} is not JSON serializable`);
  };

  return encode(value);
}

/**
 * Python's `json.loads`: `JSON.parse`, plus the `NaN`, `Infinity` and
 * `-Infinity` literals Python's encoder writes (and its decoder accepts).
 * Errors are `JSON.parse`'s `SyntaxError`.
 */
export function pyJsonLoads(text: string): unknown {
  if (!/NaN|Infinity/.test(text)) return JSON.parse(text);
  // Rewrite the literals outside string tokens to sentinel strings that
  // cannot occur in the input, then turn those back into numbers.
  let tag = "pyjson";
  while (text.includes(tag)) tag += "_";
  const sentinels: Record<string, number> = {
    [`\u0000${tag}:NaN`]: Number.NaN,
    [`\u0000${tag}:Infinity`]: Number.POSITIVE_INFINITY,
    [`\u0000${tag}:-Infinity`]: Number.NEGATIVE_INFINITY,
  };
  let out = "";
  let i = 0;
  while (i < text.length) {
    const c = text[i] as string;
    if (c === '"') {
      // Copy the string token verbatim.
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    const literal = ["-Infinity", "Infinity", "NaN"].find((l) => text.startsWith(l, i));
    if (literal) {
      out += JSON.stringify(`\u0000${tag}:${literal}`);
      i += literal.length;
      continue;
    }
    out += c;
    i++;
  }
  return JSON.parse(out, (_key, value) =>
    typeof value === "string" && value in sentinels ? sentinels[value] : value,
  );
}
