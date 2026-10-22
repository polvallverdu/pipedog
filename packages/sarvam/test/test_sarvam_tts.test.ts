// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_sarvam_tts.py

/**
 * Tests for SarvamTTSService and SarvamHttpTTSService.
 *
 * Porting notes:
 * - `_FakeWebsocket` keeps its `state` and `sent`, with `State` from core.
 * - `_FakeSession` (aiohttp) becomes a fake `fetch` that records the JSON
 *   body of each POST, since `SarvamHttpTTSService` takes a `fetch`.
 * - `monkeypatch.setattr(service, "_disconnect", AsyncMock())` → instance mocks.
 * - `test_v4_flash_defaults` reads `_initSampleRate`, upstream's
 *   `_init_sample_rate`.
 */

import { describe, expect, mock, test } from "bun:test";
import { State } from "@pipedog/core/services/websocket_service";
import { SarvamHttpTTSService, SarvamTTSService } from "../src/tts.ts";

type Any = any;

const V4_FLASH = "bulbul:v4-flash";

class FakeWebsocket {
  state: State;
  sent: string[] = [];

  constructor(state: State = State.OPEN) {
    this.state = state;
  }

  async send(message: string): Promise<void> {
    this.sent.push(message);
  }

  async close(): Promise<void> {
    this.state = State.CLOSED;
  }
}

/** Records the JSON body of each POST. */
class FakeSession {
  payloads: Record<string, any>[] = [];

  fetch = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    this.payloads.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ audios: [""], request_id: "test" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
}

function service(settings: Record<string, unknown> = {}): Any {
  const options = { model: V4_FLASH, ...settings };
  return new SarvamTTSService({
    apiKey: "test-key",
    settings: new SarvamTTSService.Settings(options),
  });
}

function httpService(session: FakeSession, settings: Record<string, unknown> = {}): Any {
  const options = { model: V4_FLASH, ...settings };
  const svc: Any = new SarvamHttpTTSService({
    apiKey: "test-key",
    fetch: session.fetch as typeof fetch,
    settings: new SarvamHttpTTSService.Settings(options),
  });
  svc._sampleRate = svc._initSampleRate;
  return svc;
}

/** Read back the config the service put on the wire. */
function sentConfig(svc: Any): Record<string, any> {
  const messages = svc._websocket.sent.map((m: string) => JSON.parse(m));
  const configs = messages.filter((m: Any) => m.type === "config").map((m: Any) => m.data);
  expect(configs.length).toBeGreaterThan(0); // no config message was sent
  return configs[configs.length - 1];
}

function urlModel(svc: Any): string {
  return new URL(svc._websocketUrl).searchParams.get("model") as string;
}

async function synthesize(svc: Any, session: FakeSession): Promise<Record<string, any>> {
  for await (const _ of svc.runTts("hello", "ctx")) {
    // drain
  }
  return session.payloads[session.payloads.length - 1]!;
}

test("test_v4_flash_defaults", () => {
  // The service has to land on the same speaker and rate the API defaults to.
  const svc = service();

  expect(svc._settings.voice).toBe("shubh_en_narration_gentle");
  expect(svc._initSampleRate).toBe(24000);
  expect(svc._settings.enablePreprocessing).toBe(true);
});

test("test_v4_flash_sends_pitch_and_loudness", async () => {
  // v4-flash applies both; the v3 models ignore them.
  const svc = service({ pitch: 0.3, loudness: 1.5, pace: 1.2 });
  svc._websocket = new FakeWebsocket();

  await svc._sendConfig();
  const config = sentConfig(svc);

  expect(config.pitch).toBe(0.3);
  expect(config.loudness).toBe(1.5);
  expect(config.pace).toBe(1.2);
});

describe("test_v4_flash_drops_temperature", () => {
  // The API pins it to 0.6, so sending any value would only mislead.
  for (const temperature of [0.6, 0.9]) {
    test(String(temperature), async () => {
      const svc = service({ temperature });
      svc._websocket = new FakeWebsocket();

      await svc._sendConfig();

      expect("temperature" in sentConfig(svc)).toBe(false);
    });
  }
});

test("test_v4_flash_drops_a_runtime_temperature_update", async () => {
  const svc = service();
  svc._websocket = new FakeWebsocket();

  await svc._updateSettings(new SarvamTTSService.Settings({ temperature: 0.9 }));

  expect("temperature" in sentConfig(svc)).toBe(false);
});

test("test_v4_flash_clamps_pace_to_its_own_range", () => {
  const svc = service({ pace: 2.5 });

  expect(svc._settings.pace).toBe(2.0);
});

test("test_switching_to_v4_flash_reconnects_with_its_capabilities", async () => {
  // The model is pinned on the URL, so the switch needs a new connection.
  const svc = service({ model: "bulbul:v3", voice: null });
  const disconnect = mock(async () => {});
  const connect = mock(async () => {});
  svc._disconnect = disconnect;
  svc._connect = connect;

  await svc._updateSettings(new SarvamTTSService.Settings({ model: V4_FLASH }));

  expect(urlModel(svc)).toBe(V4_FLASH);
  expect(svc._config.supportsPitch).toBe(true);
  // bulbul:v4-flash rejects the v3 default, so the voice moves with the model.
  expect(svc._settings.voice).toBe("shubh_en_narration_gentle");
  expect(disconnect).toHaveBeenCalledTimes(1);
  expect(connect).toHaveBeenCalledTimes(1);
});

test("test_a_voice_switched_with_the_model_is_kept", async () => {
  const svc = service({ model: "bulbul:v3", voice: null });
  svc._disconnect = mock(async () => {});
  svc._connect = mock(async () => {});

  await svc._updateSettings(
    new SarvamTTSService.Settings({ model: V4_FLASH, voice: "ritu_hi_edtech" }),
  );

  expect(svc._settings.voice).toBe("ritu_hi_edtech");
});

test("test_an_unsupported_model_update_is_ignored", async () => {
  const svc = service({ model: "bulbul:v3", voice: null });
  svc._websocket = new FakeWebsocket();
  const connect = mock(async () => {});
  svc._connect = connect;

  const changed = await svc._updateSettings(new SarvamTTSService.Settings({ model: "bulbul:v9" }));

  expect(svc._settings.model).toBe("bulbul:v3");
  expect(urlModel(svc)).toBe("bulbul:v3");
  expect("model" in changed).toBe(false);
  expect(connect).not.toHaveBeenCalled();
});

test("test_http_payload_carries_only_the_parameters_v4_flash_supports", async () => {
  const session = new FakeSession();
  const svc = httpService(session, { pitch: 0.3, loudness: 1.5, temperature: 0.9 });

  const payload = await synthesize(svc, session);

  expect(payload.model).toBe(V4_FLASH);
  expect(payload.speaker).toBe("shubh_en_narration_gentle");
  expect(payload.pitch).toBe(0.3);
  expect(payload.loudness).toBe(1.5);
  expect("temperature" in payload).toBe(false);
});

test("test_switching_the_http_service_to_v4_flash_takes_its_capabilities", async () => {
  // `runTts` builds the payload from the model config, so the switch has to swap it.
  const session = new FakeSession();
  const svc = httpService(session, { model: "bulbul:v3", voice: null });

  await svc._updateSettings(
    new SarvamHttpTTSService.Settings({ model: V4_FLASH, pitch: 0.3, loudness: 1.5 }),
  );
  const payload = await synthesize(svc, session);

  expect(payload.model).toBe(V4_FLASH);
  expect(payload.speaker).toBe("shubh_en_narration_gentle");
  expect(payload.pitch).toBe(0.3);
  expect("temperature" in payload).toBe(false);
});
