// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Process entry for the WebSocket end-to-end runs on Bun, Node and Deno.
//
//   E2E_ROLE=server E2E_PORT=<port>  -> echo bot behind SingleClientWebsocketServerTransport;
//                                       prints E2E_READY once listening, exits when the client leaves
//   E2E_ROLE=client E2E_URI=<ws uri> -> WebsocketClientTransport round trip; prints E2E_RESULT <json>
//
// E2E_ALLOWED_ORIGINS (server, comma-separated) and E2E_ORIGIN (client's Origin header)
// exercise the origin check.

import { env, exit, quietLogs, runEchoClient, runEchoServer } from "./apps.ts";

quietLogs();

const role = env("E2E_ROLE");
try {
  if (role === "server") {
    const origins = env("E2E_ALLOWED_ORIGINS");
    await runEchoServer(
      Number(env("E2E_PORT")),
      () => console.log("E2E_READY"),
      origins ? origins.split(",") : [],
    );
    exit(0);
  } else if (role === "client") {
    const origin = env("E2E_ORIGIN");
    const result = await runEchoClient(
      env("E2E_URI") as string,
      origin ? 3 : 10,
      origin ? { Origin: origin } : null,
    );
    console.log(`E2E_RESULT ${JSON.stringify(result)}`);
    exit(result.ok ? 0 : 1);
  } else {
    throw new Error(`unknown E2E_ROLE ${role}`);
  }
} catch (e) {
  console.error("E2E_ERROR", e);
  exit(2);
}
