// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Samples for content/docs/services/stt/meta.mdx. Type-checked on every docs build.

// #region usage
import { Language } from "@pipedog/core/transcriptions/language";
import { MetaSTTService } from "@pipedog/meta/stt";

const stt = new MetaSTTService({
  apiKey: process.env.META_API_KEY ?? "",
  settings: new MetaSTTService.Settings({ language: Language.EN, keywords: ["pipedog"] }),
});
// #endregion usage
