// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

// Known-vector tests for the event stream codec, SigV4 and the Transcribe
// presigned URL. The Transcribe and event-message vectors were produced by
// upstream's `pipecat.services.aws.utils` with the clock fixed at
// 2015-08-30T12:36:00Z.

import { describe, expect, test } from "bun:test";
import {
  crc32,
  decodeEventStream,
  decodeEventStreamMessage,
  EventStreamDecoder,
  EventStreamError,
  encodeEventStreamMessage,
} from "../src/event_stream.ts";
import { signRequest, uriEscape } from "../src/sigv4.ts";
import { buildEventMessage, decodeEvent, getPresignedUrl } from "../src/utils.ts";

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const fromHex = (s: string) => Uint8Array.from(s.match(/../g) ?? [], (h) => Number.parseInt(h, 16));
const DATE = new Date("2015-08-30T12:36:00Z");
const CREDS = {
  accessKeyId: "AKIDEXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
};

describe("crc32", () => {
  test("check value", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array(0))).toBe(0);
  });
});

describe("event stream", () => {
  const UPSTREAM_AUDIO_EVENT =
    "00000072000000588380b5000d3a636f6e74656e742d747970650700186170706c69636174696f6e2f6f637465742d73747265616d0b3a6576656e742d7479706507000a417564696f4576656e740d3a6d6573736167652d747970650700056576656e74000102030405060708094fc1e193";

  test("buildEventMessage matches upstream bytes", () => {
    const payload = Uint8Array.from({ length: 10 }, (_, i) => i);
    expect(hex(buildEventMessage(payload))).toBe(UPSTREAM_AUDIO_EVENT);
  });

  test("encodeEventStreamMessage matches buildEventMessage", () => {
    const payload = Uint8Array.from({ length: 10 }, (_, i) => i);
    const encoded = encodeEventStreamMessage({
      headers: {
        ":content-type": "application/octet-stream",
        ":event-type": "AudioEvent",
        ":message-type": "event",
      },
      body: payload,
    });
    expect(hex(encoded)).toBe(UPSTREAM_AUDIO_EVENT);
  });

  test("empty message vector", () => {
    // From the AWS event stream test suite: "empty_message".
    const encoded = encodeEventStreamMessage({ headers: {}, body: new Uint8Array(0) });
    expect(hex(encoded)).toBe("000000100000000005c248eb7d98c8ff");
  });

  test("all header types round trip", () => {
    const msg = {
      headers: {
        t: { type: "boolean" as const, value: true },
        f: { type: "boolean" as const, value: false },
        b: { type: "byte" as const, value: -3 },
        s: { type: "short" as const, value: -300 },
        i: { type: "integer" as const, value: 123456789 },
        l: { type: "long" as const, value: -9007199254740993n },
        bin: { type: "binary" as const, value: new Uint8Array([1, 2, 3]) },
        str: { type: "string" as const, value: "héllo" },
        ts: { type: "timestamp" as const, value: new Date(1700000000123) },
        u: { type: "uuid" as const, value: "01234567-89ab-cdef-0123-456789abcdef" },
      },
      body: new TextEncoder().encode('{"a":1}'),
    };
    const decoded = decodeEventStreamMessage(encodeEventStreamMessage(msg));
    expect(decoded.headers).toEqual(msg.headers);
    expect(decoded.body).toEqual(msg.body);
  });

  test("CRC failures are detected", () => {
    const encoded = encodeEventStreamMessage({ headers: { a: "b" }, body: new Uint8Array([1]) });
    const badPrelude = encoded.slice();
    badPrelude[9] = (badPrelude[9] as number) ^ 1;
    expect(() => decodeEventStreamMessage(badPrelude)).toThrow("Prelude CRC check failed");
    const badBody = encoded.slice();
    badBody[badBody.length - 5] = (badBody[badBody.length - 5] as number) ^ 1;
    expect(() => decodeEventStreamMessage(badBody)).toThrow("Message CRC check failed");
  });

  test("decoder handles split and joined chunks", async () => {
    const a = encodeEventStreamMessage({ headers: { n: "1" }, body: new Uint8Array([1, 2]) });
    const b = encodeEventStreamMessage({ headers: { n: "2" }, body: new Uint8Array([3]) });
    const all = new Uint8Array([...a, ...b]);
    const decoder = new EventStreamDecoder();
    const out = [
      ...decoder.push(all.subarray(0, 5)),
      ...decoder.push(all.subarray(5, a.length + 3)),
      ...decoder.push(all.subarray(a.length + 3)),
    ];
    expect(out.map((m) => m.headers.n)).toEqual([
      { type: "string", value: "1" },
      { type: "string", value: "2" },
    ]);
    expect(decoder.pending).toBe(0);

    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(all.subarray(0, 7));
        c.enqueue(all.subarray(7));
        c.close();
      },
    });
    const bodies = [];
    for await (const m of decodeEventStream(stream)) bodies.push([...m.body]);
    expect(bodies).toEqual([[1, 2], [3]]);
  });

  test("truncated stream throws", async () => {
    const a = encodeEventStreamMessage({ headers: {}, body: new Uint8Array([1, 2]) });
    async function* gen() {
      yield a.subarray(0, a.length - 1);
    }
    const run = async () => {
      for await (const _ of decodeEventStream(gen())) {
        // drain
      }
    };
    await expect(run()).rejects.toBeInstanceOf(EventStreamError);
  });

  test("decodeEvent parses headers and JSON payload", () => {
    const encoded = encodeEventStreamMessage({
      headers: { ":message-type": "event", ":event-type": "TranscriptEvent" },
      body: new TextEncoder().encode('{"Transcript":{"Results":[]}}'),
    });
    const [headers, payload] = decodeEvent(encoded);
    expect(headers).toEqual({ ":message-type": "event", ":event-type": "TranscriptEvent" });
    expect(payload).toEqual({ Transcript: { Results: [] } });
    expect(fromHex(hex(encoded))).toEqual(encoded);
  });
});

describe("sigv4", () => {
  test("uriEscape is RFC 3986", () => {
    expect(uriEscape("a b/c:d*e!~._-")).toBe("a%20b%2Fc%3Ad%2Ae%21~._-");
  });

  test("get-vanilla (AWS SigV4 test suite)", async () => {
    const headers = await signRequest({
      method: "GET",
      url: "https://example.amazonaws.com/",
      service: "service",
      region: "us-east-1",
      credentials: CREDS,
      date: DATE,
    });
    expect(headers.authorization).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31",
    );
  });

  test("IAM ListUsers (AWS documentation example)", async () => {
    const headers = await signRequest({
      method: "GET",
      url: "https://iam.amazonaws.com/?Action=ListUsers&Version=2010-05-08",
      headers: { "Content-Type": "application/x-www-form-urlencoded; charset=utf-8" },
      service: "iam",
      region: "us-east-1",
      credentials: CREDS,
      date: DATE,
    });
    expect(headers.authorization).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/iam/aws4_request, SignedHeaders=content-type;host;x-amz-date, Signature=5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7",
    );
  });

  test("session token is signed", async () => {
    const headers = await signRequest({
      method: "POST",
      url: "https://bedrock-runtime.us-east-1.amazonaws.com/model/a%3Ab/converse",
      body: "{}",
      service: "bedrock",
      region: "us-east-1",
      credentials: { ...CREDS, sessionToken: "TOKEN" },
      date: DATE,
    });
    expect(headers["x-amz-security-token"]).toBe("TOKEN");
    expect(headers.authorization).toContain("SignedHeaders=host;x-amz-date;x-amz-security-token");
  });
});

describe("AWSTranscribePresignedURL", () => {
  test("matches upstream URL", async () => {
    const url = await getPresignedUrl({
      region: "us-west-2",
      credentials: {
        access_key: CREDS.accessKeyId,
        secret_key: CREDS.secretAccessKey,
        session_token: "tok/en+=",
      },
      languageCode: "en-US",
      sampleRate: 16000,
      vocabularyName: "vocab",
      date: DATE,
    });
    expect(url).toBe(
      "wss://transcribestreaming.us-west-2.amazonaws.com:8443/stream-transcription-websocket?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIDEXAMPLE%2F20150830%2Fus-west-2%2Ftranscribe%2Faws4_request&X-Amz-Date=20150830T123600Z&X-Amz-Expires=300&X-Amz-Security-Token=tok%2Fen%2B%3D&X-Amz-SignedHeaders=host&enable-partial-results-stabilization=true&language-code=en-US&media-encoding=pcm&partial-results-stability=high&sample-rate=16000&vocabulary-name=vocab&X-Amz-Signature=bd8cb334d7b32605cb1be446044509bba11001d52808c08c79746b97f850f7f8",
    );
  });

  test("requires keys", async () => {
    await expect(
      getPresignedUrl({ region: "us-east-1", credentials: {}, languageCode: "en-US" }),
    ).rejects.toThrow("AWS credentials are required");
  });
});
