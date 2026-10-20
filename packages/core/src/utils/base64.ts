// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Base64 without `Buffer` (which core cannot use), with the semantics of
 * Python's `base64.b64encode` / `base64.b64decode`.
 */

/** `base64.b64encode(data).decode()`. */
export function bytesToBase64(data: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < data.length; i += chunk) {
    binary += String.fromCharCode(...data.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/** `base64.b64decode(encoded)`: characters outside the alphabet are discarded (`validate=False`). */
export function base64ToBytes(encoded: string): Uint8Array<ArrayBuffer> {
  const binary = atob(encoded.replace(/[^A-Za-z0-9+/=]/g, ""));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}
