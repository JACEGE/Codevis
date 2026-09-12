#!/usr/bin/env node
/**
 * codevis start — Start the MCP server (stdio transport).
 *
 * This is called automatically by Claude Code via settings.local.json.
 * Can also be run manually for debugging.
 */

import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { execFileSync } from "child_process";
import { createRequire } from "module";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageRoot = resolve(__dirname, "../..");

export default async function start(args) {
  if (args.length) throw new Error(`Unknown option: ${args[0]}`);
  const mcpServer = resolve(packageRoot, "tools/mcp_server.ts");
  const require = createRequire(import.meta.url);
  const projectRoot = require(resolve(packageRoot, "server/codevis-paths.cjs")).PROJECT_ROOT;
  // Run the installed TS runtime with Node directly. A nested `npx` is both
  // unnecessary and broken through execFileSync on Windows: bare `npx` gives
  // ENOENT, while `npx.cmd` gives EINVAL on current Node versions.
  const tsxCli = resolve(packageRoot, "lib/tsx-launcher.cjs");

  execFileSync(process.execPath, [tsxCli, mcpServer], {
    cwd: projectRoot,
    stdio: "inherit",
    env: {
      ...process.env,
      CODEVIS_PROJECT_DIR: projectRoot,
    },
  });
}
