// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

import { Elysia } from "elysia";
import { offer } from "./voice.ts";

export const app = new Elysia().post("/api/offer", ({ request }) => offer(request));

// `bun server.ts` starts it on port 3000.
if (import.meta.main) {
  app.listen(3000);
}
