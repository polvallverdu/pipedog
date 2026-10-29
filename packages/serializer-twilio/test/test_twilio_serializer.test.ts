// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_twilio_serializer.py

/**
 * Tests for TwilioFrameSerializer.
 *
 * deserialize() ignores malformed JSON and messages missing expected fields
 * rather than raising, since the transport's receive loop ends the call on any
 * exception. With auto_hang_up enabled, the constructor requires exactly one
 * credential type: auth_token or the api_key_sid + api_key_secret pair. The
 * hang-up request authenticates with the matching Basic Auth pair, while
 * account_sid stays in the URL.
 */

import { afterEach, beforeEach, describe, expect, type Mock, spyOn, test } from "bun:test";

import { SystemClock } from "@pipedog/core/clocks/system_clock";
import {
  FrameProcessorSetup,
  type FrameProcessorSetupOptions,
} from "@pipedog/core/processors/frame_processor";
import type { BaseTaskManager } from "@pipedog/core/utils/asyncio/task_manager";

import { base64ToBytes } from "@pipedog/core/utils/base64";

import { TwilioFrameSerializer, type TwilioFrameSerializerOptions } from "../src/twilio.ts";

const STREAM_SID = "stream123";
const SAMPLE_RATE = 8000;

const CALL_SID = "CAyyyy";
const ACCOUNT_SID = "ACxxxx";
const AUTH_TOKEN = "Auth_token";
const API_KEY_SID = "SKxxxx";
const API_KEY_SECRET = "secret";
const BASE_URL = "https://api.example.test";
const CREDS = { callSid: CALL_SID, accountSid: ACCOUNT_SID };

/** Test view of the serializer's protected members. */
interface TwilioFrameSerializerInternals {
  _authToken: string | null;
  _apiKeySid: string | null;
  _apiKeySecret: string | null;
  _hangUpCall(): Promise<void>;
}

function internals(serializer: TwilioFrameSerializer): TwilioFrameSerializerInternals {
  return serializer as unknown as TwilioFrameSerializerInternals;
}

/**
 * Mock the HTTP client used for the hang-up request (upstream patches
 * `aiohttp.ClientSession`; the port uses `fetch`). Responds with status 200.
 */
function makeClientSession(): Mock<typeof fetch> {
  return spyOn(globalThis, "fetch").mockImplementation(
    (async () => new Response(null, { status: 200 })) as unknown as typeof fetch,
  ) as Mock<typeof fetch>;
}

/** The `(login, password)` of the Basic Auth header sent with a fetch call. */
function basicAuthOf(init: RequestInit | undefined): { login: string; password: string } {
  const headers = new Headers(init?.headers);
  const header = headers.get("Authorization") ?? "";
  expect(header.startsWith("Basic ")).toBe(true);
  const decoded = new TextDecoder().decode(base64ToBytes(header.slice("Basic ".length)));
  const idx = decoded.indexOf(":");
  return { login: decoded.slice(0, idx), password: decoded.slice(idx + 1) };
}

function makeSerializer(
  options: Omit<TwilioFrameSerializerOptions, "streamSid">,
): TwilioFrameSerializer {
  return new TwilioFrameSerializer({ streamSid: STREAM_SID, ...options });
}

/**
 * Build a setup configuration for a processor used outside a pipeline.
 *
 * Local port of upstream tests/frame_processor_helpers.py `frame_processor_setup`.
 */
function frameProcessorSetup(
  taskManager: BaseTaskManager | null = null,
  options: Partial<FrameProcessorSetupOptions> = {},
): FrameProcessorSetup {
  return new FrameProcessorSetup({
    clock: new SystemClock(),
    pipelineWorker: null,
    ...options,
    taskManager: taskManager as BaseTaskManager,
  });
}

describe("TestTwilioDeserializeRobustness", () => {
  let serializer: TwilioFrameSerializer;

  beforeEach(async () => {
    serializer = new TwilioFrameSerializer({
      streamSid: STREAM_SID,
      params: new TwilioFrameSerializer.InputParams({ autoHangUp: false }),
    });
    await serializer.setup(
      frameProcessorSetup(null, {
        audioInSampleRate: SAMPLE_RATE,
        audioOutSampleRate: SAMPLE_RATE,
      }),
    );
  });

  test("test_malformed_json_is_ignored_not_raised", async () => {
    const frame = await serializer.deserialize("not json");
    expect(frame).toBeNull();
  });

  test("test_media_event_missing_payload_is_ignored_not_raised", async () => {
    const frame = await serializer.deserialize(JSON.stringify({ event: "media", media: {} }));
    expect(frame).toBeNull();
  });

  test("test_message_missing_event_key_is_ignored_not_raised", async () => {
    const frame = await serializer.deserialize(JSON.stringify({ foo: "bar" }));
    expect(frame).toBeNull();
  });
});

describe("TestConstructorCredentialValidation", () => {
  test("test_auth_token_alone_is_accepted", () => {
    const serializer = makeSerializer({ authToken: AUTH_TOKEN, ...CREDS });
    expect(internals(serializer)._authToken).toEqual(AUTH_TOKEN);
  });

  test("test_api_key_pair_alone_is_accepted", () => {
    const cases: [string, Partial<TwilioFrameSerializerOptions>][] = [
      ["token_omitted", {}],
      ["empty_token", { authToken: "" }],
    ];
    for (const [_name, tokenPart] of cases) {
      const serializer = makeSerializer({
        apiKeySid: API_KEY_SID,
        apiKeySecret: API_KEY_SECRET,
        ...tokenPart,
        ...CREDS,
      });
      expect(internals(serializer)._apiKeySid).toEqual(API_KEY_SID);
      expect(internals(serializer)._apiKeySecret).toEqual(API_KEY_SECRET);
    }
  });

  test("test_api_key_sid_without_secret_is_rejected", () => {
    expect(() => makeSerializer({ apiKeySid: API_KEY_SID, ...CREDS })).toThrow(
      /Missing: api_key_secret/,
    );
  });

  test("test_api_key_secret_without_sid_is_rejected", () => {
    expect(() => makeSerializer({ apiKeySecret: API_KEY_SECRET, ...CREDS })).toThrow(
      /Missing: api_key_sid/,
    );
  });

  test("test_auth_token_with_any_api_key_part_is_rejected", () => {
    const cases: [string, Partial<TwilioFrameSerializerOptions>][] = [
      ["sid_only", { apiKeySid: API_KEY_SID }],
      ["secret_only", { apiKeySecret: API_KEY_SECRET }],
      ["full_pair", { apiKeySid: API_KEY_SID, apiKeySecret: API_KEY_SECRET }],
    ];
    for (const [_name, keyPart] of cases) {
      expect(() => makeSerializer({ authToken: AUTH_TOKEN, ...keyPart, ...CREDS })).toThrow(
        /not both/,
      );
    }
  });

  test("test_no_credentials_is_rejected", () => {
    expect(() => makeSerializer({ ...CREDS })).toThrow(
      /missing required parameters: auth_token or api_key_sid \+ api_key_secret/,
    );
  });
});

describe("TestHangUpBasicAuth", () => {
  let session: Mock<typeof fetch>;

  beforeEach(() => {
    session = makeClientSession();
  });

  afterEach(() => {
    session.mockRestore();
  });

  test("test_basic_auth_with_auth_token", async () => {
    const serializer = makeSerializer({ authToken: AUTH_TOKEN, ...CREDS });

    await internals(serializer)._hangUpCall();

    expect(session).toHaveBeenCalledTimes(1);

    const auth = basicAuthOf(session.mock.calls[0]?.[1]);
    expect(auth.login).toEqual(ACCOUNT_SID);
    expect(auth.password).toEqual(AUTH_TOKEN);
  });

  test("test_basic_auth_with_api_key", async () => {
    const serializer = makeSerializer({
      apiKeySid: API_KEY_SID,
      apiKeySecret: API_KEY_SECRET,
      ...CREDS,
    });

    await internals(serializer)._hangUpCall();

    expect(session).toHaveBeenCalledTimes(1);

    const auth = basicAuthOf(session.mock.calls[0]?.[1]);
    expect(auth.login).toEqual(API_KEY_SID);
    expect(auth.password).toEqual(API_KEY_SECRET);

    const url = String(session.mock.calls[0]?.[0]);
    expect(url).toContain(`/Accounts/${ACCOUNT_SID}/`);
  });

  test("test_base_url_working_with_api_key", async () => {
    const serializer = makeSerializer({
      apiKeySid: API_KEY_SID,
      apiKeySecret: API_KEY_SECRET,
      baseUrl: BASE_URL,
      ...CREDS,
    });

    await internals(serializer)._hangUpCall();

    expect(session).toHaveBeenCalledTimes(1);

    const auth = basicAuthOf(session.mock.calls[0]?.[1]);
    expect(auth.login).toEqual(API_KEY_SID);
    expect(auth.password).toEqual(API_KEY_SECRET);

    const url = String(session.mock.calls[0]?.[0]);
    expect(url.startsWith(`${BASE_URL}/`)).toBe(true);
  });
});
