# Copyright (c) 2026, pipecat-ts contributors
# SPDX-License-Identifier: BSD-2-Clause
"""Build porting/manifest.json from the pinned upstream checkout.

For every upstream module: its target package and TS path, its pipecat
dependencies, a topological layer (modules in the same layer can be ported in
parallel), the upstream tests that exercise it, and third-party imports.
Existing status/notes in the manifest are preserved, so re-running after an
upstream bump only updates the analysis.

Usage: python3 -I tools/port/graph.py [--root .]
"""

import argparse
import ast
import json
import os
import sys

STDLIB = set(sys.stdlib_module_names) | {"typing_extensions"}

# Third-party Python deps that are fine for core (we replace them with
# built-ins / our own code): they don't force a separate package.
CORE_OK_THIRD_PARTY = {
    "loguru", "pydantic", "numpy", "aiohttp", "websockets", "dotenv", "httpx",
    "PIL", "yaml", "markdown", "docstring_parser", "nltk", "pysbd", "openai",
    "opentelemetry", "pyloudnorm", "resampy", "soxr", "protobuf", "google",
    "wait_for2", "audioop", "Levenshtein", "fastapi", "uvicorn", "jinja2",
}

CORE_ROOTS = [
    "pipecat.pipeline.worker",
    "pipecat.pipeline.pipeline",
    "pipecat.workers.runner",
    "pipecat.tests.utils",
]

# Path prefix -> package rule. First match wins. "{1}" is the next path segment.
PACKAGE_RULES = [
    ("pipecat.services.", "@pipecat-ts/{1}", lambda parts: len(parts) > 3),
    ("pipecat.transports.", "@pipecat-ts/transport-{1}", lambda parts: len(parts) > 3),
    ("pipecat.serializers.", "@pipecat-ts/serializer-{1}",
        lambda parts: parts[2] not in ("base_serializer", "__init__")),
    ("pipecat.flows", "@pipecat-ts/flows", None),
    ("pipecat.evals", "@pipecat-ts/evals", None),
    ("pipecat.cli", "@pipecat-ts/cli", None),
    ("pipecat.runner", "@pipecat-ts/runner", None),
    ("pipecat.extensions", "@pipecat-ts/extensions", None),
    ("pipecat.bus.network.pgmq", "@pipecat-ts/bus-pgmq", None),
    ("pipecat.bus.network.redis", "@pipecat-ts/bus-redis", None),
    ("pipecat.services.mcp_service", "@pipecat-ts/mcp", None),
    ("pipecat.processors.metrics.sentry", "@pipecat-ts/sentry", None),
    ("pipecat.workers.proxy.websocket.server", "@pipecat-ts/worker-proxy", None),
    ("pipecat.processors.gstreamer", "@pipecat-ts/gstreamer", None),
    ("pipecat.processors.frameworks.langchain", "@pipecat-ts/langchain", None),
    ("pipecat.processors.frameworks.strands_agents", "@pipecat-ts/strands-agents", None),
]

AUDIO_IMPL_PREFIXES = ("pipecat.audio.filters.", "pipecat.audio.vad.", "pipecat.audio.turn.",
                       "pipecat.audio.resamplers.", "pipecat.audio.mixers.")


def module_path(src, mod):
    p = os.path.join(src, *mod.split("."))
    if os.path.isfile(p + ".py"):
        return p + ".py"
    if os.path.isfile(os.path.join(p, "__init__.py")):
        return os.path.join(p, "__init__.py")
    return None


def all_modules(src):
    out = []
    for dirpath, _, files in os.walk(os.path.join(src, "pipecat")):
        for f in files:
            if f.endswith(".py"):
                rel = os.path.relpath(os.path.join(dirpath, f), src)[:-3]
                mod = rel.replace(os.sep, ".")
                if mod.endswith(".__init__"):
                    mod = mod[: -len(".__init__")]
                out.append(mod)
    return sorted(out)


def analyze(src, mod):
    """Return (pipecat deps incl. TYPE_CHECKING, third-party top-level names)."""
    path = module_path(src, mod)
    tree = ast.parse(open(path).read())
    deps, third = set(), set()
    pkg = mod if path.endswith("__init__.py") else mod.rsplit(".", 1)[0]
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom):
            if node.level:
                base = pkg.split(".")
                if node.level > 1:
                    base = base[: -(node.level - 1)]
                name = ".".join(base + ([node.module] if node.module else []))
            else:
                name = node.module or ""
            if name.startswith("pipecat"):
                deps.add(name)
                for a in node.names:
                    if module_path(src, f"{name}.{a.name}"):
                        deps.add(f"{name}.{a.name}")
            elif name:
                third.add(name.split(".")[0])
        elif isinstance(node, ast.Import):
            for a in node.names:
                if a.name.startswith("pipecat"):
                    deps.add(a.name)
                else:
                    third.add(a.name.split(".")[0])
    deps = {d for d in deps if module_path(src, d) and d != mod}
    third = {t for t in third if t not in STDLIB and t != "pipecat"}
    return sorted(deps), sorted(third)


def closure(graph, roots):
    seen, stack = set(), list(roots)
    while stack:
        m = stack.pop()
        if m in seen or m not in graph:
            continue
        seen.add(m)
        stack.extend(graph[m]["deps"])
    return seen


def package_for(mod, core, third):
    parts = mod.split(".")
    if mod in core:
        return "@pipecat-ts/core"
    for prefix, pattern, cond in PACKAGE_RULES:
        if mod.startswith(prefix) and (cond is None or cond(parts)):
            name = pattern.replace("{1}", parts[2] if len(parts) > 2 else parts[-1])
            name = name.replace("{2}", parts[3] if len(parts) > 3 else parts[-1])
            return name.replace("_", "-")
    if mod.startswith(AUDIO_IMPL_PREFIXES) and not parts[-1].startswith("base_") \
            and parts[-1] not in ("__init__", "vad_analyzer", "vad_controller"):
        heavy = [t for t in third if t not in CORE_OK_THIRD_PARTY]
        if heavy or parts[2] in ("filters", "turn"):
            return f"@pipecat-ts/audio-{parts[3]}".replace("_", "-")
    if mod.startswith("pipecat.adapters.services.") and parts[-1].endswith("_adapter"):
        provider = parts[-1][: -len("_adapter")].split("_")[0]
        provider = {"open": "openai", "gemini": "google", "bedrock": "aws"}.get(provider, provider)
        return f"@pipecat-ts/{provider}"
    heavy = [t for t in third if t not in CORE_OK_THIRD_PARTY]
    if heavy and not mod.startswith(("pipecat.tests", "pipecat.utils.text.transforms")):
        return f"@pipecat-ts/{parts[-1]}".replace("_", "-")
    return "@pipecat-ts/core"


def package_dir(pkg):
    return "packages/" + pkg.split("/", 1)[1]


def ts_path(mod, src, pkg):
    path = module_path(src, mod)
    rel = os.path.relpath(path, os.path.join(src, "pipecat"))
    if rel.endswith("__init__.py"):
        rel = rel[: -len("__init__.py")] + "index.py"
    rel = rel[:-3] + ".ts"
    if pkg != "@pipecat-ts/core":
        # Strip the directory that names the package (services/deepgram/stt.py -> stt.ts).
        parts = rel.split("/")
        for depth in (2, 1):
            if len(parts) > depth:
                rel = "/".join(parts[depth:])
                break
    return f"{package_dir(pkg)}/src/{rel}"


def layers(graph, mods):
    """Topological layers ignoring cycles (cycle members share a layer)."""
    # Tarjan SCC.
    index, low, onstack, stack, sccs = {}, {}, set(), [], []
    counter = [0]
    sys.setrecursionlimit(100000)

    def strong(v):
        index[v] = low[v] = counter[0]
        counter[0] += 1
        stack.append(v)
        onstack.add(v)
        for w in graph[v]["deps"]:
            if w not in mods:
                continue
            if w not in index:
                strong(w)
                low[v] = min(low[v], low[w])
            elif w in onstack:
                low[v] = min(low[v], index[w])
        if low[v] == index[v]:
            comp = []
            while True:
                w = stack.pop()
                onstack.discard(w)
                comp.append(w)
                if w == v:
                    break
            sccs.append(comp)

    for m in mods:
        if m not in index:
            strong(m)
    comp_of = {m: i for i, c in enumerate(sccs) for m in c}
    layer = {}
    for i, comp in enumerate(sccs):  # Tarjan emits SCCs in reverse topological order
        deps = {comp_of[d] for m in comp for d in graph[m]["deps"] if d in mods} - {i}
        layer[i] = 1 + max((layer[d] for d in deps), default=-1)
    return {m: layer[comp_of[m]] for m in mods}, {m: len(sccs[comp_of[m]]) for m in mods}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", default=".")
    args = ap.parse_args()
    root = os.path.abspath(args.root)
    upstream = json.load(open(os.path.join(root, "upstream.json")))
    up = os.path.join(root, upstream["path"])
    src = os.path.join(up, "src")
    manifest_path = os.path.join(root, "porting", "manifest.json")
    old = {}
    if os.path.exists(manifest_path):
        old = {m["module"]: m for m in json.load(open(manifest_path))["modules"]}

    graph = {}
    for mod in all_modules(src):
        deps, third = analyze(src, mod)
        graph[mod] = {"deps": deps, "third": third}
    core = closure(graph, CORE_ROOTS)

    # Tests: map each upstream test file to the modules it imports.
    tests_dir = os.path.join(up, "tests")
    tests_by_mod = {}
    test_entries = []
    for f in sorted(os.listdir(tests_dir)):
        if not (f.startswith("test_") and f.endswith(".py")):
            continue
        tree = ast.parse(open(os.path.join(tests_dir, f)).read())
        imported = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.ImportFrom) and (node.module or "").startswith("pipecat"):
                if module_path(src, node.module):
                    imported.add(node.module)
                for a in node.names:
                    if module_path(src, f"{node.module}.{a.name}"):
                        imported.add(f"{node.module}.{a.name}")
        test_entries.append((f, sorted(imported)))
        for m in imported:
            tests_by_mod.setdefault(m, []).append(f)

    mods = set(graph)
    layer, scc_size = layers(graph, mods)
    out = []
    for mod in sorted(mods):
        pkg = package_for(mod, core, graph[mod]["third"])
        prev = old.get(mod, {})
        lines = sum(1 for _ in open(module_path(src, mod)))
        out.append({
            "module": mod,
            "upstream": os.path.relpath(module_path(src, mod), up),
            "lines": lines,
            "package": pkg,
            # Keep a hand-adjusted path, but never one left over from a different package.
            "ts": prev["ts"] if prev.get("ts", "").startswith(package_dir(pkg) + "/") else ts_path(mod, src, pkg),
            "layer": layer[mod],
            # Part of the first milestone: the closure of PipelineWorker/WorkerRunner/run_test.
            "mvp": mod in core,
            "cycle": scc_size[mod] > 1,
            "deps": graph[mod]["deps"],
            "thirdParty": graph[mod]["third"],
            "tests": sorted(tests_by_mod.get(mod, [])),
            "status": prev.get("status", "todo"),
            "portedAt": prev.get("portedAt"),
            "notes": prev.get("notes", ""),
        })

    by_mod = {m["module"]: m for m in out}
    tests = []
    old_tests = {}
    if os.path.exists(manifest_path):
        old_tests = {t["file"]: t for t in json.load(open(manifest_path)).get("tests", [])}
    for f, imported in test_entries:
        pkgs = {by_mod[m]["package"] for m in imported if m in by_mod}
        non_core = sorted(p for p in pkgs if p != "@pipecat-ts/core")
        pkg = non_core[0] if non_core else "@pipecat-ts/core"
        needs = sorted(closure(graph, imported))
        prev = old_tests.get(f, {})
        tests.append({
            "file": f"tests/{f}",
            "lines": sum(1 for _ in open(os.path.join(tests_dir, f))),
            "package": pkg,
            "ts": prev["ts"] if prev.get("ts", "").startswith(package_dir(pkg) + "/") else f"{package_dir(pkg)}/test/{f[:-3]}.test.ts",
            "imports": imported,
            "needsModules": len(needs),
            "status": prev.get("status", "todo"),
            "notes": prev.get("notes", ""),
        })

    os.makedirs(os.path.dirname(manifest_path), exist_ok=True)
    json.dump({"upstreamCommit": upstream["commit"], "modules": out, "tests": tests},
              open(manifest_path, "w"), indent=2)
    pk = {}
    for m in out:
        pk.setdefault(m["package"], [0, 0])
        pk[m["package"]][0] += 1
        pk[m["package"]][1] += m["lines"]
    print(f"{len(out)} modules, {len(tests)} test files, {len(pk)} packages")
    for p, (n, l) in sorted(pk.items(), key=lambda kv: -kv[1][1])[:15]:
        print(f"  {p:40} {n:4} modules {l:7} lines")


if __name__ == "__main__":
    main()
