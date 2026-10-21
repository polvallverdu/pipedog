// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_flows_manager.py

/**
 * Test suite for FlowManager functionality.
 *
 * This module contains tests for the FlowManager class, which handles
 * conversation flow management across different LLM providers. Tests cover:
 * - Flow initialization
 * - State transitions and validation
 * - Function registration and execution
 * - Action handling
 * - Error cases
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import {
  type Frame,
  LLMMessagesAppendFrame,
  LLMMessagesUpdateFrame,
  LLMRunFrame,
  LLMSetToolsFrame,
  LLMUpdateSettingsFrame,
} from "@pipedog/core/frames/frames";
import {
  FunctionCallParams,
  type FunctionCallParamsOptions,
} from "@pipedog/core/services/llm_service";
import { FlowError, FlowTransitionError } from "@pipedog/flows/exceptions";
import { FlowManager } from "@pipedog/flows/manager";
import {
  ContextStrategy,
  ContextStrategyConfig,
  type FlowArgs,
  FlowsFunctionSchema,
  flowsToolOptions,
  NO_RESPONSE,
  type NodeConfig,
  TRANSITION_IN_YAML,
} from "@pipedog/flows/types";
import { OpenAILLMService } from "@pipedog/openai/llm";
import {
  assertTtsSpeakFramesQueued,
  captureLogs,
  getAdvertisedToolHandlers,
  getAdvertisedTools,
  getQueuedFramesBatches,
  type MockWorker,
  makeMockWorker,
} from "./flows_test_helpers.ts";

/** Build FunctionCallParams the way the LLM service would, for a hand-driven call. */
function makeParams(
  options: Pick<FunctionCallParamsOptions, "functionName" | "toolCallId" | "resultCallback"> & {
    arguments?: Record<string, unknown>;
    worker: unknown;
  },
): FunctionCallParams {
  return new FunctionCallParams({
    functionName: options.functionName,
    toolCallId: options.toolCallId,
    arguments: options.arguments ?? {},
    llm: null as any,
    pipelineWorker: options.worker as any,
    context: null as any,
    resultCallback: options.resultCallback,
  });
}

describe("TestFlowManager", () => {
  let mockWorker: MockWorker;
  let mockLlm: OpenAILLMService;
  let mockAssistantAggregator: { hasFunctionCallsInProgress: boolean };
  let mockContextAggregator: any;
  let sampleNode: NodeConfig;

  const newManager = (extra: Record<string, unknown> = {}) =>
    new FlowManager({
      worker: mockWorker as any,
      llm: mockLlm,
      contextAggregator: mockContextAggregator,
      ...extra,
    });

  /** The frames of the first `queueFrames` call since the last reset. */
  const firstBatch = (): Frame[] => getQueuedFramesBatches(mockWorker)[0]!;

  beforeEach(() => {
    mockWorker = makeMockWorker();
    mockLlm = new OpenAILLMService({ apiKey: "test-key" });

    // Create mock assistant aggregator with public property only
    mockAssistantAggregator = { hasFunctionCallsInProgress: false };

    // Create mock context aggregator
    mockContextAggregator = {
      user: () => ({ context: { getMessages: () => [] } }),
      assistant: () => mockAssistantAggregator,
    };

    // Sample node configurations
    sampleNode = {
      roleMessage: "You are a helpful test assistant.",
      taskMessages: [{ role: "developer", content: "Complete the test task." }],
      functions: [
        new FlowsFunctionSchema({
          name: "test_function",
          description: "Test function",
          properties: {},
          required: [],
          handler: mock(async () => ({ status: "success" })),
        }),
      ],
    };
  });

  test("test_worker_and_task_arguments", () => {
    // worker is the canonical argument
    const flowManager = newManager();
    expect(flowManager.worker).toBe(mockWorker as any);

    // The deprecated `task` argument and property are not ported.

    // Passing no worker is an error
    expect(
      () => new FlowManager({ llm: mockLlm, contextAggregator: mockContextAggregator } as any),
    ).toThrow(Error);
  });

  test("test_flow_initialization", async () => {
    // Create mock transition callback
    const mockFunction = mock(async () => ({}));

    // Initialize flow manager
    const flowManager = newManager();

    // Create test node
    const testNode: NodeConfig = {
      name: "test",
      taskMessages: [{ role: "developer", content: "Test message" }],
      functions: [
        new FlowsFunctionSchema({
          name: "test_function",
          description: "Test function",
          properties: {},
          required: [],
          handler: mockFunction,
        }),
      ],
    };

    // Initialize and set node
    await flowManager.initialize();
    await flowManager.setNodeFromConfig(testNode);

    expect(mockFunction).not.toHaveBeenCalled(); // Shouldn't be called until function is used
    expect(flowManager._currentNode).toBe("test");
  });

  test("test_node_validation", async () => {
    const flowManager = newManager();
    await flowManager.initialize();

    // Test missing taskMessages
    const invalidConfig = { functions: [] } as unknown as NodeConfig;
    await expect(flowManager.setNodeFromConfig(invalidConfig)).rejects.toThrow(FlowError);
    await expect(flowManager.setNodeFromConfig(invalidConfig)).rejects.toThrow(
      "missing required 'taskMessages' field",
    );

    // Test valid config
    await flowManager.setNodeFromConfig({ name: "test", taskMessages: [] });

    expect(flowManager._currentNode).toBe("test");
    expect(flowManager._currentFunctions).toEqual(new Set());
  });

  test("test_function_registration", async () => {
    const flowManager = newManager();
    await flowManager.initialize();

    // Reset mock to clear initialization calls
    mockWorker.queueFrames.mockClear();

    // Set node with function
    await flowManager.setNodeFromConfig(sampleNode);

    // The tool is advertised carrying its handler, which the LLM service
    // registers when it sees the advertised tools.
    const handlers = getAdvertisedToolHandlers(mockWorker);
    expect(Object.keys(handlers)).toEqual(["test_function"]);
    expect(typeof handlers.test_function).toBe("function");
  });

  test("test_action_execution", async () => {
    const flowManager = newManager();
    await flowManager.initialize();

    // Create node config with actions
    const nodeWithActions: NodeConfig = {
      roleMessage: sampleNode.roleMessage!,
      taskMessages: sampleNode.taskMessages,
      functions: sampleNode.functions!,
      preActions: [{ type: "tts_say", text: "Pre action" }],
      postActions: [{ type: "tts_say", text: "Post action" }],
    };

    // Reset mock to clear initialization calls
    mockWorker.queueFrame.mockClear();

    // Set node with actions
    await flowManager.setNodeFromConfig(nodeWithActions);

    assertTtsSpeakFramesQueued(mockWorker, ["Pre action", "Post action"]);
  });

  test("test_error_handling", async () => {
    const flowManager = newManager();

    // Test setting node before initialization
    await expect(flowManager.setNodeFromConfig(sampleNode)).rejects.toThrow(FlowTransitionError);

    // Initialize normally
    await flowManager.initialize();
    expect(flowManager._initialized).toBe(true);

    // Test node setting error
    mockWorker.queueFrames.mockImplementation(async () => {
      throw new Error("Queue error");
    });
    await expect(flowManager.setNodeFromConfig(sampleNode)).rejects.toThrow(FlowError);

    // Verify flow manager remains initialized despite error
    expect(flowManager._initialized).toBe(true);
  });

  test("test_state_management", async () => {
    const flowManager = newManager();
    await flowManager.initialize();

    // Set state data
    const testValue = "test_value";
    flowManager.state.test_key = testValue;

    // Reset mock to clear initialization calls
    mockWorker.queueFrames.mockClear();

    // Verify state persists across node transitions
    await flowManager.setNodeFromConfig(sampleNode);
    expect(flowManager.state.test_key).toBe(testValue);
  });

  test("test_multiple_function_registration", async () => {
    const flowManager = newManager();
    await flowManager.initialize();

    // Create node config with multiple functions
    const nodeConfig: NodeConfig = {
      taskMessages: [{ role: "developer", content: "Test" }],
      functions: [0, 1, 2].map(
        (i) =>
          new FlowsFunctionSchema({
            name: `func_${i}`,
            description: `Function ${i}`,
            properties: {},
            required: [],
            handler: mock(async () => ({ status: "success" })),
          }),
      ),
    };

    await flowManager.setNodeFromConfig(nodeConfig);

    // Verify all functions were advertised (each carrying a handler) and tracked
    const handlers = getAdvertisedToolHandlers(mockWorker);
    expect(new Set(Object.keys(handlers))).toEqual(new Set(["func_0", "func_1", "func_2"]));
    expect(flowManager._currentFunctions.size).toBe(3);
  });

  test("test_advertised_handlers_register_with_node_call_options", async () => {
    // Advertised handlers register with each tool's resolved call options.
    //
    // The wrapped handler carries the tool's call options (via toolOptions), so
    // the LLM service resolves cancelOnInterruption to Flows' default of false
    // — not the service's own default of true — and honors explicit overrides
    // on both FlowsFunctionSchemas and direct functions.
    const flowManager = newManager();
    await flowManager.initialize();

    const handler = async (_args: FlowArgs, _flowManager: FlowManager) =>
      [{ ok: true }, null] as const;

    const directTool = flowsToolOptions({ cancelOnInterruption: true, timeoutSecs: 7 })(
      Object.assign(
        async function direct_tool(flowManager: FlowManager, city: string) {
          void [flowManager, city];
          return [{ ok: true }, null] as const;
        },
        {
          description: "Do a thing.",
          parameters: { city: { type: "string", description: "A city." } },
        },
      ),
    );

    await flowManager.setNodeFromConfig({
      taskMessages: [{ role: "developer", content: "Test" }],
      functions: [
        new FlowsFunctionSchema({
          name: "defaults",
          description: "Uses default call options",
          properties: {},
          required: [],
          handler,
        }),
        new FlowsFunctionSchema({
          name: "overrides",
          description: "Overrides call options",
          properties: {},
          required: [],
          handler,
          cancelOnInterruption: true,
          timeoutSecs: 12.5,
        }),
        directTool,
      ],
    });

    // Register the advertised tools the way the LLM service does on inference.
    (mockLlm as any)._syncRegisteredToolHandlers(getAdvertisedTools(mockWorker));
    const functions = (mockLlm as any)._functions as Map<string, any>;

    // FlowsFunctionSchema default: Flows' false default survives (not the service's true).
    const defaults = functions.get("defaults");
    expect(defaults.cancelOnInterruption).toBe(false);
    expect(defaults.timeoutSecs).toBeNull();

    // FlowsFunctionSchema explicit overrides are honored.
    const overrides = functions.get("overrides");
    expect(overrides.cancelOnInterruption).toBe(true);
    expect(overrides.timeoutSecs).toBe(12.5);

    // A direct function's flowsToolOptions values are honored.
    const direct = functions.get("direct_tool");
    expect(direct.cancelOnInterruption).toBe(true);
    expect(direct.timeoutSecs).toBe(7);
  });

  test("test_redeclared_function_rebinds_new_handler", async () => {
    // Regression: redeclaring a function in a new node must bind the new handler.
    //
    // Two adjacent nodes declare `go` with different handlers returning
    // different next nodes. The handler advertised for `go` must reflect the
    // latest node's handler, not the first one's.
    const flowManager = newManager();
    await flowManager.initialize();

    const handlerACalls: FlowArgs[] = [];
    const handlerBCalls: FlowArgs[] = [];

    const handlerA = async (args: FlowArgs) => {
      handlerACalls.push(args);
      return [
        { from: "A" },
        { taskMessages: [{ role: "developer", content: "menu" }], functions: [] },
      ] as const;
    };

    const handlerB = async (args: FlowArgs) => {
      handlerBCalls.push(args);
      return [
        { from: "B" },
        { taskMessages: [{ role: "developer", content: "home" }], functions: [] },
      ] as const;
    };

    await flowManager.setNodeFromConfig({
      taskMessages: [{ role: "developer", content: "A" }],
      functions: [
        new FlowsFunctionSchema({
          name: "go",
          description: "A's go",
          properties: {},
          required: [],
          handler: handlerA,
        }),
      ],
    });
    await flowManager.setNodeFromConfig({
      taskMessages: [{ role: "developer", content: "B" }],
      functions: [
        new FlowsFunctionSchema({
          name: "go",
          description: "B's go",
          properties: {},
          required: [],
          handler: handlerB,
        }),
      ],
    });

    // After node B, the advertised `go` handler must be node B's, not node A's.
    const latestGo = getAdvertisedToolHandlers(mockWorker).go!;

    await latestGo(
      makeParams({
        functionName: "go",
        toolCallId: "t1",
        worker: mockWorker,
        resultCallback: async () => {},
      }),
    );

    expect(handlerBCalls.length).toBe(1);
    expect(handlerACalls.length).toBe(0);
  });

  test("test_initialize_already_initialized", async () => {
    const flowManager = newManager();
    await flowManager.initialize();

    // Try to initialize again
    const warnings = await captureLogs(() => flowManager.initialize());
    expect(warnings.length).toBe(1);
  });

  test("test_register_action", () => {
    const flowManager = newManager();

    const customAction = async (_action: unknown) => {};

    flowManager.registerAction("custom", customAction);
    expect(flowManager._actionManager._actionHandlers.has("custom")).toBe(true);
  });

  test("test_call_handler_variations", async () => {
    // DIVERGENCE: upstream inspects each handler's signature (and warns for the
    // deprecated forms). Here every handler is called as (args, flowManager);
    // one that declares fewer parameters ignores the rest.
    const flowManager = newManager();
    await flowManager.initialize();

    // Test handler with args
    const handlerWithArgs = async (args: FlowArgs) => ({ status: "success", args });
    let result: any = await flowManager._callHandler(handlerWithArgs, { test: "value" });
    expect(result.args.test).toBe("value");

    // Test handler without args
    const handlerNoArgs = async () => ({ status: "success" });
    result = await flowManager._callHandler(handlerNoArgs, {});
    expect(result.status).toBe("success");

    // Test handler with FlowManager parameter (2+ parameters)
    const handlerWithFlowManager = async (args: FlowArgs, flowManagerParam: FlowManager) => ({
      status: "success",
      has_flow_manager: true,
      flow_manager: flowManagerParam, // Return for verification
      args,
    });
    result = await flowManager._callHandler(handlerWithFlowManager, { test: "value" });
    expect(result.status).toBe("success");
    expect(result.has_flow_manager).toBe(true);
    expect(result.flow_manager).toBe(flowManager); // Verify it's the same instance
    expect(result.flow_manager).toBeInstanceOf(FlowManager);
    expect(result.args.test).toBe("value");

    // Test instance method handler
    class TestHandlerClass {
      instanceData = "test_instance";

      async instanceMethodHandler(args: FlowArgs) {
        return { status: "success", instance_data: this.instanceData, args };
      }

      async instanceMethodWithFlowManager(args: FlowArgs, flowManagerParam: FlowManager) {
        return {
          status: "success",
          has_flow_manager: true,
          flow_manager: flowManagerParam, // Return for verification
          instance_data: this.instanceData,
          args,
        };
      }

      static async classMethodHandler(args: FlowArgs) {
        return { status: "success", class_data: "test_class", args };
      }

      static async classMethodWithFlowManager(args: FlowArgs, flowManagerParam: FlowManager) {
        return {
          status: "success",
          has_flow_manager: true,
          flow_manager: flowManagerParam, // Return for verification
          class_data: "test_class",
          args,
        };
      }
    }

    const testInstance = new TestHandlerClass();

    // Test instance method (1 parameter)
    result = await flowManager._callHandler(testInstance.instanceMethodHandler.bind(testInstance), {
      test: "value",
    });
    expect(result.status).toBe("success");
    expect(result.instance_data).toBe("test_instance");
    expect(result.args.test).toBe("value");

    // Test instance method with FlowManager (2+ parameters)
    result = await flowManager._callHandler(
      testInstance.instanceMethodWithFlowManager.bind(testInstance),
      { test: "value" },
    );
    expect(result.status).toBe("success");
    expect(result.has_flow_manager).toBe(true);
    expect(result.flow_manager).toBe(flowManager); // Verify it's the same instance
    expect(result.instance_data).toBe("test_instance");
    expect(result.args.test).toBe("value");

    // Test static method (1 parameter)
    result = await flowManager._callHandler(TestHandlerClass.classMethodHandler, {
      test: "value",
    });
    expect(result.status).toBe("success");
    expect(result.class_data).toBe("test_class");
    expect(result.args.test).toBe("value");

    // Test static method with FlowManager (2+ parameters)
    result = await flowManager._callHandler(TestHandlerClass.classMethodWithFlowManager, {
      test: "value",
    });
    expect(result.status).toBe("success");
    expect(result.has_flow_manager).toBe(true);
    expect(result.flow_manager).toBe(flowManager); // Verify it's the same instance
    expect(result.class_data).toBe("test_class");
    expect(result.args.test).toBe("value");
  });

  test("test_transition_func_error_handling", async () => {
    const flowManager = newManager();
    await flowManager.initialize();

    const errorHandler = async (_args: FlowArgs) => {
      throw new Error("Test error");
    };

    const transitionFunc = await flowManager._createTransitionFunc("test", errorHandler);

    // Mock result callback
    let callbackCalled = false;

    const resultCallback = async (result: any) => {
      callbackCalled = true;
      expect(result).toHaveProperty("error");
      expect(result.status).toBe("error");
      expect(result.error).toContain("Test error");
    };

    // The transition function should catch the error and pass it to the callback
    await transitionFunc(
      makeParams({ functionName: "test", toolCallId: "id", worker: mockWorker, resultCallback }),
    );
    expect(callbackCalled).toBe(true);
  });

  test("test_transition_in_yaml_rejected_outside_a_configured_flow", async () => {
    // A node built in code has nothing to decide a deferred transition.
    const flowManager = newManager();
    await flowManager.initialize();

    const defers = async (_args: FlowArgs, _fm: FlowManager) =>
      [{ ok: true }, TRANSITION_IN_YAML] as const;

    const transitionFunc = await flowManager._createTransitionFunc("defers", defers);
    const results: any[] = [];

    await transitionFunc(
      makeParams({
        functionName: "defers",
        toolCallId: "id",
        worker: mockWorker,
        resultCallback: async (result) => {
          results.push(result);
        },
      }),
    );
    expect(results[0].status).toBe("error");
    expect(results[0].error).toContain("TRANSITION_IN_YAML");
    expect(results[0].error).toContain("not built from a flow config");
  });

  test("test_node_validation_edge_cases", async () => {
    const flowManager = newManager();
    await flowManager.initialize();

    // Test invalid function format (plain object instead of FlowsFunctionSchema)
    const invalidConfig = {
      taskMessages: [{ role: "developer", content: "Test" }],
      functions: [{ type: "function" }],
    } as unknown as NodeConfig;
    await expect(flowManager.setNodeFromConfig(invalidConfig)).rejects.toThrow(
      "Invalid function format",
    );

    // A FlowsFunctionSchema requires a handler: omitting it is a construction-time error.
    expect(
      () =>
        new FlowsFunctionSchema({
          name: "test_func",
          description: "Test",
          properties: {},
          required: [],
        } as any),
    ).toThrow(TypeError);
  });

  test("test_action_execution_error_handling", async () => {
    const flowManager = newManager();
    await flowManager.initialize();

    // Create node config with actions that will fail
    const nodeConfig: NodeConfig = {
      taskMessages: [{ role: "developer", content: "Test" }],
      functions: [],
      preActions: [{ type: "invalid_action" }],
      postActions: [{ type: "another_invalid_action" }],
    };

    // Should raise FlowError due to invalid actions
    await expect(flowManager.setNodeFromConfig(nodeConfig)).rejects.toThrow(FlowError);

    // Verify error handling for pre and post actions separately
    await expect(
      flowManager._executeActions({ preActions: [{ type: "invalid_action" }] }),
    ).rejects.toThrow(FlowError);

    await expect(
      flowManager._executeActions({ postActions: [{ type: "invalid_action" }] }),
    ).rejects.toThrow(FlowError);
  });

  test("test_update_llm_context_error_handling", async () => {
    const flowManager = newManager();
    await flowManager.initialize();

    // Mock worker to raise error on queueFrames
    mockWorker.queueFrames.mockImplementation(async () => {
      throw new Error("Queue error");
    });

    await expect(
      flowManager._updateLlmContext({
        roleMessage: null,
        taskMessages: [{ role: "developer", content: "Test" }],
        functions: [],
      }),
    ).rejects.toThrow(FlowError);
  });

  test("test_function_declarations_processing", async () => {
    const flowManager = newManager();
    await flowManager.initialize();

    const testHandler = async (_args: FlowArgs) => ({ status: "success" });

    // Create node config with multiple FlowsFunctionSchema functions
    const nodeConfig: NodeConfig = {
      taskMessages: [{ role: "developer", content: "Test" }],
      functions: [
        new FlowsFunctionSchema({
          name: "test1",
          description: "Test function 1",
          properties: {},
          required: [],
          handler: testHandler,
        }),
        new FlowsFunctionSchema({
          name: "test2",
          description: "Test function 2",
          properties: {},
          required: [],
          handler: testHandler,
        }),
      ],
    };

    // Set node and verify function registration
    await flowManager.setNodeFromConfig(nodeConfig);

    // Verify both functions were registered
    expect(flowManager._currentFunctions.has("test1")).toBe(true);
    expect(flowManager._currentFunctions.has("test2")).toBe(true);
  });

  test("test_role_message_inheritance", async () => {
    // Test that roleMessage is sent as LLMUpdateSettingsFrame.
    const flowManager = newManager();
    await flowManager.initialize();

    // First node with roleMessage
    const firstNode: NodeConfig = {
      roleMessage: "You are a helpful assistant.",
      taskMessages: [{ role: "developer", content: "First task." }],
      functions: [],
    };

    // Second node without role messages
    const secondNode: NodeConfig = {
      taskMessages: [{ role: "developer", content: "Second task." }],
      functions: [],
    };

    // Set first node
    await flowManager.setNodeFromConfig(firstNode);
    const firstFrames = firstBatch();

    // Verify LLMUpdateSettingsFrame with systemInstruction
    let settingsFrames = firstFrames.filter(
      (f): f is LLMUpdateSettingsFrame => f instanceof LLMUpdateSettingsFrame,
    );
    expect(settingsFrames.length).toBe(1);
    expect(settingsFrames[0]!.delta!.systemInstruction).toBe("You are a helpful assistant.");

    // Verify AppendFrame contains only taskMessages
    let appendFrames = firstFrames.filter(
      (f): f is LLMMessagesAppendFrame => f instanceof LLMMessagesAppendFrame,
    );
    expect(appendFrames.length).toBe(1);
    expect(appendFrames[0]!.messages).toEqual(firstNode.taskMessages);

    // Verify frame ordering: LLMUpdateSettingsFrame before LLMMessagesAppendFrame
    expect(firstFrames.indexOf(settingsFrames[0]!)).toBeLessThan(
      firstFrames.indexOf(appendFrames[0]!),
    );

    // Reset mock and set second node
    mockWorker.queueFrames.mockClear();
    await flowManager.setNodeFromConfig(secondNode);

    // Verify no LLMUpdateSettingsFrame for second node
    const secondFrames = firstBatch();
    settingsFrames = secondFrames.filter(
      (f): f is LLMUpdateSettingsFrame => f instanceof LLMUpdateSettingsFrame,
    );
    expect(settingsFrames.length).toBe(0);

    // Verify AppendFrame with only task messages
    appendFrames = secondFrames.filter(
      (f): f is LLMMessagesAppendFrame => f instanceof LLMMessagesAppendFrame,
    );
    expect(appendFrames.length).toBe(1);
    expect(appendFrames[0]!.messages).toEqual(secondNode.taskMessages);
  });

  test("test_frame_type_selection", async () => {
    // Under the default (APPEND) strategy, the context update appends for
    // every node.
    const flowManager = newManager();
    await flowManager.initialize();

    const testNode: NodeConfig = {
      taskMessages: [{ role: "developer", content: "Test task." }],
      functions: [],
    };

    // Under the default strategy the first node appends.
    await flowManager.setNodeFromConfig(testNode);
    let frames = firstBatch();
    expect(frames.some((f) => f instanceof LLMMessagesAppendFrame)).toBe(true);
    expect(frames.some((f) => f instanceof LLMMessagesUpdateFrame)).toBe(false);

    // Reset mock
    mockWorker.queueFrames.mockClear();

    // Subsequent node should also use AppendFrame
    await flowManager.setNodeFromConfig(testNode);
    frames = firstBatch();
    expect(frames.some((f) => f instanceof LLMMessagesAppendFrame)).toBe(true);
    expect(frames.some((f) => f instanceof LLMMessagesUpdateFrame)).toBe(false);
  });

  test("test_edge_vs_node_function_behavior", async () => {
    const flowManager = newManager();
    await flowManager.initialize();

    // Create test functions
    const testHandler = async (_args: FlowArgs) => ({ status: "success" });

    const consolidatedTestHandler = async (_args: FlowArgs) => {
      const nextNode: NodeConfig = {
        taskMessages: [{ role: "developer", content: "Next" }],
        functions: [],
      };
      return [{ status: "success" }, nextNode] as const;
    };

    // Create node with both types of functions
    const nodeConfig: NodeConfig = {
      name: "test",
      taskMessages: [{ role: "developer", content: "Test" }],
      functions: [
        new FlowsFunctionSchema({
          name: "node_function",
          description: "Node function",
          properties: {},
          required: [],
          handler: testHandler,
        }),
        new FlowsFunctionSchema({
          name: "edge_function_1",
          description: "Edge function",
          properties: {},
          required: [],
          handler: consolidatedTestHandler,
        }),
        new FlowsFunctionSchema({
          name: "edge_function_2",
          description: "Edge function",
          properties: {},
          required: [],
          handler: consolidatedTestHandler,
        }),
      ],
    };

    await flowManager.setNodeFromConfig(nodeConfig);

    // Get the advertised handlers (which the LLM service auto-registers)
    const handlers = getAdvertisedToolHandlers(mockWorker);

    const call = async (name: string) => {
      mockWorker.queueFrames.mockClear();
      let properties: any = null;
      await handlers[name]!(
        makeParams({
          functionName: name,
          toolCallId: name,
          worker: mockWorker,
          resultCallback: async (_result, options) => {
            properties = options?.properties ?? null;
          },
        }),
      );
      return properties;
    };

    // Node function should not set runLlm=false
    const nodeProperties = await call("node_function");
    expect(nodeProperties === null || nodeProperties.runLlm !== false).toBe(true);

    // Edge functions should set runLlm=false
    const edgeProperties1 = await call("edge_function_1");
    expect(edgeProperties1 !== null && edgeProperties1.runLlm === false).toBe(true);

    const edgeProperties2 = await call("edge_function_2");
    expect(edgeProperties2 !== null && edgeProperties2.runLlm === false).toBe(true);
  });

  test("test_no_response_function_behavior", async () => {
    // A function returning NO_RESPONSE finishes without responding or transitioning.
    const flowManager = newManager();
    await flowManager.initialize();

    const handoffHandler = async (_args: FlowArgs) =>
      [{ status: "transferred" }, NO_RESPONSE] as const;

    await flowManager.setNodeFromConfig({
      name: "test",
      taskMessages: [{ role: "developer", content: "Test" }],
      functions: [
        new FlowsFunctionSchema({
          name: "handoff_function",
          description: "Hands off without responding",
          properties: {},
          required: [],
          handler: handoffHandler,
        }),
      ],
    });
    const handoffFunc = getAdvertisedToolHandlers(mockWorker).handoff_function!;

    // Nothing should be queued (no context update, no completion) after the
    // node is set up.
    mockWorker.queueFrames.mockClear();
    let result: unknown = null;
    let properties: any = null;

    await handoffFunc(
      makeParams({
        functionName: "handoff_function",
        toolCallId: "id1",
        worker: mockWorker,
        resultCallback: async (res, options) => {
          result = res;
          properties = options?.properties ?? null;
        },
      }),
    );

    // The result is delivered, but with no completion and no transition.
    expect(result).toEqual({ status: "transferred" });
    expect(properties).not.toBeNull();
    expect(properties.runLlm).toBe(false);
    expect(properties.onContextUpdated).toBeNull();
    // Unlike an edge function, NO_RESPONSE schedules no transition and
    // writes nothing to the (possibly shared) context.
    expect(flowManager._pendingTransition).toBeNull();
    expect(mockWorker.queueFrames).not.toHaveBeenCalled();
  });

  test("test_completion_timing", async () => {
    // Test that completions occur at the right time.
    const flowManager = newManager();
    await flowManager.initialize();

    const runFrames = () =>
      getQueuedFramesBatches(mockWorker)
        .flat()
        .filter((f) => f instanceof LLMRunFrame);

    // Test initial node setup
    mockWorker.queueFrames.mockClear();

    await flowManager.setNodeFromConfig({
      taskMessages: [{ role: "developer", content: "Test" }],
      functions: [],
    });

    // Should see context update and completion trigger
    expect(mockWorker.queueFrames).toHaveBeenCalled();

    // Verify that LLM completion was triggered once
    expect(runFrames().length).toBe(1);

    // Test node transition by directly setting next node
    mockWorker.queueFrames.mockClear();

    await flowManager.setNodeFromConfig({
      taskMessages: [{ role: "developer", content: "Next test" }],
      functions: [],
    });

    // Should see context update and completion trigger again
    expect(mockWorker.queueFrames).toHaveBeenCalled();
    expect(runFrames().length).toBe(1);
  });

  test("test_get_current_context", async () => {
    const flowManager = newManager();
    await flowManager.initialize();

    // Mock the context messages
    const mockMessages = [{ role: "developer", content: "Test message" }];
    mockContextAggregator.user = () => ({ context: { getMessages: () => mockMessages } });

    // Test getting context
    expect(flowManager.getCurrentContext()).toEqual(mockMessages);

    // Test error when context aggregator is not available
    flowManager._contextAggregator = null;
    expect(() => flowManager.getCurrentContext()).toThrow(FlowError);
    expect(() => flowManager.getCurrentContext()).toThrow("No context aggregator available");
  });

  test("test_handler_with_flow_manager", async () => {
    // Test function handler that receives both args and flowManager.
    const flowManager = newManager();
    await flowManager.initialize();

    let handlerCalled = false;
    let correctFlowManager = false;

    const modernHandler = async (args: FlowArgs, flowMgr: FlowManager) => {
      handlerCalled = true;
      correctFlowManager = flowMgr === flowManager;
      return { status: "success", args_received: args, has_flow_manager: true };
    };

    const result: any = await flowManager._callHandler(modernHandler, { test: "value" });

    expect(handlerCalled).toBe(true);
    expect(correctFlowManager).toBe(true);
    expect(result.args_received.test).toBe("value");
    expect(result.has_flow_manager).toBe(true);
  });

  test("test_node_without_functions", async () => {
    const flowManager = newManager();
    await flowManager.initialize();

    // Set node and verify it works without a functions field
    await flowManager.setNodeFromConfig({
      taskMessages: [{ role: "developer", content: "Test task without functions." }],
    });

    // Verify current functions is empty set
    expect(flowManager._currentFunctions).toEqual(new Set());

    // Verify LLM tools were still set (with empty or placeholder functions)
    const toolsBatches = getQueuedFramesBatches(mockWorker).filter((batch) =>
      batch.some((f) => f instanceof LLMSetToolsFrame),
    );
    expect(toolsBatches.length).toBeGreaterThan(0);
  });

  test("test_node_with_empty_functions", async () => {
    const flowManager = newManager();
    await flowManager.initialize();

    // Set node and verify it works with an empty functions list
    await flowManager.setNodeFromConfig({
      taskMessages: [{ role: "developer", content: "Test task with empty functions." }],
      functions: [],
    });

    // Verify current functions is empty set
    expect(flowManager._currentFunctions).toEqual(new Set());

    // Verify LLM tools were still set (with empty or placeholder functions)
    const toolsBatches = getQueuedFramesBatches(mockWorker).filter((batch) =>
      batch.some((f) => f instanceof LLMSetToolsFrame),
    );
    expect(toolsBatches.length).toBeGreaterThan(0);
  });

  test("test_role_message_singular", async () => {
    // Test that a plain string roleMessage works correctly.
    const flowManager = newManager();
    await flowManager.initialize();

    const node: NodeConfig = {
      roleMessage: "You are a helpful assistant.",
      taskMessages: [{ role: "developer", content: "Do the task." }],
      functions: [],
    };

    await flowManager.setNodeFromConfig(node);
    const firstFrames = firstBatch();

    // Verify LLMUpdateSettingsFrame with correct systemInstruction
    const settingsFrames = firstFrames.filter(
      (f): f is LLMUpdateSettingsFrame => f instanceof LLMUpdateSettingsFrame,
    );
    expect(settingsFrames.length).toBe(1);
    expect(settingsFrames[0]!.delta!.systemInstruction).toBe("You are a helpful assistant.");

    // Verify messages frame contains only taskMessages
    const appendFrames = firstFrames.filter(
      (f): f is LLMMessagesAppendFrame => f instanceof LLMMessagesAppendFrame,
    );
    expect(appendFrames.length).toBe(1);
    expect(appendFrames[0]!.messages).toEqual(node.taskMessages);
  });

  test("test_role_messages_persist_across_reset", async () => {
    // Test that system instruction persists when a RESET node omits roleMessage.
    const flowManager = newManager({
      contextStrategy: new ContextStrategyConfig({ strategy: ContextStrategy.RESET }),
    });
    await flowManager.initialize();

    // First node sets roleMessage
    await flowManager.setNodeFromConfig({
      roleMessage: "You are a helpful assistant.",
      taskMessages: [{ role: "developer", content: "First task." }],
      functions: [],
    });
    const firstFrames = firstBatch();

    // Verify first node sends LLMUpdateSettingsFrame
    let settingsFrames = firstFrames.filter(
      (f): f is LLMUpdateSettingsFrame => f instanceof LLMUpdateSettingsFrame,
    );
    expect(settingsFrames.length).toBe(1);
    expect(settingsFrames[0]!.delta!.systemInstruction).toBe("You are a helpful assistant.");

    // Second node with RESET strategy but no roleMessage
    mockWorker.queueFrames.mockClear();
    const secondNode: NodeConfig = {
      taskMessages: [{ role: "developer", content: "Second task." }],
      functions: [],
    };

    await flowManager.setNodeFromConfig(secondNode);
    const secondFrames = firstBatch();

    // No LLMUpdateSettingsFrame since no roleMessage — system instruction
    // persists in LLM settings from the first node
    settingsFrames = secondFrames.filter(
      (f): f is LLMUpdateSettingsFrame => f instanceof LLMUpdateSettingsFrame,
    );
    expect(settingsFrames.length).toBe(0);

    // Verify RESET still uses UpdateFrame for context messages
    const updateFrames = secondFrames.filter(
      (f): f is LLMMessagesUpdateFrame => f instanceof LLMMessagesUpdateFrame,
    );
    expect(updateFrames.length).toBe(1);
    expect(updateFrames[0]!.messages).toEqual(secondNode.taskMessages);
  });

  // `role_messages` (plural) is deprecated upstream (since 1.5.0) and not ported.
  test.skip("test_role_messages_deprecated_warning", () => {});
  test.skip("test_role_message_and_role_messages_both_specified", () => {});
  test.skip("test_role_messages_list_format_still_works", () => {});
});
