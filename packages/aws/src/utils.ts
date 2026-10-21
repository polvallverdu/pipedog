// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/services/aws/utils.py

/**
 * AWS utility functions for Pipecat services.
 *
 * This module provides shared credential resolution and AWS Transcribe utilities
 * for creating presigned URLs, building event messages, and handling AWS event
 * stream protocol for real-time transcription services.
 *
 * Porting notes:
 * - SigV4 runs on WebCrypto (`sigv4.ts`), which is asynchronous, so
 *   `getPresignedUrl()` and `AWSTranscribePresignedURL.getRequestUrl()` return
 *   promises. Both accept an optional `date` (a pipedog addition) so signatures
 *   can be checked against fixed vectors.
 * - DIVERGENCE: there is no botocore default credential chain (instance
 *   profiles, IRSA, ECS roles, SSO, credential files). Keys come from the
 *   parameters or the environment, as upstream; beyond that, services accept a
 *   `credentialsProvider` function (see `aws_session.ts`), which renews
 *   temporary credentials the way an aiobotocore session does.
 * - `decodeEvent` throws `EventStreamError` where upstream's `assert` raises
 *   `AssertionError`.
 */

import { getEnv } from "@pipedog/core/utils/env";
import { pyJsonLoads } from "@pipedog/core/utils/py_json";
import { crc32, decodeEventStreamMessage, EventStreamError } from "./event_stream.ts";
import { amzDate, getSigningKey, sha256Hex, signHex, uriEscape } from "./sigv4.ts";

export interface AWSCredentialsOptions {
  accessKey: string | null;
  secretKey: string | null;
  sessionToken: string | null;
  region: string;
}

/** Resolved AWS credentials ready for use by any AWS service. */
export class AWSCredentials {
  accessKey: string | null;
  secretKey: string | null;
  sessionToken: string | null;
  region: string;

  constructor(options: AWSCredentialsOptions) {
    this.accessKey = options.accessKey;
    this.secretKey = options.secretKey;
    this.sessionToken = options.sessionToken;
    this.region = options.region;
  }
}

export interface ResolveCredentialsOptions {
  /** Explicit access key ID. */
  awsAccessKeyId?: string | null;
  /** Explicit secret access key. */
  awsSecretAccessKey?: string | null;
  /** Explicit session token. */
  awsSessionToken?: string | null;
  /** Explicit AWS region. */
  region?: string | null;
}

/**
 * Resolve AWS credentials from explicit parameters and the environment.
 *
 * Resolution order:
 *
 * 1. Explicit parameters
 * 2. Environment variables (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`,
 *    `AWS_SESSION_TOKEN`, `AWS_REGION`)
 *
 * When neither supplies keys, `accessKey` and `secretKey` are `null` and the
 * caller falls back to its `credentialsProvider`, if any.
 *
 * @returns An `AWSCredentials` instance. `accessKey` and `secretKey` are `null`
 *   when neither the parameters nor the environment supply them.
 */
export function resolveCredentials(options: ResolveCredentialsOptions = {}): AWSCredentials {
  const accessKey = options.awsAccessKeyId || getEnv("AWS_ACCESS_KEY_ID") || null;
  const secretKey = options.awsSecretAccessKey || getEnv("AWS_SECRET_ACCESS_KEY") || null;
  const sessionToken = options.awsSessionToken || getEnv("AWS_SESSION_TOKEN") || null;
  const resolvedRegion = options.region || (getEnv("AWS_REGION") ?? "us-east-1");

  return new AWSCredentials({
    accessKey,
    secretKey,
    sessionToken,
    region: resolvedRegion,
  });
}

/** Keys to sign a Transcribe URL with. */
export interface PresignCredentials {
  access_key?: string | null;
  secret_key?: string | null;
  session_token?: string | null;
}

export interface GetPresignedUrlOptions {
  /** AWS region for the service. */
  region: string;
  /** AWS credentials: `access_key` and `secret_key`, with optional `session_token`. */
  credentials: PresignCredentials;
  /** Language code for transcription (e.g., "en-US"). */
  languageCode: string;
  /** Audio encoding format. Defaults to "pcm". */
  mediaEncoding?: string;
  /** Audio sample rate in Hz. Defaults to 16000. */
  sampleRate?: number;
  /** Number of audio channels. Defaults to 1. */
  numberOfChannels?: number;
  /** Whether to enable partial result stabilization. */
  enablePartialResultsStabilization?: boolean;
  /** Stability level for partial results. */
  partialResultsStability?: string;
  /** Custom vocabulary name to use. */
  vocabularyName?: string | null;
  /** Vocabulary filter name to apply. */
  vocabularyFilterName?: string | null;
  /** Whether to include speaker labels. */
  showSpeakerLabel?: boolean;
  /** Whether to enable channel identification. */
  enableChannelIdentification?: boolean;
  /** Signing time (pipedog addition; defaults to now). */
  date?: Date;
}

/**
 * Create a presigned URL for AWS Transcribe streaming.
 *
 * @returns Presigned WebSocket URL for AWS Transcribe streaming.
 * @throws Error If required AWS credentials are missing.
 */
export async function getPresignedUrl(options: GetPresignedUrlOptions): Promise<string> {
  const accessKey = options.credentials.access_key;
  const secretKey = options.credentials.secret_key;
  const sessionToken = options.credentials.session_token ?? null;

  if (!accessKey || !secretKey) {
    throw new Error("AWS credentials are required");
  }

  // Initialize the URL generator
  const urlGenerator = new AWSTranscribePresignedURL({
    accessKey,
    secretKey,
    sessionToken,
    region: options.region,
  });

  // Get the presigned URL
  return urlGenerator.getRequestUrl({
    sampleRate: options.sampleRate ?? 16000,
    languageCode: options.languageCode,
    mediaEncoding: options.mediaEncoding ?? "pcm",
    vocabularyName: options.vocabularyName ?? null,
    vocabularyFilterName: options.vocabularyFilterName ?? null,
    showSpeakerLabel: options.showSpeakerLabel ?? false,
    enableChannelIdentification: options.enableChannelIdentification ?? false,
    numberOfChannels: options.numberOfChannels ?? 1,
    enablePartialResultsStabilization: options.enablePartialResultsStabilization ?? true,
    partialResultsStability: options.partialResultsStability ?? "high",
    date: options.date,
  });
}

export interface AWSTranscribePresignedURLOptions {
  /** AWS access key ID. */
  accessKey: string;
  /** AWS secret access key. */
  secretKey: string;
  /** AWS session token for temporary credentials (optional). */
  sessionToken: string | null;
  /** AWS region for the service. Defaults to "us-east-1". */
  region?: string;
}

export interface GetRequestUrlOptions {
  sampleRate: number;
  languageCode?: string;
  mediaEncoding?: string;
  vocabularyName?: string | null;
  vocabularyFilterName?: string | null;
  showSpeakerLabel?: boolean;
  enableChannelIdentification?: boolean;
  numberOfChannels?: number;
  enablePartialResultsStabilization?: boolean;
  partialResultsStability?: string;
  /** Signing time (pipedog addition; defaults to now). */
  date?: Date;
}

/**
 * Generator for AWS Transcribe presigned WebSocket URLs.
 *
 * Handles AWS Signature Version 4 signing process to create authenticated
 * WebSocket URLs for streaming transcription requests.
 */
export class AWSTranscribePresignedURL {
  accessKey: string;
  secretKey: string;
  sessionToken: string | null;
  method = "GET";
  service = "transcribe";
  region: string;
  endpoint = "";
  host = "";
  amzDate = "";
  datestamp = "";
  canonicalUri = "/stream-transcription-websocket";
  canonicalHeaders = "";
  signedHeaders = "host";
  algorithm = "AWS4-HMAC-SHA256";
  credentialScope = "";
  canonicalQuerystring = "";
  payloadHash = "";
  canonicalRequest = "";
  stringToSign = "";
  signature = "";
  requestUrl = "";

  constructor(options: AWSTranscribePresignedURLOptions) {
    this.accessKey = options.accessKey;
    this.secretKey = options.secretKey;
    this.sessionToken = options.sessionToken;
    this.region = options.region ?? "us-east-1";
  }

  /**
   * Generate a presigned WebSocket URL for AWS Transcribe.
   *
   * @returns Presigned WebSocket URL with authentication parameters.
   */
  async getRequestUrl(options: GetRequestUrlOptions): Promise<string> {
    const languageCode = options.languageCode ?? "";
    const mediaEncoding = options.mediaEncoding ?? "pcm";
    const numberOfChannels = options.numberOfChannels ?? 1;
    const partialResultsStability = options.partialResultsStability ?? "";

    this.endpoint = `wss://transcribestreaming.${this.region}.amazonaws.com:8443`;
    this.host = `transcribestreaming.${this.region}.amazonaws.com:8443`;

    const now = options.date ?? new Date();
    this.amzDate = amzDate(now);
    this.datestamp = this.amzDate.slice(0, 8);
    this.canonicalHeaders = `host:${this.host}\n`;
    this.credentialScope = `${this.datestamp}%2F${this.region}%2F${this.service}%2Faws4_request`;

    // Create canonical querystring
    let qs = `X-Amz-Algorithm=${this.algorithm}`;
    qs += `&X-Amz-Credential=${this.accessKey}%2F${this.credentialScope}`;
    qs += `&X-Amz-Date=${this.amzDate}`;
    qs += "&X-Amz-Expires=300";
    if (this.sessionToken) {
      qs += `&X-Amz-Security-Token=${uriEscape(this.sessionToken)}`;
    }
    qs += `&X-Amz-SignedHeaders=${this.signedHeaders}`;

    if (options.enableChannelIdentification) {
      qs += "&enable-channel-identification=true";
    }
    if (options.enablePartialResultsStabilization) {
      qs += "&enable-partial-results-stabilization=true";
    }
    if (languageCode) {
      qs += `&language-code=${languageCode}`;
    }
    if (mediaEncoding) {
      qs += `&media-encoding=${mediaEncoding}`;
    }
    if (numberOfChannels > 1) {
      qs += `&number-of-channels=${numberOfChannels}`;
    }
    if (partialResultsStability) {
      qs += `&partial-results-stability=${partialResultsStability}`;
    }
    if (options.sampleRate) {
      qs += `&sample-rate=${options.sampleRate}`;
    }
    if (options.showSpeakerLabel) {
      qs += "&show-speaker-label=true";
    }
    if (options.vocabularyFilterName) {
      qs += `&vocabulary-filter-name=${options.vocabularyFilterName}`;
    }
    if (options.vocabularyName) {
      qs += `&vocabulary-name=${options.vocabularyName}`;
    }
    this.canonicalQuerystring = qs;

    // Create payload hash
    this.payloadHash = await sha256Hex("");

    // Create canonical request
    this.canonicalRequest = `${this.method}\n${this.canonicalUri}\n${this.canonicalQuerystring}\n${this.canonicalHeaders}\n${this.signedHeaders}\n${this.payloadHash}`;

    // Create string to sign
    const credentialScope = `${this.datestamp}/${this.region}/${this.service}/aws4_request`;
    this.stringToSign = `${this.algorithm}\n${this.amzDate}\n${credentialScope}\n${await sha256Hex(this.canonicalRequest)}`;

    // Calculate signature
    const kSigning = await getSigningKey(this.secretKey, this.datestamp, this.region, this.service);
    this.signature = await signHex(kSigning, this.stringToSign);

    // Add signature to query string
    this.canonicalQuerystring += `&X-Amz-Signature=${this.signature}`;

    // Create request URL
    this.requestUrl = `${this.endpoint}${this.canonicalUri}?${this.canonicalQuerystring}`;
    return this.requestUrl;
  }
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Build a header following AWS event stream format.
 *
 * @param headerName Name of the header.
 * @param headerValue Value of the header.
 * @returns Encoded header following AWS event stream protocol.
 */
export function getHeaders(headerName: string, headerValue: string): Uint8Array {
  const name = encoder.encode(headerName);
  const value = encoder.encode(headerValue);
  const out = new Uint8Array(1 + name.length + 1 + 2 + value.length);
  out[0] = name.length;
  out.set(name, 1);
  out[1 + name.length] = 7; // 7 represents a string
  new DataView(out.buffer).setUint16(2 + name.length, value.length);
  out.set(value, 4 + name.length);
  return out;
}

/**
 * Build an event message for AWS Transcribe streaming.
 *
 * Creates a properly formatted AWS event stream message containing audio data
 * for real-time transcription. Follows the AWS event stream protocol with
 * prelude, headers, payload, and CRC checksums.
 *
 * Implementation matches AWS sample:
 * https://github.com/aws-samples/amazon-transcribe-streaming-python-websockets/blob/main/eventstream.py
 *
 * @param payload Raw audio bytes to include in the event message.
 * @returns Complete event message, ready to send via WebSocket.
 */
export function buildEventMessage(payload: Uint8Array): Uint8Array {
  // Build headers
  const parts = [
    getHeaders(":content-type", "application/octet-stream"),
    getHeaders(":event-type", "AudioEvent"),
    getHeaders(":message-type", "event"),
  ];
  const headersLength = parts.reduce((n, p) => n + p.length, 0);

  // 16 accounts for 8 byte prelude, 2x 4 byte CRCs
  const total = headersLength + payload.length + 16;
  const message = new Uint8Array(total);
  const view = new DataView(message.buffer);
  view.setUint32(0, total);
  view.setUint32(4, headersLength);
  view.setUint32(8, crc32(message.subarray(0, 8)));
  let offset = 12;
  for (const p of parts) {
    message.set(p, offset);
    offset += p.length;
  }
  message.set(payload, offset);
  view.setUint32(total - 4, crc32(message.subarray(0, total - 4)));
  return message;
}

/**
 * Decode an AWS event stream message.
 *
 * Parses an AWS event stream message to extract headers and payload,
 * verifying CRC checksums for data integrity.
 *
 * @param message Raw event stream message bytes received from AWS.
 * @returns A tuple of `[headers, payload]`: the string headers and the parsed
 *   JSON payload.
 * @throws EventStreamError If CRC checksum verification fails.
 */
export function decodeEvent(message: Uint8Array): [Record<string, string>, unknown] {
  const decoded = decodeEventStreamMessage(message);
  const headersDict: Record<string, string> = {};
  for (const [name, header] of Object.entries(decoded.headers)) {
    if (header.type !== "string") {
      throw new EventStreamError(`Unexpected ${header.type} header ${name}`);
    }
    headersDict[name] = header.value;
  }
  return [headersDict, pyJsonLoads(decoder.decode(decoded.body))];
}
