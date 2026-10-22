// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/cli/test_client_generation.py

// Integration tests for client generation.
//
// DIVERGENCE: only the vanilla JS (Vite) client is ported; the React clients and the Pipecat UI
// snapshot they vendor aren't, so their tests are skipped. Daily isn't ported ("smallwebrtc" and
// "websocket" stand in). The client's `config.js` lists the selected transports only, where
// upstream's `config.ts` knows every web transport.

import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ProjectGenerator } from "../src/project.ts";
import { ProjectConfig, type ProjectConfigOptions } from "../src/questions.ts";
import { ServiceRegistry } from "../src/service_metadata.ts";
import { read, tmpDir } from "./helpers.ts";

async function generate(
  options: Partial<ProjectConfigOptions> & { projectName: string },
): Promise<string> {
  const config = new ProjectConfig({
    botType: "web",
    transports: ["smallwebrtc"],
    mode: "cascade",
    sttService: "deepgram_stt",
    llmService: "openai_llm",
    ttsService: "cartesia_tts",
    generateClient: true,
    clientFramework: "vanilla",
    clientServer: "vite",
    ...options,
  });
  return await new ProjectGenerator(config, { out: () => {} }).generate(tmpDir(), {
    nonInteractive: true,
  });
}

test("test_every_web_transport_declares_a_client_package", () => {
  // Client package.json rendering depends on each web transport naming its npm package.
  for (const transport of ServiceRegistry.WEBRTC_TRANSPORTS) {
    expect(transport.clientPackage, `${transport.value} has no clientPackage`).toBeTruthy();
    expect(transport.clientPackageVersion, `${transport.value} has no version`).toBeTruthy();
  }
});

describe("TestClientGeneration", () => {
  // Test client generation with different configurations.

  test("test_vite_with_multiple_transports", async () => {
    const project = await generate({
      projectName: "test-multi-transport",
      transports: ["smallwebrtc", "websocket"],
    });
    expect(existsSync(join(project, "client", "package.json"))).toBe(true);
    // Config has only the selected transports in the available list
    const config = read(project, "client", "src", "config.js");
    expect(config).toContain("'smallwebrtc'");
    expect(config).toContain("'websocket'");
    expect(config).toContain("AVAILABLE_TRANSPORTS");
    expect(config).not.toContain("'livekit'");
  });

  // The Pipecat UI snapshot and the React clients aren't ported.
  test.skip("test_vite_includes_pipecat_ui_source", () => {});
  test.skip("test_nextjs_includes_pipecat_ui_source", () => {});
  test.skip("test_broken_snapshot_manifest_names_the_sync_script", () => {});
  test.skip("test_nextjs_with_single_transport", () => {});

  test("test_vanilla_client_gets_no_pipecat_ui_source", async () => {
    const project = await generate({ projectName: "test-vanilla" });
    expect(existsSync(join(project, "client", "components.json"))).toBe(false);
    expect(existsSync(join(project, "client", "src", "components"))).toBe(false);
  });

  test("test_server_only_no_client", async () => {
    const project = await generate({
      projectName: "test-server-only",
      generateClient: false,
      clientFramework: null,
      clientServer: null,
    });
    // Verify server exists, client doesn't
    expect(existsSync(join(project, "server", "bot.ts"))).toBe(true);
    expect(existsSync(join(project, "client"))).toBe(false);
  });

  test("test_package_json_dependencies", async () => {
    // package.json only includes the selected transports' packages.
    const project = await generate({ projectName: "test-deps", transports: ["smallwebrtc"] });
    const pkg = JSON.parse(read(project, "client", "package.json"));
    expect(pkg.dependencies["@pipecat-ai/small-webrtc-transport"]).toBeDefined();
    expect(pkg.dependencies["@pipecat-ai/client-js"]).toBeDefined();
    // Not the other transports'.
    expect(pkg.dependencies["@pipecat-ai/websocket-transport"]).toBeUndefined();
    expect(pkg.dependencies["@pipecat-ai/livekit-transport"]).toBeUndefined();
    expect(pkg.devDependencies.vite).toBeDefined();
    expect(pkg.scripts.dev).toEqual("vite");
  });

  test("test_gitignore_includes_client", async () => {
    // .gitignore covers the client's build output when a client is generated.
    const project = await generate({ projectName: "test-gitignore" });
    const gitignore = read(project, ".gitignore");
    expect(gitignore).toContain("node_modules/"); // matches client/node_modules too
    expect(gitignore).toContain("client/dist/");
    const server = await generate({
      projectName: "server-only",
      generateClient: false,
      clientFramework: null,
      clientServer: null,
    });
    expect(read(server, ".gitignore")).not.toContain("client/dist/");
  });

  test("test_readme_reflects_structure", async () => {
    // README shows the correct project structure.
    const project = await generate({ projectName: "test-readme" });
    const readme = read(project, "README.md");
    expect(readme).toContain("server/");
    expect(readme).toContain("client/");
    expect(readme.includes("bun install") || readme.includes("bun run dev")).toBe(true);
  });
});

describe("TestStaticTypeScript", () => {
  // Test that generated JavaScript is clean and static.

  test("test_no_template_syntax_in_static_files", async () => {
    const project = await generate({
      projectName: "test-static",
      transports: ["smallwebrtc", "websocket"],
    });
    for (const file of [
      "client/src/app.js",
      "client/src/config.js",
      "client/src/style.css",
      "client/index.html",
      "client/package.json",
    ]) {
      const content = read(project, file);
      // Not a trace of Jinja2 syntax, nor of an unfilled template.
      expect(content, file).not.toContain("{%");
      expect(content, file).not.toContain("endfor");
      expect(content, file).not.toContain("{{");
    }
  });

  test("test_all_transport_types_in_config", async () => {
    // config.js builds each selected transport, and only those.
    const project = await generate({
      projectName: "test-all-transports",
      transports: ["smallwebrtc", "websocket", "livekit"],
    });
    const config = read(project, "client", "src", "config.js");
    for (const t of ServiceRegistry.WEBRTC_TRANSPORTS.map((x) => x.value)) {
      expect(config, `${t} missing`).toContain(`'${t}'`);
      expect(config).toContain(`${t}:`);
    }
    // The first selected one is the default.
    expect(config).toContain("DEFAULT_TRANSPORT = 'smallwebrtc'");
    // The start requests are the runner's /start bodies.
    expect(config).toContain("transport: 'webrtc'");
    expect(config).toContain("transport: 'websocket'");
    expect(config).toContain("transport: 'livekit'");
    // Each SDK transport is imported only when it is used.
    expect(config).toContain("import('@pipecat-ai/small-webrtc-transport')");
    expect(config).toContain("import('@pipecat-ai/websocket-transport')");
    expect(config).toContain("import('@pipecat-ai/livekit-transport')");

    const one = await generate({ projectName: "test-one", transports: ["websocket"] });
    const oneConfig = read(one, "client", "src", "config.js");
    expect(oneConfig).not.toContain("small-webrtc-transport");
    expect(oneConfig).toContain("DEFAULT_TRANSPORT = 'websocket'");
  });
});

describe("TestMonorepoStructure", () => {
  // Test the monorepo directory structure.

  test("test_monorepo_structure_with_client", async () => {
    // Projects with clients have the correct monorepo structure.
    const project = await generate({ projectName: "test-monorepo", dockerfile: true });
    // Root level files
    expect(existsSync(join(project, "README.md"))).toBe(true);
    expect(existsSync(join(project, ".gitignore"))).toBe(true);
    // Server files
    for (const f of ["bot.ts", "package.json", "tsconfig.json", ".env.example", "Dockerfile"]) {
      expect(existsSync(join(project, "server", f)), f).toBe(true);
    }
    // Client files
    expect(existsSync(join(project, "client", "package.json"))).toBe(true);
    expect(existsSync(join(project, "client", "src", "app.js"))).toBe(true);
    expect(existsSync(join(project, "client", "src", "config.js"))).toBe(true);
    expect(existsSync(join(project, "client", "index.html"))).toBe(true);
  });

  test("test_server_only_structure", async () => {
    // Server-only projects don't create a client directory.
    const project = await generate({
      projectName: "test-server-structure",
      generateClient: false,
      clientFramework: null,
      clientServer: null,
    });
    expect(existsSync(join(project, "README.md"))).toBe(true);
    expect(existsSync(join(project, ".gitignore"))).toBe(true);
    expect(existsSync(join(project, "server", "bot.ts"))).toBe(true);
    expect(existsSync(join(project, "server", "package.json"))).toBe(true);
    expect(existsSync(join(project, "client"))).toBe(false);
  });
});

describe("TestVanillaJSGeneration", () => {
  // Test Vanilla JS client generation.

  test("test_vanilla_vite_generation", async () => {
    // Vanilla JS client generation (always uses Vite).
    const project = await generate({
      projectName: "test-vanilla-vite",
      transports: ["smallwebrtc", "websocket"],
    });
    // Verify client structure
    expect(existsSync(join(project, "client", "src", "config.js"))).toBe(true);
    expect(existsSync(join(project, "client", "src", "app.js"))).toBe(true);
    expect(existsSync(join(project, "client", "index.html"))).toBe(true);
    expect(existsSync(join(project, "client", "package.json"))).toBe(true);
    expect(existsSync(join(project, "client", "env.example"))).toBe(true);

    // Verify config.js content
    const config = read(project, "client", "src", "config.js");
    expect(config).toContain("'smallwebrtc'");
    expect(config).toContain("'websocket'");
    expect(config).toContain("AVAILABLE_TRANSPORTS");

    // Verify app.js has no template syntax, and takes what config.js exports
    const app = read(project, "client", "src", "app.js");
    expect(app).not.toContain("{%");
    expect(app).toContain("AVAILABLE_TRANSPORTS");
    expect(app).toContain("from './config'");
    for (const name of [
      "AVAILABLE_TRANSPORTS",
      "DEFAULT_TRANSPORT",
      "PROJECT_NAME",
      "TRANSPORT_CONFIG",
      "TRANSPORT_LABELS",
    ]) {
      expect(config, name).toContain(`export const ${name}`);
    }
    expect(config).toContain("export async function createTransport");
    // No Pipecat logo or branding in the page.
    expect(read(project, "client", "index.html")).not.toContain("Pipecat");
  });

  test("test_vanilla_package_json_dependencies", async () => {
    // Vanilla JS package.json only includes the selected transports.
    const project = await generate({ projectName: "test-vanilla-deps", transports: ["websocket"] });
    const pkg = read(project, "client", "package.json");
    expect(pkg).toContain("@pipecat-ai/websocket-transport");
    expect(pkg).not.toContain("@pipecat-ai/small-webrtc-transport");
  });

  test("NEW: the client's config.js is valid JavaScript", async () => {
    const project = await generate({
      projectName: "js",
      transports: ["smallwebrtc", "websocket", "livekit"],
    });
    // `import.meta.env` is Vite's; the file must still parse as a module.
    for (const file of ["config.js", "app.js"]) {
      expect(
        () =>
          new Bun.Transpiler({ loader: "js" }).transformSync(read(project, "client", "src", file)),
        file,
      ).not.toThrow();
    }
  });
});
