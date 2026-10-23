// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/** The worker thread of `forwarding_server.ts`: a bot for each connection it is handed. */

import { runBot } from "./bot.ts";
import { acceptConnections } from "./socket_forwarding.ts";
import { parentThread } from "./threads.ts";

const port = await parentThread();
if (!port) throw new Error("bot_thread.ts runs in a worker thread (spawnThread)");
acceptConnections(port, (connection) => runBot(connection));
