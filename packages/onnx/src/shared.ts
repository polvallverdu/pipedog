// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Inference sessions shared across callers: one session per backend, model and
 * options. A voice bot creates its VAD and turn analyzers once per call, and each
 * would otherwise load its own copy of the model (tens of MB per call).
 *
 * Sharing is safe for models that keep no state between runs. Silero VAD passes
 * its recurrent state in and out as tensors, and Smart Turn is stateless, so one
 * session serves every call. onnxruntime-web can't run a session concurrently,
 * so runs on a non-native backend are serialized; runs are short (well under a
 * millisecond for a VAD chunk), so queueing them costs little.
 *
 * A shared session ignores `dispose()`, since other callers use it. Release all
 * of them with `disposeSharedSessions()`.
 */

import type { OnnxBackend, OnnxModelSource, OnnxSession, OnnxSessionOptions } from "./backend.ts";

interface BackendSessions {
  /** Models given by path or URL, by `<model>\n<options>`. */
  byName: Map<string, Promise<OnnxSession>>;
  /** Models given as bytes, by the bytes' identity, then by options. */
  byBytes: WeakMap<object, Map<string, Promise<OnnxSession>>>;
}

let sessions = new WeakMap<OnnxBackend, BackendSessions>();
/** Every shared session, so `disposeSharedSessions()` can reach them. */
const all = new Set<Promise<OnnxSession>>();

/** The runtime that runs sessions concurrently without serializing. */
const CONCURRENT_BACKEND = "onnxruntime-node";

function optionsKey(options: OnnxSessionOptions): string {
  return JSON.stringify(
    Object.fromEntries(Object.entries(options).sort(([a], [b]) => a.localeCompare(b))),
  );
}

function sharedView(session: OnnxSession, serialize: boolean): OnnxSession {
  let tail: Promise<unknown> = Promise.resolve();
  return {
    inputNames: session.inputNames,
    outputNames: session.outputNames,
    run(feeds) {
      if (!serialize) return session.run(feeds);
      const result = tail.then(() => session.run(feeds));
      tail = result.catch(() => {});
      return result;
    },
    // Other callers hold this session; disposeSharedSessions() releases it.
    async dispose() {},
  };
}

/**
 * The shared session for `model` on `backend` with `options`, created on first
 * use. A failed load isn't cached, so the next call retries.
 */
export function sharedSession(
  backend: OnnxBackend,
  model: OnnxModelSource,
  options: OnnxSessionOptions = {},
): Promise<OnnxSession> {
  let entry = sessions.get(backend);
  if (!entry) {
    entry = { byName: new Map(), byBytes: new WeakMap() };
    sessions.set(backend, entry);
  }

  const key = optionsKey(options);
  let table: Map<string, Promise<OnnxSession>>;
  let tableKey: string;
  if (typeof model === "string" || model instanceof URL) {
    table = entry.byName;
    tableKey = `${model instanceof URL ? model.href : model}\n${key}`;
  } else {
    // By the object passed in: two views of one buffer can hold different models.
    let perBytes = entry.byBytes.get(model);
    if (!perBytes) {
      perBytes = new Map();
      entry.byBytes.set(model, perBytes);
    }
    table = perBytes;
    tableKey = key;
  }

  const existing = table.get(tableKey);
  if (existing) return existing;

  const raw = backend.createSession(model, options);
  const created = raw.then((session) => sharedView(session, backend.name !== CONCURRENT_BACKEND));
  table.set(tableKey, created);
  all.add(raw);
  raw.catch(() => {
    table.delete(tableKey);
    all.delete(raw);
  });
  return created;
}

/** Release every shared session. Later calls to `sharedSession` load the models again. */
export async function disposeSharedSessions(): Promise<void> {
  const pending = [...all];
  all.clear();
  sessions = new WeakMap();
  for (const session of pending) {
    try {
      await (await session).dispose();
    } catch {
      // A session that failed to load has nothing to release.
    }
  }
}
