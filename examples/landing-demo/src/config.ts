// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// The Worker's bindings, secrets and vars, and the limits read from them.

import type { DemoBudget } from "./budget.ts";
import type { DemoSession } from "./session.ts";

/** The part of the Workers Rate Limiting binding the demo uses. */
export interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface Env {
  AI: Ai;
  /** The demo page (the SvelteKit build), as Workers Static Assets. */
  ASSETS: Fetcher;
  DEMO_SESSION: DurableObjectNamespace<DemoSession>;
  DEMO_BUDGET: DurableObjectNamespace<DemoBudget>;
  SESSION_RATE_LIMITER?: RateLimiter;

  // Secrets
  ANTHROPIC_API_KEY: string;
  TURNSTILE_SECRET_KEY?: string;
  SESSION_SIGNING_KEY: string;
  /** Cloudflare Realtime SFU app (Dashboard > Realtime > SFU). Without them, WebRTC is off. */
  CLOUDFLARE_REALTIME_APP_ID?: string;
  CLOUDFLARE_REALTIME_APP_SECRET?: string;

  // Vars (wrangler.jsonc)
  DEMO_ENABLED?: string;
  /** Turnstile's site key (public), handed to the page by /api/status. */
  TURNSTILE_SITE_KEY?: string;
  /** Origins besides the demo's own that may use the API (e.g. Vite's dev server). */
  ALLOWED_ORIGINS?: string;
  /** Who may embed the page in an iframe (CSP frame-ancestors), besides the demo itself. */
  FRAME_ANCESTORS?: string;
  MAX_CONCURRENT_SESSIONS?: string;
  MAX_CONCURRENT_SESSIONS_PER_IP?: string;
  MAX_SESSIONS_PER_DAY?: string;
  MAX_SPEND_USD_PER_MONTH?: string;
  COST_PER_MINUTE_USD?: string;
  MAX_MINUTES_PER_DAY?: string;
  MAX_SESSIONS_PER_IP?: string;
  SESSION_MAX_SECS?: string;
  SESSION_IDLE_SECS?: string;
  SESSION_MAX_TURNS?: string;

  /** "true" skips Turnstile and honors the test overrides below. Never set it in production. */
  DEMO_DEV_MODE?: string;
  // Test overrides, read only in dev mode: where the fakes are.
  ANTHROPIC_BASE_URL?: string;
  FAKE_AI_URL?: string;
  TURNSTILE_VERIFY_URL?: string;
  OPEN_METEO_GEOCODING_URL?: string;
  OPEN_METEO_FORECAST_URL?: string;
  DOCS_INDEX_URL?: string;
  TRACE_URL?: string;
  CLOUDFLARE_REALTIME_API_URL?: string;
}

/** The model the demo talks to, and how much it may say per reply. */
export const LLM_MODEL = "claude-haiku-5-5";
export const LLM_MAX_TOKENS = 400;

export const DEFAULT_URLS = {
  turnstileVerify: "https://challenges.cloudflare.com/turnstile/v0/siteverify",
  geocoding: "https://geocoding-api.open-meteo.com/v1/search",
  forecast: "https://api.open-meteo.com/v1/forecast",
  docsIndex: "https://polvallverdu.github.io/pipedog/llms.txt",
  trace: "https://www.cloudflare.com/cdn-cgi/trace",
} as const;

export interface DemoConfig {
  enabled: boolean;
  devMode: boolean;
  /** Whether WebRTC sessions (through Cloudflare Realtime) can be offered. */
  webrtc: boolean;
  /** The Realtime API base URL; null for the default. */
  realtimeApiUrl: string | null;
  /** Extra origins allowed to use the API; the demo's own origin always is. */
  allowedOrigins: string[];
  frameAncestors: string[];
  turnstileSiteKey: string | null;
  budget: BudgetLimits;
  session: SessionLimitsConfig;
  urls: { [K in keyof typeof DEFAULT_URLS]: string };
}

export interface BudgetLimits {
  /** Sessions at once across everyone; 0 for no cap (the daily limits still bound the cost). */
  maxConcurrent: number;
  /** Sessions at once from one IP. */
  maxConcurrentPerIp: number;
  /** Sessions per UTC day; 0 for no cap. */
  maxSessionsPerDay: number;
  /** Session minutes per UTC day; 0 for no cap. */
  maxMinutesPerDay: number;
  /** Estimated spend per UTC month, in USD; 0 for no cap. */
  maxSpendUsdPerMonth: number;
  /** What a minute of session costs, for the estimate: Workers AI (Flux, Aura) plus the LLM. */
  costPerMinuteUsd: number;
  /** Sessions per IP in IP_WINDOW_SECS. */
  maxSessionsPerIp: number;
  /** The longest a session runs, which a reservation assumes it will. */
  sessionMaxSecs: number;
}

export interface SessionLimitsConfig {
  maxSecs: number;
  idleSecs: number;
  maxTurns: number;
}

function positiveInt(value: string | undefined, fallback: number): number {
  const n = Number.parseInt(value ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function positiveNumber(value: string | undefined, fallback: number): number {
  const n = Number.parseFloat(value ?? "");
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function nonNegativeNumber(value: string | undefined, fallback: number): number {
  const n = Number.parseFloat(value ?? "");
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function nonNegativeInt(value: string | undefined, fallback: number): number {
  const n = Number.parseInt(value ?? "", 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function list(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((o) => o.trim().replace(/\/+$/, ""))
    .filter(Boolean);
}

/** Read the configuration from the environment, with the defaults for anything unset. */
export function readConfig(env: Env): DemoConfig {
  const devMode = env.DEMO_DEV_MODE === "true";
  const sessionMaxSecs = positiveInt(env.SESSION_MAX_SECS, 120);
  const override = (value: string | undefined, fallback: string) =>
    devMode && value ? value : fallback;
  return {
    enabled: env.DEMO_ENABLED === "true",
    devMode,
    webrtc: Boolean(env.CLOUDFLARE_REALTIME_APP_ID && env.CLOUDFLARE_REALTIME_APP_SECRET),
    realtimeApiUrl:
      devMode && env.CLOUDFLARE_REALTIME_API_URL ? env.CLOUDFLARE_REALTIME_API_URL : null,
    allowedOrigins: list(env.ALLOWED_ORIGINS),
    frameAncestors: list(env.FRAME_ANCESTORS),
    turnstileSiteKey: env.TURNSTILE_SITE_KEY || null,
    budget: {
      maxConcurrent: nonNegativeInt(env.MAX_CONCURRENT_SESSIONS, 0),
      maxConcurrentPerIp: positiveInt(env.MAX_CONCURRENT_SESSIONS_PER_IP, 1),
      maxSessionsPerDay: nonNegativeInt(env.MAX_SESSIONS_PER_DAY, 0),
      maxMinutesPerDay: nonNegativeInt(env.MAX_MINUTES_PER_DAY, 0),
      maxSpendUsdPerMonth: nonNegativeNumber(env.MAX_SPEND_USD_PER_MONTH, 500),
      costPerMinuteUsd: positiveNumber(env.COST_PER_MINUTE_USD, 0.04),
      maxSessionsPerIp: positiveInt(env.MAX_SESSIONS_PER_IP, 4),
      sessionMaxSecs,
    },
    session: {
      maxSecs: sessionMaxSecs,
      idleSecs: positiveInt(env.SESSION_IDLE_SECS, 30),
      maxTurns: positiveInt(env.SESSION_MAX_TURNS, 12),
    },
    urls: {
      turnstileVerify: override(env.TURNSTILE_VERIFY_URL, DEFAULT_URLS.turnstileVerify),
      geocoding: override(env.OPEN_METEO_GEOCODING_URL, DEFAULT_URLS.geocoding),
      forecast: override(env.OPEN_METEO_FORECAST_URL, DEFAULT_URLS.forecast),
      docsIndex: override(env.DOCS_INDEX_URL, DEFAULT_URLS.docsIndex),
      trace: override(env.TRACE_URL, DEFAULT_URLS.trace),
    },
  };
}
