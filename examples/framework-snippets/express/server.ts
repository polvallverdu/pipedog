// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

import { nodeRequestListener } from "@pipedog/transport-smallwebrtc/http";
import express, { type Express } from "express";
import { offer } from "./voice.ts";

const app: Express = express();

// Don't add express.json(): the offer handler reads the body itself.
app.post("/api/offer", nodeRequestListener(offer));

export default app;

// `node server.ts` starts it on port 3000.
if (import.meta.main) {
  app.listen(3000);
}
