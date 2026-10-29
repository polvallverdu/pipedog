// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/processors/tone/reader/processor.py

/**
 * The processor that reads how each user turn was meant with Pipecat Tone.
 *
 * PORTING NOTES:
 * - The model (`pipecat.processors.tone.reader.model`) lives in `@pipedog/tone`, which
 *   depends on core, so core can't import it statically. The reader loads
 *   `@pipedog/tone/reader/model` when it's installed, or uses the `openModel` option.
 * - Upstream reads off the event loop (`asyncio.to_thread`); here the model's `tag` is
 *   awaited (ONNX runtimes for JavaScript run asynchronously).
 */

import { rethrowIfCancelled } from "@pipedog/asyncio";
import {
  PerceptionCapabilities,
  PerceptionSignal,
  PerceptionTerm,
} from "../../../expressive/perception.ts";
import {
  type Frame,
  LLMContextAssistantTurnFrame,
  PerceptionMetadataFrame,
  StartFrame,
  TranscriptionFrame,
} from "../../../frames/frames.ts";
import { isSpace } from "../../../utils/text/alnum_utils.ts";
import {
  type FrameDirection,
  FrameProcessor,
  type FrameProcessorOptions,
  type FrameProcessorSetup,
} from "../../frame_processor.ts";
import { loadModel } from "../_models.ts";

/** The model's release on Hugging Face that the reader loads by default. */
// Mirrors `TONE_REVISION` in `pipecat.processors.tone.reader.model` (`@pipedog/tone`).
export const TONE_REVISION = "reader-rc1";

const _EMOTION =
  "The feeling the words show. Read from the words alone, so neutral means they show no " +
  "strong feeling, not that the user feels none: go by what they say.";
const _SARCASM =
  "The chance the turn is sarcastic, from 0 to 1. Read the emotion together with it: " +
  "a sarcastic turn can read happy.";

/** The weights to load. */
export type PipecatToneReaderPrecision = "fp16" | "fp32";

/** The reader model's tags for one turn, in its own form (the parts the reader uses). */
export interface PipecatToneReaderTags {
  emotion: { probabilities: Record<string, number> };
  sarcasm: { probability: number };
  [key: string]: unknown;
}

/** The part of `PipecatToneReaderModel` (`@pipedog/tone/reader/model`) the reader uses. */
export interface PipecatToneReaderModel {
  /** The emotions the model reads. */
  readonly emotions: readonly string[];
  /** Read one turn, with the turn before it, if there is one. */
  tag(
    text: string,
    previous?: string | null,
  ): PipecatToneReaderTags | Promise<PipecatToneReaderTags>;
}

/** How to open the reader's model. */
export interface PipecatToneReaderModelSettings {
  revision: string;
  modelDir: string | null;
  precision: PipecatToneReaderPrecision;
  threads: number;
}

/** Opens the reader's model. */
export type PipecatToneReaderModelOpener = (
  settings: PipecatToneReaderModelSettings,
) => PipecatToneReaderModel | Promise<PipecatToneReaderModel>;

// Held in a variable so bundlers leave the import alone.
const TONE_MODEL_MODULE = "@pipedog/tone/reader/model";

/** Opens the model with `@pipedog/tone`, as upstream's `_open_model` does. */
const packageModelOpener: PipecatToneReaderModelOpener = async (settings) => {
  const mod = await import(TONE_MODEL_MODULE);
  const Model = mod.PipecatToneReaderModel;
  if (settings.modelDir) {
    return await Model.load(settings.modelDir, {
      precision: settings.precision,
      threads: settings.threads,
    });
  }
  return await Model.download({
    revision: settings.revision,
    precision: settings.precision,
    threads: settings.threads,
  });
};

export interface PipecatToneReaderOptions extends FrameProcessorOptions {
  /** The model's release on Hugging Face, such as `"reader-rc1"`. */
  revision?: string;
  /**
   * A folder to load the model from instead of downloading one, laid out as a
   * release's `reader`. `revision` is then unused.
   */
  modelDir?: string | null;
  /** The weights to load: `"fp16"` or `"fp32"`. */
  precision?: PipecatToneReaderPrecision;
  /** The CPU threads for one read. */
  threads?: number;
  /**
   * Opens the model. Defaults to `@pipedog/tone`'s `PipecatToneReaderModel`, when that
   * package is installed.
   */
  openModel?: PipecatToneReaderModelOpener;
}

/**
 * Reads how each user turn was meant with Pipecat Tone.
 *
 * Goes between the STT service and the user aggregator. Each final
 * transcription is read, with the bot's reply before it, and the reading is
 * set as its `perception`: the turn's `emotion`, its two likeliest labels
 * with their confidences, and its `sarcasm`, the chance it's sarcastic.
 * The read runs off the event loop, and the transcription waits for it, a
 * few milliseconds.
 *
 * The model loads while the pipeline is set up, once a process, and every
 * reader shares it. The first load downloads it from Hugging Face, which holds
 * the pipeline's start, so download it ahead, such as when building the
 * image. A model that can't be loaded is reported as an error that leaves the
 * reader unusable, and transcriptions pass through unread.
 *
 * Part of expressive conversation (alpha): turn it on with
 * `new PipelineParams({ enableExpressiveConversation: true })` for the LLM to read
 * the turns.
 *
 * @example
 * const pipeline = new Pipeline([transport.input(), stt, new PipecatToneReader(), userAggregator, llm]);
 */
export class PipecatToneReader extends FrameProcessor {
  protected _model: PipecatToneReaderModel | null;
  protected _revision: string;
  protected _modelDir: string | null;
  protected _precision: PipecatToneReaderPrecision;
  protected _threads: number;
  protected _previous: string | null;
  #openModel: PipecatToneReaderModelOpener;

  /** Initialize the processor. */
  constructor(options: PipecatToneReaderOptions = {}) {
    super(options);
    this._model = null;
    this._revision = options.revision ?? TONE_REVISION;
    this._modelDir = options.modelDir || null;
    this._precision = options.precision ?? "fp16";
    this._threads = options.threads ?? 4;
    this._previous = null;
    this.#openModel = options.openModel ?? packageModelOpener;
  }

  /**
   * Set up the processor and load its model.
   *
   * @param setup Configuration object containing setup parameters.
   */
  override async setup(setup: FrameProcessorSetup): Promise<void> {
    await super.setup(setup);
    this._model = await loadModel(
      this,
      ["reader", this._modelDir || this._revision, this._precision, this._threads],
      () => this._openModel(),
    );
  }

  protected _openModel(): PipecatToneReaderModel | Promise<PipecatToneReaderModel> {
    return this.#openModel({
      revision: this._revision,
      modelDir: this._modelDir,
      precision: this._precision,
      threads: this._threads,
    });
  }

  /**
   * Read final transcriptions, and keep the bot's replies to read them against.
   *
   * @param frame The frame to process.
   * @param direction The direction of frame processing.
   */
  override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
    await super.processFrame(frame, direction);

    if (frame instanceof StartFrame) {
      await this.pushFrame(frame, direction);
      if (this._model) {
        await this.pushFrame(
          new PerceptionMetadataFrame({ serviceName: this.name, perception: this._capabilities() }),
        );
      }
      return;
    }
    if (
      frame instanceof TranscriptionFrame &&
      // Python's `text.strip()`: whitespace by `str.isspace()`.
      [...frame.text].some((ch) => !isSpace(ch)) &&
      this._model
    ) {
      frame.perception = await this._read(frame.text);
    } else if (frame instanceof LLMContextAssistantTurnFrame) {
      this._previous = frame.text;
    }
    await this.pushFrame(frame, direction);
  }

  protected _capabilities(): PerceptionCapabilities {
    if (!this._model) {
      throw new Error("assert self._model");
    }
    return new PerceptionCapabilities({
      signals: [
        new PerceptionTerm({
          name: "emotion",
          description: _EMOTION,
          labels: [...this._model.emotions],
        }),
        new PerceptionTerm({ name: "sarcasm", description: _SARCASM }),
      ],
    });
  }

  protected async _read(text: string): Promise<PerceptionSignal[] | null> {
    if (!this._model) {
      throw new Error("assert self._model");
    }
    let tags: PipecatToneReaderTags;
    try {
      tags = await this._model.tag(text, this._previous);
    } catch (e) {
      rethrowIfCancelled(e);
      const msg = e instanceof Error ? e.message : String(e);
      await this.pushError(`${this}: couldn't read the turn: ${msg}`, { exception: e });
      return null;
    }
    const likeliest = Object.entries(tags.emotion.probabilities)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 2);
    return [
      new PerceptionSignal({ name: "emotion", labels: likeliest }),
      new PerceptionSignal({ name: "sarcasm", value: _round2(tags.sarcasm.probability) }),
    ];
  }
}

/** Python's `round(x, 2)`: to the nearest hundredth, an exact tie to even. */
function _round2(x: number): number {
  // An exact tie in hundredths is an odd number of eighths (x * 8 is exact).
  const eighths = x * 8;
  if (Number.isInteger(eighths) && eighths % 2 !== 0) {
    const floor = Math.floor(x * 100);
    return (floor % 2 === 0 ? floor : floor + 1) / 100;
  }
  // toFixed rounds the exact binary value, as Python does; only its ties differ.
  return Number(x.toFixed(2));
}
