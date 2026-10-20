// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_ssrf.py

/** Unit tests for pipecat.utils.security.ssrf.classify_url_reachability. */

import { afterEach, describe, expect, mock, test } from "bun:test";

import {
  classifyUrlReachability,
  defaultAllowedFileUrlNetworks,
  IPNetwork,
  setHostResolver,
} from "../src/utils/security/ssrf.ts";

// Upstream patches `asyncio.get_event_loop().getaddrinfo`; the port's resolution
// hook is `setHostResolver`.
function addrInfo(...ips: string[]): void {
  setHostResolver(mock(async (_hostname: string) => ips));
}

describe("TestClassifyUrlReachability", () => {
  afterEach(() => {
    setHostResolver(null);
  });

  test("test_public_for_a_public_address", async () => {
    addrInfo("8.8.8.8");
    expect(await classifyUrlReachability("https://example.com/doc.pdf")).toEqual("public");
  });

  test("test_blocked_for_loopback", async () => {
    addrInfo("127.0.0.1");
    expect(await classifyUrlReachability("http://localhost/doc.pdf")).toEqual("blocked");
  });

  test("test_blocked_for_cloud_metadata_link_local_address", async () => {
    addrInfo("169.254.169.254");
    expect(await classifyUrlReachability("http://169.254.169.254/latest/meta-data/")).toEqual(
      "blocked",
    );
  });

  test("test_blocked_for_private_rfc1918_address_with_no_allowed_networks", async () => {
    addrInfo("10.0.0.5");
    expect(await classifyUrlReachability("http://10.0.0.5/internal")).toEqual("blocked");
  });

  test("test_blocked_if_any_resolved_address_is_not_public", async () => {
    // A hostname resolving to a mix of public and private addresses is blocked.
    addrInfo("8.8.8.8", "127.0.0.1");
    expect(await classifyUrlReachability("https://example.com/doc.pdf")).toEqual("blocked");
  });

  test("test_blocked_when_resolution_fails", async () => {
    setHostResolver(
      mock(async (_hostname: string): Promise<string[]> => {
        throw new Error("no such host");
      }),
    );
    expect(await classifyUrlReachability("https://does-not-resolve.invalid/doc.pdf")).toEqual(
      "blocked",
    );
  });

  test("test_blocked_for_url_without_a_host", async () => {
    expect(await classifyUrlReachability("not-a-url")).toEqual("blocked");
  });

  test("test_allowed_for_private_address_within_an_allowed_network", async () => {
    addrInfo("10.0.0.5");
    expect(
      await classifyUrlReachability("http://10.0.0.5/internal", [new IPNetwork("10.0.0.0/8")]),
    ).toEqual("allowed");
  });

  test("test_blocked_for_private_address_outside_the_allowed_networks", async () => {
    addrInfo("192.168.1.5");
    expect(
      await classifyUrlReachability("http://192.168.1.5/internal", [new IPNetwork("10.0.0.0/8")]),
    ).toEqual("blocked");
  });

  test("test_allowed_networks_does_not_relax_loopback", async () => {
    // An allowed private network doesn't widen the loopback block.
    addrInfo("127.0.0.1");
    expect(
      await classifyUrlReachability("http://localhost/doc.pdf", [new IPNetwork("10.0.0.0/8")]),
    ).toEqual("blocked");
  });

  test("test_public_for_a_public_address_even_with_allowed_networks_set", async () => {
    // A public address still classifies as public, not merely allowed.
    addrInfo("8.8.8.8");
    expect(
      await classifyUrlReachability("https://example.com/doc.pdf", [new IPNetwork("10.0.0.0/8")]),
    ).toEqual("public");
  });
});

describe("TestDefaultAllowedFileUrlNetworks", () => {
  const KEY = "PIPECAT_ALLOWED_FILE_URL_NETWORKS";
  let saved: string | undefined;

  function patchEnv(value: string | undefined): void {
    saved = process.env[KEY];
    if (value === undefined) delete process.env[KEY];
    else process.env[KEY] = value;
  }

  afterEach(() => {
    if (saved === undefined) delete process.env[KEY];
    else process.env[KEY] = saved;
  });

  test("test_returns_empty_list_when_unset", () => {
    patchEnv(undefined);
    expect(defaultAllowedFileUrlNetworks()).toEqual([]);
  });

  test("test_parses_comma_separated_cidr_list", () => {
    patchEnv("10.0.0.0/8, 192.168.0.0/16 ,");
    expect(defaultAllowedFileUrlNetworks()).toEqual(["10.0.0.0/8", "192.168.0.0/16"]);
  });
});
