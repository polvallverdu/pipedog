// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// The vendored prebuilt client must be in the repository, so it ships in the
// npm package. A root `dist/` ignore once kept it out, and the browser test that
// would have noticed is skipped when no Chromium is installed.

import { describe, expect, test } from "bun:test";
import { directoryAssetReader, prebuiltAvailable } from "../src/prebuilt";

describe("vendored prebuilt client", () => {
  test("prebuilt/dist has the client's index.html", async () => {
    expect(await prebuiltAvailable(directoryAssetReader())).toBe(true);
  });

  test("index.html references bundled assets", async () => {
    const html = new TextDecoder().decode(
      (await directoryAssetReader()("index.html")) ?? undefined,
    );
    const assets = [...html.matchAll(/(?:src|href)="\.?\/?(assets\/[^"]+)"/g)].map((m) => m[1]);
    expect(assets.length).toBeGreaterThan(0);
    for (const asset of assets) {
      expect(await directoryAssetReader()(asset!)).not.toBeNull();
    }
  });
});
