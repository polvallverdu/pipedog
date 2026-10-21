// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

import { expect, test } from "bun:test";
import { type LogRecord, logger } from "../src/utils/logger.ts";

function capture(fn: () => void): LogRecord[] {
  const records: LogRecord[] = [];
  const remove = logger.addSink((record) => records.push(record));
  try {
    fn();
  } finally {
    remove();
  }
  return records;
}

test("warnings and errors are masked, message and attached error alike", () => {
  const [record] = capture(() =>
    logger.error(
      "connect to wss://host/ws?key=AIzaSyA-secret-123 failed",
      new Error("WebSocket connection to 'wss://host/ws?key=AIzaSyA-secret-123' failed"),
    ),
  );
  expect(record!.message).not.toContain("secret-123");
  expect(record!.message).toContain("[REDACTED]");
  const error = record!.error as Error;
  expect(error.message).not.toContain("secret-123");
  expect(error.stack ?? "").not.toContain("secret-123");
});

test("debug messages pass through as written", () => {
  const [record] = capture(() => logger.debug("token=abc"));
  expect(record!.message).toBe("token=abc");
});
