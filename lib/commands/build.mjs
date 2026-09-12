#!/usr/bin/env node
/**
 * codevis build [mode] — Build/update the code graph in the embedded
 * Ladybug DB.
 *
 * Modes:
 *   diff  (default) — Only re-parse changed files
 *   full            — Clear and rebuild the entire graph
 */

import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { execFileSync } from "child_process";
import { createRequire } from "module";
import workspaceNames from "../workspace-names.cjs";
import ui from "../terminal-ui.cjs";

const { normalizeWorkspaceName, publicWorkspaceName } = workspaceNames;

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageRoot = resolve(__dirname, "../..");
const require = createRequire(import.meta.url);

export default async function build(args) {
  const first = args[0];
  const maxArgs = ["full", "diff"].includes(first) ? 1 : 2;
  if (args.length > maxArgs) throw new Error(`Unexpected argument: ${args[maxArgs]}`);
  const workspace = ["full", "diff", undefined].includes(first)
    ? "target"
    : normalizeWorkspaceName(first);
  const mode = (["full", "diff"].includes(first) ? first : args[1]) || "diff";
  if (!["full", "diff"].includes(mode)) {
    console.error(`Unknown build mode: ${mode}. Use 'full' or 'diff'.`);
    process.exit(1);
  }

  const paths = require(resolve(packageRoot, "server/codevis-paths.cjs"));
  if (workspace === "target") {
    const config = paths.loadConfig();
    if (config.workMode === "planning") {
      console.log(`${ui.title("CodeVis", "graph build")}\n${ui.section("Skipped")}`);
      console.log("  Planning mode does not build a code graph.");
      console.log("  Switch after code exists: codevis init code [--source <paths>]\n");
      return;
    }
  }

  const graphBuilder = resolve(packageRoot, "scripts/graph_builder.js");
  const buildArgs = [workspace];
  if (mode === "diff") buildArgs.push("diff");

  console.log(`${ui.title("CodeVis", "graph build")}\n${ui.section("Build")}`);
  console.log(`  workspace        ${publicWorkspaceName(workspace)}`);
  console.log(`  mode             ${ui.badge(mode.toUpperCase(), mode === "full" ? "yellow" : "green")}\n`);

  execFileSync(process.execPath, [graphBuilder, ...buildArgs], {
    cwd: paths.PROJECT_ROOT,
    stdio: "inherit",
    env: {
      ...process.env,
      CODEVIS_PROJECT_DIR: paths.PROJECT_ROOT,
    },
  });
}
