// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

import { offer } from "@/lib/voice";

// The Node.js runtime, not the edge: the media runs over UDP, and the server has
// to stay up for the call.
export const runtime = "nodejs";

export const POST = (request: Request) => offer(request);
