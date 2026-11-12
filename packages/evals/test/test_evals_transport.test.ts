// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_evals_transport.py

/** Tests for the eval transport, over its server and over an accepted WebSocket. */

import { describe, expect, mock, test } from "bun:test";
import { Queue, waitFor } from "@pipedog/asyncio";
import {
  type Frame,
  LLMConfigureOutputFrame,
  UserImageRawFrame,
  UserImageRequestFrame,
} from "@pipedog/core/frames/frames";
import * as RTVI from "@pipedog/core/processors/frameworks/rtvi/models";
import { bytesToBase64 } from "@pipedog/core/utils/base64";
import { pyJsonDumps } from "@pipedog/core/utils/py_json";
import type { FastAPIWebSocket } from "@pipedog/transport-websocket/fastapi";
import {
  EvalFastAPIWebsocketInputTransport,
  EvalFastAPIWebsocketOutputTransport,
  EvalFastAPIWebsocketTransport,
} from "../src/fastapi_transport.ts";
import { EVAL_IMAGE_MESSAGE_TYPE, EvalConnectionFlags, EvalSerializer } from "../src/serializer.ts";
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

// -- A minimal PNG encoder (upstream builds the image with Pillow) --

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of data) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + body.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, body.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(body, 8);
  view.setUint32(8 + body.length, crc32(out.subarray(4, 8 + body.length)));
  return out;
}

/** `Image.new("RGB", (width, height), color).save(buffer, format="PNG")`. */
async function solidPng(
  width: number,
  height: number,
  color: [number, number, number],
): Promise<Uint8Array> {
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  const raw = new Uint8Array(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) raw.set(color, y * (1 + width * 3) + 1 + x * 3);
  }
  const stream = new Blob([raw]).stream().pipeThrough(new CompressionStream("deflate"));
  const idat = new Uint8Array(await new Response(stream).arrayBuffer());
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", idat),
    pngChunk("IEND", new Uint8Array(0)),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/** The protected members of the input transport these tests reach into (as upstream does). */
interface InputTransportInternals {
  _params: { serializer: EvalSerializer };
  pushFrame: (frame: Frame) => Promise<void>;
  _serveUserImage(request: UserImageRequestFrame): Promise<void>;
}

describe("TestUserImageRequests", () => {
  /**
   * The input of the eval transport over its server and over an accepted WebSocket.
   *
   * Upstream also covers the deprecated `EvalTransport` server (deprecated since
   * 1.13.0, removed in 2.0.0), which is not ported; only the accepted WebSocket
   * transport is exercised here.
   */
  const _inputTransports = (): InputTransportInternals[] => {
    const accepted = new EvalFastAPIWebsocketTransport(
      fakeWebsocket(),
      new EvalTransportParams({ serializer: new EvalSerializer() }),
      new EvalConnectionFlags(),
    );
    return [accepted.input() as unknown as InputTransportInternals];
  };

  /** Register an image with the serializer, as the harness's eval-image message does. */
  const _registerImage = async (serializer: EvalSerializer): Promise<void> => {
    const png = await solidPng(4, 3, [255, 0, 0]);
    const message = {
      label: RTVI.MESSAGE_LABEL,
      type: "client-message",
      id: "1",
      data: {
        t: EVAL_IMAGE_MESSAGE_TYPE,
        d: {
          image: bytesToBase64(png),
          format: "image/png",
        },
      },
    };
    await serializer.deserialize(pyJsonDumps(message));
  };

  test("test_request_without_an_image_is_answered_with_an_error", async () => {
    for (const inputTransport of _inputTransports()) {
      const pushFrame = mock(async (_frame: Frame) => {});
      inputTransport.pushFrame = pushFrame;
      const resultCallback = mock(async (_result: unknown) => {});
      const request = new UserImageRequestFrame({ userId: "user", resultCallback });

      await inputTransport._serveUserImage(request);

      expect(resultCallback).toHaveBeenCalledTimes(1);
      expect(resultCallback.mock.calls[0]![0]).toHaveProperty("error");
      expect(pushFrame).not.toHaveBeenCalled();
    }
  });

  test("test_request_with_an_image_is_served_the_image", async () => {
    for (const inputTransport of _inputTransports()) {
      await _registerImage(inputTransport._params.serializer);
      const pushFrame = mock(async (_frame: Frame) => {});
      inputTransport.pushFrame = pushFrame;
      const resultCallback = mock(async (_result: unknown) => {});
      const request = new UserImageRequestFrame({ userId: "user", resultCallback });

      await inputTransport._serveUserImage(request);

      const frame = pushFrame.mock.calls.at(-1)![0];
      expect(frame).toBeInstanceOf(UserImageRawFrame);
      expect((frame as UserImageRawFrame).request).toBe(request);
      expect(resultCallback).not.toHaveBeenCalled();
    }
  });
});
