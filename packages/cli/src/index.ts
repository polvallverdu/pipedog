// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/cli/__init__.py

/**
 * pipedog CLI: command-line tools for building pipedog voice agents.
 *
 * This package provides command-line tools for:
 *
 * - Initializing a new pipedog project with `pipedog init` (the entry point: writes the
 *   coding-agent guide and registers the docs MCP server, then helps you build with a coding
 *   agent or scaffolds a runnable bot, interactively or non-interactively from flags or a
 *   config file)
 * - Running behavioral evals against a bot with `pipedog eval` (the `@pipedog/evals` commands)
 *
 * This index also holds what upstream's package `__init__` files re-export:
 * `pipecat.cli.commands` (`init`), `pipecat.cli.generators` (`ProjectGenerator`),
 * `pipecat.cli.prompts` (`ProjectConfig`, `askProjectQuestions`) and `pipecat.cli.registry`
 * (`ServiceRegistry`, `ServiceLoader`).
 *
 * Not ported: extensions such as Pipecat Cloud (`pipecat cloud`), which have no counterpart.
 */

export { Exit, type Io } from "./_io.ts";
export {
  ConfigValidationError,
  configToJson,
  loadConfigFromFile,
  validateAndBuildConfig,
} from "./config_validator.ts";
export { initCommand } from "./init.ts";
export { run } from "./main.ts";
export {
  describeMcpResults,
  MCP_ARGS,
  MCP_COMMAND,
  MCP_SERVER_NAME,
  MCP_TARGETS,
  type McpClient,
  type McpResult,
  registerMcp,
} from "./mcp_register.ts";
export { FileExistsError, ProjectGenerator } from "./project.ts";
export {
  askProjectQuestions,
  ProjectCancelledError,
  ProjectConfig,
  type Prompter,
} from "./questions.ts";
export {
  generateScaffold,
  listOptions,
  resolveScaffoldConfig,
  scaffoldQuickstart,
} from "./scaffold.ts";
export { ServiceLoader } from "./service_loader.ts";
export { NOT_OFFERED, ServiceDefinition, ServiceRegistry } from "./service_metadata.ts";
