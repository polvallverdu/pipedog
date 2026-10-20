// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/audio/dtmf/utils.py

/**
 * DTMF audio utilities.
 *
 * Provides functionality to load DTMF (Dual-Tone Multi-Frequency) audio files
 * corresponding to phone keypad entries. Audio data is cached in-memory after
 * first load to improve performance on subsequent accesses.
 *
 * Porting note: the WAV files bundled upstream are embedded (base64) in
 * `dtmf_data.ts`, so no filesystem access is needed on any runtime.
 */

import { Lock } from "@pipedog/asyncio";
import type { BaseAudioResampler } from "../resamplers/base_audio_resampler.ts";
import { createFileResampler, readWav } from "../utils.ts";
import { DTMF_WAV_FILES } from "./dtmf_data.ts";
import { KeypadEntry } from "./types.ts";

const DTMF_LOCK = new Lock();
const DTMF_AUDIO = new Map<string, Uint8Array>();
let DTMF_RESAMPLER: BaseAudioResampler | null = null;

const DTMF_FILE_NAME: Partial<Record<KeypadEntry, string>> = {
  [KeypadEntry.POUND]: "dtmf-pound.wav",
  [KeypadEntry.STAR]: "dtmf-star.wav",
};

function readBundledFile(fileName: string): Uint8Array {
  const encoded = DTMF_WAV_FILES[fileName];
  if (encoded === undefined) {
    throw new Error(`No such DTMF audio file: ${fileName}`);
  }
  const binary = atob(encoded);
  const data = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) data[i] = binary.charCodeAt(i);
  return data;
}

export interface LoadDtmfAudioOptions {
  /** The sample rate for the audio. Defaults to 8000. */
  sampleRate?: number;
}

/**
 * Load audio for DTMF tones associated with the given button.
 *
 * @param button The button for which the DTMF audio is to be loaded.
 * @returns The audio data for the DTMF tone.
 */
export async function loadDtmfAudio(
  button: KeypadEntry,
  options: LoadDtmfAudioOptions = {},
): Promise<Uint8Array> {
  const sampleRate = options.sampleRate ?? 8000;
  const cacheKey = `${button}:${sampleRate}`;

  await DTMF_LOCK.run(async () => {
    if (DTMF_AUDIO.has(cacheKey)) {
      return;
    }

    if (!DTMF_RESAMPLER) {
      DTMF_RESAMPLER = createFileResampler();
    }

    const dtmfFileName = DTMF_FILE_NAME[button] ?? `dtmf-${button}.wav`;
    const data = readBundledFile(dtmfFileName);

    const wav = readWav(data);
    const resampledAudio = await DTMF_RESAMPLER.resample(wav.audio, wav.sampleRate, sampleRate);
    DTMF_AUDIO.set(cacheKey, resampledAudio);
  });

  return DTMF_AUDIO.get(cacheKey) as Uint8Array;
}
