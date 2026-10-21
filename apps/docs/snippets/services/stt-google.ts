// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Samples for content/docs/services/stt/google.mdx (Cloud Speech-to-Text). Type-checked on every docs build.

// #region usage
import { STTUpdateSettingsFrame } from "@pipedog/core/frames/frames";
import { Language } from "@pipedog/core/transcriptions/language";
import { GoogleSTTService } from "@pipedog/google/stt";

const stt = new GoogleSTTService({
  credentialsPath: process.env.GOOGLE_APPLICATION_CREDENTIALS ?? "",
  location: "global",
  settings: new GoogleSTTService.Settings({
    model: "latest_long",
    languages: [Language.EN_US],
    enableInterimResults: true,
  }),
});
// #endregion usage

// #region adaptation
// Bias recognition with a stored phrase set and an inline one.
const biased = new GoogleSTTService({
  credentials: process.env.GOOGLE_CREDENTIALS_JSON ?? "",
  settings: new GoogleSTTService.Settings({
    adaptation: {
      phrase_sets: [
        "projects/my-project/locations/global/phraseSets/catalog",
        { phrases: [{ value: "pipedog", boost: 15.0 }] },
      ],
    },
  }),
});
// #endregion adaptation

// #region update
// Changing settings reconnects the stream.
const update = new STTUpdateSettingsFrame({
  delta: new GoogleSTTService.Settings({ languages: [Language.ES_ES, Language.EN_US] }),
});
// #endregion update
