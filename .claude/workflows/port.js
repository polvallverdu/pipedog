export const meta = {
  name: 'port',
  description: 'Port pending upstream Pipecat modules to TypeScript, review them, integrate, and port their tests',
  whenToUse: 'Porting the next batch of pipecat modules or tests. args: {select: "--mvp" | "--package @pipecat-ts/x" | "--modules a,b", maxLines, review, tests, testLimit, testsOnly}',
  phases: [
    { title: 'Plan', detail: 'pack pending modules into work units (tools/port/next.ts)' },
    { title: 'Port', detail: 'one porter per unit, Python -> TS per docs/CONVENTIONS.md' },
    { title: 'Review', detail: 'adversarial parity review of each unit against upstream' },
    { title: 'Integrate', detail: 'typecheck + lint the package, fix cross-unit mismatches' },
    { title: 'Tests', detail: 'port ready upstream tests 1:1 and make them pass' },
    { title: 'Record', detail: 'update porting/manifest.json and STATUS.md' },
  ],
}

const opts = Object.assign(
  { select: '--mvp', maxLines: 4000, review: true, tests: true, testLimit: 40, testsOnly: false },
  args || {},
)

const CONTEXT = `You are porting Pipecat (Python, pinned checkout in .upstream/pipecat) to pipecat-ts, a Bun
monorepo (repo root = current directory). Before writing code, read docs/CONVENTIONS.md in full,
and skim the hand-ported reference files it lists (packages/asyncio/src/task.ts,
packages/core/src/processors/frame_processor.ts, packages/core/src/utils/base_object.ts,
the top of packages/core/src/frames/frames.ts). Those define every pattern: options objects,
camelCase members, snake_case file names, # privates, as-const enums, defineMixin, cancellation
(rethrowIfCancelled in every broad catch), seconds for durations, Uint8Array for bytes, the license
header, and the rule that deprecated upstream APIs are NOT ported.
Other modules are being ported concurrently by other agents. Import them by their deterministic TS
path (same path as upstream, .ts extension, relative imports inside a package) and the names the
conventions produce from the Python source, even if the file does not exist yet. Read the Python
source of a dependency to learn its API; do not invent APIs. Do not edit porting/manifest.json.`

const UNITS_SCHEMA = {
  type: 'object',
  properties: { json: { type: 'string', description: 'stdout of the command, verbatim' } },
  required: ['json'],
}

const PORT_SCHEMA = {
  type: 'object',
  properties: {
    modules: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          module: { type: 'string' },
          status: { type: 'string', enum: ['ported', 'partial', 'skipped'] },
          notes: { type: 'string', description: 'deprecated APIs dropped, stubs, divergences, missing deps; empty if none' },
        },
        required: ['module', 'status', 'notes'],
      },
    },
  },
  required: ['modules'],
}

const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    fixed: { type: 'array', items: { type: 'string' }, description: 'one line per divergence found and fixed' },
    unresolved: { type: 'array', items: { type: 'string' }, description: 'divergences you could not fix' },
  },
  required: ['fixed', 'unresolved'],
}

const INTEGRATE_SCHEMA = {
  type: 'object',
  properties: {
    typeErrorsRemaining: { type: 'number' },
    summary: { type: 'string' },
  },
  required: ['typeErrorsRemaining', 'summary'],
}

const TEST_SCHEMA = {
  type: 'object',
  properties: {
    file: { type: 'string' },
    status: { type: 'string', enum: ['tested', 'partial', 'todo'] },
    passed: { type: 'number' },
    failed: { type: 'number' },
    skipped: { type: 'number' },
    sourceFixes: { type: 'array', items: { type: 'string' }, description: 'source bugs fixed to reach parity' },
    notes: { type: 'string' },
  },
  required: ['file', 'status', 'passed', 'failed', 'skipped', 'sourceFixes', 'notes'],
}

const packagesTouched = new Set()

async function record(commands, label) {
  if (!commands.length) return
  await agent(
    `Run these shell commands one by one from the repo root, exactly as written, and report any that fail:\n${commands.join('\n')}`,
    { label, phase: 'Record', effort: 'low' },
  )
}
let portResults = []

if (!opts.testsOnly) {
  phase('Plan')
  const plan = await agent(
    `Run exactly: bun tools/port/next.ts modules ${opts.select} --max-lines ${opts.maxLines}
and return its stdout verbatim in the json field. Do nothing else.`,
    { label: 'plan', schema: UNITS_SCHEMA, effort: 'low' },
  )
  const units = JSON.parse(plan.json)
  log(`${units.length} units, ${units.reduce((a, u) => a + u.lines, 0)} Python lines`)
  units.forEach((u) => packagesTouched.add(u.package))

  const results = await pipeline(
    units,
    (unit) => {
      const list = unit.modules
        .map((m) => `- ${m.module}: ${m.upstream} -> ${m.ts} (${m.lines} lines)${m.notes ? ` [note: ${m.notes}]` : ''}`)
        .join('\n')
      return agent(
        `${CONTEXT}

Your work unit ${unit.id} (package ${unit.package}):
${list}

For each module: read the whole Python file (paths are relative to .upstream/pipecat), then write
the complete TypeScript port at the given path. Port everything that is not deprecated: every class,
method, branch, default, log line and docstring (as JSDoc). If the TS file already exists and contains a
"PORTING:" marker, keep what is above the marker and continue the port below it, then remove the marker.
If the package directory does not exist yet, create package.json (name, "type": "module", exports
"./*": "./src/*.ts", the "pipecat" block with runtimes and upstream, dependency on @pipecat-ts/core
"workspace:*") and tsconfig.json modelled on packages/core.
When a dependency needs a third-party library with no edge-compatible JS equivalent (onnx models, soxr,
Krisp...), port the interface and leave the implementation as a clearly marked stub that throws
"not ported yet" and mark that module "partial" with a note.
Then run \`bunx tsc --noEmit -p ${unit.package === '@pipecat-ts/core' ? 'packages/core' : 'packages/' + unit.package.split('/')[1]}/tsconfig.json 2>&1 | grep -F -e "${unit.modules.map((m) => m.ts.split('/src/')[1]).join('" -e "')}"\`
and fix errors in YOUR files that are not caused by modules other agents have not written yet.
Return one entry per module.`,
        { label: `port:${unit.id}`, phase: 'Port', schema: PORT_SCHEMA },
      )
    },
    (ported, unit) => {
      if (!opts.review || !ported) return ported
      const list = unit.modules.map((m) => `- .upstream/pipecat/${m.upstream} -> ${m.ts}`).join('\n')
      return agent(
        `${CONTEXT}

You are an adversarial reviewer. Another agent just ported these modules:
${list}

Compare each TS file against its Python source line by line, assuming the port is wrong until proven
otherwise. Hunt specifically for: missing methods/branches/event registrations; changed defaults
(\`or\` -> must be \`??\` unless falsy-coalescing is intended; mutable default args); broad catch blocks
without rethrowIfCancelled; Python truthiness ported wrong (empty list/dict/str/0 are falsy in Python
but [] and {} are truthy in JS); integer division (\`//\` -> Math.floor) and int() truncation;
dict iteration order and \`in\` checks on dicts vs arrays; isinstance on mixins; awaits dropped or added
(missing await = floating promise); seconds vs milliseconds; bytes math on Uint8Array; string formatting
of logs; anything deprecated that was ported anyway (remove it); conventions violations (naming,
header, options objects, no TS enums).
Fix every real divergence in place. Do not restyle code that is already correct.`,
        { label: `review:${unit.id}`, phase: 'Review', schema: REVIEW_SCHEMA },
      ).then((review) => ({ ...ported, review }))
    },
  )
  portResults = results.filter(Boolean)

  phase('Integrate')
  for (const pkg of packagesTouched) {
    const dir = pkg === '@pipecat-ts/core' ? 'packages/core' : `packages/${pkg.split('/')[1]}`
    let remaining = Infinity
    for (let round = 1; round <= 3 && remaining > 0; round++) {
      const r = await agent(
        `${CONTEXT}

All modules of ${pkg} in this batch were ported in parallel by different agents, so cross-module
mismatches are expected (a name or signature one module imports that another exported differently).
Run \`bun install\` once, then \`bunx tsc --noEmit -p ${dir}/tsconfig.json\` and fix ALL type errors until
it is clean. When two modules disagree, the Python upstream decides which side is right. Never silence
errors with \`any\`, \`@ts-ignore\` or \`as unknown as\` unless the Python is genuinely dynamic, and say so in
a comment. Then run \`bunx biome check --write ${dir}\` and \`bun tools/port/check-headers.ts\` and fix what they report.
This is round ${round}; if you run low on context, stop and report the remaining error count honestly.`,
        { label: `integrate:${pkg}:${round}`, phase: 'Integrate', schema: INTEGRATE_SCHEMA },
      )
      remaining = r ? r.typeErrorsRemaining : remaining
      log(`${pkg} integrate round ${round}: ${remaining} type errors remaining`)
    }
  }
}

const moduleCommands = []
for (const r of portResults) {
  for (const m of r.modules) {
    const status = m.status === 'partial' ? 'ported' : m.status
    const note = [m.status === 'partial' ? 'PARTIAL' : '', m.notes, ...(r.review?.unresolved || []).map((u) => `UNRESOLVED: ${u}`)]
      .filter(Boolean)
      .join(' | ')
    moduleCommands.push(`bun tools/port/status.ts --set ${m.module} ${status} ${JSON.stringify(note)}`)
  }
}
// Recorded before Tests: tests are selected by whether their modules are ported.
await record(moduleCommands, 'record:modules')

let testResults = []
if (opts.tests) {
  phase('Tests')
  const pkgFlag = opts.select.startsWith('--package') ? opts.select : opts.select === '--mvp' ? '--mvp' : ''
  const ready = await agent(
    `Run exactly: bun tools/port/next.ts tests ${pkgFlag} --limit ${opts.testLimit}
and return its stdout verbatim in the json field. Do nothing else.`,
    { label: 'plan-tests', phase: 'Tests', schema: UNITS_SCHEMA, effort: 'low' },
  )
  const tests = JSON.parse(ready.json)
  log(`${tests.length} upstream test files ready to port`)
  testResults = (
    await pipeline(tests, (t) =>
      agent(
        `${CONTEXT}

Port the upstream test file .upstream/pipecat/${t.file} (${t.lines} lines) 1:1 to ${t.ts} with bun:test,
following the "Tests" section of docs/CONVENTIONS.md (keep test names; options objects for frames;
deprecated-only tests -> test.skip with a reason). Then run \`bun test ${t.ts}\`.
When a test fails, find out whether the test port or the source port is wrong by comparing with the
Python. Fix the source only where it diverges from upstream behavior; other agents may be editing source
files concurrently, so re-read a file right before editing it and keep source edits minimal.
Never weaken an assertion. A test that cannot pass because of an unported module -> test.todo naming it.
Report counts from the final run.`,
        { label: `test:${t.file.replace('tests/', '')}`, phase: 'Tests', schema: TEST_SCHEMA },
      ),
    )
  ).filter(Boolean)
}

phase('Record')
await record(
  testResults.map(
    (t) => `bun tools/port/status.ts --set ${t.file} ${t.status} ${JSON.stringify(`${t.passed} pass, ${t.failed} fail, ${t.skipped} skip. ${t.notes}`)}`,
  ),
  'record:tests',
)
await record(['bun tools/port/status.ts'], 'record:status')

return {
  modules: portResults.flatMap((r) => r.modules),
  reviewFixes: portResults.flatMap((r) => r.review?.fixed || []),
  unresolved: portResults.flatMap((r) => r.review?.unresolved || []),
  tests: testResults,
}
