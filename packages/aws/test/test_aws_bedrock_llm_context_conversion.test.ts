// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_aws_bedrock_llm_context_conversion.py

/** Unit tests for AWSBedrockLLMService's file-message cleanup on error. */

import { expect, mock, spyOn, test } from "bun:test";

import { LLMContextConversionError } from "@pipedog/core/adapters/base_llm_adapter";
import { LLMContext } from "@pipedog/core/processors/aggregators/llm_context";

import { AWSServiceError } from "../src/aws_session.ts";
import { AWSBedrockLLMService } from "../src/llm.ts";

function _makeService(): AWSBedrockLLMService {
  const service = new AWSBedrockLLMService({
    awsAccessKey: "test",
    awsSecretKey: "test",
    awsRegion: "us-east-1",
  });
  const s = service as any;
  s.pushFrame = mock(async () => {});
  s.pushError = mock(async () => {});
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

/** `botocore.exceptions.ClientError` / `EventStreamError` equivalent. */
function _clientError(code: string, message: string, status: number): AWSServiceError {
  return new AWSServiceError({
    status,
    code,
    message: `An error occurred (${code}) when calling the ConverseStream operation: ${message}`,
    body: "",
  });
}

async function _processWithError(
  service: AWSBedrockLLMService,
  context: LLMContext,
  error: unknown,
): Promise<void> {
  const spy = spyOn(service as any, "_getLlmInvocationParams").mockImplementation(async () => {
    throw error;
  });
  try {
    await (service as any)._processContext(context);
  } finally {
    spy.mockRestore();
  }
}

test("test_aws_bedrock_llm_removes_file_message_on_context_conversion_error", async () => {
  // Test that an LLMContextConversionError triggers file-message cleanup.
  //
  // An unsupported file MIME type (or corrupt base64) fails during local
  // message conversion, before any request reaches Bedrock at all — so it
  // never surfaces as an API rejection, but it's just as much evidence the
  // file was the problem. Without this, the file stays in context forever,
  // since it was never actually sent for Bedrock to reject.
  const service = _makeService();
  const context = await _contextWithFileMessage();

  const error = new LLMContextConversionError(new Error("Unsupported 'file' MIME type"));
  await _processWithError(service, context, error);

  const messages = context.getMessages();
  expect(messages.length).toEqual(1);
  expect((messages[0] as any).content).toEqual("hello");
});

test("test_aws_bedrock_llm_removes_file_message_on_client_error", async () => {
  // A 4xx ClientError from Bedrock (e.g. a rejected document) triggers cleanup.
  //
  // This prevents the context from getting permanently stuck retrying a file
  // Bedrock has already rejected (e.g. ValidationException on document name).
  const service = _makeService();
  const context = await _contextWithFileMessage();

  const error = _clientError("ValidationException", "bad document name", 400);
  await _processWithError(service, context, error);

  const messages = context.getMessages();
  expect(messages.length).toEqual(1);
  expect((messages[0] as any).content).toEqual("hello");
});

test("test_aws_bedrock_llm_removes_file_message_on_mid_stream_validation_error", async () => {
  // A rejection arriving mid-stream triggers cleanup too.
  //
  // When the model rejects content after ConverseStream has started (e.g. file
  // bytes not matching the declared format), the error code is the event
  // stream's modeled `validationException` — lowercase, unlike the up-front
  // rejection's `ValidationException`.
  const service = _makeService();
  const context = await _contextWithFileMessage();

  const error = _clientError(
    "validationException",
    "The detected file MIME type image/webp does not match the expected type image/png.",
    0,
  );
  await _processWithError(service, context, error);

  const messages = context.getMessages();
  expect(messages.length).toEqual(1);
  expect((messages[0] as any).content).toEqual("hello");
});

test("test_aws_bedrock_llm_leaves_context_alone_on_server_error", async () => {
  // A 5xx ClientError from Bedrock does not trigger file-message cleanup.
  //
  // A server-side failure isn't evidence that our request (or its file) was
  // bad, so the message should survive to be retried.
  const service = _makeService();
  const context = await _contextWithFileMessage();

  const error = _clientError("InternalServerException", "internal error", 500);
  await _processWithError(service, context, error);

  expect(context.getMessages().length).toEqual(2);
});

test("test_aws_bedrock_llm_leaves_context_alone_on_throttling_error", async () => {
  // A ThrottlingException from Bedrock does not trigger file-message cleanup.
  //
  // Throttling arrives as a 4xx ClientError like ValidationException does,
  // but it says nothing about whether the request (or its file) was bad —
  // removing the file wouldn't help the next retry succeed, and would just
  // discard it for no reason.
  const service = _makeService();
  const context = await _contextWithFileMessage();

  const error = _clientError("ThrottlingException", "rate exceeded", 429);
  await _processWithError(service, context, error);

  expect(context.getMessages().length).toEqual(2);
});
