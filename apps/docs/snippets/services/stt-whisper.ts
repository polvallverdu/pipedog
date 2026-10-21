// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Samples for content/docs/services/stt/whisper.mdx. Type-checked on every docs build.

// #region usage
import { Language } from "@pipedog/core/transcriptions/language";
import { OpenAISTTService } from "@pipedog/openai/stt";
import { BaseWhisperSTTService, type Transcription } from "@pipedog/whisper/base_stt";

// A server that speaks OpenAI's /v1/audio/transcriptions API.
const stt = new OpenAISTTService({
  apiKey: process.env.WHISPER_API_KEY ?? "",
  baseUrl: "http://localhost:8000/v1",
  settings: new OpenAISTTService.Settings({
    model: "whisper-1",
    language: Language.EN,
  }),
});
// #endregion usage

// #region subclass
/** A provider whose Whisper-compatible endpoint needs its own request shape. */
class MyWhisperSTTService extends BaseWhisperSTTService {
  // Fail at construction without a key, instead of falling back to OPENAI_API_KEY.
  protected static override _requiresApiKey = true;

  protected override async _transcribe(audio: Uint8Array): Promise<Transcription> {
    return await this._client.audio.transcriptions.create({
      file: new File([audio.slice()], "audio.wav", { type: "audio/wav" }),
      model: String(this._settings.model),
      language: String(this._settings.language),
      response_format: "json",
    });
  }
}

const custom = new MyWhisperSTTService({
  apiKey: process.env.WHISPER_API_KEY ?? "",
  baseUrl: "https://whisper.example.com/v1",
  settings: new MyWhisperSTTService.Settings({ model: "whisper-large-v3", language: Language.EN }),
});
// #endregion subclass
