// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Runtime smoke test for tools/compat: loads a flow from YAML, joins it to
// handlers, enters it with a FlowManager and follows one tool call to the next
// node. The pipeline worker is a stand-in that records the frames queued on it,
// so no network is needed.

import { type Frame, LLMSetToolsFrame } from "@pipedog/core/frames/frames";
import { FunctionCallParams } from "@pipedog/core/services/llm_service";
import { Flow, FlowConfig, FlowManager, TRANSITION_IN_YAML } from "@pipedog/flows";
import { OpenAILLMService } from "@pipedog/openai/llm";

const YAML = `
initial_node: greet
nodes:
  greet:
    role_message: You work for {{ shop }}.
    task_messages:
      - role: developer
        content: Greet the caller.
    functions:
      - name: start_order
        transition_to: order
  order:
    task_messages:
      - role: developer
        content: Take the order.
`;

async function start_order(flowManager: unknown) {
  void flowManager;
  return [null, TRANSITION_IN_YAML];
}
Object.assign(start_order, { description: "The caller wants to order." });

export default async function smoke(): Promise<void> {
  const config = FlowConfig.fromYaml(YAML);
  const flow = new Flow(config, { handlers: { start_order } });

  const queued: Frame[] = [];
  const worker = {
    queueFrame: async (frame: Frame) => {
      queued.push(frame);
    },
    queueFrames: async (frames: Iterable<Frame>) => {
      queued.push(...frames);
    },
    setReachedDownstreamFilter: () => {},
    eventHandler: () => {},
  };
  const llm = new OpenAILLMService({ apiKey: "smoke-key" });
  const flowManager = new FlowManager({
    worker: worker as never,
    llm,
    contextAggregator: {
      user: () => ({ context: { getMessages: () => [] } }),
      assistant: () => ({ hasFunctionCallsInProgress: false }),
    } as never,
  });
  flowManager.state.shop = "Luigi's";
  await flowManager.initialize(flow.initialNode);
  if (flowManager.currentNode !== "greet") {
    throw new Error(`flows smoke: started at ${flowManager.currentNode}`);
  }

  const advertised = (): Record<string, unknown> => {
    const frames = queued.filter((f): f is LLMSetToolsFrame => f instanceof LLMSetToolsFrame);
    const tools = frames[frames.length - 1]?.tools as { standardTools: any[] } | undefined;
    return Object.fromEntries((tools?.standardTools ?? []).map((t) => [t.name, t.handler]));
  };
  const handler = advertised().start_order as
    | ((p: FunctionCallParams) => Promise<void>)
    | undefined;
  if (!handler) throw new Error("flows smoke: start_order was not advertised");

  await handler(
    new FunctionCallParams({
      functionName: "start_order",
      toolCallId: "call-1",
      arguments: {},
      llm,
      pipelineWorker: worker as never,
      context: null as never,
      resultCallback: async (_result, options) => {
        await options?.properties?.onContextUpdated?.();
      },
    }),
  );
  if (flowManager.currentNode !== "order") {
    throw new Error(`flows smoke: ended at ${flowManager.currentNode}`);
  }
}
