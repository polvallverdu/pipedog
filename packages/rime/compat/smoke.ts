// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Runtime smoke test for tools/compat. On every runtime (bun, node, deno, workerd) it:
// - runs `RimeHttpTTSService` against an in-process fake `fetch`;
// - runs `RimeTTSService` (JSON WebSocket) and `RimeV1TTSService` (protobuf, binary and
//   JSON envelopes from `@rimelabs/api`) against in-process fake WebSockets, so the
//   protobuf codec runs on the runtime under test.

import { create, fromBinary, fromJsonString, toBinary, toJsonString } from "@bufbuild/protobuf";
import { TTSAudioRawFrame, TTSSpeakFrame } from "@pipedog/core/frames/frames";
import { WebsocketClientConnection } from "@pipedog/core/services/websocket_service";
import { runTest, SleepFrame } from "@pipedog/core/tests/utils";
import { RimeHttpTTSService, RimeTTSService } from "@pipedog/rime/tts";
import { RimeV1TTSService } from "@pipedog/rime/tts_v1";
import {
  WebSocketDoneSchema,
  WebSocketReadySchema,
  WebSocketRequestSchema,
  type WebSocketResponse,
  WebSocketResponseSchema,
  WebSocketStartedSchema,
} from "@rimelabs/api";

function check(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(`rime smoke: ${message}`);
}

/** A WebSocket stand-in the service talks to; `onSend` produces the server's replies. */
class FakeWebSocket extends EventTarget {
  readyState = 1;
  binaryType = "arraybuffer";
  protocol = "";
  sent: unknown[] = [];

  onSend: (data: any, reply: (data: string | Uint8Array) => void) => void;

  constructor(
    onSend: (data: any, reply: (data: string | Uint8Array) => void) => void,
    protocol = "",
  ) {
    super();
    this.onSend = onSend;
    this.protocol = protocol;
  }

  reply = (data: string | Uint8Array) => {
    queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", { data })));
  };

  send(data: any) {
    this.sent.push(data);
    this.onSend(data, this.reply);
  }

  close() {
    this.readyState = 3;
  }
}

function connection(ws: FakeWebSocket): WebsocketClientConnection {
  return new WebsocketClientConnection(ws as unknown as WebSocket);
}

async function http(): Promise<void> {
  const audio = new Uint8Array(4096).fill(3);
  const fakeFetch = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string);
    check(body.speaker === "luna" && body.modelId === "coda", "http payload");
    return new Response(audio, { status: 200 });
  }) as unknown as typeof fetch;
  const service = new RimeHttpTTSService({
    apiKey: "key",
    fetch: fakeFetch,
    sampleRate: 24000,
    settings: new RimeHttpTTSService.Settings({ voice: "luna" }),
  });
  const [down] = await runTest(service, {
    framesToSend: [new TTSSpeakFrame({ text: "Hello." })],
    startTimeout: 3,
  });
  check(
    down.some((f) => f instanceof TTSAudioRawFrame),
    "http audio",
  );
}

async function websocketJson(): Promise<void> {
  const service: any = new RimeTTSService({
    apiKey: "key",
    sampleRate: 24000,
    settings: new RimeTTSService.Settings({ voice: "luna" }),
  });
  let handshakeHeaders: unknown = null;
  service._websocketConnect = async (url: string, options: any) => {
    handshakeHeaders = options.additionalHeaders;
    check(url.includes("speaker=luna") && url.includes("modelId=coda"), "ws url");
    return connection(
      new FakeWebSocket((data, reply) => {
        const msg = JSON.parse(data);
        if (typeof msg.text === "string") {
          reply(
            JSON.stringify({
              type: "chunk",
              data: btoa(String.fromCharCode(1, 2, 3, 4)),
              contextId: msg.contextId,
            }),
          );
          reply(JSON.stringify({ type: "done", contextId: msg.contextId }));
        }
      }),
    );
  };
  const [down] = await runTest(service, {
    framesToSend: [new TTSSpeakFrame({ text: "Hello." }), new SleepFrame({ sleep: 0.2 })],
    startTimeout: 3,
  });
  check((handshakeHeaders as any)?.Authorization === "Bearer key", "ws auth header");
  check(
    down.some((f) => f instanceof TTSAudioRawFrame),
    "ws audio",
  );
}

async function websocketV1(protocol: "binary" | "json"): Promise<void> {
  const subprotocol = `rime.v1.${protocol}`;
  const encode = (r: WebSocketResponse) =>
    protocol === "binary"
      ? toBinary(WebSocketResponseSchema, r)
      : toJsonString(WebSocketResponseSchema, r);
  const payloads: string[] = [];
  const service: any = new RimeV1TTSService({
    apiKey: "key",
    websocketProtocol: protocol,
    sampleRate: 24000,
    settings: new RimeV1TTSService.Settings({ model: "coda", voice: "luna" }),
  });
  service._websocketConnect = async (_url: string, options: any) => {
    check(options.subprotocols?.[0] === subprotocol, "subprotocol offered");
    const ws = new FakeWebSocket((data, reply) => {
      const request =
        protocol === "binary"
          ? fromBinary(WebSocketRequestSchema, new Uint8Array(data))
          : fromJsonString(WebSocketRequestSchema, data);
      const kind = request.payload.case ?? "";
      payloads.push(kind);
      const base = { contextId: request.contextId };
      if (kind === "start") {
        reply(
          encode(
            create(WebSocketResponseSchema, {
              ...base,
              payload: {
                case: "started",
                value: create(WebSocketStartedSchema, { requestId: "r" }),
              },
            }),
          ),
        );
      } else if (kind === "text") {
        reply(
          encode(
            create(WebSocketResponseSchema, {
              ...base,
              payload: { case: "audio", value: new Uint8Array([1, 2, 3, 4]) },
            }),
          ),
        );
      } else if (kind === "end") {
        reply(
          encode(
            create(WebSocketResponseSchema, {
              ...base,
              payload: { case: "done", value: create(WebSocketDoneSchema) },
            }),
          ),
        );
      }
    }, subprotocol);
    ws.reply(
      encode(
        create(WebSocketResponseSchema, {
          payload: { case: "ready", value: create(WebSocketReadySchema, { protocol: 1 }) },
        }),
      ),
    );
    return connection(ws);
  };
  const [down] = await runTest(service, {
    framesToSend: [new TTSSpeakFrame({ text: "Hello." }), new SleepFrame({ sleep: 0.2 })],
    startTimeout: 3,
  });
  check(payloads.join(",") === "start,text,end", `v1 ${protocol} requests: ${payloads}`);
  check(
    down.some((f) => f instanceof TTSAudioRawFrame),
    `v1 ${protocol} audio`,
  );
}

export default async function smoke(): Promise<Record<string, string>> {
  await http();
  await websocketJson();
  await websocketV1("binary");
  await websocketV1("json");
  return { http: "ok", websocket: "ok", v1: "ok" };
}
