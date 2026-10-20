// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipecat-ts contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/services/stt_latency.py

/**
 * STT service latency defaults.
 *
 * This module contains P99 time-to-final-segment (TTFS) latency values for
 * STT services. TTFS measures the time from when speech ends to when the
 * final transcript is received.
 *
 * These values are used by turn stop strategies to optimize timing. Each STT
 * service publishes its latency via STTMetadataFrame at pipeline start.
 *
 * All built-in values were measured with `VADParams.stopSecs=0.2`, the
 * recommended default. If you change `stopSecs`, re-run the benchmark with
 * your VAD settings and pass the measured value to your STT service
 * constructor.
 *
 * To measure latency for your specific deployment (region, network
 * conditions, self-hosted instances), use the STT benchmark tool:
 * https://github.com/pipecat-ai/stt-benchmark
 *
 * Run the TTFS benchmark for your service and configuration, then pass the
 * measured value to your STT service constructor:
 *
 * @example
 * const stt = new DeepgramSTTService({ apiKey: "...", ttfsP99Latency: 0.45 });
 *
 * Turn-based STT services (e.g. `CartesiaTurnsSTTService`,
 * `DeepgramFluxSTTService`) have no meaningful TTFS metric — the server
 * defines the turn boundary directly, so there is no separate "speech end →
 * final transcript" interval to measure. Those services override the
 * `STTService.supportsTtfs` property to return false rather than supplying a
 * constant here.
 */

// Conservative fallback for services without measured values
export const DEFAULT_TTFS_P99: number = 1.0;

// Measured P99 TTFS latency values (in seconds)
export const ASSEMBLYAI_TTFS_P99: number = 0.42;
export const ASSEMBLYAI_SYNC_TTFS_P99: number = 0.65;
export const AWS_TRANSCRIBE_TTFS_P99: number = 1.9;
export const AZURE_TTFS_P99: number = 1.8;
export const CARTESIA_TTFS_P99: number = 0.81;
export const DEEPGRAM_TTFS_P99: number = 0.35;
export const DEEPGRAM_SAGEMAKER_TTFS_P99: number = 0.35;
export const ELEVENLABS_TTFS_P99: number = 2.01;
export const ELEVENLABS_REALTIME_TTFS_P99: number = 0.41;
export const FAL_TTFS_P99: number = 2.07;
export const GEMINI_TTFS_P99: number = 0.6;
export const GLADIA_TTFS_P99: number = 1.49;
export const GOOGLE_TTFS_P99: number = 1.57;
export const GRADIUM_TTFS_P99: number = 0.62;
export const GROQ_TTFS_P99: number = 1.54;
export const META_TTFS_P99: number = 1.92;
export const MISTRAL_TTFS_P99: number = 1.89;
export const OPENAI_TTFS_P99: number = 2.01;
export const OPENAI_REALTIME_TTFS_P99: number = 1.66;
export const SARVAM_TTFS_P99: number = 1.17;
// Provisional until benchmarked against the realtime endpoint.
export const SARVAM_REALTIME_TTFS_P99: number = 1.0;
export const SMALLEST_TTFS_P99: number = 1.59;
export const SONIOX_TTFS_P99: number = 0.35;
export const SPEECHMATICS_TTFS_P99: number = 0.74;
export const XAI_TTFS_P99: number = 2.14;
export const TOGETHER_TTFS_P99: number = 1.0;

// These services run locally and should be replaced with measured values
export const NVIDIA_TTFS_P99: number = DEFAULT_TTFS_P99;
export const WHISPER_TTFS_P99: number = DEFAULT_TTFS_P99;
