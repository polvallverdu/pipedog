// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_inworld_realtime_context.py

/**
 * Tests for Inworld Realtime context synchronization.
 *
 * Upstream patches `websocket_connect` to capture the URI. Module bindings
 * can't be patched here, so `test_connect_generates_unique_session_keys`
 * points the services at a local `Bun.serve` websocket server and reads the
 * URIs it was asked for.
 */

import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";

import { LLMContext } from "@pipedog/core/processors/aggregators/llm_context";
import { FrameDirection } from "@pipedog/core/processors/frame_processor";

import { InworldRealtimeLLMService } from "../src/realtime/llm.ts";

// The tests reach into the service's protected members, as upstream does.
type AnyService = any;

describe("TestInworldRealtimeContext", () => {
  const requests: { url: string; authorization: string | null }[] = [];
  let server: ReturnType<typeof Bun.serve>;

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      fetch(req, srv) {
        requests.push({ url: req.url, authorization: req.headers.get("authorization") });
        if (srv.upgrade(req)) return undefined;
        return new Response("expected a websocket", { status: 400 });
      },
      websocket: { message() {} },
    });
  });

  afterAll(() => {
    server.stop(true);
  });

  test("test_connect_generates_unique_session_keys", async () => {
    const services: AnyService[] = [0, 1].map(
      () =>
        new InworldRealtimeLLMService({
          apiKey: "test",
          baseUrl: `ws://localhost:${server.port}/api/v1/realtime/session`,
        }),
    );

    // The receive task is discarded, as upstream's `discard_task` does.
    for (const service of services) {
      service.createTask = mock(() => null);
    }

    await services[0]._connect();
    await services[1]._connect();

    const sessionKeys = requests.map((r) => r.url.split("key=", 2)[1]!.split("&", 2)[0]);
    expect(sessionKeys).toHaveLength(2);
    expect(sessionKeys[0]).not.toEqual(sessionKeys[1]);
    for (const r of requests) {
      expect(r.url).toContain("protocol=realtime");
      expect(r.authorization).toBe("Basic test");
    }

    for (const service of services) {
      await service._websocket.close();
    }
  });

  test("test_runtime_temperature_is_sent_in_a_session_update", async () => {
    const service: AnyService = new InworldRealtimeLLMService({ apiKey: "test" });
    service._sendSessionUpdate = mock(async () => {});

    await service._updateSettings(new InworldRealtimeLLMService.Settings({ temperature: 0.3 }));

    expect(service._sendSessionUpdate).toHaveBeenCalledTimes(1);
    expect(service._settings.sessionProperties.temperature).toBe(0.3);
  });

  test("test_tool_update_does_not_consume_server_vad_user_turn", async () => {
    const context = new LLMContext({ messages: [{ role: "developer", content: "Be helpful." }] });
    const service: AnyService = new InworldRealtimeLLMService({ apiKey: "test" });
    service._context = context;
    service._lastContextMessageCount = context.getMessages().length;
    service._serverVadHandledTurn = true;
    service._processCompletedFunctionCalls = mock(async () => {});
    service.sendClientEvent = mock(async () => {});

    context.addMessages([
      {
        role: "assistant",
        tool_calls: [
          {
            id: "call-1",
            type: "function",
            function: { name: "weather", arguments: "{}" },
          },
        ],
      },
      { role: "tool", tool_call_id: "call-1", content: '{"temp": 22}' },
    ] as any);
    // The assistant aggregator pushes the context back upstream after a tool result.
    await service._handleContext(context, FrameDirection.UPSTREAM);

    expect(service._serverVadHandledTurn).toBe(true);
    expect(service.sendClientEvent).not.toHaveBeenCalled();

    context.addMessage({ role: "user", content: "What is the weather?" } as any);
    await service._handleContext(context, FrameDirection.DOWNSTREAM);

    expect(service._serverVadHandledTurn).toBe(false);
    expect(service.sendClientEvent).not.toHaveBeenCalled();
    expect(service._lastContextMessageCount).toBe(context.getMessages().length);
  });
});
