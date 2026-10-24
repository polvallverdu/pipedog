// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Writes a benchmark's table into the performance docs page, between its markers.

import { join } from "node:path";
import { ROOT } from "../compat/packages.ts";

export const PERFORMANCE_PAGE = join(ROOT, "apps", "docs", "content", "docs", "performance.mdx");

/** Replace what is between `{/* <name>:start *\/}` and `{/* <name>:end *\/}` with `content`. */
export async function writeDocsSection(name: string, content: string): Promise<void> {
  const text = await Bun.file(PERFORMANCE_PAGE).text();
  const start = `{/* ${name}:start */}`;
  const end = `{/* ${name}:end */}`;
  const a = text.indexOf(start);
  const b = text.indexOf(end);
  if (a < 0 || b < a) throw new Error(`${PERFORMANCE_PAGE}: no ${start} ... ${end} section`);
  await Bun.write(
    PERFORMANCE_PAGE,
    `${text.slice(0, a + start.length)}\n\n${content}\n\n${text.slice(b)}`,
  );
}
