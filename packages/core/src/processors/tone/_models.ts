// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/processors/tone/_models.py

/** Pipecat Tone's models, loaded once a process and shared by every call. */

import { abortable, rethrowIfCancelled } from "@pipedog/asyncio";
import type { FrameProcessor } from "../frame_processor.ts";

/**
 * What identifies a model and its settings. Upstream keys are hashable tuples such as
 * `("reader", revision, precision, threads)`; here they are arrays of JSON values,
 * compared by their JSON form.
 */
export type Hashable = string | number | boolean | null | readonly Hashable[];

// DIVERGENCE: upstream stores loaded models under a threading.Lock and loads them with
// asyncio.to_thread. There are no threads here, so the map holds the in-flight load
// (a promise): concurrent callers for the same key share one load, as the lock makes
// them do upstream, and a failed load is dropped so the next call tries again.
export const _models = new Map<string, Promise<unknown>>();

function _shared<M>(key: Hashable, load: () => M | Promise<M>): Promise<M> {
  const k = JSON.stringify(key);
  let model = _models.get(k) as Promise<M> | undefined;
  if (model === undefined) {
    model = (async () => await load())();
    _models.set(k, model);
    model.catch(() => {
      if (_models.get(k) === model) {
        _models.delete(k);
      }
    });
  }
  return model;
}

/**
 * Load a model off the event loop, or share the one already loaded for `key`.
 *
 * A model that can't be loaded is reported as an error that leaves the
 * processor unusable, and the next call tries again.
 *
 * @param processor The processor the model is for.
 * @param key What identifies the model and its settings.
 * @param load Loads the model, downloading its files the first time.
 * @returns The model, or null when it can't be loaded.
 */
export async function loadModel<M>(
  processor: FrameProcessor,
  key: Hashable,
  load: () => M | Promise<M>,
): Promise<M | null> {
  try {
    // asyncio.to_thread is a cancellation point and resumes the caller through the loop;
    // abortable() keeps both.
    return await abortable(_shared(key, load));
  } catch (e) {
    rethrowIfCancelled(e);
    const msg = e instanceof Error ? e.message : String(e);
    await processor.pushError(`${processor}: couldn't load its model: ${msg}`, {
      exception: e,
      forceTreatAsPermanent: true,
    });
    return null;
  }
}
