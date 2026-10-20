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
 * Not ported yet: Upstream builds on PyYAML loader classes and reads
 * included files from disk. Core takes no YAML dependency and has no
 * filesystem access (Workers), so only the interface is here; both functions
 * throw until a YAML parser and file reader are wired in.
 */

/** A YAML node, as handed to a constructor. */
export interface YamlNode {
  /** Whether the node is a scalar (as opposed to a sequence or mapping). */
  readonly isScalar: boolean;
  /** The scalar value, for scalar nodes. */
  readonly value?: unknown;
}

/** A tag constructor registered on a loader class. */
export type YamlConstructor = (loader: unknown, node: YamlNode) => unknown;

/** The loader-class shape the helpers work with (a `yaml.SafeLoader` subclass upstream). */
export interface YamlLoaderClass {
  /** Register a constructor for a tag on this loader class. */
  addConstructor(tag: string, fn: YamlConstructor): void;
}

function notPorted(name: string): never {
  throw new Error(`pipecat.utils.yaml.${name}: not ported yet (needs a YAML parser)`);
}

/**
 * Register an `!include <relative-path>` constructor on `loaderClass`.
 *
 * Included files load with the same loader class, so nested includes work and
 * scalars get the same resolver treatment as the top-level document. Paths
 * resolve against `baseDir` and may reach outside it.
 *
 * This mutates `loaderClass`. Register on a private subclass rather than on
 * the base loader itself so the constructor has no global side effects;
 * `includeLoader` does that for you.
 *
 * @param loaderClass The loader class to register the constructor on.
 * @param baseDir Directory that `!include` paths resolve against.
 */
export function addIncludeConstructor(_loaderClass: YamlLoaderClass, _baseDir: string): void {
  notPorted("add_include_constructor");
}

/**
 * Build a loader class that resolves `!include` relative to `baseDir`.
 *
 * Returns a fresh subclass of `base` with the include constructor registered,
 * so `base` itself is left untouched.
 *
 * @param baseDir Directory that `!include` paths resolve against, typically
 *   the directory of the document being loaded.
 * @param base Loader class to subclass. Defaults to the safe loader; pass a
 *   custom one to keep its resolvers and constructors.
 * @returns A loader class to load documents with.
 */
export function includeLoader(_baseDir: string, _base?: YamlLoaderClass): YamlLoaderClass {
  return notPorted("include_loader");
}
