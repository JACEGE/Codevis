#!/usr/bin/env node
/**
 * codevis dashboard — Serve the graph dashboard + Kanban for this project.
 *
 * Runs the bridge, which serves the built frontend and talks to this project's
 * embedded graph. The port is derived from the project path, so several projects
 * can serve their dashboards side by side; --port / CODEVIS_BRIDGE_PORT override.
 *
 * --db <database> picks project_db (default) or codevis_db. Legacy aliases are
 * accepted and normalized before the bridge starts.
 */

import { resolve, dirname, join } from "path";
import { fileURLToPath } from "url";
import { existsSync } from "fs";
import { spawn, execSync } from "child_process";
import { createRequire } from "module";
import { reuseDashboard } from "../dashboard-session.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageRoot = resolve(__dirname, "../..");
const require = createRequire(import.meta.url);
const ui = require("../terminal-ui.cjs");
const { openBrowser } = require("../open-browser.cjs");
const { parsePort } = require("../network-options.cjs");

export default async function dashboard(args = []) {
  const paths = require(join(packageRoot, "server", "codevis-paths.cjs"));
  const projectRoot = paths.PROJECT_ROOT;
  if (!existsSync(join(projectRoot, "codevis.config.cjs")) &&
      !existsSync(join(projectRoot, "codevis.config.js"))) {
    console.error("No codevis config here. Run 'npx codevis init' first.");
    process.exit(1);
  }

  // Unknown arguments are an error, not something to ignore. Every flag below is
  // looked up with indexOf, so a mistyped one simply is not found and the command
  // proceeds on its defaults — silently. '-.db meta' (a dot instead of the second
  // dash) opened the dashboard on 'target' with no complaint, which reads as
  // "--db does not work" and gets debugged as a bug in the dashboard.
  const VALUE_FLAGS = new Set(["--port", "--db"]);
  const BOOL_FLAGS = new Set(["--no-open", "--watch", "--no-watch", "--web-shell"]);
  const unknownArgs = [];
  for (let i = 0; i < args.length; i++) {
    if (VALUE_FLAGS.has(args[i])) {
      if (args[i + 1] === undefined || args[i + 1].startsWith("--")) {
        console.error(`${args[i]} needs a value`);
        process.exit(1);
      }
      i++;
      continue;
    }
    if (BOOL_FLAGS.has(args[i])) continue;
    unknownArgs.push(args[i]);
  }
  if (unknownArgs.length > 0) {
    console.error(`Unknown argument: ${unknownArgs.join(", ")}`);
    console.error("Usage: codevis dashboard [--db <workspace>] [--port <n>] [--no-open] [--watch|--no-watch] [--web-shell]");
    process.exit(1);
  }

  const env = { ...process.env, CODEVIS_PROJECT_DIR: projectRoot };
  // A browser-accessible PTY is intentionally per-process opt-in. Keeping this
  // out of persistent project config prevents a forgotten setting from silently
  // exposing a shell on every later dashboard start.
  env.CODEVIS_WEB_SHELL = args.includes("--web-shell") ? "1" : "0";
  const portFlag = args.indexOf("--port");
  if (portFlag !== -1 && args[portFlag + 1]) {
    try { env.CODEVIS_BRIDGE_PORT = String(parsePort(args[portFlag + 1], "--port")); }
    catch (error) { console.error(error.message); process.exit(1); }
  }

  // Which workspace the dashboard opens on. Without this the only way to start
  // on 'meta' was an environment variable, so a project whose target graph was
  // never built greeted you with an empty 3D view and no hint that the other
  // workspace is the populated one.
  const dbFlag = args.indexOf("--db");
  if (dbFlag !== -1) {
    const db = args[dbFlag + 1];
    const { normalizeWorkspaceName } = require(join(packageRoot, "lib", "workspace-names.cjs"));
    let normalized;
    try { normalized = normalizeWorkspaceName(db, "project_db"); } catch { normalized = null; }
    if (!normalized) {
      console.error("--db needs project_db or codevis_db (legacy aliases are accepted)");
      process.exit(1);
    }
    env.CODEVIS_DEFAULT_DB = normalized;
  }

  // Ask the shared path module for the port the bridge is about to bind, so the
  // banner and the browser we open cannot drift from reality.
  const port = env.CODEVIS_BRIDGE_PORT || paths.BRIDGE_PORT;
  const projectConfig = paths.loadConfig();

  try {
    const running = await reuseDashboard({
      port, projectRoot, dataDir: paths.DATA_DIR,
      db: env.CODEVIS_DEFAULT_DB, webShell: args.includes("--web-shell"),
    });
    if (running) {
      const url = `http://localhost:${port}`;
      console.log(`Reusing CodeVis dashboard: ${url}`);
      console.log(`Project: ${projectRoot}\nWorkspace: ${running.activeDb}`);
      if (args.includes("--watch") || args.includes("--no-watch")) {
        console.log("Watcher options apply on startup; the existing watcher was left unchanged.");
      }
      if (!args.includes("--no-open")) openBrowser(url);
      return;
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
    return;
  }

  const distIndex = join(packageRoot, "frontend", "dist", "index.html");
  if (!existsSync(distIndex)) {
    // In a git checkout the sources are right there, so just build them. In an
    // installed package they are not shipped — building is impossible and the
    // real problem is a broken package, so say that instead of failing obscurely.
    const frontendSrc = join(packageRoot, "frontend", "package.json");
    if (existsSync(frontendSrc)) {
      console.log("  Building the frontend (first run)...");
      try {
        execSync("npm install && npm run build", {
          cwd: join(packageRoot, "frontend"),
          stdio: "inherit",
        });
      } catch {
        console.error("  Frontend build failed — run 'npm run build' in frontend/ to see why.");
        process.exit(1);
      }
    } else {
      console.error("  The dashboard bundle is missing from this install (frontend/dist).");
      console.error("  This is a packaging bug — please report it.");
      process.exit(1);
    }
  }

  const openingOn = env.CODEVIS_DEFAULT_DB ? `, workspace: ${env.CODEVIS_DEFAULT_DB}` : "";
  const url = `http://localhost:${port}`;
  console.log(`\n${ui.title("CodeVis", "dashboard")}`);
  console.log(ui.section("Ready"));
  console.log(`  ${ui.badge("ONLINE", "green")} ${ui.link(url)}`);
  console.log(`  project          ${projectRoot}${openingOn}\n`);

  const child = spawn(process.execPath, [join(packageRoot, "server", "bridge.js")], {
    cwd: projectRoot,
    stdio: "inherit",
    env,
  });

  const shouldWatch = projectConfig.workMode !== "planning" &&
    (args.includes("--watch") || (!args.includes("--no-watch") && projectConfig.autoUpdate?.enabled === true));
  const watcher = shouldWatch
    ? spawn(process.execPath, [join(packageRoot, "bin", "codevis.mjs"), "watch"], {
        cwd: projectRoot,
        stdio: "inherit",
        env,
      })
    : null;

  if (!args.includes("--no-open")) {
    setTimeout(() => openBrowser(`http://localhost:${port}`), 1500);
  }

  child.on("exit", (code) => {
    if (watcher && !watcher.killed) watcher.kill();
    process.exit(code ?? 0);
  });

  // Forward signals so Ctrl+C shuts the bridge down cleanly — an abrupt kill can
  // leave the DB's WAL un-checkpointed.
  for (const sig of ["SIGINT", "SIGTERM"]) {
    process.on(sig, () => {
      if (watcher && !watcher.killed) watcher.kill(sig);
      child.kill(sig);
    });
  }
}
