// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Piper voices: the parts of Python's `piper` (piper-tts 1.8.0, OHF-Voice
 * piper1-gpl) that Pipecat's `PiperTTSService` uses, on `@pipedog/onnx` and
 * `@pipedog/espeak-ng`.
 *
 * - `PiperVoice.load(modelPath, { useCuda })` reads `<model>.onnx.json`
 *   (`PiperConfig`) and opens the model.
 * - `voice.synthesize(text)` yields one `AudioChunk` per sentence, like
 *   `piper.voice.PiperVoice.synthesize`:
 *   1. espeak-ng phonemizes the text clause by clause (IPA, no separators),
 *      language-switch flags like `(en)` are removed, the clause's
 *      punctuation is appended (`.`, `?`, `!`, `,`, `:`, `;`; a space after
 *      `,`, `:`, `;`), and the phonemes are decomposed (NFD) into code points;
 *      sentences end where espeak-ng ends them.
 *   2. Phoneme ids: `^`, then each phoneme followed by the pad `_`, then `$`
 *      (`phoneme_id_map` from the config; unknown phonemes are skipped).
 *   3. Inference with `input` (int64 `[1, n]`), `input_lengths` (`[n]`),
 *      `scales` (float32 `[noise_scale, length_scale, noise_w]`) and, for
 *      multi-speaker voices, `sid`.
 *   4. Audio is peak-normalized (`normalize_audio`), scaled by `volume`,
 *      clipped to [-1, 1]; int16 is `clip(x * 32767, -32767, 32767)`.
 * - `downloadVoice(voice, dir)` fetches `<voice>.onnx` and `<voice>.onnx.json`
 *   from Hugging Face `rhasspy/piper-voices`, like `piper.download_voices`.
 *
 * Not ported: phoneme types other than `espeak` and `text` (Chinese, Hebrew,
 * Japanese and Thai voices need other G2P models), Arabic diacritization
 * (tashkeel), and phoneme/audio alignments.
 */

import { logger } from "@pipedog/core/utils/logger";
import { type EspeakNG, getEspeakNG } from "@pipedog/espeak-ng";
import {
  createOnnxBackend,
  downloadModelFile,
  fileExists,
  float32Tensor,
  int64Tensor,
  loadModelBytes,
  type OnnxBackend,
  type OnnxSession,
  type OnnxSessionOptions,
  sharedSession,
} from "@pipedog/onnx";

// const.py
/** Padding (0). */
export const PAD = "_";
/** Beginning of sentence. */
export const BOS = "^";
/** End of sentence. */
export const EOS = "$";

// config.py
export const DEFAULT_NOISE_SCALE = 0.667;
export const DEFAULT_LENGTH_SCALE = 1.0;
export const DEFAULT_NOISE_W_SCALE = 0.8;
export const DEFAULT_HOP_LENGTH = 256;

export const PhonemeType = {
  ESPEAK: "espeak",
  TEXT: "text",
  PINYIN: "pinyin",
  HEBREW: "hebrew",
  JAPANESE: "japanese",
  THAI: "thai",
} as const;
export type PhonemeType = (typeof PhonemeType)[keyof typeof PhonemeType];

type Dict = Record<string, any>;

/** Piper configuration (`<voice>.onnx.json`). */
export class PiperConfig {
  /** Number of phonemes. */
  numSymbols: number;
  /** Number of speakers. */
  numSpeakers: number;
  /** Sample rate of output audio. */
  sampleRate: number;
  /** Name of espeak-ng voice or alphabet. */
  espeakVoice: string;
  /** Phoneme -> [id,]. */
  phonemeIdMap: Record<string, number[]>;
  /** espeak or text. */
  phonemeType: PhonemeType;
  /** Speaker -> id. */
  speakerIdMap: Record<string, number>;
  piperVersion: string | null;
  lengthScale: number;
  noiseScale: number;
  noiseWScale: number;
  hopLength: number;
  /** Clusters of vowels to merge into a single "phoneme", e.g. ["a", "ɪ"] -> "aɪ". */
  vowelClusters: string[][] | null;
  /** Id of the default speaker for multi-speaker voices. */
  defaultSpeakerId: number;

  constructor(options: {
    numSymbols: number;
    numSpeakers: number;
    sampleRate: number;
    espeakVoice: string;
    phonemeIdMap: Record<string, number[]>;
    phonemeType: PhonemeType;
    speakerIdMap?: Record<string, number>;
    piperVersion?: string | null;
    lengthScale?: number;
    noiseScale?: number;
    noiseWScale?: number;
    hopLength?: number;
    vowelClusters?: string[][] | null;
    defaultSpeakerId?: number;
  }) {
    this.numSymbols = options.numSymbols;
    this.numSpeakers = options.numSpeakers;
    this.sampleRate = options.sampleRate;
    this.espeakVoice = options.espeakVoice;
    this.phonemeIdMap = options.phonemeIdMap;
    this.phonemeType = options.phonemeType;
    this.speakerIdMap = options.speakerIdMap ?? {};
    this.piperVersion = options.piperVersion ?? null;
    this.lengthScale = options.lengthScale ?? DEFAULT_LENGTH_SCALE;
    this.noiseScale = options.noiseScale ?? DEFAULT_NOISE_SCALE;
    this.noiseWScale = options.noiseWScale ?? DEFAULT_NOISE_W_SCALE;
    this.hopLength = options.hopLength ?? DEFAULT_HOP_LENGTH;
    this.vowelClusters = options.vowelClusters ?? null;
    this.defaultSpeakerId = options.defaultSpeakerId ?? 0;
  }

  /** Load configuration from a dictionary (the parsed JSON). */
  static fromDict(config: Dict): PiperConfig {
    const inference: Dict = config.inference ?? {};
    const vowelClusters: string[][] | null = config.vowel_clusters?.length
      ? config.vowel_clusters
      : null;
    const phonemeType = (config.phoneme_type ?? PhonemeType.ESPEAK) as PhonemeType;
    if (!Object.values(PhonemeType).includes(phonemeType)) {
      throw new Error(`'${phonemeType}' is not a valid PhonemeType`);
    }
    return new PiperConfig({
      numSymbols: config.num_symbols,
      numSpeakers: config.num_speakers,
      sampleRate: config.audio.sample_rate,
      noiseScale: inference.noise_scale ?? DEFAULT_NOISE_SCALE,
      lengthScale: inference.length_scale ?? DEFAULT_LENGTH_SCALE,
      noiseWScale: inference.noise_w ?? DEFAULT_NOISE_W_SCALE,
      espeakVoice: config.espeak.voice,
      phonemeIdMap: config.phoneme_id_map,
      phonemeType,
      speakerIdMap: config.speaker_id_map ?? {},
      piperVersion: config.piper_version ?? null,
      hopLength: config.hop_length ?? DEFAULT_HOP_LENGTH,
      vowelClusters,
      defaultSpeakerId: config.default_speaker_id ?? 0,
    });
  }
}

/** Configuration for Piper synthesis. */
export class SynthesisConfig {
  /** Index of speaker to use (multi-speaker voices only). */
  speakerId: number | null;
  /** Phoneme length scale (< 1 is faster, > 1 is slower). */
  lengthScale: number | null;
  /** Amount of generator noise to add. */
  noiseScale: number | null;
  /** Amount of phoneme width noise to add. */
  noiseWScale: number | null;
  /** Enable/disable scaling audio samples to fit full range. */
  normalizeAudio: boolean;
  /** Multiplier for audio samples (< 1 is quieter, > 1 is louder). */
  volume: number;

  constructor(
    options: {
      speakerId?: number | null;
      lengthScale?: number | null;
      noiseScale?: number | null;
      noiseWScale?: number | null;
      normalizeAudio?: boolean;
      volume?: number;
    } = {},
  ) {
    this.speakerId = options.speakerId ?? null;
    this.lengthScale = options.lengthScale ?? null;
    this.noiseScale = options.noiseScale ?? null;
    this.noiseWScale = options.noiseWScale ?? null;
    this.normalizeAudio = options.normalizeAudio ?? true;
    this.volume = options.volume ?? 1.0;
  }
}

const MAX_WAV_VALUE = 32767.0;

/** Chunk of raw audio (one sentence). */
export class AudioChunk {
  /** Rate of chunk samples in Hertz. */
  readonly sampleRate: number;
  /** Width of chunk samples in bytes. */
  readonly sampleWidth: number;
  /** Number of channels in chunk samples. */
  readonly sampleChannels: number;
  /** Audio data as float array in [-1, 1]. */
  readonly audioFloatArray: Float32Array;
  /** Phonemes that produced this audio chunk. */
  readonly phonemes: string[];
  /** Phoneme ids that produced this audio chunk. */
  readonly phonemeIds: number[];
  #int16: Int16Array | null = null;

  constructor(options: {
    sampleRate: number;
    sampleWidth?: number;
    sampleChannels?: number;
    audioFloatArray: Float32Array;
    phonemes: string[];
    phonemeIds: number[];
  }) {
    this.sampleRate = options.sampleRate;
    this.sampleWidth = options.sampleWidth ?? 2;
    this.sampleChannels = options.sampleChannels ?? 1;
    this.audioFloatArray = options.audioFloatArray;
    this.phonemes = options.phonemes;
    this.phonemeIds = options.phonemeIds;
  }

  /** Audio as int16 samples: `clip(x * 32767, -32767, 32767)`, truncated. */
  get audioInt16Array(): Int16Array {
    if (!this.#int16) {
      const out = new Int16Array(this.audioFloatArray.length);
      for (let i = 0; i < out.length; i++) {
        // float32 arithmetic, as numpy does on a float32 array.
        const v = Math.fround((this.audioFloatArray[i] as number) * MAX_WAV_VALUE);
        out[i] = v > MAX_WAV_VALUE ? MAX_WAV_VALUE : v < -MAX_WAV_VALUE ? -MAX_WAV_VALUE : v;
      }
      this.#int16 = out;
    }
    return this.#int16;
  }

  /** Audio as signed 16-bit little-endian PCM bytes. */
  get audioInt16Bytes(): Uint8Array {
    const a = this.audioInt16Array;
    return new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
  }
}

// phoneme_ids.py
/** Piper's default phoneme id map (used when a config has none). */
export const DEFAULT_PHONEME_ID_MAP: Readonly<Record<string, number[]>> = Object.fromEntries(
  Object.entries({
    _: 0,
    "^": 1,
    $: 2,
    " ": 3,
    "!": 4,
    "'": 5,
    "(": 6,
    ")": 7,
    ",": 8,
    "-": 9,
    ".": 10,
    ":": 11,
    ";": 12,
    "?": 13,
    a: 14,
    b: 15,
    c: 16,
    d: 17,
    e: 18,
    f: 19,
    h: 20,
    i: 21,
    j: 22,
    k: 23,
    l: 24,
    m: 25,
    n: 26,
    o: 27,
    p: 28,
    q: 29,
    r: 30,
    s: 31,
    t: 32,
    u: 33,
    v: 34,
    w: 35,
    x: 36,
    y: 37,
    z: 38,
    æ: 39,
    ç: 40,
    ð: 41,
    ø: 42,
    ħ: 43,
    ŋ: 44,
    œ: 45,
    ǀ: 46,
    ǁ: 47,
    ǂ: 48,
    ǃ: 49,
    ɐ: 50,
    ɑ: 51,
    ɒ: 52,
    ɓ: 53,
    ɔ: 54,
    ɕ: 55,
    ɖ: 56,
    ɗ: 57,
    ɘ: 58,
    ə: 59,
    ɚ: 60,
    ɛ: 61,
    ɜ: 62,
    ɞ: 63,
    ɟ: 64,
    ɠ: 65,
    ɡ: 66,
    ɢ: 67,
    ɣ: 68,
    ɤ: 69,
    ɥ: 70,
    ɦ: 71,
    ɧ: 72,
    ɨ: 73,
    ɪ: 74,
    ɫ: 75,
    ɬ: 76,
    ɭ: 77,
    ɮ: 78,
    ɯ: 79,
    ɰ: 80,
    ɱ: 81,
    ɲ: 82,
    ɳ: 83,
    ɴ: 84,
    ɵ: 85,
    ɶ: 86,
    ɸ: 87,
    ɹ: 88,
    ɺ: 89,
    ɻ: 90,
    ɽ: 91,
    ɾ: 92,
    ʀ: 93,
    ʁ: 94,
    ʂ: 95,
    ʃ: 96,
    ʄ: 97,
    ʈ: 98,
    ʉ: 99,
    ʊ: 100,
    ʋ: 101,
    ʌ: 102,
    ʍ: 103,
    ʎ: 104,
    ʏ: 105,
    ʐ: 106,
    ʑ: 107,
    ʒ: 108,
    ʔ: 109,
    ʕ: 110,
    ʘ: 111,
    ʙ: 112,
    ʛ: 113,
    ʜ: 114,
    ʝ: 115,
    ʟ: 116,
    ʡ: 117,
    ʢ: 118,
    ʲ: 119,
    ˈ: 120,
    ˌ: 121,
    ː: 122,
    ˑ: 123,
    "˞": 124,
    β: 125,
    θ: 126,
    χ: 127,
    ᵻ: 128,
    ⱱ: 129,
    "0": 130,
    "1": 131,
    "2": 132,
    "3": 133,
    "4": 134,
    "5": 135,
    "6": 136,
    "7": 137,
    "8": 138,
    "9": 139,
    "̧": 140,
    "̃": 141,
    "̪": 142,
    "̯": 143,
    "̩": 144,
    ʰ: 145,
    ˤ: 146,
    ε: 147,
    "↓": 148,
    "#": 149,
    '"': 150,
    "↑": 151,
    "̺": 152,
    "̻": 153,
    g: 154,
    ʦ: 155,
    X: 156,
    "̝": 157,
    "̊": 158,
    ɝ: 159,
    ʷ: 160,
    // diphthongs
    aɪ: 161,
    aʊ: 162,
    ɔɪ: 163,
    eɪ: 164,
    oʊ: 165,
  }).map(([k, v]) => [k, [v]]),
);

/** Phonemes to ids: BOS, then each phoneme followed by PAD, then EOS. */
export function phonemesToIds(
  phonemes: string[],
  idMap?: Readonly<Record<string, readonly number[]>> | null,
): number[] {
  const map = idMap && Object.keys(idMap).length > 0 ? idMap : DEFAULT_PHONEME_ID_MAP;
  const ids: number[] = [];
  ids.push(...(map[BOS] ?? []));
  ids.push(...(map[PAD] ?? []));
  for (const phoneme of phonemes) {
    const phonemeIds = map[phoneme];
    if (!phonemeIds) {
      logger.warning(`Missing phoneme from id map: ${phoneme}`);
      continue;
    }
    ids.push(...phonemeIds);
    ids.push(...(map[PAD] ?? []));
  }
  ids.push(...(map[EOS] ?? []));
  return ids;
}

// phonemize_espeak.py

/** Merge adjacent recognized vowel clusters. */
function mergeKnownVowelClusters(phones: string[], clusters: string[][]): string[] {
  const keys = new Set(clusters.map((c) => c.join("\u0000")));
  const maxLen = Math.max(...clusters.map((c) => c.length));
  const out: string[] = [];
  let i = 0;
  while (i < phones.length) {
    let match: string[] | null = null;
    for (let n = Math.min(maxLen, phones.length - i); n > 1; n--) {
      const candidate = phones.slice(i, i + n);
      if (keys.has(candidate.join("\u0000"))) {
        match = candidate;
        break;
      }
    }
    if (match) {
      out.push(match.join(""));
      i += match.length;
    } else {
      out.push(phones[i] as string);
      i += 1;
    }
  }
  return out;
}

/** Phonemizer that uses espeak-ng. */
export class EspeakPhonemizer {
  readonly #espeak: EspeakNG;

  constructor(espeak: EspeakNG) {
    this.#espeak = espeak;
  }

  /** Text to phonemes grouped by sentence. */
  phonemize(voice: string, text: string, vowelClusters?: string[][] | null): string[][] {
    this.#espeak.setVoice(voice);

    const allPhonemes: string[][] = [];
    let sentencePhonemes: string[] = [];

    for (const clause of this.#espeak.textToPhonemesWithTerminator(text)) {
      // Filter out (lang) switch (flags).
      // These surround words from languages other than the current voice.
      let phonemesStr = clause.phonemes.replace(/\([^)]+\)/g, "");

      // Keep punctuation even though it's not technically a phoneme
      phonemesStr += clause.punctuation;
      if (clause.punctuation === "," || clause.punctuation === ":" || clause.punctuation === ";") {
        // Not a sentence boundary
        phonemesStr += " ";
      }

      // Decompose phonemes into UTF-8 codepoints.
      // This separates accent characters into separate "phonemes".
      sentencePhonemes.push(...Array.from(phonemesStr.normalize("NFD")));

      if (clause.endOfSentence) {
        if (vowelClusters?.length) {
          sentencePhonemes = mergeKnownVowelClusters(sentencePhonemes, vowelClusters);
        }
        allPhonemes.push(sentencePhonemes);
        sentencePhonemes = [];
      }
    }

    if (sentencePhonemes.length > 0) {
      // Text without a final sentence terminator
      if (vowelClusters?.length) {
        sentencePhonemes = mergeKnownVowelClusters(sentencePhonemes, vowelClusters);
      }
      allPhonemes.push(sentencePhonemes);
    }
    return allPhonemes;
  }
}

// voice.py

const PHONEME_BLOCK_PATTERN = /(\[\[.*?\]\])/;

export interface PiperVoiceLoadOptions {
  /** Path to JSON voice config (defaults to `modelPath + ".json"`). */
  configPath?: string | URL | null;
  /**
   * True if CUDA (GPU) should be used instead of CPU.
   *
   * DIVERGENCE: accepted but ignored; `@pipedog/onnx` sessions run on the
   * backend's default (CPU) execution provider.
   */
  useCuda?: boolean;
  /** The ONNX backend (default: `createOnnxBackend()`). */
  backend?: OnnxBackend | Promise<OnnxBackend> | null;
  /** Share the session with other voices loading the same model (default `true`). */
  shareSession?: boolean;
  /** Session options passed to the backend. */
  sessionOptions?: OnnxSessionOptions;
  /** The eSpeak NG instance (default: the shared one). */
  espeak?: EspeakNG | Promise<EspeakNG> | null;
}

let warnedCuda = false;

/** A voice for Piper. */
export class PiperVoice {
  /** ONNX session. */
  readonly session: OnnxSession;
  /** Piper voice configuration. */
  readonly config: PiperConfig;
  readonly #espeak: EspeakNG | Promise<EspeakNG> | null;

  constructor(options: {
    session: OnnxSession;
    config: PiperConfig;
    espeak?: EspeakNG | Promise<EspeakNG> | null;
  }) {
    this.session = options.session;
    this.config = options.config;
    this.#espeak = options.espeak ?? null;
  }

  /**
   * Load an ONNX model and config.
   *
   * @param modelPath Path to ONNX voice model (or a URL).
   * @returns Voice object.
   */
  static async load(
    modelPath: string | URL,
    options: PiperVoiceLoadOptions = {},
  ): Promise<PiperVoice> {
    const modelRef = modelPath instanceof URL ? modelPath.href : modelPath;
    const configPath = options.configPath ?? `${modelRef}.json`;
    logger.debug(`Guessing voice config path: ${String(configPath)}`);
    const configBytes = await loadModelBytes(configPath);
    const configDict = JSON.parse(new TextDecoder().decode(configBytes)) as Dict;

    if (options.useCuda && !warnedCuda) {
      warnedCuda = true;
      logger.warning(
        "Piper: useCuda is not supported; running on the ONNX backend's default provider",
      );
    }

    const backend = await (options.backend ?? createOnnxBackend());
    const sessionOptions = options.sessionOptions ?? {};
    const session =
      options.shareSession === false
        ? await backend.createSession(modelPath, sessionOptions)
        : await sharedSession(backend, modelPath, sessionOptions);

    return new PiperVoice({
      config: PiperConfig.fromDict(configDict),
      session,
      espeak: options.espeak,
    });
  }

  /**
   * Text to phonemes grouped by sentence.
   *
   * @param text Text to phonemize. `[[ ... ]]` blocks are raw phonemes.
   * @returns List of phonemes for each sentence.
   */
  async phonemize(text: string): Promise<string[][]> {
    if (this.config.phonemeType === PhonemeType.TEXT) {
      // Phonemes = codepoints
      return [Array.from(text.normalize("NFD"))];
    }
    if (this.config.phonemeType !== PhonemeType.ESPEAK) {
      throw new Error(`Unsupported phoneme type: ${this.config.phonemeType}`);
    }
    if (this.config.espeakVoice === "ar") {
      logger.warning(
        "Piper: Arabic diacritization (tashkeel) is not supported; using the text as is",
      );
    }

    const phonemizer = new EspeakPhonemizer(await (this.#espeak ?? getEspeakNG()));
    const phonemes: string[][] = [];
    const textParts = text.split(PHONEME_BLOCK_PATTERN);
    let prevRawPhonemes = false;
    for (let i = 0; i < textParts.length; i++) {
      const textPart = textParts[i] as string;
      if (textPart.startsWith("[[")) {
        prevRawPhonemes = true;

        // Phonemes
        if (phonemes.length === 0) {
          // Start new sentence
          phonemes.push([]);
        }
        const last = phonemes[phonemes.length - 1] as string[];
        if (i > 0 && (textParts[i - 1] as string).endsWith(" ")) last.push(" ");
        last.push(...Array.from(textPart.slice(2, -2).trim()));
        if (i < textParts.length - 1 && (textParts[i + 1] as string).startsWith(" "))
          last.push(" ");
        continue;
      }

      let textPartPhonemes = phonemizer.phonemize(
        this.config.espeakVoice,
        textPart,
        this.config.vowelClusters,
      );
      if (prevRawPhonemes && textPartPhonemes.length > 0) {
        // Add to previous block of phonemes first if it came from [[ raw phonemes]]
        (phonemes[phonemes.length - 1] as string[]).push(...(textPartPhonemes[0] as string[]));
        textPartPhonemes = textPartPhonemes.slice(1);
      }
      phonemes.push(...textPartPhonemes);
      prevRawPhonemes = false;
    }

    if (phonemes.length > 0 && (phonemes[phonemes.length - 1] as string[]).length === 0) {
      // Remove empty phonemes
      phonemes.pop();
    }
    return phonemes;
  }

  /** Phonemes to ids. */
  phonemesToIds(phonemes: string[]): number[] {
    return phonemesToIds(phonemes, this.config.phonemeIdMap);
  }

  /**
   * Synthesize one audio chunk per sentence from text.
   *
   * @param text Text to synthesize.
   * @param synConfig Synthesis configuration.
   */
  async *synthesize(
    text: string,
    synConfig?: SynthesisConfig | null,
  ): AsyncGenerator<AudioChunk, void, undefined> {
    const config = synConfig ?? new SynthesisConfig();
    const sentencePhonemes = await this.phonemize(text);
    logger.debug(`text=${text}, phonemes=${JSON.stringify(sentencePhonemes)}`);

    for (const phonemes of sentencePhonemes) {
      if (phonemes.length === 0) continue;

      const phonemeIds = this.phonemesToIds(phonemes);
      let audio = await this.phonemeIdsToAudio(phonemeIds, config);

      if (config.normalizeAudio) {
        let maxVal = 0;
        for (const v of audio) maxVal = Math.max(maxVal, Math.abs(v));
        if (maxVal < 1e-8) {
          // Prevent division by zero
          audio = new Float32Array(audio.length);
        } else {
          audio = audio.map((v) => v / maxVal);
        }
      }
      if (config.volume !== 1.0) {
        audio = audio.map((v) => v * config.volume);
      }
      audio = audio.map((v) => (v > 1 ? 1 : v < -1 ? -1 : v));

      yield new AudioChunk({
        sampleRate: this.config.sampleRate,
        sampleWidth: 2,
        sampleChannels: 1,
        audioFloatArray: audio,
        phonemes,
        phonemeIds,
      });
    }
  }

  /**
   * Synthesize raw audio from phoneme ids.
   *
   * @returns Audio float array from voice model (unnormalized, in range [-1, 1]).
   */
  async phonemeIdsToAudio(
    phonemeIds: number[],
    synConfig?: SynthesisConfig | null,
  ): Promise<Float32Array> {
    const config = synConfig ?? new SynthesisConfig();
    let speakerId = config.speakerId;
    const lengthScale = config.lengthScale ?? this.config.lengthScale;
    const noiseScale = config.noiseScale ?? this.config.noiseScale;
    const noiseWScale = config.noiseWScale ?? this.config.noiseWScale;

    const feeds = {
      input: int64Tensor(BigInt64Array.from(phonemeIds, BigInt), [1, phonemeIds.length]),
      input_lengths: int64Tensor(BigInt64Array.of(BigInt(phonemeIds.length)), [1]),
      scales: float32Tensor(Float32Array.of(noiseScale, lengthScale, noiseWScale), [3]),
    } as Record<string, ReturnType<typeof int64Tensor>>;

    if (this.config.numSpeakers <= 1) speakerId = null;
    if (this.config.numSpeakers > 1 && speakerId === null) {
      // Default speaker
      speakerId = this.config.defaultSpeakerId;
    }
    if (speakerId !== null) {
      feeds.sid = int64Tensor(BigInt64Array.of(BigInt(speakerId)), [1]);
    }

    // Synthesize through onnx
    const result = await this.session.run(feeds);
    return result[this.session.outputNames[0] as string]?.data as Float32Array;
  }
}

// download_voices.py

export const URL_FORMAT =
  "https://huggingface.co/rhasspy/piper-voices/resolve/main/{lang_family}/{lang_code}/{voice_name}/{voice_quality}/{lang_code}-{voice_name}-{voice_quality}{extension}?download=true";
export const VOICES_JSON =
  "https://huggingface.co/rhasspy/piper-voices/resolve/main/voices.json?download=true";
export const VOICE_PATTERN =
  /^(?<lang_family>[^-]+)_(?<lang_region>[^-]+)-(?<voice_name>[^-]+)-(?<voice_quality>.+)$/;

function joinPath(dir: string, file: string): string {
  return dir.endsWith("/") || dir.endsWith("\\") ? `${dir}${file}` : `${dir}/${file}`;
}

/**
 * Download a voice model and config file to a directory.
 *
 * @param voice Name of voice like `en_US-lessac-medium`.
 * @param downloadDir Directory to download into.
 * @param options.forceRedownload Download again even if the files exist.
 * @param options.fetch `fetch` to download with (default: the global `fetch`).
 */
export async function downloadVoice(
  voice: string,
  downloadDir: string,
  options: { forceRedownload?: boolean; fetch?: typeof fetch } = {},
): Promise<void> {
  voice = voice.trim();
  const voiceMatch = VOICE_PATTERN.exec(voice);
  if (!voiceMatch?.groups) {
    throw new Error(
      `Voice '${voice}' did not match pattern: <language>-<name>-<quality> like 'en_US-lessac-medium'`,
    );
  }
  const g = voiceMatch.groups as Record<string, string>;
  const langFamily = g.lang_family as string;
  const langCode = `${langFamily}_${g.lang_region}`;
  const voiceCode = `${langCode}-${g.voice_name}-${g.voice_quality}`;
  const url = (extension: string) =>
    URL_FORMAT.replaceAll("{lang_family}", langFamily)
      .replaceAll("{lang_code}", langCode)
      .replaceAll("{voice_name}", g.voice_name as string)
      .replaceAll("{voice_quality}", g.voice_quality as string)
      .replaceAll("{extension}", extension);

  for (const extension of [".onnx", ".onnx.json"]) {
    const path = joinPath(downloadDir, `${voiceCode}${extension}`);
    const force = options.forceRedownload ?? false;
    if (force || !(await fileExists(path))) {
      const from = url(extension);
      logger.debug(
        `Downloading ${extension === ".onnx" ? "model" : "config"} from '${from}' to '${path}'`,
      );
      await downloadModelFile(from, path, { force, fetch: options.fetch });
      logger.debug(`Downloaded: '${path}'`);
    }
  }
  logger.info(`Downloaded: ${voice}`);
}
