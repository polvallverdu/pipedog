// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_google_image.py
//
// Upstream patches `google.genai.Client`; here the mock client is injected
// with the `client` option. Its `aclose` stands in for upstream's
// `client.aio.aclose`.

import { expect, mock, test } from "bun:test";
import { type GoogleImageGenClient, GoogleImageGenService } from "../src/image.ts";

function serviceWithMockClient() {
  const aclose = mock(async () => {});
  const mockClient = {
    models: { generateContent: mock() },
    aclose,
  } as unknown as GoogleImageGenClient & { aclose: typeof aclose };
  return {
    service: new GoogleImageGenService({ apiKey: "test-api-key", client: mockClient }),
    mockClient,
  };
}

test("test_cleanup_closes_genai_session", async () => {
  const { service, mockClient } = serviceWithMockClient();

  await service.cleanup();

  expect(mockClient.aclose).toHaveBeenCalledTimes(1);
});

test("test_genai_session_is_closed_once_across_repeated_cleanup", async () => {
  const { service, mockClient } = serviceWithMockClient();

  await service.cleanup();
  await service.cleanup();

  expect(mockClient.aclose).toHaveBeenCalledTimes(1);
});
