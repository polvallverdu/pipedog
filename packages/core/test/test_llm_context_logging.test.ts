// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipecat-ts contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_llm_context_logging.py

/** Tests for how LLM services log the context in each `PIPECAT_LOG_LLM_CONTEXT` mode. */

import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";

import { LLMContext } from "../src/processors/aggregators/llm_context.ts";
import { LLMService } from "../src/services/llm_service.ts";
import { InvalidEnvVarValueError } from "../src/utils/env.ts";
import { _LLM_CONTEXT_LOG_ENV_VAR, _resetLlmContextLogMode } from "../src/utils/log_config.ts";
import { LOG_LEVELS, type LogLevel, logger } from "../src/utils/logger.ts";

const MESSAGES = [
  { role: "system", content: "You are helpful." },
  { role: "user", content: "What's the weather?" },
];

// The protected `_log*` methods, reached the way the Python test reaches them.
interface LoggingService {
  _logLlmResponse(context: LLMContext): void;
  _logLlmConversationSetup(context: LLMContext): void;
}

function asLogging(service: LLMService): LoggingService {
  return service as unknown as LoggingService;
}

function newContext(): LLMContext {
  return new LLMContext({ messages: structuredClone(MESSAGES) as never });
}

// The logger has one process-wide level rather than a level per sink; find it
// so it can be restored after each test.
function currentLevel(): LogLevel {
  const levels = Object.keys(LOG_LEVELS) as LogLevel[];
  return levels.find((level) => logger.isEnabledFor(level)) ?? "CRITICAL";
}

let savedEnv: string | undefined;
let savedLevel: LogLevel;
const cleanups: (() => void)[] = [];

// Equivalent of the autouse `_reset` fixture (monkeypatch restores on teardown).
beforeEach(() => {
  savedEnv = process.env[_LLM_CONTEXT_LOG_ENV_VAR];
  savedLevel = currentLevel();
  _resetLlmContextLogMode();
  delete process.env[_LLM_CONTEXT_LOG_ENV_VAR];
});

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
  logger.setLevel(savedLevel);
  _resetLlmContextLogMode();
  if (savedEnv === undefined) {
    delete process.env[_LLM_CONTEXT_LOG_ENV_VAR];
  } else {
    process.env[_LLM_CONTEXT_LOG_ENV_VAR] = savedEnv;
  }
});

/** The `captured` fixture: a DEBUG sink collecting each message as a line. */
function captured(): { getvalue(): string } {
  const lines: string[] = [];
  logger.setLevel("DEBUG");
  const remove = logger.addSink((record) => {
    if (LOG_LEVELS[record.level] >= LOG_LEVELS.DEBUG) lines.push(`${record.message}\n`);
  });
  cleanups.push(remove);
  return { getvalue: () => lines.join("") };
}

test("test_invalid_mode_raises_at_construction", () => {
  process.env[_LLM_CONTEXT_LOG_ENV_VAR] = "of";
  expect(() => new LLMService()).toThrow(InvalidEnvVarValueError);
});

test("test_full_logs_every_message", () => {
  const sink = captured();
  const service = new LLMService();
  asLogging(service)._logLlmResponse(newContext());
  expect(sink.getvalue()).toBe(`${service}: Generating LLM response ${JSON.stringify(MESSAGES)}\n`);
});

test("test_conversation_setup_logs_every_message", () => {
  const sink = captured();
  const service = new LLMService();
  asLogging(service)._logLlmConversationSetup(newContext());
  expect(sink.getvalue()).toBe(
    `${service}: Setting up LLM conversation ${JSON.stringify(MESSAGES)}\n`,
  );
});

test("test_off_logs_without_context", () => {
  const sink = captured();
  process.env[_LLM_CONTEXT_LOG_ENV_VAR] = "off";
  const service = new LLMService();
  asLogging(service)._logLlmResponse(newContext());
  asLogging(service)._logLlmConversationSetup(newContext());
  expect(
    sink
      .getvalue()
      .split("\n")
      .filter((line) => line !== ""),
  ).toEqual([`${service}: Generating LLM response`, `${service}: Setting up LLM conversation`]);
});

test("test_off_does_not_build_messages", () => {
  captured();
  process.env[_LLM_CONTEXT_LOG_ENV_VAR] = "off";
  const service = new LLMService();
  const rendered: LLMContext[] = [];
  const spy = spyOn(service.getLlmAdapter(), "getMessagesForLogging").mockImplementation(
    (context: LLMContext) => {
      rendered.push(context);
      return [];
    },
  );
  cleanups.push(() => spy.mockRestore());
  asLogging(service)._logLlmResponse(newContext());
  expect(rendered).toEqual([]);
});

test("test_not_rendered_without_debug_sink", () => {
  const service = new LLMService();
  const rendered: LLMContext[] = [];
  const spy = spyOn(service.getLlmAdapter(), "getMessagesForLogging").mockImplementation(
    (context: LLMContext) => {
      rendered.push(context);
      return [];
    },
  );
  cleanups.push(() => spy.mockRestore());
  // loguru's `logger.remove(); logger.add(sink, level="INFO")`: only INFO and
  // above reach any sink. The afterEach restores the previous level.
  logger.setLevel("INFO");
  asLogging(service)._logLlmResponse(newContext());
  expect(rendered).toEqual([]);
});
