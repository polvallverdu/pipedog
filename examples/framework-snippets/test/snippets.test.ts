// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Each framework's snippet mounts the same endpoints, so each is checked the
// same way. A POST without an SDP offer must reach pipedog's handler and get its
// own 400 ("sdp and type are required"), which a framework's own 404 wouldn't
// give. The WebSocket endpoints must accept an upgrade. Deno isn't run here: its
// snippet needs the Deno runtime.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createApp, defineEventHandler, toWebHandler, toWebRequest } from "h3";

// The agents started by the WebSocket tests read the key when they connect. Set
// it only for this file: other test files decide what to run from its presence.
const savedKey = process.env.OPENAI_API_KEY;
beforeAll(() => {
  process.env.OPENAI_API_KEY = "test-key";
});
afterAll(() => {
  if (savedKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = savedKey;
});

const EXPECTED = "sdp and type are required";

function offerRequest(): Request {
  return new Request("http://localhost/api/offer", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
}

async function expectOwnOfferError(response: Response): Promise<void> {
  expect(response.status).toBe(400);
  expect(await response.text()).toContain(EXPECTED);
}

/** Open a WebSocket to `url` and resolve once it's open, then close it. */
function expectUpgrade(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => reject(new Error(`no open for ${url}`)), 10_000);
    ws.onopen = () => {
      clearTimeout(timer);
      ws.close();
      resolve();
    };
    ws.onerror = (event) => {
      clearTimeout(timer);
      reject(event);
    };
  });
}

/** Start a Bun server from a snippet's config on a free port; returns its base URL. */
function serveConfig(config: Record<string, unknown>): { base: string; stop: () => void } {
  const server = Bun.serve({ ...(config as any), port: 0, hostname: "127.0.0.1" });
  return { base: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}

describe("SvelteKit", () => {
  test("POST /api/offer is the route's handler", async () => {
    const { POST } = await import("../sveltekit/src/routes/api/offer/+server.ts");
    await expectOwnOfferError(await POST({ request: offerRequest() } as never));
  });
});

describe("Hono", () => {
  test("POST /api/offer", async () => {
    const { default: config } = await import("../hono/app.ts");
    const { app } = { app: null as unknown };
    void app;
    const server = serveConfig(config as unknown as Record<string, unknown>);
    try {
      await expectOwnOfferError(await fetch(`${server.base}/api/offer`, offerRequest()));
    } finally {
      server.stop();
    }
  });

  test("GET /ws upgrades", async () => {
    const { default: config } = await import("../hono/app.ts");
    const server = serveConfig(config as unknown as Record<string, unknown>);
    try {
      await expectUpgrade(server.base.replace("http", "ws") + "/ws");
    } finally {
      server.stop();
    }
  });
});

describe("Bun", () => {
  test("POST /api/offer", async () => {
    const { default: config } = await import("../bun/server.ts");
    const server = serveConfig(config as unknown as Record<string, unknown>);
    try {
      await expectOwnOfferError(await fetch(`${server.base}/api/offer`, offerRequest()));
    } finally {
      server.stop();
    }
  });

  test("GET /ws upgrades", async () => {
    const { default: config } = await import("../bun/server.ts");
    const server = serveConfig(config as unknown as Record<string, unknown>);
    try {
      await expectUpgrade(server.base.replace("http", "ws") + "/ws");
    } finally {
      server.stop();
    }
  });
});

describe("Next.js", () => {
  test("POST is the route's handler", async () => {
    const { POST, runtime } = await import("../nextjs/app/api/offer/route.ts");
    expect(runtime).toBe("nodejs");
    await expectOwnOfferError(await POST(offerRequest()));
  });
});

describe("Express", () => {
  test("POST /api/offer", async () => {
    const { default: app } = await import("../express/server.ts");
    const server = app.listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    const { port } = server.address() as { port: number };
    try {
      await expectOwnOfferError(await fetch(`http://127.0.0.1:${port}/api/offer`, offerRequest()));
    } finally {
      server.close();
    }
  });
});

describe("Elysia", () => {
  test("POST /api/offer", async () => {
    const { app } = await import("../elysia/server.ts");
    await expectOwnOfferError(await app.handle(offerRequest()));
  });
});

describe("Nuxt (Nitro handler, mounted on h3)", () => {
  test("POST /api/offer", async () => {
    // Nuxt auto-imports these into server handlers; the snippet doesn't import them.
    (globalThis as any).defineEventHandler = defineEventHandler;
    (globalThis as any).toWebRequest = toWebRequest;
    const { default: handler } = await import("../nuxt/server/api/offer.post.ts");
    const app = createApp();
    app.use("/api/offer", handler);
    await expectOwnOfferError(await toWebHandler(app)(offerRequest()));
  });
});

describe("Vercel (Bun runtime)", () => {
  test("POST /api/offer", async () => {
    const { default: config } = await import("../vercel/server.ts");
    const server = serveConfig(config as unknown as Record<string, unknown>);
    try {
      await expectOwnOfferError(await fetch(`${server.base}/api/offer`, offerRequest()));
    } finally {
      server.stop();
    }
  });

  test("GET /ws upgrades", async () => {
    const { default: config } = await import("../vercel/server.ts");
    const server = serveConfig(config as unknown as Record<string, unknown>);
    try {
      await expectUpgrade(server.base.replace("http", "ws") + "/ws");
    } finally {
      server.stop();
    }
  });
});

describe.skipIf(!Bun.which("deno"))("Deno", () => {
  test("POST /api/offer and GET /ws", async () => {
    const port = 30000 + Math.floor(Math.random() * 10000);
    const proc = Bun.spawn(["deno", "run", "-A", "deno/main.ts"], {
      cwd: import.meta.dir + "/..",
      env: { ...process.env, PORT: String(port) },
      stdout: "ignore",
      stderr: "ignore",
    });
    try {
      let ready = false;
      for (let i = 0; i < 200 && !ready; i++) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        ready = await fetch(`http://127.0.0.1:${port}/api/offer`, { method: "POST" }).then(
          () => true,
          () => false,
        );
      }
      expect(ready).toBe(true);
      await expectOwnOfferError(await fetch(`http://127.0.0.1:${port}/api/offer`, offerRequest()));
      await expectUpgrade(`ws://127.0.0.1:${port}/ws`);
    } finally {
      proc.kill();
    }
  }, 60_000);
});
