// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_app_resources.py

import { describe, expect, mock, test } from "bun:test";
import { DirectFunctionWrapper } from "../src/adapters/schemas/direct_function.ts";
import { SystemClock } from "../src/clocks/system_clock.ts";
import { EndFrame, type Frame, StartFrame } from "../src/frames/frames.ts";
import { Pipeline } from "../src/pipeline/pipeline.ts";
import { PipelineWorker } from "../src/pipeline/worker.ts";
import { LLMContext } from "../src/processors/aggregators/llm_context.ts";
import {
  type FrameDirection,
  FrameProcessor,
  FrameProcessorSetup,
  type FrameProcessorSetupOptions,
} from "../src/processors/frame_processor.ts";
import {
  FunctionCallParams,
  FunctionCallRegistryItem,
  FunctionCallRunnerItem,
  LLMService,
  type LLMServiceOptions,
} from "../src/services/llm_service.ts";
import { LLMSettings } from "../src/services/settings.ts";
import { type BaseTaskManager, TaskManager } from "../src/utils/asyncio/task_manager.ts";
import { WorkerParams } from "../src/workers/base_worker.ts";

/**
 * Port of `tests/frame_processor_helpers.frame_processor_setup`: build a setup
 * configuration for a processor used outside a pipeline.
 */
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

class _Resources {
  userName: string;
  db: Record<string, unknown>;

  constructor(options: { userName: string; db?: Record<string, unknown> }) {
    this.userName = options.userName;
    this.db = options.db ?? {};
  }
}

/**
 * Return an LLMSettings with every field set so test_service_init's
 * auto-discovered `_MockLLMService` doesn't fail its NOT_GIVEN check.
 */
function _completeLlmSettings(): LLMSettings {
  return new LLMSettings({
    model: null,
    systemInstruction: null,
    temperature: null,
    maxTokens: null,
    topP: null,
    topK: null,
    frequencyPenalty: null,
    presencePenalty: null,
    seed: null,
    filterIncompleteUserTurns: null,
    userTurnCompletionConfig: null,
  });
}

class _MockLLMService extends LLMService {
  constructor(options: LLMServiceOptions = {}) {
    super({ ...options, settings: _completeLlmSettings() });
  }

  // Test access to protected members (Python reads/writes them directly).
  set setupForTest(setup: FrameProcessorSetup) {
    this._setup = setup;
  }

  get functions(): Map<string | null, FunctionCallRegistryItem> {
    return this._functions;
  }

  async runFunctionCallForTest(runnerItem: FunctionCallRunnerItem): Promise<void> {
    await this._runFunctionCall(runnerItem);
  }
}

describe("TestFunctionCallParamsAppResources", () => {
  test("test_default_is_none", () => {
    const params = new FunctionCallParams({
      functionName: "f",
      toolCallId: "1",
      arguments: {},
      llm: null as never,
      pipelineWorker: null as never,
      context: new LLMContext(),
      resultCallback: mock(async () => {}),
    });
    expect(params.appResources).toBeNull();
  });

  test("test_holds_reference", () => {
    const resources = new _Resources({ userName: "John" });
    const params = new FunctionCallParams({
      functionName: "f",
      toolCallId: "1",
      arguments: {},
      llm: null as never,
      pipelineWorker: null as never,
      context: new LLMContext(),
      resultCallback: mock(async () => {}),
      appResources: resources,
    });
    expect(params.appResources).toBe(resources);
  });

  // Deprecated upstream API (`FunctionCallParams.tool_resources`) is not ported.
  test.skip("test_tool_resources_property_warns_and_aliases_app_resources", () => {});
});

describe("TestLLMServiceFunctionCallReadsWorkerRunner", () => {
  test("test_function_call_params_receives_worker_runner", async () => {
    // A tool handler reaches the runner without the app wiring it through.
    const service = new _MockLLMService();
    const runner = { name: "stub-runner" };
    service.setupForTest = frameProcessorSetup(new TaskManager(), {
      pipelineWorker: { appResources: null, workerRunner: runner } as never,
    });

    const captured: Record<string, unknown> = {};

    const handler = async (params: FunctionCallParams) => {
      captured.worker_runner = params.workerRunner;
      await params.resultCallback({ ok: true });
    };

    service.functions.set(
      "lookup",
      new FunctionCallRegistryItem({
        functionName: "lookup",
        handler,
        cancelOnInterruption: true,
      }),
    );
    service.broadcastFrame = mock(async () => {}) as never;

    const runnerItem = new FunctionCallRunnerItem({
      registryItem: service.functions.get("lookup") as FunctionCallRegistryItem,
      functionName: "lookup",
      toolCallId: "call-1",
      arguments: {},
      context: new LLMContext(),
    });
    await service.runFunctionCallForTest(runnerItem);

    expect(captured.worker_runner).toBe(runner);
  });
});

describe("TestLLMServiceFunctionCallReadsAppResources", () => {
  test("test_function_call_params_receives_app_resources", async () => {
    const service = new _MockLLMService();
    const resources = new _Resources({ userName: "John" });
    // Stub the pipeline worker with just the bit LLMService reads.
    service.setupForTest = frameProcessorSetup(new TaskManager(), {
      pipelineWorker: { appResources: resources, workerRunner: null } as never,
    });

    const captured: Record<string, FunctionCallParams> = {};

    const handler = async (params: FunctionCallParams) => {
      captured.params = params;
      (params.appResources as _Resources).db.hit = true;
      await params.resultCallback({ ok: true });
    };

    service.functions.set(
      "lookup",
      new FunctionCallRegistryItem({
        functionName: "lookup",
        handler,
        cancelOnInterruption: true,
      }),
    );
    service.broadcastFrame = mock(async () => {}) as never;

    const runnerItem = new FunctionCallRunnerItem({
      registryItem: service.functions.get("lookup") as FunctionCallRegistryItem,
      functionName: "lookup",
      toolCallId: "call-1",
      arguments: {},
      context: new LLMContext(),
    });
    await service.runFunctionCallForTest(runnerItem);

    expect(captured.params?.appResources).toBe(resources);
    expect(resources.db.hit).toBeTruthy();
  });

  test("test_direct_function_params_receives_app_resources", async () => {
    const service = new _MockLLMService();
    const resources = new _Resources({ userName: "John" });
    service.setupForTest = frameProcessorSetup(new TaskManager(), {
      pipelineWorker: { appResources: resources, workerRunner: null } as never,
    });
    const captured: Record<string, FunctionCallParams> = {};

    async function lookup(params: FunctionCallParams) {
      captured.params = params;
    }

    const wrapper = new DirectFunctionWrapper(lookup);
    service.functions.set(
      wrapper.name,
      new FunctionCallRegistryItem({
        functionName: wrapper.name,
        handler: wrapper,
        cancelOnInterruption: true,
      }),
    );
    service.broadcastFrame = mock(async () => {}) as never;

    const runnerItem = new FunctionCallRunnerItem({
      registryItem: service.functions.get(wrapper.name) as FunctionCallRegistryItem,
      functionName: wrapper.name,
      toolCallId: "call-1",
      arguments: {},
      context: new LLMContext(),
    });
    await service.runFunctionCallForTest(runnerItem);

    expect(captured.params?.appResources).toBe(resources);
  });

  // Deprecated upstream API (`FrameProcessorSetup.tool_resources`) is not ported.
  test.skip("test_frame_processor_setup_tool_resources_warns_on_read", () => {});
});

describe("TestPipelineWorkerAppResources", () => {
  test("test_getter_returns_constructor_value", () => {
    const resources = new _Resources({ userName: "John" });
    const worker = new PipelineWorker(new Pipeline([]), { appResources: resources });
    expect(worker.appResources).toBe(resources);
  });

  test("test_default_app_resources_is_none", () => {
    const worker = new PipelineWorker(new Pipeline([]));
    expect(worker.appResources).toBeNull();
  });

  // Deprecated upstream API (`PipelineWorker(tool_resources=...)`) is not ported.
  test.skip("test_tool_resources_kwarg_warns_and_aliases_app_resources", () => {});

  // Deprecated upstream API (`PipelineWorker(tool_resources=...)`) is not ported.
  test.skip("test_app_resources_takes_precedence_over_tool_resources", () => {});
});

/** Records the pipelineWorker it sees once StartFrame reaches it. */
class _RecordingProcessor extends FrameProcessor {
  observedTask: unknown = null;
  observedAppResources: unknown = null;

  override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
    await super.processFrame(frame, direction);
    if (frame instanceof StartFrame) {
      // setup() runs before any frame reaches us, so pipelineWorker is wired up.
      if (this.pipelineWorker == null) {
        throw new Error("pipelineWorker is not set");
      }
      this.observedTask = this.pipelineWorker;
      this.observedAppResources = this.pipelineWorker.appResources;
    }
    await this.pushFrame(frame, direction);
  }
}

describe("TestFrameProcessorSetupToolResourcesBackwardsCompat", () => {
  // Deprecated upstream API (`FrameProcessorSetup.tool_resources`) is not ported.
  test.skip("test_legacy_processor_receives_value_via_app_resources", () => {});

  // Deprecated upstream API (`PipelineWorker(tool_resources=...)` and
  // `FrameProcessorSetup.tool_resources`) is not ported.
  test.skip("test_legacy_processor_receives_value_via_deprecated_tool_resources_kwarg", () => {});
});

describe("TestFrameProcessorPipelineTaskAccess", () => {
  test("test_processor_can_reach_pipeline_task_and_app_resources", async () => {
    const resources = new _Resources({ userName: "John" });
    const recorder = new _RecordingProcessor();
    const pipeline = new Pipeline([recorder]);
    const worker = new PipelineWorker(pipeline, { appResources: resources });

    await worker.queueFrame(new EndFrame());
    await worker.run(new WorkerParams({ taskManager: new TaskManager() }));

    expect(recorder.observedTask).toBe(worker);
    expect(recorder.observedAppResources).toBe(resources);
  });

  test("test_pipeline_task_raises_when_not_set_up", () => {
    const recorder = new _RecordingProcessor();
    expect(() => recorder.pipelineWorker).toThrow(/is still not set up/);
  });
});
