// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Samples for content/docs/services/tts/aws.mdx. Type-checked on every docs build.

// #region usage
import { AWSPollyTTSService } from "@pipedog/aws/tts";
import { TTSUpdateSettingsFrame } from "@pipedog/core/frames/frames";

const tts = new AWSPollyTTSService({
  // Or leave these out to read the AWS_* environment variables.
  awsAccessKeyId: process.env.AWS_ACCESS_KEY_ID,
  apiKey: process.env.AWS_SECRET_ACCESS_KEY,
  region: "us-east-1",
  sampleRate: 24000,
  settings: new AWSPollyTTSService.Settings({
    voice: "Joanna",
    engine: "generative",
    language: "en-US",
    rate: "105%",
  }),
});
// #endregion usage

// #region update
// Queue it on the worker, or push it from a processor upstream of the service.
const update = new TTSUpdateSettingsFrame({
  delta: new AWSPollyTTSService.Settings({ voice: "Matthew" }),
});
// #endregion update
