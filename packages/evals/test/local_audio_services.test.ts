// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

// The keyless local audio defaults (Kokoro, Moonshine, Whisper) are built by
// name. Construction resolves settings only; nothing is downloaded until the
// services start.

import { describe, expect, test } from "bun:test";
import { Language } from "@pipedog/core/transcriptions/language";
import { KokoroTTSService } from "@pipedog/kokoro/tts";
import { MoonshineSTTService } from "@pipedog/moonshine/stt";
import { WhisperSTTService } from "@pipedog/whisper/stt";
import { sttServiceFromConfig, ttsServiceFromConfig } from "../src/services.ts";

type Settings = Record<string, unknown>;
const settingsOf = (service: unknown) => (service as { _settings: Settings })._settings;

describe("local audio services by name", () => {
  test("kokoro builds a KokoroTTSService with voice, language and speed", async () => {
    const tts = await ttsServiceFromConfig(
      { service: "kokoro", voice: "af_heart", language: "en", speed: 1.2 },
      { useCache: false },
    );
    const service = (tts as unknown as { _inner: unknown })._inner;
    expect(service).toBeInstanceOf(KokoroTTSService);
    expect(settingsOf(service).voice).toBe("af_heart");
    expect(settingsOf(service).speed).toBe(1.2);
  });

  test("moonshine is the default transcriber", async () => {
    const stt = await sttServiceFromConfig(null);
    expect(stt).toBeInstanceOf(MoonshineSTTService);
    expect(settingsOf(stt).model).toBe("small-streaming");
    expect(settingsOf(stt).language).toBe("en");
  });

  test("whisper disables the non-speech filter and uses int8 on the CPU", async () => {
    const stt = await sttServiceFromConfig({
      service: "whisper",
      model: "large-v3-turbo",
      language: Language.ES,
    });
    expect(stt).toBeInstanceOf(WhisperSTTService);
    expect(settingsOf(stt).noSpeechProb).toBe(1.0);
    expect(settingsOf(stt).language).toBe("es");
    expect((stt as unknown as { _computeType: string })._computeType).toBe("int8");
  });
});
