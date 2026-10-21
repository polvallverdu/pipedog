// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_runner_run.py

import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FileStorage } from "@pipedog/core/utils/file_storage";
import { LocalFileStorage } from "@pipedog/core/utils/file_storage";
import { isOriginAllowed } from "@pipedog/core/utils/security/allowed_origins";
import type { Namespace } from "../src/argparse.ts";
import {
  _deps,
  _extractWsToken,
  _formatStartupMessage,
  _generateWsToken,
  _parseIceServers,
  _resolveFileStorage,
  _runBotSession,
  _runTelephonyBot,
  _setupDailyRoutes,
  _setupFileUploadsRoutes,
  _setupTelephonyRoutes,
  _setupUnifiedStartRoute,
  _setupWebrtcRoutes,
  _setupWebsocketRoutes,
  _transportRouteDependencies,
  _transportRoutesEnabled,
  _verifyAndConsumeWsToken,
  _webrtcHandlers,
  type BotModule,
  RunnerApp,
} from "../src/run.ts";
import { serve } from "../src/serve.ts";
import type { RunnerArguments } from "../src/types.ts";

const realDeps = { ..._deps };
afterEach(() => {
  Object.assign(_deps, realDeps);
});

/** Make `_transportRoutesEnabled` return `enabled` (upstream patches it). */
function routesEnabled(enabled: boolean | ((transport: string) => boolean)): void {
  if (typeof enabled === "boolean") {
    _deps.isModuleAvailable = () => enabled;
    return;
  }
  // Map each transport's dependency back to the transport names that need it.
  _deps.isModuleAvailable = (module) =>
    ["daily", "livekit", "webrtc", "telephony", "websocket", "moq"].some(
      (t) => _transportRouteDependencies(t).includes(module) && enabled(t),
    );
}

function paths(app: RunnerApp): Set<string> {
  return new Set(app.routes.map((r) => r.path));
}

function post(app: RunnerApp, path: string, body?: unknown, init: RequestInit = {}) {
  return app.fetch(
    new Request(`http://localhost${path}`, {
      method: "POST",
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      ...init,
    }),
  );
}

function upload(app: RunnerApp, path: string, name = "a.txt", contents = "hi") {
  const form = new FormData();
  form.append("file", new File([contents], name));
  return app.fetch(new Request(`http://localhost${path}`, { method: "POST", body: form }));
}

function fakeStorage(save: (name: string, contents: Uint8Array) => Promise<string>) {
  return {
    save: mock(save),
    delete: mock(async (_url: string) => {}),
  } as unknown as FileStorage & {
    save: ReturnType<typeof mock>;
    delete: ReturnType<typeof mock>;
  };
}

describe("TestRunnerRun", () => {
  test("test_transport_route_dependencies_maps_transports_to_modules", () => {
    expect(_transportRouteDependencies("daily")).toEqual(["@pipedog/transport-daily"]);
    expect(_transportRouteDependencies("webrtc")).toEqual(["@pipedog/transport-smallwebrtc"]);
    expect(_transportRouteDependencies("websocket")).toEqual(["@pipedog/transport-websocket"]);
    expect(_transportRouteDependencies("telephony")).toEqual(["@pipedog/transport-websocket"]);
    expect(_transportRouteDependencies("twilio")).toEqual(["@pipedog/transport-websocket"]);
    expect(_transportRouteDependencies("telnyx")).toEqual(["@pipedog/transport-websocket"]);
    expect(_transportRouteDependencies("plivo")).toEqual(["@pipedog/transport-websocket"]);
    expect(_transportRouteDependencies("exotel")).toEqual(["@pipedog/transport-websocket"]);
    expect(_transportRouteDependencies("vonage")).toEqual([]);
    expect(_transportRouteDependencies("livekit")).toEqual(["@pipedog/transport-livekit"]);
  });

  test("test_transport_routes_enabled_maps_transports_to_dependency_checks", () => {
    _deps.isModuleAvailable = (module) => module === "@pipedog/transport-websocket";
    expect(_transportRoutesEnabled("daily")).toBe(false);
    expect(_transportRoutesEnabled("webrtc")).toBe(false);
    expect(_transportRoutesEnabled("websocket")).toBe(true);
    expect(_transportRoutesEnabled("telephony")).toBe(true);
    expect(_transportRoutesEnabled("twilio")).toBe(true);
    expect(_transportRoutesEnabled("vonage")).toBe(true);
  });

  test("pipedog: the real environment enables webrtc, telephony and websocket only", () => {
    expect(_transportRoutesEnabled("webrtc")).toBe(true);
    expect(_transportRoutesEnabled("telephony")).toBe(true);
    expect(_transportRoutesEnabled("websocket")).toBe(true);
    expect(_transportRoutesEnabled("daily")).toBe(false);
    expect(_transportRoutesEnabled("livekit")).toBe(false);
    expect(_transportRoutesEnabled("moq")).toBe(false);
  });

  const webrtcArgs = (extra: Namespace = {}): Namespace => ({
    downloads_folder: null,
    esp32: false,
    host: "localhost",
    ice_servers: [],
    ...extra,
  });

  test("test_setup_webrtc_routes_skips_when_aiortc_is_missing", async () => {
    const app = new RunnerApp();
    routesEnabled(false);
    await _setupWebrtcRoutes(app, webrtcArgs(), {});
    expect(paths(app).has("/api/offer")).toBe(false);
  });

  test("test_setup_webrtc_routes_registers_routes_when_webrtc_is_available", async () => {
    const app = new RunnerApp();
    routesEnabled(true);
    await _setupWebrtcRoutes(app, webrtcArgs(), {});
    expect(paths(app).has("/api/offer")).toBe(true);
    expect(paths(app).has("/files/{filename:path}")).toBe(true);
  });

  test("test_download_file_404s_when_downloads_folder_unconfigured", async () => {
    const app = new RunnerApp();
    routesEnabled(true);
    await _setupWebrtcRoutes(app, webrtcArgs(), {});
    const response = await app.fetch(new Request("http://localhost/files/report.txt"));
    expect(response.status).toBe(404);
  });

  test("test_download_file_serves_file_from_downloads_folder", async () => {
    const tmpdirPath = mkdtempSync(join(tmpdir(), "runner-dl-"));
    try {
      writeFileSync(join(tmpdirPath, "report.txt"), "hello");
      const app = new RunnerApp();
      routesEnabled(true);
      await _setupWebrtcRoutes(app, webrtcArgs({ downloads_folder: tmpdirPath }), {});
      const response = await app.fetch(new Request("http://localhost/files/report.txt"));
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("hello");
    } finally {
      rmSync(tmpdirPath, { recursive: true, force: true });
    }
  });

  test("test_setup_webrtc_routes_gives_handler_no_ice_servers_when_unconfigured", async () => {
    const app = new RunnerApp();
    routesEnabled(true);
    await _setupWebrtcRoutes(app, webrtcArgs(), {});
    expect((_webrtcHandlers.get(app) as { _iceServers: unknown })._iceServers).toBeNull();
  });

  test("test_setup_webrtc_routes_passes_configured_ice_servers_to_handler", async () => {
    const app = new RunnerApp();
    routesEnabled(true);
    await _setupWebrtcRoutes(
      app,
      webrtcArgs({
        ice_servers: [
          { urls: "stun:stun.l.google.com:19302" },
          { urls: "turn:turn.example.com:3478", username: "user", credential: "secret" },
        ],
      }),
      {},
    );
    const { IceServer } = await import("@pipedog/transport-smallwebrtc/connection");
    const servers = (_webrtcHandlers.get(app) as { _iceServers: unknown[] })._iceServers;
    expect(servers).toEqual([
      new IceServer({ urls: "stun:stun.l.google.com:19302" }),
      new IceServer({ urls: "turn:turn.example.com:3478", username: "user", credential: "secret" }),
    ]);
  });

  test("test_setup_websocket_routes_skips_when_websocket_is_missing", () => {
    const app = new RunnerApp();
    routesEnabled(false);
    _setupWebsocketRoutes(app, {}, new Set());
    expect(paths(app).has("/ws-client")).toBe(false);
  });

  test("test_setup_websocket_routes_registers_when_websocket_is_available", () => {
    const app = new RunnerApp();
    routesEnabled(true);
    _setupWebsocketRoutes(app, {}, new Set());
    expect(paths(app).has("/ws-client")).toBe(true);
  });

  test("test_setup_telephony_routes_skips_when_websocket_is_missing", () => {
    const app = new RunnerApp();
    routesEnabled(false);
    _setupTelephonyRoutes(app, { transport: null }, new Set());
    expect(paths(app).has("/ws")).toBe(false);
  });

  test("test_setup_telephony_routes_registers_when_websocket_is_available", () => {
    const app = new RunnerApp();
    routesEnabled(true);
    _setupTelephonyRoutes(app, { transport: null }, new Set());
    expect(paths(app).has("/ws")).toBe(true);
  });

  test("test_setup_telephony_routes_registers_provider_webhook_for_selected_transport", () => {
    const app = new RunnerApp();
    routesEnabled(true);
    _setupTelephonyRoutes(app, { transport: "twilio", proxy: "example.ngrok.io" }, new Set());
    const postRoot = app.routes.filter((r) => r.path === "/" && r.methods.has("POST"));
    expect(postRoot.length).toBe(1);
  });

  test("pipedog: the telephony webhook returns TwiML or TeXML pointing at the proxy", async () => {
    routesEnabled(true);
    for (const [transport, attribute] of [
      ["twilio", '<Stream url="wss://example.ngrok.io/ws"></Stream>'],
      ["telnyx", '<Stream url="wss://example.ngrok.io/ws" bidirectionalMode="rtp"></Stream>'],
      ["plivo", ">wss://example.ngrok.io/ws</Stream>"],
    ] as const) {
      const app = new RunnerApp();
      _setupTelephonyRoutes(app, { transport, proxy: "example.ngrok.io" }, new Set());
      const response = await post(app, "/");
      expect(response.headers.get("content-type")).toBe("application/xml");
      expect(await response.text()).toContain(attribute);
    }
    const app = new RunnerApp();
    _setupTelephonyRoutes(app, { transport: "exotel", proxy: "example.ngrok.io" }, new Set());
    expect(await (await post(app, "/")).json()).toEqual({
      error: "Exotel doesn't use POST webhooks",
      websocket_url: "wss://example.ngrok.io/ws",
      note: "Configure the WebSocket URL above in your Exotel App Bazaar Voicebot Applet",
    });
  });

  test("test_setup_daily_routes_skips_when_daily_is_missing", () => {
    const app = new RunnerApp();
    routesEnabled(false);
    _setupDailyRoutes(app, { dialin: false });
    expect(paths(app).has("/daily")).toBe(false);
  });

  // DIVERGENCE: the Daily transport is not ported, so /daily and
  // /daily-dialin-webhook are never registered.
  test.skip("test_setup_daily_routes_registers_when_daily_is_available", () => {});
  test.skip("test_setup_daily_routes_registers_dialin_route_when_enabled", () => {});

  test("test_websocket_routes_require_fastapi_and_websockets", () => {
    const calls: string[] = [];
    _deps.isModuleAvailable = (module) => {
      calls.push(module);
      return false;
    };
    expect(_transportRoutesEnabled("websocket")).toBe(false);
    expect(calls).toEqual(["@pipedog/transport-websocket"]);
  });

  test("test_start_rejects_disabled_transport_before_running_bot", async () => {
    const app = new RunnerApp();
    _setupUnifiedStartRoute(app, { transport: null, ice_servers: [] }, {});
    routesEnabled(false);
    const response = await post(app, "/start", { transport: "daily" });
    expect(response.status).toBe(400);
    expect((await response.json()).detail).toBe(
      "Transport 'daily' is disabled in this runner environment. " +
        "Check the startup banner for enabled transports.",
    );
  });

  test("test_startup_message_all_transports_shows_open_url_and_transport_status", () => {
    const args = {
      transport: null,
      host: "localhost",
      port: 7860,
      ws_auth: "none",
      allowed_origins: [],
    };
    routesEnabled((t) => t === "telephony" || t === "websocket");
    expect(_formatStartupMessage(args)).toBe(
      "\n" +
        "🚀 Bot ready!\n" +
        "   → Open: http://localhost:7860\n" +
        "   → Enabled transports: telephony, websocket\n" +
        "   → Disabled transports: daily (not ported to pipedog yet), " +
        "livekit (not ported to pipedog yet), " +
        "webrtc (install @pipedog/transport-smallwebrtc), " +
        "moq (not ported to pipedog yet)\n" +
        "   → Allowed origins: all (no restriction)\n" +
        "\n",
    );
  });

  test("test_startup_message_all_transports_omits_disabled_status_when_all_enabled", () => {
    const args = {
      transport: null,
      host: "localhost",
      port: 7860,
      ws_auth: "none",
      allowed_origins: [],
    };
    routesEnabled(true);
    expect(_formatStartupMessage(args)).toBe(
      "\n" +
        "🚀 Bot ready!\n" +
        "   → Open: http://localhost:7860\n" +
        "   → Enabled transports: daily, livekit, webrtc, telephony, websocket, moq\n" +
        "   → Allowed origins: all (no restriction)\n" +
        "\n",
    );
  });

  test("test_startup_message_webrtc_uses_root_open_url", () => {
    routesEnabled(true);
    const output = _formatStartupMessage({
      transport: "webrtc",
      host: "localhost",
      port: 7860,
      esp32: false,
      whatsapp: false,
    });
    expect(output).toContain("   → Open: http://localhost:7860\n");
    expect(output).not.toContain("/client");
  });

  test("test_startup_message_daily_uses_root_open_url", () => {
    routesEnabled(true);
    const output = _formatStartupMessage({
      transport: "daily",
      host: "localhost",
      port: 7860,
      dialin: false,
    });
    expect(output).toContain("   → Open: http://localhost:7860\n");
    expect(output).not.toContain("/daily in your browser");
  });

  test("test_startup_message_telephony_keeps_provider_endpoint_details", () => {
    routesEnabled(true);
    const output = _formatStartupMessage({
      transport: "twilio",
      host: "localhost",
      port: 7860,
      proxy: "example.ngrok.io",
      ws_auth: "none",
      allowed_origins: [],
    });
    expect(output).toContain("   → Open: http://localhost:7860\n");
    expect(output).toContain("   → XML webhook: http://localhost:7860/\n");
    expect(output).toContain("   → WebSocket:   ws://localhost:7860/ws\n");
  });
});

/**
 * POST /files must always be registered so an unconfigured uploads folder fails
 * with a clear 503 from the handler itself.
 */
describe("TestFileUploadsRoute", () => {
  test("test_registers_the_route_even_without_storage_configured", () => {
    const app = new RunnerApp();
    app.fileStorage = null;
    _setupFileUploadsRoutes(app, {});
    expect(paths(app).has("/files")).toBe(true);
  });

  test("test_returns_503_directly_when_storage_not_configured", async () => {
    const app = new RunnerApp();
    app.fileStorage = null;
    _setupFileUploadsRoutes(app, {});
    expect((await upload(app, "/files")).status).toBe(503);
  });

  test("test_saves_file_when_storage_is_configured", async () => {
    const app = new RunnerApp();
    app.fileStorage = fakeStorage(async () => "pipecat:abc123");
    _setupFileUploadsRoutes(app, {});
    const response = await upload(app, "/files", "a.txt", "hello");
    expect(response.status).toBe(200);
    expect((await response.json()).source).toEqual({ type: "url", url: "pipecat:abc123" });
  });

  test("test_storage_save_failure_returns_clean_500", async () => {
    const app = new RunnerApp();
    app.fileStorage = fakeStorage(async () => {
      throw new Error("AccessDenied: no PutObject");
    });
    _setupFileUploadsRoutes(app, {});
    const response = await upload(app, "/files", "a.txt", "hello");
    expect(response.status).toBe(500);
    expect((await response.json()).detail).toBe("Failed to save file");
  });
});

/**
 * The uploads backend comes from the bot module's `createFileStorage()` when it
 * exports one, falling back to `-u/--uploads-folder` local storage.
 */
describe("TestResolveFileStorage", () => {
  const args = (uploadsFolder: string | null = null): Namespace => ({
    uploads_folder: uploadsFolder,
    uploads_folder_max_files: 10,
  });
  const bot = async () => {};

  test("test_bot_module_factory_wins_over_the_uploads_folder_flag", async () => {
    const storage = fakeStorage(async () => "x");
    const resolved = await _resolveFileStorage(args("/tmp/uploads"), async () => ({
      bot,
      createFileStorage: () => storage,
    }));
    expect(resolved).toBe(storage);
  });

  test("test_factory_returning_none_disables_uploads_despite_the_flag", async () => {
    const resolved = await _resolveFileStorage(args("/tmp/uploads"), async () => ({
      bot,
      createFileStorage: () => null,
    }));
    expect(resolved).toBeNull();
  });

  test("test_uploads_folder_flag_backs_uploads_with_local_storage", async () => {
    const folder = mkdtempSync(join(tmpdir(), "runner-up-"));
    try {
      const resolved = await _resolveFileStorage(args(folder), async () => ({ bot }));
      expect(resolved).toBeInstanceOf(LocalFileStorage);
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });

  test("test_no_factory_and_no_flag_disables_uploads", async () => {
    const resolved = await _resolveFileStorage(args(), async () => {
      throw new Error("no bot");
    });
    expect(resolved).toBeNull();
  });

  test("test_async_factory_is_rejected_loudly", async () => {
    const botModule = { bot, createFileStorage: (async () => ({})) as unknown as () => null };
    await expect(_resolveFileStorage(args(), async () => botModule)).rejects.toThrow(TypeError);
  });
});

/**
 * POST /sessions/{session_id}/files mirrors Pipecat Cloud's session-scoped
 * routes; a session's uploads are tracked and deleted when the session ends.
 */
describe("TestSessionScopedUploads", () => {
  function appWith(activeSessions: Record<string, unknown>, storage: FileStorage | null) {
    const app = new RunnerApp();
    app.fileStorage = storage;
    _setupFileUploadsRoutes(app, activeSessions);
    return app;
  }

  test("test_unknown_session_404s", async () => {
    const storage = fakeStorage(async () => "x");
    const response = await upload(appWith({}, storage), "/sessions/nope/files");
    expect(response.status).toBe(404);
    expect(storage.save).not.toHaveBeenCalled();
  });

  test("test_active_session_upload_is_saved_and_tracked", async () => {
    const app = appWith(
      { "sess-1": {} },
      fakeStorage(async () => "pipecat:abc123"),
    );
    const response = await upload(app, "/sessions/sess-1/files");
    expect(response.status).toBe(200);
    expect((await response.json()).source).toEqual({ type: "url", url: "pipecat:abc123" });
    expect(Object.fromEntries(app.sessionUploadUrls)).toEqual({ "sess-1": ["pipecat:abc123"] });
  });

  test("test_sessionless_upload_is_not_tracked", async () => {
    const app = appWith(
      {},
      fakeStorage(async () => "pipecat:abc123"),
    );
    const response = await upload(app, "/files");
    expect(response.status).toBe(200);
    expect(app.sessionUploadUrls.size).toBe(0);
  });

  test("test_session_files_route_wins_over_webrtc_session_proxy", async () => {
    const activeSessions = { "sess-1": {} };
    const app = appWith(activeSessions, null);
    routesEnabled(true);
    await _setupWebrtcRoutes(app, webrtcArgsFor(), activeSessions);
    const response = await upload(app, "/sessions/sess-1/files");
    // The upload handler answers (503: storage unconfigured), not the proxy (200).
    expect(response.status).toBe(503);
  });
});

function webrtcArgsFor(): Namespace {
  return { downloads_folder: null, esp32: false, host: "localhost", ice_servers: [] };
}

describe("TestRunBotSessionCleanup", () => {
  test("test_session_end_deletes_uploads_and_releases_session", async () => {
    const app = new RunnerApp();
    const storage = fakeStorage(async () => "x");
    app.fileStorage = storage;
    app.sessionUploadUrls.set("sess-1", ["pipecat:aaa", "pipecat:bbb"]);
    const activeSessions: Record<string, unknown> = { "sess-1": {} };

    await _runBotSession(app, async () => {}, "sess-1", activeSessions);

    expect(activeSessions).toEqual({});
    expect(app.sessionUploadUrls.size).toBe(0);
    expect(storage.delete).toHaveBeenCalledWith("pipecat:aaa");
    expect(storage.delete).toHaveBeenCalledWith("pipecat:bbb");
  });

  test("test_cleanup_runs_even_when_the_bot_raises", async () => {
    const app = new RunnerApp();
    const storage = fakeStorage(async () => "x");
    app.fileStorage = storage;
    app.sessionUploadUrls.set("sess-1", ["pipecat:aaa"]);
    const activeSessions: Record<string, unknown> = { "sess-1": {} };

    await expect(
      _runBotSession(
        app,
        async () => {
          throw new Error("boom");
        },
        "sess-1",
        activeSessions,
      ),
    ).rejects.toThrow("boom");

    expect(activeSessions).toEqual({});
    expect(storage.delete).toHaveBeenCalledTimes(1);
    expect(storage.delete).toHaveBeenCalledWith("pipecat:aaa");
  });

  test("test_delete_failure_is_swallowed", async () => {
    const app = new RunnerApp();
    app.fileStorage = {
      delete: async () => {
        throw new Error("AccessDenied");
      },
    } as unknown as FileStorage;
    app.sessionUploadUrls.set("sess-1", ["pipecat:aaa"]);
    await _runBotSession(app, async () => {}, "sess-1", { "sess-1": {} });
  });
});

describe("TestLiveKitRunnerRoutes", () => {
  // pipecat.runner.livekit is not ported (the LiveKit transport isn't); upstream
  // skips these too when the livekit package is missing.
  test.todo("test_livekit_credentials_raises_when_unconfigured (needs pipecat.runner.livekit)");
  test.todo("test_livekit_credentials_returns_configured_values (needs pipecat.runner.livekit)");
  test.todo(
    "test_generate_session_tokens_suffixes_identity_with_session_id (needs pipecat.runner.livekit)",
  );
});

/** Unit tests for the HMAC WebSocket session token helpers. */
describe("TestWsAuthTokens", () => {
  test("test_generate_token_has_two_parts", async () => {
    const token = await _generateWsToken();
    expect(token.split(".").length).toBe(2);
  });

  test("test_generate_token_is_unique", async () => {
    expect(await _generateWsToken()).not.toBe(await _generateWsToken());
  });

  test("test_validate_accepts_fresh_token", async () => {
    const token = await _generateWsToken();
    expect(await _verifyAndConsumeWsToken(new Set(), token)).toBe(true);
  });

  test("test_validate_consumes_token_on_success", async () => {
    const used = new Set<string>();
    const token = await _generateWsToken();
    await _verifyAndConsumeWsToken(used, token);
    expect(used.has(token)).toBe(true);
  });

  test("test_validate_rejects_replayed_token", async () => {
    const used = new Set<string>();
    const token = await _generateWsToken();
    expect(await _verifyAndConsumeWsToken(used, token)).toBe(true);
    expect(await _verifyAndConsumeWsToken(used, token)).toBe(false);
  });

  test("test_validate_rejects_expired_token", async () => {
    _deps.time = () => 1_000_000_000;
    const token = await _generateWsToken(300);
    _deps.time = () => 1_000_000_000 + 301;
    expect(await _verifyAndConsumeWsToken(new Set(), token)).toBe(false);
  });

  test("test_validate_rejects_tampered_signature", async () => {
    const token = await _generateWsToken();
    const payload = token.slice(0, token.lastIndexOf("."));
    expect(await _verifyAndConsumeWsToken(new Set(), `${payload}.badsignature`)).toBe(false);
  });

  test("test_validate_rejects_tampered_payload", async () => {
    const token = await _generateWsToken();
    const sig = token.slice(token.lastIndexOf(".") + 1);
    const badPayload = btoa(JSON.stringify({ exp: 9_999_999_999 }))
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replace(/=+$/, "");
    expect(await _verifyAndConsumeWsToken(new Set(), `${badPayload}.${sig}`)).toBe(false);
  });

  test("test_validate_rejects_malformed_token_no_dot", async () => {
    expect(await _verifyAndConsumeWsToken(new Set(), "nodothere")).toBe(false);
  });

  test("test_validate_rejects_malformed_token_bad_base64", async () => {
    expect(await _verifyAndConsumeWsToken(new Set(), "!!!.invalidsig")).toBe(false);
  });

  const ws = (auth: string, query: string | null) => ({
    headers: { get: () => auth },
    queryParams: { get: () => query },
  });

  test("test_extract_reads_authorization_bearer_header", () => {
    expect(_extractWsToken(ws("Bearer mytoken", null))).toBe("mytoken");
  });

  test("test_extract_bearer_is_case_insensitive", () => {
    expect(_extractWsToken(ws("BEARER mytoken", null))).toBe("mytoken");
  });

  test("test_extract_falls_back_to_query_param", () => {
    expect(_extractWsToken(ws("", "qptoken"))).toBe("qptoken");
  });

  test("test_extract_prefers_header_over_query_param", () => {
    expect(_extractWsToken(ws("Bearer headertoken", "qptoken"))).toBe("headertoken");
  });

  test("test_extract_returns_none_when_absent", () => {
    expect(_extractWsToken(ws("", null))).toBeNull();
  });
});

/** Route registration tests for path-token WebSocket variants. */
describe("TestWsAuthRouteRegistration", () => {
  test("test_websocket_routes_register_path_token_route", () => {
    const app = new RunnerApp();
    routesEnabled(true);
    _setupWebsocketRoutes(app, { ws_auth: "token" }, new Set());
    expect(paths(app).has("/ws-client")).toBe(true);
    expect(paths(app).has("/ws-client/{token}")).toBe(true);
  });

  test("test_telephony_routes_register_path_token_route", () => {
    const app = new RunnerApp();
    routesEnabled(true);
    _setupTelephonyRoutes(app, { transport: null, ws_auth: "token" }, new Set());
    expect(paths(app).has("/ws")).toBe(true);
    expect(paths(app).has("/ws/{token}")).toBe(true);
  });
});

/** Tests for /start returning HMAC tokens when ws_auth='token'. */
describe("TestWsAuthStartEndpoint", () => {
  function makeApp(wsAuth: string): RunnerApp {
    const app = new RunnerApp();
    app.fileStorage = null;
    _setupUnifiedStartRoute(
      app,
      { transport: null, ws_auth: wsAuth, host: "localhost", port: 7860, ice_servers: [] },
      {},
    );
    return app;
  }

  test("test_start_websocket_returns_none_when_auth_disabled", async () => {
    routesEnabled(true);
    const response = await post(makeApp("none"), "/start", { transport: "websocket" });
    expect(response.status).toBe(200);
    expect((await response.json()).token ?? null).toBeNull();
  });

  test("test_start_websocket_returns_real_token_when_auth_enabled", async () => {
    routesEnabled(true);
    const response = await post(makeApp("token"), "/start", { transport: "websocket" });
    expect(response.status).toBe(200);
    const token = (await response.json()).token;
    expect(token).not.toBeNull();
    expect(await _verifyAndConsumeWsToken(new Set(), token)).toBe(true);
  });

  test("test_start_telephony_omits_token_when_auth_disabled", async () => {
    routesEnabled(true);
    const response = await post(makeApp("none"), "/start", { transport: "twilio" });
    expect(response.status).toBe(200);
    expect("token" in (await response.json())).toBe(false);
  });

  test("test_start_telephony_returns_token_when_auth_enabled", async () => {
    routesEnabled(true);
    const response = await post(makeApp("token"), "/start", { transport: "twilio" });
    expect(response.status).toBe(200);
    const token = (await response.json()).token;
    expect(token).toBeTruthy();
    expect(await _verifyAndConsumeWsToken(new Set(), token)).toBe(true);
  });
});

/**
 * Connect to `path` on a served app; resolves with the close code once the
 * server closes the socket, or "open" if it stays open for a moment.
 */
async function connect(
  app: RunnerApp,
  path: string,
  headers: Record<string, string> = {},
): Promise<number | "accepted"> {
  const server = await serve(app, { host: "127.0.0.1", port: 0 });
  try {
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}${path}`, { headers } as any);
    return await new Promise((resolve, reject) => {
      let opened = false;
      ws.addEventListener("open", () => {
        opened = true;
      });
      ws.addEventListener("close", (event) => {
        // The bot stub returns at once, so an accepted socket closes with 1000.
        resolve(event.code === 4003 ? 4003 : opened ? "accepted" : event.code);
      });
      ws.addEventListener("error", () => {
        if (!opened) reject(new Error("connection failed"));
      });
    });
  } finally {
    await server.close();
  }
}

/** A bot module whose `bot()` records its runner arguments and returns. */
function stubBot(): BotModule & { calls: RunnerArguments[] } {
  const calls: RunnerArguments[] = [];
  return {
    calls,
    bot: async (runnerArgs: RunnerArguments) => {
      calls.push(runnerArgs);
    },
  };
}

/** WebSocket connection tests verifying auth enforcement. */
describe("TestWsAuthConnectionBehavior", () => {
  function makeWsClientApp(wsAuth: string): [RunnerApp, Set<string>, ReturnType<typeof stubBot>] {
    const bot = stubBot();
    const app = new RunnerApp({ botModule: bot });
    app.fileStorage = null;
    const used = new Set<string>();
    routesEnabled(true);
    _setupWebsocketRoutes(app, { ws_auth: wsAuth, allowed_origins: [] }, used);
    return [app, used, bot];
  }

  function makeTelephonyApp(wsAuth: string): [RunnerApp, Set<string>, ReturnType<typeof stubBot>] {
    const bot = stubBot();
    const app = new RunnerApp({ botModule: bot });
    app.fileStorage = null;
    const used = new Set<string>();
    routesEnabled(true);
    _setupTelephonyRoutes(app, { ws_auth: wsAuth, transport: null, allowed_origins: [] }, used);
    return [app, used, bot];
  }

  // /ws-client (plain WebSocket)

  test("test_plain_ws_rejects_without_token_when_auth_enabled", async () => {
    const [app] = makeWsClientApp("token");
    expect(await connect(app, "/ws-client")).toBe(4003);
  });

  test("test_plain_ws_rejects_invalid_token_in_query_param", async () => {
    const [app] = makeWsClientApp("token");
    expect(await connect(app, "/ws-client?token=badtoken")).toBe(4003);
  });

  test("test_plain_ws_accepts_valid_token_in_query_param", async () => {
    const [app, , bot] = makeWsClientApp("token");
    const token = await _generateWsToken();
    expect(await connect(app, `/ws-client?token=${token}`)).toBe("accepted");
    expect(bot.calls.length).toBe(1);
  });

  test("test_plain_ws_accepts_valid_token_in_path", async () => {
    const [app, , bot] = makeWsClientApp("token");
    const token = await _generateWsToken();
    expect(await connect(app, `/ws-client/${token}`)).toBe("accepted");
    expect(bot.calls.length).toBe(1);
  });

  test("test_plain_ws_rejects_replayed_token", async () => {
    const [app, used] = makeWsClientApp("token");
    const token = await _generateWsToken();
    used.add(token); // mark already consumed
    expect(await connect(app, `/ws-client?token=${token}`)).toBe(4003);
  });

  test("test_plain_ws_allows_any_connection_when_auth_disabled", async () => {
    const [app, , bot] = makeWsClientApp("none");
    expect(await connect(app, "/ws-client")).toBe("accepted");
    expect(bot.calls.length).toBe(1);
  });

  // /ws (telephony WebSocket)

  test("test_telephony_ws_rejects_without_token_when_auth_enabled", async () => {
    const [app] = makeTelephonyApp("token");
    expect(await connect(app, "/ws")).toBe(4003);
  });

  test("test_telephony_ws_accepts_valid_token_in_path", async () => {
    const [app, , bot] = makeTelephonyApp("token");
    const token = await _generateWsToken();
    expect(await connect(app, `/ws/${token}`)).toBe("accepted");
    expect(bot.calls.length).toBe(1);
  });

  test("test_telephony_ws_allows_any_connection_when_auth_disabled", async () => {
    const [app, , bot] = makeTelephonyApp("none");
    expect(await connect(app, "/ws")).toBe("accepted");
    expect(bot.calls.length).toBe(1);
  });
});

/** `--runner-body` reaches WebSocket sessions, which have no /start body. */
describe("TestRunnerBody", () => {
  test("test_telephony_bot_gets_the_runner_body", async () => {
    const dir = mkdtempSync(join(tmpdir(), "runner-body-"));
    try {
      const file = join(dir, "body.yaml");
      writeFileSync(file, "image_path: cat.jpg\n");
      const bot = stubBot();
      const app = new RunnerApp({ botModule: bot });
      app.fileStorage = null;
      await _runTelephonyBot(app, {} as any, { runner_body: file });
      expect(bot.calls[0]!.body).toEqual({ image_path: "cat.jpg" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("test_telephony_bot_without_a_runner_body", async () => {
    const bot = stubBot();
    const app = new RunnerApp({ botModule: bot });
    app.fileStorage = null;
    await _runTelephonyBot(app, {} as any, { runner_body: null });
    expect(bot.calls[0]!.body).toBeNull();
  });
});

describe("TestDeprecatedEvalTransportOption", () => {
  // `-t eval` is deprecated upstream (since 1.13.0); deprecated APIs are not ported.
  test.skip("test_eval_transport_runs_the_server", () => {});
});

/** Unit tests for the isOriginAllowed utility. */
describe("TestAllowedOriginsUtil", () => {
  test("test_empty_list_allows_any_origin", () => {
    expect(isOriginAllowed("https://example.com", [])).toBe(true);
  });
  test("test_empty_list_allows_missing_origin", () => {
    expect(isOriginAllowed("", [])).toBe(true);
  });
  test("test_matching_origin_is_allowed", () => {
    expect(isOriginAllowed("https://example.com", ["https://example.com"])).toBe(true);
  });
  test("test_non_matching_origin_is_rejected", () => {
    expect(isOriginAllowed("https://evil.com", ["https://example.com"])).toBe(false);
  });
  test("test_missing_origin_is_rejected_when_origins_configured", () => {
    expect(isOriginAllowed("", ["https://example.com"])).toBe(false);
  });
  test("test_matching_is_case_insensitive", () => {
    expect(isOriginAllowed("https://Example.COM", ["https://example.com"])).toBe(true);
  });
  test("test_multiple_allowed_origins", () => {
    const allowed = ["https://a.com", "https://b.com"];
    expect(isOriginAllowed("https://a.com", allowed)).toBe(true);
    expect(isOriginAllowed("https://b.com", allowed)).toBe(true);
    expect(isOriginAllowed("https://c.com", allowed)).toBe(false);
  });
});

/** WebSocket connection tests verifying origin enforcement. */
describe("TestWsOriginConnectionBehavior", () => {
  function makeWsClientApp(allowedOrigins: string[]): RunnerApp {
    const app = new RunnerApp({ botModule: stubBot() });
    app.fileStorage = null;
    routesEnabled(true);
    _setupWebsocketRoutes(app, { ws_auth: "none", allowed_origins: allowedOrigins }, new Set());
    return app;
  }

  function makeTelephonyApp(allowedOrigins: string[]): RunnerApp {
    const app = new RunnerApp({ botModule: stubBot() });
    app.fileStorage = null;
    routesEnabled(true);
    _setupTelephonyRoutes(
      app,
      { ws_auth: "none", transport: null, allowed_origins: allowedOrigins },
      new Set(),
    );
    return app;
  }

  test("test_plain_ws_rejects_disallowed_origin", async () => {
    const app = makeWsClientApp(["https://allowed.com"]);
    expect(await connect(app, "/ws-client", { Origin: "https://evil.com" })).toBe(4003);
  });

  test("test_plain_ws_rejects_missing_origin_when_origins_configured", async () => {
    const app = makeWsClientApp(["https://allowed.com"]);
    expect(await connect(app, "/ws-client")).toBe(4003);
  });

  test("test_plain_ws_accepts_allowed_origin", async () => {
    const app = makeWsClientApp(["https://allowed.com"]);
    expect(await connect(app, "/ws-client", { Origin: "https://allowed.com" })).toBe("accepted");
  });

  test("test_plain_ws_allows_any_origin_when_origins_not_configured", async () => {
    const app = makeWsClientApp([]);
    expect(await connect(app, "/ws-client", { Origin: "https://anyone.com" })).toBe("accepted");
  });

  test("test_telephony_ws_rejects_disallowed_origin", async () => {
    const app = makeTelephonyApp(["https://allowed.com"]);
    expect(await connect(app, "/ws", { Origin: "https://evil.com" })).toBe(4003);
  });

  test("test_telephony_ws_accepts_allowed_origin", async () => {
    const app = makeTelephonyApp(["https://allowed.com"]);
    expect(await connect(app, "/ws", { Origin: "https://allowed.com" })).toBe("accepted");
  });
});

/** Unit tests for the --ice-servers and PIPECAT_ICE_SERVERS parser. */
describe("TestIceServerParsing", () => {
  test("test_empty_input_yields_no_servers", () => {
    expect(_parseIceServers(null)).toEqual([]);
    expect(_parseIceServers("")).toEqual([]);
    expect(_parseIceServers([])).toEqual([]);
  });

  test("test_cli_tokens_of_bare_urls", () => {
    expect(
      _parseIceServers(["stun:stun.l.google.com:19302", "turn:turn.example.com:3478"]),
    ).toEqual([{ urls: "stun:stun.l.google.com:19302" }, { urls: "turn:turn.example.com:3478" }]);
  });

  test("test_cli_token_of_json_object_keeps_credentials", () => {
    expect(
      _parseIceServers([
        '{"urls": "turn:turn.example.com:3478", "username": "u", "credential": "p"}',
      ]),
    ).toEqual([{ urls: "turn:turn.example.com:3478", username: "u", credential: "p" }]);
  });

  test("test_env_value_is_split_on_commas", () => {
    expect(_parseIceServers("stun:stun.l.google.com:19302, turn:turn.example.com:3478")).toEqual([
      { urls: "stun:stun.l.google.com:19302" },
      { urls: "turn:turn.example.com:3478" },
    ]);
  });

  test("test_env_value_may_be_a_json_array", () => {
    expect(
      _parseIceServers(
        '[{"urls": ["turn:turn.example.com:3478"], "username": "u", "credential": "p"},' +
          ' "stun:stun.l.google.com:19302"]',
      ),
    ).toEqual([
      { urls: ["turn:turn.example.com:3478"], username: "u", credential: "p" },
      { urls: "stun:stun.l.google.com:19302" },
    ]);
  });

  test("test_null_credentials_are_dropped", () => {
    expect(_parseIceServers('{"urls": "stun:stun.example.com:3478", "username": null}')).toEqual([
      { urls: "stun:stun.example.com:3478" },
    ]);
  });

  test("test_entry_without_urls_is_rejected", () => {
    expect(() => _parseIceServers('{"username": "u", "credential": "p"}')).toThrow();
  });

  test("test_unsupported_key_is_rejected", () => {
    expect(() => _parseIceServers('{"urls": "turn:turn.example.com:3478", "user": "u"}')).toThrow(
      "user",
    );
  });

  test("test_malformed_json_is_rejected", () => {
    expect(() => _parseIceServers('{"urls": ')).toThrow();
    expect(() => _parseIceServers('[{"urls": "turn:turn.example.com:3478"')).toThrow();
  });

  test("test_json_scalar_is_rejected", () => {
    expect(() => _parseIceServers("[7]")).toThrow();
  });
});

/** Tests for the iceConfig the WebRTC /start response hands to clients. */
describe("TestStartIceConfig", () => {
  async function postStart(iceServers: object[], body: object): Promise<Record<string, any>> {
    const app = new RunnerApp();
    app.fileStorage = null;
    _setupUnifiedStartRoute(app, { transport: null, ice_servers: iceServers }, {});
    routesEnabled(true);
    const response = await post(app, "/start", { transport: "webrtc", ...body });
    expect(response.status).toBe(200);
    return await response.json();
  }

  test("test_no_ice_config_without_configuration_or_request_flag", async () => {
    expect((await postStart([], {})).iceConfig ?? null).toBeNull();
  });

  test("test_request_flag_still_returns_the_public_stun_fallback", async () => {
    const result = await postStart([], { enableDefaultIceServers: true });
    expect(result.iceConfig).toEqual({ iceServers: [{ urls: ["stun:stun.l.google.com:19302"] }] });
  });

  test("test_configured_servers_are_returned_to_the_client", async () => {
    const configured = [{ urls: "turn:turn.example.com:3478", username: "u", credential: "p" }];
    expect((await postStart(configured, {})).iceConfig).toEqual({ iceServers: configured });
  });

  test("test_configured_servers_take_precedence_over_the_fallback", async () => {
    const configured = [{ urls: "stun:stun.example.com:3478" }];
    const result = await postStart(configured, { enableDefaultIceServers: true });
    expect(result.iceConfig).toEqual({ iceServers: configured });
  });
});

/**
 * Tests for the fileUploadUrl the /start response advertises so clients never
 * have to reconstruct the uploads route themselves.
 */
describe("TestStartFileUploadUrl", () => {
  async function postStart(body: object, storage: FileStorage | null) {
    const app = new RunnerApp();
    app.fileStorage = storage;
    _setupUnifiedStartRoute(
      app,
      { transport: null, ice_servers: [], ws_auth: "none", host: "localhost", port: 7860 },
      {},
    );
    routesEnabled(true);
    const response = await post(app, "/start", body);
    expect(response.status).toBe(200);
    return (await response.json()) as Record<string, any>;
  }

  test("test_webrtc_advertises_the_session_scoped_route", async () => {
    const result = await postStart(
      { transport: "webrtc" },
      fakeStorage(async () => "x"),
    );
    expect(result.fileUploadUrl).toBe(`/sessions/${result.sessionId}/files`);
  });

  test("test_webrtc_omits_the_url_when_uploads_are_disabled", async () => {
    const result = await postStart({ transport: "webrtc" }, null);
    expect("fileUploadUrl" in result).toBe(false);
  });

  test("test_websocket_advertises_the_flat_route", async () => {
    // The websocket /start sessionId is never registered (the bot mints its own
    // at connect time), so the session-scoped route would 404.
    const result = await postStart(
      { transport: "websocket" },
      fakeStorage(async () => "x"),
    );
    expect(result.fileUploadUrl).toBe("/files");
  });

  test("test_telephony_advertises_nothing", async () => {
    const result = await postStart(
      { transport: "twilio" },
      fakeStorage(async () => "x"),
    );
    expect("fileUploadUrl" in result).toBe(false);
  });
});

describe("pipedog: unported transports", () => {
  test("/start for an unported transport says so when its routes are forced on", async () => {
    const app = new RunnerApp();
    _setupUnifiedStartRoute(app, { transport: null, ice_servers: [] }, {});
    routesEnabled(true);
    const response = await post(app, "/start", { transport: "livekit" });
    expect(response.status).toBe(400);
    expect((await response.json()).detail).toContain("not ported to pipedog yet");
  });
});
