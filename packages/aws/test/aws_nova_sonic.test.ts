// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

// Mock tests for Nova Sonic: the WebSocket bidirectional stream (presign and
// event-signing vectors checked against the AWS SDK's own signer), the
// adapter, the service end to end against a fake stream, and the session
// continuation helper.

import { describe, expect, test } from "bun:test";
import { Queue } from "@pipedog/asyncio";
import { FunctionSchema } from "@pipedog/core/adapters/schemas/function_schema";
import { ToolsSchema } from "@pipedog/core/adapters/schemas/tools_schema";
import {
  AggregatedTextFrame,
  type Frame,
  InputAudioRawFrame,
  LLMContextFrame,
  LLMFullResponseEndFrame,
  LLMFullResponseStartFrame,
  LLMTextFrame,
  TranscriptionFrame,
  TTSAudioRawFrame,
  TTSStartedFrame,
  TTSStoppedFrame,
  TTSTextFrame,
} from "@pipedog/core/frames/frames";
import { LLMContext } from "@pipedog/core/processors/aggregators/llm_context";
import type { FunctionCallParams } from "@pipedog/core/services/llm_service";
import { runTest, SleepFrame } from "@pipedog/core/tests/utils";
import { bytesToBase64 } from "@pipedog/core/utils/base64";
import { AWSNovaSonicLLMAdapter, Role } from "../src/aws_nova_sonic_adapter.ts";
import { AWSSession } from "../src/aws_session.ts";
import {
  type BidirectionalStream,
  BidirectionalStreamError,
  decodeChunkEvent,
  EventStreamMessageSigner,
  encodeChunkEvent,
  openBedrockWebSocketStream,
  presignUrl,
} from "../src/bidirectional_stream.ts";
import { decodeEventStreamMessage, encodeEventStreamMessage } from "../src/event_stream.ts";
import {
  AWSNovaSonicLLMService,
  AWSNovaSonicLLMSettings,
  type NovaSonicStreamClient,
} from "../src/nova_sonic/llm.ts";
import {
  type NovaSonicSessionSender,
  SessionContinuationHelper,
  SessionContinuationParams,
} from "../src/nova_sonic/session_continuation.ts";
import { resolveCredentials } from "../src/utils.ts";

type Dict = Record<string, any>;
const enc = new TextEncoder();
const dec = new TextDecoder();
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

const CREDS = { accessKeyId: "AKID", secretAccessKey: "SECRET", sessionToken: "TOK/+=" };
const DATE = new Date("2026-01-02T03:04:05.678Z");

describe("bidirectional stream (WebSocket)", () => {
  // Expected values produced by @smithy/signature-v4 (presign, signMessage) and
  // the event signing stream of @aws-sdk/middleware-websocket with the same
  // inputs.
  const URL_ =
    "wss://bedrock-runtime.us-east-1.amazonaws.com/model/amazon.nova-sonic-v1%3A0/invoke-with-bidirectional-stream-websocket?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKID%2F20260102%2Fus-east-1%2Fbedrock%2Faws4_request&X-Amz-Date=20260102T030405Z&X-Amz-Expires=60&X-Amz-Security-Token=TOK%2F%2B%3D&X-Amz-SignedHeaders=host&X-Amz-Signature=0d96ef626d470753c5455dcd10340509e992d4464d6cc1b4d308857aaa3cf910";
  const ENVELOPE_1 =
    "000000c600000043eca2d238053a64617465080000019b7ca98f2e103a6368756e6b2d7369676e6174757265060020b1d671a2f3868a749ee2bdd2743f8e4202b5cd7dca382e072425d332c143785b000000730000004b3a5edd6e0b3a6576656e742d747970650700056368756e6b0d3a6d6573736167652d747970650700056576656e740d3a636f6e74656e742d747970650700106170706c69636174696f6e2f6a736f6e7b226279746573223a2265794a68496a6f7866513d3d227d0fc8260a5a3eeaed";
  const ENVELOPE_END =
    "0000005300000043f5447a58053a64617465080000019b7ca98f2e103a6368756e6b2d7369676e61747572650600205072d0e13aa01aaea878c670a9f8b3fa83ca92642ad4484d56164192b270d1e421b0739e";

  test("presigned URL matches the AWS SDK", async () => {
    const { url, signature } = await presignUrl({
      url: "wss://bedrock-runtime.us-east-1.amazonaws.com/model/amazon.nova-sonic-v1%3A0/invoke-with-bidirectional-stream-websocket",
      service: "bedrock",
      region: "us-east-1",
      credentials: CREDS,
      expiresIn: 60,
      date: DATE,
    });
    expect(url).toBe(URL_);
    expect(signature).toBe("0d96ef626d470753c5455dcd10340509e992d4464d6cc1b4d308857aaa3cf910");
  });

  test("signed envelopes match the AWS SDK and chain", async () => {
    const signer = new EventStreamMessageSigner({
      seedSignature: "0d96ef626d470753c5455dcd10340509e992d4464d6cc1b4d308857aaa3cf910",
      credentials: CREDS,
      region: "us-east-1",
      service: "bedrock",
    });
    const first = await signer.sign(encodeChunkEvent(enc.encode('{"a":1}')), DATE);
    expect(hex(first)).toBe(ENVELOPE_1);
    expect(signer.priorSignature).toBe(
      "b1d671a2f3868a749ee2bdd2743f8e4202b5cd7dca382e072425d332c143785b",
    );
    const end = await signer.sign(new Uint8Array(0), DATE);
    expect(hex(end)).toBe(ENVELOPE_END);
  });

  test("decodeChunkEvent returns payloads and raises exceptions", () => {
    const chunk = encodeChunkEvent(enc.encode('{"event":{}}'));
    expect(dec.decode(decodeChunkEvent(chunk) as Uint8Array)).toBe('{"event":{}}');
    const exception = encodeEventStreamMessage({
      headers: {
        ":message-type": "exception",
        ":exception-type": "validationException",
        ":content-type": "application/json",
      },
      body: enc.encode('{"message":"bad input"}'),
    });
    expect(() => decodeChunkEvent(exception)).toThrow(BidirectionalStreamError);
    expect(() => decodeChunkEvent(exception)).toThrow("validationException: bad input");
  });

  test("openBedrockWebSocketStream sends signed chunks and receives payloads", async () => {
    const sent: Uint8Array[] = [];
    let opened: string | null = null;
    class FakeWebSocket extends EventTarget {
      readyState = 0;
      binaryType = "blob";
      url: string;
      constructor(url: string) {
        super();
        this.url = url;
        opened = url;
        setTimeout(() => {
          this.readyState = 1;
          this.dispatchEvent(new Event("open"));
        }, 1);
      }
      send(data: Uint8Array) {
        sent.push(new Uint8Array(data));
        if (sent.length === 1) {
          const reply = encodeChunkEvent(enc.encode('{"event":{"completionStart":{}}}'));
          setTimeout(() => {
            const ev = new MessageEvent("message", { data: reply.buffer });
            this.dispatchEvent(ev);
          }, 1);
        }
      }
      close(code = 1000) {
        this.readyState = 3;
        const ev = new Event("close") as Event & { code: number; reason: string };
        Object.assign(ev, { code, reason: "" });
        this.dispatchEvent(ev);
      }
    }
    const session = new AWSSession({
      credentials: resolveCredentials({
        awsAccessKeyId: "AKID",
        awsSecretAccessKey: "SECRET",
        region: "eu-north-1",
      }),
    });
    const stream = await openBedrockWebSocketStream({
      session,
      modelId: "amazon.nova-2-5-sonic",
      webSocketFactory: (uri) => new FakeWebSocket(uri) as unknown as WebSocket,
    });
    expect(opened).toStartWith(
      "wss://bedrock-runtime.eu-north-1.amazonaws.com/model/amazon.nova-2-5-sonic/invoke-with-bidirectional-stream-websocket?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKID%2F",
    );
    await stream.send(enc.encode('{"event":{"sessionStart":{}}}'));
    const payload = await stream.receive();
    expect(dec.decode(payload as Uint8Array)).toBe('{"event":{"completionStart":{}}}');
    await stream.close();
    expect(sent.length).toBe(2);
    const outer = decodeEventStreamMessage(sent[0] as Uint8Array);
    expect(Object.keys(outer.headers).sort()).toEqual([":chunk-signature", ":date"]);
    const inner = decodeEventStreamMessage(outer.body);
    expect(JSON.parse(dec.decode(inner.body))).toEqual({
      bytes: bytesToBase64(enc.encode('{"event":{"sessionStart":{}}}')),
    });
    // The last envelope (end of input) carries no body.
    expect(decodeEventStreamMessage(sent[1] as Uint8Array).body.length).toBe(0);
    expect(await stream.receive()).toBeNull();
  });
});

describe("AWSNovaSonicLLMAdapter", () => {
  test("tools are converted to toolSpec with a JSON schema string", () => {
    const adapter = new AWSNovaSonicLLMAdapter();
    const tools = new ToolsSchema({
      standardTools: [
        new FunctionSchema({
          name: "get_weather",
          description: "Get the weather",
          properties: { location: { type: "string" } },
          required: ["location"],
        }),
      ],
    });
    expect(adapter.toProviderToolsFormat(tools)).toEqual([
      {
        toolSpec: {
          name: "get_weather",
          description: "Get the weather",
          inputSchema: {
            json: '{"type": "object", "properties": {"location": {"type": "string"}}, "required": ["location"]}',
          },
        },
      },
    ]);
  });

  test("messages become USER/ASSISTANT history; tool messages are dropped", async () => {
    const adapter = new AWSNovaSonicLLMAdapter();
    const context = new LLMContext({
      messages: [
        { role: "user", content: "Hi" },
        { role: "developer", content: "Be nice" },
        { role: "assistant", content: [{ type: "text", text: "Hello" }] },
        { role: "tool", tool_call_id: "x", content: "{}" },
      ] as never,
    });
    const params = await adapter.getLlmInvocationParams(context, { systemInstruction: "Sys" });
    expect(params.system_instruction).toBe("Sys");
    expect(params.messages.map((m) => [m.role, m.text])).toEqual([
      [Role.USER, "Hi"],
      [Role.USER, "Be nice"],
      [Role.ASSISTANT, "Hello"],
    ]);
    expect(params.tools).toEqual([]);
  });
});

/** A fake bidirectional stream: records what the service sends, plays scripted events back. */
class FakeStream implements BidirectionalStream {
  raw: string[] = [];
  sent: Dict[] = [];
  readonly queue = new Queue<Uint8Array | null>();
  onSend: ((event: Dict, stream: FakeStream) => void) | null = null;
  closed = false;

  async send(payload: Uint8Array): Promise<void> {
    const text = dec.decode(payload);
    this.raw.push(text);
    const event = JSON.parse(text) as Dict;
    this.sent.push(event);
    this.onSend?.(event, this);
  }

  async receive(): Promise<Uint8Array | null> {
    return await this.queue.get();
  }

  async closeInput(): Promise<void> {}

  async close(): Promise<void> {
    this.closed = true;
    this.queue.putNowait(null);
  }

  serve(event: Dict): void {
    this.queue.putNowait(enc.encode(JSON.stringify({ event })));
  }

  /** The event names sent, e.g. `contentStart:AUDIO`. */
  names(): string[] {
    return this.sent.map((e) => {
      const [name, body] = Object.entries(e.event as Dict)[0] as [string, Dict];
      return name === "contentStart" ? `${name}:${body.type}:${body.role}` : name;
    });
  }
}

function makeService(
  onSend: ((event: Dict, stream: FakeStream) => void) | null = null,
  options: { tools?: ToolsSchema } = {},
): { service: AWSNovaSonicLLMService; streams: FakeStream[] } {
  const streams: FakeStream[] = [];
  const client: NovaSonicStreamClient = {
    invokeModelWithBidirectionalStream: async () => {
      const stream = new FakeStream();
      stream.onSend = onSend;
      streams.push(stream);
      return stream;
    },
  };
  const service = new AWSNovaSonicLLMService({
    accessKeyId: "AKID",
    secretAccessKey: "SECRET",
    region: "us-east-1",
    settings: new AWSNovaSonicLLMSettings({ systemInstruction: "You are helpful." }),
    clientFactory: () => client,
    tools: options.tools ?? null,
  });
  return { service, streams };
}

function eventsOnAudioStart(events: Dict[]): (event: Dict, stream: FakeStream) => void {
  let served = false;
  return (event, stream) => {
    const start = event.event?.contentStart;
    if (!served && start?.type === "AUDIO") {
      served = true;
      for (const e of events) stream.serve(e);
    }
  };
}

describe("AWSNovaSonicLLMService", () => {
  test("session setup sends upstream's event sequence", async () => {
    const { service, streams } = makeService();
    const context = new LLMContext({ messages: [{ role: "user", content: "Hi there" }] as never });
    await runTest(service, { framesToSend: [new LLMContextFrame({ context }), new SleepFrame()] });

    const stream = streams[0] as FakeStream;
    expect(stream.names()).toEqual([
      "sessionStart",
      "promptStart",
      "contentStart:TEXT:SYSTEM",
      "textInput",
      "contentEnd",
      "contentStart:AUDIO:USER",
      "contentStart:TEXT:USER",
      "textInput",
      "contentEnd",
      "promptEnd",
      "sessionEnd",
    ]);
    expect(stream.raw[0]).toBe(`
        {
          "event": {
            "sessionStart": {
              "inferenceConfiguration": {
                "maxTokens": 1024,
                "topP": 0.9,
                "temperature": 0.7
              }
            }
          }
        }
        `);
    const promptStart = stream.sent[1]?.event.promptStart as Dict;
    expect(promptStart.audioOutputConfiguration).toEqual({
      mediaType: "audio/lpcm",
      sampleRateHertz: 24000,
      sampleSizeBits: 16,
      channelCount: 1,
      voiceId: "matthew",
      encoding: "base64",
      audioType: "SPEECH",
    });
    expect("toolConfiguration" in promptStart).toBe(false);
    expect(stream.sent[3]?.event.textInput.content).toBe("You are helpful.");
    expect(stream.sent[6]?.event.contentStart.interactive).toBe(true);
    expect(stream.sent[7]?.event.textInput.content).toBe("Hi there");
    expect(stream.closed).toBe(true);
  });

  test("tools go in promptStart", async () => {
    const tools = new ToolsSchema({
      standardTools: [
        new FunctionSchema({
          name: "get_weather",
          description: "Get the weather",
          properties: {},
          required: [],
        }),
      ],
    });
    const { service, streams } = makeService(null, { tools });
    const context = new LLMContext();
    await runTest(service, { framesToSend: [new LLMContextFrame({ context }), new SleepFrame()] });
    const promptStart = (streams[0] as FakeStream).sent[1]?.event.promptStart as Dict;
    expect(promptStart.toolUseOutputConfiguration).toEqual({ mediaType: "application/json" });
    expect(promptStart.toolConfiguration.tools[0].toolSpec.name).toBe("get_weather");
  });

  test("user audio goes in as audioInput events", async () => {
    const { service, streams } = makeService();
    const audio = Uint8Array.from({ length: 640 }, (_, i) => i & 0xff);
    await runTest(service, {
      framesToSend: [
        new LLMContextFrame({ context: new LLMContext() }),
        new SleepFrame({ sleep: 0.05 }),
        new InputAudioRawFrame({ audio, sampleRate: 16000, numChannels: 1 }),
        new SleepFrame({ sleep: 0.05 }),
      ],
    });
    const stream = streams[0] as FakeStream;
    const audioStart = stream.sent.find((e) => e.event.contentStart?.type === "AUDIO") as Dict;
    const audioInput = stream.sent.find((e) => e.event.audioInput) as Dict;
    expect(audioInput.event.audioInput).toEqual({
      promptName: audioStart.event.contentStart.promptName,
      contentName: audioStart.event.contentStart.contentName,
      content: bytesToBase64(audio),
    });
    expect(audioStart.event.contentStart.audioInputConfiguration.sampleRateHertz).toBe(16000);
  });

  test("assistant text and audio become frames; user text goes upstream", async () => {
    const pcm = Uint8Array.from({ length: 480 }, (_, i) => (i * 3) & 0xff);
    const speculative = JSON.stringify({ generationStage: "SPECULATIVE" });
    const final = JSON.stringify({ generationStage: "FINAL" });
    const { service } = makeService(
      eventsOnAudioStart([
        { contentStart: { type: "TEXT", role: "USER", additionalModelFields: final } },
        { textOutput: { content: "what's the weather" } },
        { contentEnd: { stopReason: "END_TURN" } },
        { completionStart: {} },
        { contentStart: { type: "TEXT", role: "ASSISTANT", additionalModelFields: speculative } },
        { textOutput: { content: "It is sunny." } },
        { contentEnd: { stopReason: "PARTIAL_TURN" } },
        { contentStart: { type: "AUDIO", role: "ASSISTANT" } },
        { audioOutput: { content: bytesToBase64(pcm) } },
        { contentEnd: { stopReason: "END_TURN" } },
        {
          usageEvent: {
            details: {
              delta: { input: { speechTokens: 3, textTokens: 2 }, output: { speechTokens: 4 } },
            },
          },
        },
        { completionEnd: {} },
      ]),
    );
    const [down, up] = await runTest(service, {
      framesToSend: [new LLMContextFrame({ context: new LLMContext() }), new SleepFrame()],
    });
    const types = down
      .map((f: Frame) => f.constructor)
      .filter((c) =>
        [
          LLMFullResponseStartFrame,
          TTSStartedFrame,
          LLMTextFrame,
          AggregatedTextFrame,
          TTSAudioRawFrame,
          TTSTextFrame,
          LLMFullResponseEndFrame,
          TTSStoppedFrame,
        ].includes(c as never),
      );
    expect(types).toEqual([
      LLMFullResponseStartFrame,
      TTSStartedFrame,
      LLMTextFrame,
      AggregatedTextFrame,
      TTSAudioRawFrame,
      TTSTextFrame,
      LLMFullResponseEndFrame,
      TTSStoppedFrame,
    ]);
    const audioFrame = down.find((f) => f instanceof TTSAudioRawFrame) as TTSAudioRawFrame;
    expect(audioFrame.audio).toEqual(pcm);
    expect(audioFrame.sampleRate).toBe(24000);
    const llmText = down.find((f) => f instanceof LLMTextFrame) as LLMTextFrame;
    expect(llmText.text).toBe("It is sunny.");
    expect(llmText.appendToContext).toBe(false);
    const transcription = up.find((f) => f instanceof TranscriptionFrame) as TranscriptionFrame;
    expect(transcription.text).toBe("what's the weather");
  });

  test("tool use runs the function and sends its result", async () => {
    const toolUseContent = JSON.stringify({ location: "Barcelona" });
    const tools = new ToolsSchema({
      standardTools: [
        new FunctionSchema({
          name: "get_weather",
          description: "Get the weather",
          properties: { location: { type: "string" } },
          required: ["location"],
        }),
      ],
    });
    const { service, streams } = makeService(
      eventsOnAudioStart([
        { contentStart: { type: "TOOL", role: "TOOL" } },
        { toolUse: { toolName: "get_weather", toolUseId: "tool-1", content: toolUseContent } },
        { contentEnd: { stopReason: "TOOL_USE" } },
      ]),
      { tools },
    );
    const calls: Dict[] = [];
    service.registerFunction("get_weather", async (params: FunctionCallParams) => {
      calls.push(params.arguments as Dict);
      await params.resultCallback({ temperature: 75, sky: "señal" });
    });
    await runTest(service, {
      framesToSend: [new LLMContextFrame({ context: new LLMContext() }), new SleepFrame()],
    });
    expect(calls).toEqual([{ location: "Barcelona" }]);
    const stream = streams[0] as FakeStream;
    const toolStart = stream.sent.find((e) => e.event.contentStart?.type === "TOOL") as Dict;
    expect(toolStart.event.contentStart.toolResultInputConfiguration.toolUseId).toBe("tool-1");
    const toolResult = stream.sent.find((e) => e.event.toolResult) as Dict;
    expect(toolResult.event.toolResult.content).toBe('{"temperature": 75, "sky": "señal"}');
    expect(toolResult.event.toolResult.contentName).toBe(toolStart.event.contentStart.contentName);
  });
});

/** A fake sender for the session continuation helper. */
class FakeSender implements NovaSonicSessionSender<string> {
  log: string[] = [];
  readonly audioConfig = { inputSampleRate: 16000, inputSampleSize: 16, inputChannelCount: 1 };

  async openStream(client: string): Promise<BidirectionalStream> {
    this.log.push(`open:${client}`);
    return new FakeStream();
  }
  async sendEvent(eventJson: string): Promise<void> {
    this.log.push(`event:${Object.keys(JSON.parse(eventJson).event)[0]}`);
  }
  buildSessionStartJson(): string {
    return '{"event":{"sessionStart":{}}}';
  }
  async sendPromptStart(tools: unknown[]): Promise<void> {
    this.log.push(`promptStart:${tools.length}`);
  }
  async sendText(text: string, role: string, _p: string, _s: unknown, interactive: boolean) {
    this.log.push(`text:${role}:${text}:${interactive}`);
  }
  async sendAudioInputStart(): Promise<void> {
    this.log.push("audioInputStart");
  }
  async sendAudio(audio: Uint8Array): Promise<void> {
    this.log.push(`audio:${audio.length}`);
  }
  createClient(): string {
    return "client-2";
  }
  async getSetupParams(): Promise<[string | null, unknown[]]> {
    return ["Be brief.", [{ toolSpec: {} }]];
  }
}

describe("SessionContinuationHelper", () => {
  function helper(sender: FakeSender): SessionContinuationHelper<string> {
    return new SessionContinuationHelper(
      new SessionContinuationParams({ audioBufferDurationSeconds: 0.05 }),
      {
        sender,
        createTask: () => {
          throw new Error("no tasks in this test");
        },
        cancelTask: async () => {},
      },
    );
  }

  test("an assistant turn past the threshold prepares, buffers and hands off", async () => {
    const sender = new FakeSender();
    const sc = helper(sender);
    sc.setConnected(1);
    sc.seedHistory("ASSISTANT", "Welcome!");
    sc.seedHistory("USER", "Hi");
    // The monitor sets this once the session is old enough.
    (sc as unknown as { _waitingForAudioStart: boolean })._waitingForAudioStart = true;

    expect(await sc.onAssistantAudioStarted()).toBe(true);
    expect(sc.isBuffering).toBe(true);
    expect(sc.nextSession?.client).toBe("client-2");
    expect(sender.log).toEqual([
      "open:client-2",
      "event:sessionStart",
      "promptStart:1",
      "text:SYSTEM:Be brief.:false",
    ]);

    // 0.05 s of 16 kHz 16-bit mono is 1600 bytes: the oldest chunk is dropped.
    sc.onAudioInput(new Uint8Array(1000));
    sc.onAudioInput(new Uint8Array(1000));

    sc.onTextOutput("ASSISTANT", "SPECULATIVE");
    sc.onTextOutput("ASSISTANT", "FINAL");
    expect(sc.onContentEndAssistantFinalText("Sure.")).toBe(true);

    sender.log = [];
    const ns = await sc.executeHandoff();
    expect(ns?.client).toBe("client-2");
    // History starts at a USER message; the leading ASSISTANT one is dropped.
    expect(sender.log).toEqual([
      "text:USER:Hi:false",
      "text:ASSISTANT:Sure.:false",
      "audioInputStart",
      "audio:1000",
    ]);
    expect(sc.isBuffering).toBe(false);
    expect(sc.nextSession).toBeNull();
    expect(sc.handoffInProgress).toBe(false);
  });

  test("nothing happens before the threshold", async () => {
    const sender = new FakeSender();
    const sc = helper(sender);
    sc.setConnected(1);
    expect(await sc.onAssistantAudioStarted()).toBe(false);
    sc.onAudioInput(new Uint8Array(10));
    expect(sc.isBuffering).toBe(false);
    expect(sc.onCompletionEnd()).toBe(false);
    expect(await sc.executeHandoff()).toBeNull();
    expect(sender.log).toEqual([]);
  });

  test("a barge-in completes the transition", async () => {
    const sender = new FakeSender();
    const sc = helper(sender);
    sc.setConnected(1);
    (sc as unknown as { _waitingForAudioStart: boolean })._waitingForAudioStart = true;
    await sc.onAssistantAudioStarted();
    expect(sc.onContentEndTextInterrupted()).toBe(true);
    // Only one completion signal per transition.
    expect(sc.onCompletionEnd()).toBe(false);
  });
});
