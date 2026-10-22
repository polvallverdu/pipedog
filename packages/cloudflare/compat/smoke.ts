// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Runtime smoke test for tools/compat, with no network: imports every entry,
// builds every service, and runs the binding and REST paths of the client and
// the Smart Turn analyzer against a fake `env.AI` and a fake `fetch`.

import {
  WorkersAIAuraHttpTTSService,
  WorkersAIAuraTTSService,
  WorkersAIClient,
  WorkersAIFluxSTTService,
  WorkersAILLMService,
  WorkersAIMeloTTSService,
  WorkersAINova3STTService,
  WorkersAISmartTurnAnalyzer,
  WorkersAIWhisperSTTService,
} from "@pipedog/cloudflare";
import { EndOfTurnState } from "@pipedog/core/audio/turn/base_turn_analyzer";

function check(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(`cloudflare smoke: ${message}`);
}

const binding = {
  async run(model: string, _input: unknown, options: Record<string, unknown> = {}) {
    if (options.returnRawResponse) {
      return new Response(new Uint8Array(8), { headers: { "Content-Type": "audio/l16" } });
    }
    if (model === "@cf/pipecat-ai/smart-turn-v2") return { is_complete: true, probability: 0.9 };
    return { text: "hello" };
  },
};

const fakeFetch = (async (input: RequestInfo | URL) => {
  const url = String(input);
  check(url.includes("/accounts/acc/ai/run/"), `unexpected URL ${url}`);
  return new Response(JSON.stringify({ result: { text: "hello rest" }, success: true }), {
    headers: { "Content-Type": "application/json" },
  });
}) as typeof fetch;

export default async function smoke(): Promise<void> {
  const viaBinding = new WorkersAIClient({ ai: binding });
  const viaRest = new WorkersAIClient({ accountId: "acc", apiToken: "tok", fetch: fakeFetch });

  check((await viaBinding.run("@cf/openai/whisper", {})).text === "hello", "binding run");
  check((await viaRest.run("@cf/openai/whisper", {})).text === "hello rest", "REST run");
  const raw = await viaBinding.runRaw("@cf/deepgram/aura-2-en", { text: "hi" });
  check((await raw.arrayBuffer()).byteLength === 8, "binding runRaw");

  const analyzer = new WorkersAISmartTurnAnalyzer({ client: viaBinding });
  analyzer.setSampleRate(16000);
  for (let i = 0; i < 10; i++) analyzer.appendAudio(new Uint8Array(640), true);
  const [state] = await analyzer.analyzeEndOfTurn();
  check(state === EndOfTurnState.COMPLETE, "smart turn");

  for (const client of [viaBinding, viaRest]) {
    new WorkersAIFluxSTTService({ client });
    new WorkersAINova3STTService({ client });
    new WorkersAIWhisperSTTService({ client });
    new WorkersAIAuraTTSService({ client });
    new WorkersAIAuraHttpTTSService({ client });
    new WorkersAIMeloTTSService({
      client,
      decodeAudio: () => ({ channelData: [], sampleRate: 1 }),
    });
  }
  new WorkersAILLMService({ client: viaRest });
}
