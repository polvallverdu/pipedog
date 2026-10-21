// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

import type { RequestHandler } from "@sveltejs/kit";
import { offer } from "$lib/voice";

// Use adapter-node (or any Node, Bun or Deno server): the media runs over UDP,
// which serverless adapters don't carry.
export const POST: RequestHandler = ({ request }) => offer(request);
