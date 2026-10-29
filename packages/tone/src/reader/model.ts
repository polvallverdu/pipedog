// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/processors/tone/reader/model.py

/**
 * Pipecat Tone's reader model, on the CPU.
 *
 * Runs on `@pipedog/onnx` (onnxruntime-node or onnxruntime-web) with
 * `@huggingface/tokenizers` (pure JS) in place of Python's `onnxruntime` and
 * `tokenizers`; `huggingface_hub.snapshot_download` becomes a download of the
 * model's files from Hugging Face into `modelCacheDir("tone")`.
 *
 * DIVERGENCE: upstream loads the model in its constructor. Loading is async
 * here, so use `PipecatToneReaderModel.load(modelDir, options)` (or
 * `PipecatToneReaderModel.download(options)`), and `tag()` returns a Promise.
 */

import { Tokenizer } from "@huggingface/tokenizers";
import {
  createOnnxBackend,
  downloadModelFile,
  int64Tensor,
  loadModelBytes,
  modelCacheDir,
  type OnnxBackend,
  type OnnxSession,
  type OnnxSessionOptions,
  type OnnxTensor,
} from "@pipedog/onnx";

export const TONE_REPO = "pipecat-ai/tone-models";
export const TONE_REVISION = "reader-rc1";

const _FOLDER = "reader";

const _MODEL_FILES = { fp16: "model_fp16.onnx", fp32: "model.opt.onnx" } as const;

/** The weights' precision. */
export type PipecatToneReaderPrecision = keyof typeof _MODEL_FILES;

/** The emotion the model reads in a turn. */
export interface PipecatToneReaderEmotionTag {
  label: string;
  intensity: string;
  confidence: number;
  probabilities: Record<string, number>;
}

/** The move a turn makes. */
export interface PipecatToneReaderMoveTag {
  label: string;
  confidence: number;
  probabilities: Record<string, number>;
}

/** Whether a turn is sarcastic. */
export interface PipecatToneReaderSarcasmTag {
  sarcastic: boolean;
  probability: number;
}

/** Whether a turn is only a listening sound. */
export interface PipecatToneReaderBackchannelTag {
  is_backchannel: boolean;
  probability: number;
}

/** The model's tags for one turn, in its own form (upstream's dict, keys unchanged). */
export interface PipecatToneReaderTags {
  emotion: PipecatToneReaderEmotionTag;
  move: PipecatToneReaderMoveTag;
  sarcasm: PipecatToneReaderSarcasmTag;
  backchannel: PipecatToneReaderBackchannelTag;
}

/** A Platt curve: `sigmoid(a * logit(p) + b)`. */
interface PlattCurve {
  a: number;
  b: number;
}

export interface PipecatToneReaderModelOptions {
  /**
   * `"fp16"` for the weights in 16 bits, which give the same tags at half the
   * size, or `"fp32"`. Default `"fp16"`.
   */
  precision?: PipecatToneReaderPrecision;
  /** The CPU threads for one read. Default 4. */
  threads?: number;
  /** The ONNX backend (default: `createOnnxBackend()`). */
  backend?: OnnxBackend | Promise<OnnxBackend>;
}

export interface PipecatToneReaderModelDownloadOptions extends PipecatToneReaderModelOptions {
  /** The model's revision. Default `TONE_REVISION`. */
  revision?: string;
  /**
   * Where downloaded files are kept. Default: `modelCacheDir("tone")`, i.e.
   * `~/.cache/pipedog/tone`.
   */
  downloadRoot?: string | null;
  /** Hugging Face endpoint (default: `$HF_ENDPOINT` or `https://huggingface.co`). */
  endpoint?: string | null;
  /** `fetch` for downloads (default: the global `fetch`). */
  fetch?: typeof fetch;
}

/** Pipecat Tone's reader model, on the CPU. */
export class PipecatToneReaderModel {
  // `config.json` is arbitrary JSON (a Python dict upstream), so `any` is genuine.
  readonly config: Record<string, any>;
  readonly _tokenizer: Tokenizer;
  readonly _session: OnnxSession;
  readonly _emotionTemperature: number;
  readonly _moveTemperature: number;
  readonly _sarcasmCurve: PlattCurve | null;
  readonly _sarcasmThreshold: number;

  /**
   * Use a loaded model. Prefer `PipecatToneReaderModel.load()` or
   * `PipecatToneReaderModel.download()`.
   *
   * @param config The model's `config.json`.
   * @param tokenizer The model's tokenizer.
   * @param session The model's inference session.
   */
  constructor(config: Record<string, any>, tokenizer: Tokenizer, session: OnnxSession) {
    this.config = config;
    this._tokenizer = tokenizer;
    this._session = session;
    const calibration = this.config.calibration || {};
    this._emotionTemperature = Number(calibration.emotion_temperature ?? 1.0);
    this._moveTemperature = Number(calibration.move_temperature ?? 1.0);
    this._sarcasmCurve = calibration.sarcasm ?? null;
    this._sarcasmThreshold = Number(this.config.sarcasm_tau_raw ?? 0.5);
  }

  /**
   * Load the model from a folder.
   *
   * @param modelDir A folder (a path or an `http(s):`/`file:` URL) with the
   *   model's `config.json`, `tokenizer.json` and ONNX file.
   * @param options `precision` (`"fp16"` for the weights in 16 bits, which give
   *   the same tags at half the size, or `"fp32"`), `threads` (the CPU threads
   *   for one read) and the ONNX `backend`.
   * @returns The model.
   */
  static async load(
    modelDir: string | URL,
    options: PipecatToneReaderModelOptions = {},
  ): Promise<PipecatToneReaderModel> {
    const precision = options.precision ?? "fp16";
    const threads = options.threads ?? 4;
    const file = (name: string) => _join(modelDir, name);
    const config = await _readJson(file("config.json"));
    // Truncation (`enable_truncation(max_len)`) is applied in `_encode`, and
    // tokenizers.js never pads (`no_padding()`).
    const tokenizer = new Tokenizer(await _readJson(file("tokenizer.json")), {});
    const sessionOptions: OnnxSessionOptions = {
      forceCpu: true,
      intraOpNumThreads: threads,
      interOpNumThreads: 1,
    };
    const backend = await (options.backend ?? createOnnxBackend());
    const session = await backend.createSession(file(_MODEL_FILES[precision]), sessionOptions);
    return new PipecatToneReaderModel(config, tokenizer, session);
  }

  /**
   * Load the model from Hugging Face, downloading its files the first time.
   *
   * @param options `revision` (the model's revision), `precision` (`"fp16"` or
   *   `"fp32"`), `threads` (the CPU threads for one read), and where and how to
   *   download.
   * @returns The model.
   */
  static async download(
    options: PipecatToneReaderModelDownloadOptions = {},
  ): Promise<PipecatToneReaderModel> {
    const revision = options.revision ?? TONE_REVISION;
    const precision = options.precision ?? "fp16";
    const files = ["config.json", "tokenizer.json", _MODEL_FILES[precision]];
    const root = options.downloadRoot ?? (await modelCacheDir("tone"));
    const local = `${root}/${TONE_REPO.replace("/", "--")}@${revision}`;
    const endpoint = (options.endpoint ?? _env("HF_ENDPOINT") ?? "https://huggingface.co").replace(
      /\/+$/,
      "",
    );
    for (const name of files) {
      const path = `${_FOLDER}/${name}`;
      await downloadModelFile(
        `${endpoint}/${TONE_REPO}/resolve/${encodeURIComponent(revision)}/${path}`,
        `${local}/${path}`,
        { fetch: options.fetch },
      );
    }
    return PipecatToneReaderModel.load(`${local}/${_FOLDER}`, options);
  }

  /** The emotions the model reads. */
  get emotions(): string[] {
    return this.config.emotions;
  }

  /**
   * Read one turn.
   *
   * @param text The turn.
   * @param previous The turn before it, if there is one.
   * @returns The model's tags, in its own form: `emotion`, `move`, `sarcasm`
   *   and `backchannel`.
   */
  async tag(text: string, previous: string | null = null): Promise<PipecatToneReaderTags> {
    let rendered = `"${_strip(text)}"`;
    if (previous && _strip(previous)) {
      rendered += ` Before: "${_strip(previous)}"`;
    }
    const ids = this._encode(rendered);
    const inputs: Record<string, OnnxTensor> = {
      input_ids: int64Tensor(
        BigInt64Array.from(ids, (id) => BigInt(id)),
        [1, ids.length],
      ),
      attention_mask: int64Tensor(new BigInt64Array(ids.length).fill(1n), [1, ids.length]),
    };
    const results = await this._session.run(inputs);
    // Upstream zips config["outputs"] with the session's outputs, in the model's order.
    const outputs: Record<string, number[]> = {};
    const names: string[] = this.config.outputs;
    names.forEach((name, i) => {
      const outputName = this._session.outputNames[i];
      const result = outputName !== undefined ? results[outputName] : undefined;
      if (result) outputs[name] = _firstRow(result);
    });

    const emotions = _softmax(outputs.emotion as number[], this._emotionTemperature);
    const moves = _softmax(outputs.move as number[], this._moveTemperature);
    const emotion: string = this.config.emotions[_argmax(emotions)];
    const intensity: string =
      this.config.intensities[_argmax(_softmax(outputs.emotion_intensity as number[]))];
    const rawSarcasm = _softmax(outputs.sarcasm as number[])[1] as number;
    const backchannel = _softmax(outputs.backchannel as number[])[1] as number;
    return {
      emotion: {
        label: emotion,
        intensity: emotion === "neutral" ? "low" : intensity,
        confidence: _round(Math.max(...emotions), 4),
        probabilities: _probabilities(this.config.emotions, emotions),
      },
      move: {
        label: this.config.moves[_argmax(moves)],
        confidence: _round(Math.max(...moves), 4),
        probabilities: _probabilities(this.config.moves, moves),
      },
      sarcasm: {
        sarcastic: rawSarcasm >= this._sarcasmThreshold,
        probability: _round(_platt(rawSarcasm, this._sarcasmCurve), 4),
      },
      backchannel: {
        is_backchannel: backchannel >= 0.5,
        probability: _round(backchannel, 4),
      },
    };
  }

  /**
   * Token ids for `text`, truncated to `config.max_len` as Python's
   * `tokenizer.enable_truncation(max_len)` does: the text's tokens are cut on
   * the right so that, with the special tokens added, they fit.
   */
  _encode(text: string): number[] {
    const maxLen: number = this.config.max_len;
    const full = this._tokenizer.encode(text);
    if (maxLen === undefined || maxLen === null || full.ids.length <= maxLen) return full.ids;
    const plain = this._tokenizer.encode(text, { add_special_tokens: false });
    const specials = full.ids.length - plain.ids.length;
    const kept = plain.tokens.slice(0, Math.max(0, maxLen - specials));
    // tokenizers.js has no truncation: re-run its post-processor on the kept tokens.
    // `post_processor` and `model.unk_token_id` exist at runtime but are not in
    // @huggingface/tokenizers' public types, hence the casts.
    const postProcessor = (
      this._tokenizer as unknown as {
        post_processor:
          | ((tokens: string[], pair: string[] | null, addSpecial: boolean) => { tokens: string[] })
          | null;
      }
    ).post_processor;
    const tokens = postProcessor ? postProcessor(kept, null, true).tokens : kept;
    const unk = (this._tokenizer.model as unknown as { unk_token_id?: number } | null)
      ?.unk_token_id;
    return tokens.map((t) => this._tokenizer.token_to_id(t) ?? unk ?? 0);
  }
}

function _env(name: string): string | undefined {
  const value = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
    ?.env?.[name];
  return value ? value : undefined;
}

function _join(dir: string | URL, name: string): string {
  return `${String(dir).replace(/[\\/]+$/, "")}/${name}`;
}

// Parsed JSON is genuinely dynamic (a Python dict upstream).
async function _readJson(source: string): Promise<Record<string, any>> {
  const bytes = await loadModelBytes(source);
  return JSON.parse(new TextDecoder().decode(bytes));
}

/** Python's `str.strip()`: Unicode whitespace on both ends. */
function _strip(s: string): string {
  return s.replace(_PY_STRIP, "");
}

// Python's `str.isspace()` characters: JS `\s` plus U+001C-U+001F and U+0085,
// minus U+FEFF (which JS counts as whitespace and Python does not).
const _PY_WS =
  "\\t\\n\\v\\f\\r \\u001c-\\u001f\\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const _PY_STRIP = new RegExp(`^[${_PY_WS}]+|[${_PY_WS}]+$`, "gu");

/** `result[0]`: the first row of a batched output, as numbers. */
function _firstRow(tensor: OnnxTensor): number[] {
  const rowLength = tensor.dims.slice(1).reduce((a, b) => a * b, 1);
  const out: number[] = new Array(rowLength);
  for (let i = 0; i < rowLength; i++) out[i] = Number(tensor.data[i]);
  return out;
}

/** numpy's `argmax`: the index of the first largest value. */
function _argmax(values: readonly number[]): number {
  let best = 0;
  for (let i = 1; i < values.length; i++) {
    if ((values[i] as number) > (values[best] as number)) best = i;
  }
  return best;
}

function _softmax(logits: readonly number[], temperature = 1.0): number[] {
  const z = logits.map((x) => x / temperature);
  const max = Math.max(...z);
  const e = z.map((x) => Math.exp(x - max));
  const sum = e.reduce((a, b) => a + b, 0);
  return e.map((x) => x / sum);
}

function _probabilities(
  labels: readonly string[],
  probabilities: readonly number[],
): Record<string, number> {
  const out: Record<string, number> = {};
  const n = Math.min(labels.length, probabilities.length);
  for (let i = 0; i < n; i++) out[labels[i] as string] = _round(probabilities[i] as number, 4);
  return out;
}

/** The calibrated chance, `sigmoid(a * logit(p) + b)`, or `p` without a curve. */
function _platt(p: number, curve: PlattCurve | null): number {
  if (!curve || Object.keys(curve).length === 0) return p;
  p = Math.min(Math.max(p, 1e-6), 1 - 1e-6);
  const z = curve.a * Math.log(p / (1 - p)) + curve.b;
  return z >= 0 ? 1 / (1 + Math.exp(-z)) : Math.exp(z) / (1 + Math.exp(z));
}

/**
 * Python's `round(x, digits)`: correctly rounded from the double's exact
 * value, with exact ties to even. (`toFixed` rounds exact ties up.)
 */
function _round(x: number, digits: number): number {
  if (!Number.isFinite(x)) return x;
  const scale = 10 ** digits;
  const scaled = x * scale;
  const floor = Math.floor(scaled);
  // An exact tie: the double is exactly halfway between two `digits`-place decimals.
  if (scaled - floor === 0.5 && (floor + 0.5) / scale === x && _isExactTie(x, digits)) {
    return (floor % 2 === 0 ? floor : floor + 1) / scale;
  }
  return Number(x.toFixed(digits));
}

/** Whether `x` is exactly `(k + 0.5) / 10^digits` for an integer `k`. */
function _isExactTie(x: number, digits: number): boolean {
  // (2k + 1) / (2 * 10^digits) = (2k + 1) / (2^(digits+1) * 5^digits) is a dyadic
  // rational (as every double is) only when 5^digits divides 2k + 1, i.e. when
  // x * 2^(digits+1) is an odd integer. Multiplying by a power of 2 is exact.
  const y = x * 2 ** (digits + 1);
  return Number.isInteger(y) && Math.abs(y % 2) === 1;
}
