// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// The global budget's bookkeeping, kept by the DemoBudget Durable Object (budget.ts). It caps
// sessions running at once, sessions and minutes per UTC day, and sessions per IP (as a keyed
// hash) in a 10-minute window.
//
// A ticket reserves a slot for TICKET_TTL_SECS; the session's WebSocket claims it, and the session
// releases it when it ends, reporting how long it ran. A reservation nobody claims lapses, and a
// session that never reports (its object was evicted) is dropped once it has outlived the longest
// session, charged at that length.

import type { BudgetLimits } from "./config.ts";
import { TICKET_TTL_SECS } from "./security.ts";

/** The window of the per-IP cap, in seconds. */
export const IP_WINDOW_SECS = 600;
/** Slack after the longest session before an unreported one is dropped, in seconds. */
const STALE_GRACE_SECS = 60;

export type Refusal = "busy" | "daily_sessions" | "daily_minutes" | "ip_limit";

export type Reservation = { ok: true } | { ok: false; reason: Refusal };

interface Slot {
  /** Unix ms the reservation lapses at, while unclaimed. */
  reservedUntil: number | null;
  /** Unix ms the session started at, once claimed. */
  startedAt: number | null;
}

export interface LedgerState {
  /** The UTC day the counters are for, `YYYY-MM-DD`. */
  day: string;
  sessionsToday: number;
  secondsToday: number;
  slots: Record<string, Slot>;
  /** Ticket times (Unix ms) per IP hash, within the IP window. */
  ips: Record<string, number[]>;
}

export function emptyLedger(now: number): LedgerState {
  return { day: utcDay(now), sessionsToday: 0, secondsToday: 0, slots: {}, ips: {} };
}

function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

/** The budget's bookkeeping, as plain functions over its state, so it can be tested on its own. */
export class BudgetLedger {
  state: LedgerState;
  readonly limits: BudgetLimits;

  constructor(state: LedgerState, limits: BudgetLimits) {
    this.state = state;
    this.limits = limits;
  }

  /** Start a new day, drop lapsed reservations, stale sessions and old IP entries. */
  #tidy(now: number): void {
    const day = utcDay(now);
    if (day !== this.state.day) {
      this.state.day = day;
      this.state.sessionsToday = 0;
      this.state.secondsToday = 0;
    }
    const staleAfter = (this.limits.sessionMaxSecs + STALE_GRACE_SECS) * 1000;
    for (const [id, slot] of Object.entries(this.state.slots)) {
      if (slot.startedAt === null && slot.reservedUntil !== null && slot.reservedUntil <= now) {
        delete this.state.slots[id];
      } else if (slot.startedAt !== null && now - slot.startedAt > staleAfter) {
        this.state.secondsToday += this.limits.sessionMaxSecs;
        delete this.state.slots[id];
      }
    }
    const windowStart = now - IP_WINDOW_SECS * 1000;
    for (const [ip, times] of Object.entries(this.state.ips)) {
      const recent = times.filter((t) => t > windowStart);
      if (recent.length > 0) this.state.ips[ip] = recent;
      else delete this.state.ips[ip];
    }
  }

  /** Reserve a slot for a new session, or say why not. */
  reserve(sessionId: string, ipHash: string, now: number): Reservation {
    this.#tidy(now);
    const slots = Object.values(this.state.slots);
    if (slots.length >= this.limits.maxConcurrent) return { ok: false, reason: "busy" };
    if (this.state.sessionsToday >= this.limits.maxSessionsPerDay) {
      return { ok: false, reason: "daily_sessions" };
    }
    // Count the sessions that are running (or about to) at their full length, so the day's
    // minutes can't be overrun by sessions already admitted.
    const committed = this.state.secondsToday + (slots.length + 1) * this.limits.sessionMaxSecs;
    if (committed > this.limits.maxMinutesPerDay * 60)
      return { ok: false, reason: "daily_minutes" };
    const ipTimes = this.state.ips[ipHash] ?? [];
    if (ipTimes.length >= this.limits.maxSessionsPerIp) return { ok: false, reason: "ip_limit" };

    this.state.slots[sessionId] = { reservedUntil: now + TICKET_TTL_SECS * 1000, startedAt: null };
    this.state.ips[ipHash] = [...ipTimes, now];
    this.state.sessionsToday += 1;
    return { ok: true };
  }

  /** Claim a reservation as its WebSocket opens. False if there is none (lapsed, or used). */
  start(sessionId: string, now: number): boolean {
    this.#tidy(now);
    const slot = this.state.slots[sessionId];
    if (!slot || slot.startedAt !== null) return false;
    slot.startedAt = now;
    slot.reservedUntil = null;
    return true;
  }

  /** Release a session's slot and charge the time it ran. */
  finish(sessionId: string, now: number): void {
    const slot = this.state.slots[sessionId];
    if (slot?.startedAt != null) {
      const secs = Math.min((now - slot.startedAt) / 1000, this.limits.sessionMaxSecs + 30);
      this.state.secondsToday += Math.max(0, Math.round(secs));
    }
    delete this.state.slots[sessionId];
    this.#tidy(now);
  }

  /** What the budget looks like now, for the status endpoint and the logs (no IPs). */
  snapshot(now: number): { active: number; sessionsToday: number; minutesToday: number } {
    this.#tidy(now);
    return {
      active: Object.keys(this.state.slots).length,
      sessionsToday: this.state.sessionsToday,
      minutesToday: Math.round(this.state.secondsToday / 6) / 10,
    };
  }
}
