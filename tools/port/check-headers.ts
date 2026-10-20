// Copyright (c) 2026, pipecat-ts contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Every source file must carry the BSD-2-Clause header, and files that say
// "Ported from pipecat" must also keep Daily's copyright line (license §1).

import { Glob } from "bun";

const DAILY = "// Copyright (c) 2024-2026, Daily";
const OURS = "// Copyright (c) 2026, pipecat-ts contributors";
const SPDX = "// SPDX-License-Identifier: BSD-2-Clause";

let failures = 0;
for await (const file of new Glob("{packages,tools,examples}/**/*.ts").scan(".")) {
  if (file.includes("node_modules") || file.includes("/dist/") || file.endsWith(".d.ts")) continue;
  const head = (await Bun.file(file).text()).split("\n").slice(0, 8).join("\n");
  const problems: string[] = [];
  if (!head.includes(OURS)) problems.push("missing contributors copyright");
  if (!head.includes(SPDX)) problems.push("missing SPDX line");
  if (head.includes("Ported from pipecat:") && !head.includes(DAILY))
    problems.push("ported file missing Daily copyright");
  if (head.includes(DAILY) && !head.includes("Ported from pipecat:"))
    problems.push("Daily copyright without 'Ported from pipecat:' line");
  if (problems.length) {
    failures++;
    console.error(`${file}: ${problems.join(", ")}`);
  }
}
if (failures) process.exit(1);
console.log("headers ok");
