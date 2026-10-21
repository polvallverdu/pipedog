// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// What the end-to-end test needs from a mock provider API, and the shared replies.

export const SCRIPTED_QUESTION = "What is the capital of Germany?";
export const ANSWER = "The capital of Germany is Berlin.";
export const GREETING = "Hello, I am your voice assistant. Ask me anything.";

export interface ProviderMock {
  /** Base URL to use as the provider's API base URL. */
  baseUrl: string;
  /** Bytes of user audio the speech-to-text service sent. */
  heard: number;
  /** The text of each user turn the chat model was asked to answer. */
  asked: string[];
  /** The text of each speech synthesis request. */
  spoken: string[];
  stop(): void;
}

/** 0.5 s of a 440 Hz tone, 24 kHz mono 16-bit little-endian PCM. */
export function tonePcm(): ArrayBuffer {
  const samples = 12000;
  const pcm = new Int16Array(samples);
  for (let i = 0; i < samples; i++)
    pcm[i] = Math.round(6000 * Math.sin((2 * Math.PI * 440 * i) / 24000));
  return pcm.buffer;
}
