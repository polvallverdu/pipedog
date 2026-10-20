// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_google_http_tts.py

/**
 * Unit tests for Google HTTP TTS's SSML construction.
 *
 * PORTING NOTES:
 * - `patch.object(GoogleHttpTTSService, "_create_client", return_value=MagicMock())`
 *   → `spyOn(GoogleHttpTTSService.prototype, "_createClient")` returning a
 *   stub, restored after construction (the `with` block scope).
 */

import { expect, spyOn, test } from "bun:test";
import { GoogleHttpTTSService } from "../src/tts.ts";

type ServiceInternals = {
  _createClient: (...args: unknown[]) => unknown;
  _constructSsml: (text: string) => string;
};

test("test_text_is_escaped_inside_ssml", () => {
  const proto = GoogleHttpTTSService.prototype as unknown as ServiceInternals;
  const spy = spyOn(proto, "_createClient").mockReturnValue({});
  let service: GoogleHttpTTSService;
  try {
    service = new GoogleHttpTTSService({
      settings: new GoogleHttpTTSService.Settings({ voice: "en-US-Neural2-A" }),
    });
  } finally {
    spy.mockRestore();
  }

  const ssml = (service as unknown as ServiceInternals)._constructSsml("Q&A: is 3 < 5 > 2?");

  expect(ssml).toContain("Q&amp;A: is 3 &lt; 5 &gt; 2?");
});
