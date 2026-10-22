// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Configuration (c): Google. Gemini's LLM (`@google/genai`, against a mock) and the
// gRPC clients behind Cloud Speech-to-Text and Text-to-Speech. The gRPC clients
// talk to a local gRPC server that has no services, so a call that reaches it
// and comes back UNIMPLEMENTED proves the whole client stack (grpc-js, google-gax,
// its protos) loaded and ran from the bundle.
//
// Run by two entries: google_bot.ts lets the services import the SDKs by name at run
// time (so they must be installed next to the bundle), google_sdk_bot.ts imports the
// SDKs itself and passes them in, which puts them in the bundle.

import { LLMContextFrame, LLMTextFrame } from "@pipedog/core/frames/frames";
import { LLMContext } from "@pipedog/core/processors/aggregators/llm_context";
import { runTest } from "@pipedog/core/tests/utils";
import { startMockGoogle } from "@pipedog/example-test-mocks/mock_google";
import { GoogleLLMService, GoogleLLMSettings } from "@pipedog/google/llm";
import { type GoogleSpeechModule, GoogleSTTService } from "@pipedog/google/stt";
import { GoogleHttpTTSService, type GoogleTextToSpeechModule } from "@pipedog/google/tts";
import { OK_MARKER } from "./common.ts";

export async function checkGoogle(
  grpc: typeof import("@grpc/grpc-js"),
  modules: {
    speechModule?: GoogleSpeechModule;
    textToSpeechModule?: GoogleTextToSpeechModule;
  } = {},
): Promise<void> {
  const mock = startMockGoogle();

  // 1. Gemini over HTTP (the mock streams the canned answer).
  const llm = new GoogleLLMService({
    apiKey: "test",
    httpOptions: { baseUrl: mock.baseUrl },
    settings: new GoogleLLMSettings({ systemInstruction: "Be brief." }),
  });
  const context = new LLMContext();
  context.addMessage({ role: "user", content: "What is the capital of Germany?" });
  const [down] = await runTest(llm, { framesToSend: [new LLMContextFrame({ context })] });
  const text = down
    .filter((f): f is LLMTextFrame => f instanceof LLMTextFrame)
    .map((f) => f.text)
    .join("");
  console.log(`gemini answered: ${text}`);
  if (!text.includes("Berlin")) throw new Error(`unexpected Gemini answer: ${text}`);

  // 2. The gRPC clients.
  const server = new grpc.Server();
  const port = await new Promise<number>((resolve, reject) =>
    server.bindAsync("127.0.0.1:0", grpc.ServerCredentials.createInsecure(), (e, p) =>
      e ? reject(e) : resolve(p),
    ),
  );
  const clientOptions = {
    apiEndpoint: "127.0.0.1",
    port,
    sslCreds: grpc.credentials.createInsecure(),
    projectId: "bundle-check",
    // No credentials: the call fails at the server, not while fetching a token.
    authClient: { getRequestHeaders: async () => ({}) },
  };

  let unimplemented = 0;
  const expectUnimplemented = (e: unknown) => {
    if (String((e as Error).message).includes("UNIMPLEMENTED")) unimplemented++;
    else throw e;
  };

  const tts = new GoogleHttpTTSService({
    clientOptions,
    textToSpeechModule: modules.textToSpeechModule,
  });
  try {
    await (tts as any)._client.synthesizeSpeech({
      input: { text: "hi" },
      voice: { languageCode: "en-US" },
      audioConfig: { audioEncoding: "LINEAR16" },
    });
  } catch (e) {
    expectUnimplemented(e);
  }

  const stt = new GoogleSTTService({
    credentials: JSON.stringify({ project_id: "bundle-check" }),
    clientOptions,
    speechModule: modules.speechModule,
  });
  const sttClient = await (stt as any)._ensureClient();
  try {
    const call = sttClient.streamingRecognize();
    call.write({ recognizer: "projects/bundle-check/locations/global/recognizers/_" });
    for await (const _ of call) {
      // nothing is expected
    }
  } catch (e) {
    expectUnimplemented(e);
  }

  if (unimplemented !== 2)
    throw new Error(`expected two UNIMPLEMENTED calls, got ${unimplemented}`);
  console.log(`${OK_MARKER} grpc-unimplemented=${unimplemented}`);
  server.forceShutdown();
  mock.stop();
  process.exit(0);
}
