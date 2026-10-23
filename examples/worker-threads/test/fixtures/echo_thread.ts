// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

// Echoes each message back, moving its buffer back with it.

import { parentThread } from "../../src/threads.ts";

const port = await parentThread();
port!.addListener((msg: { bytes: Uint8Array }) => {
  port!.postMessage({ echo: msg.bytes, isWorker: true }, [msg.bytes.buffer as ArrayBuffer]);
});
