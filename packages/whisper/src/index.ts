// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Whisper for pipedog.
 *
 * - `@pipedog/whisper/base_stt` mirrors `pipecat.services.whisper.base_stt`
 *   (the Whisper-API base class used by the OpenAI and Groq services).
 * - `@pipedog/whisper/utils` mirrors `pipecat.services.whisper.utils`.
 * - `@pipedog/whisper/stt` mirrors `pipecat.services.whisper.stt` (local
 *   Whisper models), on the ONNX engine in `@pipedog/whisper/faster_whisper`.
 *
 * The root re-exports `base_stt` and `utils` only. `stt` is left out on
 * purpose: it pulls in `@pipedog/onnx` (and with it onnxruntime-web on
 * Cloudflare Workers) and the tokenizer, which the API-based services that
 * import this root don't need. It also defines its own
 * `languageToWhisperLanguage` (local Whisper's 30 verified languages), which
 * would clash with `base_stt`'s (the Whisper API's list); the root keeps
 * `base_stt`'s. Import local Whisper from `@pipedog/whisper/stt`.
 */

export * from "./base_stt.ts";
export * from "./utils.ts";
