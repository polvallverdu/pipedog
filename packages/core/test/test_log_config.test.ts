// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipecat-ts contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_log_config.py

/** Tests for the process-wide logging controls in `utils/log_config`. */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { InvalidEnvVarValueError } from "../src/utils/env.ts";
import {
  _getLlmContextLogMode,
  _LLM_CONTEXT_LOG_ENV_VAR,
  _LLMContextLogMode,
  _resetLlmContextLogMode,
} from "../src/utils/log_config.ts";

let savedEnv: string | undefined;

// Equivalent of the autouse `_reset` fixture (monkeypatch restores on teardown).
beforeEach(() => {
  savedEnv = process.env[_LLM_CONTEXT_LOG_ENV_VAR];
  _resetLlmContextLogMode();
  delete process.env[_LLM_CONTEXT_LOG_ENV_VAR];
});

afterEach(() => {
  _resetLlmContextLogMode();
  if (savedEnv === undefined) {
    delete process.env[_LLM_CONTEXT_LOG_ENV_VAR];
  } else {
    process.env[_LLM_CONTEXT_LOG_ENV_VAR] = savedEnv;
  }
});

describe("test_log_config", () => {
  test("test_defaults_to_full", () => {
    expect(_getLlmContextLogMode()).toBe(_LLMContextLogMode.FULL);
  });

  test.each(["", "   "])("test_empty_env_var_defaults_to_full[%p]", (raw) => {
    process.env[_LLM_CONTEXT_LOG_ENV_VAR] = raw;
    expect(_getLlmContextLogMode()).toBe(_LLMContextLogMode.FULL);
  });

  test.each([
    [" Off ", _LLMContextLogMode.OFF],
    ["FULL", _LLMContextLogMode.FULL],
  ] as const)("test_reads_env_var[%p-%p]", (raw, expected) => {
    process.env[_LLM_CONTEXT_LOG_ENV_VAR] = raw;
    expect(_getLlmContextLogMode()).toBe(expected);
  });

  test("test_invalid_env_var_raises", () => {
    process.env[_LLM_CONTEXT_LOG_ENV_VAR] = "verbose";
    let error: unknown;
    try {
      _getLlmContextLogMode();
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(InvalidEnvVarValueError);
    // `name` is taken by Error, so the variable's name is `envName`.
    expect((error as InvalidEnvVarValueError).envName).toBe(_LLM_CONTEXT_LOG_ENV_VAR);
    expect((error as InvalidEnvVarValueError).value).toBe("verbose");
  });

  test("test_env_var_read_once", () => {
    process.env[_LLM_CONTEXT_LOG_ENV_VAR] = "off";
    expect(_getLlmContextLogMode()).toBe(_LLMContextLogMode.OFF);
    process.env[_LLM_CONTEXT_LOG_ENV_VAR] = "full";
    expect(_getLlmContextLogMode()).toBe(_LLMContextLogMode.OFF);
  });
});
