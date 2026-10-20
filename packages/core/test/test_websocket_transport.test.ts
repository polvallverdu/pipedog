// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_websocket_transport.py

import { describe, test } from "bun:test";

// Upstream, the whole of tests/test_websocket_transport.py is commented out, so
// pytest collects no tests from it. It is dead code written against modules that
// no longer exist (`pipecat.pipeline.frames`, `pipecat.transports.websocket_transport`
// with `WebsocketTransport`, `WebSocketFrameProcessor`, `_websocket_handler`,
// `on_connection`, `transport.run(pipeline)`, `AudioFrame`). The current websocket
// transports live in transports/websocket/{server,client}.py and are ported to
// @pipedog/transport-websocket with their own tests.
//
// The test names are kept here as skipped tests so the two suites can be diffed;
// there is nothing to port in their bodies.
describe("TestWebSocketTransportService", () => {
  const reason = "commented out upstream (targets removed pipecat.transports.websocket_transport)";

  test.skip(`test_websocket_handler (${reason})`, () => {});
  test.skip(`test_on_connection_decorator (${reason})`, () => {});
  test.skip(`test_frame_processor (${reason})`, () => {});
  test.skip(`test_serializer_parameter (${reason})`, () => {});
});
