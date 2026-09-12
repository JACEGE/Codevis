#!/usr/bin/env node
/**
 * codevis kanban [--watch [interval]] — Terminal task dashboard.
 * codevis kanban --web [--port 4200] — Web Kanban board in browser.
 */

import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { execFileSync, spawn } from "child_process";
import { createRequire } from "module";
import ui from "../terminal-ui.cjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageRoot = resolve(__dirname, "../..");
const require = createRequire(import.meta.url);
const { openBrowser } = require("../open-browser.cjs");
const { parsePort } = require("../network-options.cjs");

export function validateKanbanArgs(args) {
  const web = args.includes("--web");
  if (web) {
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "--web") continue;
      if (args[i] === "--port") {
        if (args[i + 1] === undefined || args[i + 1].startsWith("--")) throw new Error("--port needs a value");
        i++;
        continue;
      }
      throw new Error(`Unknown option: ${args[i]}`);
    }
    return;
  }
  if (!args.length) return;
  if (args[0] !== "--watch") throw new Error(`Unknown option: ${args[0]}`);
  if (args.length > 2) throw new Error(`Unexpected argument: ${args[2]}`);
  if (args[1] !== undefined && (!Number.isFinite(Number(args[1])) || Number(args[1]) <= 0)) {
    throw new Error("--watch interval must be a positive number of seconds");
  }
}

export default async function kanban(args) {
  validateKanbanArgs(args);
  const projectRoot = require(resolve(packageRoot, "server/codevis-paths.cjs")).PROJECT_ROOT;
  if (args.includes("--web")) {
    // Web Kanban
    const portIdx = args.indexOf("--port");
    let port;
    try { port = parsePort(portIdx !== -1 && args[portIdx + 1] ? args[portIdx + 1] : "4200", "--port"); }
    catch (error) { console.error(error.message); process.exit(1); }
    const server = resolve(packageRoot, "lib/kanban-server.mjs");
    const url = `http://localhost:${port}`;

    console.log(`${ui.title("CodeVis", "web kanban")}\n${ui.section("Ready")}`);
    console.log(`  ${ui.badge("ONLINE", "green")} ${ui.link(url)}\n`);

    const child = spawn(process.execPath, [server], {
      cwd: projectRoot,
      stdio: "inherit",
      env: {
        ...process.env,
        CODEVIS_PROJECT_DIR: projectRoot,
        KANBAN_PORT: String(port),
      },
    });

    // Open browser after short delay
    setTimeout(() => {
      try {
        openBrowser(url);
      } catch {}
    }, 500);

    // Keep running until Ctrl+C
    child.on("close", (code) => process.exit(code || 0));
    return;
  }

  // Terminal Kanban
  const kanbanScript = resolve(packageRoot, "scripts/kanban.js");
  execFileSync(process.execPath, [kanbanScript, ...args], {
    cwd: projectRoot,
    stdio: "inherit",
    env: {
      ...process.env,
      CODEVIS_PROJECT_DIR: projectRoot,
    },
  });
}
