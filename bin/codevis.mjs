#!/usr/bin/env node
/**
 * CodeVis CLI — Graph-based code intelligence for Claude Code agent teams.
 *
 * Usage:
 *   npx codevis init          # Initialize CodeVis in current project
 *   npx codevis build [mode]  # Build/update the code graph (embedded DB)
 *   npx codevis start         # Start MCP server (stdio)
 *   npx codevis kanban        # Show task dashboard
 */

import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import { commandDefinitions } from "../lib/cli-commands.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const require = createRequire(import.meta.url);
const ui = require("../lib/terminal-ui.cjs");

/** Root of the installed codevis package */
export const packageRoot = resolve(__dirname, "..");

/** Current working directory (the target project) */
export const projectRoot = process.cwd();

const [command, ...args] = process.argv.slice(2);

const commands = Object.fromEntries(
  Object.entries(commandDefinitions).map(([name, definition]) => [name, definition.load]),
);

const commandHelp = Object.fromEntries(
  Object.entries(commandDefinitions).map(([name, definition]) => [name, definition.help]),
);

async function main() {
  // `help` without dashes is what people type first; refusing it with
  // "Unknown command" for the sake of a convention is a pointless dead end.
  if (!command || command === "--help" || command === "-h") {
    printHelp();
    process.exit(0);
  }

  if (command === "help") {
    if (args[0]) printCommandHelp(args[0]);
    else printHelp();
    process.exit(process.exitCode || 0);
  }

  const loader = commands[command];
  if (!loader) {
    console.error(`${ui.badge("ERROR", "red")} Unknown command: ${command}`);
    console.error(`${ui.paint("Hint", "cyan")}: run 'codevis help' for usage.`);
    process.exit(1);
  }

  if (args[0] === "--help" || args[0] === "-h") {
    printCommandHelp(command);
    process.exit(0);
  }

  const mod = await loader();
  await mod.default(args);
}

function printHelp() {
  console.log(`${ui.title("CodeVis", "graph-based code intelligence")}
${ui.section("Usage")}
  codevis <command> [options]

${ui.section("Commands")}
${Object.entries(commandDefinitions).map(([name, entry]) => `  ${name.padEnd(12)}  ${entry.description}`).join("\n")}

${ui.section("Options")}
  --help, -h    Show this help message

${ui.section("Examples")}
  codevis init                         Interactive setup wizard
  codevis init new                     Plan a new project without code builds
  codevis init code --source ./src     Switch the project to code-graph mode
  codevis build                        Incremental graph update
  codevis build codevis_db full        Full CodeVis self-graph rebuild
  codevis diff-graph feat/x --base main
  codevis impact save --file src/save.js --depth 3
  codevis dashboard                    Open the graph dashboard

Run ${ui.paint("codevis help <command>", "green")} for every argument and option.
`);
}

function printCommandHelp(name) {
  const entry = commandHelp[name];
  if (!entry || !commands[name]) {
    console.error(`${ui.badge("ERROR", "red")} Unknown command: ${name}`);
    console.error(`${ui.paint("Hint", "cyan")}: run 'codevis help' for the complete command list.`);
    process.exitCode = 1;
    return;
  }
  const lines = [ui.title("CodeVis", `${name} command`), ui.section("Usage"), `  ${entry.usage}`];
  if (entry.arguments?.length) lines.push("", ui.section("Arguments"), ...entry.arguments.map((line) => `  ${line}`));
  if (entry.options?.length) lines.push("", ui.section("Options"), ...entry.options.map((line) => `  ${line}`));
  if (entry.note) lines.push("", ui.section("Note"), `  ${entry.note}`);
  console.log(lines.join("\n"));
}

main().catch((err) => {
  console.error(`${ui.badge("ERROR", "red")} ${err.message || err}`);
  process.exit(1);
});
