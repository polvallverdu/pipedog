// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/processors/tone/tagger/processor.py

/**
 * The processor that tags an LLM's plain replies with Pipecat Tone's tagger.
 *
 * PORTING NOTES:
 * - The model (`pipecat.processors.tone.tagger.model`) lives in `@pipedog/tone`, which
 *   depends on core, so core can't import it statically. The tagger loads
 *   `@pipedog/tone/tagger/model` when it's installed, or uses the `openModel` option.
 * - Upstream labels off the event loop (`asyncio.to_thread`); here the model's `tag` is
 *   awaited (ONNX runtimes for JavaScript run asynchronously).
 */

import { monotonic, rethrowIfCancelled } from "@pipedog/asyncio";
import {
  CORE_DELIVERY,
  CORE_SOUNDS,
  ExpressionDelivery,
  ExpressionSound,
} from "../../../expressive/expression.ts";
import { EXPRESSION_TAGS } from "../../../expressive/formatter.ts";
import { ExpressionPolicy } from "../../../expressive/policy.ts";
import {
  ExpressionMetadataFrame,
  type Frame,
  InterruptionFrame,
  LLMContextAssistantTurnFrame,
  LLMContextUserTurnFrame,
  LLMFullResponseStartFrame,
  StartFrame,
  TextType,
  TTSMetadataFrame,
  UserTurnResponseCancelFrame,
} from "../../../frames/frames.ts";
import { logger } from "../../../utils/logger.ts";
import { isSpace } from "../../../utils/text/alnum_utils.ts";
import { SkipTagsAggregator } from "../../../utils/text/skip_tags_aggregator.ts";
import {
  LLMTextProcessor,
  type LLMTextProcessorOptions,
} from "../../aggregators/llm_text_processor.ts";
import type { FrameDirection, FrameProcessorSetup } from "../../frame_processor.ts";
import { RTVISendTextFrame } from "../../frameworks/rtvi/frames.ts";
import { loadModel } from "../_models.ts";
import { fold, Message, TurnContext } from "./_input.ts";
import {
  BREATH_KINDS,
  LabelSpace,
  type LabelVocabulary,
  ReplyRenderer,
  SentenceLabels,
} from "./_labels.ts";

/** The model's release on Hugging Face that the tagger loads by default. */
// Mirrors `TAGGER_REVISION` in `pipecat.processors.tone.tagger.model` (`@pipedog/tone`).
export const TAGGER_REVISION = "tagger-rc1";

/** The model's size. */
export type PipecatToneTaggerSize = "17m" | "32m";

/** The part of `PipecatToneTaggerModel` (`@pipedog/tone/tagger/model`) the tagger uses. */
export interface PipecatToneTaggerModel {
  /** The most breaths a reply takes, or null for no limit. */
  readonly breathsPerReply: number | null;
  /** The kinds a breath is drawn as, with their shares; empty for a plain breath. */
  readonly breathKinds: Record<string, number>;
  /** Label one sentence of a reply. */
  tag(
    turn: TurnContext,
    earlier: string[],
    sentence: string,
  ): SentenceLabels | Promise<SentenceLabels>;
}

/** How to open the tagger's model. */
export interface PipecatToneTaggerModelSettings {
  size: PipecatToneTaggerSize;
  revision: string;
  modelDir: string | null;
  threads: number;
}

/** Opens the tagger's model. */
export type PipecatToneTaggerModelOpener = (
  settings: PipecatToneTaggerModelSettings,
) => PipecatToneTaggerModel | Promise<PipecatToneTaggerModel>;

// Held in a variable so bundlers leave the import alone.
const TONE_MODEL_MODULE = "@pipedog/tone/tagger/model";

/** Opens the model with `@pipedog/tone`, as upstream's `_open_model` does. */
const packageModelOpener: PipecatToneTaggerModelOpener = async (settings) => {
  const mod = await import(TONE_MODEL_MODULE);
  const Model = mod.PipecatToneTaggerModel;
  if (settings.modelDir) {
    return await Model.load(settings.modelDir, { threads: settings.threads });
  }
  return await Model.download({
    size: settings.size,
    revision: settings.revision,
    threads: settings.threads,
  });
};

export interface PipecatToneTaggerOptions extends LLMTextProcessorOptions {
  /**
   * The model's size: `"17m"`, or `"32m"`, which agrees with its teacher a little
   * more often and takes nearly three times as long a sentence.
   */
  size?: PipecatToneTaggerSize;
  /** The model's release on Hugging Face, such as `"tagger-rc1"`. */
  revision?: string;
  /**
   * A folder to load the model from instead of downloading one, laid out as a
   * release's `tagger/17m`, such as for a model you trained or keep yourself. `size`
   * and `revision` are then unused.
   */
  modelDir?: string | null;
  /** The CPU threads for one sentence. */
  threads?: number;
  /**
   * Names to write first for a delivery, sound or kind of breath (`CORE_DELIVERY`,
   * `CORE_SOUNDS`, `BREATH_KINDS`), best first, such as
   * `{ [ExpressionDelivery.WARM]: ["cheerful"] }`. A name is written only where the
   * TTS service performs it and the policy offers it; elsewhere the label's universal
   * name stands. A name written for `ExpressionSound.BREATH` is written for every
   * breath, rather than its kinds' names.
   */
  vocabulary?: LabelVocabulary | null;
  /**
   * Opens the model. Defaults to `@pipedog/tone`'s `PipecatToneTaggerModel`, when that
   * package is installed.
   */
  openModel?: PipecatToneTaggerModelOpener;
}

/**
 * Tags an LLM's plain replies with Pipecat Tone, a sentence at a time.
 *
 * Goes between the LLM and the TTS service. Each sentence is labeled with
 * the call so far, how the user sounded and the pipeline's expression
 * policy, and sent on with the tags the TTS service performs. The labeling
 * runs off the event loop, and the sentence waits for it, about 15
 * milliseconds.
 *
 * The model loads while the pipeline is set up, once a process, and every
 * tagger shares it. The first load downloads it from Hugging Face, which holds
 * the pipeline's start, so download it ahead, such as when building the
 * image. At start, the tagger broadcasts an `ExpressionMetadataFrame`, so the
 * LLM is taught no tags and writes plain words, and the context keeps them
 * plain. A model that can't be loaded is reported as an error that leaves the
 * tagger unusable: the LLM writes the tags itself and replies pass through as
 * written.
 *
 * The policy's `ExpressionGuidance` presets steer the tagger, its
 * `delivery` and `sounds` narrow the names it writes, and a breath is
 * written only with `ExpressionGuidance.BREATHE`. The developer's own
 * lines are for the LLM.
 *
 * Part of expressive conversation (alpha): turn it on with
 * `new PipelineParams({ enableExpressiveConversation: true })`. Add a
 * `PipecatToneReader` for the tagger to hear how the user sounded.
 *
 * @example
 * const pipeline = new Pipeline([userAggregator, llm, new PipecatToneTagger(), tts]);
 */
export class PipecatToneTagger extends LLMTextProcessor {
  protected _model: PipecatToneTaggerModel | null;
  protected _size: PipecatToneTaggerSize;
  protected _revision: string;
  protected _modelDir: string | null;
  protected _threads: number;
  protected _vocabulary: LabelVocabulary;
  protected _policy: ExpressionPolicy;
  protected _space: LabelSpace | null;
  protected _messages: Message[];
  protected _turn: TurnContext | null;
  protected _renderer: ReplyRenderer | null;
  protected _sentences: string[];
  // The labels of the reply being tagged, which the next reply's model
  // reads; null before the first reply.
  protected _labels: SentenceLabels[] | null;
  // Draws each breath's kind, seeded by the call so far, so a call replays alike.
  protected _draw: SeededRandom;
  #openModel: PipecatToneTaggerModelOpener;

  /**
   * Initialize the processor.
   *
   * @throws Error The vocabulary names a label the tagger doesn't write.
   */
  constructor(options: PipecatToneTaggerOptions = {}) {
    const labels: string[] = [...CORE_DELIVERY, ...CORE_SOUNDS, ...BREATH_KINDS];
    const unknown = [...new Set(Object.keys(options.vocabulary ?? {}))]
      .filter((label) => !labels.includes(label))
      .sort();
    if (unknown.length > 0) {
      throw new Error(
        `the tagger writes none of ${_pyList(unknown)}; it writes ${_pyList(labels, true)}`,
      );
    }
    super({ ...options, textAggregator: new SkipTagsAggregator({ tags: EXPRESSION_TAGS }) });
    this.addTextTransformer((text, textType) => this._tag(text, textType), TextType.SENTENCE);
    this._model = null;
    this._size = options.size ?? "17m";
    this._revision = options.revision ?? TAGGER_REVISION;
    this._modelDir = options.modelDir || null;
    this._threads = options.threads ?? 1;
    this._vocabulary = options.vocabulary ?? {};
    this._policy = new ExpressionPolicy();
    this._space = null;
    this._messages = [];
    this._turn = null;
    this._renderer = null;
    this._sentences = [];
    this._labels = null;
    this._draw = new SeededRandom();
    this.#openModel = options.openModel ?? packageModelOpener;
  }

  /**
   * Set up the processor with the pipeline's expression policy, and load its model.
   *
   * @param setup Configuration object containing setup parameters.
   */
  override async setup(setup: FrameProcessorSetup): Promise<void> {
    await super.setup(setup);
    this._policy = setup.expressionPolicy ?? new ExpressionPolicy();
    if (!setup.enableExpressiveConversation) {
      logger.warning(
        `${this}: expressive conversation is off, so replies pass through untagged; ` +
          "turn it on with PipelineParams(enable_expressive_conversation=True)",
      );
      return;
    }
    this._model = await loadModel(
      this,
      ["tagger", this._modelDir || [this._size, this._revision], this._threads],
      () => this._openModel(),
    );
  }

  protected _openModel(): PipecatToneTaggerModel | Promise<PipecatToneTaggerModel> {
    return this.#openModel({
      size: this._size,
      revision: this._revision,
      modelDir: this._modelDir,
      threads: this._threads,
    });
  }

  /**
   * Tag the LLM's sentences, and keep the call and the TTS's names to tag them by.
   *
   * @param frame The frame to process.
   * @param direction The direction of frame processing.
   */
  override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
    if (!this._model) {
      // Replies pass through as the LLM wrote them.
      await super.processFrame(frame, direction);
      return;
    }

    if (frame instanceof TTSMetadataFrame) {
      this._onTtsMetadata(frame);
    } else if (frame instanceof LLMContextUserTurnFrame) {
      this._onUserTurn(frame);
    } else if (frame instanceof RTVISendTextFrame) {
      // Text the user typed is appended to the context with no user turn
      // frame, and with no reading.
      this._messages.push(new Message({ role: "user", text: frame.text }));
    } else if (frame instanceof LLMContextAssistantTurnFrame) {
      this._messages.push(new Message({ role: "assistant", text: frame.text }));
    } else if (frame instanceof UserTurnResponseCancelFrame) {
      // The turn an early reply was to answer isn't over yet.
      this._messages = this._messages.filter((m) => !m.speculation);
    } else if (frame instanceof InterruptionFrame) {
      this._turn = null;
    }

    await super.processFrame(frame, direction);

    if (frame instanceof StartFrame) {
      await this.broadcastFrame(ExpressionMetadataFrame, { serviceName: this.name });
    } else if (frame instanceof LLMFullResponseStartFrame) {
      await this._startReply();
    }
  }

  protected _onTtsMetadata(frame: TTSMetadataFrame): void {
    if (frame.expression === null) {
      logger.warning(
        `${this}: ${frame.serviceName} performs no expression, ` +
          "so replies pass through untagged",
      );
      this._space = null;
      return;
    }
    this._space = LabelSpace.resolve(
      frame.expression,
      this._policy,
      frame.serviceName,
      this._vocabulary,
    );
  }

  protected _onUserTurn(frame: LLMContextUserTurnFrame): void {
    const message = new Message({
      role: "user",
      text: frame.text,
      heard: fold(frame.perception),
      speculation: frame.speculation,
    });
    // A turn replaces the speculation before it, where it stands: the early
    // reply that answered it may already follow it.
    for (let i = this._messages.length - 1; i >= 0; i--) {
      if (this._messages[i]?.speculation) {
        this._messages[i] = message;
        return;
      }
    }
    this._messages.push(message);
  }

  protected async _startReply(): Promise<void> {
    // Text left from a reply cut short isn't part of this one.
    await this.reset();
    this._sentences = [];
    if (!this._space) {
      this._turn = null;
      return;
    }
    this._turn = new TurnContext({
      messages: [...this._messages],
      space: this._space,
      policy: this._policy,
      previous: this._labels,
    });
    this._renderer = new ReplyRenderer(this._space);
    this._labels = [];
    this._draw = new SeededRandom(this._turn.messages.map((m) => m.text).join("\n"));
  }

  /** Tag one sentence of the reply; text that isn't spoken stays as written. */
  protected async _tag(sentence: string, _textType: TextType | string): Promise<string> {
    if (!this._turn || !this._renderer || !this._model || this._labels === null || this._skipTts) {
      return sentence;
    }
    // The labels are offsets into the sentence as the model reads it.
    const plain = _splitWords(sentence).join(" ");
    const earlier = [...this._sentences];
    this._sentences.push(plain);
    const started = monotonic();
    let labels: SentenceLabels;
    let tagged: string;
    try {
      labels = await this._model.tag(this._turn, earlier, plain);
      labels = this._cappedBreaths(labels);
      tagged = this._renderer.render(plain, this._drawn(labels));
    } catch (e) {
      rethrowIfCancelled(e);
      // A transform that raises drops the sentence, so it's spoken untagged.
      const msg = e instanceof Error ? e.message : String(e);
      await this.pushError(`${this}: couldn't tag a sentence, spoken untagged: ${msg}`, {
        exception: e,
      });
      return plain;
    }
    logger.debug(`${this}: tagged in ${((monotonic() - started) * 1000).toFixed(1)} ms: ${tagged}`);
    // The next reply's model reads a breath as a breath, whatever kind it was drawn as.
    this._labels.push(labels);
    return tagged;
  }

  /**
   * The labels with a breath drawn as a kind the service performs, at the model's shares.
   *
   * A breath stays plain when the model or the service has no kinds, or when it's
   * written as a name the developer gave for every breath.
   */
  protected _drawn(labels: SentenceLabels): SentenceLabels {
    if (labels.soundBefore !== "breath" || !this._model || !this._turn) {
      return labels;
    }
    const sounds = this._turn.space.sounds;
    const breathName = Object.hasOwn(sounds, "breath") ? sounds.breath : undefined;
    if (
      breathName !== undefined &&
      (this._vocabulary[ExpressionSound.BREATH] ?? []).includes(breathName)
    ) {
      return labels;
    }
    const breaths = this._turn.space.breaths;
    const kinds = Object.entries(this._model.breathKinds).filter(([k]) =>
      Object.hasOwn(breaths, k),
    );
    if (kinds.length === 0) {
      return labels;
    }
    const kind = this._draw.choice(
      kinds.map(([k]) => k),
      kinds.map(([, share]) => share),
    );
    return _replace(labels, { soundBefore: kind });
  }

  /**
   * The labels without a breath past the model's limit for a reply.
   *
   * The model breathes only before a sentence.
   */
  protected _cappedBreaths(labels: SentenceLabels): SentenceLabels {
    const cap = this._model ? this._model.breathsPerReply : null;
    if (cap === null || cap === undefined || labels.soundBefore !== "breath") {
      return labels;
    }
    const taken = (this._labels ?? []).filter(
      (sentence) => sentence.soundBefore === "breath",
    ).length;
    return taken >= cap ? _replace(labels, { soundBefore: null }) : labels;
  }
}

/** `dataclasses.replace` for `SentenceLabels`. */
function _replace(labels: SentenceLabels, changes: { soundBefore: string | null }): SentenceLabels {
  return new SentenceLabels({
    delivery: labels.delivery,
    spans: labels.spans,
    emphasis: labels.emphasis,
    soundBefore: changes.soundBefore,
    soundAfter: labels.soundAfter,
  });
}

/** Python's `str.split()`: the words between runs of whitespace, by `str.isspace()`. */
function _splitWords(text: string): string[] {
  const words: string[] = [];
  let word = "";
  for (const ch of text) {
    if (isSpace(ch)) {
      if (word) words.push(word);
      word = "";
    } else {
      word += ch;
    }
  }
  if (word) words.push(word);
  return words;
}

/**
 * A list as Python prints it: `['a', 'b']`, or with `labels`, its `StrEnum` members as
 * `[<ExpressionDelivery.CALM: 'calm'>, ...]`.
 */
function _pyList(items: readonly string[], labels = false): string {
  return `[${items.map((item) => (labels ? _labelRepr(item) : _strRepr(item))).join(", ")}]`;
}

/** Python's `repr()` of a label, a member of `ExpressionDelivery` or `ExpressionSound`. */
function _labelRepr(label: string): string {
  for (const [enumName, members] of [
    ["ExpressionDelivery", ExpressionDelivery],
    ["ExpressionSound", ExpressionSound],
  ] as const) {
    const member = Object.entries(members).find(([, value]) => value === label);
    if (member) {
      return `<${enumName}.${member[0]}: ${_strRepr(label)}>`;
    }
  }
  return _strRepr(label);
}

/** Python's `repr()` of a plain string (quotes and backslashes; enough for a label). */
function _strRepr(text: string): string {
  const quote = text.includes("'") && !text.includes('"') ? '"' : "'";
  const body = text.replaceAll("\\", "\\\\").replaceAll(quote, `\\${quote}`);
  return `${quote}${body}${quote}`;
}

/**
 * Python's `random.Random`, as far as the tagger uses it: the Mersenne Twister
 * (MT19937), seeded with a string as Python seeds it (version 2: the string's UTF-8
 * bytes followed by their SHA-512 digest, read as one big-endian integer), so a call
 * draws the same kinds as upstream.
 */
export class SeededRandom {
  #mt = new Uint32Array(_N);
  #mti = _N + 1;

  /** @param seed The seed; none seeds from `Math.random()`, as Python seeds from the OS. */
  constructor(seed?: string) {
    if (seed === undefined) {
      const key: number[] = [];
      for (let i = 0; i < _N; i++) key.push(Math.floor(Math.random() * 2 ** 32) >>> 0);
      this.#initByArray(key);
      return;
    }
    const bytes = new TextEncoder().encode(seed);
    this.#initByArray(_keyWords([...bytes, ..._sha512(bytes)]));
  }

  #initGenrand(s: number): void {
    const mt = this.#mt;
    mt[0] = s >>> 0;
    for (let i = 1; i < _N; i++) {
      const prev = mt[i - 1] as number;
      mt[i] = (Math.imul(1812433253, prev ^ (prev >>> 30)) + i) >>> 0;
    }
    this.#mti = _N;
  }

  #initByArray(key: readonly number[]): void {
    const mt = this.#mt;
    this.#initGenrand(19650218);
    let i = 1;
    let j = 0;
    for (let k = Math.max(_N, key.length); k > 0; k--) {
      const prev = mt[i - 1] as number;
      mt[i] =
        (((mt[i] as number) ^ Math.imul(prev ^ (prev >>> 30), 1664525)) +
          (key[j] as number) +
          j) >>>
        0;
      i++;
      j++;
      if (i >= _N) {
        mt[0] = mt[_N - 1] as number;
        i = 1;
      }
      if (j >= key.length) j = 0;
    }
    for (let k = _N - 1; k > 0; k--) {
      const prev = mt[i - 1] as number;
      mt[i] = (((mt[i] as number) ^ Math.imul(prev ^ (prev >>> 30), 1566083941)) - i) >>> 0;
      i++;
      if (i >= _N) {
        mt[0] = mt[_N - 1] as number;
        i = 1;
      }
    }
    mt[0] = 0x80000000;
  }

  #genrandUint32(): number {
    const mt = this.#mt;
    if (this.#mti >= _N) {
      let kk = 0;
      for (; kk < _N - _M; kk++) {
        const y = ((mt[kk] as number) & 0x80000000) | ((mt[kk + 1] as number) & 0x7fffffff);
        mt[kk] = (mt[kk + _M] as number) ^ (y >>> 1) ^ (y & 1 ? 0x9908b0df : 0);
      }
      for (; kk < _N - 1; kk++) {
        const y = ((mt[kk] as number) & 0x80000000) | ((mt[kk + 1] as number) & 0x7fffffff);
        mt[kk] = (mt[kk + (_M - _N)] as number) ^ (y >>> 1) ^ (y & 1 ? 0x9908b0df : 0);
      }
      const y = ((mt[_N - 1] as number) & 0x80000000) | ((mt[0] as number) & 0x7fffffff);
      mt[_N - 1] = (mt[_M - 1] as number) ^ (y >>> 1) ^ (y & 1 ? 0x9908b0df : 0);
      this.#mti = 0;
    }
    let y = mt[this.#mti++] as number;
    y ^= y >>> 11;
    y ^= (y << 7) & 0x9d2c5680;
    y ^= (y << 15) & 0xefc60000;
    y ^= y >>> 18;
    return y >>> 0;
  }

  /** A float in [0, 1), with 53 random bits, as `random.random()`. */
  random(): number {
    const a = this.#genrandUint32() >>> 5;
    const b = this.#genrandUint32() >>> 6;
    return (a * 67108864.0 + b) * (1.0 / 9007199254740992.0);
  }

  /** One of `population`, at `weights` (`random.choices(population, weights)[0]`). */
  choice<T>(population: readonly T[], weights: readonly number[]): T {
    if (weights.length !== population.length) {
      throw new Error("The number of weights does not match the population");
    }
    const cumulative: number[] = [];
    let running = 0;
    for (const w of weights) {
      running += w;
      cumulative.push(running);
    }
    const total = cumulative.at(-1) ?? 0;
    if (total <= 0.0) {
      throw new Error("Total of weights must be greater than zero");
    }
    if (!Number.isFinite(total)) {
      throw new Error("Total of weights must be finite");
    }
    const x = this.random() * total;
    // bisect_right(cumulative, x, 0, n - 1)
    let lo = 0;
    let hi = population.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (x < (cumulative[mid] as number)) hi = mid;
      else lo = mid + 1;
    }
    return population[lo] as T;
  }
}

const _N = 624;
const _M = 397;

/** A big-endian integer's 32-bit words, least significant first, as CPython's `random_seed`. */
function _keyWords(bytes: readonly number[]): number[] {
  const words: number[] = [];
  for (let end = bytes.length; end > 0; end -= 4) {
    let word = 0;
    for (let i = Math.max(0, end - 4); i < end; i++)
      word = ((word << 8) | (bytes[i] as number)) >>> 0;
    words.push(word);
  }
  // The integer's own words: leading zeros don't count, and zero is one word.
  while (words.length > 1 && words.at(-1) === 0) words.pop();
  return words.length > 0 ? words : [0];
}

const _SHA512_K = [
  "428a2f98d728ae22",
  "7137449123ef65cd",
  "b5c0fbcfec4d3b2f",
  "e9b5dba58189dbbc",
  "3956c25bf348b538",
  "59f111f1b605d019",
  "923f82a4af194f9b",
  "ab1c5ed5da6d8118",
  "d807aa98a3030242",
  "12835b0145706fbe",
  "243185be4ee4b28c",
  "550c7dc3d5ffb4e2",
  "72be5d74f27b896f",
  "80deb1fe3b1696b1",
  "9bdc06a725c71235",
  "c19bf174cf692694",
  "e49b69c19ef14ad2",
  "efbe4786384f25e3",
  "0fc19dc68b8cd5b5",
  "240ca1cc77ac9c65",
  "2de92c6f592b0275",
  "4a7484aa6ea6e483",
  "5cb0a9dcbd41fbd4",
  "76f988da831153b5",
  "983e5152ee66dfab",
  "a831c66d2db43210",
  "b00327c898fb213f",
  "bf597fc7beef0ee4",
  "c6e00bf33da88fc2",
  "d5a79147930aa725",
  "06ca6351e003826f",
  "142929670a0e6e70",
  "27b70a8546d22ffc",
  "2e1b21385c26c926",
  "4d2c6dfc5ac42aed",
  "53380d139d95b3df",
  "650a73548baf63de",
  "766a0abb3c77b2a8",
  "81c2c92e47edaee6",
  "92722c851482353b",
  "a2bfe8a14cf10364",
  "a81a664bbc423001",
  "c24b8b70d0f89791",
  "c76c51a30654be30",
  "d192e819d6ef5218",
  "d69906245565a910",
  "f40e35855771202a",
  "106aa07032bbd1b8",
  "19a4c116b8d2d0c8",
  "1e376c085141ab53",
  "2748774cdf8eeb99",
  "34b0bcb5e19b48a8",
  "391c0cb3c5c95a63",
  "4ed8aa4ae3418acb",
  "5b9cca4f7763e373",
  "682e6ff3d6b2b8a3",
  "748f82ee5defb2fc",
  "78a5636f43172f60",
  "84c87814a1f0ab72",
  "8cc702081a6439ec",
  "90befffa23631e28",
  "a4506cebde82bde9",
  "bef9a3f7b2c67915",
  "c67178f2e372532b",
  "ca273eceea26619c",
  "d186b8c721c0c207",
  "eada7dd6cde0eb1e",
  "f57d4f7fee6ed178",
  "06f067aa72176fba",
  "0a637dc5a2c898a6",
  "113f9804bef90dae",
  "1b710b35131c471b",
  "28db77f523047d84",
  "32caab7b40c72493",
  "3c9ebe0a15c9bebc",
  "431d67c49c100d4c",
  "4cc5d4becb3e42b6",
  "597f299cfc657e2a",
  "5fcb6fab3ad6faec",
  "6c44198c4a475817",
].map((h) => BigInt(`0x${h}`));

const _SHA512_H = [
  "6a09e667f3bcc908",
  "bb67ae8584caa73b",
  "3c6ef372fe94f82b",
  "a54ff53a5f1d36f1",
  "510e527fade682d1",
  "9b05688c2b3e6c1f",
  "1f83d9abfb41bd6b",
  "5be0cd19137e2179",
].map((h) => BigInt(`0x${h}`));

const _MASK64 = (1n << 64n) - 1n;

function _rotr64(x: bigint, n: bigint): bigint {
  return ((x >> n) | (x << (64n - n))) & _MASK64;
}

/** SHA-512 of some bytes (synchronous; a seed is short). */
function _sha512(message: Uint8Array): number[] {
  const length = message.length;
  const padded = new Uint8Array(Math.ceil((length + 17) / 128) * 128);
  padded.set(message);
  padded[length] = 0x80;
  const bits = BigInt(length) * 8n;
  for (let i = 0; i < 16; i++) {
    padded[padded.length - 1 - i] = Number((bits >> BigInt(8 * i)) & 0xffn);
  }
  const h = [..._SHA512_H];
  const w: bigint[] = new Array(80).fill(0n);
  for (let offset = 0; offset < padded.length; offset += 128) {
    for (let t = 0; t < 16; t++) {
      let word = 0n;
      for (let b = 0; b < 8; b++)
        word = (word << 8n) | BigInt(padded[offset + t * 8 + b] as number);
      w[t] = word;
    }
    for (let t = 16; t < 80; t++) {
      const w15 = w[t - 15] as bigint;
      const w2 = w[t - 2] as bigint;
      const s0 = _rotr64(w15, 1n) ^ _rotr64(w15, 8n) ^ (w15 >> 7n);
      const s1 = _rotr64(w2, 19n) ^ _rotr64(w2, 61n) ^ (w2 >> 6n);
      w[t] = ((w[t - 16] as bigint) + s0 + (w[t - 7] as bigint) + s1) & _MASK64;
    }
    let [a, b, c, d, e, f, g, hh] = h as [
      bigint,
      bigint,
      bigint,
      bigint,
      bigint,
      bigint,
      bigint,
      bigint,
    ];
    for (let t = 0; t < 80; t++) {
      const s1 = _rotr64(e, 14n) ^ _rotr64(e, 18n) ^ _rotr64(e, 41n);
      const ch = (e & f) ^ (~e & _MASK64 & g);
      const temp1 = (hh + s1 + ch + (_SHA512_K[t] as bigint) + (w[t] as bigint)) & _MASK64;
      const s0 = _rotr64(a, 28n) ^ _rotr64(a, 34n) ^ _rotr64(a, 39n);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + maj) & _MASK64;
      hh = g;
      g = f;
      f = e;
      e = (d + temp1) & _MASK64;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) & _MASK64;
    }
    const next = [a, b, c, d, e, f, g, hh];
    for (let i = 0; i < 8; i++) h[i] = ((h[i] as bigint) + (next[i] as bigint)) & _MASK64;
  }
  const digest: number[] = [];
  for (const word of h) {
    for (let b = 7; b >= 0; b--) digest.push(Number((word >> BigInt(8 * b)) & 0xffn));
  }
  return digest;
}
