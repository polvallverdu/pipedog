// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Samples for content/docs/services/stt/cartesia.mdx (turns). Type-checked on every docs build.

// #region usage
import { CartesiaTurnsSTTService } from "@pipedog/cartesia/turns/stt";

const stt = new CartesiaTurnsSTTService({
  apiKey: process.env.CARTESIA_API_KEY ?? "",
  settings: new CartesiaTurnsSTTService.Settings({
    keyterm: ["pipedog"],
    turnEndTimeoutMs: 2000,
  }),
});

stt.addEventHandler("on_turn_end", async (_service, transcript: string) => {
  console.log("end of turn:", transcript);
});
// #endregion usage

// #region eager
// Answer the server's predicted end of turn ahead of the committed one.
const eager = new CartesiaTurnsSTTService({
  apiKey: process.env.CARTESIA_API_KEY ?? "",
  enableEagerEndOfTurn: true,
  settings: new CartesiaTurnsSTTService.Settings({
    turnStartThreshold: 0.8,
    turnEagerEndThreshold: 0.6,
    turnEndThreshold: 0.3,
  }),
});

eager.addEventHandler("on_turn_eager_end", async (_service, transcript: string) => {
  console.log("predicted end of turn:", transcript);
});
eager.addEventHandler("on_turn_resume", async () => {
  console.log("user kept speaking");
});
// #endregion eager
