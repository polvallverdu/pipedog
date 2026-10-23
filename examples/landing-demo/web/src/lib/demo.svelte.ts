// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// The page's state: one demo session at a time, over the WebSocket (Pipecat's own client,
// `@pipecat-ai/client-js` with its WebSocket transport, unchanged) or over WebRTC (rtc.ts). Both
// deliver the same RTVI messages, and `#rtvi()` turns them into the chat, the tool cards and the
// metrics, so the page looks the same on either.

import type { PipecatClient } from "@pipecat-ai/client-js";
import { levelMeter, RtcCall, type RtviMessage } from "./rtc.ts";
import { turnstileToken } from "./turnstile.ts";

export type Transport = "websocket" | "webrtc";

export type Status =
  | "loading"
  | "unavailable"
  | "idle"
  | "verifying"
  | "connecting"
  | "connected"
  | "ending"
  | "ended"
  | "refused"
  | "error";

export type ChatItem =
  | { kind: "user"; id: number; text: string; final: boolean }
  | { kind: "bot"; id: number; text: string; streaming: boolean; note?: string }
  | {
      kind: "tool";
      id: number;
      callId: string;
      name: string;
      args: Record<string, unknown> | null;
      status: "running" | "done" | "cancelled";
      result: unknown;
    }
  | { kind: "system"; id: number; text: string };

export interface Visitor {
  colo: string | null;
  country: string | null;
  city: string | null;
}

export interface ServerStatus {
  enabled: boolean;
  transports: { websocket: boolean; webrtc: boolean };
  turnstileSiteKey: string | null;
  turnstileRequired: boolean;
  limits: { maxSecs: number; maxTurns: number };
}

const PING_EVERY_MS = 3000;
const LEVEL_HISTORY = 36;

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

export class Demo {
  status = $state<Status>("loading");
  message = $state<string | null>(null);
  server = $state<ServerStatus | null>(null);
  transport = $state<Transport>("websocket");
  active = $state<Transport | null>(null);
  items = $state<ChatItem[]>([]);

  // Metrics
  rtts = $state<number[]>([]);
  latencies = $state<number[]>([]);
  ttfb = $state<{ stt: number | null; llm: number | null; tts: number | null }>({
    stt: null,
    llm: null,
    tts: null,
  });
  botColo = $state<string | null>(null);
  visitor = $state<Visitor | null>(null);
  rtcStats = $state<{ rttMs: number | null; jitterMs: number | null } | null>(null);

  // Session
  endsAt = $state<number | null>(null);
  now = $state(Date.now());
  turns = $state(0);
  maxTurns = $state(12);
  userSpeaking = $state(false);
  botSpeaking = $state(false);
  levels = $state<{ user: number; bot: number }[]>(
    Array.from({ length: LEVEL_HISTORY }, () => ({ user: 0, bot: 0 })),
  );

  #nextId = 0;
  #currentUser: number | null = null;
  #currentBot: number | null = null;
  #client: PipecatClient | null = null;
  #rtc: RtcCall | null = null;
  #timers: ReturnType<typeof setInterval>[] = [];
  #userLevel = 0;
  #botLevel = 0;
  // The WebSocket transport's media manager reports no levels: measure the mic ourselves.
  #micMeter: (() => number) | null = null;
  #meterContext: AudioContext | null = null;

  get webrtcAvailable(): boolean {
    return this.server?.transports.webrtc === true;
  }

  get busy(): boolean {
    return ["verifying", "connecting", "connected", "ending"].includes(this.status);
  }

  get remainingSecs(): number | null {
    return this.endsAt === null ? null : Math.max(0, Math.round((this.endsAt - this.now) / 1000));
  }

  get rttMs(): number | null {
    return median(this.rtts.slice(-5));
  }

  /** Ask the Worker whether the demo is on, and what it offers. */
  async load(): Promise<void> {
    try {
      const response = await fetch("/api/status", { cache: "no-store" });
      if (!response.ok) throw new Error(String(response.status));
      const status = (await response.json()) as ServerStatus;
      this.server = status;
      this.maxTurns = status.limits.maxTurns;
      if (!status.enabled) {
        this.#unavailable("The demo is switched off for now. Check back later!");
      } else if (status.turnstileRequired && !status.turnstileSiteKey) {
        this.#unavailable("The demo isn't configured yet.");
      } else {
        this.status = "idle";
      }
    } catch {
      this.#unavailable("The demo server can't be reached right now.");
    }
  }

  #unavailable(message: string): void {
    this.status = "unavailable";
    this.message = message;
  }

  #push(item: ChatItem): number {
    this.items.push(item);
    return item.id;
  }

  #find<K extends ChatItem["kind"]>(id: number | null, kind: K) {
    if (id === null) return null;
    const item = this.items.find((i) => i.id === id);
    return item && item.kind === kind ? (item as Extract<ChatItem, { kind: K }>) : null;
  }

  #reset(): void {
    this.items = [];
    this.rtts = [];
    this.latencies = [];
    this.ttfb = { stt: null, llm: null, tts: null };
    this.botColo = null;
    this.visitor = null;
    this.rtcStats = null;
    this.endsAt = null;
    this.turns = 0;
    this.#currentUser = null;
    this.#currentBot = null;
    this.message = null;
  }

  /** Start a session over the chosen transport. */
  async start(turnstileContainer: HTMLElement, theme: "light" | "dark"): Promise<void> {
    if (this.busy || !this.server) return;
    this.#reset();
    const transport = this.transport === "webrtc" && this.webrtcAvailable ? "webrtc" : "websocket";
    try {
      this.status = "verifying";
      let token = "";
      if (this.server.turnstileRequired && this.server.turnstileSiteKey) {
        token = await turnstileToken(this.server.turnstileSiteKey, turnstileContainer, theme);
      }
      this.status = "connecting";
      const response = await fetch("/api/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ turnstileToken: token, transport }),
      });
      const session = await response.json().catch(() => ({}));
      if (!response.ok) {
        this.status = "refused";
        this.message = session.message ?? "The demo couldn't start a session.";
        return;
      }
      this.active = transport;
      if (transport === "webrtc") {
        await this.#startRtc(session.rtcUrl, session.ticket);
      } else {
        await this.#startWebsocket(session.wsUrl);
      }
      this.#startTimers();
    } catch (e) {
      await this.#teardown();
      this.status = "error";
      const text = e instanceof Error ? e.message : String(e);
      this.message = /permission|NotAllowed/i.test(text)
        ? "The demo needs your microphone. Allow it and try again."
        : `The session couldn't start: ${text}`;
    }
  }

  async #startWebsocket(wsUrl: string): Promise<void> {
    const [{ PipecatClient }, { ProtobufFrameSerializer, WavMediaManager, WebSocketTransport }] =
      await Promise.all([
        import("@pipecat-ai/client-js"),
        import("@pipecat-ai/websocket-transport"),
      ]);
    const rtvi = (type: string, data?: unknown) => this.#rtvi({ type, data });
    const client = new PipecatClient({
      transport: new WebSocketTransport({
        // Pipecat's protobuf frames, the format the bot's serializer speaks; the mic at 16 kHz.
        serializer: new ProtobufFrameSerializer(),
        mediaManager: new WavMediaManager(512, 16000),
      }),
      enableMic: true,
      enableCam: false,
      callbacks: {
        onBotReady: () => rtvi("bot-ready"),
        onDisconnected: () => void this.#ended(),
        onUserTranscript: (d) => rtvi("user-transcription", d),
        onUserStartedSpeaking: () => rtvi("user-started-speaking"),
        onUserStoppedSpeaking: () => rtvi("user-stopped-speaking"),
        onBotStartedSpeaking: () => rtvi("bot-started-speaking"),
        onBotStoppedSpeaking: () => rtvi("bot-stopped-speaking"),
        onBotLlmStarted: () => rtvi("bot-llm-started"),
        onBotLlmText: (d) => rtvi("bot-llm-text", d),
        onBotLlmStopped: () => rtvi("bot-llm-stopped"),
        onLLMFunctionCallInProgress: (d) => rtvi("llm-function-call-in-progress", d),
        onLLMFunctionCallStopped: (d) => rtvi("llm-function-call-stopped", d),
        onMetrics: (d) => rtvi("metrics", d),
        onServerMessage: (d) => rtvi("server-message", d),
        onLocalAudioLevel: (level) => {
          this.#userLevel = level;
        },
        onRemoteAudioLevel: (level) => {
          this.#botLevel = level;
        },
        onError: (m) => {
          const d = (m?.data ?? {}) as { message?: string; error?: string };
          if (this.status !== "connected") this.message = String(d.message ?? d.error ?? "error");
        },
      },
    });
    this.#client = client;
    await client.connect({ wsUrl });
    const mic = client.tracks()?.local?.audio;
    if (mic) {
      this.#meterContext = new AudioContext();
      this.#micMeter = levelMeter(new MediaStream([mic]), this.#meterContext);
    }
  }

  async #startRtc(rtcUrl: string, ticket: string): Promise<void> {
    const call = new RtcCall(
      rtcUrl,
      (m) => this.#rtvi(m),
      () => void this.#ended(),
    );
    this.#rtc = call;
    await call.start(ticket);
  }

  #startTimers(): void {
    // The round trip: an RTVI client message the bot answers, timed here.
    const ping = async () => {
      const t0 = performance.now();
      try {
        if (this.#client) await this.#client.sendClientRequest("ping", {}, 2500);
        else if (this.#rtc) await this.#rtc.request("ping", {}, 2500);
        else return;
        this.rtts = [...this.rtts.slice(-19), performance.now() - t0];
      } catch {
        // A lost ping: the next one counts.
      }
      if (this.#rtc) this.rtcStats = await this.#rtc.stats().catch(() => null);
    };
    this.#timers.push(setInterval(ping, PING_EVERY_MS));
    setTimeout(ping, 600);
    this.#timers.push(
      setInterval(() => {
        this.now = Date.now();
        const user = this.#rtc ? this.#rtc.userLevel() : (this.#micMeter?.() ?? this.#userLevel);
        // The bot's audio plays inside the media manager, out of reach: while it speaks, show a
        // speaking pattern instead of its level.
        const t = performance.now() / 160;
        const speaking = 0.3 + 0.3 * Math.abs(Math.sin(t) * Math.cos(t * 0.37));
        const bot = this.#rtc
          ? this.#rtc.botLevel()
          : this.#botLevel || (this.botSpeaking ? speaking : 0);
        this.levels = [...this.levels.slice(1), { user, bot }];
      }, 90),
    );
  }

  /** One RTVI message from the bot. */
  #rtvi(message: RtviMessage): void {
    const data = message.data ?? {};
    switch (message.type) {
      case "bot-ready":
        this.status = "connected";
        break;
      case "user-transcription": {
        const text = String(data.text ?? "");
        const current = this.#find(this.#currentUser, "user");
        if (current && !current.final) {
          current.text = text;
          current.final = Boolean(data.final);
        } else if (text) {
          this.#currentUser = this.#push({
            kind: "user",
            id: this.#nextId++,
            text,
            final: Boolean(data.final),
          });
        }
        if (data.final) {
          this.turns += 1;
          this.#currentUser = null;
          this.#currentBot = null;
        }
        break;
      }
      case "user-started-speaking":
        this.userSpeaking = true;
        break;
      case "user-stopped-speaking":
        this.userSpeaking = false;
        break;
      case "bot-started-speaking":
        this.botSpeaking = true;
        break;
      case "bot-stopped-speaking":
        this.botSpeaking = false;
        break;
      case "bot-llm-started":
        this.#currentBot = this.#push({
          kind: "bot",
          id: this.#nextId++,
          text: "",
          streaming: true,
        });
        break;
      case "bot-llm-text": {
        const bot = this.#find(this.#currentBot, "bot");
        if (bot) bot.text += String(data.text ?? "");
        else
          this.#currentBot = this.#push({
            kind: "bot",
            id: this.#nextId++,
            text: String(data.text ?? ""),
            streaming: true,
          });
        break;
      }
      case "bot-llm-stopped": {
        const bot = this.#find(this.#currentBot, "bot");
        if (bot) {
          bot.streaming = false;
          bot.text = bot.text.trim();
          if (!bot.text) this.items = this.items.filter((i) => i.id !== bot.id);
        }
        this.#currentBot = null;
        break;
      }
      case "llm-function-call-in-progress":
        this.#finishBot();
        this.#push({
          kind: "tool",
          id: this.#nextId++,
          callId: String(data.tool_call_id ?? ""),
          name: String(data.function_name ?? "tool"),
          args: data.arguments ?? null,
          status: "running",
          result: null,
        });
        break;
      case "llm-function-call-stopped": {
        const tool = this.items.find((i) => i.kind === "tool" && i.callId === data.tool_call_id);
        if (tool && tool.kind === "tool") {
          tool.status = data.cancelled ? "cancelled" : "done";
          tool.result = data.result ?? null;
        }
        break;
      }
      case "metrics":
        for (const t of (data.ttfb ?? []) as { processor: string; value: number }[]) {
          const p = t.processor ?? "";
          const key = /anthropic|llm/i.test(p)
            ? "llm"
            : /aura|tts/i.test(p)
              ? "tts"
              : /flux|stt/i.test(p)
                ? "stt"
                : null;
          if (key && t.value > 0) this.ttfb = { ...this.ttfb, [key]: t.value * 1000 };
        }
        break;
      case "server-message":
        this.#serverMessage(data);
        break;
    }
  }

  #finishBot(): void {
    const bot = this.#find(this.#currentBot, "bot");
    if (bot) bot.streaming = false;
    this.#currentBot = null;
  }

  #serverMessage(data: any): void {
    switch (data?.type) {
      case "session-info":
        this.botColo = data.bot_colo ?? null;
        this.visitor = data.visitor ?? null;
        this.maxTurns = data.limits?.max_turns ?? this.maxTurns;
        this.endsAt = Date.now() + (data.limits?.max_secs ?? 120) * 1000;
        this.status = "connected";
        break;
      case "bot-speech":
        this.#finishBot();
        this.#push({
          kind: "bot",
          id: this.#nextId++,
          text: String(data.text ?? ""),
          streaming: false,
        });
        break;
      case "voice-latency":
        this.latencies = [...this.latencies, Number(data.seconds) * 1000];
        break;
      case "session-ending": {
        this.#finishBot();
        this.status = "ending";
        const why: Record<string, string> = {
          time: "Time's up",
          idle: "It went quiet",
          turns: "That was the last turn",
          goodbye: "You said goodbye",
        };
        this.#push({
          kind: "bot",
          id: this.#nextId++,
          text: String(data.text ?? ""),
          streaming: false,
          note: why[data.reason] ?? undefined,
        });
        break;
      }
    }
  }

  async #ended(): Promise<void> {
    if (this.status === "ended" || this.status === "idle") return;
    const wasStarting = this.status === "connecting" || this.status === "verifying";
    await this.#teardown();
    if (wasStarting) return;
    this.status = "ended";
    this.#push({ kind: "system", id: this.#nextId++, text: "Session ended." });
  }

  async #teardown(): Promise<void> {
    for (const t of this.#timers) clearInterval(t);
    this.#timers = [];
    this.userSpeaking = false;
    this.botSpeaking = false;
    this.endsAt = null;
    const client = this.#client;
    const rtc = this.#rtc;
    this.#client = null;
    this.#rtc = null;
    await client?.disconnect().catch(() => {});
    this.#micMeter = null;
    void this.#meterContext?.close();
    this.#meterContext = null;
    await rtc?.close();
    this.levels = this.levels.map(() => ({ user: 0, bot: 0 }));
  }

  /** Hang up. */
  async stop(): Promise<void> {
    await this.#ended();
  }
}
