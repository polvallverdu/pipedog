// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// The demo's tools, defined with `defineTool` and Zod: the JSON schema Claude sees, the handler's
// argument types and the validation of what Claude sends all come from one schema.
//
// All of them are safe to call from the public internet: no keys, short timeouts, and small results
// (each is capped at MAX_RESULT_CHARS).

import { rethrowIfCancelled } from "@pipedog/asyncio";
import { defineTool, type ToolDefinition } from "@pipedog/core/adapters/llm/schemas/standard_tool";
import { FunctionCallResultProperties } from "@pipedog/core/frames/frames";
import { z } from "zod";

/** Seconds a tool may run before the LLM service cancels it. */
const TOOL_TIMEOUT_SECS = 8;
/** Milliseconds each outgoing request may take. */
const FETCH_TIMEOUT_MS = 4000;
/** Longest tool result, in characters of JSON. */
export const MAX_RESULT_CHARS = 1500;
/** How long the docs index is kept, in milliseconds. */
const DOCS_TTL_MS = 60 * 60 * 1000;

/** Where a visitor entered Cloudflare's network, from `request.cf`. */
export interface VisitorInfo {
  colo: string | null;
  country: string | null;
  city: string | null;
}

export interface ToolContext {
  fetch: typeof fetch;
  urls: { geocoding: string; forecast: string; docsIndex: string };
  visitor: VisitorInfo;
  /** The data centre this session's Durable Object runs in, once known. */
  botColo: () => Promise<string | null>;
  /** Say goodbye and end the session. */
  endCall: () => Promise<void>;
  /** Clock, for tests. */
  now?: () => Date;
}

/** Cut a result down to `MAX_RESULT_CHARS` of JSON, keeping it valid JSON. */
export function capResult(result: unknown): unknown {
  const json = JSON.stringify(result);
  if (json.length <= MAX_RESULT_CHARS) return result;
  return { truncated: true, text: json.slice(0, MAX_RESULT_CHARS - 40) };
}

async function getJson(ctx: ToolContext, url: string): Promise<unknown> {
  const response = await ctx.fetch(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return await response.json();
}

function errorResult(what: string, e: unknown): { error: string } {
  rethrowIfCancelled(e);
  const reason = e instanceof Error && e.name === "TimeoutError" ? "timed out" : "failed";
  return { error: `${what} ${reason}` };
}

/** WMO weather interpretation codes, as Open-Meteo reports them. */
const WEATHER_CODES: Record<number, string> = {
  0: "clear sky",
  1: "mainly clear",
  2: "partly cloudy",
  3: "overcast",
  45: "fog",
  48: "freezing fog",
  51: "light drizzle",
  53: "drizzle",
  55: "heavy drizzle",
  56: "freezing drizzle",
  57: "freezing drizzle",
  61: "light rain",
  63: "rain",
  65: "heavy rain",
  66: "freezing rain",
  67: "freezing rain",
  71: "light snow",
  73: "snow",
  75: "heavy snow",
  77: "snow grains",
  80: "light showers",
  81: "showers",
  82: "violent showers",
  85: "snow showers",
  86: "heavy snow showers",
  95: "thunderstorm",
  96: "thunderstorm with hail",
  99: "thunderstorm with heavy hail",
};

interface GeocodingResult {
  name: string;
  country?: string;
  admin1?: string;
  latitude: number;
  longitude: number;
}

/** The current weather in `city`, from Open-Meteo (geocoding, then forecast). */
export async function getWeather(ctx: ToolContext, city: string): Promise<unknown> {
  try {
    const geocodingUrl = new URL(ctx.urls.geocoding);
    geocodingUrl.search = new URLSearchParams({
      name: city,
      count: "1",
      language: "en",
      format: "json",
    }).toString();
    const geo = (await getJson(ctx, geocodingUrl.toString())) as { results?: GeocodingResult[] };
    const place = geo.results?.[0];
    if (!place) return { error: `No place called ${city} was found` };

    const forecastUrl = new URL(ctx.urls.forecast);
    forecastUrl.search = new URLSearchParams({
      latitude: String(place.latitude),
      longitude: String(place.longitude),
      current:
        "temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m",
      timezone: "auto",
    }).toString();
    const forecast = (await getJson(ctx, forecastUrl.toString())) as {
      current?: Record<string, number | string>;
      timezone?: string;
    };
    const current = forecast.current ?? {};
    return capResult({
      place: [place.name, place.admin1, place.country].filter(Boolean).join(", "),
      temperature_c: current.temperature_2m ?? null,
      feels_like_c: current.apparent_temperature ?? null,
      humidity_percent: current.relative_humidity_2m ?? null,
      wind_kmh: current.wind_speed_10m ?? null,
      conditions: WEATHER_CODES[Number(current.weather_code)] ?? "unknown",
      local_time: current.time ?? null,
    });
  } catch (e) {
    return errorResult("The weather lookup", e);
  }
}

/** The current time in an IANA time zone. */
export function getTime(timezone: string, now: Date = new Date()): unknown {
  try {
    const time = new Intl.DateTimeFormat("en-GB", {
      timeZone: timezone,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(now);
    const date = new Intl.DateTimeFormat("en-GB", {
      timeZone: timezone,
      weekday: "long",
      day: "numeric",
      month: "long",
      year: "numeric",
    }).format(now);
    return { timezone, time, date };
  } catch {
    return { error: `Unknown time zone ${timezone}. Use an IANA name such as Europe/Madrid.` };
  }
}

/** Where this conversation is running: the bot's data centre and the visitor's entry point. */
export async function whereAmI(ctx: ToolContext): Promise<unknown> {
  return {
    bot_data_center: (await ctx.botColo()) ?? "unknown",
    your_entry_data_center: ctx.visitor.colo ?? "unknown",
    your_country: ctx.visitor.country ?? "unknown",
    your_city: ctx.visitor.city ?? "unknown",
    note: "Data centres are IATA airport codes. The visitor's location comes from Cloudflare's IP geolocation.",
  };
}

export interface DocsEntry {
  title: string;
  url: string;
  description: string;
  section: string;
}

/** Parse the docs' llms.txt: `- [Title](url): description` lines under `- **Section**` headings. */
export function parseDocsIndex(text: string): DocsEntry[] {
  const entries: DocsEntry[] = [];
  let section = "";
  for (const line of text.split("\n")) {
    const heading = /^- \*\*(.+)\*\*\s*$/.exec(line);
    if (heading) {
      section = heading[1]!;
      continue;
    }
    const entry = /^- \[([^\]]+)\]\(([^)]+)\)(?::\s*(.*))?$/.exec(line);
    if (entry) {
      entries.push({
        title: entry[1]!,
        // The index links to each page's Markdown; people want the page.
        url: entry[2]!.replace(/\.md$/, "/").replace(/\/docs\/$/, "/docs"),
        description: (entry[3] ?? "").trim(),
        section,
      });
    }
  }
  return entries;
}

const STOP_WORDS = new Set(
  "a an and are can do does for how i in is it of on or the to what with you your pipedog".split(
    " ",
  ),
);

function terms(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !STOP_WORDS.has(t));
}

/** Rank the entries for `query`: keyword matches, weighted title > section > description > URL. */
export function rankDocs(entries: DocsEntry[], query: string, limit = 3): DocsEntry[] {
  const wanted = terms(query);
  if (wanted.length === 0) return [];
  const scored = entries.map((entry) => {
    const title = terms(entry.title);
    const description = terms(entry.description);
    const section = terms(entry.section);
    const url = terms(entry.url.replace(/^https?:\/\/[^/]+/, ""));
    let score = 0;
    for (const w of wanted) {
      const prefix = (t: string) => t === w || (w.length >= 4 && t.startsWith(w));
      if (title.some(prefix)) score += 3;
      if (section.some(prefix)) score += 1;
      if (description.some(prefix)) score += 1.5;
      if (url.some(prefix)) score += 1;
    }
    return { entry, score };
  });
  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => s.entry);
}

/** A per-isolate cache of the docs index, shared by the sessions of a Durable Object's isolate. */
let docsCache: { at: number; url: string; entries: DocsEntry[] } | null = null;

/** Forget the cached docs index (tests). */
export function clearDocsCache(): void {
  docsCache = null;
}

/** Search the pipedog docs for `query`, returning a few pages with their URLs. */
export async function searchDocs(ctx: ToolContext, query: string): Promise<unknown> {
  try {
    const now = Date.now();
    if (!docsCache || docsCache.url !== ctx.urls.docsIndex || now - docsCache.at > DOCS_TTL_MS) {
      const response = await ctx.fetch(ctx.urls.docsIndex, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      docsCache = {
        at: now,
        url: ctx.urls.docsIndex,
        entries: parseDocsIndex(await response.text()),
      };
    }
    const hits = rankDocs(docsCache.entries, query);
    if (hits.length === 0) return { results: [], note: "Nothing in the docs matched." };
    return capResult({
      results: hits.map((h) => ({
        title: h.title,
        url: h.url,
        snippet: h.description.slice(0, 220),
      })),
    });
  } catch (e) {
    return errorResult("The docs search", e);
  }
}

/** The tools, bound to one session. */
export function buildTools(ctx: ToolContext): ToolDefinition[] {
  return [
    defineTool({
      name: "get_weather",
      description: "Get the current weather in a city (temperature in Celsius, conditions, wind).",
      parameters: z.object({
        city: z.string().min(1).max(80).describe("City name, e.g. 'Barcelona' or 'Tokyo'"),
      }),
      timeoutSecs: TOOL_TIMEOUT_SECS,
      handler: async ({ city }) => await getWeather(ctx, city),
    }),
    defineTool({
      name: "get_time",
      description: "Get the current local time and date in a time zone.",
      parameters: z.object({
        timezone: z
          .string()
          .min(1)
          .max(64)
          .describe("IANA time zone, e.g. 'Europe/Madrid' or 'America/New_York'"),
      }),
      timeoutSecs: TOOL_TIMEOUT_SECS,
      handler: async ({ timezone }) => getTime(timezone, ctx.now?.() ?? new Date()),
    }),
    defineTool({
      name: "where_am_i",
      description:
        "Tell where this conversation runs: the Cloudflare data centre running the bot, and the data centre, country and city the user connected through.",
      parameters: z.object({}),
      timeoutSecs: TOOL_TIMEOUT_SECS,
      handler: async () => await whereAmI(ctx),
    }),
    defineTool({
      name: "search_docs",
      description:
        "Search the pipedog documentation. Returns up to three pages with a short description and URL.",
      parameters: z.object({
        query: z.string().min(1).max(200).describe("What to look for, e.g. 'turn detection'"),
      }),
      timeoutSecs: TOOL_TIMEOUT_SECS,
      handler: async ({ query }) => await searchDocs(ctx, query),
    }),
    defineTool({
      name: "end_call",
      description:
        "End the conversation when the user says goodbye or asks to stop. The demo says goodbye itself.",
      parameters: z.object({}),
      timeoutSecs: TOOL_TIMEOUT_SECS,
      handler: async (_args, params) => {
        // The goodbye is spoken by endCall; the LLM doesn't need another turn.
        await params.resultCallback(
          { ended: true },
          { properties: new FunctionCallResultProperties({ runLlm: false }) },
        );
        await ctx.endCall();
      },
    }),
  ];
}
