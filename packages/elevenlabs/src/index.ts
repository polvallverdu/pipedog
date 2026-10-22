// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/** ElevenLabs services for pipedog. Subpaths mirror `pipecat.services.elevenlabs.*` (`/stt`, `/tts`, `/dialogue/tts`). */

export * from "./dialogue/tts.ts";
export * from "./stt.ts";
export * from "./tts.ts";
export * from "./tts_base.ts";

// Both the STT and TTS modules define a language mapping under this name, as
// upstream does. The root exports the TTS one; `@pipedog/elevenlabs/stt` has the STT one.
export { languageToElevenlabsLanguage } from "./tts_base.ts";
