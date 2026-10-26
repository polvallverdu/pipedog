// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

import { afterEach, describe, expect, test } from "bun:test";
import * as api from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import {
  addLlmSpanAttributes,
  addSttSpanAttributes,
} from "@pipedog/core/utils/tracing/service_attributes";
import { redactSpan, redactTracer, redactTracerProvider } from "../src/redact.ts";

const exporter = new InMemorySpanExporter();
const provider = new BasicTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(exporter)],
});

afterEach(() => exporter.reset());

function finished(name: string) {
  const span = exporter.getFinishedSpans().find((s) => s.name === name);
  if (!span) throw new Error(`no span ${name}`);
  return span;
}

describe("redactContent", () => {
  test("keeps metadata and drops what was said on pipedog's service spans", () => {
    const tracer = redactTracer(provider.getTracer("pipedog"));
    const stt = tracer.startSpan("stt");
    addSttSpanAttributes(stt, {
      serviceName: "DeepgramSTTService",
      model: "nova-3",
      transcript: "my card number is 4242",
      isFinal: true,
      language: "en-US",
      userId: "user-123",
      ttfb: 0.25,
    });
    stt.end();
    const llm = tracer.startSpan("llm");
    addLlmSpanAttributes(llm, {
      serviceName: "OpenAILLMService",
      model: "gpt-4.1",
      messages: '[{"role":"user","content":"secret"}]',
      output: "the answer",
      systemInstructions: "You are a nurse",
      toolsSerialized: '[{"name":"lookup"}]',
    });
    llm.end();

    const sttAttributes = finished("stt").attributes;
    expect(sttAttributes["gen_ai.request.model"]).toBe("nova-3");
    expect(sttAttributes["gen_ai.provider.name"]).toBe("deepgram");
    expect(sttAttributes.language).toBe("en-US");
    expect(sttAttributes.is_final).toBe(true);
    expect(sttAttributes["metrics.ttfb"]).toBe(0.25);
    expect(sttAttributes.transcript).toBeUndefined();
    expect(sttAttributes.user_id).toBeUndefined();

    const llmAttributes = finished("llm").attributes;
    expect(llmAttributes["gen_ai.request.model"]).toBe("gpt-4.1");
    for (const key of ["input", "output", "gen_ai.system_instructions", "tools.definitions"]) {
      expect(llmAttributes[key]).toBeUndefined();
    }
  });

  test("filters start attributes, events, exceptions, statuses and links", () => {
    const tracer = redactTracer(provider.getTracer("t"));
    const span = tracer.startSpan("s", {
      attributes: { text: "hello", count: 2, "conversation.id": "c1", words: ["a", "b"] },
    });
    span.setAttributes({ text: "again", "turn.number": 3, flags: [true, false] });
    span.addEvent("said", { text: "hi", "exception.type": "X" });
    span.addEvent("plain");
    span.recordException(new TypeError("leaked message"));
    span.setStatus({ code: api.SpanStatusCode.ERROR, message: "leaked status" });
    span.end();

    const s = finished("s");
    expect(s.attributes).toEqual({
      count: 2,
      "conversation.id": "c1",
      "turn.number": 3,
      flags: [true, false],
    });
    expect(s.events.map((e) => [e.name, e.attributes])).toEqual([
      ["said", { "exception.type": "X" }],
      ["plain", {}],
      ["exception", { "exception.type": "TypeError" }],
    ]);
    expect(s.status).toEqual({ code: api.SpanStatusCode.ERROR });
  });

  test("startActiveSpan hands the callback a redacted span", () => {
    const tracer = redactTracer(provider.getTracer("t"));
    const result = tracer.startActiveSpan("active", { attributes: { text: "x" } }, (span) => {
      span.setAttribute("transcript", "secret");
      span.setAttribute("language", "es");
      span.end();
      return 42;
    });
    expect(result).toBe(42);
    expect(finished("active").attributes).toEqual({ language: "es" });
  });

  test("allowed keys can be extended, replaced or decided by a predicate", () => {
    const extended = redactTracerProvider(provider, { extraAllowedAttributes: ["app.tenant"] });
    const a = extended.getTracer("t").startSpan("a");
    a.setAttributes({ "app.tenant": "acme", "gen_ai.request.model": "m", text: "x" });
    a.end();
    expect(finished("a").attributes).toEqual({ "app.tenant": "acme", "gen_ai.request.model": "m" });

    const replaced = redactTracer(provider.getTracer("t"), { allowedAttributes: ["only"] });
    const b = replaced.startSpan("b");
    b.setAttributes({ only: "yes", "gen_ai.request.model": "m" });
    b.end();
    expect(finished("b").attributes).toEqual({ only: "yes" });

    const custom = redactTracer(provider.getTracer("t"), {
      isAllowed: (key) => key.startsWith("keep."),
    });
    const c = custom.startSpan("c");
    c.setAttributes({ "keep.me": "yes", n: 1 });
    c.end();
    expect(finished("c").attributes).toEqual({ "keep.me": "yes" });
  });

  test("redactSpan is idempotent", () => {
    const span = redactSpan(redactSpan(provider.getTracer("t").startSpan("twice")));
    span.setAttribute("language", "en");
    span.setAttribute("text", "x");
    span.end();
    expect(finished("twice").attributes).toEqual({ language: "en" });
  });
});
