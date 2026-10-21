// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/**
 * A small stand-in for the aiobotocore session the upstream services hold:
 * it knows the region and where keys come from, and signs `fetch` requests
 * with SigV4.
 *
 * Keys come, in order, from the explicit options, the environment
 * (`resolveCredentials`), and a `credentialsProvider` function. The provider
 * is called for every request, so it can hand out renewed temporary
 * credentials (for example `fromNodeProviderChain()` from
 * `@aws-sdk/credential-providers`, which caches and refreshes them). There is
 * no built-in default chain: without keys or a provider, signing throws.
 */

import { type AWSCredentialIdentity, signRequest } from "./sigv4.ts";
import { type AWSCredentials, resolveCredentials } from "./utils.ts";

export type { AWSCredentialIdentity } from "./sigv4.ts";

/** Returns the keys to sign the next request with. Called once per request. */
export type AWSCredentialsProvider = () => AWSCredentialIdentity | Promise<AWSCredentialIdentity>;

/** A `fetch`-compatible function. */
export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface AWSSessionOptions {
  /** Explicit or environment keys and the region (from `resolveCredentials`). */
  credentials: AWSCredentials;
  /** Keys to use when none are configured; called for every request. */
  credentialsProvider?: AWSCredentialsProvider | null;
  /** `fetch` to send requests with (defaults to the global `fetch`). */
  fetch?: FetchLike | null;
}

/** Options shared by every AWS service for credentials and transport. */
export interface AWSClientOptions {
  /**
   * Keys to sign with when none are passed in or set in the environment.
   * Called for every request or connection, so it can renew temporary
   * credentials.
   */
  credentialsProvider?: AWSCredentialsProvider | null;
  /** `fetch` used for HTTP calls (defaults to the global `fetch`). */
  fetch?: FetchLike | null;
  /** Override the service endpoint (e.g. a VPC endpoint or a local fake), `https://host[:port]`. */
  endpointUrl?: string | null;
}

/** A failed AWS HTTP call, with the status and AWS error code when known. */
export class AWSServiceError extends Error {
  override name = "AWSServiceError";
  /** HTTP status code. */
  readonly status: number;
  /** AWS error code (`x-amzn-ErrorType` / `__type`, e.g. `ValidationException`). */
  readonly code: string | null;
  /** Response body as text. */
  readonly body: string;

  constructor(options: { status: number; code: string | null; message: string; body: string }) {
    super(options.message);
    this.status = options.status;
    this.code = options.code;
    this.body = options.body;
  }

  /** Same shape as `botocore`'s `ClientError.response` for the fields services read. */
  get response(): { Error: { Code: string | null; Message: string }; status_code: number } {
    return { Error: { Code: this.code, Message: this.message }, status_code: this.status };
  }

  /** HTTP status, so `extractHttpStatusCode` from core recognizes it. */
  get statusCode(): number {
    return this.status;
  }
}

/** Build an `AWSServiceError` from a non-2xx response. */
export async function awsErrorFromResponse(response: Response): Promise<AWSServiceError> {
  const body = await response.text().catch(() => "");
  let code = response.headers.get("x-amzn-errortype");
  let message = "";
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    code ??= (parsed.__type as string | undefined) ?? (parsed.code as string | undefined) ?? null;
    message = String(parsed.message ?? parsed.Message ?? "");
  } catch {
    message = body;
  }
  if (code?.includes(":")) code = code.split(":")[0] as string;
  if (code?.includes("#")) code = code.split("#").pop() as string;
  return new AWSServiceError({
    status: response.status,
    code: code ?? null,
    message: `${code ?? "Error"} (HTTP ${response.status}): ${message}`,
    body,
  });
}

/** Options for one signed request. */
export interface AWSRequestOptions {
  /** SigV4 service name (e.g. `bedrock`, `polly`, `bedrock-agentcore`). */
  service: string;
  /** Full URL, with the path escaped as it goes on the wire. */
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string | Uint8Array | null;
  signal?: AbortSignal | null;
}

/** Region, keys and a signing `fetch` for one service instance. */
export class AWSSession {
  readonly credentials: AWSCredentials;
  #provider: AWSCredentialsProvider | null;
  #fetch: FetchLike | null;

  constructor(options: AWSSessionOptions) {
    this.credentials = options.credentials;
    this.#provider = options.credentialsProvider ?? null;
    this.#fetch = options.fetch ?? null;
  }

  /** Build a session from service options (explicit keys, environment, provider). */
  static fromOptions(
    options: {
      awsAccessKeyId?: string | null;
      awsSecretAccessKey?: string | null;
      awsSessionToken?: string | null;
      region?: string | null;
    } & AWSClientOptions,
  ): AWSSession {
    return new AWSSession({
      credentials: resolveCredentials({
        awsAccessKeyId: options.awsAccessKeyId,
        awsSecretAccessKey: options.awsSecretAccessKey,
        awsSessionToken: options.awsSessionToken,
        region: options.region,
      }),
      credentialsProvider: options.credentialsProvider,
      fetch: options.fetch,
    });
  }

  /** The region requests go to. */
  get region(): string {
    return this.credentials.region;
  }

  /** Whether keys were passed in or found in the environment. */
  get hasConfiguredKeys(): boolean {
    return Boolean(this.credentials.accessKey || this.credentials.secretKey);
  }

  /**
   * The keys to sign the next request with: configured keys as given, else
   * the provider's current keys.
   *
   * @throws Error If no keys are configured and there is no provider (or it returns none).
   */
  async getCredentials(): Promise<AWSCredentialIdentity> {
    if (this.hasConfiguredKeys) {
      return {
        accessKeyId: this.credentials.accessKey ?? "",
        secretAccessKey: this.credentials.secretKey ?? "",
        sessionToken: this.credentials.sessionToken,
      };
    }
    const provided = this.#provider ? await this.#provider() : null;
    if (!provided?.accessKeyId || !provided.secretAccessKey) {
      throw new Error("No AWS credentials found in the parameters, environment or chain.");
    }
    return provided;
  }

  /** Send a SigV4-signed request and return the raw response (any status). */
  async request(options: AWSRequestOptions): Promise<Response> {
    const credentials = await this.getCredentials();
    const signed = await signRequest({
      method: options.method ?? "POST",
      url: options.url,
      headers: options.headers,
      body: options.body ?? null,
      service: options.service,
      region: this.region,
      credentials,
    });
    // `fetch` sets `host` itself (and some runtimes refuse it).
    delete signed.host;
    const fetchFn = this.#fetch ?? (globalThis.fetch as FetchLike);
    return fetchFn(options.url, {
      method: options.method ?? "POST",
      headers: signed,
      body: (options.body ?? undefined) as BodyInit | undefined,
      signal: options.signal ?? undefined,
    });
  }

  /** Like `request`, but throws `AWSServiceError` on a non-2xx status. */
  async requestOk(options: AWSRequestOptions): Promise<Response> {
    const response = await this.request(options);
    if (!response.ok) throw await awsErrorFromResponse(response);
    return response;
  }
}

/** `https://<prefix>.<region>.amazonaws.com`, or the override. */
export function awsEndpoint(prefix: string, region: string, override?: string | null): string {
  if (override) return override.replace(/\/+$/, "");
  return `https://${prefix}.${region}.amazonaws.com`;
}
