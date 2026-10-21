// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Stand-in for loguru, which upstream logs through. Same level names, so
// ported `logger.warning(...)` calls read the same. Replace the sink to route
// logs elsewhere (pino, console.json, Workers logs...).

import { redactSecrets } from "./security/redaction.ts";

export const LOG_LEVELS = {
  TRACE: 5,
  DEBUG: 10,
  INFO: 20,
  SUCCESS: 25,
  WARNING: 30,
  ERROR: 40,
  CRITICAL: 50,
} as const;

export type LogLevel = keyof typeof LOG_LEVELS;

export interface LogRecord {
  level: LogLevel;
  message: string;
  time: Date;
  error?: unknown;
}

export type LogSink = (record: LogRecord) => void;

/** `error` with the credentials in its message and stack masked. */
function redactError(error: unknown): unknown {
  if (error instanceof Error) {
    const masked = new Error(redactSecrets(error.message));
    masked.name = error.name;
    masked.stack = error.stack === undefined ? undefined : redactSecrets(error.stack);
    return masked;
  }
  return typeof error === "string" ? redactSecrets(error) : error;
}

const consoleSink: LogSink = (record) => {
  const line = `${record.time.toISOString()} | ${record.level.padEnd(8)} | ${record.message}`;
  if (LOG_LEVELS[record.level] >= LOG_LEVELS.ERROR) {
    console.error(line, ...(record.error ? [record.error] : []));
  } else if (record.level === "WARNING") {
    console.warn(line);
  } else {
    console.log(line);
  }
};

function initialLevel(): LogLevel {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
    ?.env;
  const value = env?.PIPEDOG_LOG_LEVEL?.toUpperCase();
  return value && value in LOG_LEVELS ? (value as LogLevel) : "DEBUG";
}

class Logger {
  #level: number = LOG_LEVELS[initialLevel()];
  #sinks: LogSink[] = [consoleSink];

  /** Only records at or above `level` are emitted. */
  setLevel(level: LogLevel): void {
    this.#level = LOG_LEVELS[level];
  }

  isEnabledFor(level: LogLevel): boolean {
    return LOG_LEVELS[level] >= this.#level;
  }

  /** Replace all sinks (loguru `logger.remove()` + `logger.add(sink)`). */
  setSink(...sinks: LogSink[]): void {
    this.#sinks = sinks;
  }

  addSink(sink: LogSink): () => void {
    this.#sinks.push(sink);
    return () => {
      this.#sinks = this.#sinks.filter((s) => s !== sink);
    };
  }

  log(level: LogLevel, message: string, error?: unknown): void {
    if (LOG_LEVELS[level] < this.#level) return;
    // DIVERGENCE: upstream masks credentials only in ErrorFrame. Warnings and
    // errors often quote what failed, such as a URL with `?key=...`, so their
    // text and attached error are masked here, for every sink.
    const record: LogRecord =
      LOG_LEVELS[level] >= LOG_LEVELS.WARNING
        ? { level, message: redactSecrets(message), time: new Date(), error: redactError(error) }
        : { level, message, time: new Date(), error };
    for (const sink of this.#sinks) sink(record);
  }

  trace(message: string): void {
    this.log("TRACE", message);
  }
  debug(message: string): void {
    this.log("DEBUG", message);
  }
  info(message: string): void {
    this.log("INFO", message);
  }
  success(message: string): void {
    this.log("SUCCESS", message);
  }
  warning(message: string): void {
    this.log("WARNING", message);
  }
  warn(message: string): void {
    this.log("WARNING", message);
  }
  error(message: string, error?: unknown): void {
    this.log("ERROR", message, error);
  }
  /** loguru `logger.exception`: an error with its stack. */
  exception(message: string, error?: unknown): void {
    this.log("ERROR", message, error);
  }
  critical(message: string, error?: unknown): void {
    this.log("CRITICAL", message, error);
  }
}

export const logger = new Logger();
export type { Logger };
