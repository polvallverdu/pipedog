// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipecat-ts contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_redaction.py

/** Unit tests for pipecat.utils.security.redaction.redact_secrets. */

import { describe, expect, test } from "bun:test";

import { ErrorFrame } from "../src/frames/frames.ts";
import { redactSecrets } from "../src/utils/security/redaction.ts";

describe("TestRedactSecrets", () => {
  test("test_masks_a_credential_in_a_printed_header_dict", () => {
    const message =
      "Sarvam API error: headers: {'api-subscription-key': 'sk_live_abc123', " +
      "'User-Agent': 'sarvamai/0.1.28'}, status_code: 429";
    expect(redactSecrets(message)).toEqual(
      "Sarvam API error: headers: {'api-subscription-key': '[REDACTED]', " +
        "'User-Agent': 'sarvamai/0.1.28'}, status_code: 429",
    );
  });

  test("test_masks_a_presigned_urls_credentials_and_keeps_the_rest", () => {
    const message =
      "Timed out fetching file from URL: 'https://bucket.s3.amazonaws.com/doc.pdf" +
      "?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAEXAMPLE%2F20261014" +
      "&X-Amz-Signature=deadbeef&X-Amz-Security-Token=FQoGZXIvYXdz'";
    expect(redactSecrets(message)).toEqual(
      "Timed out fetching file from URL: 'https://bucket.s3.amazonaws.com/doc.pdf" +
        "?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=[REDACTED]" +
        "&X-Amz-Signature=[REDACTED]&X-Amz-Security-Token=[REDACTED]'",
    );
  });

  test("test_masks_a_key_in_a_query_string", () => {
    expect(
      redactSecrets("wss://api.example.com/ws?api_key=SECRET&version=v1 isn't a valid URI"),
    ).toEqual("wss://api.example.com/ws?api_key=[REDACTED]&version=v1 isn't a valid URI");
  });

  test("test_keeps_an_auth_scheme_and_masks_its_credential", () => {
    expect(redactSecrets("Authorization: Bearer abc123")).toEqual(
      "Authorization: Bearer [REDACTED]",
    );
  });

  test("test_masks_a_camel_case_credential_name", () => {
    expect(redactSecrets("apiKey=foo, accessToken: bar")).toEqual(
      "apiKey=[REDACTED], accessToken: [REDACTED]",
    );
  });

  test("test_masks_a_urls_password", () => {
    expect(redactSecrets("Could not connect to redis://default:hunter2@redis:6379/0")).toEqual(
      "Could not connect to redis://default:[REDACTED]@redis:6379/0",
    );
  });

  test("test_masks_tokens_recognizable_by_format", () => {
    expect(
      redactSecrets(
        "rejected sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA for AKIAIOSFODNN7EXAMPLE " +
          "joining https://acme.daily.co/room?t=eyJhbGciOiJIUzI1NiJ9.eyJyIjoicm9vbSJ9." +
          "c2lnbmF0dXJl",
      ),
    ).toEqual("rejected [REDACTED] for [REDACTED] joining https://acme.daily.co/room?t=[REDACTED]");
  });

  test("test_masks_each_provider_token_format", () => {
    for (const token of [
      `sk-proj-${"a".repeat(74)}T3BlbkFJ${"b".repeat(74)}`, // OpenAI
      `ABIA${"A".repeat(16)}`, // AWS
      `ABSK${"a".repeat(120)}==`, // Amazon Bedrock, long-lived
      `bedrock-api-key-YmVkcm9jay5hbWF6b25hd3MuY29t${"a".repeat(40)}`, // short-lived
      `AIza${"a".repeat(35)}`, // Google
      `github_pat_${"a".repeat(82)}`, // GitHub
      `xapp-1-A0123456789-0123456789012-${"a".repeat(64)}`, // Slack
      `hf_${"a".repeat(34)}`, // Hugging Face
      `pplx-${"a".repeat(48)}`, // Perplexity
      `SK${"0".repeat(32)}`, // Twilio
      "eyJhbGciOiJub25lIn0.eyJzdWIiOiIxMjM0NSJ9.", // unsigned JWT
    ]) {
      // subTest(token=token[:20])
      expect([token.slice(0, 20), redactSecrets(`failed with ${token} here`)]).toEqual([
        token.slice(0, 20),
        "failed with [REDACTED] here",
      ]);
    }
  });

  test("test_masks_a_slack_webhooks_secret_path", () => {
    expect(redactSecrets(`posting to https://hooks.slack.com/services/${"a".repeat(44)}`)).toEqual(
      "posting to https://hooks.slack.com/services/[REDACTED]",
    );
  });

  test("test_masks_a_multiline_private_key", () => {
    const pem = "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0B\n-----END PRIVATE KEY-----";
    expect(redactSecrets(`{"private_key": "${pem}", "client_email": "svc@x"}`)).toEqual(
      '{"private_key": "[REDACTED]", "client_email": "svc@x"}',
    );
  });

  test("test_masks_a_value_after_any_assignment_separator", () => {
    expect(redactSecrets("apiKey := abc123, 'secret' => 'def456', creds=ghi789")).toEqual(
      "apiKey := [REDACTED], 'secret' => '[REDACTED]', creds=[REDACTED]",
    );
  });

  test("test_masks_an_aws_signature_authorization_header", () => {
    expect(
      redactSecrets(
        "Authorization: AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20261014/" +
          "us-east-1/s3/aws4_request, SignedHeaders=host, Signature=fe5f80f77d5fa3be",
      ),
    ).toEqual(
      "Authorization: AWS4-HMAC-SHA256 [REDACTED], SignedHeaders=host, Signature=[REDACTED]",
    );
  });

  test("test_masks_a_quoted_value_cut_short_by_truncation", () => {
    expect(redactSecrets("PGMQueue(host='db', password='hunter2...")).toEqual(
      "PGMQueue(host='db', password='[REDACTED]",
    );
  });

  test("test_masks_a_resumable_upload_session_id", () => {
    expect(redactSecrets("https://example.googleapis.com/upload/files?upload_id=ABC123")).toEqual(
      "https://example.googleapis.com/upload/files?upload_id=[REDACTED]",
    );
  });

  test("test_leaves_a_message_without_credentials_as_written", () => {
    for (const message of [
      "wss://api.elevenlabs.io/v1/speech-to-text?model_id=scribe&keyterms=pipecat",
      "Error code: 400 - {'error': {'message': 'max_tokens: 100 is too low'}}",
      'Cartesia API error (status 400): {"error": "bad voice", "voice_id": "abc"}',
      "Error: timeout at 12:30",
      "",
    ]) {
      // subTest(message=message)
      expect(redactSecrets(message)).toEqual(message);
    }
  });

  test("test_redacting_twice_reads_the_same_as_redacting_once", () => {
    const message =
      "Failed to fetch file from URL 'https://x/a?sig=abc&se=2026': 403, " +
      "url='https://x/a?sig=abc&se=2026' Authorization: Bearer abc";
    const once = redactSecrets(message);
    expect(redactSecrets(once)).toEqual(once);
  });
});

describe("TestErrorFrameRedaction", () => {
  test("test_an_error_frame_masks_the_credentials_its_message_quotes", () => {
    const frame = new ErrorFrame({
      error: "Sarvam API error: headers: {'api-subscription-key': 'k'}",
    });
    expect(frame.error).toEqual(
      "Sarvam API error: headers: {'api-subscription-key': '[REDACTED]'}",
    );
  });
});
