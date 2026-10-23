// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Small display helpers: data-centre names, numbers, and one-line summaries of tool results.

/** Cities of common Cloudflare data centres (IATA codes). Others show as the code alone. */
const COLOS: Record<string, string> = {
  AMS: "Amsterdam",
  ARN: "Stockholm",
  ATL: "Atlanta",
  BCN: "Barcelona",
  BOM: "Mumbai",
  BOS: "Boston",
  BRU: "Brussels",
  CDG: "Paris",
  CPH: "Copenhagen",
  DEL: "New Delhi",
  DEN: "Denver",
  DFW: "Dallas",
  DUB: "Dublin",
  DUS: "Düsseldorf",
  EWR: "Newark",
  FRA: "Frankfurt",
  GRU: "São Paulo",
  HAM: "Hamburg",
  HEL: "Helsinki",
  HKG: "Hong Kong",
  IAD: "Ashburn",
  ICN: "Seoul",
  IST: "Istanbul",
  JNB: "Johannesburg",
  KIX: "Osaka",
  LAX: "Los Angeles",
  LHR: "London",
  LIS: "Lisbon",
  MAD: "Madrid",
  MAN: "Manchester",
  MEL: "Melbourne",
  MEX: "Mexico City",
  MIA: "Miami",
  MIL: "Milan",
  MRS: "Marseille",
  MUC: "Munich",
  MXP: "Milan",
  NRT: "Tokyo",
  ORD: "Chicago",
  OSL: "Oslo",
  PRG: "Prague",
  SEA: "Seattle",
  SFO: "San Francisco",
  SIN: "Singapore",
  SJC: "San José",
  SYD: "Sydney",
  TPE: "Taipei",
  VIE: "Vienna",
  WAW: "Warsaw",
  YUL: "Montréal",
  YVR: "Vancouver",
  YYZ: "Toronto",
  ZRH: "Zürich",
};

export function coloName(code: string | null | undefined): string | null {
  return code ? (COLOS[code.toUpperCase()] ?? null) : null;
}

/** Milliseconds, as "38 ms" or "1.24 s". */
export function ms(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return value < 1000 ? `${Math.round(value)} ms` : `${(value / 1000).toFixed(2)} s`;
}

/** A tool's result in a line, for its card. */
export function summarizeResult(name: string, result: unknown): string {
  if (result === null || result === undefined) return "";
  const r = result as Record<string, any>;
  if (typeof r === "object" && typeof r.error === "string") return r.error;
  if (name === "get_weather" && r.place) {
    const t = r.temperature_c === null ? "" : `${Math.round(r.temperature_c)} °C · `;
    return `${t}${r.conditions} · ${r.place}`;
  }
  if (name === "get_time" && r.time) return `${r.time} · ${r.date}`;
  if (name === "where_am_i") {
    const you = [r.your_city, r.your_country].filter((x) => x && x !== "unknown").join(", ");
    return `bot in ${r.bot_data_center} · you via ${r.your_entry_data_center}${you ? ` (${you})` : ""}`;
  }
  if (name === "search_docs" && Array.isArray(r.results)) {
    const n = r.results.length;
    return n ? `${n} ${n === 1 ? "page" : "pages"} in the docs` : (r.note ?? "no results");
  }
  if (name === "end_call") return "ending the call";
  const json = JSON.stringify(result);
  return json.length > 140 ? `${json.slice(0, 140)}…` : json;
}

/** Links in a docs search result, for its card. */
export function resultLinks(name: string, result: unknown): { title: string; url: string }[] {
  if (name !== "search_docs") return [];
  const r = result as { results?: { title: string; url: string }[] } | null;
  return (r?.results ?? []).filter((x) => /^https?:\/\//.test(x.url)).slice(0, 3);
}

/** Tool arguments, compactly: `city: "Paris"`. */
export function formatArgs(args: Record<string, unknown> | null): string {
  if (!args) return "";
  return Object.entries(args)
    .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
    .join(", ");
}
