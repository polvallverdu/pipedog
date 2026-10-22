// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Samples for content/docs/services/stt/soniox.mdx. Type-checked on every docs build.

// #region usage
import { Language } from "@pipedog/core/transcriptions/language";
import { SonioxSTTService } from "@pipedog/soniox/stt";

const stt = new SonioxSTTService({
  apiKey: process.env.SONIOX_API_KEY ?? "",
  settings: new SonioxSTTService.Settings({ languageHints: [Language.EN, Language.ES] }),
});
// #endregion usage
