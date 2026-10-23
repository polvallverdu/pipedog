// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Which Cloudflare data centre a Durable Object runs in. A Durable Object has no `request.cf` of its
// own location, so it asks: `/cdn-cgi/trace` answers with the data centre the request came from,
// one `key=value` per line, `colo=` among them. Fetched once per isolate.

/** Parse `colo=` out of a `/cdn-cgi/trace` body. */
export function parseTraceColo(body: string): string | null {
  for (const line of body.split("\n")) {
    const [key, value] = line.split("=", 2);
    if (key?.trim() === "colo" && value?.trim()) return value.trim().toUpperCase();
  }
  return null;
}

let cached: Promise<string | null> | null = null;

/** This isolate's data centre, or null if the trace can't be had (logged once, not thrown). */
export function durableObjectColo(
  url: string,
  doFetch: typeof fetch = fetch,
): Promise<string | null> {
  if (cached) return cached;
  const attempt = (async () => {
    try {
      const response = await doFetch(url, { signal: AbortSignal.timeout(3000) });
      if (!response.ok) return null;
      return parseTraceColo(await response.text());
    } catch {
      return null;
    }
  })();
  cached = attempt;
  // Only a known colo is kept: a failure is tried again next time.
  attempt.then((colo) => {
    if (colo === null && cached === attempt) cached = null;
  });
  return attempt;
}

/** Forget the cached colo (tests). */
export function clearColoCache(): void {
  cached = null;
}
