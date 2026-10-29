// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_pipecat_tone_reader.py

/** Tests for the processor that reads each user turn with Pipecat Tone. */

import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PerceptionSignal } from "@pipedog/core/expressive/perception";
import {
  ErrorFrame,
  InterimTranscriptionFrame,
  LLMContextAssistantTurnFrame,
  PerceptionMetadataFrame,
  TranscriptionFrame,
} from "@pipedog/core/frames/frames";
import * as _models from "@pipedog/core/processors/tone/_models";
import {
  PipecatToneReader,
  type PipecatToneReaderModelOpener,
  type PipecatToneReaderOptions,
} from "@pipedog/core/processors/tone/reader/processor";
import { runTest } from "@pipedog/core/tests/utils";
import { PipecatToneReaderModel } from "../src/reader/model.ts";

const TAGS = {
  emotion: {
    label: "angry",
    intensity: "low",
    confidence: 0.71,
    probabilities: { neutral: 0.2, happy: 0.04, angry: 0.71, sad: 0.05 },
  },
  move: { label: "other", confidence: 0.92, probabilities: {} },
  sarcasm: { sarcastic: true, probability: 0.99 },
  backchannel: { is_backchannel: false, probability: 0.01 },
};

class FakeReaderModel {
  emotions = ["neutral", "happy", "angry", "sad"];
  reads: [string, string | null][] = [];
  #error: Error | null;

  constructor(error: Error | null = null) {
    this.#error = error;
  }

  tag(text: string, previous: string | null = null) {
    this.reads.push([text, previous]);
    if (this.#error) {
      throw this.#error;
    }
    return TAGS;
  }
}

// `@pipedog/tone` depends on `@pipedog/core`, so in this monorepo core can't resolve
// it for the reader's default opener. This opener is that default (upstream's
// `_open_model`), on this package's `PipecatToneReaderModel`, so patching its
// `download` / `load` (upstream's `__init__`) works as upstream's monkeypatching does.
const openModel: PipecatToneReaderModelOpener = async (settings) => {
  if (settings.modelDir) {
    return await PipecatToneReaderModel.load(settings.modelDir, {
      precision: settings.precision,
      threads: settings.threads,
    });
  }
  return await PipecatToneReaderModel.download({
    revision: settings.revision,
    precision: settings.precision,
    threads: settings.threads,
  });
};

function newReader(options: PipecatToneReaderOptions = {}): PipecatToneReader {
  return new PipecatToneReader({ openModel, ...options });
}

const spies: { mockRestore(): void }[] = [];

// Each test loads its own model.
beforeEach(() => {
  _models._models.clear();
});

afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
  _models._models.clear();
});

function patchDownload(impl: (options?: unknown) => unknown) {
  spies.push(spyOn(PipecatToneReaderModel, "download").mockImplementation(impl as any));
}

function patchLoad(impl: (modelDir: string | URL, options?: unknown) => unknown) {
  spies.push(spyOn(PipecatToneReaderModel, "load").mockImplementation(impl as any));
}

/** A reader whose model downloads as `model`. */
function _reader(model: FakeReaderModel): PipecatToneReader {
  patchDownload(() => model);
  return newReader();
}

function _transcription(text: string): TranscriptionFrame {
  return new TranscriptionFrame({ text, userId: "", timestamp: "now" });
}

test("test_the_signals_are_declared_at_start", async () => {
  const [down] = await runTest(_reader(new FakeReaderModel()), { framesToSend: [] });

  const metadata = down.filter((f) => f instanceof PerceptionMetadataFrame);
  expect(metadata[0]?.perception.signals.map((t) => [t.name, t.labels])).toEqual([
    ["emotion", ["neutral", "happy", "angry", "sad"]],
    ["sarcasm", []],
  ]);
});

test("test_the_reading_is_set_on_its_transcription", async () => {
  const [down] = await runTest(_reader(new FakeReaderModel()), {
    framesToSend: [_transcription("Oh great, a forty minute wait.")],
    expectedDownFrames: [PerceptionMetadataFrame, TranscriptionFrame],
  });

  expect((down[1] as TranscriptionFrame).perception).toEqual([
    new PerceptionSignal({
      name: "emotion",
      labels: [
        ["angry", 0.71],
        ["neutral", 0.2],
      ],
    }),
    new PerceptionSignal({ name: "sarcasm", value: 0.99 }),
  ]);
});

test("test_a_turn_is_read_against_the_bots_words_before_it", async () => {
  const model = new FakeReaderModel();

  await runTest(_reader(model), {
    framesToSend: [
      new LLMContextAssistantTurnFrame({
        text: "The next visit is in forty minutes. Sorry.",
        timestamp: "now",
      }),
      _transcription("Oh great."),
    ],
  });

  expect(model.reads).toEqual([["Oh great.", "The next visit is in forty minutes. Sorry."]]);
});

test("test_interim_transcriptions_are_not_read", async () => {
  const model = new FakeReaderModel();

  await runTest(_reader(model), {
    framesToSend: [new InterimTranscriptionFrame({ text: "Oh", userId: "", timestamp: "now" })],
  });

  expect(model.reads).toEqual([]);
});

test("test_a_failed_read_is_reported_and_the_transcription_still_passes", async () => {
  const [down, up] = await runTest(_reader(new FakeReaderModel(new Error("no session"))), {
    framesToSend: [_transcription("Hello.")],
    expectedDownFrames: [PerceptionMetadataFrame, TranscriptionFrame],
  });

  expect(up.filter((f) => f instanceof ErrorFrame).length).toBeGreaterThan(0);
  expect((down[1] as TranscriptionFrame).perception).toBeNull();
});

test("test_a_model_that_cant_load_leaves_the_reader_unusable_and_the_pipeline_running", async () => {
  const fail = () => {
    throw new Error("no network");
  };

  patchDownload(fail);
  const reader = newReader();

  const [down, up] = await runTest(reader, { framesToSend: [_transcription("Hello there.")] });

  expect(reader.isUsable).toBe(false);
  expect(up.filter((f) => f instanceof ErrorFrame).length).toBeGreaterThan(0);
  expect(down.filter((f) => f instanceof PerceptionMetadataFrame)).toEqual([]);
  expect(down.filter((f) => f instanceof TranscriptionFrame).map((f) => f.perception)).toEqual([
    null,
  ]);
});

test("test_the_model_downloads_at_the_release_asked_for", async () => {
  const asked: { revision?: string }[] = [];

  const download = (options?: unknown) => {
    asked.push(options as { revision?: string });
    return new FakeReaderModel();
  };

  patchDownload(download);
  for (const reader of [newReader(), newReader({ revision: "reader-rc9" })]) {
    await runTest(reader, { framesToSend: [] });
  }

  expect(asked.map((a) => a.revision)).toEqual(["reader-rc1", "reader-rc9"]);
});

test("test_the_model_downloads_its_files_from_the_reader_folder", async () => {
  const tmpPath = await mkdtemp(join(tmpdir(), "pipecat-tone-reader-"));
  try {
    const seen: Record<string, unknown> = {};
    const urls: string[] = [];

    // Stands in for `snapshot_download`: the download fetches each file it asks for.
    const fetchFile = async (url: string | URL | Request) => {
      urls.push(String(url));
      return new Response("{}");
    };
    patchLoad((modelDir) => {
      seen.dir = String(modelDir);
      return {};
    });

    await PipecatToneReaderModel.download({
      downloadRoot: tmpPath,
      endpoint: "https://huggingface.co",
      fetch: fetchFile as typeof fetch,
    });

    // `<endpoint>/<repo>/resolve/<revision>/<pattern>`
    const parsed = urls.map((u) => {
      const m = /^https:\/\/huggingface\.co\/(.+?)\/resolve\/([^/]+)\/(.+)$/.exec(u);
      if (!m) throw new Error(`unexpected download URL: ${u}`);
      return { repo: m[1], revision: decodeURIComponent(m[2] as string), pattern: m[3] };
    });
    seen.repo = [...new Set(parsed.map((p) => p.repo))].join();
    seen.revision = [...new Set(parsed.map((p) => p.revision))].join();
    seen.patterns = parsed.map((p) => p.pattern);

    // The snapshot's root, as `snapshot_download` returns it.
    const root = `${tmpPath}/pipecat-ai--tone-models@reader-rc1`;
    expect(seen).toEqual({
      repo: "pipecat-ai/tone-models",
      revision: "reader-rc1",
      patterns: ["reader/config.json", "reader/tokenizer.json", "reader/model_fp16.onnx"],
      dir: `${root}/reader`,
    });
  } finally {
    await rm(tmpPath, { recursive: true, force: true });
  }
});

test("test_a_folder_of_your_own_loads_in_place_of_a_download", async () => {
  const tmpPath = await mkdtemp(join(tmpdir(), "pipecat-tone-reader-"));
  try {
    const loaded: [string, unknown][] = [];

    const fail = () => {
      throw new Error("no network");
    };

    const load = (modelDir: string | URL, options?: unknown) => {
      loaded.push([String(modelDir), (options as { precision?: string }).precision]);
      const self = Object.create(PipecatToneReaderModel.prototype);
      self.config = { emotions: ["neutral", "happy"] };
      return self;
    };

    patchDownload(fail);
    patchLoad(load);

    const [down] = await runTest(newReader({ modelDir: tmpPath, precision: "fp32" }), {
      framesToSend: [],
    });

    expect(loaded).toEqual([[tmpPath, "fp32"]]);
    expect(down.filter((f) => f instanceof PerceptionMetadataFrame).length).toBeGreaterThan(0);
  } finally {
    await rm(tmpPath, { recursive: true, force: true });
  }
});
