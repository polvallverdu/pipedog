// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/**
 * A small `argparse` for the development runner's command line.
 *
 * Upstream's `main(parser)` takes an `argparse.ArgumentParser` so a bot can
 * add its own flags, then reads them from `runnerArgs.cli_args`. This class
 * covers the parts of argparse the runner and such bots use: optional flags
 * with short and long names, `type: "int" | "float"`, `choices`, `default`,
 * `dest`, and the actions `store`, `store_true`, `store_false`, `count` and
 * `boolean_optional` (`--x` / `--no-x`), plus `nargs: "*"`. No positional
 * arguments or subcommands. `-h` / `--help` prints the usage.
 *
 * @example
 * const parser = new ArgumentParser({ description: "My bot" });
 * parser.addArgument("--voice", { default: "alloy", help: "TTS voice" });
 * await main({ parser });
 * // in bot(): runnerArgs.cliArgs?.voice
 */

/** How a flag stores its value. */
export type ArgumentAction = "store" | "store_true" | "store_false" | "count" | "boolean_optional";

export interface ArgumentOptions {
  /** Defaults to `"store"`. */
  action?: ArgumentAction;
  /** Convert the value; strings are kept as given by default. */
  type?: "str" | "int" | "float";
  /** The allowed values. */
  choices?: readonly (string | number)[];
  /** The value when the flag is absent. */
  default?: unknown;
  /** The key in the parsed namespace; derived from the first long flag by default. */
  dest?: string;
  /** `"*"`: zero or more values, collected into an array. */
  nargs?: "*";
  /** Help text. */
  help?: string;
  /** Placeholder for the value in the usage text. */
  metavar?: string;
}

interface Argument extends ArgumentOptions {
  flags: string[];
  dest: string;
  action: ArgumentAction;
}

/** Raised for an invalid command line (argparse exits with status 2). */
export class ArgumentError extends Error {
  override name = "ArgumentError";
}

/** The parsed command line: each argument's `dest`, as argparse's `Namespace`. */
export type Namespace = Record<string, any>;

export interface ArgumentParserOptions {
  /** Shown at the top of `--help`. */
  description?: string;
  /** The program name in the usage line. */
  prog?: string;
}

function destOf(flags: string[]): string {
  const long = flags.find((f) => f.startsWith("--")) ?? flags[0]!;
  return long.replace(/^-+/, "").replaceAll("-", "_");
}

/** A command line parser shaped like Python's `argparse.ArgumentParser`. */
export class ArgumentParser {
  readonly description: string;
  readonly prog: string;
  #arguments: Argument[] = [];

  constructor(options: ArgumentParserOptions = {}) {
    this.description = options.description ?? "";
    this.prog = options.prog ?? "bot";
  }

  /**
   * Add a flag (`add_argument`).
   *
   * @param flags One or more names, e.g. `"-t", "--transport"`.
   * @throws ArgumentError If a name is already taken.
   */
  addArgument(...args: [...flags: string[], options: ArgumentOptions] | string[]): this {
    const last = args.at(-1);
    const options: ArgumentOptions = typeof last === "object" ? (last as ArgumentOptions) : {};
    const flags = (typeof last === "object" ? args.slice(0, -1) : args) as string[];
    if (flags.length === 0 || flags.some((f) => !f.startsWith("-"))) {
      throw new ArgumentError(`only optional flags are supported, got ${flags.join(", ")}`);
    }
    for (const flag of flags) {
      if (this.#find(flag)) {
        throw new ArgumentError(`argument ${flags.join("/")}: conflicting option string: ${flag}`);
      }
    }
    this.#arguments.push({
      ...options,
      flags,
      dest: options.dest ?? destOf(flags),
      action: options.action ?? "store",
    });
    return this;
  }

  #find(flag: string): { argument: Argument; negated: boolean } | null {
    for (const argument of this.#arguments) {
      if (argument.flags.includes(flag)) return { argument, negated: false };
      if (
        argument.action === "boolean_optional" &&
        argument.flags.some((f) => f.startsWith("--") && `--no-${f.slice(2)}` === flag)
      ) {
        return { argument, negated: true };
      }
    }
    return null;
  }

  #defaults(): Namespace {
    const namespace: Namespace = {};
    for (const a of this.#arguments) {
      if (a.dest in namespace) continue;
      if (a.default !== undefined) namespace[a.dest] = a.default;
      else if (a.action === "store_true") namespace[a.dest] = false;
      else if (a.action === "store_false") namespace[a.dest] = true;
      else namespace[a.dest] = null;
    }
    return namespace;
  }

  #convert(argument: Argument, raw: string): unknown {
    let value: unknown = raw;
    if (argument.type === "int") {
      if (!/^[-+]?\d+$/.test(raw)) {
        throw new ArgumentError(
          `argument ${argument.flags.join("/")}: invalid int value: '${raw}'`,
        );
      }
      value = Number.parseInt(raw, 10);
    } else if (argument.type === "float") {
      value = Number(raw);
      if (Number.isNaN(value)) {
        throw new ArgumentError(
          `argument ${argument.flags.join("/")}: invalid float value: '${raw}'`,
        );
      }
    }
    if (argument.choices && !argument.choices.includes(value as string | number)) {
      const choices = argument.choices.map((c) => `'${c}'`).join(", ");
      throw new ArgumentError(
        `argument ${argument.flags.join("/")}: invalid choice: '${raw}' (choose from ${choices})`,
      );
    }
    return value;
  }

  /**
   * Parse `argv` (without the runtime and script, e.g. `process.argv.slice(2)`).
   *
   * @throws ArgumentError For an unknown flag, a missing value or a bad choice.
   */
  parseArgs(argv: readonly string[]): Namespace {
    const namespace = this.#defaults();
    for (let i = 0; i < argv.length; i++) {
      let token = argv[i]!;
      let inline: string | null = null;
      if (token.startsWith("--") && token.includes("=")) {
        inline = token.slice(token.indexOf("=") + 1);
        token = token.slice(0, token.indexOf("="));
      }
      if (token === "-h" || token === "--help") {
        throw new HelpRequested(this.formatHelp());
      }
      const found = this.#find(token);
      if (!found) throw new ArgumentError(`unrecognized arguments: ${argv[i]}`);
      const { argument, negated } = found;
      const takesValue = argument.action === "store";
      if (!takesValue && inline !== null) {
        throw new ArgumentError(`argument ${token}: ignored explicit argument '${inline}'`);
      }
      switch (argument.action) {
        case "store_true":
          namespace[argument.dest] = true;
          break;
        case "store_false":
          namespace[argument.dest] = false;
          break;
        case "count":
          namespace[argument.dest] = (namespace[argument.dest] ?? 0) + 1;
          break;
        case "boolean_optional":
          namespace[argument.dest] = !negated;
          break;
        case "store": {
          if (argument.nargs === "*") {
            const values: unknown[] = inline !== null ? [this.#convert(argument, inline)] : [];
            while (i + 1 < argv.length && !argv[i + 1]!.startsWith("-")) {
              values.push(this.#convert(argument, argv[++i]!));
            }
            namespace[argument.dest] = values;
          } else {
            const raw = inline ?? argv[++i];
            if (raw === undefined) {
              throw new ArgumentError(
                `argument ${argument.flags.join("/")}: expected one argument`,
              );
            }
            namespace[argument.dest] = this.#convert(argument, raw);
          }
          break;
        }
      }
    }
    return namespace;
  }

  /** The `--help` text. */
  formatHelp(): string {
    const lines = [`usage: ${this.prog} [options]`, ""];
    if (this.description) lines.push(this.description, "");
    lines.push("options:");
    lines.push("  -h, --help            show this help message and exit");
    for (const a of this.#arguments) {
      const value = a.action === "store" ? ` ${a.metavar ?? a.dest.toUpperCase()}` : "";
      const names =
        a.action === "boolean_optional"
          ? [
              ...a.flags,
              ...a.flags.filter((f) => f.startsWith("--")).map((f) => `--no-${f.slice(2)}`),
            ]
          : a.flags;
      const head = `  ${names.join(", ")}${value}`;
      lines.push(a.help ? `${head.padEnd(24)}${a.help}` : head);
    }
    return `${lines.join("\n")}\n`;
  }
}

/** Raised by `parseArgs` for `-h` / `--help`; `message` is the help text. */
export class HelpRequested extends Error {
  override name = "HelpRequested";
}
