// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_evals_transport.py

/** Tests for the eval transport's per-connection flags, over an accepted WebSocket. */

import { describe, expect, mock, test } from "bun:test";
import { Queue, waitFor } from "@pipedog/asyncio";
import { type Frame, LLMConfigureOutputFrame } from "@pipedog/core/frames/frames";
import type { FastAPIWebSocket } from "@pipedog/transport-websocket/fastapi";
import {
  EvalFastAPIWebsocketInputTransport,
  EvalFastAPIWebsocketOutputTransport,
  EvalFastAPIWebsocketTransport,
} from "../src/fastapi_transport.ts";
import { EvalConnectionFlags, EvalSerializer } from "../src/serializer.ts";
import { EvalTransportParams } from "../src/transport.ts";

/** A stand-in for an accepted socket (upstream: `MagicMock()`). */
function fakeWebsocket(): FastAPIWebSocket {
  return { headers: { get: () => null } } as unknown as FastAPIWebSocket;
}

// The query-flag tests exercise `_query_flag` and the URL flags of the
// deprecated `EvalTransport` server (deprecated since 1.13.0, removed in
// 2.0.0), which is not ported: the flags arrive in the `eval-connect` message.
describe("TestQueryFlag", () => {
  test.skip("test_true_via_legacy_path", () => {});
  test.skip("test_true_via_request_path", () => {});
  test.skip("test_accepts_yes_and_mixed_case", () => {});
  test.skip("test_capture_audio_flag", () => {});
  test.skip("test_capture_images_flag", () => {});
  test.skip("test_false_when_absent", () => {});
  test.skip("test_false_when_falsey_value", () => {});
  test.skip("test_false_when_no_path_at_all", () => {});
});

// These build the deprecated `EvalTransport` server (deprecated since 1.13.0,
// removed in 2.0.0), which is not ported. `TestEvalFastAPIWebsocketTransport`
// covers the same skip_tts-before-greeting behavior on the supported transport.
describe("TestConnectionOutputSettings", () => {
  test.skip("test_audio_connection_reenables_tts_without_query_flag", () => {});
  test.skip("test_audio_connection_reenables_tts_with_false_query_flag", () => {});
});

describe("TestEvalFastAPIWebsocketTransport", () => {
  const _transport = (flags: EvalConnectionFlags): EvalFastAPIWebsocketTransport => {
    const params = new EvalTransportParams({ serializer: new EvalSerializer() });
    return new EvalFastAPIWebsocketTransport(fakeWebsocket(), params, flags);
  };

  test("test_uses_the_eval_input_and_output", () => {
    const transport = _transport(new EvalConnectionFlags());
    expect(transport.input()).toBeInstanceOf(EvalFastAPIWebsocketInputTransport);
    expect(transport.output()).toBeInstanceOf(EvalFastAPIWebsocketOutputTransport);
  });

  test("test_capture_flags_reach_the_serializer", () => {
    const transport = _transport(
      new EvalConnectionFlags({ captureBotAudio: true, captureBotImages: true }),
    );
    const serializer = (transport as unknown as { _params: { serializer: EvalSerializer } })._params
      .serializer as unknown as { _captureAudio: boolean; _captureImages: boolean };
    expect(serializer._captureAudio).toBe(true);
    expect(serializer._captureImages).toBe(true);
  });

  /** The skip_tts settings pushed by the time `on_client_connected` runs. */
  const _greetingSkipTts = async (skipTts: boolean): Promise<boolean[]> => {
    const transport = _transport(new EvalConnectionFlags({ skipTts }));
    const pushFrame = mock(async (_frame: Frame) => {});
    transport.input().pushFrame = pushFrame;
    const greetingSettings = new Queue<boolean[]>();

    transport.eventHandler("on_client_connected", async () => {
      greetingSettings.putNowait(
        pushFrame.mock.calls
          .map((call) => call[0])
          .filter((frame) => frame instanceof LLMConfigureOutputFrame)
          .map((frame) => (frame as LLMConfigureOutputFrame).skipTts),
      );
    });

    await (
      transport as unknown as { _onClientConnected(ws: FastAPIWebSocket): Promise<void> }
    )._onClientConnected(fakeWebsocket());
    return await waitFor(() => greetingSettings.get(), 1);
  };

  test("test_skip_tts_is_configured_before_on_client_connected", async () => {
    expect(await _greetingSkipTts(true)).toEqual([true]);
    expect(await _greetingSkipTts(false)).toEqual([false]);
  });
});
