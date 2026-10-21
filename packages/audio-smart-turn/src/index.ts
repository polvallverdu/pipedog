// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Smart Turn v3 with a real ONNX runtime.
 *
 * Core's `LocalSmartTurnAnalyzerV3` (a port of upstream's) takes an injected
 * session factory and has no runtime of its own. This package wires it to an
 * `@pipedog/onnx` backend and the upstream `smart-turn-v3.2-cpu.onnx` model,
 * which ships in `data/` and is the default on Bun, Node and Deno. On
 * Cloudflare Workers pass the model's bytes (R2, KV, static assets or fetch).
 *
 * @example
 * ```ts
 * import { createLocalSmartTurnAnalyzerV3 } from "@pipedog/audio-smart-turn";
 * const turnAnalyzer = createLocalSmartTurnAnalyzerV3();
 * ```
 */

import {
  LocalSmartTurnAnalyzerV3,
  type LocalSmartTurnAnalyzerV3Options,
  type SmartTurnSessionFactory,
} from "@pipedog/core/audio/turn/smart_turn/local_smart_turn_v3";
import {
  createOnnxBackend,
  float32Tensor,
  type OnnxBackend,
  type OnnxModelSource,
  sharedSession,
} from "@pipedog/onnx";

/** The upstream model file name. */
export const SMART_TURN_MODEL_NAME = "smart-turn-v3.2-cpu.onnx";

/**
 * The model shipped with this package (`data/smart-turn-v3.2-cpu.onnx`), as a URL.
 *
 * Readable on Bun, Node and Deno. On Cloudflare Workers there is no
 * filesystem: pass the model's bytes instead.
 */
export function defaultSmartTurnModelUrl(): URL {
  return new URL(`../data/${SMART_TURN_MODEL_NAME}`, import.meta.url);
}

export interface OnnxSmartTurnSessionFactoryOptions {
  /** The model: bytes, a path or a URL. Default: the factory's `modelPath` argument. */
  model?: OnnxModelSource;
  /** The ONNX backend (default: `createOnnxBackend()`). */
  backend?: OnnxBackend | Promise<OnnxBackend>;
  /**
   * Share one inference session across analyzers for the same backend, model
   * and options (default `true`). The model is stateless, so sharing is safe;
   * it loads the model once instead of once per call.
   */
  shareSession?: boolean;
}

/**
 * A `createSession` for core's `LocalSmartTurnAnalyzerV3` backed by `@pipedog/onnx`.
 *
 * The analyzer's session options (threads, sequential execution, full graph
 * optimization) are passed through to the backend.
 */
export function onnxSmartTurnSessionFactory(
  options: OnnxSmartTurnSessionFactoryOptions = {},
): SmartTurnSessionFactory {
  return async (modelPath, sessionOptions) => {
    const backend = await (options.backend ?? createOnnxBackend());
    const model = options.model ?? modelPath;
    const session =
      options.shareSession === false
        ? await backend.createSession(model, sessionOptions)
        : await sharedSession(backend, model, sessionOptions);
    const output = session.outputNames[0] as string;
    return {
      async run(feeds) {
        const { data, dims } = feeds.input_features;
        const result = await session.run({ input_features: float32Tensor(data, dims) });
        return result[output]!.data as Float32Array;
      },
    };
  };
}

export interface CreateLocalSmartTurnAnalyzerV3Options
  extends Omit<LocalSmartTurnAnalyzerV3Options, "createSession"> {
  /**
   * The Smart Turn model: bytes, a path or a URL. Defaults to
   * `smartTurnModelPath` if set, else the model shipped with this package.
   * Required on Cloudflare Workers.
   */
  model?: OnnxModelSource;
  /** The ONNX backend (default: `createOnnxBackend()`). */
  backend?: OnnxBackend | Promise<OnnxBackend>;
  /** Share the inference session across analyzers (default `true`). */
  shareSession?: boolean;
}

/**
 * Create core's `LocalSmartTurnAnalyzerV3` with an ONNX runtime and model.
 *
 * Without `model` or `smartTurnModelPath` it uses the upstream
 * `smart-turn-v3.2-cpu.onnx` shipped with this package.
 */
export function createLocalSmartTurnAnalyzerV3(
  options: CreateLocalSmartTurnAnalyzerV3Options = {},
): LocalSmartTurnAnalyzerV3 {
  const { model, backend, shareSession, ...analyzerOptions } = options;
  let source: OnnxModelSource | undefined = model;
  let label = analyzerOptions.smartTurnModelPath ?? undefined;
  if (source === undefined && !label) {
    source = defaultSmartTurnModelUrl();
  }
  if (!label) {
    label =
      typeof source === "string"
        ? source
        : source instanceof URL
          ? source.href
          : SMART_TURN_MODEL_NAME;
  }
  return new LocalSmartTurnAnalyzerV3({
    ...analyzerOptions,
    smartTurnModelPath: label,
    createSession: onnxSmartTurnSessionFactory({ model: source, backend, shareSession }),
  });
}

export {
  HttpSmartTurnAnalyzer,
  type HttpSmartTurnAnalyzerOptions,
  serializeNpy,
} from "./smart_turn/http_smart_turn.ts";
export { LocalSmartTurnAnalyzerV3 };
