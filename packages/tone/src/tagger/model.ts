// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/processors/tone/tagger/model.py

/**
 * Pipecat Tone's tagger model, on the CPU.
 *
 * Runs on `@pipedog/onnx` (onnxruntime-node or onnxruntime-web) with
 * `@huggingface/tokenizers` (pure JS) in place of Python's `onnxruntime` and
 * `tokenizers`; `huggingface_hub.snapshot_download` becomes a download of the
 * model's files from Hugging Face into `modelCacheDir("tone")`.
 *
 * DIVERGENCE: upstream loads the model in its constructor. Loading is async
 * here, so use `PipecatToneTaggerModel.load(modelDir, options)` (or
 * `PipecatToneTaggerModel.download(options)`), and `tag()` returns a Promise.
 *
 * DIVERGENCE: tokenizers.js has no truncation, offsets, sequence ids or
 * special-token masks, so `_encodePair` rebuilds them: it truncates the pair as
 * Rust `tokenizers` does (`only_first` / `longest_first`, from the left, with
 * the post-processor's special tokens counted), finds each token's place with
 * the post-processor, and aligns the sentence's tokens with its characters.
 * Offsets are in UTF-16 code units (JS string indices), as the rest of the
 * port's labels are, where upstream counts code points.
 *
 * Upstream guards encoding with a lock because Python's tokenizer keeps its
 * truncation as state and calls come from threads; here encoding is
 * synchronous and keeps no state, so calls never interleave.
 */

import { Tokenizer } from "@huggingface/tokenizers";
import { rethrowIfCancelled } from "@pipedog/asyncio";
import { encode, Layout, type TurnContext } from "@pipedog/core/processors/tone/tagger/_input";
import {
  type LabelSpace,
  SentenceLabels,
  Span,
} from "@pipedog/core/processors/tone/tagger/_labels";
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

export const TAGGER_REPO = "pipecat-ai/tone-models";
export const TAGGER_REVISION = "tagger-rc1";

const _INPUTS = ["input_ids", "attention_mask", "sentence_mask"] as const;
// A span or stressed word's tokens, as the model classes them.
// _OUTSIDE = 0, any class but these two.
const _BEGIN = 1;
const _INSIDE = 2;

/** The model's size. */
export type PipecatToneTaggerSize = "17m" | "32m";

/** One head of the model's output, for the batch's one sentence. */
export type PipecatToneTaggerHead = number[] | number[][];

/** A token's character offsets in its text, or null outside the sentence. */
type Offset = [number, number] | null;

export interface PipecatToneTaggerModelOptions {
  /** The CPU threads for one sentence. Default 1. */
  threads?: number;
  /** The ONNX backend (default: `createOnnxBackend()`). */
  backend?: OnnxBackend | Promise<OnnxBackend>;
}

export interface PipecatToneTaggerModelDownloadOptions extends PipecatToneTaggerModelOptions {
  /** The model's size, `"17m"` or `"32m"`. Default `"17m"`. */
  size?: PipecatToneTaggerSize;
  /** The model's release, such as `"tagger-rc1"`. Default `TAGGER_REVISION`. */
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

/** Pipecat Tone's tagger model, on the CPU. One model can serve every call. */
export class PipecatToneTaggerModel {
  // `config.json` is arbitrary JSON (a Python dict upstream), so `any` is genuine.
  config: Record<string, any>;
  _layout: Layout;
  _tokenizer: Tokenizer;
  _session: OnnxSession;
  readonly #scheme: _TokenScheme;

  /**
   * Use a loaded model. Prefer `PipecatToneTaggerModel.load()` or
   * `PipecatToneTaggerModel.download()`.
   *
   * @param config The model's `config.json`.
   * @param tokenizerConfig The model's `tokenizer.json`.
   * @param session The model's inference session.
   */
  constructor(
    config: Record<string, any>,
    tokenizerConfig: Record<string, any>,
    session: OnnxSession,
  ) {
    this.config = config;
    this._layout = new Layout(_layoutOptions(this.config.layout ?? {}));
    this.#scheme = _tokenScheme(tokenizerConfig);
    this._tokenizer = new Tokenizer(tokenizerConfig, {});
    this._session = session;
  }

  /**
   * Load the model from a folder.
   *
   * @param modelDir A folder (a path or an `http(s):`/`file:` URL) with the
   *   model's `config.json`, `tokenizer.json` and ONNX file.
   * @param options `threads` (the CPU threads for one sentence) and the ONNX `backend`.
   * @returns The model.
   */
  static async load(
    modelDir: string | URL,
    options: PipecatToneTaggerModelOptions = {},
  ): Promise<PipecatToneTaggerModel> {
    const threads = options.threads ?? 1;
    const file = (name: string) => _join(modelDir, name);
    const config = await _readJson(file("config.json"));
    const tokenizerConfig = await _readJson(file("tokenizer.json"));
    const sessionOptions: OnnxSessionOptions = {
      forceCpu: true,
      intraOpNumThreads: threads,
      interOpNumThreads: 1,
    };
    const backend = await (options.backend ?? createOnnxBackend());
    const session = await backend.createSession(file(config.onnx), sessionOptions);
    return new PipecatToneTaggerModel(config, tokenizerConfig, session);
  }

  /** The most breaths a reply takes, or null for no limit. */
  get breathsPerReply(): number | null {
    return this.config.breaths_per_reply ?? null;
  }

  /** The kinds a breath is drawn as, with their shares; empty for a plain breath. */
  get breathKinds(): Record<string, number> {
    return this.config.breath_kinds || {};
  }

  /**
   * Load the model from Hugging Face, downloading its files the first time.
   *
   * DIVERGENCE: upstream downloads the folder's every file (`tagger/<size>/*`);
   * this downloads `config.json`, `tokenizer.json` and the ONNX file that
   * `config.json` names, which is what `load()` reads.
   *
   * @param options `size` (the model's size, `"17m"` or `"32m"`), `revision`
   *   (the model's release, such as `"tagger-rc1"`), `threads` (the CPU threads
   *   for one sentence), and where and how to download.
   * @returns The model.
   */
  static async download(
    options: PipecatToneTaggerModelDownloadOptions = {},
  ): Promise<PipecatToneTaggerModel> {
    const size = options.size ?? "17m";
    const revision = options.revision ?? TAGGER_REVISION;
    const folder = `tagger/${size}`;
    const root = options.downloadRoot ?? (await modelCacheDir("tone"));
    const local = `${root}/${TAGGER_REPO.replace("/", "--")}@${revision}`;
    const endpoint = (options.endpoint ?? _env("HF_ENDPOINT") ?? "https://huggingface.co").replace(
      /\/+$/,
      "",
    );
    const fetchFile = (name: string) => {
      const path = `${folder}/${name}`;
      return downloadModelFile(
        `${endpoint}/${TAGGER_REPO}/resolve/${encodeURIComponent(revision)}/${path}`,
        `${local}/${path}`,
        { fetch: options.fetch },
      );
    };
    const config = await _readJson(await fetchFile("config.json"));
    for (const name of ["tokenizer.json", config.onnx as string]) {
      await fetchFile(name);
    }
    return PipecatToneTaggerModel.load(`${local}/${folder}`, {
      threads: options.threads,
      backend: options.backend,
    });
  }

  /**
   * Label one sentence of a reply.
   *
   * @param turn The call so far, the labels it can use and the policy.
   * @param earlier The reply's earlier sentences, without tags.
   * @param sentence The sentence, without tags.
   * @returns The sentence's labels, from those the turn's label space holds.
   */
  async tag(turn: TurnContext, earlier: string[], sentence: string): Promise<SentenceLabels> {
    const [ids, attention, sentenceMask, offsets] = this._encode(turn, earlier, sentence);
    const feeds: Record<string, OnnxTensor> = {};
    const values = [ids, attention, sentenceMask];
    _INPUTS.forEach((name, i) => {
      const row = values[i] as number[];
      feeds[name] = int64Tensor(
        BigInt64Array.from(row, (v) => BigInt(v)),
        [1, row.length],
      );
    });
    const results = await this._session.run(feeds);
    // Upstream takes the session's outputs in the model's order.
    const heads = this._session.outputNames.map((name) => _firstRow(results[name] as OnnxTensor));
    return this._decode(heads, offsets, sentence, turn.space);
  }

  /** The labels from one sentence's heads, from those the space holds. */
  _decode(
    heads: PipecatToneTaggerHead[],
    offsets: Offset[],
    sentence: string,
    space: LabelSpace,
  ): SentenceLabels {
    const [delivery, before, after, spans, emphasis, breath] = heads as [
      number[],
      number[],
      number[],
      number[][],
      number[][],
      PipecatToneTaggerHead,
    ];
    const sounds: string[] = this.config.sounds;
    // Calibration shifts a sound's logit by the sentence's words:
    // [[most words, shift], ..., [None, shift]].
    const bias: Record<string, [number | null, number][]> = this.config.sound_bias || {};
    const words = _pySplit(sentence).filter((token) => _ALNUM.test(token)).length;
    const shift: Record<string, number> = {};
    for (const [sound, steps] of Object.entries(bias)) shift[sound] = _shift(steps, words);
    const soundShift = sounds.map((sound) => shift[sound] ?? 0.0);
    // A breath has a head of its own, so the sound heads never choose one.
    const others = _keys(space.sounds).filter((sound) => sound !== "breath");

    const labels = new SentenceLabels({
      delivery: _choose(delivery, this.config.deliveries, space.deliveries),
      soundBefore: _choose(_add(before, soundShift), sounds, others),
      soundAfter: _choose(_add(after, soundShift), sounds, others),
    });
    // A breath goes before the sentence, where its logit, shifted, is above zero
    // and no other sound starts the sentence. (`breath[0]` is one logit, or a row
    // of one for a head with a trailing axis.)
    const breathLogit = _first(breath[0] as number | number[]);
    if (
      !labels.soundBefore &&
      _has(space.sounds, "breath") &&
      breathLogit + (shift.breath ?? 0.0) > 0
    ) {
      labels.soundBefore = "breath";
    }
    const n = offsets.length;
    if (_has(space.deliveries, "slow")) {
      const slow = _ranges(spans.slice(0, n).map(_argmax), offsets, sentence);
      labels.spans = slow.map(([a, b]) => new Span({ start: a, end: b, delivery: "slow" }));
    }
    if (space.emphasis) {
      labels.emphasis = _ranges(emphasis.slice(0, n).map(_argmax), offsets, sentence);
    }
    return labels;
  }

  _encode(
    turn: TurnContext,
    earlier: string[],
    sentence: string,
  ): [number[], number[], number[], Offset[]] {
    const [first, second, start] = encode(turn, earlier, sentence, this._layout);
    const encoding = this._encodePair(first, second);
    const offsets: Offset[] = [];
    const sentenceMask: number[] = [];
    encoding.sequenceIds.forEach((seq, i) => {
      const special = encoding.specialTokensMask[i] as number;
      const [a, b] = encoding.offsets[i] as [number, number];
      const inside = seq === 1 && !special && a >= start && b > a;
      sentenceMask.push(Number(inside));
      offsets.push(inside ? [a - start, b - start] : null);
    });
    return [encoding.ids, encoding.attentionMask, sentenceMask, offsets];
  }

  _encodePair(first: string, second: string): _PairEncoding {
    const layout = this._layout;
    if (layout.cutCallFirst) {
      // The tokenizer won't cut a text to nothing, so a call too long to
      // keep any of is left out.
      for (const call of [first, ""]) {
        try {
          return this.#encode(call, second, "only_first");
        } catch (e) {
          rethrowIfCancelled(e);
        }
      }
    }
    return this.#encode(first, second, "longest_first");
  }

  /**
   * Python `tokenizers`' `encode(first, second)` with
   * `enable_truncation(max_tokens, strategy=strategy, direction="left")`.
   */
  #encode(first: string, second: string, strategy: "only_first" | "longest_first"): _PairEncoding {
    const maxTokens = this._layout.maxTokens;
    const tokenizer = this._tokenizer as unknown as _TokenizerInternals;
    let a = tokenizer.encode_text(first) ?? [];
    let b = tokenizer.encode_text(second) ?? [];
    let bOffsets = _align(b, second, this.#scheme, tokenizer.normalizer);

    // Where the post-processor puts each sequence's tokens and its special tokens.
    const template = this.#template(a.length, b.length);
    const added = template.filter((t) => t.seq === null).length;
    const maxLength = Math.max(0, maxTokens - added);
    const total = a.length + b.length;
    if (total > maxLength) {
      const toRemove = total - maxLength;
      let n1 = a.length;
      let n2 = b.length;
      if (strategy === "only_first") {
        if (n1 > toRemove) {
          n1 -= toRemove;
        } else {
          throw new Error(
            "Truncation error: Sequence to truncate too short to respect the provided max_length",
          );
        }
      } else {
        const swap = n1 > n2;
        let [s1, s2] = swap ? [n2, n1] : [n1, n2];
        s2 = s1 > maxLength ? s1 : Math.max(s1, maxLength - s1);
        if (s1 + s2 > maxLength) {
          s1 = Math.floor(maxLength / 2);
          s2 = s1 + (maxLength % 2);
        }
        [n1, n2] = swap ? [s2, s1] : [s1, s2];
        n1 = Math.min(n1, a.length);
        n2 = Math.min(n2, b.length);
      }
      // From the left: keep each sequence's last tokens.
      a = a.slice(a.length - n1);
      b = b.slice(b.length - n2);
      bOffsets = bOffsets.slice(bOffsets.length - n2);
    }

    const unk = (tokenizer.model as unknown as { unk_token_id?: number } | null)?.unk_token_id;
    const idOf = (t: string) => tokenizer.token_to_id(t) ?? unk ?? 0;
    const encoding: _PairEncoding = {
      ids: [],
      attentionMask: [],
      sequenceIds: [],
      specialTokensMask: [],
      offsets: [],
    };
    for (const t of this.#template(a.length, b.length)) {
      if (t.seq === 0) {
        encoding.ids.push(idOf(a[t.index] as string));
        encoding.offsets.push([0, 0]);
      } else if (t.seq === 1) {
        encoding.ids.push(idOf(b[t.index] as string));
        encoding.offsets.push(bOffsets[t.index] as [number, number]);
      } else {
        encoding.ids.push(idOf(t.token));
        encoding.offsets.push([0, 0]);
      }
      encoding.attentionMask.push(1);
      encoding.sequenceIds.push(t.seq);
      encoding.specialTokensMask.push(t.seq === null ? 1 : 0);
    }
    return encoding;
  }

  /** The pair's layout after the post-processor, found by running it on placeholders. */
  #template(n1: number, n2: number): _TemplateToken[] {
    const tokenizer = this._tokenizer as unknown as _TokenizerInternals;
    const a = Array.from({ length: n1 }, (_, i) => `\uE000A${i}\uE000`);
    const b = Array.from({ length: n2 }, (_, i) => `\uE000B${i}\uE000`);
    const tokens = tokenizer.post_processor
      ? tokenizer.post_processor(a, b, true).tokens
      : [...a, ...b];
    return tokens.map((token) => {
      const match = /^\uE000([AB])(\d+)\uE000$/.exec(token);
      if (!match) return { seq: null, index: -1, token };
      return { seq: match[1] === "A" ? 0 : 1, index: Number(match[2]), token };
    });
  }
}

interface _PairEncoding {
  ids: number[];
  attentionMask: number[];
  sequenceIds: (number | null)[];
  specialTokensMask: number[];
  offsets: [number, number][];
}

interface _TemplateToken {
  seq: 0 | 1 | null;
  index: number;
  token: string;
}

/**
 * Runtime members of @huggingface/tokenizers' `Tokenizer` that its public types
 * do not declare; reached with `as unknown as` because tokenizers.js has no
 * truncation API (Python `tokenizers` does).
 */
interface _TokenizerInternals {
  encode_text(text: string | null): string[] | null;
  token_to_id(token: string): number | undefined;
  model: unknown;
  normalizer: ((text: string) => string) | null;
  post_processor:
    | ((tokens: string[], pair: string[] | null, addSpecial: boolean) => { tokens: string[] })
    | null;
}

function _shift(steps: [number | null, number][], words: number): number {
  for (const [most, shift] of steps) {
    if (most === null || words <= most) return shift;
  }
  // Python's `next()` on an exhausted generator.
  throw new Error("StopIteration");
}

/** The likeliest class the space allows, or null for no label. */
function _choose(
  logits: readonly number[],
  classes: readonly string[],
  allowed: unknown,
): string | null {
  const mask = classes.map((c) => c === "none" || _has(allowed, c));
  const best = classes[_argmax(logits.map((x, i) => (mask[i] ? x : -Infinity)))] as string;
  return best === "none" ? null : best;
}

/** Character ranges from begin, inside and outside token classes, widened to whole words. */
function _ranges(
  classes: readonly number[],
  offsets: readonly Offset[],
  sentence: string,
): [number, number][] {
  const ranges: [number, number][] = [];
  let current: [number, number] | null = null;
  const n = Math.min(classes.length, offsets.length);
  for (let i = 0; i < n; i++) {
    const cls = classes[i] as number;
    const offset = offsets[i] as Offset;
    if (offset === null) continue;
    if (cls === _BEGIN || (cls === _INSIDE && current === null)) {
      if (current) ranges.push(current);
      current = [offset[0], offset[1]];
    } else if (cls === _INSIDE && current) {
      current[1] = offset[1];
    } else if (current) {
      // An _OUTSIDE token ends the range.
      ranges.push(current);
      current = null;
    }
  }
  if (current) ranges.push(current);
  const words: [number, number][] = [];
  for (let [a, b] of ranges) {
    // A subword token's offsets can include the space before it.
    while (a < b && _isSpace(sentence[a] as string)) a += 1;
    while (b > a && _isSpace(sentence[b - 1] as string)) b -= 1;
    if (a === b) continue;
    while (a > 0 && _isAlnum(sentence[a - 1] as string)) a -= 1;
    while (b < sentence.length && _isAlnum(sentence[b] as string)) b += 1;
    words.push([a, b]);
  }
  return words;
}

// --- Token alignment (what Python `tokenizers` gives as `encoding.offsets`) ---

let _UNICODE_TO_BYTES: Map<string, number> | null = null;

/** GPT-2's byte-level alphabet, char to byte. */
function _unicodeToBytes(): Map<string, number> {
  if (_UNICODE_TO_BYTES) return _UNICODE_TO_BYTES;
  const bs: number[] = [];
  for (let b = 0x21; b <= 0x7e; b++) bs.push(b);
  for (let b = 0xa1; b <= 0xac; b++) bs.push(b);
  for (let b = 0xae; b <= 0xff; b++) bs.push(b);
  const cs = bs.slice();
  let n = 0;
  for (let b = 0; b < 256; b++) {
    if (!bs.includes(b)) {
      bs.push(b);
      cs.push(256 + n);
      n += 1;
    }
  }
  _UNICODE_TO_BYTES = new Map(bs.map((b, i) => [String.fromCharCode(cs[i] as number), b]));
  return _UNICODE_TO_BYTES;
}

const _ENCODER = new TextEncoder();

function _isAsciiSpace(byte: number): boolean {
  return byte === 0x20 || (byte >= 0x09 && byte <= 0x0d);
}

/** How a tokenizer writes its tokens: what to undo to find them in the text. */
interface _TokenScheme {
  byteLevel: boolean;
  prefix: string | null;
  suffix: string | null;
  byteFallback: boolean;
}

// `tokenizer.json` is arbitrary JSON, so `any` is genuine.
function _tokenScheme(tokenizerConfig: Record<string, any>): _TokenScheme {
  const pre = JSON.stringify(tokenizerConfig.pre_tokenizer ?? null);
  const decoder = JSON.stringify(tokenizerConfig.decoder ?? null);
  const model = tokenizerConfig.model ?? {};
  return {
    byteLevel: pre.includes('"ByteLevel"') || decoder.includes('"ByteLevel"'),
    prefix: model.continuing_subword_prefix ?? (model.type === "WordPiece" ? "##" : null),
    suffix: model.end_of_word_suffix ?? null,
    byteFallback: Boolean(model.byte_fallback),
  };
}

/** A token's bytes as they appear in the normalized text, without marker spaces. */
function _tokenBytes(token: string, scheme: _TokenScheme): Uint8Array {
  let bytes: number[];
  if (scheme.byteLevel) {
    const table = _unicodeToBytes();
    bytes = [];
    for (const c of token) {
      const byte = table.get(c);
      if (byte === undefined) {
        bytes.push(..._ENCODER.encode(c));
      } else {
        bytes.push(byte);
      }
    }
  } else {
    let s = token;
    const { prefix, suffix } = scheme;
    if (prefix && s.startsWith(prefix) && s.length > prefix.length) s = s.slice(prefix.length);
    if (suffix && s.endsWith(suffix) && s.length > suffix.length) s = s.slice(0, -suffix.length);
    const byte = /^<0x([0-9A-Fa-f]{2})>$/.exec(s);
    if (byte && scheme.byteFallback) {
      bytes = [Number.parseInt(byte[1] as string, 16)];
    } else {
      bytes = [..._ENCODER.encode(s.replaceAll("▁", " "))];
    }
  }
  let start = 0;
  let end = bytes.length;
  while (start < end && _isAsciiSpace(bytes[start] as number)) start++;
  while (end > start && _isAsciiSpace(bytes[end - 1] as number)) end--;
  return Uint8Array.from(bytes.slice(start, end));
}

/**
 * Each token's `[start, end)` in `text`, in UTF-16 code units: the normalized
 * text's bytes are matched in order with the tokens' bytes, skipping spaces.
 */
function _align(
  tokens: readonly string[],
  text: string,
  scheme: _TokenScheme,
  normalizer: ((text: string) => string) | null,
): [number, number][] {
  // The normalized text's bytes, each with the original character it comes from.
  const bytes: number[] = [];
  const charStart: number[] = [];
  const charEnd: number[] = [];
  const space: boolean[] = [];
  let i = 0;
  for (const c of text) {
    // A Metaspace-style normalizer writes spaces as U+2581.
    const normalized = (normalizer ? normalizer(c) : c).replaceAll("\u2581", " ");
    const isSpace = _isSpace(c);
    for (const byte of _ENCODER.encode(normalized)) {
      bytes.push(byte);
      charStart.push(i);
      charEnd.push(i + c.length);
      space.push(isSpace || _isAsciiSpace(byte));
    }
    i += c.length;
  }
  const matchesAt = (tb: Uint8Array, p: number) => {
    if (tb.length === 0 || p + tb.length > bytes.length) return false;
    for (let k = 0; k < tb.length; k++) if (bytes[p + k] !== tb[k]) return false;
    return true;
  };
  const tokenBytes = tokens.map((t) => _tokenBytes(t, scheme));
  const offsets: [number, number][] = [];
  let p = 0;
  for (let t = 0; t < tokens.length; t++) {
    while (p < bytes.length && space[p]) p++;
    const here = p < bytes.length ? (charStart[p] as number) : text.length;
    const tb = tokenBytes[t] as Uint8Array;
    if (tb.length === 0) {
      offsets.push([here, here]);
      continue;
    }
    let end: number;
    if (matchesAt(tb, p)) {
      end = p + tb.length;
    } else {
      // A token that isn't in the text as such (an unknown token): it covers the
      // text up to where the next token is found, or up to the next space.
      const next = tokenBytes.slice(t + 1).find((x) => x.length > 0);
      end = p;
      while (end < bytes.length && !space[end] && !(end > p && next && matchesAt(next, end))) end++;
      if (end === p) {
        offsets.push([here, here]);
        continue;
      }
    }
    offsets.push([charStart[p] as number, charEnd[end - 1] as number]);
    p = end;
  }
  return offsets;
}

// --- Helpers ---

function _layoutOptions(layout: Record<string, unknown>): Record<string, unknown> {
  const options: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(layout)) {
    options[key.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase())] = value;
  }
  return options;
}

/** `c in allowed` for a dict (object or Map), a list or a set. */
function _has(allowed: unknown, c: string): boolean {
  if (allowed == null) return false;
  if (allowed instanceof Map || allowed instanceof Set) return allowed.has(c);
  if (Array.isArray(allowed)) return allowed.includes(c);
  return Object.hasOwn(allowed as object, c);
}

/** A dict's keys (object or Map), or a list's items. */
function _keys(x: unknown): string[] {
  if (x == null) return [];
  if (x instanceof Map) return [...x.keys()];
  if (x instanceof Set || Array.isArray(x)) return [...x];
  return Object.keys(x as object);
}

/** A logit, from a number or a row holding one. */
function _first(x: number | readonly number[]): number {
  return Array.isArray(x) ? (x[0] as number) : (x as number);
}

function _add(a: readonly number[], b: readonly number[]): number[] {
  return a.map((x, i) => x + (b[i] as number));
}

/** numpy's `argmax`: the index of the first largest value. */
function _argmax(values: readonly number[]): number {
  let best = 0;
  for (let i = 1; i < values.length; i++) {
    if ((values[i] as number) > (values[best] as number)) best = i;
  }
  return best;
}

// Python's `str.isalnum()` and `str.isspace()`, by character.
const _ALNUM = /[\p{L}\p{N}]/u;
// JS `\s` plus the characters Python's `str.isspace()` adds (U+001C-U+001F, U+0085).
const _PY_WS = "\\s\\u001c-\\u001f\\u0085";
const _SPACE = new RegExp(`^[${_PY_WS}]$`, "u");
const _SPACES = new RegExp(`[${_PY_WS}]+`, "u");

function _isAlnum(c: string): boolean {
  return _ALNUM.test(c);
}

function _isSpace(c: string): boolean {
  return _SPACE.test(c);
}

/** Python's `str.split()`: on runs of whitespace, without empty strings. */
function _pySplit(s: string): string[] {
  return s.split(_SPACES).filter((w) => w.length > 0);
}

/** `result[0]`: the first row of a batched output, as numbers (a row of rows for 3-D heads). */
function _firstRow(tensor: OnnxTensor): PipecatToneTaggerHead {
  const dims = tensor.dims.slice(1);
  const rowLength = dims.reduce((a, b) => a * b, 1);
  const flat: number[] = new Array(rowLength);
  for (let i = 0; i < rowLength; i++) flat[i] = Number(tensor.data[i]);
  if (dims.length < 2) return flat;
  const width = dims.slice(1).reduce((a, b) => a * b, 1);
  const rows: number[][] = [];
  for (let r = 0; r < (dims[0] as number); r++) rows.push(flat.slice(r * width, (r + 1) * width));
  return rows;
}

function _env(name: string): string | undefined {
  const value = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
    ?.env?.[name];
  return value ? value : undefined;
}

function _join(dir: string | URL, name: string): string {
  return `${String(dir).replace(/[\\/]+$/, "")}/${name}`;
}

async function _readJson(source: string): Promise<Record<string, any>> {
  const bytes = await loadModelBytes(source);
  return JSON.parse(new TextDecoder().decode(bytes));
}
