// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_google_utils.py

import { describe, expect, mock, test } from "bun:test";

import * as core from "@pipedog/core";

const MOCKED_VERSION = "0.0.0-test";

// Upstream patches `pipecat.services.google.utils.pipecat_version`.
mock.module("@pipedog/core", () => ({ ...core, version: () => MOCKED_VERSION }));

const { updateGoogleClientHttpOptions } = await import("../src/utils.ts");

describe("TestGoogleUtils", () => {
  test("test_update_google_client_http_options_none", () => {
    const options = updateGoogleClientHttpOptions(null);
    expect(options).toEqual({ headers: { "x-goog-api-client": `pipecat/${MOCKED_VERSION}` } });
  });

  test("test_update_google_client_http_options_dict_empty", () => {
    const options = updateGoogleClientHttpOptions({});
    expect(options).toEqual({ headers: { "x-goog-api-client": `pipecat/${MOCKED_VERSION}` } });
  });

  test("test_update_google_client_http_options_dict_existing_headers", () => {
    const initialOptions = { headers: { Authorization: "Bearer token" } };
    const options = updateGoogleClientHttpOptions(initialOptions) as {
      headers: Record<string, string>;
    };
    expect(options.headers.Authorization).toEqual("Bearer token");
    expect(options.headers["x-goog-api-client"]).toEqual(`pipecat/${MOCKED_VERSION}`);
  });

  test("test_update_google_client_http_options_object", () => {
    class HttpOptions {
      headers: Record<string, string> | null = null;
    }

    const httpOptions = new HttpOptions();
    const updatedOptions = updateGoogleClientHttpOptions(httpOptions) as HttpOptions;
    expect(updatedOptions.headers).toEqual({ "x-goog-api-client": `pipecat/${MOCKED_VERSION}` });
  });

  test("test_update_google_client_http_options_object_existing_headers", () => {
    class HttpOptions {
      headers: Record<string, string> | null = { Authorization: "Bearer token" };
    }

    const httpOptions = new HttpOptions();
    const updatedOptions = updateGoogleClientHttpOptions(httpOptions) as HttpOptions;
    expect(updatedOptions.headers!.Authorization).toEqual("Bearer token");
    expect(updatedOptions.headers!["x-goog-api-client"]).toEqual(`pipecat/${MOCKED_VERSION}`);
  });
});
