// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipecat-ts contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/utils/security/redaction.py

/**
 * Masks credentials in text bound for logs and error reports.
 *
 * Error messages often quote whatever a failure carried: an SDK exception that
 * prints the headers it sent, a URL signed for one download, a provider body
 * echoing the key it rejected. `redactSecrets` masks the credential and keeps
 * the rest, so a message still says what went wrong.
 *
 * It masks three things:
 *
 * - The value of any `name=value` or `name: value` pair, quoted or not,
 *   whose name marks a credential (`api_key`, `Authorization`,
 *   `X-Amz-Signature`, `apiKey`...). This covers query strings, printed
 *   header dicts and plain prose alike.
 * - A URL's password (`scheme://user:password@host`).
 * - Tokens recognizable by their format alone: provider key prefixes, AWS
 *   access key IDs and JWTs.
 */

export const REDACTED = "[REDACTED]";

// A name marks a credential when one of its words is one of these, so
// `x-api-key` and `X-Amz-Security-Token` do while `keyterms` and `max_tokens`
// don't.
const CREDENTIAL_WORDS: ReadonlySet<string> = new Set([
  "apikey",
  "auth",
  "authorization",
  "cookie",
  "credential",
  "credentials",
  "creds",
  "jwt",
  "key",
  "passwd",
  "password",
  "pwd",
  "secret",
  "sig",
  "signature",
  "token",
  // Google's resumable upload session ID, which authorizes the upload by itself.
  "uploadid",
]);

// `name=value` or `name: value` (or `:=`, `=>`), the name optionally quoted as
// in a printed dict, the value quoted or running to the next delimiter. A
// quoted value cut short before its closing quote, as a truncated repr leaves
// it, runs to the next delimiter instead. An auth scheme (`Bearer`, `Basic`...)
// ahead of the value is kept. A value already redacted is matched whole, so
// text redacted twice reads the same as text redacted once.
const PAIR = new RegExp(
  String.raw`(?<name>(?<![\w.-])(?<nq>["']?)[A-Za-z][\w.-]*\k<nq>)` +
    String.raw`(?<sep>\s*(?::=|=>|[:=])\s*)` +
    String.raw`(?<scheme>(?:Bearer|Basic|Token|Api-Token|Key|Digest|AWS4-HMAC-SHA256)\s+)?` +
    String.raw`(?:(?<vq>["'])(?<quoted>.*?)\k<vq>` +
    String.raw`|(?<oq>["']?)(?<bare>(?:\[REDACTED\]|[^\s,;&"'}\])\[])+))`,
  "g",
);

const URL_PASSWORD = /(?<prefix>\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s/@]+(?=@)/gi;

// Formats after gitleaks' rules for the same credentials
// (github.com/gitleaks/gitleaks, config/gitleaks.toml), loosened where a
// looser match costs nothing: a log line is masked, not scanned for findings.
const KNOWN_TOKENS = new RegExp(
  String.raw`\b(?:` +
    String.raw`sk-[A-Za-z0-9_-]{20,}` + // OpenAI, Anthropic
    String.raw`|(?:A3T[A-Z0-9]|AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16}` + // AWS access key IDs
    String.raw`|ABSK[A-Za-z0-9+/]{109,269}={0,2}` + // Amazon Bedrock API keys, long-lived
    String.raw`|bedrock-api-key-[A-Za-z0-9+/=_-]+` + // Amazon Bedrock API keys, short-lived
    String.raw`|AIza[0-9A-Za-z_-]{35}` + // Google API keys
    String.raw`|gh[pousr]_[A-Za-z0-9]{36,}|github_pat_\w{82,}` + // GitHub
    String.raw`|xox[abeoprs]-[A-Za-z0-9-]{10,}|xapp-\d-[A-Za-z0-9-]{10,}` + // Slack
    // Slack webhooks, whose path is the secret
    String.raw`|(?:(?<=hooks\.slack\.com/services/)|(?<=hooks\.slack\.com/workflows/)` +
    String.raw`|(?<=hooks\.slack\.com/triggers/))[A-Za-z0-9+/]{20,}` +
    String.raw`|(?:hf|api_org)_[A-Za-z]{34}` + // Hugging Face
    String.raw`|pplx-[A-Za-z0-9]{48}` + // Perplexity
    String.raw`|SK[0-9a-fA-F]{32}` + // Twilio API keys
    String.raw`|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*` + // JWTs, signed or not
    String.raw`)` +
    // A PEM private key, through its END line or, cut short, the end of the text.
    String.raw`|-----BEGIN[ A-Z0-9_-]{0,100}PRIVATE KEY(?: BLOCK)?-----` +
    String.raw`(?:[\s\S]*?-----END[ A-Z0-9_-]{0,100}PRIVATE KEY(?: BLOCK)?-----|[\s\S]*)`,
  "g",
);

interface PairGroups {
  name: string;
  nq: string | undefined;
  sep: string;
  scheme: string | undefined;
  vq: string | undefined;
  quoted: string | undefined;
  oq: string | undefined;
  bare: string | undefined;
}

function stripQuotes(name: string): string {
  return name.replace(/^["']+/, "").replace(/["']+$/, "");
}

function isCredentialName(name: string): boolean {
  const words = stripQuotes(name)
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase();
  const parts = words.split(/[-_.]/).filter((p) => p);
  return CREDENTIAL_WORDS.has(parts.join("")) || parts.some((p) => CREDENTIAL_WORDS.has(p));
}

function redactPairs(text: string): string {
  // String.prototype.replace collects every match before calling the
  // replacer, so recursing with the same global regex is safe.
  return text.replace(PAIR, (...args: unknown[]) =>
    redactPair(args[args.length - 1] as PairGroups),
  );
}

function redactPair(match: PairGroups): string {
  const quote = match.vq || "";
  let value: string;
  if (isCredentialName(match.name)) {
    value = REDACTED;
  } else {
    // The value may itself hold pairs, as `URL: https://...?token=...` does.
    value = redactPairs(match.quoted || match.bare || "");
  }
  const opening = match.oq || "";
  return `${match.name}${match.sep}${match.scheme || ""}${quote || opening}${value}${quote}`;
}

/**
 * Mask the credentials in `text`, leaving the rest as written.
 *
 * @param text Text that may quote a credential, such as an error message.
 * @returns The text with each credential replaced by `[REDACTED]`.
 */
export function redactSecrets(text: string): string {
  // Known formats go first: a PEM key spans lines, and masking its first line
  // as a pair's value would leave the rest unrecognizable.
  text = text.replace(KNOWN_TOKENS, REDACTED);
  text = redactPairs(text);
  return text.replace(URL_PASSWORD, `$<prefix>${REDACTED}`);
}
