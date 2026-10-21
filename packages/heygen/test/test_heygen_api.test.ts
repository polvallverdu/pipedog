// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Tests for the HeyGen and LiveAvatar session APIs, against a fake `fetch`
// (upstream has no tests for these modules).

import { describe, expect, test } from "bun:test";
import {
  ElevenLabsSettings,
  HeyGenApi,
  HeygenApiError,
  NewSessionRequest,
  VoiceSettings,
} from "../src/api_interactive_avatar.ts";
import {
  AvatarPersona,
  CustomSDKLiveKitConfig,
  LiveAvatarApi,
  LiveAvatarApiError,
  LiveAvatarNewSessionRequest,
  VideoEncoding,
  VideoQuality,
  VideoSettings,
} from "../src/api_liveavatar.ts";
import { ResponseValidationError } from "../src/base_api.ts";

type Call = { url: string; method: string; headers: Record<string, string>; body: unknown };

function fakeFetch(respond: (call: Call) => { status?: number; body: unknown }): {
  fetch: typeof fetch;
  calls: Call[];
} {
  const calls: Call[] = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      method: init?.method ?? "GET",
      headers: { ...((init?.headers as Record<string, string>) ?? {}) },
      body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
    };
    calls.push(call);
    const { status = 200, body } = respond(call);
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  }) as typeof fetch;
  return { fetch: f, calls };
}

const START_DATA = {
  session_id: "sess-1",
  livekit_url: "wss://lk.example",
  livekit_client_token: "client-token",
  livekit_agent_token: "agent-token",
  max_session_duration: 600,
  ws_url: "wss://ws.example",
};

describe("LiveAvatarApi", () => {
  test("new_session creates a token then starts the session", async () => {
    const { fetch, calls } = fakeFetch((call) =>
      call.url.endsWith("/sessions/token")
        ? {
            body: { code: 100, data: { session_id: "sess-1", session_token: "st" }, message: "ok" },
          }
        : { body: { code: 100, data: START_DATA, message: "ok" } },
    );
    const api = new LiveAvatarApi("key", { fetch });
    const session = await api.newSession(new LiveAvatarNewSessionRequest({ avatarId: "av" }));

    expect(calls.map((c) => c.url)).toEqual([
      "https://api.liveavatar.com/v1/sessions/token",
      "https://api.liveavatar.com/v1/sessions/start",
    ]);
    expect(calls[0]!.headers["X-API-KEY"]).toBe("key");
    expect(calls[0]!.headers["content-type"]).toBe("application/json");
    expect(calls[0]!.body).toEqual({
      mode: "LITE",
      avatar_id: "av",
      is_sandbox: false,
      video_settings: { encoding: "H264", quality: "high" },
    });
    expect(calls[1]!.headers.authorization).toBe("Bearer st");
    expect(calls[1]!.headers["X-API-KEY"]).toBeUndefined();
    expect(calls[1]!.body).toBeNull();

    expect(session.sessionId).toBe("sess-1");
    expect(session.accessToken).toBe("client-token");
    expect(session.livekitAgentToken).toBe("agent-token");
    expect(session.livekitUrl).toBe("wss://lk.example");
    expect(session.wsUrl).toBe("wss://ws.example");
  });

  test("create_session_token sends persona, duration, settings and livekit_config", async () => {
    const { fetch, calls } = fakeFetch(() => ({
      body: { code: 100, data: { session_id: "s", session_token: "t" }, message: "ok" },
    }));
    const api = new LiveAvatarApi("key", { fetch });
    await api.createSessionToken(
      new LiveAvatarNewSessionRequest({
        mode: "FULL",
        avatarId: "av",
        isSandbox: true,
        maxSessionDuration: 120,
        videoSettings: new VideoSettings({
          encoding: VideoEncoding.VP8,
          quality: VideoQuality.very_high,
        }),
        avatarPersona: new AvatarPersona({ voiceId: "v" }),
        livekitConfig: new CustomSDKLiveKitConfig({
          livekitUrl: "wss://mine",
          livekitRoom: "room",
          livekitClientToken: "tok",
        }),
      }),
    );
    expect(calls[0]!.body).toEqual({
      mode: "FULL",
      avatar_id: "av",
      avatar_persona: { voice_id: "v", language: "en" },
      is_sandbox: true,
      max_session_duration: 120,
      video_settings: { encoding: "VP8", quality: "very_high" },
      livekit_config: {
        livekit_url: "wss://mine",
        livekit_room: "room",
        livekit_client_token: "tok",
      },
    });
  });

  test("video_settings null falls back to H264", async () => {
    const { fetch, calls } = fakeFetch(() => ({
      body: { code: 100, data: { session_id: "s", session_token: "t" }, message: "ok" },
    }));
    const api = new LiveAvatarApi("key", { fetch });
    await api.createSessionToken(
      new LiveAvatarNewSessionRequest({ avatarId: "av", videoSettings: null, isSandbox: null }),
    );
    expect(calls[0]!.body).toEqual({
      mode: "LITE",
      avatar_id: "av",
      video_settings: { encoding: "H264" },
    });
  });

  test("start_session accepts a response without agent token or ws_url", async () => {
    const { fetch } = fakeFetch(() => ({
      body: {
        code: 100,
        data: { session_id: "s", livekit_url: "wss://lk", livekit_client_token: "c" },
        message: "ok",
      },
    }));
    const api = new LiveAvatarApi("key", { fetch });
    const response = await api.startSession("st");
    expect(response.data.livekitAgentToken).toBeNull();
    expect(response.data.wsUrl).toBeNull();
    expect(response.data.maxSessionDuration).toBeNull();
  });

  test("start_session rejects a response missing required fields", async () => {
    const { fetch } = fakeFetch(() => ({
      body: { code: 100, data: { session_id: "s" }, message: "ok" },
    }));
    const api = new LiveAvatarApi("key", { fetch });
    await expect(api.startSession("st")).rejects.toBeInstanceOf(ResponseValidationError);
  });

  test("close_session needs new_session first, then stops with the session token", async () => {
    const { fetch, calls } = fakeFetch((call) =>
      call.url.endsWith("/sessions/token")
        ? { body: { code: 100, data: { session_id: "sess-1", session_token: "st" }, message: "" } }
        : call.url.endsWith("/sessions/start")
          ? { body: { code: 100, data: START_DATA, message: "" } }
          : { body: { code: 100, data: null, message: "" } },
    );
    const api = new LiveAvatarApi("key", { fetch });
    await expect(api.closeSession("sess-1")).rejects.toThrow("Session token is not set");
    await api.newSession(new LiveAvatarNewSessionRequest({ avatarId: "av" }));
    await api.closeSession("sess-1");
    const stop = calls.at(-1)!;
    expect(stop.url).toBe("https://api.liveavatar.com/v1/sessions/stop");
    expect(stop.method).toBe("POST");
    expect(stop.headers.authorization).toBe("Bearer st");
    expect(stop.body).toEqual({ session_id: "sess-1" });
  });

  test("stop_session requires a session id", async () => {
    const api = new LiveAvatarApi("key", { fetch: fakeFetch(() => ({ body: {} })).fetch });
    await expect(api.stopSession("", "t")).rejects.toThrow("Session ID is not set.");
  });

  test("HTTP errors raise LiveAvatarApiError", async () => {
    const { fetch } = fakeFetch(() => ({ status: 401, body: "nope" }));
    const api = new LiveAvatarApi("key", { fetch });
    const error = await api.startSession("st").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LiveAvatarApiError);
    expect((error as LiveAvatarApiError).status).toBe(401);
    expect((error as LiveAvatarApiError).responseText).toBe("nope");
  });
});

describe("HeyGenApi", () => {
  test("new_session creates and starts a streaming session", async () => {
    const { fetch, calls } = fakeFetch((call) =>
      call.url.endsWith("/streaming.new")
        ? {
            body: {
              data: {
                session_id: "s1",
                access_token: "user",
                livekit_agent_token: "agent",
                realtime_endpoint: "wss://rt",
                url: "wss://lk",
              },
            },
          }
        : { body: { data: {} } },
    );
    const api = new HeyGenApi("key", { fetch });
    const session = await api.newSession(
      new NewSessionRequest({
        avatarId: "a",
        voice: new VoiceSettings({
          voiceId: "v",
          elevenlabsSettings: new ElevenLabsSettings({ stability: 0.5 }),
        }),
      }),
    );
    expect(calls.map((c) => c.url)).toEqual([
      "https://api.heygen.com/v1/streaming.new",
      "https://api.heygen.com/v1/streaming.start",
    ]);
    expect(calls[0]!.headers["x-api-key"]).toBe("key");
    expect(calls[0]!.body).toEqual({
      quality: null,
      avatar_id: "a",
      voice: {
        voice_id: "v",
        rate: null,
        emotion: null,
        elevenlabs_settings: {
          stability: 0.5,
          similarity_boost: null,
          model_id: null,
          style: null,
          use_speaker_boost: null,
        },
      },
      knowledge_id: null,
      knowledge_base: null,
      version: "v2",
      video_encoding: null,
      disable_idle_timeout: null,
      activity_idle_timeout: null,
    });
    expect(calls[1]!.body).toEqual({ session_id: "s1" });
    expect(session.sessionId).toBe("s1");
    expect(session.accessToken).toBe("user");
    expect(session.livekitAgentToken).toBe("agent");
    expect(session.wsUrl).toBe("wss://rt");
    expect(session.livekitUrl).toBe("wss://lk");
  });

  test("close_session and create_token", async () => {
    const { fetch, calls } = fakeFetch((call) =>
      call.url.endsWith("/streaming.create_token")
        ? { body: { data: { token: "tok" } } }
        : { body: "closed" },
    );
    const api = new HeyGenApi("key", { fetch });
    expect(await api.closeSession("s1")).toBe("closed");
    expect(calls[0]!.body).toEqual({ session_id: "s1" });
    expect(await api.createToken()).toBe("tok");
    await expect(api.closeSession("")).rejects.toThrow("Session ID is not set");
  });

  test("HTTP errors raise HeygenApiError", async () => {
    const { fetch } = fakeFetch(() => ({ status: 500, body: "boom" }));
    const api = new HeyGenApi("key", { fetch });
    const error = await api.createToken().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HeygenApiError);
    expect((error as HeygenApiError).status).toBe(500);
  });
});
