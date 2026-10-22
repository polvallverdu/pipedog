// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/cli/templates/server/bot_cascade.py.jinja2

/**
 * The generated server's `bot.ts`: a cascade (STT -> LLM -> TTS) or realtime (speech-to-speech)
 * pipeline on the development runner, as upstream's `bot_cascade.py.jinja2`,
 * `bot_realtime.py.jinja2` and their `_macros` and `_blocks` do for `bot.py`.
 *
 * DIVERGENCE: upstream renders Jinja2 templates and formats the result with Ruff. This is a
 * TypeScript function that builds the file from the project config, with the imports merged and
 * sorted by `ServiceLoader`. The Daily PSTN and Twilio + Daily SIP flows (`server.py`,
 * `server_utils.py`, the dial-out manager) and Krisp have no counterpart. The Context Hub,
 * Whisker and aiohttp session plumbing are replaced by: a startup check for the environment
 * variables the services need, OpenTelemetry tracing (`@pipedog/tracing`) for `--observability`,
 * and a WAV writer for `--recording`. The entry point is `main({ bot })` from
 * `@pipedog/runner/run`, started when the file is the program's entry (Bun, Deno and Node, where
 * `import.meta.main` is missing before Node 24.2).
 */

import type { ProjectConfig } from "../questions.ts";
import { ServiceLoader } from "../service_loader.ts";
import { DEFAULT_SYSTEM_INSTRUCTION, ServiceRegistry } from "../service_metadata.ts";

/** The `transportParams` key the runner looks a transport up by. */
function transportKey(transport: string): string {
  return transport === "smallwebrtc" ? "webrtc" : transport;
}

/** Indent every non-empty line of `text` by `spaces`. */
export function indent(text: string, spaces: number): string {
  const pad = " ".repeat(spaces);
  return text
    .split("\n")
    .map((line) => (line.length > 0 ? pad + line : line))
    .join("\n");
}

function labelOf(
  value: string | null,
  list: readonly { value: string; label: string }[],
): string | null {
  if (!value) return null;
  return list.find((svc) => svc.value === value)?.label ?? value;
}

/** The services of a config, as `ServiceLoader` takes them. */
export function servicesOf(config: ProjectConfig): Record<string, string | string[]> {
  const services: Record<string, string | string[]> = { transports: config.transports };
  if (config.mode === "cascade") {
    if (config.sttService) services.stt = config.sttService;
    if (config.llmService) services.llm = config.llmService;
    if (config.ttsService) services.tts = config.ttsService;
  } else if (config.realtimeService) {
    services.realtime = config.realtimeService;
  }
  if (config.videoService) services.video = config.videoService;
  return services;
}

/** The features of a config, as `ServiceLoader` takes them. */
export function featuresOf(config: ProjectConfig): Record<string, boolean> {
  return {
    recording: config.recording,
    transcription: config.transcription,
    observability: config.enableObservability,
    eval: config.enableEval,
    video_in_sources: config.videoInput && config.transports.includes("smallwebrtc"),
  };
}

/** The environment variables the generated bot refuses to start without. */
export function requiredEnv(config: ProjectConfig): string[] {
  const names: string[] = [];
  const services = servicesOf(config);
  const defs = [
    ...ServiceRegistry.WEBRTC_TRANSPORTS,
    ...ServiceRegistry.TELEPHONY_TRANSPORTS,
    ...ServiceRegistry.STT_SERVICES,
    ...ServiceRegistry.LLM_SERVICES,
    ...ServiceRegistry.TTS_SERVICES,
    ...ServiceRegistry.REALTIME_SERVICES,
    ...ServiceRegistry.VIDEO_SERVICES,
  ];
  for (const value of Object.values(services).flat()) {
    const def = defs.find((d) => d.value === value);
    if (!def) continue;
    for (const env of ServiceLoader.getEnvVars(def)) {
      if (env.required && !names.includes(env.name)) names.push(env.name);
    }
  }
  return names;
}

function transportParamsBlock(config: ProjectConfig): string {
  const { transports, videoInput, videoOutput, enableEval } = config;
  const video = (lines: string[], sources: boolean): string[] => {
    const out: string[] = [];
    if (videoInput) {
      out.push("videoInEnabled: true,");
      if (sources) {
        out.push("videoInSources: {");
        out.push("  camera: new VideoInSourceParams({ framerate: 1 }),");
        out.push("  // Uncomment to also receive the user's screen share.");
        out.push("  // screenVideo: new VideoInSourceParams({ framerate: 1 }),");
        out.push("},");
      }
    }
    if (videoOutput) {
      out.push("videoOutEnabled: true,");
      out.push("videoOutIsLive: true,");
      out.push("videoOutWidth: 1024,");
      out.push("videoOutHeight: 768,");
    }
    return [...lines, ...out];
  };
  const entry = (key: string, cls: string, lines: string[], comment?: string): string => {
    const body = lines.map((l) => `      ${l}`).join("\n");
    return `${comment ? `  // ${comment}\n` : ""}  ${key}: () =>\n    new ${cls}({\n${body}\n    }),`;
  };
  const audio = ["audioInEnabled: true,", "audioOutEnabled: true,"];

  const entries: string[] = [];
  if (transports.includes("smallwebrtc")) {
    entries.push(entry("webrtc", "TransportParams", video(audio, true)));
  }
  if (transports.includes("websocket")) {
    entries.push(
      entry("websocket", "FastAPIWebsocketParams", [
        ...audio,
        "addWavHeader: false,",
        "serializer: new ProtobufFrameSerializer(),",
      ]),
    );
  }
  if (transports.includes("livekit")) {
    entries.push(entry("livekit", "LiveKitParams", video(audio, false)));
  }
  for (const provider of ["twilio", "telnyx", "plivo", "exotel"]) {
    if (transports.includes(provider)) {
      entries.push(
        entry(
          transportKey(provider),
          "FastAPIWebsocketParams",
          audio,
          `createTransport sets the ${provider} serializer and addWavHeader.`,
        ),
      );
    }
  }
  if (enableEval) {
    entries.push(
      entry(
        "eval",
        "EvalTransportParams",
        audio,
        "Behavioral evals: `pipedog eval` drives this bot through its eval transport.",
      ),
    );
  }
  return `const transportParams = {\n${entries.join("\n")}\n};`;
}

/** The `runBot` function: services, pipeline, worker and event handlers. */
function runBotBlock(config: ProjectConfig): string {
  const { mode, botType } = config;
  const lines: string[] = [];
  const configOf = (value: string | null): string => {
    const text = value ? ServiceLoader.getServiceConfig(value) : null;
    if (!text) throw new Error(`No config for service '${value}'`);
    return text;
  };

  if (mode === "cascade") {
    lines.push("// Speech-to-Text service");
    lines.push(`const stt = ${configOf(config.sttService)};`);
    lines.push("");
    lines.push("// Text-to-Speech service");
    lines.push(`const tts = ${configOf(config.ttsService)};`);
    lines.push("");
    lines.push("// LLM service");
    lines.push(`const llm = ${configOf(config.llmService)};`);
  } else {
    lines.push("// Realtime (speech-to-speech) service");
    lines.push(`const llm = ${configOf(config.realtimeService)};`);
  }
  if (config.videoService) {
    lines.push("");
    lines.push("// Video service (avatar)");
    lines.push(`const video = ${configOf(config.videoService)};`);
  }

  lines.push("");
  lines.push(
    "// Conversation context and the aggregators that keep it up to date. Silero VAD hears",
  );
  lines.push(
    "// the user speak; the default turn strategy (Smart Turn) decides when they are done.",
  );
  lines.push("const context = new LLMContext();");
  lines.push("const aggregators = new LLMContextAggregatorPair(context, {");
  lines.push(
    "  userParams: new LLMUserAggregatorParams({ vadAnalyzer: new SileroVADAnalyzer() }),",
  );
  lines.push("});");
  lines.push("const userAggregator = aggregators.user();");
  lines.push("const assistantAggregator = aggregators.assistant();");

  if (config.recording) {
    lines.push("");
    lines.push("// Audio recording, started automatically when the pipeline starts");
    lines.push("const audioBuffer = new AudioBufferProcessor({ autoStartRecording: true });");
  }

  const stages = ["transport.input(),"];
  if (mode === "cascade") stages.push("stt,");
  stages.push("userAggregator,", "llm,");
  if (mode === "cascade") stages.push("tts,");
  if (config.videoService) stages.push("video,");
  stages.push("transport.output(),");
  if (config.recording) stages.push("audioBuffer,");
  stages.push("assistantAggregator,");

  lines.push("");
  lines.push("// Pipeline, assembled from reusable components");
  lines.push("const pipeline = new Pipeline([");
  for (const stage of stages) lines.push(`  ${stage}`);
  lines.push("]);");

  const params = ["enableMetrics: true,", "enableUsageMetrics: true,"];
  if (botType === "telephony") {
    // Phone audio is 8 kHz; the serializer needs no resampling.
    params.push("audioInSampleRate: 8000,", "audioOutSampleRate: 8000,");
  }
  lines.push("");
  lines.push("const worker = new PipelineWorker(pipeline, {");
  lines.push("  params: new PipelineParams({");
  for (const p of params) lines.push(`    ${p}`);
  lines.push("  }),");
  if (config.enableObservability) {
    lines.push("  // Traced when OTEL_EXPORTER_OTLP_ENDPOINT is set.");
    lines.push("  enableTracing: startTracing(),");
  }
  lines.push("});");
  lines.push("");
  lines.push("const runner = new WorkerRunner({ handleSigint: runnerArgs.handleSigint });");
  lines.push("await runner.addWorkers(worker);");
  lines.push("");

  // Event handlers
  const kickoff = [
    'context.addMessage({ role: "developer", content: "Start by concisely introducing yourself." });',
    "await worker.queueFrames([new LLMRunFrame()]);",
  ];
  if (botType === "web") {
    lines.push('worker.rtvi.eventHandler("on_client_ready", async () => {');
    lines.push("  // Kick off the conversation");
    for (const l of kickoff) lines.push(`  ${l}`);
    lines.push("});");
    lines.push("");
  }
  lines.push('transport.eventHandler("on_client_connected", async () => {');
  lines.push('  logger.info("Client connected");');
  if (botType !== "web") {
    lines.push("  // Kick off the conversation");
    for (const l of kickoff) lines.push(`  ${l}`);
  }
  lines.push("});");
  lines.push("");
  lines.push('transport.eventHandler("on_client_disconnected", async () => {');
  lines.push('  logger.info("Client disconnected");');
  lines.push("  await runner.cancel();");
  lines.push("});");

  if (config.transcription) {
    lines.push("");
    lines.push("userAggregator.eventHandler(");
    lines.push('  "on_user_turn_stopped",');
    lines.push(
      "  async (_aggregator: unknown, _strategy: unknown, message: UserTurnStoppedMessage) => {",
    );
    lines.push('    const timestamp = message.timestamp ? `[${message.timestamp}] ` : "";');
    lines.push("    logger.info(`Transcript: ${timestamp}user: ${message.content}`);");
    lines.push("  },");
    lines.push(");");
    lines.push("");
    lines.push("assistantAggregator.eventHandler(");
    lines.push('  "on_assistant_turn_stopped",');
    lines.push("  async (_aggregator: unknown, message: AssistantTurnStoppedMessage) => {");
    lines.push('    const timestamp = message.timestamp ? `[${message.timestamp}] ` : "";');
    lines.push("    logger.info(`Transcript: ${timestamp}assistant: ${message.content}`);");
    lines.push("  },");
    lines.push(");");
  }

  if (config.recording) {
    lines.push("");
    lines.push("audioBuffer.eventHandler(");
    lines.push('  "on_audio_data",');
    lines.push(
      "  async (_buffer: unknown, audio: Uint8Array, sampleRate: number, numChannels: number) => {",
    );
    lines.push('    const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 15);');
    lines.push(
      "    await saveAudioFile(audio, `recordings/merged_${stamp}.wav`, sampleRate, numChannels);",
    );
    lines.push("  },");
    lines.push(");");
  }

  lines.push("");
  lines.push("await runner.run();");

  return [
    "/** Runs the voice bot for one session. */",
    "async function runBot(transport: BaseTransport, runnerArgs: RunnerArguments): Promise<void> {",
    '  logger.info("Starting bot");',
    "",
    indent(lines.join("\n"), 2),
    "}",
  ].join("\n");
}

const SAVE_AUDIO_FILE = `/** Saves 16-bit PCM audio as a WAV file. */
async function saveAudioFile(
  audio: Uint8Array,
  filename: string,
  sampleRate: number,
  numChannels: number,
): Promise<void> {
  if (audio.length === 0) return;
  const header = new DataView(new ArrayBuffer(44));
  const text = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i++) header.setUint8(offset + i, value.charCodeAt(i));
  };
  text(0, "RIFF");
  header.setUint32(4, 36 + audio.length, true);
  text(8, "WAVE");
  text(12, "fmt ");
  header.setUint32(16, 16, true);
  header.setUint16(20, 1, true); // PCM
  header.setUint16(22, numChannels, true);
  header.setUint32(24, sampleRate, true);
  header.setUint32(28, sampleRate * numChannels * 2, true);
  header.setUint16(32, numChannels * 2, true);
  header.setUint16(34, 16, true);
  text(36, "data");
  header.setUint32(40, audio.length, true);
  await mkdir("recordings", { recursive: true });
  const wav = new Uint8Array(44 + audio.length);
  wav.set(new Uint8Array(header.buffer), 0);
  wav.set(audio, 44);
  await writeFile(filename, wav);
  logger.info(\`Audio saved to \${filename}\`);
}`;

/** The one-time tracing setup (`--observability`). */
function startTracingBlock(projectName: string): string {
  return `const TRACING_SERVICE_NAME = ${JSON.stringify(projectName)};

let tracing: boolean | null = null;

/**
 * Starts OpenTelemetry tracing once per process when OTEL_EXPORTER_OTLP_ENDPOINT is set (an
 * OTLP/HTTP traces endpoint, such as http://localhost:4318/v1/traces), and returns whether it is on.
 * Each conversation is traced: its turns, and the service calls in them.
 */
function startTracing(): boolean {
  if (tracing === null) {
    const url = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    tracing = false;
    if (url) {
      const exporter = new OTLPTraceExporter({ url });
      tracing = setupTracing({ serviceName: TRACING_SERVICE_NAME, exporter });
    }
  }
  return tracing;
}`;
}

/** `const REQUIRED_ENV = [...]`, wrapped to one name per line when it doesn't fit in 100 columns. */
function requiredEnvDeclaration(names: string[]): string {
  const line = `const REQUIRED_ENV = [${names.map((n) => JSON.stringify(n)).join(", ")}];`;
  if (line.length <= 100) return line;
  return `const REQUIRED_ENV = [\n${names.map((n) => `  ${JSON.stringify(n)},`).join("\n")}\n];`;
}

/** Render the generated `bot.ts`. */
export function renderBot(config: ProjectConfig): string {
  const { mode, botType, transports } = config;
  const telephony = transports.some((t) =>
    ServiceRegistry.TELEPHONY_TRANSPORTS.some((d) => d.value === t),
  );
  const services = servicesOf(config);
  const features = featuresOf(config);

  // Pulled in by the bot itself.
  const extraImports = [
    'import type { BaseTransport } from "@pipedog/core/transports/base_transport";',
    'import { resolve } from "node:path";',
    'import { pathToFileURL } from "node:url";',
  ];
  if (telephony) {
    extraImports.push('import { TelephonyCallEndedError } from "@pipedog/runner/utils";');
    extraImports.push('import { WebSocketRunnerArguments } from "@pipedog/runner/types";');
  }
  const importLines = ServiceLoader.getImportsForServices(
    services,
    features,
    botType,
    extraImports,
  );

  const labels: string[] = [];
  if (mode === "cascade") {
    labels.push(`- ${labelOf(config.sttService, ServiceRegistry.STT_SERVICES)} (Speech-to-Text)`);
    labels.push(`- ${labelOf(config.llmService, ServiceRegistry.LLM_SERVICES)} (LLM)`);
    labels.push(`- ${labelOf(config.ttsService, ServiceRegistry.TTS_SERVICES)} (Text-to-Speech)`);
  } else {
    labels.push(
      `- ${labelOf(config.realtimeService, ServiceRegistry.REALTIME_SERVICES)} (Realtime speech-to-speech)`,
    );
  }
  if (config.videoService) {
    labels.push(`- ${labelOf(config.videoService, ServiceRegistry.VIDEO_SERVICES)} (Video avatar)`);
  }
  const run = config.runtime === "node" ? "node bot.ts" : "bun bot.ts";

  const required = requiredEnv(config);
  const parts: string[] = [];
  parts.push(
    [
      `// ${config.projectName} - pipedog voice agent`,
      "//",
      `// This bot uses ${mode === "cascade" ? "a cascade pipeline: Speech-to-Text -> LLM -> Text-to-Speech" : "a realtime speech-to-speech pipeline"}.`,
      "//",
      "// Generated by the pipedog CLI.",
      "//",
      "// Required AI services:",
      ...labels.map((l) => `// ${l}`),
      "//",
      "// Run the bot with:",
      "//",
      `//     ${run}`,
    ].join("\n"),
  );
  parts.push(importLines.join("\n"));
  parts.push(`const SYSTEM_INSTRUCTION =\n  ${JSON.stringify(DEFAULT_SYSTEM_INSTRUCTION)};`);
  if (required.length > 0) {
    parts.push(
      [
        "/** Environment variables the services need. The runner loads .env before it starts a bot. */",
        requiredEnvDeclaration(required),
      ].join("\n"),
    );
  }
  if (config.enableObservability) parts.push(startTracingBlock(config.projectName));
  if (config.recording) parts.push(SAVE_AUDIO_FILE);
  parts.push(runBotBlock(config));

  // The entry point
  const entry: string[] = [];
  entry.push("/** The bot's entry point: the runner calls it once for each session. */");
  entry.push("export async function bot(runnerArgs: RunnerArguments): Promise<void> {");
  if (required.length > 0) {
    entry.push("  const missing = REQUIRED_ENV.filter((name) => !process.env[name]);");
    entry.push("  if (missing.length > 0) {");
    entry.push("    throw new Error(");
    entry.push(
      '      `Missing environment variables: ${missing.join(", ")}. Copy .env.example to .env and fill them in.`,',
    );
    entry.push("    );");
    entry.push("  }");
    entry.push("");
  }
  entry.push(indent(transportParamsBlock(config), 2));
  entry.push("");
  if (telephony) {
    entry.push(
      "  // createTransport reads the provider's handshake (stream and call IDs) and builds",
    );
    entry.push("  // the serializer. A caller who hangs up before it completes is not an error.");
    entry.push("  let transport: BaseTransport;");
    entry.push("  try {");
    entry.push("    transport = await createTransport(runnerArgs, transportParams);");
    entry.push("  } catch (e) {");
    entry.push("    if (e instanceof TelephonyCallEndedError) return;");
    entry.push("    throw e;");
    entry.push("  }");
    entry.push("");
    entry.push(
      "  // OPTIONAL personalization: the parsed handshake is on runnerArgs.callData. Look up the",
    );
    entry.push("  // caller by number, say, to personalize the conversation.");
    entry.push("  if (runnerArgs instanceof WebSocketRunnerArguments) {");
    entry.push("    logger.info(`Call from: ${runnerArgs.callData?.fromNumber}`);");
    entry.push("  }");
  } else {
    entry.push("  const transport = await createTransport(runnerArgs, transportParams);");
  }
  entry.push("");
  entry.push("  await runBot(transport, runnerArgs);");
  entry.push("}");
  parts.push(entry.join("\n"));

  parts.push(
    `/** Whether this file is the program's entry point (\`import.meta.main\` is missing on Node before 24.2). */
function isMainModule(): boolean {
  const meta = import.meta as { main?: boolean };
  if (typeof meta.main === "boolean") return meta.main;
  const entry = process.argv[1];
  return entry !== undefined && import.meta.url === pathToFileURL(resolve(entry)).href;
}

if (isMainModule()) {
  const { main } = await import("@pipedog/runner/run");
  await main({ bot });
}`,
  );

  return `${parts.join("\n\n")}\n`;
}
