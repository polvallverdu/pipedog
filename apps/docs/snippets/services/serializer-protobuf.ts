// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Samples for content/docs/serializers/protobuf.mdx. Type-checked on every docs build.

// #region usage
import { TextFrame } from "@pipedog/core/frames/frames";
import { ProtobufFrameSerializer } from "@pipedog/serializer-protobuf/protobuf";
import {
  FastAPIWebsocketParams,
  FastAPIWebsocketTransport,
} from "@pipedog/transport-websocket/fastapi";
import type { WebsocketConnection } from "@pipedog/transport-websocket/socket";

function createTransport(connection: WebsocketConnection): FastAPIWebsocketTransport {
  return new FastAPIWebsocketTransport(
    connection,
    new FastAPIWebsocketParams({
      audioInEnabled: true,
      audioOutEnabled: true,
      serializer: new ProtobufFrameSerializer(),
    }),
  );
}
// #endregion usage

// #region roundtrip
// The transports call these for you; this shows the wire form of one frame.
const serializer = new ProtobufFrameSerializer();
const bytes = await serializer.serialize(new TextFrame({ text: "hello" }));
const frame = bytes ? await serializer.deserialize(bytes) : null;
// #endregion roundtrip
