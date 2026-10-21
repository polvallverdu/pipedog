// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_aws_credentials.py

/**
 * Unit tests for AWS credential resolution and renewal.
 *
 * Porting notes:
 * - `patch.dict(os.environ, ...)` → set `process.env` and restore it after
 *   each test.
 * - DIVERGENCE: there is no botocore default chain. The chain tests become
 *   `credentialsProvider` tests: the provider plays the role of the session's
 *   renewing credentials, and signing is checked through a fake `fetch`
 *   (the `Credential=` key of each request's `Authorization` header).
 *   `test_partial_explicit_credentials_do_not_mix_with_botocore_chain` checks
 *   that the provider is not consulted when keys are configured.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { AWSAgentCoreProcessor } from "../src/agent_core.ts";
import type { AWSCredentialIdentity, AWSSession } from "../src/aws_session.ts";
import { AWSBedrockLLMService } from "../src/llm.ts";
import { AWSTranscribeSTTService } from "../src/stt.ts";
import { AWSPollyTTSService } from "../src/tts.ts";
import { AWSCredentials, resolveCredentials } from "../src/utils.ts";

type Any = any;

const AWS_ENV = [
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_REGION",
] as const;
let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv = Object.fromEntries(AWS_ENV.map((k) => [k, process.env[k]]));
});

afterEach(() => {
  for (const k of AWS_ENV) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

function setEnv(values: Partial<Record<(typeof AWS_ENV)[number], string>>, clear = false): void {
  if (clear) for (const k of AWS_ENV) delete process.env[k];
  for (const [k, v] of Object.entries(values)) process.env[k] = v;
}

/** The `no_configured_keys` fixture. */
function noConfiguredKeys(): void {
  for (const k of ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN"]) {
    delete process.env[k];
  }
}

describe("TestResolveCredentials", () => {
  test("test_explicit_credentials_take_priority", () => {
    const result = resolveCredentials({
      awsAccessKeyId: "explicit-key",
      awsSecretAccessKey: "explicit-secret",
      awsSessionToken: "explicit-token",
      region: "eu-west-1",
    });
    expect(result.accessKey).toEqual("explicit-key");
    expect(result.secretKey).toEqual("explicit-secret");
    expect(result.sessionToken).toEqual("explicit-token");
    expect(result.region).toEqual("eu-west-1");
  });

  test("test_env_vars_fallback", () => {
    setEnv({
      AWS_ACCESS_KEY_ID: "env-key",
      AWS_SECRET_ACCESS_KEY: "env-secret",
      AWS_SESSION_TOKEN: "env-token",
      AWS_REGION: "ap-southeast-2",
    });
    const result = resolveCredentials();
    expect(result.accessKey).toEqual("env-key");
    expect(result.secretKey).toEqual("env-secret");
    expect(result.sessionToken).toEqual("env-token");
    expect(result.region).toEqual("ap-southeast-2");
  });

  test("test_explicit_overrides_env", () => {
    setEnv({ AWS_ACCESS_KEY_ID: "env-key", AWS_SECRET_ACCESS_KEY: "env-secret" });
    const result = resolveCredentials({
      awsAccessKeyId: "override-key",
      awsSecretAccessKey: "override-secret",
    });
    expect(result.accessKey).toEqual("override-key");
    expect(result.secretKey).toEqual("override-secret");
  });

  test("test_partial_explicit_credentials_do_not_mix_with_botocore_chain", async () => {
    setEnv({}, true);
    let providerCalls = 0;
    const result = resolveCredentials({ awsAccessKeyId: "explicit-key" });

    expect(result.accessKey).toEqual("explicit-key");
    expect(result.secretKey).toBeNull();

    // A service built with the same partial keys signs with them as given,
    // without asking its provider for ambient keys.
    const service: Any = new AWSPollyTTSService({
      awsAccessKeyId: "explicit-key",
      credentialsProvider: () => {
        providerCalls++;
        return { accessKeyId: "ambient-key", secretAccessKey: "ambient-secret" };
      },
    });
    const creds = await (service._awsSession as AWSSession).getCredentials();
    expect(creds.accessKeyId).toEqual("explicit-key");
    expect(providerCalls).toBe(0);
  });

  test("test_no_keys_when_nothing_configured", () => {
    setEnv({}, true);
    const result = resolveCredentials();

    expect(result.accessKey).toBeNull();
    expect(result.secretKey).toBeNull();
    expect(result.sessionToken).toBeNull();
  });

  test("test_default_region", () => {
    setEnv({}, true);
    const result = resolveCredentials({ awsAccessKeyId: "key", awsSecretAccessKey: "secret" });
    expect(result.region).toEqual("us-east-1");
  });

  test("test_returns_aws_credentials_dataclass", () => {
    const result = resolveCredentials({ awsAccessKeyId: "key", awsSecretAccessKey: "secret" });
    expect(result).toBeInstanceOf(AWSCredentials);
  });
});

/** Temporary credentials that are renewed on every use. */
function renewingCredentials(): () => AWSCredentialIdentity {
  let renewals = 0;
  return () => {
    renewals += 1;
    return {
      accessKeyId: `key-${renewals}`,
      secretAccessKey: `secret-${renewals}`,
      sessionToken: `token-${renewals}`,
    };
  };
}

/** A fake `fetch` recording each request's signing key. */
function signingKeyRecorder(): {
  fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  keys: string[];
} {
  const keys: string[] = [];
  return {
    keys,
    fetch: async (_input, init) => {
      const headers = new Headers(init?.headers);
      const auth = headers.get("authorization") ?? "";
      keys.push(/Credential=([^/]+)\//.exec(auth)?.[1] ?? "");
      return new Response("{}", { status: 200 });
    },
  };
}

const CLIENT_CASES: [string, (opts: Any) => Any, string][] = [
  ["bedrock", (opts) => new AWSBedrockLLMService(opts), "bedrock"],
  ["polly", (opts) => new AWSPollyTTSService(opts), "polly"],
  [
    "agentcore",
    (opts) =>
      new AWSAgentCoreProcessor({
        agentArn: "arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/test",
        ...opts,
      }),
    "bedrock-agentcore",
  ],
];

describe("test_clients_sign_with_renewed_default_chain_credentials", () => {
  for (const [id, makeService, serviceName] of CLIENT_CASES) {
    test(id, async () => {
      noConfiguredKeys();
      const recorder = signingKeyRecorder();
      const service = makeService({
        credentialsProvider: renewingCredentials(),
        fetch: recorder.fetch,
      });

      const session = service._awsSession as AWSSession;
      for (let i = 0; i < 2; i++) {
        await session.request({
          service: serviceName,
          url: `https://${serviceName}.us-east-1.amazonaws.com/`,
          body: "{}",
        });
      }

      expect(recorder.keys[0]).not.toEqual(recorder.keys[1]);
      expect(recorder.keys.every((key) => key.startsWith("key-"))).toBe(true);
    });
  }
});

test("test_transcribe_signs_each_connection_with_current_keys", async () => {
  noConfiguredKeys();
  const service: Any = new AWSTranscribeSTTService({
    credentialsProvider: renewingCredentials(),
  });

  const first = await service._signingCredentials();
  const second = await service._signingCredentials();

  expect(first.access_key).not.toEqual(second.access_key);
  expect(second.session_token).toEqual(second.access_key.replace("key", "token"));
});

test("test_transcribe_signs_with_configured_keys_as_given", async () => {
  noConfiguredKeys();
  let providerCalls = 0;
  const service: Any = new AWSTranscribeSTTService({
    apiKey: "secret",
    awsAccessKeyId: "key",
    awsSessionToken: "token",
    credentialsProvider: () => {
      providerCalls++;
      return { accessKeyId: "x", secretAccessKey: "y" };
    },
  });

  const credentials = await service._signingCredentials();

  expect(credentials).toEqual({ access_key: "key", secret_key: "secret", session_token: "token" });
  expect(providerCalls).toBe(0);
});

test("test_transcribe_without_any_credentials_raises", async () => {
  noConfiguredKeys();
  const service: Any = new AWSTranscribeSTTService({
    credentialsProvider: async () => null as unknown as AWSCredentialIdentity,
  });

  await expect(service._signingCredentials()).rejects.toThrow("No AWS credentials found");

  const noProvider: Any = new AWSTranscribeSTTService();
  await expect(noProvider._signingCredentials()).rejects.toThrow("No AWS credentials found");
});
