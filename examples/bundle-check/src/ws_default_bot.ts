// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Configuration (a) with no options: what a bot does when it was not written for
// bundling. Silero and Smart Turn read their default model files next to the package's
// source, which a bundle does not copy. The test expects the error that says how to
// pass the model.

import { checkWebsocketBot } from "./ws_check.ts";

// It fails: don't wait long for an answer.
await checkWebsocketBot({ explicitSmartTurn: true, timeoutSecs: 1 });
