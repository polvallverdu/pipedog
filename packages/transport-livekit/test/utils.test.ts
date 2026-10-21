// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// LiveKitRESTHelper against a fake fetch: the DeleteRoom request and its
// short-lived roomCreate token, verified with livekit-server-sdk.

import { describe, expect, test } from "bun:test";
import { LiveKitRESTHelper } from "@pipedog/transport-livekit/utils";
import { TokenVerifier } from "livekit-server-sdk";

const API_KEY = "devkey";
const API_SECRET = "secretsecretsecretsecretsecretsecret";

function helper(status: number, body = "{}") {
  const requests: { url: string; init: RequestInit }[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    requests.push({ url, init });
    return new Response(body, { status });
  }) as unknown as typeof globalThis.fetch;
  const h = new LiveKitRESTHelper({
    apiKey: API_KEY,
    apiSecret: API_SECRET,
    apiUrl: "https://lk.example.com/",
    fetch,
  });
  return { h, requests };
}

describe("LiveKitRESTHelper", () => {
  test("deleteRoomByName posts DeleteRoom with a roomCreate token", async () => {
    const { h, requests } = helper(200);

    expect(await h.deleteRoomByName("my-room")).toBe(true);

    expect(requests.length).toBe(1);
    const { url, init } = requests[0]!;
    expect(url).toBe("https://lk.example.com/twirp/livekit.RoomService/DeleteRoom");
    expect(init.method).toBe("POST");
    expect(init.body).toBe('{"room": "my-room"}');
    const headers = init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
    const token = headers.Authorization!.replace(/^Bearer /, "");
    const claims = await new TokenVerifier(API_KEY, API_SECRET).verify(token);
    expect(claims.iss).toBe(API_KEY);
    expect(claims.video?.roomCreate).toBe(true);
    expect((claims.exp as number) - (claims.nbf as number)).toBe(60);
  });

  test("deleteRoomByName throws with the status and body on failure", async () => {
    const { h } = helper(404, "room not found");
    await expect(h.deleteRoomByName("gone")).rejects.toThrow(
      "Failed to delete room [gone] (status: 404): room not found",
    );
  });
});
