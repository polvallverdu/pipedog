// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// The global budget (ledger.ts) and the per-session limits (limits.ts).

import { describe, expect, test } from "bun:test";
import type { BudgetLimits } from "../src/config.ts";
import { BudgetLedger, emptyLedger, IP_WINDOW_SECS } from "../src/ledger.ts";
import { GOODBYE_LEAD_SECS, SessionLimits } from "../src/limits.ts";

const LIMITS: BudgetLimits = {
  maxConcurrent: 2,
  maxConcurrentPerIp: 5,
  maxSessionsPerDay: 5,
  maxMinutesPerDay: 10,
  maxSpendUsdPerMonth: 0,
  costPerMinuteUsd: 0.04,
  maxSessionsPerIp: 3,
  sessionMaxSecs: 120,
};
const T0 = Date.UTC(2026, 9, 23, 12, 0, 0);

function ledger(limits: Partial<BudgetLimits> = {}, now = T0) {
  return new BudgetLedger(emptyLedger(now), { ...LIMITS, ...limits });
}

describe("BudgetLedger", () => {
  test("caps concurrent sessions, and frees a slot when one finishes", () => {
    const l = ledger();
    expect(l.reserve("a", "ip1", T0)).toEqual({ ok: true });
    expect(l.reserve("b", "ip2", T0)).toEqual({ ok: true });
    expect(l.reserve("c", "ip3", T0)).toEqual({ ok: false, reason: "busy" });
    expect(l.start("a", T0 + 1000)).toBe(true);
    l.finish("a", T0 + 31_000);
    expect(l.reserve("c", "ip3", T0 + 31_000)).toEqual({ ok: true });
  });

  test("caps the estimated spend per month, and resets it next month", () => {
    // $1 at $0.05/min: 20 minutes, ten 2-minute sessions.
    const l = ledger({
      maxConcurrent: 0,
      maxSessionsPerIp: 100,
      maxSessionsPerDay: 0,
      maxMinutesPerDay: 0,
      maxSpendUsdPerMonth: 1,
      costPerMinuteUsd: 0.05,
    });
    for (let i = 0; i < 10; i++) {
      expect(l.reserve(`s${i}`, `ip${i}`, T0)).toEqual({ ok: true });
      expect(l.start(`s${i}`, T0)).toBe(true);
      l.finish(`s${i}`, T0 + 120_000);
    }
    expect(l.snapshot(T0 + 120_000).spendThisMonthUsd).toBe(1);
    expect(l.reserve("over", "ipx", T0 + 120_000)).toEqual({ ok: false, reason: "monthly_budget" });
    const nextMonth = Date.UTC(2026, 10, 1, 0, 1, 0);
    expect(l.reserve("over", "ipx", nextMonth)).toEqual({ ok: true });
    expect(l.snapshot(nextMonth).spendThisMonthUsd).toBe(0);
  });

  test("0 means no global cap", () => {
    const l = ledger({ maxConcurrent: 0, maxSessionsPerDay: 100, maxMinutesPerDay: 1000 });
    for (let i = 0; i < 20; i++) {
      expect(l.reserve(`s${i}`, `ip${i}`, T0)).toEqual({ ok: true });
    }
  });

  test("one IP gets one session at a time, and another once it ends", () => {
    const l = ledger({ maxConcurrent: 0, maxConcurrentPerIp: 1 });
    expect(l.reserve("a", "same-ip", T0)).toEqual({ ok: true });
    expect(l.reserve("b", "same-ip", T0 + 1000)).toEqual({ ok: false, reason: "ip_busy" });
    expect(l.reserve("c", "other-ip", T0 + 1000)).toEqual({ ok: true });
    expect(l.start("a", T0 + 2000)).toBe(true);
    l.finish("a", T0 + 30_000);
    expect(l.reserve("b", "same-ip", T0 + 30_000)).toEqual({ ok: true });
  });

  test("an unclaimed reservation lapses after the ticket's lifetime", () => {
    const l = ledger({ maxConcurrent: 1 });
    expect(l.reserve("a", "ip1", T0).ok).toBe(true);
    expect(l.reserve("b", "ip2", T0 + 30_000)).toEqual({ ok: false, reason: "busy" });
    expect(l.reserve("b", "ip2", T0 + 61_000).ok).toBe(true);
    // The lapsed one can't be claimed any more.
    expect(l.start("a", T0 + 62_000)).toBe(false);
  });

  test("a reservation is claimed once", () => {
    const l = ledger();
    l.reserve("a", "ip1", T0);
    expect(l.start("a", T0 + 100)).toBe(true);
    expect(l.start("a", T0 + 200)).toBe(false);
    expect(l.start("never-reserved", T0)).toBe(false);
  });

  test("caps sessions per day, and resets at UTC midnight", () => {
    const l = ledger({ maxConcurrent: 10, maxSessionsPerIp: 10, maxMinutesPerDay: 1000 });
    for (let i = 0; i < 5; i++) {
      expect(l.reserve(`s${i}`, `ip${i}`, T0).ok).toBe(true);
      l.start(`s${i}`, T0);
      l.finish(`s${i}`, T0 + 10_000);
    }
    expect(l.reserve("s5", "ip5", T0)).toEqual({ ok: false, reason: "daily_sessions" });
    const tomorrow = Date.UTC(2026, 9, 24, 0, 0, 1);
    expect(l.reserve("s5", "ip5", tomorrow).ok).toBe(true);
    expect(l.snapshot(tomorrow).sessionsToday).toBe(1);
  });

  test("caps minutes per day, counting running sessions at their full length", () => {
    // 10 minutes a day, 2-minute sessions.
    const l = ledger({ maxConcurrent: 10, maxSessionsPerIp: 10, maxSessionsPerDay: 100 });
    // Four sessions that ran 2 minutes each: 8 minutes used.
    for (let i = 0; i < 4; i++) {
      l.reserve(`s${i}`, `ip${i}`, T0);
      l.start(`s${i}`, T0);
      l.finish(`s${i}`, T0 + 120_000);
    }
    expect(l.snapshot(T0 + 120_000).minutesToday).toBe(8);
    // A fifth fits (10 minutes); a sixth, while the fifth may still run 2 minutes, doesn't.
    expect(l.reserve("s4", "ip4", T0 + 120_000).ok).toBe(true);
    expect(l.reserve("s5", "ip5", T0 + 120_000)).toEqual({ ok: false, reason: "daily_minutes" });
  });

  test("caps sessions per IP in a 10-minute window", () => {
    const l = ledger({ maxConcurrent: 10 });
    for (let i = 0; i < 3; i++) {
      expect(l.reserve(`s${i}`, "same-ip", T0 + i).ok).toBe(true);
      l.start(`s${i}`, T0 + i);
      l.finish(`s${i}`, T0 + i + 5000);
    }
    expect(l.reserve("s3", "same-ip", T0 + 10_000)).toEqual({ ok: false, reason: "ip_limit" });
    expect(l.reserve("s3", "another-ip", T0 + 10_000).ok).toBe(true);
    expect(l.reserve("s4", "same-ip", T0 + IP_WINDOW_SECS * 1000 + 10).ok).toBe(true);
  });

  test("a session that never reports is dropped and charged at the longest length", () => {
    const l = ledger({ maxConcurrent: 1 });
    l.reserve("a", "ip1", T0);
    l.start("a", T0);
    expect(l.reserve("b", "ip2", T0 + 120_000)).toEqual({ ok: false, reason: "busy" });
    // Past the longest session plus a minute's grace, the slot is reclaimed.
    expect(l.reserve("b", "ip2", T0 + 181_000).ok).toBe(true);
    expect(l.snapshot(T0 + 181_000).minutesToday).toBe(2);
  });

  test("time charged is capped, so a stuck session can't eat the day", () => {
    const l = ledger();
    l.reserve("a", "ip1", T0);
    l.start("a", T0);
    l.finish("a", T0 + 3_600_000);
    expect(l.state.secondsToday).toBe(150);
  });

  test("the state is plain JSON (it's stored as is)", () => {
    const l = ledger();
    l.reserve("a", "ip1", T0);
    expect(JSON.parse(JSON.stringify(l.state))).toEqual(l.state);
    expect(JSON.stringify(l.snapshot(T0))).not.toContain("ip1");
  });
});

describe("SessionLimits", () => {
  const config = { maxSecs: 120, idleSecs: 30, maxTurns: 3 };

  test("ends for time shortly before the hard limit, so the goodbye fits", () => {
    const s = new SessionLimits(config, 0);
    s.userStarted(1);
    expect(s.tick(120 - GOODBYE_LEAD_SECS - 1)).toBeNull();
    expect(s.tick(120 - GOODBYE_LEAD_SECS)).toBe("time");
    expect(s.tick(130)).toBeNull();
    expect(s.ended).toBe("time");
  });

  test("ends when no one has spoken for the idle timeout", () => {
    const s = new SessionLimits(config, 0);
    s.botStarted(1);
    s.botStopped(5);
    expect(s.tick(34)).toBeNull();
    expect(s.tick(35)).toBe("idle");
  });

  test("speech keeps the session alive, however long it is", () => {
    const s = new SessionLimits(config, 0);
    s.userStarted(1);
    expect(s.tick(60)).toBeNull();
    s.userStopped(61);
    s.botStarted(62);
    expect(s.tick(100)).toBeNull();
  });

  test("ends after the reply to the last turn allowed", () => {
    const s = new SessionLimits(config, 0);
    for (let turn = 1; turn <= 3; turn++) {
      s.userStarted(turn * 10);
      s.userStopped(turn * 10 + 2);
      s.botStarted(turn * 10 + 3);
      const reason = s.botStopped(turn * 10 + 5);
      expect(reason).toBe(turn === 3 ? "turns" : null);
    }
    expect(s.turns).toBe(3);
  });

  test("ends once, whatever ends it", () => {
    const s = new SessionLimits(config, 0);
    expect(s.end("goodbye")).toBe("goodbye");
    expect(s.end("time")).toBeNull();
    expect(s.tick(200)).toBeNull();
    expect(s.ended).toBe("goodbye");
  });
});
