// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/**
 * A SentencePiece (`.model`) reader and Unigram tokenizer, enough for the
 * tokenizers Pocket TTS ships.
 *
 * pocket-tts tokenizes text with the `sentencepiece` C++ library and a Unigram
 * model per language (4000 pieces, `identity` normalization, byte fallback).
 * This module reads the same `tokenizer.model` file (a `ModelProto` protobuf)
 * and reproduces `SentencePieceProcessor.encode()` / `decode()` for that kind
 * of model:
 *
 * - normalization: the `identity` rule set only (no precompiled character
 *   map), plus `add_dummy_prefix`, `remove_extra_whitespaces` and
 *   `escape_whitespaces`;
 * - encoding: the Viterbi search of `unigram_model.cc` (`EncodeOptimized`),
 *   including the unknown-character penalty and user-defined piece scores;
 * - byte fallback: unknown characters become `<0xXX>` byte pieces;
 * - decoding: byte pieces are reassembled into UTF-8, `▁` becomes a space and
 *   the dummy-prefix space of the first piece is dropped.
 *
 * Models that need a precompiled normalization map (`nmt_nfkc`, ...), BPE /
 * word / char models and whitespace-as-suffix models are rejected with an
 * error rather than tokenized differently.
 */

const SPACE_SYMBOL = "▁"; // ▁
/** The penalty sentencepiece gives unknown characters (`kUnkPenalty`). */
const UNK_PENALTY = 10.0;
/** `SentencePieceProcessor`'s default surface for unknown pieces (`" ⁇ "`). */
const UNK_SURFACE = " ⁇ ";

/** `ModelProto.SentencePiece.Type`. */
export const PieceType = {
  NORMAL: 1,
  UNKNOWN: 2,
  CONTROL: 3,
  USER_DEFINED: 4,
  UNUSED: 5,
  BYTE: 6,
} as const;
export type PieceType = (typeof PieceType)[keyof typeof PieceType];

/** One vocabulary entry of a SentencePiece model. */
export interface SentencePiece {
  piece: string;
  score: number;
  type: PieceType;
}

/** The parts of a `ModelProto` the tokenizer uses. */
export interface SentencePieceModelProto {
  pieces: SentencePiece[];
  /** `TrainerSpec.model_type`: 1 Unigram, 2 BPE, 3 word, 4 char. */
  modelType: number;
  byteFallback: boolean;
  unkId: number;
  treatWhitespaceAsSuffix: boolean;
  normalizerName: string;
  precompiledCharsmapLength: number;
  addDummyPrefix: boolean;
  removeExtraWhitespaces: boolean;
  escapeWhitespaces: boolean;
}

// ---------------------------------------------------------------------------
// Minimal protobuf reading (wire types 0, 1, 2 and 5).

class ProtoReader {
  pos = 0;
  readonly bytes: Uint8Array;
  readonly view: DataView;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  get done(): boolean {
    return this.pos >= this.bytes.length;
  }

  varint(): number {
    let result = 0;
    let shift = 0;
    for (;;) {
      if (this.pos >= this.bytes.length) throw new Error("truncated SentencePiece model");
      const b = this.bytes[this.pos++]!;
      // Values above 2^53 never occur in the fields we read; skip their high bits.
      if (shift < 49) result += (b & 0x7f) * 2 ** shift;
      shift += 7;
      if ((b & 0x80) === 0) return result;
    }
  }

  /** A signed varint field (int32 values are sign-extended to 64 bits). */
  int32(): number {
    const v = this.varint();
    return v >= 2 ** 31 ? v - 2 ** 64 : v;
  }

  float(): number {
    const v = this.view.getFloat32(this.pos, true);
    this.pos += 4;
    return v;
  }

  lengthDelimited(): Uint8Array {
    const len = this.varint();
    const out = this.bytes.subarray(this.pos, this.pos + len);
    this.pos += len;
    return out;
  }

  skip(wireType: number): void {
    switch (wireType) {
      case 0:
        this.varint();
        break;
      case 1:
        this.pos += 8;
        break;
      case 2: {
        const len = this.varint();
        this.pos += len;
        break;
      }
      case 5:
        this.pos += 4;
        break;
      default:
        throw new Error(`unsupported protobuf wire type ${wireType} in SentencePiece model`);
    }
  }
}

const utf8Decoder = new TextDecoder();
const utf8Encoder = new TextEncoder();

function readPiece(bytes: Uint8Array): SentencePiece {
  const r = new ProtoReader(bytes);
  const out: SentencePiece = { piece: "", score: 0, type: PieceType.NORMAL };
  while (!r.done) {
    const key = r.varint();
    const field = Math.floor(key / 8);
    const wire = key & 7;
    if (field === 1 && wire === 2) out.piece = utf8Decoder.decode(r.lengthDelimited());
    else if (field === 2 && wire === 5) out.score = r.float();
    else if (field === 3 && wire === 0) out.type = r.varint() as PieceType;
    else r.skip(wire);
  }
  return out;
}

/** Parse a SentencePiece `.model` file (a serialized `ModelProto`). */
export function parseSentencePieceModel(bytes: Uint8Array): SentencePieceModelProto {
  const model: SentencePieceModelProto = {
    pieces: [],
    modelType: 1,
    byteFallback: false,
    unkId: 0,
    treatWhitespaceAsSuffix: false,
    normalizerName: "",
    precompiledCharsmapLength: 0,
    addDummyPrefix: true,
    removeExtraWhitespaces: true,
    escapeWhitespaces: true,
  };
  const r = new ProtoReader(bytes);
  while (!r.done) {
    const key = r.varint();
    const field = Math.floor(key / 8);
    const wire = key & 7;
    if (field === 1 && wire === 2) {
      model.pieces.push(readPiece(r.lengthDelimited()));
    } else if (field === 2 && wire === 2) {
      // TrainerSpec
      const t = new ProtoReader(r.lengthDelimited());
      while (!t.done) {
        const k = t.varint();
        const f = Math.floor(k / 8);
        const w = k & 7;
        if (f === 3 && w === 0) model.modelType = t.varint();
        else if (f === 24 && w === 0) model.treatWhitespaceAsSuffix = t.varint() !== 0;
        else if (f === 35 && w === 0) model.byteFallback = t.varint() !== 0;
        else if (f === 40 && w === 0) model.unkId = t.int32();
        else t.skip(w);
      }
    } else if (field === 3 && wire === 2) {
      // NormalizerSpec
      const n = new ProtoReader(r.lengthDelimited());
      while (!n.done) {
        const k = n.varint();
        const f = Math.floor(k / 8);
        const w = k & 7;
        if (f === 1 && w === 2) model.normalizerName = utf8Decoder.decode(n.lengthDelimited());
        else if (f === 2 && w === 2) model.precompiledCharsmapLength = n.lengthDelimited().length;
        else if (f === 3 && w === 0) model.addDummyPrefix = n.varint() !== 0;
        else if (f === 4 && w === 0) model.removeExtraWhitespaces = n.varint() !== 0;
        else if (f === 5 && w === 0) model.escapeWhitespaces = n.varint() !== 0;
        else n.skip(w);
      }
    } else {
      r.skip(wire);
    }
  }
  if (model.pieces.length === 0) throw new Error("not a SentencePiece model: no pieces");
  return model;
}

interface LatticeNode {
  startsAt: number;
  id: number;
  score: number;
}

/**
 * A SentencePiece Unigram tokenizer (`sentencepiece.SentencePieceProcessor`
 * for Unigram models with identity normalization).
 */
export class SentencePieceProcessor {
  readonly model: SentencePieceModelProto;
  readonly #pieceToId = new Map<string, number>();
  readonly #byteToId: number[] = new Array(256).fill(-1);
  readonly #maxPieceChars: number;
  readonly #minScore: number;
  readonly #maxScore: number;

  constructor(model: SentencePieceModelProto | Uint8Array) {
    this.model = model instanceof Uint8Array ? parseSentencePieceModel(model) : model;
    const m = this.model;
    if (m.modelType !== 1) {
      throw new Error(
        `Unsupported SentencePiece model type ${m.modelType}: only Unigram models are supported`,
      );
    }
    if (m.precompiledCharsmapLength > 0 || (m.normalizerName && m.normalizerName !== "identity")) {
      throw new Error(
        `Unsupported SentencePiece normalizer "${m.normalizerName}": only "identity" is supported`,
      );
    }
    if (m.treatWhitespaceAsSuffix) {
      throw new Error("Unsupported SentencePiece option treat_whitespace_as_suffix");
    }
    let minScore = Number.POSITIVE_INFINITY;
    let maxScore = Number.NEGATIVE_INFINITY;
    let maxChars = 1;
    m.pieces.forEach((p, id) => {
      if (p.type === PieceType.BYTE) {
        const match = /^<0x([0-9A-Fa-f]{2})>$/.exec(p.piece);
        if (match) this.#byteToId[Number.parseInt(match[1]!, 16)] = id;
        return;
      }
      if (p.type === PieceType.NORMAL) {
        minScore = Math.min(minScore, p.score);
        maxScore = Math.max(maxScore, p.score);
      }
      if (
        p.type === PieceType.NORMAL ||
        p.type === PieceType.USER_DEFINED ||
        p.type === PieceType.UNUSED
      ) {
        this.#pieceToId.set(p.piece, id);
        maxChars = Math.max(maxChars, Array.from(p.piece).length);
      }
    });
    this.#maxPieceChars = maxChars;
    this.#minScore = minScore;
    this.#maxScore = maxScore;
  }

  /** The vocabulary size. */
  vocabSize(): number {
    return this.model.pieces.length;
  }

  /** The piece string of `id`. */
  idToPiece(id: number): string {
    return this.model.pieces[id]?.piece ?? "";
  }

  /** The identity normalization with sentencepiece's whitespace handling. */
  normalize(text: string): string {
    const m = this.model;
    let s = text;
    if (m.removeExtraWhitespaces) {
      s = s.replace(/^ +/, "").replace(/ +$/, "").replace(/ {2,}/g, " ");
    }
    if (s.length === 0) return "";
    if (m.addDummyPrefix) s = ` ${s}`;
    if (m.escapeWhitespaces) s = s.replaceAll(" ", SPACE_SYMBOL);
    return s;
  }

  /** Encode `text` into piece ids (`SentencePieceProcessor.encode(text, out_type=int)`). */
  encode(text: string): number[] {
    const normalized = this.normalize(text);
    if (normalized.length === 0) return [];
    const chars = Array.from(normalized);
    const n = chars.length;
    const unkScore = this.#minScore - UNK_PENALTY;
    const nodes: LatticeNode[] = new Array(n + 1);
    for (let i = 0; i <= n; i++) nodes[i] = { startsAt: -1, id: -1, score: 0 };
    nodes[0]!.startsAt = 0;

    for (let start = 0; start < n; start++) {
      const bestHere = nodes[start]!.score;
      let hasSingleNode = false;
      let key = "";
      let byteLength = 0;
      const maxLen = Math.min(this.#maxPieceChars, n - start);
      for (let len = 1; len <= maxLen; len++) {
        const ch = chars[start + len - 1]!;
        key += ch;
        byteLength += utf8Encoder.encode(ch).length;
        const id = this.#pieceToId.get(key);
        if (id === undefined) continue;
        const piece = this.model.pieces[id]!;
        if (piece.type === PieceType.UNUSED) continue;
        const score =
          piece.type === PieceType.USER_DEFINED ? byteLength * this.#maxScore - 0.1 : piece.score;
        const candidate = score + bestHere;
        const target = nodes[start + len]!;
        if (target.startsAt === -1 || candidate > target.score) {
          target.score = candidate;
          target.startsAt = start;
          target.id = id;
        }
        if (len === 1) hasSingleNode = true;
      }
      if (!hasSingleNode) {
        const target = nodes[start + 1]!;
        const candidate = unkScore + bestHere;
        if (target.startsAt === -1 || candidate > target.score) {
          target.score = candidate;
          target.startsAt = start;
          target.id = this.model.unkId;
        }
      }
    }

    // Backtrack.
    const spans: [number, number, number][] = [];
    let end = n;
    while (end > 0) {
      const node = nodes[end]!;
      spans.push([node.startsAt, end, node.id]);
      end = node.startsAt;
    }
    spans.reverse();

    const ids: number[] = [];
    for (const [start, stop, id] of spans) {
      if (id === this.model.unkId && this.model.byteFallback) {
        const bytes = utf8Encoder.encode(chars.slice(start, stop).join(""));
        for (const b of bytes) ids.push(this.#byteToId[b]! >= 0 ? this.#byteToId[b]! : id);
      } else {
        ids.push(id);
      }
    }
    return ids;
  }

  /** Decode piece ids into text (`SentencePieceProcessor.decode(ids)`). */
  decode(ids: readonly number[]): string {
    let out = "";
    let pendingBytes: number[] = [];
    let isBos = true;
    const emit = (surface: string) => {
      let s = surface;
      if (isBos && this.model.addDummyPrefix && s.startsWith(SPACE_SYMBOL)) s = s.slice(1);
      s = s.replaceAll(SPACE_SYMBOL, " ");
      out += s;
      // Only the first non-control piece loses its dummy-prefix space.
      isBos = false;
    };
    const flushBytes = () => {
      if (pendingBytes.length === 0) return;
      const text = utf8Decoder.decode(new Uint8Array(pendingBytes));
      pendingBytes = [];
      emit(text);
    };
    for (const id of ids) {
      const piece = this.model.pieces[id];
      if (!piece) throw new Error(`piece id ${id} is out of range`);
      if (piece.type === PieceType.BYTE) {
        pendingBytes.push(Number.parseInt(piece.piece.slice(3, 5), 16));
        continue;
      }
      flushBytes();
      if (piece.type === PieceType.CONTROL) continue;
      if (piece.type === PieceType.UNKNOWN) {
        out += UNK_SURFACE;
        isBos = false;
        continue;
      }
      emit(piece.piece);
    }
    flushBytes();
    return out;
  }
}
