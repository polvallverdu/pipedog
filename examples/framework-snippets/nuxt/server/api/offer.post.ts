// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

import { offer } from "~/server/utils/voice";

// Nitro's Node, Bun or Deno preset: the media runs over UDP, so a serverless
// preset won't carry it. `toWebRequest` is auto-imported from h3.
export default defineEventHandler((event) => offer(toWebRequest(event)));
