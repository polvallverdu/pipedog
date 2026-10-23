// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// A stand-in for the `AI` binding, for the tests only (DEMO_DEV_MODE with FAKE_AI_URL). It behaves
// as the binding does for what the services use: `run(model, input, { websocket: true })` answers
// with the `Response` of a WebSocket upgrade, whose socket the caller accepts, and HTTP runs return
// the model's output. Behind it is the fake Workers AI server from @pipedog/cloudflare's tests.

import type { WorkersAIBinding } from "@pipedog/cloudflare/client";

export function fakeAiBinding(baseUrl: string): WorkersAIBinding {
  const base = baseUrl.replace(/\/+$/, "");
  return {
    async run(
      model: string,
      input: Record<string, unknown>,
      options: Record<string, unknown> = {},
    ) {
      const url = new URL(`${base}/binding/${encodeURIComponent(model)}`);
      if (options.websocket) {
        for (const [key, value] of Object.entries(input ?? {})) {
          for (const item of Array.isArray(value) ? value : [value]) {
            url.searchParams.append(key, String(item));
          }
        }
        // A Workers fetch with `Upgrade: websocket` resolves with the socket in `webSocket`.
        return await fetch(url.toString(), { headers: { Upgrade: "websocket" } });
      }
      const response = await fetch(url.toString(), {
        method: "POST",
        body: JSON.stringify(input ?? {}),
      });
      if (options.returnRawResponse) return response;
      const data = (await response.json()) as { result?: unknown };
      return data.result;
    },
  };
}
