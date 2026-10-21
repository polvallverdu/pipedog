// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_aws_stt_language.py

/** Tests for AWS Transcribe STT language code mapping. */

import { describe, expect, test } from "bun:test";
import { Language } from "@pipedog/core/transcriptions/language";
import { AWSTranscribeSTTService } from "../src/stt.ts";

const CASES: [Language, string][] = [
  [Language.CKB_IQ, "ckb-IQ"],
  [Language.CKB_IR, "ckb-IR"],
  [Language.EN_AB, "en-AB"],
  [Language.EN_WL, "en-WL"],
  [Language.FA_AF, "fa-AF"],
  [Language.KAB, "kab-DZ"],
  [Language.KAB_DZ, "kab-DZ"],
  [Language.SW_BI, "sw-BI"],
  [Language.SW_RW, "sw-RW"],
  [Language.SW_UG, "sw-UG"],
];

describe("test_aws_streaming_languages", () => {
  for (const [language, expected] of CASES) {
    // AWS streaming language variants should resolve to their provider codes.
    test(`${language}-${expected}`, () => {
      const service = Object.create(AWSTranscribeSTTService.prototype) as AWSTranscribeSTTService;

      expect(service.languageToServiceLanguage(language)).toEqual(expected);
    });
  }
});
