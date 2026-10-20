// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/utils/yaml.py

/**
 * YAML loading helpers shared across Pipecat's YAML-based configuration.
 *
 * The main helper is `includeLoader`, which builds a loader class that
 * understands an `!include <relative-path>` tag so a document can pull in
 * other files:
 *
 * ```yaml
 * judge: !include judge_audio.yaml
 * task_messages: !include prompts/greeting.yaml
 * ```
 *
 * Include paths are not confined to the base directory; `..` and absolute
 * paths reach anywhere the process can read. Use these loaders only on
 * trusted documents.
 *
 * Porting notes: upstream builds on PyYAML's loader classes. `SafeLoader`,
 * `load()` and `addImplicitResolver()` here reproduce the parts of PyYAML's
 * safe loader that these helpers rely on, on top of the `yaml` package's
 * parser: YAML 1.1 implicit resolvers (so `yes` is a boolean and `012` an
 * octal int, as with `yaml.safe_load`), per-class constructors and resolvers
 * that subclasses copy on write, and `ConstructorError` for unknown tags.
 * Core has no filesystem access, so the include constructor reads files with
 * an injected `readFile` (e.g. `(p) => readFileSync(p, "utf8")` from
 * `node:fs`, or a lookup in bundled files on Workers). It is synchronous
 * because YAML constructors are.
 */

import { rethrowIfCancelled } from "@pipedog/asyncio";
import {
  type Alias,
  type Document,
  isAlias,
  isMap,
  isPair,
  isScalar,
  isSeq,
  parseDocument,
  type Scalar,
  type Node as YamlAstNode,
} from "yaml";

const TAG = "tag:yaml.org,2002:";

/** Position of a node in its document (0-based line and column, like PyYAML's `Mark`). */
export interface YamlMark {
  line: number;
  column: number;
}

/** Base class of the errors raised while loading YAML (`yaml.YAMLError`). */
export class YAMLError extends Error {
  override name = "YAMLError";
}

/** A YAML error tied to a place in the document (`yaml.MarkedYAMLError`). */
export class MarkedYAMLError extends YAMLError {
  override name = "MarkedYAMLError";
  readonly problem: string;
  readonly problemMark: YamlMark | null;

  constructor(problem: string, problemMark: YamlMark | null = null) {
    super(
      problemMark
        ? `${problem}\n  in "<unicode string>", line ${problemMark.line + 1}, column ${problemMark.column + 1}`
        : problem,
    );
    this.problem = problem;
    this.problemMark = problemMark;
  }
}

/** The document is not valid YAML (`yaml.parser.ParserError` / `yaml.scanner.ScannerError`). */
export class ParserError extends MarkedYAMLError {
  override name = "ParserError";
}

/** A node could not be turned into a value (`yaml.constructor.ConstructorError`). */
export class ConstructorError extends MarkedYAMLError {
  override name = "ConstructorError";
}

/** A scalar node (`yaml.ScalarNode`). `value` is its text. */
export class ScalarNode {
  readonly isScalar = true;
  readonly tag: string;
  readonly value: string;
  readonly startMark: YamlMark | null;
  /** How the scalar was written: `null` when plain, else `'`, `"`, `|` or `>`. */
  readonly style: string | null;

  constructor(tag: string, value: string, startMark: YamlMark | null, style: string | null = null) {
    this.tag = tag;
    this.value = value;
    this.startMark = startMark;
    this.style = style;
  }
}

/** A sequence node (`yaml.SequenceNode`). */
export class SequenceNode {
  readonly isScalar = false;
  readonly tag: string;
  readonly value: YamlNode[];
  readonly startMark: YamlMark | null;

  constructor(tag: string, value: YamlNode[], startMark: YamlMark | null) {
    this.tag = tag;
    this.value = value;
    this.startMark = startMark;
  }
}

/** A mapping node (`yaml.MappingNode`). `value` holds the key and value nodes in order. */
export class MappingNode {
  readonly isScalar = false;
  readonly tag: string;
  value: [YamlNode, YamlNode][];
  readonly startMark: YamlMark | null;

  constructor(tag: string, value: [YamlNode, YamlNode][], startMark: YamlMark | null) {
    this.tag = tag;
    this.value = value;
    this.startMark = startMark;
  }
}

/** A YAML node, as handed to a constructor. */
export type YamlNode = ScalarNode | SequenceNode | MappingNode;

/** A tag constructor registered on a loader class. */
export type YamlConstructor = (loader: SafeLoader, node: YamlNode) => unknown;

/**
 * Implicit resolvers by the first character of the plain scalars they apply
 * to (`""` for the empty scalar, `null` for any): `[tag, pattern]` pairs,
 * tried in order.
 */
export type YamlImplicitResolvers = Map<string | null, [string, RegExp][]>;

/** The loader-class shape the helpers work with (a `yaml.SafeLoader` subclass upstream). */
export interface YamlLoaderClass {
  new (stream: string): SafeLoader;
  yamlConstructors: Map<string, YamlConstructor>;
  yamlImplicitResolvers: YamlImplicitResolvers;
  /** Register a constructor for a tag on this loader class. */
  addConstructor(tag: string, fn: YamlConstructor): void;
  /** Register an implicit resolver on this loader class. */
  addImplicitResolver(tag: string, regexp: RegExp, first: Iterable<string> | null): void;
}

// --- Construction of the safe types (PyYAML's SafeConstructor) ---------------

const BOOL_VALUES: Record<string, boolean> = {
  yes: true,
  no: false,
  true: true,
  false: false,
  on: true,
  off: false,
};

/** `int(digits, base)` of a sexagesimal (`1:30`) or plain number, sign excluded. */
function sexagesimal(value: string, parse: (part: string) => number): number {
  let base = 1;
  let result = 0;
  for (const part of value.split(":").reverse()) {
    result += parse(part) * base;
    base *= 60;
  }
  return result;
}

function constructYamlInt(loader: SafeLoader, node: YamlNode): number {
  let value = String(loader.constructScalar(node)).replaceAll("_", "");
  let sign = 1;
  if (value[0] === "-") sign = -1;
  if (value[0] === "-" || value[0] === "+") value = value.slice(1);
  if (value === "0") return 0;
  if (value.startsWith("0b")) return sign * Number.parseInt(value.slice(2), 2);
  if (value.startsWith("0x")) return sign * Number.parseInt(value.slice(2), 16);
  if (value[0] === "0") return sign * Number.parseInt(value, 8);
  if (value.includes(":")) return sign * sexagesimal(value, (p) => Number.parseInt(p, 10));
  return sign * Number.parseInt(value, 10);
}

function constructYamlFloat(loader: SafeLoader, node: YamlNode): number {
  let value = String(loader.constructScalar(node)).replaceAll("_", "").toLowerCase();
  let sign = 1;
  if (value[0] === "-") sign = -1;
  if (value[0] === "-" || value[0] === "+") value = value.slice(1);
  if (value === ".inf") return sign * Number.POSITIVE_INFINITY;
  if (value === ".nan") return Number.NaN;
  if (value.includes(":")) return sign * sexagesimal(value, (p) => Number.parseFloat(p));
  return sign * Number.parseFloat(value);
}

function constructYamlBinary(loader: SafeLoader, node: YamlNode): Uint8Array {
  const text = String(loader.constructScalar(node)).replace(/\s+/g, "");
  let binary: string;
  try {
    binary = atob(text);
  } catch (e) {
    rethrowIfCancelled(e);
    throw new ConstructorError(`failed to decode base64 data: ${text}`, node.startMark);
  }
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

const TIMESTAMP =
  /^([0-9][0-9][0-9][0-9])-([0-9][0-9]?)-([0-9][0-9]?)(?:(?:[Tt]|[ \t]+)([0-9][0-9]?):([0-9][0-9]):([0-9][0-9])(?:\.([0-9]*))?(?:[ \t]*(Z|([-+])([0-9][0-9]?)(?::([0-9][0-9]))?))?)?$/;

/** Timestamps become `Date`s (upstream: `date` or `datetime`), in UTC unless an offset is given. */
function constructYamlTimestamp(loader: SafeLoader, node: YamlNode): Date {
  const m = TIMESTAMP.exec(String(loader.constructScalar(node)));
  if (!m) throw new ConstructorError("invalid timestamp", node.startMark);
  const [, y, mo, d, h, mi, s, frac, , sign, tzh, tzm] = m;
  const ms = frac ? Number(`0.${frac}`) * 1000 : 0;
  let time = Date.UTC(
    Number(y),
    Number(mo) - 1,
    Number(d),
    Number(h ?? 0),
    Number(mi ?? 0),
    Number(s ?? 0),
    ms,
  );
  if (sign) {
    const offset = (Number(tzh) * 60 + Number(tzm ?? 0)) * 60_000;
    time -= sign === "-" ? -offset : offset;
  }
  return new Date(time);
}

function constructUndefined(_loader: SafeLoader, node: YamlNode): never {
  throw new ConstructorError(
    `could not determine a constructor for the tag '${node.tag}'`,
    node.startMark,
  );
}

// --- Implicit resolvers (PyYAML's Resolver) -----------------------------------

const DEFAULT_RESOLVERS: [string, RegExp, string[]][] = [
  [
    `${TAG}bool`,
    /^(?:yes|Yes|YES|no|No|NO|true|True|TRUE|false|False|FALSE|on|On|ON|off|Off|OFF)$/,
    [..."yYnNtTfFoO"],
  ],
  [
    `${TAG}float`,
    /^(?:[-+]?(?:[0-9][0-9_]*)\.[0-9_]*(?:[eE][-+][0-9]+)?|\.[0-9][0-9_]*(?:[eE][-+][0-9]+)?|[-+]?[0-9][0-9_]*(?::[0-5]?[0-9])+\.[0-9_]*|[-+]?\.(?:inf|Inf|INF)|\.(?:nan|NaN|NAN))$/,
    [..."-+0123456789."],
  ],
  [
    `${TAG}int`,
    /^(?:[-+]?0b[0-1_]+|[-+]?0[0-7_]+|[-+]?(?:0|[1-9][0-9_]*)|[-+]?0x[0-9a-fA-F_]+|[-+]?[1-9][0-9_]*(?::[0-5]?[0-9])+)$/,
    [..."-+0123456789"],
  ],
  [`${TAG}merge`, /^(?:<<)$/, ["<"]],
  [`${TAG}null`, /^(?:~|null|Null|NULL|)$/, ["~", "n", "N", ""]],
  [
    `${TAG}timestamp`,
    /^(?:[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]|[0-9][0-9][0-9][0-9]-[0-9][0-9]?-[0-9][0-9]?(?:[Tt]|[ \t]+)[0-9][0-9]?:[0-9][0-9]:[0-9][0-9](?:\.[0-9]*)?(?:[ \t]*(?:Z|[-+][0-9][0-9]?(?::[0-9][0-9])?))?)$/,
    [..."0123456789"],
  ],
  [`${TAG}value`, /^(?:=)$/, ["="]],
  [`${TAG}yaml`, /^(?:!|&|\*)$/, [..."!&*"]],
];

function lineAndColumn(source: string, offset: number): YamlMark {
  let line = 0;
  let lineStart = 0;
  for (let i = 0; i < offset && i < source.length; i++) {
    if (source[i] === "\n") {
      line++;
      lineStart = i + 1;
    }
  }
  return { line, column: offset - lineStart };
}

/** The class a static method was called on (a subclass registers on itself). */
function thisClass(cls: YamlLoaderClass): YamlLoaderClass {
  return cls;
}

const SCALAR_STYLES: Record<string, string | null> = {
  PLAIN: null,
  QUOTE_SINGLE: "'",
  QUOTE_DOUBLE: '"',
  BLOCK_LITERAL: "|",
  BLOCK_FOLDED: ">",
};

/**
 * The safe loader (`yaml.SafeLoader`): loads standard YAML 1.1 tags into
 * plain values. Subclass it and register constructors or resolvers on the
 * subclass to extend it; registrations never reach the parent class.
 */
export class SafeLoader {
  static yamlConstructors: Map<string, YamlConstructor> = new Map<string, YamlConstructor>([
    [`${TAG}null`, () => null],
    [`${TAG}bool`, (l, n) => BOOL_VALUES[String(l.constructScalar(n)).toLowerCase()]],
    [`${TAG}int`, constructYamlInt],
    [`${TAG}float`, constructYamlFloat],
    [`${TAG}binary`, constructYamlBinary],
    [`${TAG}timestamp`, constructYamlTimestamp],
    [`${TAG}omap`, (l, n) => l.constructPairs(n)],
    [`${TAG}pairs`, (l, n) => l.constructPairs(n)],
    [`${TAG}set`, (l, n) => new Set(Object.keys(l.constructMapping(n)))],
    [`${TAG}str`, (l, n) => l.constructScalar(n)],
    [`${TAG}seq`, (l, n) => l.constructSequence(n)],
    [`${TAG}map`, (l, n) => l.constructMapping(n)],
  ]);

  static yamlImplicitResolvers: YamlImplicitResolvers = (() => {
    const resolvers: YamlImplicitResolvers = new Map();
    for (const [tag, regexp, first] of DEFAULT_RESOLVERS) {
      for (const ch of first) {
        if (!resolvers.has(ch)) resolvers.set(ch, []);
        resolvers.get(ch)!.push([tag, regexp]);
      }
    }
    return resolvers;
  })();

  /** Register `fn` as the constructor for `tag` on this class (copying the parent's table first). */
  static addConstructor(tag: string, fn: YamlConstructor): void {
    // biome-ignore lint/complexity/noThisInStatic: registers on the subclass it is called on.
    const cls = thisClass(this);
    if (!Object.hasOwn(cls, "yamlConstructors")) {
      cls.yamlConstructors = new Map(cls.yamlConstructors);
    }
    cls.yamlConstructors.set(tag, fn);
  }

  /**
   * Resolve plain scalars matching `regexp` (and starting with one of `first`,
   * or any character when null) to `tag` on this class.
   */
  static addImplicitResolver(tag: string, regexp: RegExp, first: Iterable<string> | null): void {
    // biome-ignore lint/complexity/noThisInStatic: registers on the subclass it is called on.
    const cls = thisClass(this);
    if (!Object.hasOwn(cls, "yamlImplicitResolvers")) {
      cls.yamlImplicitResolvers = new Map(
        [...cls.yamlImplicitResolvers].map(([ch, list]) => [ch, [...list]]),
      );
    }
    for (const ch of first ?? [null]) {
      if (!cls.yamlImplicitResolvers.has(ch)) cls.yamlImplicitResolvers.set(ch, []);
      cls.yamlImplicitResolvers.get(ch)!.push([tag, regexp]);
    }
  }

  readonly #stream: string;
  readonly #constructed = new Map<YamlNode, unknown>();

  constructor(stream: string) {
    this.#stream = stream;
  }

  get #class(): YamlLoaderClass {
    return this.constructor as YamlLoaderClass;
  }

  /** Load the stream's single document (`get_single_data`); `null` for an empty stream. */
  getSingleData(): unknown {
    const node = this.getSingleNode();
    return node === null ? null : this.constructDocument(node);
  }

  /** Compose the stream's single document into nodes, resolving tags. */
  getSingleNode(): YamlNode | null {
    const doc = parseDocument(this.#stream, {
      version: "1.1",
      schema: "failsafe",
      uniqueKeys: false,
    });
    const error = doc.errors[0];
    if (error) {
      const mark = error.linePos?.[0];
      throw new ParserError(
        error.message.split(" at line ")[0]!,
        mark ? { line: mark.line - 1, column: mark.col - 1 } : null,
      );
    }
    if (doc.contents === null) return null;
    return this.#compose(doc, doc.contents, new Map());
  }

  #compose(doc: Document, ast: YamlAstNode, anchors: Map<YamlAstNode, YamlNode>): YamlNode {
    if (isAlias(ast)) {
      const target = (ast as Alias).resolve(doc);
      if (!target) throw new ParserError(`found undefined alias ${(ast as Alias).source}`);
      return this.#compose(doc, target, anchors);
    }
    const existing = anchors.get(ast);
    if (existing) return existing;
    const mark = ast.range ? lineAndColumn(this.#stream, ast.range[0]) : null;
    let node: YamlNode;
    if (isScalar(ast)) {
      const scalar = ast as Scalar;
      const value = scalar.value === null || scalar.value === undefined ? "" : String(scalar.value);
      const style = SCALAR_STYLES[scalar.type ?? "PLAIN"] ?? null;
      const tag = scalar.tag ?? (style === null ? this.resolveScalar(value) : `${TAG}str`);
      node = new ScalarNode(tag, value, mark, style);
    } else if (isSeq(ast)) {
      const seq = new SequenceNode(ast.tag ?? `${TAG}seq`, [], mark);
      anchors.set(ast, seq);
      for (const item of ast.items) {
        seq.value.push(this.#compose(doc, item as YamlAstNode, anchors));
      }
      node = seq;
    } else if (isMap(ast)) {
      const map = new MappingNode(ast.tag ?? `${TAG}map`, [], mark);
      anchors.set(ast, map);
      for (const pair of ast.items) {
        if (!isPair(pair)) continue;
        const key = (pair.key ?? null) as YamlAstNode | null;
        const value = (pair.value ?? null) as YamlAstNode | null;
        map.value.push([
          key === null ? new ScalarNode(`${TAG}null`, "", mark) : this.#compose(doc, key, anchors),
          value === null
            ? new ScalarNode(`${TAG}null`, "", mark)
            : this.#compose(doc, value, anchors),
        ]);
      }
      node = map;
    } else {
      throw new ParserError("unexpected YAML node", mark);
    }
    anchors.set(ast, node);
    return node;
  }

  /** The tag a plain scalar resolves to under this class's implicit resolvers. */
  resolveScalar(value: string): string {
    const resolvers = this.#class.yamlImplicitResolvers;
    const candidates = [...(resolvers.get(value === "" ? "" : value[0]!) ?? [])];
    candidates.push(...(resolvers.get(null) ?? []));
    for (const [tag, regexp] of candidates) {
      if (regexp.test(value)) return tag;
    }
    return `${TAG}str`;
  }

  /** Construct the value of a whole document. */
  constructDocument(node: YamlNode): unknown {
    return this.constructObject(node);
  }

  /** Construct the value of `node` with the constructor registered for its tag. */
  constructObject(node: YamlNode): unknown {
    if (this.#constructed.has(node)) return this.#constructed.get(node);
    const construct = this.#class.yamlConstructors.get(node.tag) ?? constructUndefined;
    const value = construct(this, node);
    this.#constructed.set(node, value);
    return value;
  }

  /** The text of a scalar node. */
  constructScalar(node: YamlNode): string {
    if (!(node instanceof ScalarNode)) {
      throw new ConstructorError(
        `expected a scalar node, but found ${node instanceof SequenceNode ? "sequence" : "mapping"}`,
        node.startMark,
      );
    }
    return node.value;
  }

  /** The values of a sequence node. */
  constructSequence(node: YamlNode): unknown[] {
    if (!(node instanceof SequenceNode)) {
      throw new ConstructorError(
        `expected a sequence node, but found ${node instanceof ScalarNode ? "scalar" : "mapping"}`,
        node.startMark,
      );
    }
    const result: unknown[] = [];
    this.#constructed.set(node, result);
    for (const child of node.value) result.push(this.constructObject(child));
    return result;
  }

  /**
   * The entries of a mapping node, as an object, after applying `<<` merge
   * keys. Keys are scalars; a sequence or mapping key is an error, as an
   * unhashable key is upstream.
   */
  constructMapping(node: YamlNode): Record<string, unknown> {
    if (!(node instanceof MappingNode)) {
      throw new ConstructorError(
        `expected a mapping node, but found ${node instanceof ScalarNode ? "scalar" : "sequence"}`,
        node.startMark,
      );
    }
    this.#flattenMapping(node);
    const result: Record<string, unknown> = {};
    this.#constructed.set(node, result);
    for (const [keyNode, valueNode] of node.value) {
      if (!(keyNode instanceof ScalarNode)) {
        throw new ConstructorError("found unhashable key", keyNode.startMark);
      }
      result[String(this.constructObject(keyNode))] = this.constructObject(valueNode);
    }
    return result;
  }

  /** The entries of a sequence of one-entry mappings (`!!omap`, `!!pairs`) as `[key, value]` pairs. */
  constructPairs(node: YamlNode): [unknown, unknown][] {
    if (!(node instanceof SequenceNode)) {
      throw new ConstructorError("expected a sequence of mappings", node.startMark);
    }
    const pairs: [unknown, unknown][] = [];
    for (const item of node.value) {
      if (!(item instanceof MappingNode) || item.value.length !== 1) {
        throw new ConstructorError("expected a single mapping item", item.startMark);
      }
      const [k, v] = item.value[0]!;
      pairs.push([this.constructObject(k), this.constructObject(v)]);
    }
    return pairs;
  }

  /** Apply `<<` merge keys in place (`SafeConstructor.flatten_mapping`). */
  #flattenMapping(node: MappingNode): void {
    const merge: [YamlNode, YamlNode][] = [];
    const entries: [YamlNode, YamlNode][] = [];
    for (const [key, value] of node.value) {
      if (key.tag !== `${TAG}merge`) {
        entries.push([key, value]);
        continue;
      }
      if (value instanceof MappingNode) {
        this.#flattenMapping(value);
        merge.push(...value.value);
      } else if (value instanceof SequenceNode) {
        const submerge: [YamlNode, YamlNode][][] = [];
        for (const sub of value.value) {
          if (!(sub instanceof MappingNode)) {
            throw new ConstructorError(
              "expected a mapping for merging, but found a non-mapping",
              sub.startMark,
            );
          }
          this.#flattenMapping(sub);
          submerge.push(sub.value);
        }
        for (const sub of submerge.reverse()) merge.push(...sub);
      } else {
        throw new ConstructorError(
          "expected a mapping or list of mappings for merging",
          value.startMark,
        );
      }
    }
    node.value = [...merge, ...entries];
  }
}

/**
 * Parse the single YAML document in `stream` (`yaml.load(stream, Loader)`).
 *
 * @param stream The YAML text.
 * @param Loader The loader class to load with. Defaults to `SafeLoader`.
 */
export function load(stream: string, Loader: YamlLoaderClass = SafeLoader): unknown {
  return new Loader(stream).getSingleData();
}

/**
 * Register an implicit resolver (`yaml.add_implicit_resolver`) on `Loader`.
 *
 * @param tag The tag plain scalars matching `regexp` resolve to.
 * @param regexp The pattern a plain scalar must match.
 * @param first The characters such scalars start with, or null for any.
 */
export function addImplicitResolver(
  tag: string,
  regexp: RegExp,
  first: Iterable<string> | null = null,
  options: { Loader?: YamlLoaderClass } = {},
): void {
  (options.Loader ?? SafeLoader).addImplicitResolver(tag, regexp, first);
}

/**
 * Reads an included file as UTF-8 text. Throws if the file can't be read
 * (Node's `ENOENT` error is upstream's `FileNotFoundError`).
 */
export type YamlFileReader = (path: string) => string;

export interface IncludeOptions {
  /** Reads `!include`d files, e.g. `(p) => readFileSync(p, "utf8")`. */
  readFile: YamlFileReader;
}

/** `Path(baseDir) / path`: `path` itself when absolute, else joined onto `baseDir`. */
function joinPath(baseDir: string, path: string): string {
  if (path.startsWith("/") || path.startsWith("\\") || /^[A-Za-z]:[\\/]/.test(path)) return path;
  if (baseDir === "") return path;
  return /[\\/]$/.test(baseDir) ? `${baseDir}${path}` : `${baseDir}/${path}`;
}

/**
 * Register an `!include <relative-path>` constructor on `loaderClass`.
 *
 * Included files load with the same loader class, so nested includes work and
 * scalars get the same resolver treatment as the top-level document. Paths
 * resolve against `baseDir` and may reach outside it.
 *
 * This mutates `loaderClass`. Register on a private subclass rather than on
 * `SafeLoader` itself so the constructor has no global side effects;
 * `includeLoader` does that for you.
 *
 * @param loaderClass The loader class to register the constructor on.
 * @param baseDir Directory that `!include` paths resolve against.
 * @param options How to read the included files.
 */
export function addIncludeConstructor(
  loaderClass: YamlLoaderClass,
  baseDir: string,
  options: IncludeOptions,
): void {
  const include: YamlConstructor = (loader, node) => {
    if (!(node instanceof ScalarNode)) {
      throw new ConstructorError("!include expects a file path", node.startMark);
    }
    const includePath = joinPath(baseDir, String(loader.constructScalar(node)));
    return load(options.readFile(includePath), loaderClass);
  };

  loaderClass.addConstructor("!include", include);
}

export interface IncludeLoaderOptions extends IncludeOptions {
  /**
   * Loader class to subclass. Defaults to `SafeLoader`; pass a custom
   * `SafeLoader` subclass to keep its resolvers and constructors.
   */
  base?: YamlLoaderClass;
}

/**
 * Build a loader class that resolves `!include` relative to `baseDir`.
 *
 * Returns a fresh subclass of `base` with the include constructor
 * registered, so `base` itself is left untouched.
 *
 * @param baseDir Directory that `!include` paths resolve against, typically
 *   the directory of the document being loaded.
 * @param options How to read included files, and the loader class to subclass.
 * @returns A loader class to pass to `load`.
 *
 * @example
 * ```ts
 * const data = load(readFileSync(path, "utf8"), includeLoader(dirname(path), {
 *   readFile: (p) => readFileSync(p, "utf8"),
 * }));
 * ```
 */
export function includeLoader(baseDir: string, options: IncludeLoaderOptions): YamlLoaderClass {
  const base = options.base ?? SafeLoader;
  const _IncludeLoader = class _IncludeLoader extends (base as typeof SafeLoader) {};

  addIncludeConstructor(_IncludeLoader, baseDir, options);
  return _IncludeLoader;
}
