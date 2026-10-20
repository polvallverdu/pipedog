// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

// Writes test/fixtures/upstream-corpus.json: every string literal in upstream
// Pipecat's sentence-splitting tests (parsed with Python's `ast`), used as
// parity-test inputs. Needs the pinned checkout (`bun run upstream`) and python3.
//
//   bun scripts/extract-upstream-corpus.ts

const root = new URL("..", import.meta.url).pathname;
const upstream = new URL("../../../.upstream/pipecat/tests/", import.meta.url).pathname;
const FILES = [
  "test_english_sentence_aggregation.py",
  "test_sentence_tokenizer_language.py",
  "test_sentencex_tokenizer.py",
  "test_simple_text_aggregator.py",
  "test_utils_string.py",
];

const PY = `
import ast, json, sys
out = {}
for path in sys.argv[1:]:
    seen = []
    for node in ast.walk(ast.parse(open(path, encoding="utf-8").read())):
        if isinstance(node, ast.Constant) and isinstance(node.value, str):
            s = node.value
            # Skip docstrings/identifiers: keep text that has a letter and a space or punctuation.
            if len(s) >= 2 and any(c.isalpha() for c in s) and s not in seen:
                seen.append(s)
    out[path.rsplit("/", 1)[-1]] = seen
print(json.dumps(out, ensure_ascii=False, indent=1))
`;

const res = Bun.spawnSync(["python3", "-I", "-c", PY, ...FILES.map((f) => upstream + f)]);
if (res.exitCode !== 0) {
  console.error(res.stderr.toString());
  process.exit(1);
}
await Bun.write(`${root}test/fixtures/upstream-corpus.json`, res.stdout.toString());
const corpus = JSON.parse(res.stdout.toString()) as Record<string, string[]>;
console.log(
  Object.entries(corpus)
    .map(([f, xs]) => `${f}: ${xs.length}`)
    .join("\n"),
);
