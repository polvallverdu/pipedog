// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/**
 * The backend interface: everything pipedog's ONNX models need from a runtime.
 *
 * Models load from bytes or a path/URL, run with named float32/int64 tensors,
 * and are disposed when done. Implementations wrap onnxruntime-node (native),
 * onnxruntime-web (WASM) and onnxruntime-web on Cloudflare Workers; anything
 * else that satisfies `OnnxBackend` can be passed in instead.
 */

/** Element types the models use. */
export type OnnxTensorType = "float32" | "int64";

/** A tensor: row-major data plus its dimensions. */
export interface OnnxTensor {
  type: OnnxTensorType;
  data: Float32Array | BigInt64Array;
  dims: readonly number[];
}

/** A model: its bytes, or a filesystem path / `file:` / `http(s):` URL to read them from. */
export type OnnxModelSource = Uint8Array | ArrayBuffer | string | URL;

/** Session options common to every backend (unsupported ones are ignored). */
export interface OnnxSessionOptions {
  /** Run on the CPU only (`cpu` on onnxruntime-node, `wasm` on onnxruntime-web). */
  forceCpu?: boolean;
  intraOpNumThreads?: number;
  interOpNumThreads?: number;
  executionMode?: "sequential" | "parallel";
  graphOptimizationLevel?: "disabled" | "basic" | "extended" | "all";
}

/** An inference session for one model. */
export interface OnnxSession {
  readonly inputNames: readonly string[];
  readonly outputNames: readonly string[];
  /** Run the model; returns every output by name. */
  run(feeds: Record<string, OnnxTensor>): Promise<Record<string, OnnxTensor>>;
  /** Release the session's native/WASM memory. */
  dispose(): Promise<void>;
}

/** Creates inference sessions. */
export interface OnnxBackend {
  /** Which runtime this is, e.g. `onnxruntime-node` or `onnxruntime-web`. */
  readonly name: string;
  createSession(model: OnnxModelSource, options?: OnnxSessionOptions): Promise<OnnxSession>;
}

/** A float32 tensor. */
export function float32Tensor(data: Float32Array, dims: readonly number[]): OnnxTensor {
  return { type: "float32", data, dims };
}

/** An int64 tensor. */
export function int64Tensor(data: BigInt64Array, dims: readonly number[]): OnnxTensor {
  return { type: "int64", data, dims };
}

// ---------------------------------------------------------------------------
// onnxruntime adapters. Structural types for the part of the onnxruntime JS
// API we use (shared by onnxruntime-node and onnxruntime-web), so this package
// type-checks and imports without either installed.

/** @internal */
export interface OrtTensorLike {
  type: string;
  data: unknown;
  dims: readonly number[];
}

/** @internal */
export interface OrtSessionLike {
  readonly inputNames: readonly string[];
  readonly outputNames: readonly string[];
  run(feeds: Record<string, OrtTensorLike>): Promise<Record<string, OrtTensorLike>>;
  release(): Promise<void>;
}

/** The part of an `onnxruntime-node` / `onnxruntime-web` module the backends use. */
export interface OrtModuleLike {
  InferenceSession: {
    create(model: Uint8Array | string, options?: Record<string, unknown>): Promise<unknown>;
  };
  Tensor: new (
    type: string,
    data: Float32Array | BigInt64Array,
    dims: readonly number[],
  ) => OrtTensorLike;
  env: any;
}

/** onnxruntime session options for `options` and the given CPU execution provider. */
export function ortSessionOptions(
  options: OnnxSessionOptions,
  cpuProvider: string,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (options.forceCpu) out.executionProviders = [cpuProvider];
  if (options.intraOpNumThreads !== undefined) out.intraOpNumThreads = options.intraOpNumThreads;
  if (options.interOpNumThreads !== undefined) out.interOpNumThreads = options.interOpNumThreads;
  if (options.executionMode !== undefined) out.executionMode = options.executionMode;
  if (options.graphOptimizationLevel !== undefined)
    out.graphOptimizationLevel = options.graphOptimizationLevel;
  return out;
}

/** Wrap an onnxruntime session in the `OnnxSession` interface. */
export function wrapOrtSession(ort: OrtModuleLike, session: OrtSessionLike): OnnxSession {
  return {
    inputNames: session.inputNames,
    outputNames: session.outputNames,
    async run(feeds) {
      const ortFeeds: Record<string, OrtTensorLike> = {};
      for (const [name, t] of Object.entries(feeds)) {
        ortFeeds[name] = new ort.Tensor(t.type, t.data, t.dims);
      }
      const results = await session.run(ortFeeds);
      const out: Record<string, OnnxTensor> = {};
      for (const [name, t] of Object.entries(results)) {
        out[name] = {
          type: t.type as OnnxTensorType,
          data: t.data as Float32Array | BigInt64Array,
          dims: t.dims,
        };
      }
      return out;
    },
    dispose: () => session.release(),
  };
}
