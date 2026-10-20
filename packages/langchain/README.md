# @pipedog/langchain

[LangChain](https://js.langchain.com) and [LangGraph](https://langchain-ai.github.io/langgraphjs/)
for pipedog: a port of Pipecat's `pipecat.processors.frameworks.langchain` (`LangchainProcessor`).

```sh
bun add @pipedog/langchain @langchain/core
```

`LangchainProcessor` takes the latest user message from each `LLMContextFrame`, streams it through
any LangChain `Runnable`, and pushes the output as `TextFrame`s between `LLMFullResponseStartFrame`
and `LLMFullResponseEndFrame`. Put it where an LLM service would go:

```ts
import { ChatPromptTemplate } from "@langchain/core/prompts";
import { ChatOpenAI } from "@langchain/openai";
import { LangchainProcessor } from "@pipedog/langchain/langchain";

const prompt = ChatPromptTemplate.fromMessages([
  ["system", "You are a helpful voice assistant. Keep answers short."],
  ["human", "{input}"],
]);
const lc = new LangchainProcessor(prompt.pipe(new ChatOpenAI({ model: "gpt-4.1-mini" })));

const pipeline = new Pipeline([
  transport.input(),
  stt,
  contextAggregator.user(),
  lc,
  tts,
  transport.output(),
  contextAggregator.assistant(),
]);
```

| option | default | |
|---|---|---|
| `transcriptKey` | `"input"` | the input key the user's text is passed under |

Strings and `AIMessageChunk`s from the stream are spoken; anything else is skipped, as upstream.
`setParticipantId(id)` passes `configurable.session_id` to the chain (for
`RunnableWithMessageHistory`). Interruptions abort the stream: the chain receives an `AbortSignal`
in its config.

## LangGraph

A compiled graph is a `Runnable`, but its `stream()` yields state updates, not text. Wrap it to
speak what you want. To stream the model's tokens as they are generated:

```ts
import { AIMessageChunk } from "@langchain/core/messages";
import { RunnableLambda } from "@langchain/core/runnables";

const graph = workflow.compile({ checkpointer }); // a MessagesAnnotation graph

const chain = RunnableLambda.from(async function* (input: { messages: string }, config) {
  const thread_id = config?.configurable?.session_id;
  const stream = await graph.stream(input, {
    ...config,
    configurable: { ...config?.configurable, thread_id },
    streamMode: "messages",
  });
  for await (const [chunk] of stream) {
    if (AIMessageChunk.isInstance(chunk)) yield chunk;
  }
});

const lc = new LangchainProcessor(chain, { transcriptKey: "messages" });
```

To speak only the final answer, `await graph.invoke(input, config)` in a `RunnableLambda` and
return the last message's content. Both are tested in `test/test_langgraph.test.ts`.

## Runtimes

| | Bun | Node | Deno | Cloudflare Workers |
|---|---|---|---|---|
| `LangchainProcessor` | ✅ | ✅ | ✅ | ✅ |

Your chain's own dependencies (model SDKs, LangGraph checkpointers) decide where the whole thing runs.

## Differences from upstream

- A multi-part (list) message content is stringified as JSON instead of Python's `str()`.
- Upstream's `GeneratorExit` warning has no JavaScript equivalent; the stream is closed instead.
