// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/**
 * The Azure Speech service's WebSocket message format, shared by the STT and
 * TTS services.
 *
 * Upstream drives the Speech service through the Speech SDK
 * (`azure-cognitiveservices-speech`), a native library. This module speaks the
 * same wire protocol the SDKs use, so the services run on any runtime with
 * `fetch` and `WebSocket`. The format follows `WebsocketMessageFormatter` and
 * `SpeechConnectionMessage` in the JS Speech SDK
 * (`microsoft-cognitiveservices-speech-sdk`):
 *
 * - A text message is `Header: value\r\n` lines, an empty line, and the body.
 * - A binary message is a 2-byte big-endian header length, the headers (ASCII),
 *   and the body.
 * - Every message carries `Path`, `X-RequestId` and `X-Timestamp`; audio sent
 *   to the service also carries `Content-Type` on its first (WAV header)
 *   chunk.
 */

import { rethrowIfCancelled } from "@pipedog/asyncio";

const CRLF = "\r\n";

/** A message received from (or sent to) the Speech service. */
export interface SpeechMessage {
  /** Header names, lowercased. */
  headers: Record<string, string>;
  /** The `Path` header, lowercased. */
  path: string;
  /** The `X-RequestId` header, or "". */
  requestId: string;
  /** The text body (text messages). */
  text: string | null;
  /** The binary body (binary messages). */
  binary: Uint8Array | null;
}

/** A request id or connection id: a UUID without dashes, uppercase, as the SDK makes. */
export function createNoDashGuid(): string {
  return crypto.randomUUID().replaceAll("-", "").toUpperCase();
}

/**
 * The host suffix for a region: `.azure.cn` for China, `.azure.us` for US
 * Government, `.microsoft.com` otherwise (the SDK's `getHostSuffix`).
 */
export function speechHostSuffix(region: string | null | undefined): string {
  if (region) {
    const lower = region.toLowerCase();
    if (lower.startsWith("china")) return ".azure.cn";
    if (lower.startsWith("usgov")) return ".azure.us";
  }
  return ".microsoft.com";
}

function makeHeaders(path: string, requestId: string, extra: Record<string, string>): string {
  const headers: Record<string, string> = {
    Path: path,
    "X-RequestId": requestId,
    "X-Timestamp": new Date().toISOString(),
    ...extra,
  };
  let out = "";
  for (const [name, value] of Object.entries(headers)) {
    out += `${name}: ${value}${CRLF}`;
  }
  return out;
}

/**
 * Build a text message.
 *
 * @param path The `Path` header (e.g. "speech.config").
 * @param requestId The `X-RequestId` header.
 * @param contentType The `Content-Type` header.
 * @param body The message body.
 */
export function buildTextMessage(
  path: string,
  requestId: string,
  contentType: string,
  body: string,
): string {
  return `${makeHeaders(path, requestId, { "Content-Type": contentType })}${CRLF}${body}`;
}

/**
 * Build a binary message.
 *
 * @param path The `Path` header (e.g. "audio").
 * @param requestId The `X-RequestId` header.
 * @param body The binary body, or null for an empty one (end of stream).
 * @param contentType The `Content-Type` header, if any.
 */
export function buildBinaryMessage(
  path: string,
  requestId: string,
  body: Uint8Array | null,
  contentType: string | null = null,
): Uint8Array {
  const extra: Record<string, string> = {};
  if (contentType) extra["Content-Type"] = contentType;
  const headers = makeHeaders(path, requestId, extra);
  const headerBytes = new Uint8Array(headers.length);
  for (let i = 0; i < headers.length; i++) headerBytes[i] = headers.charCodeAt(i) & 0xff;
  const out = new Uint8Array(2 + headerBytes.length + (body ? body.length : 0));
  out[0] = (headerBytes.length >> 8) & 0xff;
  out[1] = headerBytes.length & 0xff;
  out.set(headerBytes, 2);
  if (body) out.set(body, 2 + headerBytes.length);
  return out;
}

function parseHeaders(raw: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    if (!line) continue;
    const sep = line.indexOf(":");
    if (sep > 0) {
      headers[line.slice(0, sep).trim().toLowerCase()] = line.slice(sep + 1).trim();
    } else {
      headers[line.toLowerCase()] = "";
    }
  }
  return headers;
}

/**
 * Parse a message received from the service.
 *
 * @param data A text or binary WebSocket message.
 * @returns The parsed message.
 * @throws Error if a binary message is shorter than its header length says.
 */
export function parseSpeechMessage(data: string | Uint8Array): SpeechMessage {
  let headers: Record<string, string>;
  let text: string | null = null;
  let binary: Uint8Array | null = null;
  if (typeof data === "string") {
    const split = data.indexOf(`${CRLF}${CRLF}`);
    if (split === -1) {
      headers = parseHeaders(data);
    } else {
      headers = parseHeaders(data.slice(0, split));
      text = data.slice(split + 4);
    }
  } else {
    if (data.length < 2) {
      throw new Error("Invalid binary message format. Header length missing.");
    }
    const headerLength = (data[0]! << 8) | data[1]!;
    if (data.length < headerLength + 2) {
      throw new Error("Invalid binary message format. Header content missing.");
    }
    let raw = "";
    for (let i = 0; i < headerLength; i++) raw += String.fromCharCode(data[i + 2]!);
    headers = parseHeaders(raw);
    binary = data.length > headerLength + 2 ? data.subarray(2 + headerLength) : null;
  }
  return {
    headers,
    path: (headers.path ?? "").toLowerCase(),
    requestId: headers["x-requestid"] ?? "",
    text,
    binary,
  };
}

/**
 * A 44-byte RIFF/WAV header for a PCM stream of unknown length (sizes 0), as
 * the SDK sends before the audio of every recognition turn.
 *
 * @param sampleRate Samples per second.
 * @param channels Number of channels.
 * @param bitsPerSample Bits per sample.
 */
export function wavStreamHeader(sampleRate: number, channels = 1, bitsPerSample = 16): Uint8Array {
  const header = new Uint8Array(44);
  const view = new DataView(header.buffer);
  const writeAscii = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) header[offset + i] = s.charCodeAt(i);
  };
  const blockAlign = (channels * bitsPerSample) / 8;
  writeAscii(0, "RIFF");
  view.setUint32(4, 0, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  writeAscii(36, "data");
  view.setUint32(40, 0, true);
  return header;
}

/** The `speech.config` body: who the client is. */
export function speechConfigBody(recognition?: string): Record<string, unknown> {
  const body: Record<string, unknown> = {
    context: {
      system: { name: "pipedog", version: "1.0.0", build: "JavaScript", lang: "JavaScript" },
      os: { platform: "JavaScript", name: "pipedog", version: "1.0.0" },
    },
  };
  if (recognition) body.recognition = recognition;
  return body;
}

/**
 * Append the query string to a URL. The SDK sends the auth key and connection
 * id both as headers and as query parameters, since a browser `WebSocket`
 * cannot set headers.
 */
export function withQuery(url: string, params: Record<string, string>): string {
  let out = url;
  let first = !url.includes("?");
  for (const [key, value] of Object.entries(params)) {
    out += `${first ? "?" : "&"}${encodeURIComponent(key)}=${encodeURIComponent(value)}`;
    first = false;
  }
  return out;
}

/**
 * Resolve a custom-domain endpoint the way the SDK does: ask the endpoint for
 * its redirect (`GenerateRedirectResponse=true`), and keep the original URL if
 * it has none.
 *
 * @param endpoint The endpoint, with its path.
 * @param fetchFn `fetch` to use.
 * @param useWebSocketProtocol Whether to return a `ws(s):` URL.
 */
export async function getRedirectUrlFromEndpoint(
  endpoint: string,
  fetchFn: typeof fetch,
  useWebSocketProtocol = true,
): Promise<string> {
  const redirectUrl = new URL(endpoint);
  redirectUrl.protocol = "https:";
  redirectUrl.port = "";
  redirectUrl.searchParams.append("GenerateRedirectResponse", "true");
  let response: Response;
  try {
    response = await fetchFn(redirectUrl.toString());
  } catch (e) {
    rethrowIfCancelled(e);
    return endpoint;
  }
  if (response.status !== 200) {
    return endpoint;
  }
  const text = (await response.text()).trim();
  try {
    const url = new URL(text);
    if (useWebSocketProtocol) {
      if (url.protocol === "https:") url.protocol = "wss:";
      else if (url.protocol === "http:") url.protocol = "ws:";
    }
    return url.toString();
  } catch {
    return endpoint;
  }
}
