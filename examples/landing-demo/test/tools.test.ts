// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// The demo's tools, against a fake fetch (Open-Meteo and llms.txt are not called), and the
// data-centre lookup.

import { beforeEach, describe, expect, test } from "bun:test";
import type { FunctionCallParams } from "@pipedog/core/services/llm_service";
import { clearColoCache, durableObjectColo, parseTraceColo } from "../src/colo.ts";
import {
  buildTools,
  capResult,
  clearDocsCache,
  getTime,
  getWeather,
  MAX_RESULT_CHARS,
  parseDocsIndex,
  rankDocs,
  searchDocs,
  type ToolContext,
  whereAmI,
} from "../src/tools.ts";
import { DOCS_INDEX, TRACE } from "./fakes.ts";

const URLS = {
  geocoding: "https://geo.test/v1/search",
  forecast: "https://forecast.test/v1/forecast",
  docsIndex: "https://docs.test/llms.txt",
};

/** A fetch that answers from `routes` by URL prefix, and records what was asked. */
function fakeFetch(routes: Record<string, (url: URL) => Response | Promise<Response>>) {
  const calls: string[] = [];
  const f = (async (input: string | URL | Request) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    calls.push(url.toString());
    for (const [prefix, answer] of Object.entries(routes)) {
      if (url.toString().startsWith(prefix)) return await answer(url);
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
  return { fetch: f, calls };
}

function context(f: typeof fetch, overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    fetch: f,
    urls: URLS,
    visitor: { colo: "CDG", country: "FR", city: "Paris" },
    botColo: async () => "MAD",
    endCall: async () => {},
    ...overrides,
  };
}

const weatherRoutes = {
  [URLS.geocoding]: (url: URL) =>
    url.searchParams.get("name") === "Atlantis"
      ? Response.json({ generationtime_ms: 0.1 })
      : Response.json({
          results: [
            {
              name: "Barcelona",
              admin1: "Catalonia",
              country: "Spain",
              latitude: 41.39,
              longitude: 2.16,
            },
          ],
        }),
  [URLS.forecast]: () =>
    Response.json({
      current: {
        time: "2026-10-23T15:00",
        temperature_2m: 21.3,
        apparent_temperature: 20.9,
        relative_humidity_2m: 55,
        weather_code: 61,
        wind_speed_10m: 9.4,
      },
    }),
};

describe("get_weather", () => {
  test("geocodes the city, then reads the current conditions", async () => {
    const { fetch: f, calls } = fakeFetch(weatherRoutes);
    const result = await getWeather(context(f), "Barcelona");
    expect(result).toEqual({
      place: "Barcelona, Catalonia, Spain",
      temperature_c: 21.3,
      feels_like_c: 20.9,
      humidity_percent: 55,
      wind_kmh: 9.4,
      conditions: "light rain",
      local_time: "2026-10-23T15:00",
    });
    expect(new URL(calls[0]!).searchParams.get("name")).toBe("Barcelona");
    const forecast = new URL(calls[1]!);
    expect(forecast.searchParams.get("latitude")).toBe("41.39");
    expect(forecast.searchParams.get("current")).toContain("temperature_2m");
  });

  test("an unknown place, a failing API and a timeout become errors for the LLM", async () => {
    const { fetch: f } = fakeFetch(weatherRoutes);
    expect(await getWeather(context(f), "Atlantis")).toEqual({
      error: "No place called Atlantis was found",
    });

    const { fetch: down } = fakeFetch({
      [URLS.geocoding]: () => new Response("busy", { status: 503 }),
    });
    expect(await getWeather(context(down), "Paris")).toEqual({
      error: "The weather lookup failed",
    });

    const slow = (async () => {
      throw new DOMException("The operation timed out.", "TimeoutError");
    }) as unknown as typeof fetch;
    expect(await getWeather(context(slow), "Paris")).toEqual({
      error: "The weather lookup timed out",
    });
  });
});

describe("get_time", () => {
  test("formats the time in the zone", () => {
    const now = new Date(Date.UTC(2026, 9, 23, 10, 5));
    const result = getTime("Asia/Tokyo", now) as Record<string, string>;
    expect(result.timezone).toBe("Asia/Tokyo");
    expect(result.time).toBe("19:05");
    // The punctuation varies with the runtime's ICU data.
    expect(result.date).toMatch(/^Friday,? 23 October 2026$/);
  });

  test("an unknown zone is an error", () => {
    expect(getTime("Mars/Olympus_Mons")).toEqual({
      error: "Unknown time zone Mars/Olympus_Mons. Use an IANA name such as Europe/Madrid.",
    });
  });
});

describe("where_am_i", () => {
  test("reports the bot's data centre and the visitor's entry point", async () => {
    const { fetch: f } = fakeFetch({});
    expect(await whereAmI(context(f))).toMatchObject({
      bot_data_center: "MAD",
      your_entry_data_center: "CDG",
      your_country: "FR",
      your_city: "Paris",
    });
    const unknown = await whereAmI(
      context(f, { botColo: async () => null, visitor: { colo: null, country: null, city: null } }),
    );
    expect(unknown).toMatchObject({ bot_data_center: "unknown", your_city: "unknown" });
  });
});

describe("search_docs", () => {
  beforeEach(() => clearDocsCache());

  test("parses llms.txt into pages, linking the pages rather than their Markdown", () => {
    const entries = parseDocsIndex(DOCS_INDEX);
    expect(entries).toHaveLength(5);
    expect(entries[0]).toEqual({
      title: "Introduction",
      url: "http://docs.test/pipedog/docs",
      description: "pipedog is an unofficial TypeScript port of Pipecat.",
      section: "Get started",
    });
    expect(entries[2]!.url).toBe("http://docs.test/pipedog/docs/concepts/turn-detection/");
    expect(entries[2]!.section).toBe("Core concepts");
  });

  test("ranks by keywords, titles first", () => {
    const entries = parseDocsIndex(DOCS_INDEX);
    expect(rankDocs(entries, "how does turn detection work?")[0]!.title).toBe("Turn detection");
    expect(rankDocs(entries, "deploy on cloudflare")[0]!.title).toBe(
      "Voice agent fully on Cloudflare",
    );
    expect(rankDocs(entries, "zod schema tools")[0]!.title).toBe("Typed tools");
    expect(rankDocs(entries, "the and of")).toEqual([]);
    expect(rankDocs(entries, "pipeline", 1)).toHaveLength(1);
  });

  test("fetches the index once and answers from the cache", async () => {
    const { fetch: f, calls } = fakeFetch({ [URLS.docsIndex]: () => new Response(DOCS_INDEX) });
    const first = (await searchDocs(context(f), "turn detection")) as {
      results: { title: string; url: string }[];
    };
    expect(first.results[0]).toMatchObject({
      title: "Turn detection",
      url: "http://docs.test/pipedog/docs/concepts/turn-detection/",
    });
    expect(first.results.length).toBeLessThanOrEqual(3);
    await searchDocs(context(f), "typed tools");
    expect(calls).toHaveLength(1);
    expect(await searchDocs(context(f), "kubernetes")).toEqual({
      results: [],
      note: "Nothing in the docs matched.",
    });
  });

  test("an unreachable index is an error", async () => {
    const { fetch: f } = fakeFetch({});
    expect(await searchDocs(context(f), "turns")).toEqual({ error: "The docs search failed" });
  });
});

describe("results", () => {
  test("results are capped", () => {
    const big = { text: "x".repeat(5000) };
    const capped = capResult(big) as { truncated: boolean; text: string };
    expect(capped.truncated).toBe(true);
    expect(JSON.stringify(capped).length).toBeLessThanOrEqual(MAX_RESULT_CHARS);
    expect(capResult({ a: 1 })).toEqual({ a: 1 });
  });
});

describe("tool definitions", () => {
  function params(args: Record<string, unknown>) {
    const results: { value: unknown; runLlm: boolean | null | undefined }[] = [];
    const p = {
      arguments: args,
      resultCallback: async (
        value: unknown,
        opts?: { properties?: { runLlm: boolean | null } | null },
      ) => {
        results.push({ value, runLlm: opts?.properties?.runLlm });
      },
    } as unknown as FunctionCallParams;
    return { p, results };
  }

  test("five tools, with JSON schemas from the Zod schemas", () => {
    const { fetch: f } = fakeFetch({});
    const tools = buildTools(context(f));
    expect(tools.map((t) => t.name)).toEqual([
      "get_weather",
      "get_time",
      "where_am_i",
      "search_docs",
      "end_call",
    ]);
    const weather = tools[0]!;
    expect(weather.required).toEqual(["city"]);
    expect((weather.properties.city as { type: string }).type).toBe("string");
  });

  test("invalid arguments don't reach the handler", async () => {
    const { fetch: f, calls } = fakeFetch(weatherRoutes);
    const [weather] = buildTools(context(f));
    const { p, results } = params({ city: 42 });
    await weather!.handler(p);
    expect(calls).toHaveLength(0);
    expect((results[0]!.value as { error: string }).error).toContain("Invalid arguments");
  });

  test("end_call reports its result without another LLM turn, then ends the call", async () => {
    let ended = 0;
    const { fetch: f } = fakeFetch({});
    const tools = buildTools(context(f, { endCall: async () => void ended++ }));
    const { p, results } = params({});
    await tools.find((t) => t.name === "end_call")!.handler(p);
    expect(results).toEqual([{ value: { ended: true }, runLlm: false }]);
    expect(ended).toBe(1);
  });
});

describe("data centre", () => {
  beforeEach(() => clearColoCache());

  test("parses colo= from /cdn-cgi/trace", () => {
    expect(parseTraceColo(TRACE)).toBe("MAD");
    expect(parseTraceColo("fl=1\nh=x\n")).toBeNull();
  });

  test("is fetched once, and retried after a failure", async () => {
    let calls = 0;
    let up = false;
    const f = (async () => {
      calls += 1;
      return up ? new Response(TRACE) : new Response("no", { status: 500 });
    }) as unknown as typeof fetch;
    expect(await durableObjectColo("https://trace.test", f)).toBeNull();
    up = true;
    expect(await durableObjectColo("https://trace.test", f)).toBe("MAD");
    expect(await durableObjectColo("https://trace.test", f)).toBe("MAD");
    expect(calls).toBe(2);
  });
});
