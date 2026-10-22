// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Sample for content/docs/deployment/bundling.mdx. Type-checked on every docs build; the same
// recipe runs, bundled, in examples/bundle-check.

// #region google
import * as speechModule from "@google-cloud/speech";
import * as textToSpeechModule from "@google-cloud/text-to-speech";
import { GoogleSTTService } from "@pipedog/google/stt";
import { GoogleHttpTTSService } from "@pipedog/google/tts";

// Import the SDKs yourself and hand them over: the services import them by name otherwise.
export const stt = new GoogleSTTService({ speechModule });
export const tts = new GoogleHttpTTSService({ textToSpeechModule });
// #endregion
