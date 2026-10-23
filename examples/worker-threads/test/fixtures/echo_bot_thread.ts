// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

// A "bot" in a worker thread: echoes each message of each forwarded connection,
// and closes the connection when asked to.

import { acceptConnections } from "../../src/socket_forwarding.ts";
import { parentThread } from "../../src/threads.ts";

const port = await parentThread();
acceptConnections(port!, async (connection) => {
  for await (const data of connection) {
    if (data === "bye") return;
    await connection.send(typeof data === "string" ? `echo ${data} ${connection.path}` : data);
  }
});
