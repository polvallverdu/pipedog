// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Samples for content/docs/flows/*.mdx. Type-checked on every docs build.

import { readFileSync } from "node:fs";
import { Pipeline } from "@pipedog/core/pipeline/pipeline";
import { PipelineWorker } from "@pipedog/core/pipeline/worker";
import { LLMContext } from "@pipedog/core/processors/aggregators/llm_context";
import { LLMContextAggregatorPair } from "@pipedog/core/processors/aggregators/llm_response_universal";
import {
  ContextStrategy,
  ContextStrategyConfig,
  Flow,
  FlowConfig,
  FlowManager,
  FlowsFunctionSchema,
  flowsToolOptions,
  NO_RESPONSE,
  type NodeConfig,
  TRANSITION_IN_YAML,
} from "@pipedog/flows";
import { OpenAILLMService } from "@pipedog/openai/llm";

const llm = new OpenAILLMService({ apiKey: process.env.OPENAI_API_KEY ?? null });
const aggregators = new LLMContextAggregatorPair(new LLMContext());
const worker = new PipelineWorker(new Pipeline([aggregators.user(), llm, aggregators.assistant()]));

// #region manager
const flowManager = new FlowManager({
  worker,
  llm,
  contextAggregator: aggregators,
});
// #endregion manager

// #region node
function createGreetingNode(): NodeConfig {
  return {
    name: "greeting",
    roleMessage: "You are a friendly receptionist at a dental clinic. Speak briefly.",
    taskMessages: [{ role: "developer", content: "Greet the caller and ask for their name." }],
    functions: [
      new FlowsFunctionSchema({
        name: "record_name",
        description: "Record the caller's name.",
        properties: { name: { type: "string", description: "The caller's name." } },
        required: ["name"],
        // Handlers receive (args, flowManager) and return [result, nextNode].
        handler: async (args, fm) => {
          fm.state.name = args.name;
          return [{ status: "ok" }, createAskReasonNode()];
        },
      }),
    ],
  };
}

function createAskReasonNode(): NodeConfig {
  return {
    name: "ask_reason",
    taskMessages: [{ role: "developer", content: "Ask why they are calling." }],
  };
}

await flowManager.initialize(createGreetingNode());
// #endregion node

// #region direct
/**
 * A direct function: the first parameter is the flow manager, the rest are
 * the tool's arguments. Its description and parameter schemas are attached
 * as metadata, since JavaScript has no docstrings or type hints at runtime.
 */
async function bookSlot(fm: FlowManager, day: string, hour: number) {
  fm.state.slot = { day, hour };
  return [{ booked: true }, createAskReasonNode()] as const;
}
Object.assign(bookSlot, {
  description: "Book an appointment slot.",
  parameters: {
    day: { type: "string", description: "Weekday name." },
    hour: { type: "integer", description: "Hour of the day, 0-23." },
  },
});

// Per-tool call options, as a decorator-style wrapper.
const slowLookup = flowsToolOptions({ cancelOnInterruption: false, timeoutSecs: 30 })(
  Object.assign(
    async (fm: FlowManager, query: string) => {
      void fm;
      return [{ matches: [query] }, NO_RESPONSE] as const;
    },
    { description: "Search the records.", parameters: { query: { type: "string" } } },
  ),
);

const node: NodeConfig = {
  taskMessages: [{ role: "developer", content: "Help the caller book a slot." }],
  functions: [bookSlot as any, slowLookup as any],
};
// #endregion direct

// #region actions
const actionsNode: NodeConfig = {
  taskMessages: [{ role: "developer", content: "Confirm the booking." }],
  preActions: [{ type: "tts_say", text: "One moment while I check." }],
  postActions: [
    {
      // A custom action: the handler receives the action and the flow manager.
      type: "notify",
      channel: "#bookings",
      handler: async (action, fm) => {
        console.log(`notify ${String(action.channel)}: ${JSON.stringify(fm.state.slot)}`);
      },
    },
    { type: "end_conversation", text: "Goodbye!" },
  ],
};
// #endregion actions

// #region register-action
flowManager.registerAction("notify", async (action, fm) => {
  console.log(`notify ${String(action.channel)}: ${JSON.stringify(fm.state)}`);
});
// #endregion register-action

// #region strategy
const resetNode: NodeConfig = {
  taskMessages: [{ role: "developer", content: "Start the payment step." }],
  // Drop the earlier conversation; keep only this node's messages.
  contextStrategy: new ContextStrategyConfig({ strategy: ContextStrategy.RESET }),
};

const managerWithDefault = new FlowManager({
  worker,
  llm,
  contextAggregator: aggregators,
  // The default for nodes that do not set their own.
  contextStrategy: new ContextStrategyConfig({ strategy: ContextStrategy.APPEND }),
});
// #endregion strategy

// #region config-yaml
const YAML = `
initial_node: greeting
nodes:
  greeting:
    role_message: You work for {{ clinic }}.
    task_messages:
      - role: developer
        content: Greet the caller and ask for their name.
    functions:
      - name: record_name
        transition_to: ask_reason
  ask_reason:
    task_messages:
      - role: developer
        content: Ask why {{ name }} is calling.
    context_strategy: reset
`;

async function record_name(fm: FlowManager, name: string) {
  fm.state.name = name;
  // The config decides the next node.
  return [{ status: "ok" }, TRANSITION_IN_YAML] as const;
}
Object.assign(record_name, {
  description: "Record the caller's name.",
  parameters: { name: { type: "string" } },
});

const flow = new Flow(FlowConfig.fromYaml(YAML), { handlers: { record_name } });
const configured = new FlowManager({
  worker,
  llm,
  contextAggregator: aggregators,
  globalFunctions: flow.globalFunctions,
});
configured.state.clinic = "Riverside Dental";
await configured.initialize(flow.initialNode);
// #endregion config-yaml

// #region config-file
const fromDisk = FlowConfig.fromFile("flow.yaml", {
  readFile: (path) => readFileSync(path, "utf8"),
});
// #endregion config-file
void [node, actionsNode, resetNode, managerWithDefault, fromDisk];

// #region dynamic
interface Slot {
  day: string;
  hour: number;
}

function createDayNode(): NodeConfig {
  return {
    name: "day",
    taskMessages: [{ role: "developer", content: "Ask which weekday the caller prefers." }],
    functions: [
      new FlowsFunctionSchema({
        name: "choose_day",
        description: "Record the preferred weekday.",
        properties: { day: { type: "string" } },
        required: ["day"],
        handler: async (args, fm) => {
          fm.state.day = args.day;
          // Build the next node from what the caller just said.
          return [{ day: args.day }, createHourNode(String(args.day))];
        },
      }),
    ],
  };
}

function createHourNode(day: string): NodeConfig {
  return {
    name: "hour",
    taskMessages: [{ role: "developer", content: `Offer times on ${day} and ask which one.` }],
    functions: [
      new FlowsFunctionSchema({
        name: "choose_hour",
        description: "Record the chosen hour.",
        properties: { hour: { type: "integer" } },
        required: ["hour"],
        handler: async (args, fm) => {
          const slot: Slot = { day, hour: Number(args.hour) };
          fm.state.slot = slot;
          return [slot, createDoneNode(slot)];
        },
      }),
    ],
  };
}

function createDoneNode(slot: Slot): NodeConfig {
  return {
    name: "done",
    taskMessages: [
      { role: "developer", content: `Confirm ${slot.day} at ${slot.hour}:00, then say goodbye.` },
    ],
    postActions: [{ type: "end_conversation" }],
  };
}

await flowManager.setNodeFromConfig(createDayNode());
// #endregion dynamic
