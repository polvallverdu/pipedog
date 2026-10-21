// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Samples for content/docs/services/stt/aws.mdx. Type-checked on every docs build.

// #region usage
import { AWSTranscribeSTTService } from "@pipedog/aws/stt";
import { STTUpdateSettingsFrame } from "@pipedog/core/frames/frames";
import { Language } from "@pipedog/core/transcriptions/language";

const stt = new AWSTranscribeSTTService({
  // Or leave these out to read AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY,
  // AWS_SESSION_TOKEN and AWS_REGION from the environment.
  awsAccessKeyId: process.env.AWS_ACCESS_KEY_ID,
  apiKey: process.env.AWS_SECRET_ACCESS_KEY,
  region: "us-east-1",
  sampleRate: 16000,
  settings: new AWSTranscribeSTTService.Settings({
    language: Language.EN_US,
    partialResultsStability: "medium",
  }),
});
// #endregion usage

// #region update
// Queue it on the worker, or push it from a processor upstream of the service.
// Transcribe binds the language to the connection, so this reconnects.
const update = new STTUpdateSettingsFrame({
  delta: new AWSTranscribeSTTService.Settings({ language: Language.ES_ES }),
});
// #endregion update
