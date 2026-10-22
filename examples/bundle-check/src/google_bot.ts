// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Configuration (c), default: the Google services import `@google-cloud/speech` and
// `@google-cloud/text-to-speech` by name at run time, so both (and `@grpc/grpc-js`,
// which this entry shares with them) must be installed next to the bundle.

import * as grpc from "@grpc/grpc-js";
import { checkGoogle } from "./google_check.ts";

await checkGoogle(grpc);
