// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// The global budget as a Durable Object: one instance, named "global", that every ticket request
// and every session goes through. The bookkeeping is in ledger.ts.

import { DurableObject } from "cloudflare:workers";
import { type Env, readConfig } from "./config.ts";
import { BudgetLedger, emptyLedger, type LedgerState, type Reservation } from "./ledger.ts";

const STATE_KEY = "ledger";

/** The singleton budget Durable Object. Every method is one read-modify-write of its state. */
export class DemoBudget extends DurableObject<Env> {
  async #update<T>(fn: (ledger: BudgetLedger) => T): Promise<T> {
    const now = Date.now();
    const state = (await this.ctx.storage.get<LedgerState>(STATE_KEY)) ?? emptyLedger(now);
    const ledger = new BudgetLedger(state, readConfig(this.env).budget);
    const result = fn(ledger);
    await this.ctx.storage.put(STATE_KEY, ledger.state);
    return result;
  }

  async reserve(sessionId: string, ipHash: string): Promise<Reservation> {
    return await this.#update((l) => l.reserve(sessionId, ipHash, Date.now()));
  }

  async start(sessionId: string): Promise<boolean> {
    return await this.#update((l) => l.start(sessionId, Date.now()));
  }

  async finish(sessionId: string): Promise<void> {
    await this.#update((l) => l.finish(sessionId, Date.now()));
  }

  async snapshot(): Promise<{ active: number; sessionsToday: number; minutesToday: number }> {
    return await this.#update((l) => l.snapshot(Date.now()));
  }
}
