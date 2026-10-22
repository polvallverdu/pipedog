// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/cli/generators/project.py

/**
 * Main project generator that orchestrates file creation.
 *
 * DIVERGENCE: upstream renders Jinja2 templates and formats the Python with Ruff
 * (`_format_python_files`); the templates here are TypeScript functions (`./templates/`) and
 * files in the package's `templates/` directory, and the output is not run through a formatter.
 * Not generated, because pipedog has no counterpart: `server.py` and `server_utils.py` (Daily
 * PSTN and Twilio + Daily SIP), `pcc-deploy.toml` (Pipecat Cloud), the React clients. A
 * `Dockerfile` is optional (`dockerfile`). An existing `README.md` or `.gitignore` is kept when
 * scaffolding in place, as the guide files are.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  ClackPrompter,
  ProjectCancelledError,
  type ProjectConfig,
  type Prompter,
} from "./questions.ts";
import { readAsset, VERSION } from "./templates/assets.ts";
import { renderClientConfig, renderClientPackageJson } from "./templates/client.ts";
import { renderGitignore } from "./templates/gitignore.ts";
import { commands, renderReadme } from "./templates/readme.ts";
import { renderBot } from "./templates/server_bot.ts";
import {
  renderDockerfile,
  renderEnvExample,
  renderEvalScenario,
  renderPackageJson,
  renderTsconfig,
} from "./templates/server_files.ts";

/** The static files of the vanilla client, under the package's `templates/client/vanilla-js-vite/`. */
const VANILLA_CLIENT_FILES = ["index.html", "src/app.js", "src/style.css"] as const;

export interface ProjectGeneratorOptions {
  /** The `@pipedog/*` release the project depends on (default: this package's version). */
  version?: string;
  /** Where messages go, one line per call (default: `console.log`). */
  out?: (line: string) => void;
  /** Asked for another name when the directory exists (default: `@clack/prompts`). */
  prompter?: Prompter;
}

export interface GenerateOptions {
  /** Raise `FileExistsError` instead of prompting. */
  nonInteractive?: boolean;
  /**
   * Scaffold directly into `outputDir` (or the current directory) without nesting under a
   * `<projectName>` subfolder.
   */
  inPlace?: boolean;
}

/** Raised when a project already exists at the destination (upstream's `FileExistsError`). */
export class FileExistsError extends Error {
  override name = "FileExistsError";
}

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
}

/** Generates a complete pipedog project from configuration. */
export class ProjectGenerator {
  readonly config: ProjectConfig;
  readonly version: string;
  readonly #out: (line: string) => void;
  readonly #prompter: Prompter | null;

  /** @param config Project configuration from user prompts or flags. */
  constructor(config: ProjectConfig, options: ProjectGeneratorOptions = {}) {
    this.config = config;
    this.version = options.version ?? VERSION;
    this.#out = options.out ?? ((line) => console.log(line));
    this.#prompter = options.prompter ?? null;
  }

  /** Ask for a new project name if the current one already exists. */
  async #promptForNewName(outputDir: string): Promise<string> {
    const prompter = this.#prompter ?? new ClackPrompter();
    for (;;) {
      this.#out(`\n⚠️  Directory '${this.config.projectName}' already exists!`);
      const name = await prompter.text("Please enter a different project name:", {
        initialValue: `${this.config.projectName}-new`,
        validate: (text) => (text.length > 0 ? undefined : "Project name cannot be empty"),
      });
      if (!name) throw new ProjectCancelledError();
      // If the new name is available we're done; otherwise ask again.
      if (!existsSync(join(outputDir, name))) return name;
    }
  }

  /**
   * Generate the complete project structure.
   *
   * @param outputDir The directory to create the project in (default: the current directory).
   *   With `inPlace` it is the exact destination; otherwise the project is created in a
   *   `<outputDir>/<projectName>` subfolder.
   * @returns The path of the created project directory.
   * @throws FileExistsError If a project already exists at the destination and `nonInteractive` is set.
   * @throws ProjectCancelledError If the user cancels, or the project already exists in place.
   */
  async generate(outputDir: string | null = null, options: GenerateOptions = {}): Promise<string> {
    const { nonInteractive = false, inPlace = false } = options;
    const base = resolve(outputDir ?? process.cwd());

    if (inPlace) {
      // Scaffold directly into the directory: no <projectName> subfolder.
      mkdirSync(base, { recursive: true });
      // Guard against clobbering an existing project. The presence of a server/ directory is our
      // "a project already lives here" signal (cargo-init style).
      if (existsSync(join(base, "server"))) {
        if (nonInteractive) {
          throw new FileExistsError(
            `A project already exists in ${base} (found a 'server' directory)`,
          );
        }
        this.#out(`\n⚠️  A project already exists in ${base} (found a 'server' directory).`);
        throw new ProjectCancelledError();
      }
      return this.#writeProjectFiles(base);
    }

    let projectPath = join(base, this.config.projectName);
    // Check if the project already exists
    if (existsSync(projectPath)) {
      if (nonInteractive) {
        throw new FileExistsError(
          `Directory '${this.config.projectName}' already exists in ${base}`,
        );
      }
      this.config.projectName = await this.#promptForNewName(base);
      projectPath = join(base, this.config.projectName);
    }
    return this.#writeProjectFiles(projectPath);
  }

  /** Create the directory structure and render all project files into `projectPath`. */
  #writeProjectFiles(projectPath: string): string {
    const { config } = this;
    const ctx = { version: this.version };
    mkdirSync(projectPath, { recursive: true });
    const server = join(projectPath, "server");
    mkdirSync(server, { recursive: true });

    // 1. bot.ts (in server/)
    write(join(server, "bot.ts"), renderBot(config));
    // 2. package.json and tsconfig.json (in server/)
    write(join(server, "package.json"), renderPackageJson(config, ctx));
    write(join(server, "tsconfig.json"), renderTsconfig(config));
    // 3. .env.example (in server/)
    write(join(server, ".env.example"), renderEnvExample(config));
    // 3b. Starter eval scenario (in server/evals/). A realtime bot has no text step to assert on.
    if (config.enableEval && config.mode === "cascade") {
      write(join(server, "evals", "starter_text.yaml"), renderEvalScenario(config));
    }
    // 4. .gitignore and README.md (at the root); an existing one is kept
    this.#writeIfAbsent(join(projectPath, ".gitignore"), renderGitignore(config.generateClient));
    this.#writeIfAbsent(join(projectPath, "README.md"), renderReadme(config));
    // 5. Dockerfile (in server/)
    if (config.dockerfile) write(join(server, "Dockerfile"), renderDockerfile(config));
    // 6. The client
    if (config.generateClient) this.#generateClient(join(projectPath, "client"));

    return projectPath;
  }

  #writeIfAbsent(path: string, content: string): void {
    if (existsSync(path)) {
      this.#out(`• Kept ${path}`);
      return;
    }
    write(path, content);
  }

  /** Generate the client application files. */
  #generateClient(clientPath: string): void {
    const { config } = this;
    if (config.clientFramework !== "vanilla" || config.clientServer !== "vite") {
      this.#out(`⚠️  Unknown client: ${config.clientFramework}/${config.clientServer}`);
      return;
    }
    const dir = "templates/client/vanilla-js-vite";
    for (const file of VANILLA_CLIENT_FILES) {
      write(join(clientPath, file), readAsset(`${dir}/${file}`));
    }
    write(join(clientPath, "env.example"), readAsset(`${dir}/env.example`));
    write(join(clientPath, "package.json"), renderClientPackageJson(config));
    write(join(clientPath, "src", "config.js"), renderClientConfig(config));
  }

  /**
   * Print next steps for the user.
   *
   * @param projectPath The directory the project was created in.
   * @param inPlace Whether the project was scaffolded into the current directory, so the "cd
   *   into your project" step is omitted.
   */
  printNextSteps(projectPath: string, inPlace = false): void {
    const { config } = this;
    const { install, run, exec, clientInstall, clientDev } = commands(config);
    const out = this.#out;
    out("\n✨ Project created successfully!");
    out(`   ${projectPath}\n`);
    out("Next steps:\n");
    if (!inPlace) out(`  • Go to your project: cd ${config.projectName}`);

    // Client setup
    if (config.generateClient) {
      out("\n  Client setup:");
      out("  • Go to client: in a separate terminal window or tab, cd client");
      out(`  • Install dependencies: ${clientInstall}`);
      out(`  • Run dev server: ${clientDev}`);
    }

    // Server setup
    out("\n  Server setup:");
    out("  • Go to server: cd server");
    out(`  • Install dependencies: ${install}`);
    out("  • Create .env file: cp .env.example .env");
    out("  • Edit .env and add your API keys");

    // Every standard transport runs the same way. The runner serves all transports and the
    // caller selects which one: a web client picks its transport when it connects, and a
    // telephony provider connects to /ws. Telephony additionally needs a public tunnel so the
    // provider can reach the bot.
    const hasTelephony = config.botType === "telephony";
    out(`  • Run your bot: ${run}`);
    if (config.botType === "web" && !config.generateClient) {
      out("  • Talk to it: open http://localhost:7860 and click Connect");
    }
    if (config.enableEval && config.mode === "cascade") {
      out(
        `  • Test it with evals: ${run}, then in another terminal ${exec} pipedog eval run evals/starter_text.yaml -v`,
      );
    }
    if (hasTelephony) {
      out(
        `  • Expose it for telephony: ngrok http 7860, then run ${run} -t <provider> --proxy <your-ngrok-host> and point your provider's webhook at https://<your-ngrok-host>/`,
      );
    }
    out("\nSee README.md for detailed setup instructions.\n");
  }
}

/** Read a generated project's file, for tests and tools (`null` if it doesn't exist). */
export function readProjectFile(projectPath: string, relativePath: string): string | null {
  const path = join(projectPath, relativePath);
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}
