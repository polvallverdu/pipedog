// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_anthropic_llm_context_conversion.py

/** Unit tests for AnthropicLLMService's file-message cleanup on error. */

import { expect, mock, spyOn, test } from "bun:test";

import Anthropic from "@anthropic-ai/sdk";
import { LLMContextConversionError } from "@pipedog/core/adapters/base_llm_adapter";
import { LLMContext } from "@pipedog/core/processors/aggregators/llm_context";

import { AnthropicLLMService } from "../src/llm.ts";

function _makeService(): AnthropicLLMService {
  const service = new AnthropicLLMService({ apiKey: "test-key" });
  // pushFrame is mocked, so pushed error frames go nowhere — but pushError
  // itself stays real so error classification and the usability verdict run.
  const s = service as any;
  s.pushFrame = mock(async () => {});
  s.startProcessingMetrics = mock(async () => {});
  s.stopProcessingMetrics = mock(async () => {});
  s.startTtfbMetrics = mock(async () => {});
  return service;
}

async function _contextWithFileMessage(): Promise<LLMContext> {
  const context = new LLMContext();
  context.addMessage({ role: "user", content: "hello" });
  await context.addFileFrameMessage({
    type: "bytes",
    format: "application/pdf",
    file: "data:application/pdf;base64,ZmFrZSBwZGY=",
  });
  return context;
}

type ApiErrorClass = new (
  status: number,
  error: object | undefined,
  message: string | undefined,
  headers: Headers,
) => InstanceType<typeof Anthropic.APIError>;

function _apiStatusError(errorCls: ApiErrorClass, statusCode: number) {
  const body = { error: { type: "invalid_request_error", message: "bad document" } };
  return new errorCls(statusCode, body, "bad document", new Headers());
}

function _patchCreateMessageStream(
  service: AnthropicLLMService,
  impl: (apiCall: unknown, params: unknown) => Promise<unknown>,
) {
  return spyOn(service as any, "_createMessageStream").mockImplementation(impl as any);
}

test("test_anthropic_llm_removes_file_message_on_context_conversion_error", async () => {
  // Test that an LLMContextConversionError triggers file-message cleanup.
  //
  // An unsupported file MIME type (or corrupt base64) fails during local
  // message conversion, before any request reaches Anthropic at all — so it
  // never surfaces as an API rejection, but it's just as much evidence the
  // file was the problem. Without this, the file stays in context forever,
  // since it was never actually sent for Anthropic to reject.
  const service = _makeService();
  const context = await _contextWithFileMessage();

  const spy = _patchCreateMessageStream(service, async () => {
    throw new LLMContextConversionError(new Error("Unsupported 'file' MIME type"));
  });
  try {
    await (service as any)._processContext(context);
  } finally {
    spy.mockRestore();
  }

  const messages = context.getMessages();
  expect(messages.length).toEqual(1);
  expect((messages[0] as any).content).toEqual("hello");
});

test("test_anthropic_llm_removes_file_message_on_bad_request_error", async () => {
  // A 4xx APIStatusError from Anthropic (e.g. a rejected document) triggers cleanup.
  //
  // This prevents the context from getting permanently stuck retrying a file
  // Anthropic has already rejected.
  const service = _makeService();
  const context = await _contextWithFileMessage();

  const spy = _patchCreateMessageStream(service, async () => {
    throw _apiStatusError(Anthropic.BadRequestError as any, 400);
  });
  try {
    await (service as any)._processContext(context);
  } finally {
    spy.mockRestore();
  }

  const messages = context.getMessages();
  expect(messages.length).toEqual(1);
  expect((messages[0] as any).content).toEqual("hello");
  // The removal changed the next request, so the "permanent" invalid-request
  // verdict must not write the service off.
  expect(service.isUsable).toBe(true);
});

test("test_anthropic_llm_removes_image_message_on_bad_request_error", async () => {
  // A rejected image (e.g. bytes that don't match the declared media type)
  // gets the same cleanup as a rejected file, so the context doesn't get
  // permanently stuck resending it.
  const service = _makeService();
  const context = new LLMContext();
  context.addMessage({ role: "user", content: "hello" });
  await context.addImageFrameMessage({
    format: "image/png",
    size: [2, 2],
    image: new TextEncoder().encode("RIFF webp"),
  });

  const spy = _patchCreateMessageStream(service, async () => {
    throw _apiStatusError(Anthropic.BadRequestError as any, 400);
  });
  try {
    await (service as any)._processContext(context);
  } finally {
    spy.mockRestore();
  }

  const messages = context.getMessages();
  expect(messages.length).toEqual(1);
  expect((messages[0] as any).content).toEqual("hello");
  expect(service.isUsable).toBe(true);
});

test("test_anthropic_llm_bad_request_without_a_file_marks_service_unusable", async () => {
  // With nothing to repair, an invalid request really will keep recurring,
  // so the standard permanent-error verdict stands.
  const service = _makeService();
  const context = new LLMContext();
  context.addMessage({ role: "user", content: "hello" });

  const spy = _patchCreateMessageStream(service, async () => {
    throw _apiStatusError(Anthropic.BadRequestError as any, 400);
  });
  try {
    await (service as any)._processContext(context);
  } finally {
    spy.mockRestore();
  }

  expect(context.getMessages().length).toEqual(1);
  expect(service.isUsable).toBe(false);
});

test("test_anthropic_llm_leaves_context_alone_on_server_error", async () => {
  // A 5xx APIStatusError from Anthropic does not trigger file-message cleanup.
  //
  // A server-side failure isn't evidence that our request (or its file) was
  // bad, so the message should survive to be retried.
  const service = _makeService();
  const context = await _contextWithFileMessage();

  const spy = _patchCreateMessageStream(service, async () => {
    throw _apiStatusError(Anthropic.InternalServerError as any, 500);
  });
  try {
    await (service as any)._processContext(context);
  } finally {
    spy.mockRestore();
  }

  expect(context.getMessages().length).toEqual(2);
});

test("test_anthropic_llm_leaves_context_alone_on_rate_limit_error", async () => {
  // A 429 RateLimitError from Anthropic does not trigger file-message cleanup.
  //
  // A rate limit is a 4xx, but it says nothing about whether the request (or
  // its file) was bad — removing the file wouldn't help the next retry
  // succeed, and would just discard it for no reason.
  const service = _makeService();
  const context = await _contextWithFileMessage();

  const spy = _patchCreateMessageStream(service, async () => {
    throw _apiStatusError(Anthropic.RateLimitError as any, 429);
  });
  try {
    await (service as any)._processContext(context);
  } finally {
    spy.mockRestore();
  }

  expect(context.getMessages().length).toEqual(2);
});
