# @pipedog/flows

Structured conversations for pipedog: a port of Pipecat Flows (`pipecat.flows`). Describe a
conversation as a graph of **nodes**. Each node gives the LLM one job, the few tools it may call
there, and optional actions. A tool does its work and can send the conversation to the next node.

```sh
bun add @pipedog/flows
```

It works with any LLM service that does function calling (the end-to-end tests run OpenAI,
Anthropic and Google through a real pipeline), and runs on Bun, Node, Deno and Workers.

```ts
import { FlowManager, FlowsFunctionSchema, type NodeConfig } from "@pipedog/flows";

const flowManager = new FlowManager({ worker, llm, contextAggregator: aggregators });

function createGreetingNode(): NodeConfig {
  return {
    name: "greeting",
    roleMessage: "You are a friendly receptionist. Speak briefly.",
    taskMessages: [{ role: "developer", content: "Greet the caller and ask for their name." }],
    functions: [
      new FlowsFunctionSchema({
        name: "record_name",
        description: "Record the caller's name.",
        properties: { name: { type: "string" } },
        required: ["name"],
        // Handlers get (args, flowManager) and return [result, nextNode].
        handler: async (args, fm) => {
          fm.state.name = args.name;
          return [{ status: "ok" }, createReasonNode()];
        },
      }),
    ],
  };
}

await flowManager.initialize(createGreetingNode());
```

A flow can also be data: `FlowConfig.fromYaml(text)` (or `fromJson`, `fromFile` with a `readFile`
you pass in) joined to your handlers with `new Flow(config, { handlers })`.
`FlowConfig.modelJsonSchema()` returns the file format's JSON Schema for editor validation.

Documentation: nodes, functions, actions, context strategies, flow configs and dynamic flows are in
the Flows section of the docs (`apps/docs/content/docs/flows`).

## Differences from Pipecat

- `NodeConfig` and `ActionConfig` keys are camelCase; the YAML/JSON file format keeps snake_case.
- A tool returns a two-element array `[result, nextNode]`; handlers are called as
  `(args, flowManager)`.
- A direct function's first parameter is `flowManager`; its description and parameter schemas are
  attached as metadata (`description`, `parameters`).
- `FlowConfig.fromFile` and `!include` read through an injected `readFile`.
- Validation is hand-written and throws `ValidationError` listing every problem.
- Placeholders render with `String()` (objects as JSON).
- Deprecated upstream APIs are not ported; `RESET_WITH_SUMMARY` is kept and warns once.

Part of [pipedog](https://github.com/polvallverdu/pipedog), an unofficial port of
[Pipecat](https://github.com/pipecat-ai/pipecat) (BSD-2-Clause, by Daily).
