// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/**
 * pipedog-only behaviour of GeminiSTTService (no upstream test): Vertex AI
 * mode, the client created on first connect, `reportDetectedLanguage`,
 * `setLanguageCodes()`, and connecting in the background on StartFrame
 * (`awaitConnectionOnStart`). Live sessions run against the local fake
 * Gemini server from `google_fakes.ts`.
 */

import { afterEach, describe, expect, test } from "bun:test";
import type { GoogleGenAI } from "@google/genai";
import {
  BotStartedSpeakingFrame,
  ErrorFrame,
  type Frame,
  InputAudioRawFrame,
  StartFrame,
  TranscriptionFrame,
  UserStoppedSpeakingFrame,
  VADUserStartedSpeakingFrame,
  VADUserStoppedSpeakingFrame,
} from "@pipedog/core/frames/frames";
import { FrameDirection } from "@pipedog/core/processors/frame_processor";
import { runTest, SleepFrame } from "@pipedog/core/tests/utils";
import { Language } from "@pipedog/core/transcriptions/language";
import {
  GeminiSTTService,
  type GeminiSTTServiceOptions,
  GeminiSTTSettings,
} from "../src/gemini_live/stt.ts";
import { type FakeGenaiServer, type LiveSocket, startFakeGenaiServer } from "./google_fakes.ts";

type Internals = any;

const AUDIO = Uint8Array.from({ length: 320 }, (_, i) => i & 0xff);
const audioFrame = () =>
  new InputAudioRawFrame({ audio: AUDIO, sampleRate: 16000, numChannels: 1 });

let server: FakeGenaiServer | null = null;
afterEach(async () => {
  await server?.stop();
  server = null;
});

/** Answer each audio chunk with a final transcription. */
function transcriber(languageCode = "en-US") {
  return (m: Record<string, any>, socket: LiveSocket) => {
    if (m.realtimeInput?.audio) {
      socket.send({
        serverContent: { inputTranscription: { text: "hello", finished: true, languageCode } },
      });
    }
  };
}

const finals = (frames: Frame[]) =>
  frames.filter((f) => f instanceof TranscriptionFrame) as TranscriptionFrame[];

const setups = (s: FakeGenaiServer) =>
  s.sessions.map((session) => session.messages[0]?.setup?.inputAudioTranscription);

describe("GeminiSTTService Vertex AI mode", () => {
  const vertex = (extra: Partial<GeminiSTTServiceOptions> = {}): Internals =>
    new GeminiSTTService({ vertexai: true, projectId: "my-project", location: "eu", ...extra });

  test("language codes go in languageCodes, never languageAuto or languageHints", () => {
    const stt = vertex({
      settings: new GeminiSTTSettings({ languages: [Language.ES_ES, Language.EN_US] }),
    });
    expect(stt._buildLiveConfig().inputAudioTranscription).toEqual({
      languageCodes: ["es-ES", "en-US"],
    });
  });

  test("no codes is an empty transcription config (automatic detection)", () => {
    expect(vertex()._buildLiveConfig().inputAudioTranscription).toEqual({});
    const noAuto = vertex({ settings: new GeminiSTTSettings({ languageAuto: false }) });
    expect(noAuto._buildLiveConfig().inputAudioTranscription).toEqual({});
  });

  test("adaptation phrases and mode are still sent", () => {
    const stt = vertex({
      settings: new GeminiSTTSettings({
        language: "fr-FR",
        adaptationPhrases: ["oatmilk"],
        mode: "SMART",
      }),
    });
    expect(stt._buildLiveConfig().inputAudioTranscription).toEqual({
      languageCodes: ["fr-FR"],
      adaptationPhrases: ["oatmilk"],
      mode: "SMART",
    });
  });

  test("the client is a Vertex AI client for the project and location", () => {
    const stt = vertex();
    // Created on first connect, not in the constructor.
    expect(stt._client).toBeNull();
    const client = stt._getClient() as GoogleGenAI & Internals;
    expect(client.vertexai).toBe(true);
    expect(client.project).toBe("my-project");
    expect(client.location).toBe("eu");
    expect(stt._getClient()).toBe(client);
  });

  test("credentials are resolved like the Vertex LLM services", () => {
    const credentials = JSON.stringify({ type: "service_account", project_id: "p" });
    expect(vertex({ credentials })._credentials).toEqual({
      credentials: { type: "service_account", project_id: "p" },
      scopes: ["https://www.googleapis.com/auth/cloud-platform"],
    });
    expect(vertex({ credentialsPath: "/key.json" })._credentials).toEqual({
      keyFilename: "/key.json",
      scopes: ["https://www.googleapis.com/auth/cloud-platform"],
    });
    expect(vertex()._credentials).toEqual({
      scopes: ["https://www.googleapis.com/auth/cloud-platform"],
    });
  });

  test("invalid option combinations are rejected", () => {
    expect(() => vertex({ apiKey: "key" })).toThrow("Invalid parameter 'apiKey'");
    expect(() => new GeminiSTTService({ vertexai: true })).toThrow("requires a 'location'");
    expect(() => new GeminiSTTService({})).toThrow("requires an 'apiKey'");
  });

  test("the Gemini API config is unchanged without vertexai", () => {
    const stt: Internals = new GeminiSTTService({ apiKey: "key" });
    expect(stt._buildLiveConfig().inputAudioTranscription).toEqual({ languageAuto: {} });
  });
});

describe("GeminiSTTService client creation", () => {
  test("a subclass can read its own options in _createClient()", async () => {
    server = startFakeGenaiServer({ onLiveMessage: transcriber() });
    const created: string[] = [];

    class TaggedGeminiSTT extends GeminiSTTService {
      protected readonly _tag: string;

      constructor(options: GeminiSTTServiceOptions & { tag: string }) {
        const { tag, ...rest } = options;
        super(rest);
        this._tag = tag;
      }

      protected override _createClient(): void {
        created.push(this._tag);
        super._createClient();
      }
    }

    const stt = new TaggedGeminiSTT({
      apiKey: "test-key",
      tag: "eu",
      sampleRate: 16000,
      httpOptions: { baseUrl: server.url },
    });
    const [down] = await runTest(stt, {
      framesToSend: [audioFrame(), new SleepFrame({ sleep: 0.2 })],
    });
    expect(created).toEqual(["eu"]);
    expect(finals(down).map((f) => f.text)).toEqual(["hello"]);
  });
});

describe("GeminiSTTService reportDetectedLanguage", () => {
  /** A service whose pushed frames are collected, with no session. */
  function makeService(options: Partial<GeminiSTTServiceOptions>): [Internals, Frame[]] {
    const stt: Internals = new GeminiSTTService({ apiKey: "test", ...options });
    const frames: Frame[] = [];
    stt.pushFrame = async (frame: Frame) => {
      frames.push(frame);
    };
    stt.stopProcessingMetrics = async () => {};
    stt._handleTranscription = async () => {};
    return [stt, frames];
  }

  const message = (languageCode: string) => ({
    serverContent: {
      interimInputTranscription: { text: "hi", languageCode },
      inputTranscription: { text: "hi", finished: true, languageCode },
    },
  });

  test("by default the language the model reports is used", async () => {
    const [stt, frames] = makeService({
      settings: new GeminiSTTSettings({ languages: [Language.ES_ES] }),
    });
    await stt._handleServerMessage(message("en-US"));
    expect(frames.map((f: Internals) => f.language)).toEqual([Language.EN_US, Language.EN_US]);
  });

  test("off: the one configured language is used", async () => {
    const [stt, frames] = makeService({
      reportDetectedLanguage: false,
      settings: new GeminiSTTSettings({ languages: [Language.ES_ES] }),
    });
    await stt._handleServerMessage(message("en-US"));
    expect(frames.map((f: Internals) => f.language)).toEqual([Language.ES_ES, Language.ES_ES]);
  });

  test("off: null with several languages or none configured", async () => {
    for (const languages of [[Language.ES_ES, Language.EN_US], []]) {
      const [stt, frames] = makeService({
        reportDetectedLanguage: false,
        settings: new GeminiSTTSettings({ languages }),
      });
      await stt._handleServerMessage(message("en-US"));
      expect(frames.map((f: Internals) => f.language)).toEqual([null, null]);
    }
  });

  test("off: the codes the session was opened with win over later changes", async () => {
    const [stt, frames] = makeService({ reportDetectedLanguage: false });
    stt._sessionLanguageCodes = ["fr-FR"];
    await stt.setLanguageCodes(["de-DE"]);
    await stt._handleServerMessage(message("en-US"));
    expect(frames.map((f: Internals) => f.language)).toEqual([Language.FR_FR, Language.FR_FR]);
  });
});

describe("GeminiSTTService setLanguageCodes", () => {
  test("codes set before start are used by the first session, with no reconnect", async () => {
    server = startFakeGenaiServer({ onLiveMessage: transcriber() });
    const stt = new GeminiSTTService({
      apiKey: "test-key",
      sampleRate: 16000,
      httpOptions: { baseUrl: server.url },
      settings: new GeminiSTTSettings({ languages: [Language.EN_US] }),
    });
    await stt.setLanguageCodes(["es-ES", "ca-ES"]);
    await runTest(stt, {
      framesToSend: [audioFrame(), new BotStartedSpeakingFrame(), new SleepFrame({ sleep: 0.2 })],
    });
    expect(setups(server)).toEqual([{ languageHints: { languageCodes: ["es-ES", "ca-ES"] } }]);
  });

  test("a change reconnects on BotStartedSpeakingFrame, and later audio goes to the new session", async () => {
    let codes = ["en-US"];
    server = startFakeGenaiServer({
      onLiveMessage: (m, socket) => {
        // The bot switches language after the first utterance.
        if (m.realtimeInput?.audio) codes = ["es-ES"];
        transcriber()(m, socket);
      },
    });
    const stt = new GeminiSTTService({
      apiKey: "test-key",
      sampleRate: 16000,
      httpOptions: { baseUrl: server.url },
    });
    await stt.setLanguageCodes(() => codes);
    const [down, up] = await runTest(stt, {
      framesToSend: [
        audioFrame(),
        new SleepFrame({ sleep: 0.2 }),
        new BotStartedSpeakingFrame(),
        audioFrame(),
        new SleepFrame({ sleep: 0.3 }),
        // Unchanged codes: no further reconnect.
        new BotStartedSpeakingFrame(),
        new SleepFrame({ sleep: 0.1 }),
      ],
    });

    expect(setups(server)).toEqual([
      { languageHints: { languageCodes: ["en-US"] } },
      { languageHints: { languageCodes: ["es-ES"] } },
    ]);
    const [first, second] = server.sessions;
    expect(first!.messages.filter((m) => m.realtimeInput?.audio)).toHaveLength(1);
    // The audio sent while reconnecting was buffered and went to the new session.
    expect(second!.messages.filter((m) => m.realtimeInput?.audio)).toHaveLength(1);
    expect(finals(down)).toHaveLength(2);
    expect(up.filter((f) => f instanceof ErrorFrame)).toEqual([]);
  });

  test("while the user is speaking, the reconnect waits for the end of the turn", async () => {
    let codes = ["en-US"];
    const events: string[] = [];
    server = startFakeGenaiServer({
      onLiveOpen: () => events.push("open"),
      onLiveMessage: (m, socket) => {
        if (m.realtimeInput?.audio) codes = ["es-ES"];
        transcriber()(m, socket);
      },
    });

    class RecordingGeminiSTT extends GeminiSTTService {
      protected override async _maybeReconnectOnUserStoppedSpeaking(): Promise<void> {
        events.push("turn end");
        await super._maybeReconnectOnUserStoppedSpeaking();
      }
    }

    const stt = new RecordingGeminiSTT({
      apiKey: "test-key",
      sampleRate: 16000,
      httpOptions: { baseUrl: server.url },
    });
    await stt.setLanguageCodes(() => codes);
    await runTest(stt, {
      framesToSend: [
        new VADUserStartedSpeakingFrame(),
        audioFrame(),
        new SleepFrame({ sleep: 0.2 }),
        // The bot starts speaking mid-utterance: the codes changed, but the
        // session must not be replaced before the utterance is finalized.
        new BotStartedSpeakingFrame(),
        new SleepFrame({ sleep: 0.2 }),
        new VADUserStoppedSpeakingFrame(),
        new SleepFrame({ sleep: 0.2 }),
        new UserStoppedSpeakingFrame(),
        new SleepFrame({ sleep: 0.3 }),
      ],
    });

    expect(events).toEqual(["open", "turn end", "open"]);
    expect(server.sessions[0]!.messages.at(-1)).toEqual({
      realtimeInput: { audioStreamEnd: true },
    });
    expect(setups(server)[1]).toEqual({ languageHints: { languageCodes: ["es-ES"] } });
  });

  test("updating the language settings replaces codes set with setLanguageCodes", async () => {
    const stt: Internals = new GeminiSTTService({ apiKey: "test" });
    stt._requestReconnect = async () => {};
    await stt.setLanguageCodes(["es-ES"]);
    expect(stt._getLanguageCodes()).toEqual(["es-ES"]);
    await stt._updateSettings(new GeminiSTTSettings({ languages: [Language.FR_FR] }));
    expect(stt._getLanguageCodes()).toEqual(["fr-FR"]);
  });
});

describe("GeminiSTTService connection on start", () => {
  /**
   * A fake server that answers the setup only after `delay` seconds, and a
   * service that logs when its StartFrame goes downstream and when it
   * connects.
   */
  function slowSetup(delay: number, options: Partial<GeminiSTTServiceOptions> = {}) {
    const events: string[] = [];
    server = startFakeGenaiServer({
      autoSetupComplete: false,
      onLiveMessage: (m, socket) => {
        if ("setup" in m) {
          setTimeout(() => socket.send({ setupComplete: {} }), delay * 1000);
          return;
        }
        transcriber()(m, socket);
      },
    });

    class LoggingGeminiSTT extends GeminiSTTService {
      override async pushFrame(
        frame: Frame,
        direction: FrameDirection = FrameDirection.DOWNSTREAM,
      ): Promise<void> {
        if (frame instanceof StartFrame) events.push("StartFrame");
        await super.pushFrame(frame, direction);
      }
    }

    const stt = new LoggingGeminiSTT({
      apiKey: "test-key",
      sampleRate: 16000,
      httpOptions: { baseUrl: server.url },
      ...options,
    });
    stt.addEventHandler("on_connected", async () => {
      events.push("connected");
    });
    return { stt, events };
  }

  test("the StartFrame goes on before the session is live; earlier audio is delivered after", async () => {
    const { stt, events } = slowSetup(0.4);
    const [down, up] = await runTest(stt, {
      // Shorter than the setup: a blocking start would time out.
      startTimeout: 0.3,
      framesToSend: [audioFrame(), audioFrame(), new SleepFrame({ sleep: 0.7 })],
    });

    expect(events).toEqual(["StartFrame", "connected"]);
    expect(server!.sessions).toHaveLength(1);
    const audio = server!.sessions[0]!.messages.filter((m) => m.realtimeInput?.audio);
    expect(audio).toHaveLength(2);
    expect(finals(down)).toHaveLength(2);
    expect(up.filter((f) => f instanceof ErrorFrame)).toEqual([]);
  });

  test("awaitConnectionOnStart holds the StartFrame until the session is live", async () => {
    const { stt, events } = slowSetup(0.2, { awaitConnectionOnStart: true });
    const [down] = await runTest(stt, {
      startTimeout: 2,
      framesToSend: [audioFrame(), new SleepFrame({ sleep: 0.2 })],
    });

    expect(events).toEqual(["connected", "StartFrame"]);
    expect(finals(down)).toHaveLength(1);
  });

  test("a failed background connect is reported through on_connection_error", async () => {
    server = startFakeGenaiServer({
      autoSetupComplete: false,
      onLiveMessage: (m, socket) => {
        if ("setup" in m) socket.close(1008, "API key not valid.");
      },
    });
    const stt = new GeminiSTTService({ apiKey: "bad", httpOptions: { baseUrl: server.url } });
    const errors: string[] = [];
    stt.addEventHandler("on_connection_error", async (_s: unknown, error: string) => {
      errors.push(error);
    });
    const [, up] = await runTest(stt, {
      framesToSend: [audioFrame(), new SleepFrame({ sleep: 0.2 })],
    });

    expect(errors).toEqual(["Gemini Live connection closed (code 1008): API key not valid."]);
    const errorFrames = up.filter((f) => f instanceof ErrorFrame) as ErrorFrame[];
    expect(errorFrames.map((e) => e.error)).toEqual([
      `${stt} connection failed: Gemini Live connection closed (code 1008): API key not valid.`,
    ]);
  });

  test("stopping while connecting cancels the connect cleanly", async () => {
    // The server never completes the setup.
    server = startFakeGenaiServer({ autoSetupComplete: false });
    const stt: Internals = new GeminiSTTService({
      apiKey: "test-key",
      httpOptions: { baseUrl: server.url },
    });
    const started = Date.now();
    const [, up] = await runTest(stt, {
      framesToSend: [audioFrame(), new SleepFrame({ sleep: 0.1 })],
    });

    expect(Date.now() - started).toBeLessThan(2000);
    expect(up.filter((f) => f instanceof ErrorFrame)).toEqual([]);
    expect(stt._connectTask).toBeNull();
    expect(stt._session).toBeNull();
  });
});
