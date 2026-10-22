// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_assemblyai_sync_stt.py

/**
 * Tests for the AssemblyAI Sync STT service.
 *
 * Porting notes:
 * - aiohttp's `web.Application` test server becomes `Bun.serve` on an
 *   ephemeral port; `aiohttp_session` is not needed (the service uses `fetch`).
 * - Python's `[frame async for frame in service.run_stt(WAV)]` becomes `collect()`.
 */

import { afterEach, describe, expect, test } from "bun:test";
import {
  ErrorFrame,
  type Frame,
  StartFrame,
  TranscriptionFrame,
  VADUserStartedSpeakingFrame,
} from "@pipedog/core/frames/frames";
import { ASSEMBLYAI_SYNC_TTFS_P99 } from "@pipedog/core/services/stt_latency";
import { Language } from "@pipedog/core/transcriptions/language";
import { ErrorCategory } from "@pipedog/core/utils/errors";
import { AssemblyAISyncSTTService } from "../src/stt.ts";

type Dict = Record<string, any>;

const WAV = new TextEncoder().encode("RIFF....WAVEfmt ");

const servers: ReturnType<typeof Bun.serve>[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.stop(true);
});

interface Captured {
  headers?: Record<string, string>;
  parts?: Record<string, string | Uint8Array>;
  audioType?: string;
  audioFilename?: string;
  warmHeaders?: Record<string, string>;
  raw?: string;
}

/** A server serving /v1/transcribe and /v1/warm, recording what each request carried. */
function _app(
  captured: Captured,
  options: { status?: number; body?: Dict; warmStatus?: number } = {},
): string {
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/v1/warm") {
        captured.warmHeaders = Object.fromEntries(request.headers.entries());
        return Response.json({ warm: "toasty" }, { status: options.warmStatus ?? 200 });
      }
      if (url.pathname === "/v1/transcribe" && request.method === "POST") {
        captured.headers = Object.fromEntries(request.headers.entries());
        captured.parts = {};
        captured.raw = await request.clone().text();
        const form = await request.formData();
        for (const [name, value] of form.entries()) {
          if (name === "audio" && typeof value !== "string") {
            captured.parts.audio = new Uint8Array(await value.arrayBuffer());
            // Bun normalizes the part's type to audio/x-wav when parsing; the raw body is checked too.
            captured.audioType = captured.raw?.match(
              /name="audio".*?\r\nContent-Type: ([^\r]+)/s,
            )?.[1];
            captured.audioFilename = value.name;
          } else if (typeof value === "string") {
            captured.parts[name] = value;
          } else {
            captured.parts[name] = await value.text();
          }
        }
        return Response.json(options.body ?? { text: "Hello there", words: [] }, {
          status: options.status ?? 200,
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
  servers.push(server);
  return `http://localhost:${server.port}`;
}

function _service(
  baseUrl: string,
  options: Partial<ConstructorParameters<typeof AssemblyAISyncSTTService>[0]> = {},
): AssemblyAISyncSTTService {
  return new AssemblyAISyncSTTService({ apiKey: "test-key", baseUrl, ...options });
}

function _bare(
  options: Partial<ConstructorParameters<typeof AssemblyAISyncSTTService>[0]> = {},
): AssemblyAISyncSTTService {
  return new AssemblyAISyncSTTService({ apiKey: "k", ...options });
}

function _config(captured: Captured): Dict {
  return JSON.parse(captured.parts?.config as string);
}

async function collect(gen: AsyncGenerator<Frame | null, void, unknown>): Promise<Frame[]> {
  const out: Frame[] = [];
  for await (const frame of gen) {
    if (frame !== null) out.push(frame);
  }
  return out;
}

/**
 * Run a segment and return the reported error.
 *
 * Errors are classified as the base class pushes them, not as `runStt` yields
 * them, so a test reading `category` or `isUsable` has to go through
 * `processGenerator` the way the pipeline does.
 */
async function _runAndReport(service: AssemblyAISyncSTTService): Promise<ErrorFrame> {
  const pushed: Frame[] = [];
  (service as any).pushFrame = async (frame: Frame) => {
    pushed.push(frame);
  };
  await service.processGenerator(service.runStt(WAV));
  return pushed.at(-1) as ErrorFrame;
}

//
// Settings
//

describe("Settings", () => {
  test("test_defaults_use_the_sync_model_and_english", () => {
    const service = _bare();

    expect((service as any)._settings.model).toBe("universal-3-6-pro");
    // The base class converts the Language enum to AssemblyAI's code at init.
    expect((service as any)._settings.language).toBe("en");
  });

  test("test_ttfs_latency_defaults_to_the_service_constant", () => {
    const service = _bare();

    expect((service as any)._ttfsP99Latency).toBe(ASSEMBLYAI_SYNC_TTFS_P99);
  });

  test("test_language_converts_to_the_assemblyai_code", () => {
    const service = _bare();

    expect(service.languageToServiceLanguage(Language.ES_US)).toBe("es");
  });
});

//
// Request construction
//

describe("Request construction", () => {
  test("test_transcribe_posts_the_audio_and_config_parts", async () => {
    const captured: Captured = {};
    const service = _service(_app(captured));

    const result = await (service as any)._transcribe(WAV);

    expect(result.text).toBe("Hello there");
    expect(captured.headers?.authorization).toBe("test-key");
    expect(captured.headers?.["x-aai-model"]).toBe("universal-3-6-pro");
    expect(captured.parts?.audio).toEqual(WAV);
    expect(captured.audioType).toBe("audio/wav");
    expect(captured.audioFilename).toBe("audio.wav");
    expect(_config(captured)).toEqual({ language_codes: ["en"] });
  });

  test("test_an_explicit_model_routes_the_request", async () => {
    const captured: Captured = {};
    const service = _service(_app(captured), {
      settings: new AssemblyAISyncSTTService.Settings({ model: "universal-3-5-pro" }),
    });

    await (service as any)._transcribe(WAV);

    expect(captured.headers?.["x-aai-model"]).toBe("universal-3-5-pro");
  });

  test("test_config_carries_prompt_and_keyterms", async () => {
    const captured: Captured = {};
    const service = _service(_app(captured), {
      settings: new AssemblyAISyncSTTService.Settings({
        prompt: "Transcribe this call.",
        keytermsPrompt: ["Pipecat", "AssemblyAI"],
      }),
    });

    await (service as any)._transcribe(WAV);

    const config = _config(captured);
    expect(config.prompt).toBe("Transcribe this call.");
    expect(config.keyterms_prompt).toEqual(["Pipecat", "AssemblyAI"]);
  });

  test("test_config_carries_declared_language_codes", async () => {
    const captured: Captured = {};
    const service = _service(_app(captured), {
      settings: new AssemblyAISyncSTTService.Settings({
        languageCodes: [Language.EN, Language.ES],
      }),
    });

    await (service as any)._transcribe(WAV);

    expect(_config(captured).language_codes).toEqual(["en", "es"]);
  });

  test("test_language_codes_resolve_to_base_codes_deduped_in_order", async () => {
    const captured: Captured = {};
    const service = _service(_app(captured), {
      settings: new AssemblyAISyncSTTService.Settings({
        languageCodes: [Language.ES_MX, Language.EN_US, Language.ES],
      }),
    });

    await (service as any)._transcribe(WAV);

    expect(_config(captured).language_codes).toEqual(["es", "en"]);
  });

  test("test_language_codes_are_not_capped", async () => {
    // The Sync API sets no limit, unlike the streaming API's ten.
    const captured: Captured = {};
    const declared = [
      Language.EN,
      Language.ES,
      Language.FR,
      Language.DE,
      Language.IT,
      Language.PT,
      Language.NL,
      Language.SV,
      Language.DA,
      Language.FI,
      Language.HI,
      Language.JA,
    ];
    const service = _service(_app(captured), {
      settings: new AssemblyAISyncSTTService.Settings({ languageCodes: declared }),
    });

    await (service as any)._transcribe(WAV);

    expect(_config(captured).language_codes.length).toBe(declared.length);
  });

  test("test_language_codes_win_over_the_single_language", async () => {
    const captured: Captured = {};
    const service = _service(_app(captured), {
      settings: new AssemblyAISyncSTTService.Settings({
        language: Language.FR,
        languageCodes: [Language.EN, Language.ES],
      }),
    });

    await (service as any)._transcribe(WAV);

    expect(_config(captured).language_codes).toEqual(["en", "es"]);
  });

  test("test_the_single_language_is_used_when_no_codes_are_declared", async () => {
    const captured: Captured = {};
    const service = _service(_app(captured), {
      settings: new AssemblyAISyncSTTService.Settings({
        language: Language.FR,
        languageCodes: [],
      }),
    });

    await (service as any)._transcribe(WAV);

    expect(_config(captured).language_codes).toEqual(["fr"]);
  });

  test("test_config_carries_timestamps_when_requested", async () => {
    const captured: Captured = {};
    const service = _service(_app(captured), {
      settings: new AssemblyAISyncSTTService.Settings({ timestamps: true }),
    });

    await (service as any)._transcribe(WAV);

    expect(_config(captured).timestamps).toBe(true);
  });

  test("test_timestamps_are_omitted_by_default", async () => {
    const captured: Captured = {};
    const service = _service(_app(captured));

    await (service as any)._transcribe(WAV);

    expect("timestamps" in _config(captured)).toBe(false);
  });

  test("test_config_part_is_omitted_when_nothing_applies", async () => {
    const captured: Captured = {};
    const service = _service(_app(captured), {
      settings: new AssemblyAISyncSTTService.Settings({ language: null }),
    });

    await (service as any)._transcribe(WAV);

    expect("config" in (captured.parts as Dict)).toBe(false);
  });
});

//
// Transcription
//

describe("Transcription", () => {
  test("test_run_stt_yields_a_transcription_frame", async () => {
    const captured: Captured = {};
    const service = _service(_app(captured));

    const frames = await collect(service.runStt(WAV));

    expect(frames.length).toBe(1);
    expect(frames[0]).toBeInstanceOf(TranscriptionFrame);
    const frame = frames[0] as TranscriptionFrame;
    expect(frame.text).toBe("Hello there");
    expect(frame.language).toBe("en");
    expect(frame.result).toEqual({ text: "Hello there", words: [] });
  });

  test("test_run_stt_yields_nothing_for_an_empty_transcript", async () => {
    const captured: Captured = {};
    const service = _service(_app(captured, { body: { text: "   ", words: [] } }));

    const frames = await collect(service.runStt(WAV));

    expect(frames).toEqual([]);
  });

  test("test_run_stt_yields_an_error_frame_on_a_problem_details_body", async () => {
    const captured: Captured = {};
    const service = _service(
      _app(captured, {
        status: 400,
        body: { status: 400, title: "Bad Request", detail: "invalid config part" },
      }),
    );

    const frames = await collect(service.runStt(WAV));

    expect(frames.length).toBe(1);
    expect(frames[0]).toBeInstanceOf(ErrorFrame);
    expect((frames[0] as ErrorFrame).error).toContain("Bad Request - invalid config part");
  });

  test("test_run_stt_names_the_error_code_and_message", async () => {
    const captured: Captured = {};
    const service = _service(
      _app(captured, {
        status: 413,
        body: { error_code: "audio_too_large", message: "audio exceeds 120 seconds" },
      }),
    );

    const frames = await collect(service.runStt(WAV));

    expect(frames[0]).toBeInstanceOf(ErrorFrame);
    expect((frames[0] as ErrorFrame).error).toContain("audio_too_large");
    expect((frames[0] as ErrorFrame).error).toContain("audio exceeds 120 seconds");
  });

  test("test_a_rejected_key_leaves_the_service_unusable", async () => {
    const captured: Captured = {};
    const service = _service(
      _app(captured, { status: 401, body: { status: 401, detail: "Invalid API key" } }),
    );

    const error = await _runAndReport(service);

    expect(error.category).toBe(ErrorCategory.AUTHENTICATION);
    // A key stays rejected, so the base class stops handing the service work.
    expect(service.isUsable).toBe(false);
  });

  test("test_a_server_error_leaves_the_service_usable", async () => {
    const captured: Captured = {};
    const service = _service(
      _app(captured, { status: 503, body: { error_code: "service_unavailable" } }),
    );

    const error = await _runAndReport(service);

    expect(error.category).toBe(ErrorCategory.SERVER);
    expect(service.isUsable).toBe(true);
  });

  test("test_an_oversized_segment_leaves_the_service_usable", async () => {
    const captured: Captured = {};
    const service = _service(
      _app(captured, { status: 413, body: { error_code: "audio_too_large" } }),
    );

    await _runAndReport(service);

    // One segment too long says nothing about the next one.
    expect(service.isUsable).toBe(true);
  });
});

//
// Conversation context
//

describe("Conversation context", () => {
  test("test_a_turn_is_absent_from_its_own_request_and_present_in_the_next", async () => {
    const captured: Captured = {};
    const service = _service(_app(captured));

    await collect(service.runStt(WAV));
    expect("conversation_context" in _config(captured)).toBe(false);

    await collect(service.runStt(WAV));

    expect(_config(captured).conversation_context).toEqual(["Hello there"]);
  });

  test("test_agent_replies_share_the_buffer_in_the_order_spoken", async () => {
    const captured: Captured = {};
    const service = _service(_app(captured));

    await collect(service.runStt(WAV));
    await (service as any)._processAssistantTurn("How can I help?");
    await collect(service.runStt(WAV));

    expect(_config(captured).conversation_context).toEqual(["Hello there", "How can I help?"]);
  });

  test("test_context_evicts_the_oldest_turn_past_the_turn_cap", () => {
    const service = _bare({ maxContextTurns: 2 });

    for (const turn of ["one", "two", "three"]) {
      (service as any)._appendContextTurn(turn);
    }

    expect((service as any)._contextTurns).toEqual(["two", "three"]);
  });

  test("test_context_evicts_the_oldest_turn_past_the_char_cap", () => {
    const service = _bare({ maxContextChars: 10 });

    (service as any)._appendContextTurn("aaaaa");
    (service as any)._appendContextTurn("bbbbb");
    (service as any)._appendContextTurn("ccccc");

    // Eviction stops as soon as the buffer is back within budget.
    expect((service as any)._contextTurns).toEqual(["bbbbb", "ccccc"]);
  });

  test("test_a_turn_longer_than_the_char_cap_is_kept_alone", () => {
    const service = _bare({ maxContextChars: 10 });

    (service as any)._appendContextTurn("aaaaa");
    (service as any)._appendContextTurn("b".repeat(40));

    expect((service as any)._contextTurns).toEqual(["b".repeat(40)]);
  });

  test("test_blank_turns_are_not_buffered", () => {
    const service = _bare();

    (service as any)._appendContextTurn("   ");

    expect((service as any)._contextTurns).toEqual([]);
  });

  test("test_zero_max_context_turns_disables_the_buffer", async () => {
    const captured: Captured = {};
    const service = _service(_app(captured), { maxContextTurns: 0 });

    await collect(service.runStt(WAV));
    await collect(service.runStt(WAV));

    expect((service as any)._contextTurns).toEqual([]);
    expect("conversation_context" in _config(captured)).toBe(false);
  });

  test("test_an_explicit_context_is_sent_as_is_and_stops_buffering", async () => {
    const captured: Captured = {};
    const service = _service(_app(captured), {
      settings: new AssemblyAISyncSTTService.Settings({
        conversationContext: ["Booking a flight to Lisbon."],
      }),
    });

    await collect(service.runStt(WAV));
    await collect(service.runStt(WAV));

    expect(_config(captured).conversation_context).toEqual(["Booking a flight to Lisbon."]);
    expect((service as any)._contextTurns).toEqual([]);
  });
});

//
// Pre-warming
//

describe("Pre-warming", () => {
  test("test_warm_gets_the_warm_path_with_the_model_and_no_auth", async () => {
    const captured: Captured = {};
    const service = _service(_app(captured));

    await service.warm();

    expect(captured.warmHeaders?.["x-aai-model"]).toBe("universal-3-6-pro");
    expect("authorization" in (captured.warmHeaders as Dict)).toBe(false);
  });

  test("test_a_failed_warm_is_swallowed", async () => {
    const captured: Captured = {};
    const service = _service(_app(captured, { warmStatus: 500 }));

    // A failed warm only forfeits the latency saving; it must not raise.
    await service.warm();
  });

  test("test_speech_start_schedules_a_warm", async () => {
    const service = _bare();
    const scheduled: unknown[] = [];

    (service as any).createTask = (fn: unknown) => {
      scheduled.push(fn);
      return null;
    };

    await (service as any)._handleUserStartedSpeaking(new VADUserStartedSpeakingFrame());

    expect(scheduled.length).toBe(1);
  });

  test("test_speech_start_schedules_no_warm_when_pre_warming_is_off", async () => {
    const service = _bare({ enablePrewarming: false });
    const scheduled: unknown[] = [];

    (service as any).createTask = (fn: unknown) => {
      scheduled.push(fn);
      return null;
    };

    await (service as any)._handleUserStartedSpeaking(new VADUserStartedSpeakingFrame());

    expect(scheduled).toEqual([]);
  });

  test("test_cleanup_cancels_a_pending_warm", async () => {
    const service = _bare();
    const cancelled: unknown[] = [];

    const pending = { done: () => false };
    (service as any)._warmTask = pending;
    (service as any).cancelTask = async (task: unknown) => {
      cancelled.push(task);
    };

    await service.cleanup();

    expect(cancelled.length).toBe(1);
    expect((service as any)._warmTask).toBeNull();
  });

  test("test_a_new_run_starts_on_an_empty_conversation_context", async () => {
    const service = _bare();
    (service as any)._appendContextTurn("Booking a flight to Lisbon.");
    // start() also creates the segment transcription task; this bare service has
    // no task manager, so stand in for it.
    (service as any).createTask = () => null;

    await service.start(new StartFrame());

    expect((service as any)._contextTurns).toEqual([]);
  });
});
