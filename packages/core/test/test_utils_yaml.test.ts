// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipecat-ts contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_utils_yaml.py

/**
 * Tests for the `!include` YAML loader helpers in utils/yaml.
 *
 * Every upstream test loads YAML with PyYAML loader classes and reads included
 * files from disk. `packages/core/src/utils/yaml.ts` (pipecat.utils.yaml) is an
 * interface-only stub: `addIncludeConstructor` / `includeLoader` always throw
 * because core has no YAML parser or file reader wired in (see the UNRESOLVED
 * note in porting/manifest.json). So each test is a `test.todo` naming that
 * module until it is implemented.
 */

import { describe, test } from "bun:test";

const TODO =
  "needs pipecat.utils.yaml (packages/core/src/utils/yaml.ts) implemented: YAML parser + file reader not ported";

describe("TestIncludeLoader", () => {
  // Upstream: `top: !include fragment.yaml` -> {top: {a: 1, b: "two"}}.
  test.todo(`test_include_resolves_relative_to_base_dir (${TODO})`);

  // Upstream: nested includes resolve against the top-level base_dir.
  test.todo(`test_nested_include_uses_same_loader (${TODO})`);

  // Upstream: an included scalar document becomes a string value.
  test.todo(`test_include_scalar_document (${TODO})`);

  // Upstream: a missing include file raises FileNotFoundError.
  test.todo(`test_missing_file_raises (${TODO})`);

  // Upstream: `!include [a, b]` raises ConstructorError "expects a file path".
  test.todo(`test_non_scalar_node_raises (${TODO})`);

  // Upstream: include_loader() leaves yaml.SafeLoader without `!include`.
  test.todo(`test_base_loader_is_not_mutated (${TODO})`);

  // Upstream: a custom base loader's implicit resolvers apply in included files.
  test.todo(`test_custom_base_loader_keeps_its_resolvers (${TODO})`);

  // Upstream: add_include_constructor on an explicit SafeLoader subclass.
  test.todo(`test_add_include_constructor_on_explicit_subclass (${TODO})`);
});
