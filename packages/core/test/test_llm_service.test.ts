// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_llm_service.py

import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";

import { CancelledError, sleep } from "@pipedog/asyncio";

import { BaseLLMAdapter } from "../src/adapters/llm/base_llm_adapter.ts";
import { FunctionSchema } from "../src/adapters/llm/schemas/function_schema.ts";
import { ToolsSchema } from "../src/adapters/llm/schemas/tools_schema.ts";
import { OpenAILLMAdapter } from "../src/adapters/llm/services/open_ai_adapter.ts";
import { SystemClock } from "../src/clocks/system_clock.ts";
import {
  type ErrorFrame,
  type Frame,
  FunctionCallCancelFrame,
  FunctionCallFromLLM,
  FunctionCallInProgressFrame,
  FunctionCallResultFrame,
  FunctionCallResultProperties,
  FunctionCallsStartedFrame,
  InterruptionFrame,
  LLMContextFrame,
  LLMSetToolsFrame,
  LLMUpdateSettingsFrame,
} from "../src/frames/frames.ts";
import { LLMContext } from "../src/processors/aggregators/llm_context.ts";
import {
  FrameDirection,
  FrameProcessorSetup,
  type FrameProcessorSetupOptions,
} from "../src/processors/frame_processor.ts";
import {
  FunctionCallParams,
  type FunctionCallRegistryItem,
  FunctionCallRunnerItem,
  LLMService,
  type LLMServiceOptions,
} from "../src/services/llm_service.ts";
import { LLMSettings } from "../src/services/settings.ts";
import { FunctionCallUserMuteStrategy } from "../src/turns/user_mute/function_call_user_mute_strategy.ts";
import type { UserTurnCompletionConfig } from "../src/turns/user_turn_completion_mixin.ts";
import { cancelToolName } from "../src/utils/async_tool_cancellation.ts";
import { type BaseTaskManager, TaskManager } from "../src/utils/asyncio/task_manager.ts";
import { ErrorCategory } from "../src/utils/errors.ts";
import { logger } from "../src/utils/logger.ts";
import { NOT_GIVEN } from "../src/utils/types.ts";

/** Python's builtin `RuntimeError`, so `error` reads `RuntimeError: ...` as upstream. */
class RuntimeError extends Error {
  override name = "RuntimeError";
}

/** Python's builtin `ValueError`. */
class ValueError extends Error {
  override name = "ValueError";
}

/** Local port of upstream tests/frame_processor_helpers.py `frame_processor_setup`. */
function frameProcessorSetup(
  taskManager: BaseTaskManager | null = null,
  options: Partial<FrameProcessorSetupOptions> = {},
): FrameProcessorSetup {
  return new FrameProcessorSetup({
    clock: new SystemClock(),
    pipelineWorker: null,
    ...options,
    taskManager: taskManager as BaseTaskManager,
  });
}

function expectedMissingToolMessage(name: string): string {
  return LLMService.MISSING_FUNCTION_CALL_MESSAGE_TEMPLATE.replaceAll("{function_name}", name);
}

type Handler = (params: FunctionCallParams) => Promise<void>;

interface MockLLMServiceOptions extends LLMServiceOptions {
  systemInstruction?: string | null;
  filterIncompleteUserTurns?: boolean | null;
  userTurnCompletionConfig?: UserTurnCompletionConfig | null;
}

/** Minimal LLM service for testing function call execution. */
class MockLLMService extends LLMService {
  constructor(options: MockLLMServiceOptions = {}) {
    const { systemInstruction, filterIncompleteUserTurns, userTurnCompletionConfig, ...rest } =
      options;
    const settings = new LLMSettings({
      model: "test-model",
      systemInstruction: systemInstruction ?? null,
      temperature: null,
      maxTokens: null,
      topP: null,
      topK: null,
      frequencyPenalty: null,
      presencePenalty: null,
      seed: null,
      filterIncompleteUserTurns: filterIncompleteUserTurns ?? null,
      userTurnCompletionConfig: userTurnCompletionConfig ?? null,
    });
    super({ ...rest, settings });
    // Stub the pipeline worker so FunctionCallParams can be constructed.
    this._setup = frameProcessorSetup(null, {
      pipelineWorker: { appResources: null, workerRunner: null } as any,
    });
  }
}

/** The protected members these tests reach into, as upstream does. */
type Internals = any;

function internals(service: LLMService): Internals {
  return service as Internals;
}

function fns(service: LLMService): Map<string | null, FunctionCallRegistryItem> {
  return internals(service)._functions;
}

function call(
  functionName: string,
  toolCallId: string,
  args: Record<string, unknown> = {},
  context: unknown = new LLMContext(),
) {
  return new FunctionCallFromLLM({ functionName, toolCallId, arguments: args, context });
}

/** `service.broadcast_frame = mock_broadcast_frame` recording into a list. */
function recordBroadcasts(service: LLMService): Frame[] {
  const recorded: Frame[] = [];
  internals(service).broadcastFrame = async (frameCls: any, options?: any) => {
    recorded.push(new frameCls(options));
  };
  return recorded;
}

function asyncMock() {
  return mock(async (..._args: unknown[]) => {});
}

/** `patch("pipecat.services.llm_service.logger")`: capture warnings and errors. */
const restores: (() => void)[] = [];
afterEach(() => {
  for (const restore of restores.splice(0)) restore();
});

function patchLogger(): { warnings: string[]; errors: string[] } {
  const warnings: string[] = [];
  const errors: string[] = [];
  const w = spyOn(logger, "warning").mockImplementation((m: string) => {
    warnings.push(m);
  });
  const e = spyOn(logger, "error").mockImplementation((m: string) => {
    errors.push(m);
  });
  restores.push(() => {
    w.mockRestore();
    e.mockRestore();
  });
  return { warnings, errors };
}

describe("TestUnparameterizedSubclass", () => {
  test("test_unparameterized_subclass_instantiates", () => {
    const service = new MockLLMService();
    const adapter = service.getLlmAdapter();

    // Default adapter_class is OpenAILLMAdapter; the runtime instance
    // should reflect that, regardless of how generics are erased.
    expect(adapter).toBeInstanceOf(OpenAILLMAdapter);
    expect(adapter).toBeInstanceOf(BaseLLMAdapter);
  });
});

describe("TestLLMService", () => {
  function runFunctionCallsInline(service: MockLLMService): void {
    const runInline = async (runnerItems: FunctionCallRunnerItem[]) => {
      for (const runnerItem of runnerItems) {
        await internals(service)._runFunctionCall(runnerItem);
      }
    };
    internals(service)._runParallelFunctionCalls = runInline;
    internals(service)._runSequentialFunctionCalls = runInline;
  }

  test("test_missing_function_call_emits_terminal_result", async () => {
    const service = new MockLLMService();
    internals(service)._callEventHandler = asyncMock();
    runFunctionCallsInline(service);

    const recordedFrames = recordBroadcasts(service);

    const log = patchLogger();
    await service.runFunctionCalls([call("missing_tool", "call_1", { query: "weather" })]);

    expect(recordedFrames.map((f) => f.constructor)).toEqual([
      FunctionCallsStartedFrame,
      FunctionCallInProgressFrame,
      FunctionCallResultFrame,
    ]);
    expect((recordedFrames[1] as FunctionCallInProgressFrame).functionName).toEqual("missing_tool");
    expect((recordedFrames[2] as FunctionCallResultFrame).result).toEqual(
      expectedMissingToolMessage("missing_tool"),
    );

    // The tool was not advertised, so this is treated as a hallucination
    // (warning at queue time). The execution-time "just unregistered"
    // warning must not double-log.
    expect(log.warnings.some((w) => w.includes("not in the currently advertised tool set"))).toBe(
      true,
    );
    expect(log.warnings.some((w) => w.includes("just unregistered"))).toBe(false);
  });

  test("test_handler_that_raises_settles_the_call_with_the_failure", async () => {
    // The LLM reads a stand-in message; the frame says what went wrong.
    const service = new MockLLMService();
    internals(service)._callEventHandler = asyncMock();
    runFunctionCallsInline(service);

    service.registerFunction("weather", async () => {
      throw new RuntimeError("the API is down");
    });

    const recordedFrames = recordBroadcasts(service);
    internals(service).pushError = asyncMock();

    await service.runFunctionCalls([call("weather", "call_1")]);

    const result = recordedFrames.at(-1) as FunctionCallResultFrame;
    expect(result).toBeInstanceOf(FunctionCallResultFrame);
    expect(result.error).toEqual("RuntimeError: the API is down");
    expect(result.result).toEqual(
      LLMService.FUNCTION_CALL_ERROR_MESSAGE_TEMPLATE.replaceAll("{function_name}", "weather"),
    );
  });

  test("test_a_call_that_returns_carries_no_error", async () => {
    const service = new MockLLMService();
    internals(service)._callEventHandler = asyncMock();
    runFunctionCallsInline(service);

    service.registerFunction("weather", async (params) => {
      await params.resultCallback({ temperature: 12 });
    });

    const recordedFrames = recordBroadcasts(service);

    await service.runFunctionCalls([call("weather", "call_1")]);

    const result = recordedFrames.at(-1) as FunctionCallResultFrame;
    expect(result.result).toEqual({ temperature: 12 });
    expect(result.error).toBeNull();
  });

  test("test_function_unregistered_between_queue_and_execute", async () => {
    // Function unregistered between queuing and execution still terminates.
    const service = new MockLLMService();
    internals(service)._callEventHandler = asyncMock();

    service.registerFunction("doomed_tool", async (params) => {
      await params.resultCallback("should not be called");
    });

    const recordedFrames = recordBroadcasts(service);

    const runInline = async (runnerItems: FunctionCallRunnerItem[]) => {
      // Simulate the function being unregistered after queuing but before execution.
      service.unregisterFunction("doomed_tool");
      for (const runnerItem of runnerItems) {
        await internals(service)._runFunctionCall(runnerItem);
      }
    };
    internals(service)._runParallelFunctionCalls = runInline;
    internals(service)._runSequentialFunctionCalls = runInline;

    await service.runFunctionCalls([call("doomed_tool", "call_1")]);

    expect(recordedFrames.map((f) => f.constructor)).toEqual([
      FunctionCallsStartedFrame,
      FunctionCallInProgressFrame,
      FunctionCallResultFrame,
    ]);
    expect((recordedFrames[2] as FunctionCallResultFrame).result).toEqual(
      expectedMissingToolMessage("doomed_tool"),
    );
  });

  test("test_missing_function_call_dev_error_logged_as_error", async () => {
    // Tool advertised to the LLM but missing a handler → logger.error.
    const service = new MockLLMService();
    internals(service)._callEventHandler = asyncMock();
    runFunctionCallsInline(service);
    internals(service).broadcastFrame = asyncMock();

    const context = new LLMContext({
      tools: new ToolsSchema({
        standardTools: [
          new FunctionSchema({
            name: "advertised_but_unhandled",
            description: "",
            properties: {},
            required: [],
          }),
        ],
      }),
    });

    const log = patchLogger();
    await service.runFunctionCalls([call("advertised_but_unhandled", "call_1", {}, context)]);

    expect(
      log.errors.some(
        (e) =>
          e.includes("advertised") &&
          e.includes("register_function") &&
          e.includes("advertised_but_unhandled"),
      ),
    ).toBe(true);
    expect(log.warnings.some((w) => w.includes("not in the currently advertised tool set"))).toBe(
      false,
    );
  });

  test("test_missing_function_call_hallucination_logged_as_warning", async () => {
    // Tool not advertised to the LLM → logger.warning (hallucination).
    const service = new MockLLMService();
    internals(service)._callEventHandler = asyncMock();
    runFunctionCallsInline(service);
    internals(service).broadcastFrame = asyncMock();

    const context = new LLMContext({
      tools: new ToolsSchema({
        standardTools: [
          new FunctionSchema({
            name: "something_else",
            description: "",
            properties: {},
            required: [],
          }),
        ],
      }),
    });

    const log = patchLogger();
    await service.runFunctionCalls([call("never_advertised", "call_1", {}, context)]);

    expect(
      log.warnings.some(
        (w) =>
          w.includes("not in the currently advertised tool set") && w.includes("never_advertised"),
      ),
    ).toBe(true);
    expect(
      log.errors.some((e) => e.includes("advertised") && e.includes("register_function")),
    ).toBe(false);
  });

  test("test_catch_all_handler_suppresses_missing_warnings", async () => {
    // register_function(None, ...) suppresses both dev-error and hallucination logs.
    const service = new MockLLMService();
    internals(service)._callEventHandler = asyncMock();
    runFunctionCallsInline(service);
    internals(service).broadcastFrame = asyncMock();

    service.registerFunction(null, async (params) => {
      await params.resultCallback("handled");
    });

    const log = patchLogger();
    await service.runFunctionCalls([call("anything", "call_1")]);

    expect(log.errors.some((e) => e.includes("register_function"))).toBe(false);
    expect(log.warnings.some((w) => w.includes("not in the currently advertised tool set"))).toBe(
      false,
    );
  });

  test("test_missing_function_call_allows_user_mute_cleanup", async () => {
    const service = new MockLLMService();
    internals(service)._callEventHandler = asyncMock();
    runFunctionCallsInline(service);

    const recordedFrames = recordBroadcasts(service);

    await service.runFunctionCalls([call("missing_tool", "call_1")]);

    const strategy = new FunctionCallUserMuteStrategy();
    let muted = false;
    for (const frame of recordedFrames) {
      muted = await strategy.processFrame(frame);
    }

    expect(muted).toBe(false);
  });

  test("test_builtin_cancel_tool_allows_user_mute_cleanup", async () => {
    // The built-in cancel tool is excluded from FunctionCallsStartedFrame,
    // so the mute strategy sees a result frame for a tool call id it is not
    // tracking.
    const service = new MockLLMService();
    internals(service)._callEventHandler = asyncMock();
    runFunctionCallsInline(service);

    service.registerFunction(
      "async_tool",
      async (params) => {
        await params.resultCallback("done");
      },
      { cancelOnInterruption: false, cancellableByLlm: true },
    );
    internals(service)._syncRegisteredToolHandlers(NOT_GIVEN);

    const recordedFrames = recordBroadcasts(service);

    await service.runFunctionCalls([
      call(cancelToolName("async_tool"), "cancel_1", { tool_call_id: "call_1" }),
    ]);

    expect(recordedFrames.map((f) => f.constructor)).not.toContain(FunctionCallsStartedFrame);

    const strategy = new FunctionCallUserMuteStrategy();
    let muted = false;
    for (const frame of recordedFrames) {
      muted = await strategy.processFrame(frame);
    }

    expect(muted).toBe(false);
  });

  test("test_intermediate_results_allow_user_mute_cleanup", async () => {
    // An async tool reporting intermediate updates emits a result frame per
    // update, so the mute strategy sees the same tool call id finish twice.
    const service = new MockLLMService();
    internals(service)._callEventHandler = asyncMock();
    runFunctionCallsInline(service);

    service.registerFunction(
      "async_tool",
      async (params) => {
        await params.resultCallback("working", {
          properties: new FunctionCallResultProperties({ isFinal: false }),
        });
        await params.resultCallback("done");
      },
      { cancelOnInterruption: false, cancellableByLlm: true },
    );
    internals(service)._syncRegisteredToolHandlers(NOT_GIVEN);

    const recordedFrames = recordBroadcasts(service);

    await service.runFunctionCalls([call("async_tool", "call_1")]);

    expect(recordedFrames.filter((f) => f instanceof FunctionCallResultFrame).length).toEqual(2);

    const strategy = new FunctionCallUserMuteStrategy();
    let muted = false;
    for (const frame of recordedFrames) {
      muted = await strategy.processFrame(frame);
    }

    expect(muted).toBe(false);
  });
});

async function runCall(
  service: MockLLMService,
  functionName: string,
  toolCallId = "call_1",
): Promise<void> {
  await service.runFunctionCalls([call(functionName, toolCallId)]);
}

describe("TestFunctionCallTimeout", () => {
  // A function call that runs past its deadline is cancelled, not abandoned.

  // Deadlines and handler durations are kept small so the suite stays quick;
  // the gap between them is what each test actually depends on.
  const TIMEOUT = 0.1;
  const HANDLER_DURATION = 0.4;
  const SETTLE = 0.6;

  function makeService(options: MockLLMServiceOptions = {}): [MockLLMService, Frame[]] {
    const service = new MockLLMService(options);
    // These tests exercise real function call tasks, so the service needs
    // the task manager a pipeline would otherwise hand it.
    internals(service)._taskManager = new TaskManager();
    const broadcastFrames = recordBroadcasts(service);
    return [service, broadcastFrames];
  }

  async function assertTimeoutCancelsHandler(runInParallel: boolean): Promise<void> {
    const [service, frames] = makeService({ functionCallTimeoutSecs: TIMEOUT, runInParallel });
    if (!runInParallel) {
      await internals(service)._createSequentialRunnerTask();
    }

    const sideEffects: string[] = [];
    const rolledBack: string[] = [];

    const slow: Handler = async (params) => {
      try {
        await sleep(HANDLER_DURATION);
        sideEffects.push(params.toolCallId);
        await params.resultCallback({ ok: true });
      } catch (e) {
        if (e instanceof CancelledError) {
          rolledBack.push(params.toolCallId);
        }
        throw e;
      }
    };

    service.registerFunction("slow", slow);
    await runCall(service, "slow");
    await sleep(SETTLE);

    expect(sideEffects).toEqual([]);
    expect(rolledBack).toEqual(["call_1"]);
    expect(frames.map((f) => f.constructor)).toEqual([
      FunctionCallsStartedFrame,
      FunctionCallInProgressFrame,
      FunctionCallCancelFrame,
    ]);

    if (!runInParallel) {
      await internals(service)._cancelSequentialRunnerTask();
    }
  }

  test("test_timeout_cancels_handler_before_its_side_effect", async () => {
    await assertTimeoutCancelsHandler(true);
  });

  test("test_timeout_cancels_handler_before_its_side_effect_sequentially", async () => {
    await assertTimeoutCancelsHandler(false);
  });

  test("test_timeout_notifies_application_code", async () => {
    const [service] = makeService({ functionCallTimeoutSecs: TIMEOUT });
    const cancelled: string[] = [];

    service.eventHandler(
      "on_function_calls_cancelled",
      async (_service: unknown, functionCalls: FunctionCallFromLLM[]) => {
        cancelled.push(...functionCalls.map((f) => f.toolCallId));
      },
    );

    service.registerFunction("slow", async () => {
      await sleep(HANDLER_DURATION);
    });
    await runCall(service, "slow");
    await sleep(SETTLE);

    expect(cancelled).toEqual(["call_1"]);
  });

  test("test_timeout_asks_for_inference", async () => {
    // Nothing else follows up on a deadline, so it has to run the LLM.
    const [service, frames] = makeService({ functionCallTimeoutSecs: TIMEOUT });

    service.registerFunction("slow", async () => {
      await sleep(HANDLER_DURATION);
    });
    await runCall(service, "slow");
    await sleep(SETTLE);

    expect(frames.at(-1)).toBeInstanceOf(FunctionCallCancelFrame);
    expect((frames.at(-1) as FunctionCallCancelFrame).runLlm).toBe(true);
  });

  test("test_interruption_does_not_ask_for_inference", async () => {
    // The user is talking; a cancelled call must not answer over them.
    const [service, frames] = makeService();

    service.registerFunction("slow", async () => {
      await sleep(HANDLER_DURATION);
    });
    await runCall(service, "slow");
    await sleep(TIMEOUT);
    await internals(service)._handleInterruptions(new InterruptionFrame());
    await sleep(SETTLE);

    expect(frames.at(-1)).toBeInstanceOf(FunctionCallCancelFrame);
    expect((frames.at(-1) as FunctionCallCancelFrame).runLlm).toBe(false);
  });

  test("test_llm_requested_cancellation_does_not_ask_for_inference", async () => {
    // The cancelling tool's own result runs the LLM; a second run would double up.
    const [service, frames] = makeService();

    service.registerFunction(
      "slow",
      async () => {
        await sleep(HANDLER_DURATION);
      },
      { cancelOnInterruption: false },
    );
    await runCall(service, "slow");
    await sleep(TIMEOUT);
    await internals(service)._cancelFunctionCallsByToolCallId("call_1");
    await sleep(SETTLE);

    expect(frames.at(-1)).toBeInstanceOf(FunctionCallCancelFrame);
    expect((frames.at(-1) as FunctionCallCancelFrame).runLlm).toBe(false);
  });

  test("test_sequential_runner_survives_a_timeout", async () => {
    // A cancelled call must not take the sequential runner down with it.
    const [service] = makeService({ functionCallTimeoutSecs: TIMEOUT, runInParallel: false });
    await internals(service)._createSequentialRunnerTask();

    const completed: string[] = [];

    service.registerFunction("slow", async () => {
      await sleep(HANDLER_DURATION);
    });
    service.registerFunction("quick", async (params) => {
      completed.push(params.toolCallId);
      await params.resultCallback({ ok: true });
    });

    await runCall(service, "slow", "call_1");
    await sleep(SETTLE);
    await runCall(service, "quick", "call_2");
    await sleep(SETTLE);

    expect(completed).toEqual(["call_2"]);
    expect(internals(service)._sequentialRunnerTask.done()).toBe(false);

    await internals(service)._cancelSequentialRunnerTask();
  });

  test("test_result_delivered_after_a_timeout_is_rejected", async () => {
    // A handler that outlives its deadline can't settle the call late.
    const [service, frames] = makeService({ functionCallTimeoutSecs: TIMEOUT });

    service.registerFunction("stubborn", async (params) => {
      try {
        await sleep(HANDLER_DURATION);
      } catch (e) {
        if (e instanceof CancelledError) {
          // The call is already settled, so this result must not reach
          // the pipeline.
          await params.resultCallback({ too: "late" });
        }
        throw e;
      }
    });
    await runCall(service, "stubborn");
    await sleep(SETTLE);

    expect(frames.some((f) => f instanceof FunctionCallResultFrame)).toBe(false);
  });

  test("test_result_delivered_after_an_interruption_is_rejected", async () => {
    // Cancellation settles a call whatever triggered it, not just a timeout.
    const [service, frames] = makeService();

    service.registerFunction("stubborn", async (params) => {
      try {
        await sleep(HANDLER_DURATION);
      } catch (e) {
        if (e instanceof CancelledError) {
          await params.resultCallback({ too: "late" });
        }
        throw e;
      }
    });
    await runCall(service, "stubborn");
    await sleep(TIMEOUT);
    await internals(service)._handleInterruptions(new InterruptionFrame());
    await sleep(SETTLE);

    expect(frames.some((f) => f instanceof FunctionCallResultFrame)).toBe(false);
    expect(frames.at(-1)).toBeInstanceOf(FunctionCallCancelFrame);
  });

  test("test_handler_finishing_within_the_deadline_is_untouched", async () => {
    const [service, frames] = makeService({ functionCallTimeoutSecs: HANDLER_DURATION });

    service.registerFunction("quick", async (params) => {
      await sleep(TIMEOUT);
      await params.resultCallback({ ok: true });
    });
    await runCall(service, "quick");
    await sleep(SETTLE);

    expect(frames.map((f) => f.constructor)).toEqual([
      FunctionCallsStartedFrame,
      FunctionCallInProgressFrame,
      FunctionCallResultFrame,
    ]);
    expect((frames.at(-1) as FunctionCallResultFrame).result).toEqual({ ok: true });
  });

  test("test_deferred_result_after_the_handler_returns_is_delivered", async () => {
    // The deadline covers the handler; a call it deferred still settles.
    const [service, frames] = makeService({ functionCallTimeoutSecs: TIMEOUT });
    const deferred: { resultCallback?: FunctionCallParams["resultCallback"] } = {};

    service.registerFunction(
      "defer",
      async (params) => {
        deferred.resultCallback = params.resultCallback;
      },
      { cancelOnInterruption: false },
    );
    await runCall(service, "defer");
    await sleep(SETTLE);

    await deferred.resultCallback?.({ ok: true });

    expect(frames.map((f) => f.constructor)).toEqual([
      FunctionCallsStartedFrame,
      FunctionCallInProgressFrame,
      FunctionCallResultFrame,
    ]);
    expect((frames.at(-1) as FunctionCallResultFrame).result).toEqual({ ok: true });
  });

  test("test_timeout_settles_a_call_with_no_task_left_to_cancel", async () => {
    // The handler can finish while the deadline is being processed.
    //
    // Its task is gone by the time the cancellation lands, but the deadline
    // has already settled the call and rejected its result, so the pipeline
    // still has to be told the call is over.
    const [service, frames] = makeService({ functionCallTimeoutSecs: TIMEOUT });
    const cancelled: string[] = [];

    service.eventHandler(
      "on_function_calls_cancelled",
      async (_service: unknown, functionCalls: FunctionCallFromLLM[]) => {
        cancelled.push(...functionCalls.map((f) => f.toolCallId));
      },
    );

    service.registerFunction("quick", async () => {});
    const runnerItem = new FunctionCallRunnerItem({
      registryItem: fns(service).get("quick") as FunctionCallRegistryItem,
      functionName: "quick",
      toolCallId: "call_1",
      arguments: {},
      context: new LLMContext(),
    });

    // No task is tracked for this call, exactly as when the handler beat
    // the timeout to the finish.
    expect(internals(service)._functionCallTasks.size).toEqual(0);
    await internals(service)._timeoutFunctionCall(runnerItem);
    // Event handlers run in their own task.
    await sleep(TIMEOUT);

    expect(frames.map((f) => f.constructor)).toEqual([FunctionCallCancelFrame]);
    expect((frames.at(-1) as FunctionCallCancelFrame).runLlm).toBe(true);
    expect(cancelled).toEqual(["call_1"]);
  });

  test("test_cancelling_the_sequential_runner_cancels_its_call", async () => {
    // A runner going away takes the call it was running with it.
    const [service, frames] = makeService({ runInParallel: false });
    await internals(service)._createSequentialRunnerTask();

    const rolledBack: string[] = [];

    service.registerFunction("slow", async (params) => {
      try {
        await sleep(HANDLER_DURATION);
        await params.resultCallback({ ok: true });
      } catch (e) {
        if (e instanceof CancelledError) {
          rolledBack.push(params.toolCallId);
        }
        throw e;
      }
    });
    await runCall(service, "slow");
    await sleep(TIMEOUT);

    await internals(service)._cancelSequentialRunnerTask();
    await sleep(SETTLE);

    expect(rolledBack).toEqual(["call_1"]);
    expect(frames.some((f) => f instanceof FunctionCallResultFrame)).toBe(false);
  });

  test("test_per_tool_timeout_overrides_the_global_one", async () => {
    const [service, frames] = makeService({ functionCallTimeoutSecs: 10.0 });

    service.registerFunction(
      "slow",
      async (params) => {
        await sleep(HANDLER_DURATION);
        await params.resultCallback({ ok: true });
      },
      { timeoutSecs: TIMEOUT },
    );
    await runCall(service, "slow");
    await sleep(SETTLE);

    expect(frames.at(-1)).toBeInstanceOf(FunctionCallCancelFrame);
  });

  test("test_no_timeout_configured_leaves_the_call_running", async () => {
    const [service, frames] = makeService();

    service.registerFunction("slow", async (params) => {
      await sleep(HANDLER_DURATION);
      await params.resultCallback({ ok: true });
    });
    await runCall(service, "slow");
    await sleep(SETTLE);

    expect(frames.at(-1)).toBeInstanceOf(FunctionCallResultFrame);
    expect((frames.at(-1) as FunctionCallResultFrame).result).toEqual({ ok: true });
  });

  test("test_intermediate_result_does_not_disarm_the_deadline", async () => {
    // An update isn't a result, so it can't buy the handler more time.
    const [service, frames] = makeService();
    const sideEffects: string[] = [];
    const rolledBack: string[] = [];

    const progressThenHang: Handler = async (params) => {
      try {
        await params.resultCallback("working", {
          properties: new FunctionCallResultProperties({ isFinal: false }),
        });
        await sleep(HANDLER_DURATION);
        sideEffects.push(params.toolCallId);
        await params.resultCallback({ ok: true });
      } catch (e) {
        if (e instanceof CancelledError) {
          rolledBack.push(params.toolCallId);
        }
        throw e;
      }
    };

    service.registerFunction("progress", progressThenHang, {
      cancelOnInterruption: false,
      timeoutSecs: TIMEOUT,
    });
    await runCall(service, "progress");
    await sleep(SETTLE);

    expect(sideEffects).toEqual([]);
    expect(rolledBack).toEqual(["call_1"]);
    expect(frames.map((f) => f.constructor)).toEqual([
      FunctionCallsStartedFrame,
      FunctionCallInProgressFrame,
      FunctionCallResultFrame,
      FunctionCallCancelFrame,
    ]);
    expect((frames[2] as FunctionCallResultFrame).properties?.isFinal).toBe(false);
    expect((frames.at(-1) as FunctionCallCancelFrame).runLlm).toBe(true);
  });

  test("test_a_hanging_async_tool_times_out_without_any_update", async () => {
    // Control for the test above, differing only in the missing update.
    const [service, frames] = makeService();
    const rolledBack: string[] = [];

    const hang: Handler = async (params) => {
      try {
        await sleep(HANDLER_DURATION);
        await params.resultCallback({ ok: true });
      } catch (e) {
        if (e instanceof CancelledError) {
          rolledBack.push(params.toolCallId);
        }
        throw e;
      }
    };

    service.registerFunction("hang", hang, { cancelOnInterruption: false, timeoutSecs: TIMEOUT });
    await runCall(service, "hang");
    await sleep(SETTLE);

    expect(rolledBack).toEqual(["call_1"]);
    expect(frames.map((f) => f.constructor)).toEqual([
      FunctionCallsStartedFrame,
      FunctionCallInProgressFrame,
      FunctionCallCancelFrame,
    ]);
    expect((frames.at(-1) as FunctionCallCancelFrame).runLlm).toBe(true);
  });
});

describe("TestFunctionCallError", () => {
  // A handler that raises settles its call instead of holding it open.

  const TIMEOUT = 0.1;
  const SETTLE = 0.6;

  interface PushedError {
    errorMsg: string;
    exception?: unknown;
    category?: ErrorCategory | null;
  }

  function makeService(
    options: MockLLMServiceOptions = {},
  ): [MockLLMService, Frame[], PushedError[]] {
    const service = new MockLLMService(options);
    internals(service)._taskManager = new TaskManager();

    const broadcastFrames = recordBroadcasts(service);
    const errors: PushedError[] = [];

    internals(service).pushError = async (
      errorMsg: string,
      opts: Omit<PushedError, "errorMsg"> = {},
    ) => {
      errors.push({ errorMsg, ...opts });
    };
    return [service, broadcastFrames, errors];
  }

  test("test_a_raising_handler_settles_its_call", async () => {
    const [service, frames] = makeService();

    service.registerFunction("boom", async () => {
      throw new RuntimeError("kaboom");
    });
    await runCall(service, "boom");
    await sleep(SETTLE);

    expect(frames.map((f) => f.constructor)).toEqual([
      FunctionCallsStartedFrame,
      FunctionCallInProgressFrame,
      FunctionCallResultFrame,
    ]);
    expect((frames.at(-1) as FunctionCallResultFrame).result).toEqual(
      "The function `boom` failed and returned no result.",
    );
  });

  test("test_a_raising_handler_still_reports_the_error_upstream", async () => {
    const [service, , errors] = makeService();

    service.registerFunction("boom", async () => {
      throw new RuntimeError("kaboom");
    });
    await runCall(service, "boom");
    await sleep(SETTLE);

    expect(errors.length).toEqual(1);
    expect(errors[0]?.errorMsg).toContain("kaboom");
    expect(errors[0]?.exception).toBeInstanceOf(RuntimeError);
  });

  test("test_the_exception_is_kept_out_of_the_llm_context", async () => {
    // Exception text reaches the user through the LLM; the ErrorFrame carries it instead.
    const [service, frames] = makeService();

    service.registerFunction("boom", async () => {
      throw new RuntimeError("connection refused: token=sk-secret");
    });
    await runCall(service, "boom");
    await sleep(SETTLE);

    const result = (frames.at(-1) as FunctionCallResultFrame).result as string;
    expect(result).not.toContain("sk-secret");
    expect(result).not.toContain("connection refused");
  });

  test("test_a_handler_that_reports_then_raises_keeps_its_result", async () => {
    const [service, frames] = makeService();

    service.registerFunction("report_then_boom", async (params) => {
      await params.resultCallback({ ok: true });
      throw new RuntimeError("kaboom");
    });
    await runCall(service, "report_then_boom");
    await sleep(SETTLE);

    const results = frames.filter(
      (f): f is FunctionCallResultFrame => f instanceof FunctionCallResultFrame,
    );
    expect(results.length).toEqual(1);
    expect(results[0]?.result).toEqual({ ok: true });
  });

  test("test_a_raising_handler_does_not_also_time_out", async () => {
    // The deadline is cancelled on the way out, so the call settles once.
    const [service, frames] = makeService({ functionCallTimeoutSecs: TIMEOUT });

    service.registerFunction("boom", async () => {
      throw new RuntimeError("kaboom");
    });
    await runCall(service, "boom");
    await sleep(SETTLE);

    expect(frames.some((f) => f instanceof FunctionCallCancelFrame)).toBe(false);
  });

  test("test_the_sequential_runner_survives_a_raising_handler", async () => {
    const [service, frames] = makeService({ runInParallel: false });
    await internals(service)._createSequentialRunnerTask();

    service.registerFunction("boom", async () => {
      throw new RuntimeError("kaboom");
    });
    service.registerFunction("fine", async (params) => {
      await params.resultCallback({ ok: true });
    });
    await runCall(service, "boom");
    await runCall(service, "fine", "call_2");
    await sleep(SETTLE);

    const results = frames.filter(
      (f): f is FunctionCallResultFrame => f instanceof FunctionCallResultFrame,
    );
    expect(results.map((f) => f.toolCallId)).toEqual(["call_1", "call_2"]);
    expect(results.at(-1)?.result).toEqual({ ok: true });

    await internals(service)._cancelSequentialRunnerTask();
  });
});

describe("TestAppendSystemInstruction", () => {
  // Coverage for `LLMService.appendSystemInstruction`.

  function makeService(systemInstruction: string | null = null): MockLLMService {
    // Construct with the prompt so the base snapshot happens the real way
    // (in the constructor), rather than poking _baseSystemInstruction directly.
    return new MockLLMService({ systemInstruction });
  }

  function si(service: MockLLMService): string | null {
    return internals(service)._settings.systemInstruction;
  }

  test("test_append_preserves_existing_prompt", () => {
    const service = makeService("APP");
    service.appendSystemInstruction("GUIDE");
    expect(si(service)).toEqual("APP\n\nGUIDE");
  });

  test("test_append_with_no_base_uses_text_alone", () => {
    const service = makeService(null);
    service.appendSystemInstruction("GUIDE");
    expect(si(service)).toEqual("GUIDE");
  });

  test("test_multiple_appends_join_in_order", () => {
    const service = makeService("APP");
    service.appendSystemInstruction("G1");
    service.appendSystemInstruction("G2");
    expect(si(service)).toEqual("APP\n\nG1\n\nG2");
  });

  test("test_composition_is_logged_only_when_it_changes", () => {
    const service = makeService("APP");
    const logged: string[] = [];
    logger.setLevel("DEBUG");
    const remove = logger.addSink((record) => {
      logged.push(`${record.message}\n`);
    });
    try {
      service.appendSystemInstruction("GUIDE");
      // Every tool sync recomposes; an unchanged instruction stays quiet.
      internals(service)._composeSystemInstruction();
      internals(service)._composeSystemInstruction();
      service.appendSystemInstruction("MORE");
    } finally {
      remove();
    }
    const composed = logged.filter((line) => line.includes("System instruction composed"));
    expect(composed.length).toEqual(2);
    expect(composed[0]).toContain("APP\n\nGUIDE\n");
    expect(composed[1]).toContain("MORE");
  });

  test("test_appended_guide_survives_turn_completion_toggle", async () => {
    const service = makeService("APP");
    service.appendSystemInstruction("GUIDE");

    // Enabling turn completion composes after the appended guide, once.
    await internals(service)._updateSettings(new LLMSettings({ filterIncompleteUserTurns: true }));
    const composed = si(service) as string;
    expect(composed.startsWith("APP\n\nGUIDE\n\n")).toBe(true);
    expect(composed.split("GUIDE").length - 1).toEqual(1);

    // Disabling restores base + guide (without the turn instructions).
    await internals(service)._updateSettings(new LLMSettings({ filterIncompleteUserTurns: false }));
    expect(si(service)).toEqual("APP\n\nGUIDE");
  });

  test("test_runtime_system_instruction_update_preserves_appended", async () => {
    const service = makeService("APP");
    service.appendSystemInstruction("GUIDE");

    // A runtime system_instruction change replaces the base but keeps the
    // appended guide composed onto the end.
    await internals(service)._updateSettings(new LLMSettings({ systemInstruction: "NEW" }));
    expect(si(service)).toEqual("NEW\n\nGUIDE");
  });

  test("test_base_set_after_append_composes", async () => {
    // No base at construction; the guide is appended first, then the user
    // sets a system_instruction at runtime. The guide is retained.
    const service = makeService(null);
    service.appendSystemInstruction("GUIDE");
    expect(si(service)).toEqual("GUIDE");

    await internals(service)._updateSettings(new LLMSettings({ systemInstruction: "APP" }));
    expect(si(service)).toEqual("APP\n\nGUIDE");
  });

  test("test_appended_guide_survives_async_tool_cancellation", () => {
    const handler = async () => {};

    const service = makeService("APP");
    service.appendSystemInstruction("GUIDE");

    // A cancellable tool composes its instructions after the appended guide,
    // without duplicating it.
    service.registerFunction("write_report", handler, {
      cancelOnInterruption: false,
      cancellableByLlm: true,
    });
    internals(service)._syncRegisteredToolHandlers(NOT_GIVEN);
    const composed = si(service) as string;
    expect(composed.startsWith("APP\n\nGUIDE\n\n")).toBe(true);
    expect(composed.split("GUIDE").length - 1).toEqual(1);
    expect(composed).not.toEqual("APP\n\nGUIDE");
  });
});

describe("TestCancellationToolBehaviour", () => {
  // What the built-in tools report and refuse.

  const handler: Handler = async () => {};

  function serviceWithRunningCalls(): MockLLMService {
    // A service holding two in-flight calls, one cancellable and one not.
    const service = new MockLLMService();
    service.registerFunction("write_report", handler, {
      cancelOnInterruption: false,
      cancellableByLlm: true,
    });
    service.registerFunction("get_current_weather", handler, { cancelOnInterruption: false });
    internals(service)._syncRegisteredToolHandlers(NOT_GIVEN);
    // A null task stands for a call with no live task behind it, which is
    // what lets these run without a task manager.
    const entries: [unknown, [string, string]][] = [
      [null, ["write_report", "call-1"]],
      [{}, ["get_current_weather", "call-2"]],
    ];
    for (const [task, [name, callId]] of entries) {
      internals(service)._functionCallTasks.set(
        task,
        new FunctionCallRunnerItem({
          registryItem: fns(service).get(name) as FunctionCallRegistryItem,
          functionName: name,
          toolCallId: callId,
          arguments: {},
          context: null as unknown as LLMContext,
        }),
      );
    }
    return service;
  }

  async function invoke(
    service: MockLLMService,
    name: string,
    args: Record<string, unknown>,
  ): Promise<any> {
    const results: unknown[] = [];

    const resultCallback = async (result: unknown) => {
      results.push(result);
    };

    const registered = fns(service).get(name) as FunctionCallRegistryItem;
    await (registered.handler as Handler)(
      new FunctionCallParams({
        functionName: name,
        toolCallId: "builtin-call",
        arguments: args,
        llm: service,
        pipelineWorker: service.pipelineWorker,
        context: null as unknown as LLMContext,
        resultCallback,
        appResources: null,
      }),
    );
    return results[0];
  }

  test("test_cancelling_falls_back_to_the_only_running_call", async () => {
    // Omitting tool_call_id with one call running means that call, which is
    // why the schema doesn't ask for it.
    const service = serviceWithRunningCalls();
    const result = await invoke(service, cancelToolName("write_report"), {});
    expect(result.cancelled).toEqual("call-1");
  });

  test("test_cancelling_by_tool_call_id", async () => {
    const service = serviceWithRunningCalls();
    const result = await invoke(service, cancelToolName("write_report"), {
      tool_call_id: "call-1",
    });
    expect(result.cancelled).toEqual("call-1");
  });

  test("test_refused_when_no_such_call_is_running", async () => {
    const service = serviceWithRunningCalls();
    internals(service)._functionCallTasks.clear();
    const result = await invoke(service, cancelToolName("write_report"), {});
    expect(result.cancelled).toBeNull();
  });

  test("test_ambiguous_call_asks_for_a_tool_call_id", async () => {
    const service = serviceWithRunningCalls();
    // A second call of the same tool: the tool name no longer picks one out.
    internals(service)._functionCallTasks.set(
      {},
      new FunctionCallRunnerItem({
        registryItem: fns(service).get("write_report") as FunctionCallRegistryItem,
        functionName: "write_report",
        toolCallId: "call-3",
        arguments: {},
        context: null as unknown as LLMContext,
      }),
    );
    const result = await invoke(service, cancelToolName("write_report"), {});
    expect(result.cancelled).toBeNull();
    expect(new Set(result.running.map((r: { tool_call_id: string }) => r.tool_call_id))).toEqual(
      new Set(["call-1", "call-3"]),
    );
  });

  // Deprecated upstream API (`enable_async_tool_cancellation`) is not ported.
  test.skip("test_a_call_covered_only_by_the_deprecated_flag_is_cancelled", () => {});
});

describe("TestAsyncToolCancellationExposure", () => {
  // A cancellable tool brings its own cancel tool, named for it.

  const handler: Handler = async () => {};

  function sync(service: MockLLMService): void {
    internals(service)._syncRegisteredToolHandlers(NOT_GIVEN);
  }

  function advertised(service: MockLLMService): Set<string> {
    return new Set(Object.keys(service.getLlmAdapter().builtinTools));
  }

  test("test_a_cancellable_tool_gets_its_own_cancel_tool", () => {
    const service = new MockLLMService();
    service.registerFunction("write_report", handler, {
      cancelOnInterruption: false,
      cancellableByLlm: true,
    });
    sync(service);
    expect(advertised(service)).toEqual(new Set([cancelToolName("write_report")]));
    expect(fns(service).has(cancelToolName("write_report"))).toBe(true);
  });

  test("test_built_in_tools_are_sent_alone_when_there_are_no_others", () => {
    const service = new MockLLMService();
    service.registerFunction("write_report", handler, {
      cancelOnInterruption: false,
      cancellableByLlm: true,
    });
    sync(service);
    const converted = service.getLlmAdapter().fromStandardTools(NOT_GIVEN) as {
      function: { name: string };
    }[];
    expect(converted.map((t) => t.function.name)).toEqual([cancelToolName("write_report")]);
  });

  test("test_the_cancel_tool_does_not_ask_for_a_tool_call_id", () => {
    // Requiring it would make every cancellation go looking for an id first,
    // including the common case of one call running.
    const service = new MockLLMService();
    service.registerFunction("write_report", handler, {
      cancelOnInterruption: false,
      cancellableByLlm: true,
    });
    sync(service);
    const schema = internals(service)._adapter.builtinTools[
      cancelToolName("write_report")
    ] as FunctionSchema;
    expect(schema.required).toEqual([]);
    expect(Object.keys(schema.properties)).toContain("tool_call_id");
  });

  test("test_a_tool_that_did_not_opt_in_gets_none", () => {
    const service = new MockLLMService();
    service.registerFunction("write_report", handler, {
      cancelOnInterruption: false,
      cancellableByLlm: true,
    });
    service.registerFunction("get_current_weather", handler, { cancelOnInterruption: false });
    sync(service);
    // The weather tool has no cancel tool, so there is nothing to call against it.
    expect(advertised(service).has(cancelToolName("get_current_weather"))).toBe(false);
  });

  test("test_nothing_advertised_without_a_cancellable_tool", () => {
    const service = new MockLLMService();
    service.registerFunction("get_current_weather", handler, { cancelOnInterruption: false });
    sync(service);
    expect(advertised(service)).toEqual(new Set());
  });

  test("test_withdrawn_when_the_cancellable_tool_goes", () => {
    const service = new MockLLMService();
    service.registerFunction("write_report", handler, {
      cancelOnInterruption: false,
      cancellableByLlm: true,
    });
    sync(service);
    service.unregisterFunction("write_report");
    sync(service);
    expect(advertised(service)).toEqual(new Set());
  });

  test("test_cancellable_by_llm_ignored_on_a_synchronous_tool", () => {
    // There is no moment at which the LLM could cancel a call it is waiting on.
    const service = new MockLLMService();
    service.registerFunction("lookup", handler, { cancellableByLlm: true });
    sync(service);
    expect(fns(service).get("lookup")?.cancellableByLlm).toBe(false);
    expect(advertised(service)).toEqual(new Set());
  });

  // Deprecated upstream API (`enable_async_tool_cancellation`) is not ported.
  test.skip("test_deprecated_flag_covers_every_async_tool", () => {});
  // Deprecated upstream API (`enable_async_tool_cancellation`) is not ported.
  test.skip("test_deprecated_flag_needs_an_async_tool", () => {});
});

describe("TestAsyncToolInstructions", () => {
  // The async-tool guidance follows the registry, however a tool got there.

  const handler: Handler = async () => {};

  function composedOf(service: MockLLMService): string {
    return internals(service)._settings.systemInstruction || "";
  }

  test("test_manual_async_registration", () => {
    const service = new MockLLMService({ systemInstruction: "BASE" });
    service.registerFunction("weather", handler, { cancelOnInterruption: false });
    // A manual registration never goes through the advertised-tool path, and a
    // context can advertise nothing at all; the sync still settles the registry.
    internals(service)._syncRegisteredToolHandlers(NOT_GIVEN);
    expect(composedOf(service)).toContain("ASYNC TOOLS:");
  });

  test("test_advertised_async_tool", () => {
    const service = new MockLLMService({ systemInstruction: "BASE" });
    service.registerFunction("weather", handler, { cancelOnInterruption: false });
    internals(service)._syncRegisteredToolHandlers(new LLMContext({ tools: NOT_GIVEN }).tools);
    expect(composedOf(service)).toContain("ASYNC TOOLS:");
  });

  test("test_absent_without_async_tools", () => {
    const service = new MockLLMService({ systemInstruction: "BASE" });
    service.registerFunction("weather", handler);
    internals(service)._syncRegisteredToolHandlers(NOT_GIVEN);
    expect(composedOf(service)).not.toContain("ASYNC TOOLS:");
    expect(composedOf(service)).toEqual("BASE");
  });

  test("test_absent_for_a_cancel_tool_alone", () => {
    // A cancel tool registers as synchronous, so it never brings the async
    // guidance in on its own.
    const service = new MockLLMService({ systemInstruction: "BASE" });
    service.registerFunction("write_report", handler, {
      cancelOnInterruption: false,
      cancellableByLlm: true,
    });
    internals(service)._syncRegisteredToolHandlers(NOT_GIVEN);
    service.unregisterFunction("write_report");
    internals(service)._syncRegisteredToolHandlers(NOT_GIVEN);
    expect(composedOf(service)).not.toContain("ASYNC TOOLS:");
  });
});

describe("TestProcessFrameToolWiring", () => {
  // processFrame syncs handlers from the context frame's advertised tools.

  test("test_context_frame_syncs_registered_direct_functions", async () => {
    const service = new MockLLMService();
    const syncMock = mock((_tools: unknown) => {});
    internals(service)._syncRegisteredToolHandlers = syncMock;
    const ctx = new LLMContext({ tools: NOT_GIVEN });
    await service.processFrame(new LLMContextFrame({ context: ctx }), FrameDirection.DOWNSTREAM);
    expect(syncMock).toHaveBeenCalledTimes(1);
    expect(syncMock).toHaveBeenCalledWith(ctx.tools);
  });

  test("test_base_service_does_not_handle_set_tools_frame", async () => {
    // The base service syncs handlers only from the context frame. An
    // LLMSetToolsFrame is a pure aggregator concern here; only realtime
    // services that run continuously handle it for handler sync.
    const service = new MockLLMService();
    const syncMock = mock((_tools: unknown) => {});
    internals(service)._syncRegisteredToolHandlers = syncMock;
    await service.processFrame(
      new LLMSetToolsFrame({ tools: NOT_GIVEN }),
      FrameDirection.DOWNSTREAM,
    );
    expect(syncMock).not.toHaveBeenCalled();
  });
});

describe("TestTurnCompletionSettingsDeprecation", () => {
  // The turn-completion settings belong to the user turn strategy.
  //
  // `LLMTurnCompletionUserTurnStopStrategy` enables them over an
  // `LLMUpdateSettingsFrame` and is also what finalizes the user turn from the
  // resulting verdict, so an application that sets them on the service directly
  // gets the marker protocol with nothing waiting on it.

  // Deprecated upstream API: the construction-time DeprecationWarning is not ported.
  test.skip("test_filter_incomplete_user_turns_at_construction_warns", () => {});
  // Deprecated upstream API: the construction-time DeprecationWarning is not ported.
  test.skip("test_user_turn_completion_config_at_construction_warns", () => {});

  test("test_construction_without_the_settings_is_silent", () => {
    // DeprecationWarnings aren't ported, so "silent" reduces to constructing
    // without raising.
    new MockLLMService();
    // Spelling the fields out with their off values, the way concrete
    // services build their defaults, must not warn either.
    new MockLLMService({ filterIncompleteUserTurns: false, userTurnCompletionConfig: null });
  });

  test("test_strategy_settings_update_is_silent", async () => {
    // The strategy's own update is how the setting is meant to arrive.
    const service = new MockLLMService();
    await service.processFrame(
      new LLMUpdateSettingsFrame({ delta: new LLMSettings({ filterIncompleteUserTurns: true }) }),
      FrameDirection.DOWNSTREAM,
    );
    expect(internals(service)._filterIncompleteUserTurns).toBe(true);
  });
});

describe("TestToolHandlerErrorClassification", () => {
  // A tool handler's own failures say nothing about the LLM service.

  async function runFailingTool(exception: Error): Promise<[MockLLMService, ErrorFrame[]]> {
    const service = new MockLLMService();
    internals(service)._callEventHandler = asyncMock();
    internals(service).broadcastFrame = asyncMock();

    service.registerFunction("call_some_api", async () => {
      throw exception;
    });

    const errors: ErrorFrame[] = [];

    internals(service).pushErrorFrame = async (error: ErrorFrame) => {
      errors.push(error);
    };

    const runInline = async (runnerItems: FunctionCallRunnerItem[]) => {
      for (const runnerItem of runnerItems) {
        await internals(service)._runFunctionCall(runnerItem);
      }
    };
    internals(service)._runParallelFunctionCalls = runInline;
    internals(service)._runSequentialFunctionCalls = runInline;

    await service.runFunctionCalls([call("call_some_api", "call_1")]);

    return [service, errors];
  }

  /** `httpx.HTTPStatusError`: an error carrying the HTTP response it failed with. */
  function httpStatusError(message: string, status: number): Error {
    return Object.assign(new Error(message), {
      request: new Request("https://weather.example.com/forecast"),
      response: new Response(null, { status }),
    });
  }

  test("test_http_error_from_a_tool_does_not_misconfigure_the_service", async () => {
    // A tool calls an unrelated API that answers 404. The LLM's own
    // credentials are fine, so it must stay usable.
    const [service, errors] = await runFailingTool(httpStatusError("Not Found", 404));

    expect(errors.length).toEqual(1);
    expect(errors[0]?.category).toEqual(ErrorCategory.APPLICATION);
    expect(service.isUsable).toBe(true);
  });

  test("test_rejected_credentials_from_a_tool_leave_the_service_usable", async () => {
    // The same holds for a 401 from whatever the tool called.
    const [service, errors] = await runFailingTool(httpStatusError("Unauthorized", 401));

    expect(errors[0]?.category).toEqual(ErrorCategory.APPLICATION);
    expect(service.isUsable).toBe(true);
  });

  test("test_plain_tool_failures_are_still_reported", async () => {
    const [, errors] = await runFailingTool(new ValueError("bad arguments"));

    expect(errors.length).toEqual(1);
    expect(errors[0]?.error).toContain("call_some_api");
    expect(errors[0]?.category).toEqual(ErrorCategory.APPLICATION);
  });
});
