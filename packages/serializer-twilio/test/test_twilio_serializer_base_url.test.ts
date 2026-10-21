// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_twilio_serializer_base_url.py

/** Tests for TwilioFrameSerializer REST base-URL resolution (auto hang-up). */

import { describe, expect, test } from "bun:test";

import { _buildCallResourceUrl, TwilioFrameSerializer } from "../src/twilio.ts";

describe("TestBuildCallResourceURL", () => {
  test("test_default_host", () => {
    // No base_url, no region/edge -> Twilio's default host (unchanged behavior).
    expect(_buildCallResourceUrl("ACxxxx", "CAyyyy")).toEqual(
      "https://api.twilio.com/2010-04-01/Accounts/ACxxxx/Calls/CAyyyy.json",
    );
  });

  test("test_region_edge_host", () => {
    expect(_buildCallResourceUrl("ACxxxx", "CAyyyy", { region: "au1", edge: "sydney" })).toEqual(
      "https://api.sydney.au1.twilio.com/2010-04-01/Accounts/ACxxxx/Calls/CAyyyy.json",
    );
  });

  test("test_base_url_override", () => {
    // base_url targets a Twilio-API-compatible backend; region/edge ignored.
    expect(
      _buildCallResourceUrl("ACxxxx", "CAyyyy", {
        baseUrl: "https://api.example.test",
        region: "au1",
        edge: "sydney",
      }),
    ).toEqual("https://api.example.test/2010-04-01/Accounts/ACxxxx/Calls/CAyyyy.json");
  });

  test("test_base_url_trailing_slash_normalized", () => {
    expect(
      _buildCallResourceUrl("ACxxxx", "CAyyyy", { baseUrl: "https://api.example.test/" }),
    ).toEqual("https://api.example.test/2010-04-01/Accounts/ACxxxx/Calls/CAyyyy.json");
  });
});

describe("TestConstructorRegionEdgeValidation", () => {
  const CREDS = { callSid: "CAyyyy", accountSid: "ACxxxx", authToken: "token" };

  test("test_partial_region_edge_rejected_without_base_url", () => {
    // FQDN host is derived from region/edge, so a lone region is rejected.
    expect(
      () => new TwilioFrameSerializer({ streamSid: "MZstream", region: "au1", ...CREDS }),
    ).toThrow(Error);
  });

  test("test_partial_region_edge_allowed_with_base_url", () => {
    // base_url is used verbatim and ignores region/edge, so the pairing
    // requirement does not apply.
    const serializer = new TwilioFrameSerializer({
      streamSid: "MZstream",
      baseUrl: "https://api.example.test",
      region: "au1",
      ...CREDS,
    });
    expect((serializer as unknown as { _baseUrl: string })._baseUrl).toEqual(
      "https://api.example.test",
    );
  });
});
