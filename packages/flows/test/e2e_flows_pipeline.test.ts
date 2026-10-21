// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// End-to-end: flows driven through a real pipeline and a real LLM service, once
// per provider (OpenAI, Anthropic, Google). The provider APIs are replaced by
// the scripted tool-calling mock in examples/test-mocks, so the test needs no
// API key. A configured flow (YAML-style config joined to handlers) and a
// dynamic flow (nodes built in code) each run a three-step conversation:
// the model calls a tool at each of the first two nodes, the manager moves the
// pipeline from node to node, and the model's final reply comes back as text.

import { afterEach, describe, expect, test } from "bun:test";
import Anthropic from "@anthropic-ai/sdk";
import { AnthropicLLMService } from "@pipedog/anthropic/llm";
import { Event, waitFor } from "@pipedog/asyncio";
import { EndFrame, type Frame, LLMTextFrame, TTSSpeakFrame } from "@pipedog/core/frames/frames";
import { Pipeline } from "@pipedog/core/pipeline/pipeline";
import { PipelineWorker } from "@pipedog/core/pipeline/worker";
import { LLMContext } from "@pipedog/core/processors/aggregators/llm_context";
import { LLMContextAggregatorPair } from "@pipedog/core/processors/aggregators/llm_response_universal";
import { type FrameDirection, FrameProcessor } from "@pipedog/core/processors/frame_processor";
import type { LLMService } from "@pipedog/core/services/llm_service";
import { WorkerRunner } from "@pipedog/core/workers/runner";
import {
  Flow,
  FlowConfig,
  FlowManager,
  type FlowManager as FlowManagerType,
  type NodeConfig,
  TRANSITION_IN_YAML,
} from "@pipedog/flows";
import { GoogleLLMService } from "@pipedog/google/llm";
import { OpenAILLMService } from "@pipedog/openai/llm";
import {
  type MockToolLLM,
  startMockToolLLM,
  type ToolLLMProvider,
  type ToolLLMScript,
} from "../../../examples/test-mocks/src/mock_tool_llm.ts";

/** Records the text and speech the pipeline produces. */
class Collector extends FrameProcessor {
  texts: string[] = [];
  spoken: string[] = [];

  override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
    await super.processFrame(frame, direction);
    if (frame instanceof LLMTextFrame) this.texts.push(frame.text);
    if (frame instanceof TTSSpeakFrame) this.spoken.push(frame.text);
    await this.pushFrame(frame, direction);
  }
}

function makeLlm(provider: ToolLLMProvider, baseUrl: string): LLMService<any> {
  if (provider === "openai") return new OpenAILLMService({ apiKey: "test-key", baseUrl });
  if (provider === "anthropic") {
    const client = new Anthropic({ apiKey: "test-key", baseURL: baseUrl });
    return new AnthropicLLMService({ apiKey: "test-key", client: client as any });
  }
  return new GoogleLLMService({ apiKey: "test-key", httpOptions: { baseUrl } });
}

interface Run {
  mock: MockToolLLM;
  collector: Collector;
  flowManager: FlowManagerType;
}

const mocks: MockToolLLM[] = [];
afterEach(() => {
  for (const mock of mocks.splice(0)) mock.stop();
});

/**
 * Run a flow to its end: start the pipeline, enter the flow at `initialNode`,
 * wait until the model has made `requests` requests and spoken, then end it.
 */
async function runFlow(
  provider: ToolLLMProvider,
  script: ToolLLMScript,
  requests: number,
  flow: { initialNode: NodeConfig; globalFunctions?: any[] },
  state: Record<string, unknown> = {},
): Promise<Run> {
  const mock = startMockToolLLM(provider, script);
  mocks.push(mock);
  const llm = makeLlm(provider, mock.baseUrl);
  const collector = new Collector();
  const context = new LLMContext();
  const aggregators = new LLMContextAggregatorPair(context);
  const pipeline = new Pipeline([aggregators.user(), llm, collector, aggregators.assistant()]);
  const worker = new PipelineWorker(pipeline, { cancelOnIdleTimeout: false });

  const started = new Event();
  worker.eventHandler("on_pipeline_started", async () => started.set());

  const flowManager = new FlowManager({
    worker,
    llm,
    contextAggregator: aggregators,
    globalFunctions: flow.globalFunctions ?? null,
  });
  // What the prompts refer to as {{ key }}.
  Object.assign(flowManager.state, state);

  const runner = new WorkerRunner({ handleSigint: false, handleSigterm: false });
  await runner.addWorkers(worker);

  const drive = async (): Promise<void> => {
    await waitFor(() => started.wait(), 5);
    await flowManager.initialize(flow.initialNode);
    // The last request is the model's final answer; wait for its text.
    const deadline = Date.now() + 8000;
    while (
      (mock.requests.length < requests || collector.texts.length === 0) &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await worker.queueFrame(new EndFrame());
  };

  await Promise.all([runner.run(), drive()]);
  return { mock, collector, flowManager };
}

/** The tool names a request offered, ignoring order. */
function offered(mock: MockToolLLM, index: number): string[] {
  return [...(mock.requests[index]?.tools ?? [])].sort();
}

const SCRIPT: ToolLLMScript = [
  { toolCalls: [{ name: "choose_pizza", arguments: {} }] },
  {
    toolCalls: [{ name: "select_pizza_order", arguments: { size: "large", pizza_type: "cheese" } }],
  },
  { text: "Your large cheese pizza is confirmed." },
];

/** The text of every message in a request body, whatever the provider's format. */
function bodyText(body: Record<string, any>): string {
  return JSON.stringify(body);
}

const PROVIDERS: ToolLLMProvider[] = ["openai", "anthropic", "google"];

// --- A handlers module, as an application would write it ---

function withMeta<F extends (...args: any[]) => any>(
  fn: F,
  meta: { description?: string; parameters?: Record<string, unknown> },
): F {
  return Object.assign(fn, meta);
}

const handlers = {
  choose_pizza: withMeta(
    async function choose_pizza(flowManager: FlowManagerType) {
      void flowManager;
      return [null, TRANSITION_IN_YAML];
    },
    { description: "User wants to order pizza." },
  ),
  select_pizza_order: withMeta(
    async function select_pizza_order(
      flowManager: FlowManagerType,
      size: string,
      pizza_type: string,
    ) {
      flowManager.state.order = { size, pizza_type };
      return [{ size, type: pizza_type, status: "ok" }, TRANSITION_IN_YAML];
    },
    {
      description: "Record the pizza order details.",
      parameters: {
        size: { type: "string", description: "small, medium or large." },
        pizza_type: { type: "string", description: "The kind of pizza." },
      },
    },
  ),
  get_delivery_estimate: withMeta(
    async function get_delivery_estimate(flowManager: FlowManagerType) {
      void flowManager;
      return [{ time: "30 minutes" }, TRANSITION_IN_YAML];
    },
    { description: "Get a delivery estimate." },
  ),
  async announce(action: Record<string, unknown>, flowManager: FlowManagerType) {
    flowManager.state.announced = action.text;
  },
};

const CONFIG = {
  initial_node: "initial",
  nodes: {
    initial: {
      role_message: "You work for {{ restaurant }}.",
      task_messages: [{ role: "developer", content: "Greet the caller." }],
      pre_actions: [
        { type: "function", handler: "announce", text: "hello" },
        { type: "tts_say", text: "Welcome to {{ restaurant }}!" },
      ],
      functions: [{ name: "choose_pizza", transition_to: "pizza" }],
    },
    pizza: {
      task_messages: [{ role: "developer", content: "Take the pizza order." }],
      functions: [{ name: "select_pizza_order", transition_to: "confirm" }],
    },
    confirm: {
      task_messages: [{ role: "developer", content: "Confirm the order." }],
    },
  },
  global_functions: [{ name: "get_delivery_estimate" }],
};

describe.each(PROVIDERS)("flows end to end on %s", (provider) => {
  test("a configured flow moves through its nodes", async () => {
    const flow = new Flow(FlowConfig.modelValidate(CONFIG), { handlers });
    const { mock, collector, flowManager } = await runFlow(provider, SCRIPT, 3, flow, {
      restaurant: "Luigi's",
    });

    expect(mock.requests.length).toBe(3);
    expect(offered(mock, 0)).toEqual(["choose_pizza", "get_delivery_estimate"]);
    expect(offered(mock, 1)).toEqual(["get_delivery_estimate", "select_pizza_order"]);
    expect(offered(mock, 2)).toEqual(["get_delivery_estimate"]);

    expect(flowManager.currentNode).toBe("confirm");
    expect(flowManager.state.order).toEqual({ size: "large", pizza_type: "cheese" });
    expect(flowManager.state.announced).toBe("hello");
    expect(collector.spoken).toEqual(["Welcome to Luigi's!"]);
    expect(collector.texts.join("")).toContain("Your large cheese pizza is confirmed.");

    // Each request carries its node's task message; the pizza order reached the model.
    expect(bodyText(mock.requests[0]!.body)).toContain("Greet the caller.");
    expect(bodyText(mock.requests[1]!.body)).toContain("Take the pizza order.");
    expect(bodyText(mock.requests[2]!.body)).toContain("Confirm the order.");
    expect(bodyText(mock.requests[2]!.body)).toContain("cheese");
  });

  test("a dynamic flow builds each node from the previous result", async () => {
    const confirmNode = (order: { size: string; pizza_type: string }): NodeConfig => ({
      name: "confirm",
      taskMessages: [
        {
          role: "developer",
          content: `Confirm the ${order.size} ${order.pizza_type} pizza.`,
        },
      ],
    });

    const selectPizza = withMeta(
      async function select_pizza_order(
        flowManager: FlowManagerType,
        size: string,
        pizza_type: string,
      ) {
        flowManager.state.order = { size, pizza_type };
        return [{ size, type: pizza_type }, confirmNode({ size, pizza_type })];
      },
      {
        description: "Record the pizza order details.",
        parameters: { size: { type: "string" }, pizza_type: { type: "string" } },
      },
    );
    const choosePizza = withMeta(
      async function choose_pizza(flowManager: FlowManagerType) {
        void flowManager;
        const pizzaNode: NodeConfig = {
          name: "pizza",
          taskMessages: [{ role: "developer", content: "Take the pizza order." }],
          functions: [selectPizza as any],
        };
        return [null, pizzaNode];
      },
      { description: "User wants to order pizza." },
    );
    const initialNode: NodeConfig = {
      name: "initial",
      roleMessage: "You work for a pizzeria.",
      taskMessages: [{ role: "developer", content: "Greet the caller." }],
      functions: [choosePizza as any],
    };

    const { mock, collector, flowManager } = await runFlow(provider, SCRIPT, 3, {
      initialNode,
    });

    expect(mock.requests.length).toBe(3);
    expect(offered(mock, 0)).toEqual(["choose_pizza"]);
    expect(offered(mock, 1)).toEqual(["select_pizza_order"]);
    expect(offered(mock, 2)).toEqual([]);
    expect(flowManager.currentNode).toBe("confirm");
    expect(bodyText(mock.requests[2]!.body)).toContain("Confirm the large cheese pizza.");
    expect(collector.texts.join("")).toContain("confirmed");
  });
});
