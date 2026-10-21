// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

import { createFileRoute } from "@tanstack/react-router";
import { offer } from "~/lib/voice";

// A server route: `server.handlers` and no component. Deploy to a Node, Bun or
// Deno server: the media runs over UDP, which serverless targets don't carry.
export const Route = createFileRoute("/api/offer")({
  server: {
    handlers: {
      POST: ({ request }) => offer(request),
    },
  },
});
