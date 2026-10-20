// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipecat-ts contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_rtvi_observer_cleanup.py

/** Tests for RTVIObserver cleanup. */

import { describe, expect, spyOn, test } from "bun:test";
import { RTVIObserver, RTVIObserverParams } from "../src/processors/frameworks/rtvi/observer.ts";
import { logger } from "../src/utils/logger.ts";

describe("TestRTVIObserverCleanup", () => {
  test("test_cleanup_can_run_twice_with_system_logs", async () => {
    // An observer removed from a worker and added back is cleaned up on
    // removal and again at shutdown.
    const observer = new RTVIObserver(null, {
      params: new RTVIObserverParams({ systemLogsEnabled: true }),
    });
    // The TS logger hands back a remove function instead of a loguru sink id.
    const internals = observer as unknown as {
      _systemLoggerRemove: (() => void) | null;
      _loggerSink: (message: string) => Promise<void>;
    };
    expect(internals._systemLoggerRemove).not.toBeNull();
    const sinkSpy = spyOn(internals, "_loggerSink").mockImplementation(async () => {});

    await observer.cleanup();
    await observer.cleanup();

    // loguru's `logger.remove(sink_id)` raising ValueError means the sink is
    // gone; here, the sink no longer receives records.
    logger.error("after cleanup");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sinkSpy).not.toHaveBeenCalled();
    sinkSpy.mockRestore();
  });
});
