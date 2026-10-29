// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
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
 *   header dicts and plain prose alike. An exception class name followed by
 *   its message (`KeyError: ...`) is not a credential name.
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

// The start of a `name=value` or `name: value` pair (or `:=`, `=>`), the name
// optionally quoted as in a printed dict. An auth scheme (`Bearer`, `Basic`...)
// ahead of the value is kept.
const PAIR_START = new RegExp(
  String.raw`(?<name>(?<![\w.-])(?<nq>["']?)[A-Za-z][\w.-]*\k<nq>)` +
    String.raw`(?<sep>\s*(?::=|=>|[:=])\s*)` +
    String.raw`(?<scheme>(?:Bearer|Basic|Token|Api-Token|Key|Digest|AWS4-HMAC-SHA256)\s+)?`,
  "g",
);

// Sticky variant of PAIR_START, for Python's `_PAIR_START.match(text, pos)`.
const PAIR_START_AT = new RegExp(PAIR_START.source, "y");

// A pair's value, quoted or running to the next delimiter. A quoted value cut
// short before its closing quote, as a truncated repr leaves it, runs to the
// next delimiter instead. A value already redacted is matched whole, so text
// redacted twice reads the same as text redacted once.
const VALUE = new RegExp(
  String.raw`(?<vq>["'])(?<quoted>.*?)\k<vq>` +
    String.raw`|(?<oq>["']?)(?<bare>(?:\[REDACTED\]|[^\s,;&"'}\])\[])+)`,
  "y",
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

// An exception or warning class name, optionally module-qualified (`KeyError`,
// `jwt.exceptions.InvalidTokenError`). It names what went wrong, so the text
// after it is the explanation, not a credential.
const EXCEPTION_NAME = /^(?:[a-z_][a-z0-9_]*\.)*[A-Z][A-Za-z0-9]*(?:Error|Exception|Warning)$/;

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

function isExceptionName(match: RegExpExecArray): boolean {
  const g = match.groups ?? {};
  return !g.nq && !g.scheme && (g.sep ?? "").trim() === ":" && EXCEPTION_NAME.test(g.name ?? "");
}

function masksValue(start: RegExpExecArray): boolean {
  return isCredentialName(start.groups?.name ?? "") && !isExceptionName(start);
}

function matchAt(re: RegExp, text: string, pos: number): RegExpExecArray | null {
  re.lastIndex = pos;
  return re.exec(text);
}

function matchEnd(m: RegExpExecArray): number {
  return m.index + m[0].length;
}

function redactPairs(text: string): string {
  // Only a credential's value is taken whole. Any other pair's value is read on
  // as ordinary text, so the pairs it holds (`URL: https://...?token=...`,
  // `error: Authorization: Bearer ...`) are found in place.
  const out: string[] = [];
  let pos = 0;
  for (;;) {
    const start = matchAt(PAIR_START, text, pos);
    if (!start) break;
    const startEnd = matchEnd(start);
    const value = masksValue(start) ? matchAt(VALUE, text, startEnd) : null;
    // A credential's value that is only the next credential's name, as
    // `token:` is in `api_key: token: abc`, gives way to that credential.
    const following = value ? matchAt(PAIR_START_AT, text, startEnd) : null;
    if (!value || (following && masksValue(following) && matchEnd(following) > matchEnd(value))) {
      out.push(text.slice(pos, startEnd));
      pos = startEnd;
      continue;
    }
    const quote = value.groups?.vq || "";
    out.push(`${text.slice(pos, startEnd)}${quote || value.groups?.oq || ""}${REDACTED}${quote}`);
    pos = matchEnd(value);
  }
  out.push(text.slice(pos));
  return out.join("");
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
