// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

import { offer, socket } from "./voice.ts";

// `deno run -A main.ts` starts it on port 3000, or on $PORT.
Deno.serve({ port: Number(Deno.env.get("PORT") ?? 3000) }, (request) => {
  const { pathname } = new URL(request.url);
  if (pathname === "/api/offer") return offer(request);
  if (pathname === "/ws") return socket(request);
  return new Response("not found", { status: 404 });
});
