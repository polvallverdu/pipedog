// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/flows_test_helpers.py

import { expect, mock } from "bun:test";
import type { FunctionSchema } from "@pipedog/core/adapters/llm/schemas/function_schema";
import type { ToolsSchema } from "@pipedog/core/adapters/llm/schemas/tools_schema";
import { EndFrame, type Frame, LLMSetToolsFrame, TTSSpeakFrame } from "@pipedog/core/frames/frames";
import { NOT_GIVEN } from "@pipedog/core/processors/aggregators/llm_context";
import type { FunctionCallHandler } from "@pipedog/core/services/llm_service";
import { type LogRecord, logger } from "@pipedog/core/utils/logger";

/** A mock PipelineWorker (Python: `AsyncMock()` set up by `make_mock_worker`). */
export interface MockWorker {
  queueFrame: ReturnType<typeof mock<(frame: Frame) => Promise<void>>>;
  queueFrames: ReturnType<typeof mock<(frames: Iterable<Frame>) => Promise<void>>>;
  setReachedDownstreamFilter: ReturnType<typeof mock<(types: unknown[]) => void>>;
  eventHandler: (name: string, handler: (...args: any[]) => unknown) => unknown;
  on_frame_reached_downstream?: (worker: unknown, frame: Frame) => Promise<void>;
  [key: string]: any;
}

/** The frames queued one at a time with `queueFrame`, in order. */
function queuedFrames(mockWorker: MockWorker): Frame[] {
  return mockWorker.queueFrame.mock.calls.map((call) => call[0] as Frame);
}

/** Assert that TTSSpeakFrames with expected texts were queued. */
export function assertTtsSpeakFramesQueued(mockWorker: MockWorker, expectedTexts: string[]): void {
  const ttsFrames = getQueuedTtsSpeakFrames(mockWorker);
  expect(ttsFrames.length).toBe(expectedTexts.length);
  for (const text of expectedTexts) {
    expect(ttsFrames.some((f) => f.text.includes(text))).toBe(true);
  }
}

/** Return the TTSSpeakFrames queued on the mock worker, in order. */
export function getQueuedTtsSpeakFrames(mockWorker: MockWorker): TTSSpeakFrame[] {
  return queuedFrames(mockWorker).filter((f): f is TTSSpeakFrame => f instanceof TTSSpeakFrame);
}

/** Assert that an EndFrame was queued. */
export function assertEndFrameQueued(mockWorker: MockWorker): void {
  const endFrames = queuedFrames(mockWorker).filter((f) => f instanceof EndFrame);
  expect(endFrames.length).toBe(1);
}

/** Every frame queued with `queueFrames`, in order. */
export function getQueuedFramesBatches(mockWorker: MockWorker): Frame[][] {
  return mockWorker.queueFrames.mock.calls.map((call) => [...(call[0] as Iterable<Frame>)]);
}

/**
 * Return the tools from the most recent LLMSetToolsFrame queued (or NOT_GIVEN).
 *
 * FlowManager advertises a node's tools via an LLMSetToolsFrame; the LLM
 * service registers the handlers they carry when it sees them.
 */
export function getAdvertisedTools(mockWorker: MockWorker): ToolsSchema | typeof NOT_GIVEN {
  const setToolsFrames = getQueuedFramesBatches(mockWorker)
    .flat()
    .filter((f): f is LLMSetToolsFrame => f instanceof LLMSetToolsFrame);
  return setToolsFrames.length > 0
    ? (setToolsFrames[setToolsFrames.length - 1]!.tools as ToolsSchema)
    : NOT_GIVEN;
}

/** Return {name: handler} from the most recent LLMSetToolsFrame queued. */
export function getAdvertisedToolHandlers(
  mockWorker: MockWorker,
): Record<string, FunctionCallHandler> {
  const tools = getAdvertisedTools(mockWorker);
  if (tools === NOT_GIVEN) {
    return {};
  }
  return Object.fromEntries(
    (tools as ToolsSchema).standardTools.map((schema: FunctionSchema) => [
      schema.name,
      schema.handler as FunctionCallHandler,
    ]),
  );
}

/** Create a mock PipelineWorker wired up so that actions don't hang. */
export function makeMockWorker(): MockWorker {
  const mockWorker = {} as MockWorker;

  // Mock queueFrame method that simulates queued frames reaching all the way downstream.
  // This is necessary for action execution to not hang, waiting.
  mockWorker.queueFrame = mock(async (frame: Frame) => {
    const handler = mockWorker.on_frame_reached_downstream;
    if (handler) {
      await handler(mockWorker, frame);
    }
  });
  mockWorker.queueFrames = mock(async (_frames: Iterable<Frame>) => {});

  // Mock stuff necessary for registering on_frame_reached_downstream handler.
  mockWorker.setReachedDownstreamFilter = mock((_types: unknown[]) => {});
  mockWorker.eventHandler = (name: string, handler: (...args: any[]) => unknown) => {
    mockWorker[name] = handler;
    return handler;
  };

  return mockWorker;
}

/** Capture log records at or above `level` while `fn` runs (loguru's `logger.add(sink)`). */
export async function captureLogs(
  fn: () => Promise<unknown> | unknown,
  level: LogRecord["level"] = "WARNING",
): Promise<LogRecord[]> {
  const order = ["TRACE", "DEBUG", "INFO", "SUCCESS", "WARNING", "ERROR", "CRITICAL"];
  const records: LogRecord[] = [];
  const remove = logger.addSink((record) => {
    if (order.indexOf(record.level) >= order.indexOf(level)) records.push(record);
  });
  try {
    await fn();
  } finally {
    remove();
  }
  return records;
}
