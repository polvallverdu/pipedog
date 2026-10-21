// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_sagemaker_bidi_client.py

/** Tests for SageMaker BiDi session start failures and how services report them. */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  InputValidationError,
  ModelError,
  SageMakerRuntimeHTTP2ServiceException,
  ServiceUnavailableError,
} from "@aws-sdk/client-sagemaker-runtime-http2";
import { ErrorCategory } from "@pipedog/core/utils/errors";
import { AWSSession } from "../src/aws_session.ts";
import {
  _connectBackoff,
  classifySagemakerBidiError,
  type InvokeEndpointWithBidirectionalStreamInput,
  type RequestStreamEvent,
  type ResponseStreamEvent,
  SageMakerBidiClient,
  SageMakerBidiSessionError,
  type SageMakerBidiStream,
  type SageMakerRuntimeHTTP2ClientLike,
  SdkSageMakerRuntimeHTTP2Client,
} from "../src/sagemaker/bidi_client.ts";
import { resolveCredentials } from "../src/utils.ts";

const OPERATION = "com.amazonaws.sagemakerruntimehttp2#InvokeEndpointWithBidirectionalStream";

/** Upstream's `smithy_core.exceptions.CallError`: only its message carries the status and id. */
class CallError extends Error {
  override name = "CallError";
  fault: string;
  constructor(options: { message: string; fault: string }) {
    super(options.message);
    this.fault = options.fault;
  }
}

/** An error shaped like the one the Python SDK raises for an unmodeled AWS error. */
function unmodeledError(status: number, errorId: string): CallError {
  return new CallError({
    message:
      `Unknown error for operation ${OPERATION} - status: ${status} - id: ` +
      `com.amazonaws.sagemakerruntimehttp2#${errorId}`,
    fault: status < 500 ? "client" : "server",
  });
}

/** The same error as the JS SDK raises it: the id as `name`, the status in `$metadata`. */
function jsUnmodeledError(status: number, errorId: string): Error {
  return new SageMakerRuntimeHTTP2ServiceException({
    name: errorId,
    $fault: status < 500 ? "client" : "server",
    $metadata: { httpStatusCode: status },
    message: errorId,
  });
}

function throttled(): CallError {
  // SageMaker reports a throttled bidirectional stream with a 400.
  return unmodeledError(400, "ThrottlingException");
}

const meta = { $metadata: {} };

class FakeStream implements SageMakerBidiStream {
  sent: RequestStreamEvent[] = [];
  closed = false;
  inputStream = {
    send: async (event: RequestStreamEvent) => {
      this.sent.push(event);
    },
    close: async () => {
      this.closed = true;
    },
  };
  async awaitOutput(): Promise<[unknown, { receive(): Promise<ResponseStreamEvent | null> }]> {
    return [null, { receive: async () => null }];
  }
}

/** Stands in for the SDK client, failing each session start with the next queued error. */
class FakeSDKClient implements SageMakerRuntimeHTTP2ClientLike {
  errors: unknown[] = [];
  failForever: unknown = null;
  attempts = 0;
  lastStream: FakeStream | null = null;
  inputs: InvokeEndpointWithBidirectionalStreamInput[] = [];

  async invokeEndpointWithBidirectionalStream(
    input: InvokeEndpointWithBidirectionalStreamInput,
  ): Promise<SageMakerBidiStream> {
    this.attempts += 1;
    this.inputs.push(input);
    if (this.errors.length > 0) throw this.errors.shift();
    if (this.failForever !== null) throw this.failForever;
    this.lastStream = new FakeStream();
    return this.lastStream;
  }
}

let fakeSdk: FakeSDKClient;
const savedMultiplier = _connectBackoff.multiplier;

beforeEach(() => {
  fakeSdk = new FakeSDKClient();
  _connectBackoff.multiplier = 0;
});

afterEach(() => {
  _connectBackoff.multiplier = savedMultiplier;
});

describe("test_classify_sagemaker_bidi_error", () => {
  const cases: [string, () => unknown, ErrorCategory | null][] = [
    ["throttled", () => throttled(), ErrorCategory.RATE_LIMIT],
    ["429", () => unmodeledError(429, "TooManyRequests"), ErrorCategory.RATE_LIMIT],
    ["503", () => unmodeledError(503, "SomethingUnmodeled"), ErrorCategory.SERVER],
    [
      "ServiceUnavailableError",
      () => new ServiceUnavailableError({ message: "unavailable", ...meta }),
      ErrorCategory.SERVER,
    ],
    // Shapes AWS returned for a missing endpoint and for rejected credentials.
    [
      "ValidationError",
      () => unmodeledError(400, "ValidationError"),
      ErrorCategory.INVALID_REQUEST,
    ],
    [
      "InvalidSignatureException",
      () => unmodeledError(403, "InvalidSignatureException"),
      ErrorCategory.CONNECTIVITY,
    ],
    [
      "UnrecognizedClientException",
      () => unmodeledError(403, "UnrecognizedClientException"),
      ErrorCategory.CONNECTIVITY,
    ],
    [
      "InputValidationError",
      () => new InputValidationError({ message: "bad input", ...meta }),
      ErrorCategory.INVALID_REQUEST,
    ],
    // The model container refused the stream (at capacity, or bad settings).
    [
      "ModelError 424",
      () =>
        new ModelError({
          message:
            'Received server error (424) from primary with message "Failed to establish WebSocket connection".',
          OriginalStatusCode: 424,
          ErrorCode: "INTERNAL_FAILURE_FROM_MODEL",
          ...meta,
        }),
      ErrorCategory.SERVER,
    ],
    [
      "ModelError 400",
      () => new ModelError({ message: "rejected", OriginalStatusCode: 400, ...meta }),
      ErrorCategory.INVALID_REQUEST,
    ],
    [
      "ModelError 503",
      () => new ModelError({ message: "overloaded", OriginalStatusCode: 503, ...meta }),
      ErrorCategory.SERVER,
    ],
    [
      "SageMakerBidiSessionError",
      () => new SageMakerBidiSessionError("x", { errorId: "ThrottlingException" }),
      ErrorCategory.RATE_LIMIT,
    ],
    ["RuntimeError", () => new Error("something else"), null],
  ];
  for (const [name, make, category] of cases) {
    test(name, () => {
      expect(classifySagemakerBidiError(make())).toBe(category);
    });
  }

  // pipedog: the JS SDK's form of the same unmodeled errors.
  const jsCases: [string, () => unknown, ErrorCategory | null][] = [
    ["js throttled", () => jsUnmodeledError(400, "ThrottlingException"), ErrorCategory.RATE_LIMIT],
    ["js 503", () => jsUnmodeledError(503, "SomethingUnmodeled"), ErrorCategory.SERVER],
    [
      "js ValidationError",
      () => jsUnmodeledError(400, "ValidationError"),
      ErrorCategory.INVALID_REQUEST,
    ],
    [
      "js InvalidSignatureException",
      () => jsUnmodeledError(403, "InvalidSignatureException"),
      ErrorCategory.CONNECTIVITY,
    ],
    [
      "js $retryable throttling",
      () => Object.assign(new Error("slow down"), { $retryable: { throttling: true } }),
      ErrorCategory.RATE_LIMIT,
    ],
    [
      "connection error",
      () => Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }),
      ErrorCategory.CONNECTIVITY,
    ],
  ];
  for (const [name, make, category] of jsCases) {
    test(name, () => {
      expect(classifySagemakerBidiError(make())).toBe(category);
    });
  }
});

function makeClient(options: { maxConnectAttempts?: number } = {}): SageMakerBidiClient {
  return new SageMakerBidiClient({
    endpointName: "endpoint",
    region: "us-east-2",
    modelInvocationPath: "v1/listen",
    client: fakeSdk,
    ...options,
  });
}

describe("SageMakerBidiClient", () => {
  test("test_start_session_retries_throttling", async () => {
    fakeSdk.errors = [throttled(), throttled()];
    const client = makeClient();

    await client.startSession();

    expect(fakeSdk.attempts).toBe(3);
    expect(client.isActive).toBe(true);
  });

  test("test_start_session_gives_up_after_max_attempts", async () => {
    fakeSdk.failForever = throttled();
    const client = makeClient({ maxConnectAttempts: 3 });

    let raised: unknown;
    try {
      await client.startSession();
    } catch (e) {
      raised = e;
    }

    expect(raised).toBeInstanceOf(SageMakerBidiSessionError);
    const err = raised as SageMakerBidiSessionError;
    expect(fakeSdk.attempts).toBe(3);
    expect(err.errorId).toBe("ThrottlingException");
    expect(err.httpStatus).toBe(400);
    expect(err.attempts).toBe(3);
    expect(err.cause).toBeInstanceOf(CallError);
    expect(client.isActive).toBe(false);
  });

  test("test_start_session_does_not_retry_rejected_credentials", async () => {
    fakeSdk.failForever = unmodeledError(403, "InvalidSignatureException");
    const client = makeClient();

    const err = (await client.startSession().catch((e) => e)) as SageMakerBidiSessionError;

    expect(err).toBeInstanceOf(SageMakerBidiSessionError);
    expect(fakeSdk.attempts).toBe(1);
    expect(err.httpStatus).toBe(403);
  });

  test("test_start_session_does_not_retry_invalid_request", async () => {
    fakeSdk.failForever = new InputValidationError({ message: "bad input", ...meta });
    const client = makeClient();

    const err = (await client.startSession().catch((e) => e)) as SageMakerBidiSessionError;

    expect(err).toBeInstanceOf(SageMakerBidiSessionError);
    expect(fakeSdk.attempts).toBe(1);
    expect(err.errorId).toBe("InputValidationError");
  });

  // pipedog: send helpers and session lifecycle.
  test("send helpers and close", async () => {
    const client = makeClient();
    await expect(client.sendText("x")).rejects.toThrow("BiDi session not active");
    await client.startSession();
    expect(fakeSdk.inputs[0]).toEqual({
      endpointName: "endpoint",
      modelInvocationPath: "v1/listen",
      modelQueryString: "",
    });
    await client.sendAudioChunk(new Uint8Array([1, 2]));
    await client.sendText("hé");
    await client.sendJson({ type: "KeepAlive", n: 1 });
    const sent = fakeSdk.lastStream?.sent ?? [];
    expect(sent[0]).toEqual({ PayloadPart: { Bytes: new Uint8Array([1, 2]), DataType: "BINARY" } });
    expect(sent[1]).toEqual({
      PayloadPart: { Bytes: new TextEncoder().encode("hé"), DataType: "UTF8" },
    });
    expect(new TextDecoder().decode(sent[2]?.PayloadPart.Bytes)).toBe(
      '{"type": "KeepAlive", "n": 1}',
    );
    expect(await client.receiveResponse()).toBeNull();
    await client.closeSession();
    await client.closeSession();
    expect(fakeSdk.lastStream?.closed).toBe(true);
    expect(client.isActive).toBe(false);
  });
});

describe("SdkSageMakerRuntimeHTTP2Client (JS SDK adapter)", () => {
  test("streams request events and response events through the SDK", async () => {
    const received: RequestStreamEvent[] = [];
    let commandInput: Record<string, unknown> | null = null;
    let drained: Promise<void> | null = null;
    class FakeCommand {
      input: Record<string, unknown>;
      constructor(input: Record<string, unknown>) {
        this.input = input;
      }
    }
    const responses: ResponseStreamEvent[] = [
      { PayloadPart: { Bytes: new Uint8Array([9]), DataType: "BINARY" } },
    ];
    const sdkClient = {
      async send(command: unknown) {
        commandInput = (command as FakeCommand).input;
        const body = commandInput.Body as AsyncIterable<RequestStreamEvent>;
        drained = (async () => {
          for await (const e of body) received.push(e);
        })();
        return {
          Body: (async function* () {
            yield* responses;
          })(),
        };
      },
    };
    const sdk = {
      SageMakerRuntimeHTTP2Client: class {},
      InvokeEndpointWithBidirectionalStreamCommand: FakeCommand,
    } as never;
    const session = AWSSession.fromOptions({
      awsAccessKeyId: "k",
      awsSecretAccessKey: "s",
      region: "us-east-2",
    });
    const adapter = new SdkSageMakerRuntimeHTTP2Client({
      endpoint: "https://runtime.sagemaker.us-east-2.amazonaws.com:8443",
      region: "us-east-2",
      session,
      sdk,
      sdkClient,
    });
    const client = new SageMakerBidiClient({
      endpointName: "endpoint",
      region: "us-east-2",
      modelInvocationPath: "v1/listen",
      modelQueryString: "model=nova-3",
      client: adapter,
    });
    await client.startSession();
    expect(commandInput).not.toBeNull();
    const input = commandInput as unknown as Record<string, unknown>;
    expect(input.EndpointName).toBe("endpoint");
    expect(input.ModelInvocationPath).toBe("v1/listen");
    expect(input.ModelQueryString).toBe("model=nova-3");
    await client.sendAudioChunk(new Uint8Array([1]));
    await client.sendText("hi");
    expect(await client.receiveResponse()).toEqual(responses[0] as ResponseStreamEvent);
    expect(await client.receiveResponse()).toBeNull();
    await client.closeSession();
    await drained;
    expect(received.map((e) => e.PayloadPart.DataType)).toEqual(["BINARY", "UTF8"]);
  });

  test("builds the real SDK client with session credentials (no network)", async () => {
    const session = AWSSession.fromOptions({
      awsAccessKeyId: "key",
      awsSecretAccessKey: "secret",
      awsSessionToken: "token",
      region: "us-east-2",
    });
    const adapter = new SdkSageMakerRuntimeHTTP2Client({
      endpoint: "https://runtime.sagemaker.us-east-2.amazonaws.com:8443",
      region: "us-east-2",
      session,
    });
    const sdkClient = (await adapter.getSdkClient()) as unknown as {
      config: { credentials: () => Promise<Record<string, unknown>> };
    };
    const creds = await sdkClient.config.credentials();
    expect(creds.accessKeyId).toBe("key");
    expect(creds.secretAccessKey).toBe("secret");
    expect(creds.sessionToken).toBe("token");
    expect(resolveCredentials({ region: "us-east-2" }).region).toBe("us-east-2");
  });

  test("credentialsProvider is used when no keys are configured", async () => {
    const saved = {
      a: process.env.AWS_ACCESS_KEY_ID,
      s: process.env.AWS_SECRET_ACCESS_KEY,
    };
    delete process.env.AWS_ACCESS_KEY_ID;
    delete process.env.AWS_SECRET_ACCESS_KEY;
    try {
      let calls = 0;
      const client = new SageMakerBidiClient({
        endpointName: "endpoint",
        region: "us-east-2",
        credentialsProvider: () => {
          calls += 1;
          return { accessKeyId: `key-${calls}`, secretAccessKey: "secret" };
        },
      });
      const adapter = client._initializeClient() as SdkSageMakerRuntimeHTTP2Client;
      const sdkClient = (await adapter.getSdkClient()) as unknown as {
        config: { credentials: () => Promise<Record<string, unknown>> };
      };
      expect((await sdkClient.config.credentials()).accessKeyId).toBe("key-1");
    } finally {
      if (saved.a !== undefined) process.env.AWS_ACCESS_KEY_ID = saved.a;
      if (saved.s !== undefined) process.env.AWS_SECRET_ACCESS_KEY = saved.s;
    }
  });
});

// The service tests need the SageMaker variants of the Deepgram and NVIDIA
// services, which are not ported yet.
describe("SageMaker services", () => {
  test.todo(
    "test_stt_unusable_when_session_never_starts (needs pipecat.services.deepgram.sagemaker.stt)",
  );
  test.todo(
    "test_stt_usable_after_throttled_attempt_recovers (needs pipecat.services.deepgram.sagemaker.stt)",
  );
  test.todo(
    "test_flux_stt_unusable_when_session_never_starts (needs pipecat.services.deepgram.flux.sagemaker.stt)",
  );
  test.todo(
    "test_tts_unusable_when_session_never_starts (needs pipecat.services.deepgram.sagemaker.tts)",
  );
  test.todo(
    "test_flux_tts_stays_usable_and_retries_next_turn (needs pipecat.services.deepgram.flux.sagemaker.tts)",
  );
  test.todo(
    "test_nvidia_stt_unusable_when_session_never_starts (needs pipecat.services.nvidia.sagemaker.stt)",
  );
  test.todo(
    "test_nvidia_tts_stays_usable_and_retries_next_turn (needs pipecat.services.nvidia.sagemaker.tts)",
  );
  test.todo(
    "test_nvidia_tts_treats_rejected_credentials_as_recoverable (needs pipecat.services.nvidia.sagemaker.tts)",
  );
});
