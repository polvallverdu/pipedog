// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

import { describe, expect, test } from "bun:test";
import { classifySetFailure, classifyTrustList, ensureTrust, pool, type TrustIo } from "./trust.ts";

const REPO = "polvallverdu/pipedog";
const WORKFLOW = "release.yml";

// What `npm trust list --json` printed when run without a terminal (a real run).
const EOTP_OUTPUT = `npm warn cli npm v12.2.0 does not support Node.js v24.14.0.
npm error code EOTP
npm error This operation requires a one-time password.
{
  "error": {
    "code": "EOTP",
    "summary": "This operation requires a one-time password."
  }
}`;

const classify = (code: number, out: string) => classifyTrustList(code, out, REPO, WORKFLOW);

describe("classifyTrustList", () => {
  test("a missing one-time password is its own state, not 'not configured'", () => {
    expect(classify(1, EOTP_OUTPUT)).toBe("otp");
  });

  test("a listing that names this repo and workflow is ours", () => {
    const out = JSON.stringify([{ type: "github", repository: REPO, file: WORKFLOW }]);
    expect(classify(0, `npm warn something\n${out}`)).toBe("ours");
    expect(
      classify(0, JSON.stringify({ trust: { claims: { repository: REPO, file: WORKFLOW } } })),
    ).toBe("ours");
  });

  test("the real output for a configured package, with npm's warning after it, is ours", () => {
    // `npm trust list @pipedog/core --json` as the script captures it: stdout (a blank line, one
    // object whose "permissions" holds an array), then stderr. It used to be read as an error
    // because the warning after the JSON broke JSON.parse.
    const stdout = `
{
  "id": "7825e2b9-1c81-43fa-974d-c233973c4d03",
  "type": "github",
  "file": "release.yml",
  "repository": "polvallverdu/pipedog",
  "environment": "npm",
  "permissions": [
    "createPackage",
    "createStagedPackage"
  ]
}
`;
    const stderr =
      "npm warn cli npm v12.2.0 does not support Node.js v24.14.0. This version of npm supports the following node versions: `^22.22.2 || ^24.15.0 || >=26.0.0`.\n";
    expect(classify(0, stdout + stderr)).toBe("ours");
    expect(classify(0, stdout)).toBe("ours");
    expect(classify(0, `${stderr}${stdout}`)).toBe("ours");
  });

  test("brackets and braces inside strings don't end the JSON early", () => {
    const note = 'a } b ] " c';
    const out = `${JSON.stringify({ file: WORKFLOW, repository: REPO, note })}\nnpm warn {x}`;
    expect(classify(0, out)).toBe("ours");
  });

  test("a listing for another repo or workflow is someone else's", () => {
    expect(classify(0, JSON.stringify([{ repository: "someone/else", file: WORKFLOW }]))).toBe(
      "other",
    );
    expect(classify(0, JSON.stringify([{ repository: REPO, file: "publish.yml" }]))).toBe("other");
  });

  test("an empty listing means nothing is configured", () => {
    expect(classify(0, "[]")).toBe("none");
    expect(classify(0, "{}")).toBe("none");
    expect(classify(1, "npm error code E404\nnpm error No trust configuration found")).toBe("none");
  });

  test("anything else is an error, which falls through to trying to set it", () => {
    expect(classify(1, "npm error network timeout")).toBe("error");
    expect(classify(0, "something that isn't JSON")).toBe("error");
  });
});

describe("classifySetFailure", () => {
  test("separates 2FA, an existing config and other failures", () => {
    expect(classifySetFailure(EOTP_OUTPUT)).toBe("otp");
    expect(classifySetFailure("npm error 409 Conflict: a trust configuration already exists")).toBe(
      "exists",
    );
    expect(classifySetFailure("npm error code E500")).toBe("error");
  });
});

/** A fake npm, with what each call returns and a record of what was asked. */
function fakeIo(script: {
  list?: Array<{ code: number; out: string }>;
  set?: Array<{ code: number; out: string }>;
  setInteractive?: number;
}) {
  const calls: string[] = [];
  const lists = [...(script.list ?? [])];
  const sets = [...(script.set ?? [{ code: 0, out: "" }])];
  const io: TrustIo = {
    list: () => {
      calls.push("list");
      return lists.shift() ?? { code: 0, out: "[]" };
    },
    authenticate: () => {
      calls.push("authenticate");
    },
    set: () => {
      calls.push("set");
      return sets.shift() ?? { code: 0, out: "" };
    },
    setInteractive: () => {
      calls.push("setInteractive");
      return script.setInteractive ?? 0;
    },
    sleep: async () => {},
    log: () => {},
  };
  return { io, calls };
}

const options = { repo: REPO, workflow: WORKFLOW, justCreated: false, dryRun: false };
const ours = JSON.stringify([{ repository: REPO, file: WORKFLOW }]);

describe("ensureTrust", () => {
  test("a package that already trusts this workflow isn't touched", async () => {
    const { io, calls } = fakeIo({ list: [{ code: 0, out: ours }] });
    expect(await ensureTrust("@pipedog/core", options, io)).toEqual({ outcome: "already" });
    expect(calls).toEqual(["list"]);
  });

  test("2FA on the first list is approved once, then the list is retried", async () => {
    const { io, calls } = fakeIo({
      list: [
        { code: 1, out: EOTP_OUTPUT },
        { code: 0, out: ours },
      ],
    });
    expect((await ensureTrust("@pipedog/core", options, io)).outcome).toBe("already");
    expect(calls).toEqual(["list", "authenticate", "list"]);
  });

  test("a package with nothing configured gets the trusted publisher", async () => {
    const { io, calls } = fakeIo({ list: [{ code: 0, out: "[]" }] });
    expect((await ensureTrust("@pipedog/new", options, io)).outcome).toBe("configured");
    expect(calls).toEqual(["list", "set"]);
  });

  test("a package published a moment ago isn't listed first", async () => {
    const { io, calls } = fakeIo({});
    await ensureTrust("@pipedog/new", { ...options, justCreated: true }, io);
    expect(calls).toEqual(["set"]);
  });

  test("a config that npm says exists is reported as assumed, not as a failure", async () => {
    const { io } = fakeIo({
      list: [{ code: 1, out: "npm error network timeout" }],
      set: [{ code: 1, out: "npm error 409 trust configuration already exists" }],
    });
    expect((await ensureTrust("@pipedog/x", options, io)).outcome).toBe("assumed");
  });

  test("another repo's trusted publisher is left alone and reported", async () => {
    const { io, calls } = fakeIo({
      list: [{ code: 0, out: JSON.stringify([{ repository: "someone/else", file: WORKFLOW }]) }],
    });
    expect((await ensureTrust("@pipedog/x", options, io)).outcome).toBe("other");
    expect(calls).toEqual(["list"]);
  });

  test("2FA asked in the middle of setting is finished in the terminal", async () => {
    const { io, calls } = fakeIo({
      list: [{ code: 0, out: "[]" }],
      set: [{ code: 1, out: EOTP_OUTPUT }],
      setInteractive: 0,
    });
    expect((await ensureTrust("@pipedog/x", options, io)).outcome).toBe("configured");
    expect(calls).toEqual(["list", "set", "setInteractive"]);
  });

  test("a dry run lists but never sets", async () => {
    const { io, calls } = fakeIo({ list: [{ code: 0, out: "[]" }] });
    expect((await ensureTrust("@pipedog/x", { ...options, dryRun: true }, io)).outcome).toBe(
      "planned",
    );
    expect(calls).toEqual(["list"]);
  });

  test("a real failure is reported with the end of npm's output", async () => {
    const { io } = fakeIo({
      list: [{ code: 0, out: "[]" }],
      set: [{ code: 1, out: "line 1\nline 2\nline 3\nnpm error code E500" }],
    });
    const r = await ensureTrust("@pipedog/x", options, io);
    expect(r.outcome).toBe("failed");
    expect(r.note).toContain("E500");
  });
});

describe("pool", () => {
  test("keeps the order of the results and never exceeds the limit", async () => {
    let running = 0;
    let peak = 0;
    const out = await pool([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
      running++;
      peak = Math.max(peak, running);
      await Bun.sleep(5 - (n % 3));
      running--;
      return n * 2;
    });
    expect(out).toEqual([2, 4, 6, 8, 10, 12, 14]);
    expect(peak).toBeLessThanOrEqual(3);
  });
});
