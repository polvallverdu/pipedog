// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Bundling check: each sample bot in src/ is bundled with `bun build` (and with
// `bun build --compile`) and run from a temp directory that has no node_modules, with
// mock providers. This is what a host does when it deploys a single file; the Bundling
// guide in the docs describes the recipes these bots use.
//
// Each bot is a self-test: it makes a call or a request and prints BUNDLE_CHECK_OK. The
// tests that expect a failure check the error message, since the point of those is that
// it says what to do.
//
// Skipped with PIPEDOG_E2E=0, and when `bun build` cannot run here (no compile support).

import { describe, expect, test } from "bun:test";
import { type BuildMode, type BundleOptions, bundleAndRun } from "../src/harness.ts";

const skip = process.env.PIPEDOG_E2E === "0";
if (skip) console.log("bundle check: skipping (PIPEDOG_E2E=0)");

/** Whether `bun build --compile` works on this machine (it needs the runtime binary). */
const compileWorks = await (async () => {
  if (skip) return false;
  const result = await bundleAndRun("rnnoise_bot.ts", "compile", {
    env: { RNNOISE: "file" },
    timeoutMs: 30000,
  });
  if (result.code === null) {
    console.log(`bundle check: skipping --compile: ${result.buildOutput.slice(0, 200)}`);
  }
  return result.code !== null;
})();

const NATIVE = "onnxruntime-node";

function check(
  name: string,
  bot: string,
  modes: BuildMode[],
  options: BundleOptions & { fails?: RegExp; forbidden?: RegExp[] } = {},
): void {
  const { fails, forbidden = [], ...rest } = options;
  for (const mode of modes) {
    const run = skip || (mode === "compile" && !compileWorks) ? test.skip : test;
    run(
      `${name} (${mode === "bun" ? "bun build" : "bun build --compile"})`,
      async () => {
        const result = await bundleAndRun(bot, mode, { timeoutMs: 60000, ...rest });
        const log = `${result.buildOutput}\n${result.output}`;
        if (fails) {
          expect(result.ok).toBe(false);
          expect(log).toMatch(fails);
        } else {
          if (!result.ok) console.log(log.split("\n").slice(-40).join("\n"));
          expect(result.ok).toBe(true);
          // The resampler loads its WASM; the fallback logs this when it could not.
          expect(result.output).not.toContain("Could not load the WASM resampler");
          for (const pattern of forbidden) expect(result.output).not.toMatch(pattern);
        }
      },
      90000,
    );
  }
}

describe("(a) WebSocket, OpenAI, Silero, Smart Turn and the resampler", () => {
  // Everything in the bundle: onnxruntime-web, its files and the models as file imports.
  check("onnxruntime-web and file imports", "ws_web_bot.ts", ["bun", "compile"]);
  // onnxruntime-node is a native addon: external, installed next to the bundle.
  check("onnxruntime-node external", "ws_native_bot.ts", ["bun"], {
    externals: [NATIVE],
    nodeModules: [NATIVE],
  });
  // No options: the default model files are not in the bundle, and the error says how to pass them.
  check("default models fail with a hint", "ws_default_bot.ts", ["bun"], {
    externals: [NATIVE],
    nodeModules: [NATIVE],
    fails: /Pass the model yourself[\s\S]*silero_vad\.onnx" with \{ type: "file" \}/,
  });
});

describe("(b) SmallWebRTC (werift)", () => {
  check("peer connection and Opus", "webrtc_bot.ts", ["bun", "compile"]);
});

describe("(c) Google", () => {
  // The SDKs imported by the app and passed in: bundled, nothing next to the bundle.
  check("SDKs passed in", "google_sdk_bot.ts", ["bun", "compile"]);
  // The SDKs imported by name at run time: they have to be installed next to the bundle.
  check("SDKs installed next to the bundle", "google_bot.ts", ["bun"], {
    externals: ["@google-cloud/speech", "@google-cloud/text-to-speech", "@grpc/grpc-js"],
    nodeModules: ["@google-cloud/speech", "@google-cloud/text-to-speech", "@grpc/grpc-js"],
  });
  check("SDKs not installed fail with a hint", "google_bot.ts", ["bun"], {
    fails: /bundled app[\s\S]*textToSpeechModule/,
  });
});

describe("(d) RNNoise", () => {
  check("module as a file import", "rnnoise_bot.ts", ["bun", "compile"], {
    env: { RNNOISE: "file" },
  });
  check("default module fails with a hint", "rnnoise_bot.ts", ["bun"], {
    fails: /initRnnoise\(new URL\(wasmPath, import\.meta\.url\)\)/,
  });
});

describe("(e) the runner with Telnyx", () => {
  // The runner loads the SmallWebRTC transport lazily; werift's reflect-metadata import must
  // not be reordered behind tsyringe, which would disable the WebRTC routes.
  check("telephony routes and a greeting", "telnyx_bot.ts", ["bun", "compile"], {
    forbidden: [/tsyringe requires a reflect polyfill/, /WebRTC routes disabled/],
  });
});
