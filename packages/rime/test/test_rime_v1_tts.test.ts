// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_rime_v1_tts.py

/**
 * Tests for RimeV1TTSService.
 *
 * Porting notes: upstream serves Rime v1 with the `websockets` package;
 * these tests serve it with `Bun.serve`. The protobuf messages come from
 * `@rimelabs/api` (upstream: the `rime-api` Python package, same schema).
 */

import { describe, expect, test } from "bun:test";
import { create, fromBinary, fromJson, fromJsonString, toBinary, toJson } from "@bufbuild/protobuf";
import {
  AggregatedTextFrame,
  BotStoppedSpeakingFrame,
  ErrorFrame,
  InterruptionFrame,
  LLMFullResponseEndFrame,
  LLMFullResponseStartFrame,
  LLMTextFrame,
  TextType,
  TTSAudioRawFrame,
  TTSSpeakFrame,
  TTSStartedFrame,
  TTSStoppedFrame,
  TTSTextFrame,
} from "@pipedog/core/frames/frames";
import { TextAggregationMode } from "@pipedog/core/services/tts_service";
import { runTest, SleepFrame } from "@pipedog/core/tests/utils";
import { Language } from "@pipedog/core/transcriptions/language";
import { ErrorCategory } from "@pipedog/core/utils/errors";
import { LOG_LEVELS, logger } from "@pipedog/core/utils/logger";
import {
  AudioParametersSchema,
  type WebSocketRequest as Request,
  type WebSocketResponse as Response_,
  SplitStrategy,
  WebSocketCancelledSchema,
  WebSocketDoneSchema,
  WebSocketErrorSchema,
  WebSocketReadySchema,
  WebSocketRequestSchema,
  WebSocketResponseSchema,
  WebSocketStartedSchema,
} from "@rimelabs/api";
import { RimeV1TTSService } from "../src/tts_v1.ts";

// Tests reach into protected members.
type Any = any;

type Reply = (request: Request) => Response_[];

function _started(request: Request): Response_ {
  return create(WebSocketResponseSchema, {
    contextId: request.contextId,
    payload: { case: "started", value: create(WebSocketStartedSchema, { requestId: "request-1" }) },
  });
}

function _audio(request: Request, audio: Uint8Array): Response_ {
  return create(WebSocketResponseSchema, {
    contextId: request.contextId,
    payload: { case: "audio", value: audio },
  });
}

function _done(request: Request): Response_ {
  return create(WebSocketResponseSchema, {
    contextId: request.contextId,
    payload: { case: "done", value: create(WebSocketDoneSchema) },
  });
}

function _error(request: Request, kind: string): Response_ {
  return create(WebSocketResponseSchema, {
    contextId: request.contextId,
    payload: {
      case: "error",
      value: create(WebSocketErrorSchema, { kind, message: "rejected" }),
    },
  });
}

function _cancelled(request: Request): Response_ {
  return create(WebSocketResponseSchema, {
    contextId: request.contextId,
    payload: { case: "cancelled", value: create(WebSocketCancelledSchema) },
  });
}

function _readyResponse(): Response_ {
  return create(WebSocketResponseSchema, {
    payload: { case: "ready", value: create(WebSocketReadySchema, { protocol: 1 }) },
  });
}

/** loguru `logger.add(sink, level="WARNING")` for the duration of `fn`. */
async function withWarningLog<T>(fn: (messages: string[]) => Promise<T> | T): Promise<T> {
  const messages: string[] = [];
  const remove = logger.addSink((record) => {
    if (LOG_LEVELS[record.level] >= LOG_LEVELS.WARNING) messages.push(record.message);
  });
  try {
    return await fn(messages);
  } finally {
    remove();
  }
}

/** Reply like Rime: started on start, audio per text, done on end. */
function _speakingReply(audio: Uint8Array = new Uint8Array([1, 2])): Reply {
  return (request) => {
    const payload = request.payload.case;
    if (payload === "start") return [_started(request)];
    if (payload === "text") return [_audio(request, audio)];
    if (payload === "end") return [_done(request)];
    return [];
  };
}

interface ServerOptions {
  ready?: Response_;
  /** Called with each request (and the connection number) after the replies are sent. */
  after?: (request: Request, connection: number, ws: { close(): void }) => void;
}

/** Serve Rime v1 locally; returns the base URL and the requests it receives. */
function _rimeServer(reply: Reply, options: ServerOptions = {}) {
  const requests: Request[] = [];
  const ready = options.ready ?? _readyResponse();
  let connections = 0;

  type Data = { binary: boolean; connection: number };
  const server = Bun.serve<Data>({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req, srv) {
      const offered = (req.headers.get("sec-websocket-protocol") ?? "")
        .split(",")
        .map((s) => s.trim());
      const chosen = offered.find((p) => p === "rime.v1.binary" || p === "rime.v1.json");
      const ok = srv.upgrade(req, {
        data: { binary: chosen === "rime.v1.binary", connection: ++connections },
        headers: chosen ? { "Sec-WebSocket-Protocol": chosen } : {},
      });
      return ok ? undefined : new Response("upgrade required", { status: 426 });
    },
    websocket: {
      open(ws) {
        ws.send(encode(ws.data.binary, ready));
      },
      message(ws, message) {
        const request = ws.data.binary
          ? fromBinary(WebSocketRequestSchema, new Uint8Array(message as Buffer))
          : fromJsonString(WebSocketRequestSchema, message as string);
        requests.push(request);
        for (const response of reply(request)) {
          ws.send(encode(ws.data.binary, response));
        }
        options.after?.(request, ws.data.connection, ws);
      },
    },
  });

  function encode(binary: boolean, response: Response_): string | Uint8Array {
    if (binary) return toBinary(WebSocketResponseSchema, response);
    return JSON.stringify(toJson(WebSocketResponseSchema, response));
  }

  return {
    url: `ws://127.0.0.1:${server.port}`,
    requests,
    connections: () => connections,
    stop: () => server.stop(true),
  };
}

const _payloads = (requests: Request[]) => requests.map((r) => r.payload.case ?? null);
const _texts = (frames: unknown[]) =>
  frames.filter((f): f is TTSTextFrame => f instanceof TTSTextFrame).map((f) => f.text);
const _audioBytes = (frames: unknown[]): number[] =>
  frames
    .filter((f): f is TTSAudioRawFrame => f instanceof TTSAudioRawFrame)
    .flatMap((f) => Array.from(f.audio));

function _service(
  extra: Record<string, unknown> = {},
  settings: Record<string, unknown> = { model: "coda" },
): Any {
  return new RimeV1TTSService({
    apiKey: "key",
    settings: new RimeV1TTSService.Settings(settings),
    ...extra,
  });
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

describe("TestConfiguration", () => {
  test("test_coda_uses_binary_and_public_endpoint", () => {
    const service = _service();

    expect(service._websocketUrl).toBe("wss://coda.api.rime.ai/ws");
    expect(service._websocketProtocol).toBe("binary");
    expect(service._settings.model).toBe("coda");
    expect(service._textAggregationMode).toBe(TextAggregationMode.SENTENCE);
  });

  for (const [model, url] of [
    ["coda", "wss://coda.api.rime.ai/ws"],
    ["mistv3", "wss://mist.api.rime.ai/ws"],
  ] as const) {
    test(`test_model_selects_the_public_endpoint[${model}]`, () => {
      const service = _service({}, { model });
      expect(service._websocketUrl).toBe(url);
      expect(service._settings.model).toBe(model);
    });
  }

  for (const url of [
    "wss://coda.api.rime.ai/ws",
    "wss://mist.api.rime.ai/ws",
    "wss://voice.customer.example/custom/stream?deployment=test",
    "wss://api.rime.ai/coda/ws",
    "wss://api.rime.ai/mist/ws",
  ]) {
    test(`test_custom_endpoint_uses_the_explicit_model[${url}]`, () => {
      const service = _service({ websocketUrl: url }, { model: "custom-model" });
      expect(service._websocketUrl).toBe(url);
      expect(service._settings.model).toBe("custom-model");
      expect(service._endpointModel).toBe("custom-model");
    });
  }

  test("test_custom_model_requires_an_endpoint", () => {
    expect(() => _service({}, { model: "custom-model" })).toThrow(/websocketUrl is required/);
  });

  const urls: (string | null)[] = [
    null,
    "wss://coda.api.rime.ai/ws",
    "wss://mist.api.rime.ai/ws",
    "wss://voice.customer.example/custom/stream",
    "wss://api.rime.ai/coda/ws",
    "wss://api.rime.ai/mist/ws",
  ];
  const settingsCases: [string, Record<string, unknown> | null][] = [
    ["None", null],
    ["Settings()", {}],
    ["model=None", { model: null }],
    ["model=''", { model: "" }],
  ];
  for (const url of urls) {
    for (const [label, settings] of settingsCases) {
      test(`test_every_endpoint_requires_an_explicit_model[${settings === null ? "None" : label}-${url}]`, () => {
        expect(
          () =>
            new RimeV1TTSService({
              apiKey: "key",
              websocketUrl: url,
              settings: settings === null ? null : new RimeV1TTSService.Settings(settings),
            }),
        ).toThrow(/requires settings\.model/);
      });
    }
  }

  test("test_service_rejects_invalid_configuration", () => {
    expect(() => _service({ websocketProtocol: "xml" })).toThrow(/binary/);
  });

  for (const url of ["https://coda.api.rime.ai/ws", "/ws", "wss:///ws"]) {
    test(`test_service_rejects_non_websocket_urls[${url}]`, () => {
      expect(() => _service({ websocketUrl: url })).toThrow(/absolute ws or wss URL/);
    });
  }

  const ignoredCases: [string, Record<string, unknown>, string][] = [
    [
      "wss://mist.api.rime.ai/ws",
      { model: "mistv3", textLookaheadTokens: 4 },
      "textLookaheadTokens",
    ],
    [
      "wss://voice.customer.example/ws",
      { model: "arcana", textLookaheadTokens: 4 },
      "textLookaheadTokens",
    ],
    [
      "wss://coda.api.rime.ai/ws",
      { model: "coda", pauseBetweenBrackets: true },
      "pauseBetweenBrackets",
    ],
    ["wss://coda.api.rime.ai/ws", { model: "coda", saveOovs: false }, "saveOovs"],
    ["wss://customer.rime.ai/ws", { model: "mistv2", timeScaleFactor: 1.2 }, "timeScaleFactor"],
  ];
  for (const [url, settings, ignored] of ignoredCases) {
    test(`test_settings_the_model_does_not_accept_are_left_out_with_a_warning[${ignored}-${settings.model}]`, async () => {
      await withWarningLog((warningLog) => {
        const service = _service({ websocketUrl: url }, settings);
        service._sampleRate = 24000;

        const start = service._buildStartRequest("turn").payload.value;
        expect(start.codaParameters?.textLookaheadTokens).toBeUndefined();
        expect(start.mistParameters).toBeUndefined();
        expect(start.audioParameters.timeScaleFactor).toBeUndefined();
        expect(service._settings[ignored]).toBe(settings[ignored]);
        expect(warningLog.some((message) => message.includes(ignored))).toBe(true);
      });
    });
  }

  test("test_unknown_settings_are_ignored", () => {
    const service = new RimeV1TTSService({
      apiKey: "key",
      settings: RimeV1TTSService.Settings.fromMapping({ model: "coda", repetition_penalty: 1.1 }),
    }) as Any;
    service._sampleRate = 24000;

    // An unset optional string reads "" in Python and undefined here.
    expect(service._buildStartRequest("turn").payload.value.speaker ?? "").toBe("");
  });

  test("test_coda_settings_map_to_the_start_request", () => {
    const service = _service(
      { sampleRate: 22050 },
      {
        model: "coda",
        voice: "astra",
        language: Language.EN,
        textLookaheadTokens: 0,
        timeScaleFactor: 1.2,
      },
    );
    service._sampleRate = 22050;

    const start = service._buildStartRequest("turn").payload.value;
    expect(start.speaker).toBe("astra");
    expect(start.language).toBe("en");
    expect(start.audioParameters.audioFormat).toBe("audio/pcm");
    expect(start.audioParameters.samplingRate).toBe(22050);
    expect(start.audioParameters.timeScaleFactor).toBeCloseTo(1.2, 5);
    expect(start.codaParameters.textLookaheadTokens).toBe(0);
    expect(start.mistParameters).toBeUndefined();
  });

  test("test_token_mode_asks_rime_to_accumulate_sentences", () => {
    const sentences = _service();
    sentences._sampleRate = 24000;
    expect(sentences._buildStartRequest("turn").payload.value.splitStrategy).toBeUndefined();

    const tokens = _service({ textAggregationMode: TextAggregationMode.TOKEN });
    tokens._sampleRate = 24000;
    const start = tokens._buildStartRequest("turn").payload.value;
    expect(start.splitStrategy).toBe(SplitStrategy.ACCUMULATE_SENTENCE);
  });

  test("test_languages_map_to_bcp47_tags", async () => {
    const service = _service({}, { model: "coda", language: "ja-JP" });
    service._sampleRate = 24000;
    expect(service._buildStartRequest("turn").payload.value.language).toBe("ja");

    await service._updateSettings(new RimeV1TTSService.Settings({ language: Language.DE_DE }));
    expect(service._buildStartRequest("turn").payload.value.language).toBe("de");
  });

  test("test_mist_settings_map_to_the_start_request", () => {
    const service = _service(
      { websocketUrl: "wss://mist.api.rime.ai/ws" },
      { model: "mistv3", pauseBetweenBrackets: true, saveOovs: false },
    );
    service._sampleRate = 24000;

    const start = service._buildStartRequest("turn").payload.value;
    expect(start.mistParameters.pauseBetweenBrackets).toBe(true);
    expect(start.mistParameters.saveOovs).toBe(false);
    expect(start.codaParameters).toBeUndefined();
  });

  test("test_runtime_settings_apply_to_the_next_context", async () => {
    await withWarningLog(async (warningLog) => {
      const service = _service({}, { model: "coda", voice: "old" });
      service._sampleRate = 24000;

      const changed = await service._updateSettings(
        new RimeV1TTSService.Settings({ voice: "new" }),
      );
      expect(changed).toEqual({ voice: "old" });
      expect(service._buildStartRequest("turn").payload.value.speaker).toBe("new");
      expect(warningLog).toEqual([]);

      // The endpoint serves one model, so a model change is reported, not applied.
      await service._updateSettings(new RimeV1TTSService.Settings({ model: "mistv3" }));
      const start = service._buildStartRequest("turn").payload.value;
      expect(start.mistParameters).toBeUndefined();
      expect(warningLog.some((message) => message.includes("mistv3 is not applied"))).toBe(true);

      const mist = _service({ websocketUrl: "wss://mist.api.rime.ai/ws" }, { model: "mistv3" });
      mist._sampleRate = 24000;
      await mist._updateSettings(new RimeV1TTSService.Settings({ textLookaheadTokens: 4 }));
      expect(mist._buildStartRequest("turn").payload.value.codaParameters).toBeUndefined();
      expect(warningLog.some((message) => message.includes("textLookaheadTokens"))).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// Wire format
// ---------------------------------------------------------------------------

// Fixed envelopes for each message the service sends or reads. The local server
// below shares the installed `@rimelabs/api` schema with the service, so only
// these catch a schema release that renumbers or renames a field.
const _REQUEST_ENVELOPES: [Record<string, any>, string][] = [
  [
    {
      contextId: "ctx",
      start: {
        language: "en",
        speaker: "luna",
        text: "Hello.",
        audioParameters: {
          audioFormat: "audio/pcm",
          samplingRate: 24000,
          timeScaleFactor: 1.25,
        },
        splitStrategy: "SPLIT_STRATEGY_NONE",
        codaParameters: { textLookaheadTokens: 0 },
      },
    },
    "0a036374781a2e1202656e1a046c756e61220648656c6c6f2e2a140a09617564696f2f70636d" +
      "10c0bb011d0000a03f300242024000",
  ],
  [{ contextId: "ctx", text: "Hello." }, "0a03637478220648656c6c6f2e"],
  [{ contextId: "ctx", end: {} }, "0a036374782a00"],
  [{ contextId: "ctx", cancel: {} }, "0a036374783200"],
];
const _RESPONSE_ENVELOPES: [Record<string, any>, string][] = [
  [
    { ready: { protocol: 1, languages: ["en", "es"], defaultLanguage: "en" } },
    "120e08011202656e120265731a02656e",
  ],
  [{ contextId: "ctx", started: { requestId: "req" } }, "0a036374781a050a03726571"],
  [{ contextId: "ctx", audio: "AAH+/w==" }, "0a0363747822040001feff"],
  [{ contextId: "ctx", done: {} }, "0a036374782a00"],
  [{ contextId: "ctx", cancelled: {} }, "0a036374783200"],
  [
    {
      contextId: "ctx",
      error: { kind: "invalid_input", message: "test error", requestId: "req" },
    },
    "0a036374783a200a0d696e76616c69645f696e707574120a74657374206572726f721a03726571",
  ],
];

function fromHex(hex: string): Uint8Array {
  return new Uint8Array(hex.match(/../g)!.map((b) => Number.parseInt(b, 16)));
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

describe("TestWireFormat", () => {
  _REQUEST_ENVELOPES.forEach(([envelope, binary], i) => {
    test(`test_requests_match_fixed_wire_envelopes[${i}]`, () => {
      const request = fromJson(WebSocketRequestSchema, envelope as any);

      const binaryService = _service();
      expect(toHex(binaryService._encode(request))).toBe(binary);
      const jsonService = _service({ websocketProtocol: "json" });
      expect(JSON.parse(jsonService._encode(request))).toEqual(envelope);
    });
  });

  _RESPONSE_ENVELOPES.forEach(([envelope, binary], i) => {
    test(`test_responses_match_fixed_wire_envelopes[${i}]`, () => {
      const fromBin = _service()._decode(fromHex(binary));
      const fromJsonResponse = _service({ websocketProtocol: "json" })._decode(
        JSON.stringify(envelope),
      );

      expect(toJson(WebSocketResponseSchema, fromBin)).toEqual(envelope as any);
      expect(toJson(WebSocketResponseSchema, fromJsonResponse)).toEqual(envelope as any);
    });
  });
});

// ---------------------------------------------------------------------------
// Synthesis against a local Rime v1 server
// ---------------------------------------------------------------------------

describe("TestSynthesis", () => {
  for (const protocol of ["binary", "json"] as const) {
    test(`test_round_trip_streams_one_context_per_turn[${protocol}]`, async () => {
      const server = _rimeServer(_speakingReply(new Uint8Array([1, 2, 3, 4])));
      let downFrames: any[];
      let upFrames: any[];
      try {
        const service = _service({
          apiKey: "test-key",
          websocketUrl: `${server.url}/custom/stream`,
          websocketProtocol: protocol,
          sampleRate: 24000,
        });
        [downFrames, upFrames] = await runTest(service, {
          framesToSend: [
            new TTSSpeakFrame({ text: "Hello from Pipecat. This is a second sentence." }),
            new SleepFrame({ sleep: 0.2 }),
            new BotStoppedSpeakingFrame(),
          ],
          startTimeout: 3.0,
        });
      } finally {
        server.stop();
      }

      expect(_payloads(server.requests)).toEqual(["start", "text", "text", "end"]);
      expect(new Set(server.requests.map((r) => r.contextId)).size).toBe(1);
      expect((server.requests[0]!.payload.value as any).audioParameters.samplingRate).toBe(24000);
      expect(server.requests.slice(1, 3).map((r) => r.payload.value)).toEqual([
        "Hello from Pipecat. ",
        "This is a second sentence. ",
      ]);
      expect([...downFrames, ...upFrames].some((f) => f instanceof ErrorFrame)).toBe(false);
      expect(_audioBytes(downFrames)).toEqual([1, 2, 3, 4, 1, 2, 3, 4]);

      const types = downFrames.map((f) => f.constructor);
      expect(types.indexOf(TTSStartedFrame)).toBeLessThan(types.indexOf(TTSAudioRawFrame));
      expect(types.indexOf(TTSAudioRawFrame)).toBeLessThan(types.indexOf(TTSStoppedFrame));
      expect(types.indexOf(TTSTextFrame)).toBeLessThan(types.indexOf(TTSStoppedFrame));
    });
  }

  test("test_token_mode_streams_tokens_and_keeps_spell_tags_whole", async () => {
    const server = _rimeServer(_speakingReply());
    let downFrames: any[];
    let upFrames: any[];
    try {
      const service = _service({
        websocketUrl: `${server.url}/custom/stream`,
        textAggregationMode: TextAggregationMode.TOKEN,
      });
      [downFrames, upFrames] = await runTest(service, {
        framesToSend: [
          new LLMFullResponseStartFrame(),
          ...["Say ", "spe", "ll(A", "B) ", "now", "."].map(
            (token) => new LLMTextFrame({ text: token }),
          ),
          new LLMFullResponseEndFrame(),
          new SleepFrame({ sleep: 0.2 }),
        ],
        startTimeout: 3.0,
      });
    } finally {
      server.stop();
    }

    expect(_payloads(server.requests)).toEqual(["start", "text", "text", "text", "text", "end"]);
    expect((server.requests[0]!.payload.value as any).splitStrategy).toBe(
      SplitStrategy.ACCUMULATE_SENTENCE,
    );
    expect(server.requests.slice(1, 5).map((r) => r.payload.value)).toEqual([
      "Say ",
      "spell(AB) ",
      "now",
      ".",
    ]);
    expect([...downFrames, ...upFrames].some((f) => f instanceof ErrorFrame)).toBe(false);
    expect(downFrames.filter((f) => f instanceof TTSStoppedFrame).length).toBe(1);
  });

  test("test_interruption_cancels_the_context_and_drops_late_audio", async () => {
    const reply: Reply = (request) => {
      const payload = request.payload.case;
      if (payload === "start") return [_started(request)];
      if (payload === "text") return [_audio(request, new Uint8Array([1, 2]))];
      if (payload === "cancel") {
        return [_audio(request, new Uint8Array([3, 4])), _cancelled(request)];
      }
      return [];
    };

    const server = _rimeServer(reply);
    let downFrames: any[];
    let upFrames: any[];
    try {
      const service = _service({ websocketUrl: `${server.url}/custom/stream` });
      [downFrames, upFrames] = await runTest(service, {
        framesToSend: [
          new TTSSpeakFrame({ text: "Stop me." }),
          new SleepFrame({ sleep: 0.05 }),
          new InterruptionFrame(),
          new SleepFrame({ sleep: 0.1 }),
        ],
        startTimeout: 3.0,
      });
    } finally {
      server.stop();
    }

    expect(_payloads(server.requests)).toEqual(["start", "text", "end", "cancel"]);
    expect([...downFrames, ...upFrames].some((f) => f instanceof ErrorFrame)).toBe(false);
    expect(_audioBytes(downFrames)).toEqual([1, 2]);
  });

  test("test_context_error_reports_and_skips_the_rest_of_the_turn", async () => {
    const reply: Reply = (request) => {
      const payload = request.payload.case;
      if (payload === "start") return [_started(request)];
      if (payload === "text") return [_error(request, "internal")];
      return [];
    };

    const failedTurn = (first: string, second: string) => [
      new LLMFullResponseStartFrame(),
      new AggregatedTextFrame({ text: first, textType: TextType.SENTENCE }),
      new SleepFrame({ sleep: 0.1 }),
      new AggregatedTextFrame({ text: second, textType: TextType.SENTENCE }),
      new LLMFullResponseEndFrame(),
      new SleepFrame({ sleep: 0.1 }),
    ];

    const server = _rimeServer(reply);
    let downFrames: any[];
    let upFrames: any[];
    let service: Any;
    let elapsed: number;
    try {
      service = _service({ websocketUrl: `${server.url}/custom/stream` });
      const startedAt = performance.now();
      [downFrames, upFrames] = await runTest(service, {
        framesToSend: [
          ...failedTurn("First one.", "First two."),
          ...failedTurn("Second one.", "Second two."),
        ],
        startTimeout: 3.0,
      });
      elapsed = (performance.now() - startedAt) / 1000;
    } finally {
      server.stop();
    }

    // Each turn's later sentence is skipped after Rime fails its context.
    expect(_payloads(server.requests)).toEqual(["start", "text", "start", "text"]);
    const rimeErrors = upFrames.filter(
      (f) => f instanceof ErrorFrame && f.error.includes("internal"),
    );
    expect(rimeErrors.length).toBe(2);
    expect(rimeErrors[0].category).toBe(ErrorCategory.SERVER);
    expect(downFrames.some((f) => f instanceof TTSAudioRawFrame)).toBe(false);
    // The failed context stays open for the rest of its turn instead of being
    // reopened empty, so each turn ends promptly with one started/stopped pair.
    expect(downFrames.filter((f) => f instanceof TTSStartedFrame).length).toBe(2);
    expect(downFrames.filter((f) => f instanceof TTSStoppedFrame).length).toBe(2);
    expect(elapsed).toBeLessThan(2.0);
    expect(_texts(downFrames)).toEqual(["First one.", "First two.", "Second one.", "Second two."]);
    expect(service.isUsable).toBe(true);
  });

  test("test_permanent_context_error_leaves_the_service_usable", async () => {
    const reply: Reply = (request) =>
      request.payload.case === "start" ? [_error(request, "invalid_input")] : [];

    const server = _rimeServer(reply);
    let downFrames: any[];
    let upFrames: any[];
    let service: Any;
    try {
      service = _service({ websocketUrl: `${server.url}/custom/stream` });
      [downFrames, upFrames] = await runTest(service, {
        framesToSend: [
          new TTSSpeakFrame({ text: "Rejected text." }),
          new SleepFrame({ sleep: 0.1 }),
        ],
        startTimeout: 3.0,
      });
    } finally {
      server.stop();
    }

    const errors = upFrames.filter((f) => f instanceof ErrorFrame);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].category).toBe(ErrorCategory.UNKNOWN);
    expect(_texts(downFrames)).toEqual(["Rejected text."]);
    expect(service.isUsable).toBe(true);
  });

  test("test_done_without_audio_ends_the_context", async () => {
    const reply: Reply = (request) => {
      const payload = request.payload.case;
      if (payload === "start") return [_started(request)];
      if (payload === "end") return [_done(request)];
      return [];
    };

    const server = _rimeServer(reply);
    let downFrames: any[];
    try {
      const service = _service({ websocketUrl: `${server.url}/custom/stream` });
      [downFrames] = await runTest(service, {
        framesToSend: [
          new TTSSpeakFrame({ text: "This audio is empty." }),
          new SleepFrame({ sleep: 0.1 }),
        ],
        startTimeout: 3.0,
      });
    } finally {
      server.stop();
    }

    expect(downFrames.some((f) => f instanceof TTSAudioRawFrame)).toBe(false);
    expect(downFrames.some((f) => f instanceof TTSStoppedFrame)).toBe(true);
    expect(_texts(downFrames)).toEqual(["This audio is empty."]);
  });

  test("test_odd_length_audio_is_padded_without_an_error", async () => {
    const reply: Reply = (request) => {
      const payload = request.payload.case;
      if (payload === "start") return [_started(request)];
      if (payload === "text") {
        return [
          _audio(request, new Uint8Array([1, 2, 3])),
          _audio(request, new Uint8Array([4, 5])),
        ];
      }
      if (payload === "end") return [_done(request)];
      return [];
    };

    const server = _rimeServer(reply);
    let downFrames: any[];
    let upFrames: any[];
    try {
      const service = _service({ websocketUrl: `${server.url}/custom/stream` });
      [downFrames, upFrames] = await runTest(service, {
        framesToSend: [
          new TTSSpeakFrame({ text: "Odd audio." }),
          new SleepFrame({ sleep: 0.2 }),
          new BotStoppedSpeakingFrame(),
        ],
        startTimeout: 3.0,
      });
    } finally {
      server.stop();
    }

    expect([...downFrames, ...upFrames].some((f) => f instanceof ErrorFrame)).toBe(false);
    expect(_audioBytes(downFrames)).toEqual([1, 2, 3, 4, 5, 0]);
  });

  test("test_ready_error_is_reported_with_its_category", async () => {
    const ready = create(WebSocketResponseSchema, {
      payload: {
        case: "error",
        value: create(WebSocketErrorSchema, { kind: "unauthenticated", message: "bad key" }),
      },
    });
    const server = _rimeServer(_speakingReply(), { ready });
    let upFrames: any[];
    try {
      const service = _service({ apiKey: "bad", websocketUrl: `${server.url}/custom/stream` });
      [, upFrames] = await runTest(service, {
        framesToSend: [new SleepFrame({ sleep: 0.05 })],
        startTimeout: 3.0,
      });
    } finally {
      server.stop();
    }

    const errors = upFrames.filter((f) => f instanceof ErrorFrame);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].error).toContain("unauthenticated");
    expect(errors[0].category).toBe(ErrorCategory.AUTHENTICATION);
    expect(server.requests).toEqual([]);
  });

  test("test_next_turn_reconnects_after_rime_closes_the_socket", async () => {
    const server = _rimeServer(_speakingReply(), {
      after(request, connection, ws) {
        if (request.payload.case === "end" && connection === 1) ws.close();
      },
    });
    let downFrames: any[];
    try {
      const service = _service({ websocketUrl: `${server.url}/custom/stream` });
      [downFrames] = await runTest(service, {
        framesToSend: [
          new TTSSpeakFrame({ text: "First turn." }),
          new SleepFrame({ sleep: 0.2 }),
          new BotStoppedSpeakingFrame(),
          new TTSSpeakFrame({ text: "Second turn." }),
          new SleepFrame({ sleep: 0.2 }),
          new BotStoppedSpeakingFrame(),
        ],
        startTimeout: 3.0,
      });
    } finally {
      server.stop();
    }

    expect(server.connections()).toBe(2);
    expect(_audioBytes(downFrames)).toEqual([1, 2, 1, 2]);
    expect(_texts(downFrames)).toEqual(["First turn.", "Second turn."]);
  });
});

// Keep the schema import used (the audio parameters message backs `_buildStartRequest`).
void AudioParametersSchema;
