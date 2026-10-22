// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Runtime smoke test for tools/compat: constructs the STT and TTS services (no network).

import * as pkg from "@pipedog/gradium";

const SERVICES = ["GradiumSTTService", "GradiumTTSService"];

export default async function smoke(): Promise<void> {
  for (const name of SERVICES) {
    const Service = (
      pkg as unknown as Record<string, new (options: object) => { _settings: unknown }>
    )[name];
    if (typeof Service !== "function") throw new Error(`gradium smoke: ${name} is not exported`);
    const service = new Service({ apiKey: "test-key" });
    if (!service._settings) throw new Error(`gradium smoke: ${name} has no settings`);
  }
}
