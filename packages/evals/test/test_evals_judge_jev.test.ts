// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_evals_judge_jev.py

/** The judge over a Jev classifier: what goes on the wire, and what comes back. */

import { describe, expect, test } from "bun:test";

import type { HttpClient } from "@pipedog/core/classifiers/http_client";
import { JevClassifier } from "@pipedog/core/classifiers/typesafe/jev/classifier";
import { DEFAULT_MODEL, JevClient } from "@pipedog/core/classifiers/typesafe/jev/client";

import { EvalJudge, type EvalJudgeOptions } from "../src/judge.ts";
import type { ServiceConfig } from "../src/services.ts";

type Body = Record<string, unknown> & { state: Record<string, unknown> };
type Reply = [number, Record<string, unknown>] | Error;

interface RecordedRequest {
  method: string;
  url: string;
  body?: Body;
  headers?: Headers;
}

/** The client's HTTP client, protected in the port (upstream's `client._http`). */
function http(client: JevClient): HttpClient {
  return (client as unknown as { _http: HttpClient })._http;
}

/**
 * Stands in for Jev's API behind a mock transport: records each request and answers it.
 *
 * Answers come from a queue, or from a function of the request body when the
 * order requests arrive in isn't fixed. A queued exception is raised, as the
 * transport would on a timeout.
 */
class _FakeApi {
  protected _responses: Reply[] | ((body: Body) => Reply);
  requests: RecordedRequest[] = [];

  constructor(responses: Reply[] | ((body: Body) => Reply)) {
    this._responses = typeof responses === "function" ? responses : [...responses];
  }

  handle(url: string, init: RequestInit = {}): Response {
    if ((init.method ?? "GET") === "GET") {
      this.requests.push({ method: "GET", url });
      return Response.json({ models: [] }, { status: 200 });
    }
    const body = JSON.parse(String(init.body)) as Body;
    this.requests.push({ method: "POST", url, body, headers: new Headers(init.headers) });
    const response =
      typeof this._responses === "function"
        ? this._responses(body)
        : (this._responses.shift() as Reply);
    if (response instanceof Error) {
      throw response;
    }
    const [status, payload] = response;
    return Response.json(payload, { status });
  }

  get posts(): RecordedRequest[] {
    return this.requests.filter((r) => r.method === "POST");
  }

  /** Swap this API in as `client`'s transport (upstream's `httpx.MockTransport`). */
  install(client: JevClient): JevClient {
    http(client).transport = (async (input: string | URL | Request, init?: RequestInit) =>
      this.handle(String(input), init)) as typeof fetch;
    return client;
  }

  client(): JevClient {
    return this.install(new JevClient({ apiKey: "k" }));
  }

  classifier(): JevClassifier {
    return new JevClassifier({ client: this.client() });
  }
}

function _choice(choice: string, confidence = 0.95): Record<string, unknown> {
  const others = ["yes", "no", "continue"].filter((c) => c !== choice);
  const rest = (1 - confidence) / 2;
  const probabilities = {
    [choice]: confidence,
    ...Object.fromEntries(others.map((c) => [c, rest])),
  };
  return { type: "choice", choice, confidence, probabilities };
}

function _noul(p: number): Record<string, unknown> {
  return { type: "noul", noul: p };
}

function _turn(meets: number): Record<string, unknown> {
  const probabilities: Record<string, number> = {
    meets,
    fails: 1 - meets,
    not_applicable: 0.0,
  };
  // Python's max(..., key=...): the first of the highest.
  let choice = "";
  for (const [k, v] of Object.entries(probabilities)) {
    if (choice === "" || v > (probabilities[choice] as number)) choice = k;
  }
  return { type: "choice", choice, confidence: probabilities[choice], probabilities };
}

function _ok(answers: Record<string, unknown>): [number, Record<string, unknown>] {
  return [200, { model: "jev-1", answers, usage: {} }];
}

function _judge(
  responses: Reply[] | ((body: Body) => Reply),
  options: EvalJudgeOptions = {},
): [EvalJudge, _FakeApi] {
  const api = new _FakeApi(responses);
  return [new EvalJudge(api.classifier(), options), api];
}

/** A `httpx.ReadTimeout` from the transport. */
function readTimeout(message: string): Error {
  return new Error(message);
}

const _FACTORY = `${import.meta.path}.typesafeClassifier`;

// The API the factory's classifier talks to while `_configJudge` runs
// (upstream patches `JevClient` in the classifier's module).
let _patchedApi: _FakeApi | null = null;

/** A factory like the release evals' own, over the patched client. */
export function typesafeClassifier(config: ServiceConfig): JevClassifier {
  const apiKey = process.env.TYPESAFE_API_KEY;
  if (!apiKey) {
    throw new Error("no key");
  }
  const classifier = new JevClassifier({
    apiKey,
    model: (config.model as string | undefined) || DEFAULT_MODEL,
    timeout: 2.5,
  });
  _patchedApi?.install(classifier.client);
  return classifier;
}

/** Run `fn` with the environment variable `name` set to `value`, or unset. */
async function withEnv<T>(name: string, value: string | undefined, fn: () => Promise<T>) {
  const saved = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    return await fn();
  } finally {
    if (saved === undefined) delete process.env[name];
    else process.env[name] = saved;
  }
}

/** The judge a `judge.eval:` block builds, over a mock connection to `api`. */
async function _configJudge(api: _FakeApi, config: ServiceConfig): Promise<EvalJudge> {
  return await withEnv("TYPESAFE_API_KEY", "k", async () => {
    _patchedApi = api;
    try {
      return await EvalJudge.fromConfig(config);
    } finally {
      _patchedApi = null;
    }
  });
}

/** The explainer a judge holds (protected in the port). */
const explainerOf = (judge: EvalJudge) => (judge as unknown as { _explainer: unknown })._explainer;

describe("TestJevQuestions", () => {
  test("test_a_reply_is_asked_as_a_choice_over_the_conversation", async () => {
    const [judge, api] = _judge([_ok({ verdict: _choice("yes") })]);
    judge.addUserMessage("What's the weather?");
    judge.addAssistantMessage("Let me check.");
    judge.addAssistantMessage("It's 72 and sunny.");

    const verdict = await judge.evaluate("describes the weather");

    expect(verdict.passed).toBe(true);
    expect(verdict.confidence).toEqual(0.95);
    expect(verdict.reason).toContain("P(yes)=0.95");
    const request = api.posts[0] as RecordedRequest;
    expect(request.url.endsWith("/v1/systemone")).toBe(true);
    expect(request.headers?.get("Authorization")).toEqual("Bearer k");
    const state = (request.body as Body).state;
    expect(state.latest_bot_reply).toEqual("Let me check. It's 72 and sunny.");
    expect(state.conversation).toEqual([{ speaker: "user", text: "What's the weather?" }]);
    const question = ((request.body as Body).questions as Record<string, Record<string, unknown>>)
      .verdict as Record<string, unknown>;
    expect(question.type).toEqual("choice");
    expect(new Set(Object.keys(question.criteria as object))).toEqual(
      new Set(["yes", "no", "continue"]),
    );
  });

  test("test_a_call_is_asked_as_a_yes_or_no", async () => {
    const [judge, api] = _judge([_ok({ answer: _noul(0.2) })]);
    judge.addUserMessage("Book six o'clock.");
    const verdict = await judge.evaluateCall("book", { time: "7pm" }, "books six o'clock");
    expect(verdict.verdict).toEqual("no");
    expect(verdict.confidence).toBeCloseTo(0.8, 7);
    const request = api.posts[0]?.body as Body;
    expect(request.state.call).toEqual({ name: "book", arguments: { time: "7pm" } });
    expect((request.questions as Record<string, Record<string, unknown>>).answer?.type).toEqual(
      "noul",
    );
  });

  test("test_a_run_asks_the_goal_and_every_turn_at_once", async () => {
    const respond = (body: Body): Reply => {
      const reply = body.state.latest_bot_reply;
      if (reply === undefined) {
        return _ok({ answer: _noul(0.9) });
      }
      return _ok(
        Object.fromEntries(
          Object.keys(body.questions as object).map((name) => [
            name,
            _turn(reply === "Sure." ? 0.9 : 0.1),
          ]),
        ),
      );
    };

    const [judge, api] = _judge(respond);
    judge.addUserMessage("Book a table at six.");
    judge.addAssistantMessage("Sure.");
    judge.addUserMessage("Thanks.");
    judge.addAssistantMessage("Bye.");

    const verdicts = await judge.evaluateRun({ polite: "is polite" }, "a table is booked");

    expect(verdicts.goal.passed).toBe(true);
    expect(verdicts.turns.polite?.map((v) => v.verdict)).toEqual(["yes", "no"]);
    expect(api.posts.length).toEqual(3);
    const turn = api.posts.find((p) => "latest_bot_reply" in (p.body as Body).state);
    const questions = ((turn as RecordedRequest).body as Body).questions as Record<
      string,
      Record<string, unknown>
    >;
    expect(new Set(Object.keys(questions.polite?.criteria as object))).toEqual(
      new Set(["meets", "fails", "not_applicable"]),
    );
  });
});

describe("TestJevConnection", () => {
  const _ask = async (judge: EvalJudge) => {
    judge.addAssistantMessage("It rains.");
    return await judge.evaluate("mentions weather");
  };

  test("test_a_timeout_is_asked_again", async () => {
    const [judge, api] = _judge([readTimeout("stalled"), _ok({ verdict: _choice("yes") })]);
    expect((await _ask(judge)).passed).toBe(true);
    expect(api.posts.length).toEqual(2);
  });

  test("test_a_rejected_question_is_asked_again", async () => {
    const [judge, api] = _judge([[503, {}], _ok({ verdict: _choice("yes") })]);
    expect((await _ask(judge)).passed).toBe(true);
    expect(api.posts.length).toEqual(2);
  });

  test("test_a_second_failure_fails_the_question", async () => {
    const [judge, api] = _judge([readTimeout("stalled"), readTimeout("stalled")]);
    const verdict = await _ask(judge);
    expect(verdict.reason).toEqual("judge call failed");
    expect(api.posts.length).toEqual(2);
  });

  test("test_the_connection_is_opened_when_the_judge_is_created", async () => {
    const api = new _FakeApi([_ok({ verdict: _choice("yes") })]);
    const judge = await _configJudge(api, { factory: _FACTORY, explainer: false });
    await _ask(judge);
    expect(api.requests.map((r) => r.method)).toEqual(["GET", "POST"]);
    expect(api.requests[0]?.url.endsWith("/v1/models")).toBe(true);
    await judge.close();
  });

  test("test_close_releases_a_connection_the_judge_opened", async () => {
    const api = new _FakeApi([]);
    const judge = await _configJudge(api, { factory: _FACTORY, explainer: false });
    await judge.close();
    expect(http((judge.classifier as JevClassifier).client).isClosed).toBe(true);
  });

  test("test_close_leaves_a_connection_the_judge_was_given_open", async () => {
    const api = new _FakeApi([]);
    const classifier = api.classifier();
    await new EvalJudge(classifier).close();
    expect(http(classifier.client).isClosed).toBe(false);
  });
});

describe("TestJevConfig", () => {
  test("test_service_typesafe_judges_with_jev_and_explains_with_an_llm", async () => {
    const judge = await _configJudge(new _FakeApi([]), { factory: _FACTORY, model: "jev-9" });
    expect(judge.classifier).toBeInstanceOf(JevClassifier);
    expect(judge.classifier.model).toEqual("jev-9");
    expect(explainerOf(judge)).not.toBeNull();
    await judge.close();
  });

  test("test_explainer_false_builds_no_explainer", async () => {
    const judge = await _configJudge(new _FakeApi([]), { factory: _FACTORY, explainer: false });
    expect(explainerOf(judge)).toBeNull();
    await judge.close();
  });

  test("test_allow_continue_is_read_from_the_config", async () => {
    const judge = await _configJudge(new _FakeApi([]), {
      factory: _FACTORY,
      allow_continue: false,
    });
    const outcomes = (judge as unknown as { _replyOutcomes: Record<string, string> })
      ._replyOutcomes;
    expect(Object.keys(outcomes)).not.toContain("continue");
    await judge.close();
  });

  test("test_a_missing_api_key_is_an_error", async () => {
    await withEnv("TYPESAFE_API_KEY", undefined, async () => {
      await expect(EvalJudge.fromConfig({ factory: _FACTORY })).rejects.toThrow(Error);
    });
  });
});
