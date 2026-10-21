// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_azure_voice_live_text_turns.py

/**
 * Tests for text-injected user turns in AzureVoiceLiveLLMService.
 *
 * These tests drive the context handler directly with a fake
 * `sendClientEvent` and assert on the client events emitted to the service.
 * An audio turn reaches Voice Live as audio and gets a response for it; a
 * turn that only appears in the context has to be sent.
 */

import { expect, test } from "bun:test";

import { LLMContext } from "@pipedog/core/processors/aggregators/llm_context";

import * as events from "../src/voice_live/events.ts";
import { AzureVoiceLiveLLMService } from "../src/voice_live/llm.ts";

// The protected members these tests reach into, as upstream does.
type Internals = any;

/** Records the client events sent via `sendClientEvent`. */
class _EventRecorder {
  events: events.ClientEvent[] = [];

  readonly call = async (event: events.ClientEvent): Promise<void> => {
    this.events.push(event);
  };

  kinds(): string[] {
    return this.events.map((e) => e.constructor.name);
  }

  userTexts(): string[] {
    const texts: string[] = [];
    for (const e of this.events) {
      if (e instanceof events.ConversationItemCreateEvent && e.item.role === "user") {
        for (const c of e.item.content ?? []) {
          if (c.text) texts.push(c.text);
        }
      }
    }
    return texts;
  }
}

/** Stand-in for `pushFrame`, which needs a linked processor. */
async function _ignoreFrame(..._args: unknown[]): Promise<void> {}

/** Construct a service wired to a fake sendClientEvent. */
function _makeService(
  sessionProperties: events.SessionProperties | null = null,
): [Internals, _EventRecorder] {
  const settings = sessionProperties
    ? new AzureVoiceLiveLLMService.Settings({ sessionProperties })
    : null;
  const service: Internals = new AzureVoiceLiveLLMService({
    apiKey: "test-key",
    endpoint: "https://my-resource.services.ai.azure.com",
    settings,
  });
  const recorder = new _EventRecorder();
  service.sendClientEvent = recorder.call;
  service.pushFrame = _ignoreFrame;
  // The session is configured by the time context frames arrive.
  service._apiSessionReady = true;
  service._llmNeedsConversationSetup = false;
  return [service, recorder];
}

/** Hand the service its first context and let the response it asks for finish. */
async function _start(service: Internals, context: LLMContext): Promise<void> {
  await service._handleContext(context);
  await service._handleEvtResponseDone(
    new events.ResponseDone({
      type: "response.done",
      response: { id: "resp_0", status: "completed" },
    }),
  );
}

async function _transcriptionCompleted(service: Internals, transcript: string): Promise<void> {
  await service._handleEvtInputAudioTranscriptionCompleted({ itemId: "item_1", transcript });
}

function _developerContext(): LLMContext {
  return new LLMContext({ messages: [{ role: "developer", content: "Be brief." }] });
}

test("test_a_text_user_turn_is_sent_and_answered", async () => {
  // Nothing else carries the turn to the service when there is no audio.
  const [service, recorder] = _makeService();
  const context = _developerContext();

  await _start(service, context);
  recorder.events.length = 0;

  context.addMessage({ role: "user", content: "What is the capital of France?" });
  await service._handleContext(context);

  expect(recorder.userTexts()).toEqual(["What is the capital of France?"]);
  expect(recorder.kinds()).toContain("ResponseCreateEvent");
});

test("test_a_text_turn_during_a_response_is_answered_when_it_finishes", async () => {
  // Voice Live rejects a second response while one is running.
  const [service, recorder] = _makeService();
  const context = _developerContext();

  await _start(service, context);
  service._responseInFlight = true;
  recorder.events.length = 0;

  context.addMessage({ role: "user", content: "What is the capital of Japan?" });
  await service._handleContext(context);

  expect(recorder.userTexts()).toEqual(["What is the capital of Japan?"]);
  expect(recorder.kinds()).not.toContain("ResponseCreateEvent");
  expect(service._runLlmWhenResponseDone).toBe(true);
});

test("test_a_server_vad_turn_is_not_sent_again", async () => {
  // Server VAD already has the audio and created its own response.
  const [service, recorder] = _makeService();
  const context = _developerContext();

  await _start(service, context);
  recorder.events.length = 0;

  // The service pushes the transcript; it lands in the context after.
  await _transcriptionCompleted(service, "What is the capital of France?");
  context.addMessage({ role: "user", content: "What is the capital of France?" });
  await service._handleContext(context);

  expect(recorder.userTexts()).toEqual([]);
  expect(recorder.kinds()).not.toContain("ResponseCreateEvent");
});

test("test_a_tool_result_landing_first_does_not_release_the_server_vad_turn", async () => {
  // The transcript is written after the response starts, so a tool result can land first.
  const [service, recorder] = _makeService();
  const context = _developerContext();

  await _start(service, context);
  await _transcriptionCompleted(service, "What's the weather?");

  // The spoken turn's tool call completes before its transcript is written.
  context.addMessage({
    role: "assistant",
    tool_calls: [
      {
        id: "call_1",
        type: "function",
        function: { name: "get_current_weather", arguments: "{}" },
      },
    ],
  });
  context.addMessage({ role: "tool", tool_call_id: "call_1", content: '{"temp": 75}' });
  await service._handleContext(context);

  recorder.events.length = 0;
  context.addMessage({ role: "user", content: "What's the weather?" });
  await service._handleContext(context);

  expect(recorder.userTexts()).toEqual([]);
  expect(recorder.kinds()).not.toContain("ResponseCreateEvent");

  context.addMessage({ role: "user", content: "typed turn" });
  await service._handleContext(context);

  expect(recorder.userTexts()).toEqual(["typed turn"]);
});

test("test_a_manual_turn_is_not_sent_again_when_its_transcript_lands", async () => {
  // A manual turn commits the caller's audio, so Voice Live already has the turn.
  const [service, recorder] = _makeService(
    new events.SessionProperties({
      turnDetection: null,
      inputAudioTranscription: new events.InputAudioTranscription({ model: "azure-speech" }),
    }),
  );
  const context = _developerContext();
  await _start(service, context);

  await service._handleUserStoppedSpeaking(null);
  await _transcriptionCompleted(service, "What is the capital of France?");
  recorder.events.length = 0;

  context.addMessage({ role: "user", content: "What is the capital of France?" });
  await service._handleContext(context);

  expect(recorder.userTexts()).toEqual([]);
  expect(recorder.kinds()).not.toContain("ResponseCreateEvent");
});

test("test_an_assistant_message_does_not_create_a_turn", async () => {
  const [service, recorder] = _makeService();
  const context = _developerContext();

  await _start(service, context);
  recorder.events.length = 0;

  context.addMessage({ role: "assistant", content: "Paris." });
  await service._handleContext(context);

  expect(recorder.userTexts()).toEqual([]);
  expect(recorder.kinds()).not.toContain("ResponseCreateEvent");
});

test("test_an_empty_repeat_transcription_does_not_release_the_claim", async () => {
  // Voice Live reports an empty transcript for an item again once the next audio commits.
  const [service, recorder] = _makeService();
  const context = _developerContext();
  await _start(service, context);

  await _transcriptionCompleted(service, "What is the capital of France?");
  await _transcriptionCompleted(service, "");
  recorder.events.length = 0;

  context.addMessage({ role: "user", content: "What is the capital of France?" });
  await service._handleContext(context);

  expect(recorder.userTexts()).toEqual([]);
  expect(recorder.kinds()).not.toContain("ResponseCreateEvent");
});

/** Replace a long history with a short one, in place or with a new context. */
function _shorten(context: LLMContext, replaceObject: boolean): LLMContext {
  const short = [{ role: "developer" as const, content: "Be brief." }];
  if (replaceObject) {
    return new LLMContext({ messages: short });
  }
  context.setMessages(short);
  return context;
}

test.each([
  ["set-messages", false],
  ["new-context", true],
])("test_a_text_turn_after_the_context_shrinks_is_sent[%s]", async (_id, replaceObject) => {
  // New messages are counted from a shorter context's length, not the old one's.
  const [service, recorder] = _makeService();
  let context = _developerContext();
  await _start(service, context);
  for (let i = 0; i < 5; i++) {
    context.addMessage({ role: "user", content: `Question ${i}` });
    context.addMessage({ role: "assistant", content: `Answer ${i}` });
  }
  await service._handleContext(context);

  context = _shorten(context, replaceObject);
  await service._handleContext(context);
  recorder.events.length = 0;

  context.addMessage({ role: "user", content: "What is the capital of Spain?" });
  await service._handleContext(context);

  expect(recorder.userTexts()).toEqual(["What is the capital of Spain?"]);
  expect(recorder.kinds()).toContain("ResponseCreateEvent");
});

test("test_a_transcript_awaited_across_a_shrink_does_not_swallow_a_text_turn", async () => {
  const [service, recorder] = _makeService();
  const context = _developerContext();
  await _start(service, context);

  // The caller's transcript is pushed, but the context is replaced before it lands.
  await _transcriptionCompleted(service, "What is the capital of France?");
  context.setMessages([]);
  await service._handleContext(context);
  recorder.events.length = 0;

  context.addMessage({ role: "user", content: "What is the capital of Spain?" });
  await service._handleContext(context);

  expect(recorder.userTexts()).toEqual(["What is the capital of Spain?"]);
});

test("test_list_content_is_flattened_to_text", async () => {
  const [service, recorder] = _makeService();
  const context = _developerContext();

  await _start(service, context);
  recorder.events.length = 0;

  context.addMessage({
    role: "user",
    content: [
      { type: "text", text: "What is" },
      { type: "text", text: "the time?" },
    ],
  });
  await service._handleContext(context);

  expect(recorder.userTexts()).toEqual(["What is the time?"]);
});
