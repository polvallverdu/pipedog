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

// #region local
import { Model, WhisperSTTService } from "@pipedog/whisper/stt";

// Downloads distil-whisper/distil-medium.en (402 MB with int8) on first start.
const local = new WhisperSTTService({
  computeType: "int8", // smaller download, faster on CPU
  settings: new WhisperSTTService.Settings({
    model: Model.DISTIL_MEDIUM_EN,
    language: Language.EN,
    hotwords: "Pipecat pipedog",
  }),
});
// #endregion local

// #region modelOptions
// Never download: read the files from a cache you filled beforehand.
const offline = new WhisperSTTService({
  modelOptions: { downloadRoot: "/models/whisper", localFilesOnly: true },
  settings: new WhisperSTTService.Settings({ model: Model.LARGE_V3_TURBO, language: Language.ES }),
});

// #endregion modelOptions

// #region mlx
import { MLXModel, WhisperSTTServiceMLX } from "@pipedog/whisper/stt";

// Not MLX: the same ONNX engine, with MLX Whisper's model names and greedy decoding.
const mlx = new WhisperSTTServiceMLX({
  settings: new WhisperSTTServiceMLX.Settings({
    model: MLXModel.LARGE_V3_TURBO_Q4,
    language: Language.EN,
    temperature: 0.0,
  }),
});

// #endregion mlx

// #region probability
import { TranscriptionFrame } from "@pipedog/core/frames/frames";
import { extractWhisperProbability } from "@pipedog/whisper/utils";

// In a frame processor after an STT service created with includeProbMetrics: true.
function logConfidence(frame: unknown): void {
  if (frame instanceof TranscriptionFrame) {
    const prob = extractWhisperProbability(frame);
    if (prob !== null) console.log(`Transcription confidence: ${(prob * 100).toFixed(2)}%`);
  }
}

// #endregion probability

// #region engine
import { WhisperModel } from "@pipedog/whisper/faster_whisper";

const model = new WhisperModel("tiny", { computeType: "int8" });
const audio = new Float32Array(16000); // 16 kHz mono audio in [-1, 1]
const [segments, info] = await model.transcribe(audio, { language: null });
for await (const s of segments) console.log(info.language, s.start, s.end, s.text, s.noSpeechProb);
// #endregion engine
