// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_azure_voice_live_service.py

/**
 * Tests for Azure Voice Live service configuration.
 *
 * Porting note: upstream patches the module's `websocket_connect`; here the
 * service's `_websocketConnect` is replaced.
 */

import { expect, test } from "bun:test";

import { TimeoutError } from "@pipedog/asyncio";
import { FunctionSchema } from "@pipedog/core/adapters/schemas/function_schema";
import { ToolsSchema } from "@pipedog/core/adapters/schemas/tools_schema";
import {
  InputAudioRawFrame,
  LLMServiceMetadataFrame,
  LLMSetToolsFrame,
} from "@pipedog/core/frames/frames";
import { LLMContext } from "@pipedog/core/processors/aggregators/llm_context";
import { ConnectionClosedError } from "@pipedog/core/services/websocket_service";
import { runTest } from "@pipedog/core/tests/utils";
import { logger } from "@pipedog/core/utils/logger";

import * as events from "../src/voice_live/events.ts";
import {
  AzureVoiceLiveLLMService,
  type AzureVoiceLiveLLMServiceOptions,
} from "../src/voice_live/llm.ts";

// The protected members these tests reach into, as upstream does.
type Internals = any;

function _service(options: Partial<AzureVoiceLiveLLMServiceOptions> = {}): Internals {
  return new AzureVoiceLiveLLMService({
    apiKey: "test-key",
    endpoint: "https://my-resource.services.ai.azure.com",
    ...options,
  });
}

/** Capture WARNING-and-above messages while `fn` runs. */
async function _captureWarnings(fn: () => unknown): Promise<string> {
  let sink = "";
  const remove = logger.addSink((record) => {
    if (["WARNING", "ERROR", "CRITICAL"].includes(record.level)) {
      sink += `${record.message}\n`;
    }
  });
  try {
    await fn();
  } finally {
    remove();
  }
  return sink;
}

async function _noop(..._args: unknown[]): Promise<void> {}

const ENDPOINTS: [string, string][] = [
  [
    "https://my-resource.services.ai.azure.com",
    "wss://my-resource.services.ai.azure.com/voice-live/realtime",
  ],
  [
    "https://my-resource.services.ai.azure.com/",
    "wss://my-resource.services.ai.azure.com/voice-live/realtime",
  ],
  [
    "wss://my-resource.services.ai.azure.com/voice-live/realtime",
    "wss://my-resource.services.ai.azure.com/voice-live/realtime",
  ],
  [
    "my-resource.services.ai.azure.com",
    "wss://my-resource.services.ai.azure.com/voice-live/realtime",
  ],
  [
    "https://my-resource.cognitiveservices.azure.com",
    "wss://my-resource.cognitiveservices.azure.com/voice-live/realtime",
  ],
  [
    "ws://my-resource.services.ai.azure.com",
    "wss://my-resource.services.ai.azure.com/voice-live/realtime",
  ],
  [
    "HTTPS://my-resource.services.ai.azure.com",
    "wss://my-resource.services.ai.azure.com/voice-live/realtime",
  ],
  [
    "WSS://my-resource.services.ai.azure.com/voice-live/realtime",
    "wss://my-resource.services.ai.azure.com/voice-live/realtime",
  ],
];

test.each(ENDPOINTS)("test_endpoint_is_normalized_to_a_websocket_url[%s]", (endpoint, expected) => {
  // The portal shows an https resource endpoint, not the realtime URL.
  expect(_service({ endpoint }).baseUrl).toBe(expected);
});

test("test_credentials_are_required", () => {
  expect(
    () => new AzureVoiceLiveLLMService({ endpoint: "https://my-resource.services.ai.azure.com" }),
  ).toThrow(Error);
});

test("test_token_provider_is_accepted_without_an_api_key", () => {
  const provider = async () => "token";

  const service = new AzureVoiceLiveLLMService({
    endpoint: "https://my-resource.services.ai.azure.com",
    tokenProvider: provider,
  });

  expect(service.apiKey).toBeNull();
});

test("test_the_default_session_speaks_with_an_azure_voice", () => {
  const service = _service();

  expect(service._settings.model).toBe("gpt-4o-mini");
  const voice = service._settings.sessionProperties.voice;
  expect(voice).toBeInstanceOf(events.AzureStandardVoice);
  expect(voice.name).toBe("en-US-Ava:DragonHDLatestNeural");
});

test("test_azure_realtime_is_left_to_pick_its_own_voice", () => {
  // `azure-realtime` rejects Azure standard voices and picks a native one when none is sent.
  const service = _service({
    settings: new AzureVoiceLiveLLMService.Settings({ model: "azure-realtime" }),
  });

  expect(service._settings.sessionProperties.voice).toBeNull();
});

const MANUAL_CASES: [string, events.SessionPropertiesOptions, boolean][] = [
  ["unset", {}, false],
  ["none", { turnDetection: null }, true],
  ["false", { turnDetection: false }, true],
  [
    "configured",
    { turnDetection: new events.TurnDetection({ type: "azure_semantic_vad" }) },
    false,
  ],
];

test.each(MANUAL_CASES)(
  "test_manual_mode_matches_what_the_session_update_sends[%s]",
  (_id, sessionOptions, manual) => {
    // The service and the wire have to agree on who is detecting turns.
    //
    // An unset `turn_detection` is omitted from the session update, leaving
    // Voice Live's own VAD running, so it is not manual mode.
    const service = _service({
      settings: new AzureVoiceLiveLLMService.Settings({
        sessionProperties: new events.SessionProperties(sessionOptions),
      }),
    });
    const session = service._settings.sessionProperties;
    const dump = new events.SessionUpdateEvent({ session: session.modelCopy() }).modelDump({
      excludeNone: true,
    });
    const wireDisablesDetection = "turn_detection" in dump.session && !dump.session.turn_detection;

    expect(service._isManualTurnDetection()).toBe(manual);
    expect(wireDisablesDetection).toBe(manual);
  },
);

test("test_a_model_update_is_reported_as_unsupported", async () => {
  // The model is fixed by the connection URL, so an update can't take effect.
  const service = _service();
  const sent: unknown[] = [];

  service.sendClientEvent = async (event: unknown) => {
    sent.push(event);
  };

  const sink = await _captureWarnings(() =>
    service._updateSettings(
      AzureVoiceLiveLLMService.Settings.fromMapping({ model: "gpt-realtime" }),
    ),
  );

  expect(sink).toContain("model");
  expect(sent).toEqual([]);
});

const MODALITY_CASES: [string, events.Modality[], boolean][] = [
  ["audio", ["text", "audio"], true],
  ["text-only", ["text"], false],
];

test.each(MODALITY_CASES)(
  "test_a_text_only_session_update_leaves_out_the_voice[%s]",
  async (_id, modalities, sendsVoice) => {
    // Voice Live rejects a repeated update naming a voice when audio is off.
    const service = _service();
    service._settings.sessionProperties.modalities = modalities;
    const sent: events.ClientEvent[] = [];

    service.sendClientEvent = async (event: events.ClientEvent) => {
      sent.push(event);
    };

    await service._sendSessionUpdate();

    expect("voice" in sent[0]!.modelDump({ excludeNone: true }).session).toBe(sendsVoice);
    expect(service._settings.sessionProperties.voice).not.toBeNull();
  },
);

test("test_a_model_given_in_settings_selects_the_connection_model", async () => {
  // The connection URL picks the model, so a model set only in settings must reach it.
  const uris: string[] = [];

  const service = _service({
    settings: new AzureVoiceLiveLLMService.Settings({ model: "gpt-realtime" }),
  });
  service._websocketConnect = async (uri: string) => {
    uris.push(uri);
    throw new Error("no network in tests");
  };
  service.pushError = _noop;

  await service._connect();

  expect(uris[0]).toContain("model=gpt-realtime");
});

const OUTPUT_RATE_CASES: [number, string][] = [
  [8000, "pcm16_8000hz"],
  [16000, "pcm16_16000hz"],
  [24000, "pcm16"],
];

test.each(OUTPUT_RATE_CASES)(
  "test_output_sample_rate_selects_the_matching_format[%d]",
  (outputRate, expectedFormat) => {
    // Voice Live picks the output rate through the format, not a rate field.
    const service = _service();

    service._ensureAudioConfig(16000, outputRate);

    expect(service._settings.sessionProperties.outputAudioFormat).toBe(expectedFormat);
    expect(service._getOutputSampleRate()).toBe(outputRate);
  },
);

test("test_a_g711_output_format_is_replaced_with_a_warning", async () => {
  // Output frames carry PCM, so the transport's rate decides the format.
  const service = _service({
    settings: new AzureVoiceLiveLLMService.Settings({
      sessionProperties: new events.SessionProperties({ outputAudioFormat: "g711_ulaw" }),
    }),
  });

  const sink = await _captureWarnings(() => service._ensureAudioConfig(8000, 8000));

  expect(sink).toContain("g711_ulaw");
  expect(service._settings.sessionProperties.outputAudioFormat).toBe("pcm16_8000hz");
});

test("test_unsupported_output_sample_rate_falls_back_to_24khz", () => {
  const service = _service();

  service._ensureAudioConfig(16000, 44100);

  expect(service._settings.sessionProperties.outputAudioFormat).toBe("pcm16");
  expect(service._getOutputSampleRate()).toBe(24000);
});

test("test_input_sample_rate_is_sent_as_configured", () => {
  const service = _service();

  service._ensureAudioConfig(8000, 24000);

  expect(service._settings.sessionProperties.inputAudioFormat).toBe("pcm16");
  expect(service._settings.sessionProperties.inputAudioSamplingRate).toBe(8000);
});

test("test_a_g711_input_format_is_replaced_with_a_warning", async () => {
  // Input frames carry PCM, whatever format the session properties name.
  const service = _service({
    settings: new AzureVoiceLiveLLMService.Settings({
      sessionProperties: new events.SessionProperties({
        inputAudioFormat: "g711_ulaw",
        inputAudioTranscription: null,
      }),
    }),
  });

  const sink = await _captureWarnings(() => service._ensureAudioConfig(8000, 8000));

  expect(sink).toContain("g711_ulaw");
  expect(service._settings.sessionProperties.inputAudioFormat).toBe("pcm16");
});

const TRANSCRIPTION_CASES: [string, (() => events.SessionProperties) | null, boolean][] = [
  ["defaults", null, false],
  [
    "left-out",
    () =>
      new events.SessionProperties({
        voice: new events.AzureStandardVoice({ name: "en-US-Andrew" }),
      }),
    true,
  ],
  [
    "explicitly-disabled",
    () => new events.SessionProperties({ inputAudioTranscription: null }),
    false,
  ],
  [
    "configured",
    () =>
      new events.SessionProperties({
        inputAudioTranscription: new events.InputAudioTranscription({ model: "azure-speech" }),
      }),
    false,
  ],
];

test.each(TRANSCRIPTION_CASES)(
  "test_session_properties_without_transcription_warn[%s]",
  async (_id, sessionProperties, warns) => {
    // The caller's turns reach the context only as transcripts.
    const settings =
      sessionProperties !== null
        ? new AzureVoiceLiveLLMService.Settings({ sessionProperties: sessionProperties() })
        : null;

    const sink = await _captureWarnings(() => _service({ settings }));

    expect(sink.includes("input_audio_transcription")).toBe(warns);
  },
);

test("test_a_session_update_without_transcription_warns", async () => {
  const service = _service();

  service.sendClientEvent = _noop;

  const sink = await _captureWarnings(() =>
    service._updateSettings(
      new AzureVoiceLiveLLMService.Settings({
        sessionProperties: new events.SessionProperties({ modalities: ["text", "audio"] }),
      }),
    ),
  );

  expect(sink).toContain("input_audio_transcription");
});

test("test_settings_from_mapping_routes_session_keys", () => {
  // Plain dicts of session keys land in session_properties, not extra.
  const settings: Internals = AzureVoiceLiveLLMService.Settings.fromMapping({
    model: "gpt-realtime",
    temperature: 0.7,
    modalities: ["audio"],
  });

  expect(settings.model).toBe("gpt-realtime");
  expect(settings.sessionProperties.modalities).toEqual(["audio"]);
  expect(Object.keys(settings.extra).length).toBe(0);
});

test("test_a_failed_disconnect_still_clears_the_disconnecting_flag", async () => {
  // Sends are dropped while the flag is set, so a stuck flag mutes the service.
  const service = _service();
  service.pushError = _noop;

  service._websocket = {
    async close() {
      throw new Error("close failed");
    },
  };
  await service._disconnect();

  expect(service._disconnecting).toBe(false);
});

/** A connection whose event stream has ended, optionally with an error. */
class _EndedWebSocket {
  private readonly _error: Error | null;

  constructor(error: Error | null = null) {
    this._error = error;
  }

  [Symbol.asyncIterator](): AsyncIterator<string> {
    return {
      next: async () => {
        if (this._error) {
          throw this._error;
        }
        return { done: true, value: undefined };
      },
    };
  }

  async send(_message: string): Promise<void> {
    throw new ConnectionClosedError(null, "");
  }
}

function _recordErrors(service: Internals): boolean[] {
  const reported: boolean[] = [];

  service.pushError = async (
    _errorMsg: string,
    options: { forceTreatAsPermanent?: boolean } = {},
  ) => {
    reported.push(options.forceTreatAsPermanent ?? false);
  };
  return reported;
}

const CLOSE_CASES: [string, () => Error | null][] = [
  ["clean-close", () => null],
  ["error-close", () => new ConnectionClosedError(null, "")],
];

test.each(CLOSE_CASES)(
  "test_a_lost_connection_is_reported_once_as_permanent[%s]",
  async (_id, error) => {
    // Without its connection the service can't respond; the unusable policy decides next.
    const service = _service();
    const reported = _recordErrors(service);
    service._websocket = new _EndedWebSocket(error());

    await service._runReceiveLoop();
    await service.sendClientEvent(new events.InputAudioBufferClearEvent());

    expect(reported).toEqual([true]);
    expect(service._websocket).toBeNull();
  },
);

test("test_a_failed_connect_is_reported_as_permanent", async () => {
  // Without a connection the service can't respond; the unusable policy decides next.
  const service = _service();
  service._websocketConnect = async () => {
    throw new TimeoutError("timed out during opening handshake");
  };
  const reported = _recordErrors(service);

  await service._connect();

  expect(reported).toEqual([true]);
  expect(service._websocket).toBeNull();
});

test("test_closing_the_connection_itself_reports_nothing", async () => {
  const service = _service();
  const reported = _recordErrors(service);
  service._websocket = new _EndedWebSocket();
  service._disconnecting = true;

  await service._runReceiveLoop();

  expect(reported).toEqual([]);
});

test("test_sending_on_a_closed_connection_reports_nothing", async () => {
  // The receive loop reports the lost connection; each send would report it again.
  const service = _service();
  const reported = _recordErrors(service);
  service._websocket = new _EndedWebSocket();

  await service.sendClientEvent(new events.InputAudioBufferClearEvent());

  expect(reported).toEqual([]);
});

test("test_reset_conversation_before_any_context_is_a_no_op", async () => {
  const service = _service();
  const reconnected: boolean[] = [];
  service._connect = async () => {
    reconnected.push(true);
  };
  service._disconnect = _noop;

  await service.resetConversation();

  expect(reconnected).toEqual([]);
});

test("test_reset_conversation_sends_the_history_to_the_new_session", async () => {
  // Conversation setup only runs when _handle_context has no context yet.
  const service = _service();
  service._connect = _noop;
  service._disconnect = _noop;
  service._apiSessionReady = true;

  const created: string[] = [];
  service.sendClientEvent = async (e: events.ClientEvent) => {
    created.push(e.constructor.name);
  };

  const context = new LLMContext({ messages: [{ role: "user", content: "remember this" }] });
  await service._handleContext(context);
  service._llmNeedsConversationSetup = false;
  // The first response finishes before the reset.
  service._responseInFlight = false;
  created.length = 0;

  await service.resetConversation();

  expect(service._llmNeedsConversationSetup).toBe(false);
  expect(created).toContain("ConversationItemCreateEvent");
});

test("test_session_properties_in_an_update_set_the_top_level_fields", () => {
  // `session_properties` replaces the stored one, and its values reach the top level.
  const service = _service();
  const settings = service._settings;

  const changed = settings.applyUpdate(
    new AzureVoiceLiveLLMService.Settings({
      sessionProperties: new events.SessionProperties({
        model: "gpt-realtime",
        instructions: "Be brief.",
      }),
    }),
  );

  expect(settings.model).toBe("gpt-realtime");
  expect(settings.systemInstruction).toBe("Be brief.");
  expect(Object.keys(changed)).toEqual(expect.arrayContaining(["model", "systemInstruction"]));
});

test("test_top_level_fields_win_over_session_properties_in_the_same_update", () => {
  const service = _service();
  const settings = service._settings;

  settings.applyUpdate(
    new AzureVoiceLiveLLMService.Settings({
      systemInstruction: "Top level.",
      sessionProperties: new events.SessionProperties({ instructions: "Session." }),
    }),
  );

  expect(settings.systemInstruction).toBe("Top level.");
  expect(settings.sessionProperties.instructions).toBe("Top level.");
});

test("test_a_response_asked_for_before_the_session_is_ready_waits_for_it", async () => {
  // Voice Live applies the first session.update before it can answer.
  const service = _service();
  service.startProcessingMetrics = _noop;
  service.startTtfbMetrics = _noop;
  const sent: string[] = [];

  service.sendClientEvent = async (event: events.ClientEvent) => {
    sent.push(event.constructor.name);
  };

  await service._handleContext(new LLMContext({ messages: [{ role: "user", content: "Hello" }] }));
  expect(sent).not.toContain("ResponseCreateEvent");

  await service._handleEvtSessionUpdated(null);

  expect(sent.filter((s) => s === "ResponseCreateEvent").length).toBe(1);
});

test.each([
  ["api-key", false],
  ["token-provider", true],
])(
  "test_connect_authenticates_with_the_configured_credential[%s]",
  async (_id, useTokenProvider) => {
    const headers: unknown[] = [];

    const tokenProvider = async () => "entra-token";

    let service: Internals;
    if (useTokenProvider) {
      service = new AzureVoiceLiveLLMService({
        endpoint: "https://my-resource.services.ai.azure.com",
        tokenProvider,
      });
    } else {
      service = _service();
    }
    service._websocketConnect = async (
      _uri: string,
      options: { additionalHeaders?: Record<string, string> },
    ) => {
      headers.push(options.additionalHeaders);
      throw new Error("no network in tests");
    };
    service.pushError = _noop;

    await service._connect();

    if (useTokenProvider) {
      expect(headers).toEqual([{ Authorization: "Bearer entra-token" }]);
    } else {
      expect(headers).toEqual([{ "api-key": "test-key" }]);
    }
  },
);

test("test_frames_reach_voice_live_and_pass_through", async () => {
  // Audio is streamed and a tools update is sent as a session update; every frame
  // continues downstream.
  const service = _service();
  service._connect = _noop;
  service._disconnect = _noop;
  service._llmNeedsConversationSetup = false;
  const sent: string[] = [];

  service.sendClientEvent = async (event: events.ClientEvent) => {
    sent.push(event.constructor.name);
  };

  const tools = new ToolsSchema({
    standardTools: [
      new FunctionSchema({
        name: "get_current_weather",
        description: "Get the weather.",
        properties: {},
        required: [],
      }),
    ],
  });
  const audio = new InputAudioRawFrame({
    audio: new Uint8Array(3200),
    sampleRate: 16000,
    numChannels: 1,
  });

  await runTest(service, {
    framesToSend: [audio, new LLMSetToolsFrame({ tools })],
    expectedDownFrames: [LLMServiceMetadataFrame, InputAudioRawFrame, LLMSetToolsFrame],
  });

  expect(sent).toContain("InputAudioBufferAppendEvent");
  expect(sent).toContain("SessionUpdateEvent");
});
