#!/usr/bin/env node
/**
 * codevis init — Interactive setup wizard.
 *
 * Copies templates into the target project and writes the config. The graph
 * lives in the embedded Ladybug database — there is nothing to install or start.
 */

import { resolve, dirname, relative } from "path";
import { fileURLToPath } from "url";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from "fs";
import { createInterface } from "readline";
import { createRequire } from "module";
import { execSync } from "child_process";
import { updateConfigSource } from "../init-config.mjs";
import { configureCodex } from "../init-codex.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageRoot = resolve(__dirname, "../..");
const projectRoot = process.cwd();
const require = createRequire(import.meta.url);
const ui = require("../terminal-ui.cjs");

// ── Helpers ───────────────────────────────────────────────────────

function ask(rl, question, defaultVal) {
  return new Promise((resolve) => {
    const suffix = defaultVal ? ` (${defaultVal})` : "";
    rl.question(`${question}${suffix}: `, (answer) => {
      resolve(answer.trim() || defaultVal || "");
    });
  });
}

// A hand-edited .mcp.json or settings file (a // comment, a trailing comma)
// used to abort init with a bare "Unexpected token" that named no file.
function readJsonConfig(file) {
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, "utf-8"));
  } catch (error) {
    throw new Error(`Cannot parse ${file}: ${error.message}. Fix or remove the file, then run init again.`);
  }
}

export function detectedSourceDirs(root) {
  const common = ["src", "app", "lib", "server", "client", "packages", "tools"];
  return common.filter((name) => existsSync(resolve(root, name)) && statSync(resolve(root, name)).isDirectory());
}

export function normalizeSourceDirs(value) {
  const raw = String(value || "").trim();
  if (!raw || /^(none|no|empty)$/i.test(raw)) return [];
  if (/^(all|everything)$/i.test(raw)) return ["."];
  return raw.split(",").map((d) => d.trim()).filter(Boolean);
}

export function existingSetup(config = {}) {
  const workspace = config.workspaces?.project_db || config.workspaces?.project || config.workspaces?.target || config.workspaces?.tool;
  const array = (value) => Array.isArray(value) ? value : value == null ? [] : [value];
  return {
    sourceDirs: array(workspace?.sourceDir).map(String),
    exclude: array(workspace?.exclude).map(String),
    knowledgePaths: array(config.knowledge?.paths).map(String),
    autoUpdate: Boolean(config.autoUpdate?.enabled),
    locking: Boolean(config.locking?.enabled),
    ros: Boolean(workspace?.extractors?.ros ?? config.extractors?.ros),
    workMode: config.workMode === "planning" ? "planning" : "code",
  };
}

function yes(value) { return /^(y|yes|j|ja|true|1)$/i.test(String(value)); }

function copyDirRecursive(src, dest) {
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src)) {
    const srcPath = resolve(src, entry);
    const destPath = resolve(dest, entry);
    if (statSync(srcPath).isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else {
      copyFileSync(srcPath, destPath);
    }
  }
}

// ── AI clients ────────────────────────────────────────────────────
// Which coding agents get an MCP entry (and, where the client has them, the
// hooks). Every client's config file is written in that client's own format.
export const CLIENTS = ["claude", "codex", "antigravity"];

function defaultClients() { return ["claude", "codex"]; }

export function parseClients(value) {
  const names = String(value).split(/[\s,]+/).map((v) => v.trim().toLowerCase()).filter(Boolean);
  if (names.length === 1 && names[0] === "none") return [];
  const unknown = names.filter((name) => !CLIENTS.includes(name));
  if (unknown.length) throw new Error(`Unknown AI client: ${unknown.join(", ")}. Choose from ${CLIENTS.join(", ")}.`);
  return [...new Set(names)];
}

/** Clients this project is already set up for; a re-init keeps exactly those. */
export function configuredClients(root) {
  const has = (file, text) => {
    try { return readFileSync(resolve(root, file), "utf8").includes(text); } catch { return false; }
  };
  const found = [];
  if (has(".mcp.json", "codevis_graph")) found.push("claude");
  if (has(".codex/config.toml", "codevis_graph")) found.push("codex");
  if (has(".gemini/antigravity/mcp_config.json", "codevis_graph")) found.push("antigravity");
  return found;
}

// ── Main ──────────────────────────────────────────────────────────

// Parse CLI flags: --source ./src,./lib [-y] [--antigravity].
export function parseFlags(args) {
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    // --source und --exclude sind Listen, also darf die wiederholte Angabe
    // nicht die vorige überschreiben. `--source ./projects --source ./vendor`
    // legte vorher nur `./vendor` an, und zwar wortlos: der Aufruf war
    // erfolgreich, die Haelfte des Projekts fehlte im Graphen. Beide Formen
    // führen jetzt zum selben Ergebnis wie die Kommaform, die
    // normalizeSourceDirs ohnehin auflöst.
    const arg = args[i];
    if (arg === "new" || arg === "code") {
      if (flags.workMode) throw new Error("Choose either 'new' or 'code', not both");
      flags.workMode = arg === "new" ? "planning" : "code";
    } else if (["--source", "--exclude", "--knowledge"].includes(arg)) {
      const value = args[i + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(`${arg} needs a value`);
      i++;
      if (arg === "--source") flags.source = flags.source ? `${flags.source},${value}` : value;
      else if (arg === "--exclude") flags.exclude = flags.exclude ? `${flags.exclude},${value}` : value;
      else flags.knowledge = value;
    } else if (arg === "--watch") flags.watch = true;
    else if (arg === "--no-watch") flags.watch = false;
    else if (arg === "--locking") flags.locking = true;
    else if (arg === "--no-locking") flags.locking = false;
    else if (arg === "--ros") flags.ros = true;
    else if (arg === "--no-ros") flags.ros = false;
    else if (arg === "--recreate") flags.recreate = true;
    else if (arg === "-y" || arg === "--yes") flags.yes = true;
    else if (arg === "--antigravity") flags.clients = [...new Set([...(flags.clients || defaultClients()), "antigravity"])];
    else if (arg === "--clients") {
      const value = args[i + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(`${arg} needs a value`);
      i++;
      flags.clients = parseClients(value);
    }
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (flags.workMode === "planning" && flags.source !== undefined) {
    throw new Error("'codevis init new' cannot be combined with --source; use 'codevis init code --source <paths>'");
  }
  if (flags.workMode === "planning" && flags.watch === true) {
    throw new Error("'codevis init new' cannot enable the code watcher");
  }
  return flags;
}

export default async function init(args) {
  console.log(`\n${ui.title("CodeVis", "project setup")}\n${ui.section("Configuration")}\n`);

  const flags = parseFlags(args);
  const configPath = resolve(projectRoot, "codevis.config.cjs");
  const hasExistingConfig = existsSync(configPath);

  // Any config flag (or -y) means the caller has provided enough to run
  // unattended — never prompt in that case. This is the common path for
  // scripted / CI / npx invocations and must not hang waiting for stdin.
  const hasConfigFlags = flags.source !== undefined || flags.exclude !== undefined ||
    flags.knowledge !== undefined || flags.watch !== undefined || flags.locking !== undefined ||
    flags.ros !== undefined || flags.recreate || flags.workMode !== undefined;
  const isInteractive = !flags.yes && !hasConfigFlags && flags.clients === undefined && process.stdin.isTTY;
  const previousClients = configuredClients(projectRoot);
  let clients = flags.clients ?? (previousClients.length ? previousClients : defaultClients());

  let previous = null;
  if (hasExistingConfig) {
    try {
      delete require.cache[require.resolve(configPath)];
      const config = require(configPath);
      if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("Config must export an object");
      previous = existingSetup(config);
    } catch (error) {
      if (!flags.recreate) throw new Error(`Existing config could not be loaded: ${error.message}. Fix it or use --recreate explicitly.`);
    }
  }

  let sourceDirArray;
  let excludeArray = previous?.exclude || [];
  let knowledgePaths = previous?.knowledgePaths || [];
  let autoUpdate = previous?.autoUpdate || false;
  let locking = previous?.locking || false;
  let rosDefault = previous?.ros ?? false;
  let workMode = previous?.workMode || "code";
  let keepExistingConfig = hasExistingConfig && !hasConfigFlags;
  let recreateConfig = Boolean(flags.recreate);
  if (isInteractive) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      let mode = hasExistingConfig
        ? await ask(rl, "  Existing setup found: [K]eep, [A]djust, or [R]ecreate", "K")
        : "R";
      mode = mode.toLowerCase();
      recreateConfig = mode.startsWith("r");
      keepExistingConfig = hasExistingConfig && !mode.startsWith("a") && !mode.startsWith("r");
      if (keepExistingConfig) {
        sourceDirArray = previous?.sourceDirs || [];
        console.log("  Keeping codevis.config.cjs unchanged; integrations will still be refreshed.");
      } else if (mode.startsWith("a") && previous) {
        sourceDirArray = normalizeSourceDirs(await ask(rl, "  Source directories (comma-separated; none for planning-only)", previous.sourceDirs.join(",") || "none"));
        excludeArray = normalizeSourceDirs(await ask(rl, "  Exclude globs (comma-separated; none for empty)", previous.exclude.join(",") || "none"));
        knowledgePaths = normalizeSourceDirs(await ask(rl, "  Markdown Knowledge paths (comma-separated; none to disable)", previous.knowledgePaths.join(",") || "none"));
        autoUpdate = yes(await ask(rl, "  Enable automatic updates with the dashboard?", previous.autoUpdate ? "Y" : "N"));
        locking = yes(await ask(rl, "  Enable experimental multi-agent locking?", previous.locking ? "Y" : "N"));
        rosDefault = yes(await ask(rl, "  Enable the ROS extractor?", previous.ros ? "Y" : "N"));
      } else {
        const detected = detectedSourceDirs(projectRoot);
        if (detected.length) {
          console.log(`  Detected source directories: ${detected.join(", ")}`);
          sourceDirArray = normalizeSourceDirs(await ask(rl, "  Source directories to analyze (comma-separated; none for planning-only)", detected.join(",")));
        } else {
          sourceDirArray = yes(await ask(rl, "  No common source directory found. Analyze the entire project?", "Y")) ? ["."] : [];
        }
        excludeArray = [];
        knowledgePaths = normalizeSourceDirs(await ask(rl, "  Markdown Knowledge paths (comma-separated; none to disable)", "none"));
        autoUpdate = yes(await ask(rl, "  Enable automatic updates with the dashboard?", "N"));
        locking = yes(await ask(rl, "  Enable experimental multi-agent locking?", "N"));
        rosDefault = detectRos(projectRoot, sourceDirArray);
      }
      clients = parseClients(await ask(rl, `  AI clients to set up (${CLIENTS.join(", ")}; none)`, clients.join(",") || "none"));
      rl.close();
    } catch (err) {
      rl.close();
      throw err;
    }
    if (!keepExistingConfig) workMode = sourceDirArray.length ? "code" : "planning";
  } else {
    // Same default as the interactive path: the detected source folders, else
    // the whole project. A blind "./src" made the first build fail with ENOENT
    // in projects without one.
    const detected = detectedSourceDirs(projectRoot);
    const defaultSources = detected.length ? detected : ["."];
    sourceDirArray = flags.source !== undefined ? normalizeSourceDirs(flags.source) : (previous?.sourceDirs || defaultSources);
    if (flags.exclude !== undefined) excludeArray = normalizeSourceDirs(flags.exclude);
    if (flags.knowledge !== undefined) knowledgePaths = normalizeSourceDirs(flags.knowledge);
    if (flags.watch !== undefined) autoUpdate = flags.watch;
    if (flags.locking !== undefined) locking = flags.locking;
    if (flags.ros !== undefined) rosDefault = flags.ros;
    if (flags.recreate) {
      sourceDirArray = flags.source !== undefined ? sourceDirArray : defaultSources;
      excludeArray = flags.exclude !== undefined ? excludeArray : [];
      knowledgePaths = flags.knowledge !== undefined ? knowledgePaths : [];
      autoUpdate = flags.watch ?? false;
      locking = flags.locking ?? false;
      rosDefault = flags.ros ?? detectRos(projectRoot, sourceDirArray);
    }

    if (flags.workMode === "planning") {
      workMode = "planning";
      sourceDirArray = [];
      autoUpdate = false;
      rosDefault = flags.ros ?? false;
    } else if (flags.workMode === "code") {
      workMode = "code";
      if (flags.source === undefined) {
        const detected = detectedSourceDirs(projectRoot);
        sourceDirArray = !flags.recreate && previous?.sourceDirs?.length ? previous.sourceDirs : detected;
      }
      if (!sourceDirArray.length) {
        throw new Error("No source directory found. Create one or pass --source <paths> when switching to code mode.");
      }
      rosDefault = flags.ros ?? (!flags.recreate ? previous?.ros : undefined) ?? detectRos(projectRoot, sourceDirArray);
    } else if (!keepExistingConfig) {
      workMode = sourceDirArray.length ? "code" : "planning";
    }
  }

    // ── 2. Write codevis.config.cjs ──────────────────────────────
    if (workMode === "planning") autoUpdate = false;
    const sourceDirStr = sourceDirArray.map((d) => JSON.stringify(d)).join(", ");
    const excludeStr = excludeArray.map((d) => JSON.stringify(d)).join(", ");
    const knowledgeStr = knowledgePaths.map((d) => JSON.stringify(d)).join(", ");

    // Turn the ROS extractor on only for projects that actually are ROS. Asking
    // one more wizard question would cost every non-ROS user a decision they
    // cannot make yet; a wrong guess costs nothing but one edited line, and the
    // generated config says which line.
    const configContent = `// CodeVis configuration — generated by 'codevis init'
// Both workspaces use embedded Ladybug databases under ./.codevis by default.
// Workspace names select the database; no database URL or login is required.
const path = require("path");
const fs = require("fs");

function codevisSourceDirs() {
  const override = process.env.CODEVIS_SELF_SRC;
  if (override) return override.split(/[;,]/).map((entry) => entry.trim()).filter(Boolean);
  try {
    const root = path.dirname(require.resolve("codevis/package.json"));
    return ["server", "scripts", "tools", "lib", "bin", "frontend/src", "tests"]
      .map((entry) => path.join(root, entry))
      .filter((entry) => fs.existsSync(entry));
  } catch {
    return [];
  }
}

module.exports = {
  // Planning mode keeps Tasks, Knowledge and Specs available without trying to
  // build or watch a code graph. Switch later with 'codevis init code'.
  workMode: "${workMode}",
  // Optional extractors for one ecosystem's idioms, on top of the language-neutral
  // core (files, functions, calls, classes, imports). Switch off what your project
  // does not use: a disabled extractor compiles no queries and writes no nodes.
  //   ros — ROS 2 nodes, topics, services and actions (rclpy, rclcpp, roslib)
  // Can also be set per workspace, which then wins over this block.
  extractors: {
    ros: ${rosDefault},
  },
  // Optional automatic incremental updates. The watch command reads these values;
  // the dashboard starts one project-wide watcher when enabled.
  autoUpdate: {
    enabled: ${autoUpdate},
    debounceMs: 2000,
    maxWaitMs: 15000,
  },
  // Experimental multi-agent node locking. Disabled by default. It can also be
  // overridden for one process with CODEVIS_LOCKING=on/off.
  locking: {
    enabled: ${locking},
  },
  // Optional repository-native Knowledge. Markdown files need YAML frontmatter
  // with a stable id; CodeVis indexes them and their code/task/wiki links.
  knowledge: {
    paths: [${knowledgeStr}],
  },
  workspaces: {
    // Your code: parsed by 'codevis build'.
    project_db: {
      sourceDir: [${sourceDirStr}],
      // Optional project-root-relative globs; ** crosses directories.
      exclude: [${excludeStr}],
    },
    // CodeVis source plus tasks, knowledge and specs. Installed sources are
    // discovered automatically; CODEVIS_SELF_SRC can point at a dev checkout.
    codevis_db: {
      sourceDir: codevisSourceDirs(),
    }
  }
};
`;
    if (!keepExistingConfig) {
      if (hasExistingConfig) copyFileSync(configPath, `${configPath}.bak`);
      const content = hasExistingConfig && !recreateConfig
        ? updateConfigSource(readFileSync(configPath, "utf8"), {
          sourceDirs: sourceDirArray, exclude: excludeArray, knowledgePaths,
          autoUpdate, locking, ros: rosDefault, workMode,
        })
        : configContent;
      writeFileSync(configPath, content);
      console.log(`  \u2713 ${hasExistingConfig ? 'Updated' : 'Created'} codevis.config.cjs${hasExistingConfig ? ' (backup: codevis.config.cjs.bak)' : ''}`);
    }

    // ── 3. Keep the graph out of version control ───────────────
    // The DB lives in <project>/.codevis so it survives npm installs and so two
    // projects get two independent graphs. It is a build artifact, not source.
    const gitignorePath = resolve(projectRoot, ".gitignore");
    const existing = existsSync(gitignorePath) ? readFileSync(gitignorePath, "utf-8") : "";
    if (!existing.split(/\r?\n/).some((l) => l.trim().replace(/\/$/, "") === ".codevis")) {
      const prefix = existing && !existing.endsWith("\n") ? "\n" : "";
      writeFileSync(
        gitignorePath,
        `${existing}${prefix}\n# CodeVis code graph (regenerate with 'npx codevis build full')\n.codevis/\n`
      );
      console.log("  ✓ Added .codevis/ to .gitignore");
    }

    // ── 4. Install CodeVis into the project ─────────────────────
    // tsx is already CodeVis' runtime dependency. npx's cache is temporary;
    // install this exact version locally so generated MCP commands stay usable.
    // Run from a git checkout (global `npm link`), the registry release with
    // the same version number is older than the code running this wizard: the
    // project links the checkout instead, and a stale registry copy is replaced.
    const installed = resolve(projectRoot, "node_modules/codevis");
    const fromCheckout = existsSync(resolve(packageRoot, ".git"));
    const needsInstall = fromCheckout
      ? !existsSync(installed) || realpathSync(installed) !== realpathSync(packageRoot)
      : !existsSync(resolve(installed, "tools/mcp_server.ts"));
    if (needsInstall && projectRoot !== packageRoot) {
      const { version } = require(resolve(packageRoot, "package.json"));
      const spec = fromCheckout ? `codevis@file:${packageRoot.replace(/\\/g, "/")}` : `codevis@${version}`;
      console.log(`  Installing ${spec} locally...`);
      try {
        execSync(`npm install --save-dev --save-exact "${spec}"`, { cwd: projectRoot, stdio: "pipe", windowsHide: true });
      } catch (error) {
        throw new Error(`Dependency installation failed. Run 'npm install -D "${spec}"', then rerun init.\n${error.stderr?.toString() || error.message}`);
      }
    }

    const mcpServerPath = resolve(projectRoot, projectRoot === packageRoot ? "bin/codevis.mjs" : "node_modules/codevis/bin/codevis.mjs");
    const mcpEnv = { CODEVIS_PROJECT_DIR: projectRoot };
    console.log(`  AI clients: ${clients.length ? clients.join(", ") : "none"}`);

    // ── 5. Claude Code: hooks, agents, .mcp.json, settings ──────
    if (clients.includes("claude")) {
      const hooksSrc = resolve(packageRoot, "templates/hooks");
      if (existsSync(hooksSrc)) {
        copyDirRecursive(hooksSrc, resolve(projectRoot, ".claude/hooks"));
        console.log("  \u2713 Installed hooks to .claude/hooks/");
      }
      const agentsSrc = resolve(packageRoot, "templates/agents");
      if (existsSync(agentsSrc)) {
        copyDirRecursive(agentsSrc, resolve(projectRoot, ".claude/agents"));
        console.log("  \u2713 Installed agent definitions to .claude/agents/");
      }

      const mcpJsonPath = resolve(projectRoot, ".mcp.json");
      const mcpConfig = readJsonConfig(mcpJsonPath);
      if (!mcpConfig.mcpServers) mcpConfig.mcpServers = {};
      mcpConfig.mcpServers.codevis_graph = { command: "node", args: [mcpServerPath, "start"], env: { ...mcpEnv } };
      mcpConfig.mcpServers.codevis_worker = { command: "node", args: [mcpServerPath, "start"], env: { ...mcpEnv, CODEVIS_ROLE: "worker" } };

      const settingsPath = resolve(projectRoot, ".claude/settings.local.json");
      const settings = readJsonConfig(settingsPath);

      // Ensure hooks (new format: matcher + hooks array)
      if (!settings.hooks) settings.hooks = {};
      if (!settings.hooks.PreToolUse) settings.hooks.PreToolUse = [];

      // Quote the path: an unquoted "C:\work\my project\..." splits on the space
      // and the hook never launches — enforcement then fails open, silently.
      // Forward slashes so the quoted string needs no escaping on Windows.
      const hookCommand = (name) =>
        `node "${resolve(projectRoot, `.claude/hooks/${name}`).replace(/\\/g, "/")}"`;

      // Migrate our previously registered .js commands, including projects that
      // became ESM since their original init. Preserve unrelated hook entries.
      for (const entry of settings.hooks.PreToolUse) {
        for (const hook of entry.hooks || []) {
          for (const name of ["lock-guard", "bash-guard"]) {
            if (hook.command?.includes(`.claude/hooks/${name}.js`) || hook.command?.includes(`.claude/hooks/${name}.cjs`)) hook.command = hookCommand(`${name}.cjs`);
          }
        }
      }
      const registered = (event, name) => (settings.hooks[event] || []).some((h) =>
        h.hooks?.some((hook) => hook.command?.includes(name)));
      if (!registered("PreToolUse", "lock-guard")) settings.hooks.PreToolUse.push({
        matcher: "Edit|Write",
        hooks: [{ type: "command", command: hookCommand("lock-guard.cjs") }],
      });
      if (!registered("PreToolUse", "bash-guard")) settings.hooks.PreToolUse.push({
        matcher: "Bash",
        hooks: [{ type: "command", command: hookCommand("bash-guard.cjs") }],
      });

      // After an edit: attribute the changed lines to the agent's task.
      if (!settings.hooks.PostToolUse) settings.hooks.PostToolUse = [];
      // Re-point existing touch-recorder entries at this project, like the
      // guards above: a copied project otherwise kept running the original
      // project's recorder, and failed on every edit once that was deleted.
      for (const entry of settings.hooks.PostToolUse) {
        for (const hook of entry.hooks || []) {
          if (hook.command?.includes(".claude/hooks/touch-recorder")) hook.command = hookCommand("touch-recorder.cjs");
        }
      }
      // And after a task is claimed or completed: remember which (sub)agent
      // works on which task, so edits made inside a subagent find their task.
      for (const matcher of ["Edit|Write|MultiEdit", "mcp__codevis_.*__(claim_task|get_next_task|complete_task)"]) {
        const present = settings.hooks.PostToolUse.some((h) => h.matcher === matcher
          && h.hooks?.some((hook) => hook.command?.includes("touch-recorder")));
        if (!present) settings.hooks.PostToolUse.push({
          matcher,
          hooks: [{ type: "command", command: hookCommand("touch-recorder.cjs") }],
        });
      }

      // Auto-allow all CodeVis MCP tools (both server instances)
      if (!settings.permissions) settings.permissions = {};
      if (!settings.permissions.allow) settings.permissions.allow = [];
      for (const pattern of ["mcp__codevis_graph__*", "mcp__codevis_worker__*"]) {
        if (!settings.permissions.allow.includes(pattern)) settings.permissions.allow.push(pattern);
      }

      // Enable both MCP servers
      if (!settings.enabledMcpjsonServers) settings.enabledMcpjsonServers = [];
      for (const server of ["codevis_graph", "codevis_worker"]) {
        if (!settings.enabledMcpjsonServers.includes(server)) settings.enabledMcpjsonServers.push(server);
      }

      writeFileSync(mcpJsonPath, JSON.stringify(mcpConfig, null, 2) + "\n");
      console.log("  \u2713 Created .mcp.json (local MCP servers)");
      mkdirSync(dirname(settingsPath), { recursive: true });
      writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
      console.log("  \u2713 Updated .claude/settings.local.json (hooks + MCP permissions)");
    }

    // ── 6. Codex: .codex/config.toml ────────────────────────────
    if (clients.includes("codex")) {
      const codex = configureCodex(projectRoot, mcpServerPath);
      console.log(codex.created
        ? "  Added codevis_graph to .codex/config.toml (Codex MCP, Lead role)"
        : codex.relocated
          ? `  ✓ Moved Codex codevis_graph from ${codex.relocated} to this project (other settings kept)`
          : "  Kept existing Codex codevis_graph configuration unchanged");
    }

    // ── 6b. Antigravity: .gemini/antigravity/mcp_config.json ───
    if (clients.includes("antigravity")) {
      const geminiDir = resolve(projectRoot, ".gemini/antigravity");
      mkdirSync(geminiDir, { recursive: true });
      const geminiConfigPath = resolve(geminiDir, "mcp_config.json");
      const geminiConfig = readJsonConfig(geminiConfigPath);
      if (!geminiConfig.mcpServers) geminiConfig.mcpServers = {};
      geminiConfig.mcpServers.codevis_graph = {
        command: "node",
        args: [mcpServerPath, "start"],
        disabled: false,
        env: { ...mcpEnv, CODEVIS_AGENT_ID: "antigravity-1" },
      };
      writeFileSync(geminiConfigPath, JSON.stringify(geminiConfig, null, 2) + "\n");
      console.log("  \u2713 Created .gemini/antigravity/mcp_config.json (Antigravity MCP)");
    }

    // ── 7. Summary ──────────────────────────────────────────────
    const nextSteps = workMode === "planning"
      ? `  Planning mode is active. Code graph builds and watchers are disabled.

  Next steps:
    1. npx codevis dashboard    # Plan with Kanban, Knowledge and Specs
    2. Restart Claude Code or Codex # Load the project MCP configuration
    3. npx codevis init code    # Switch after source code exists`
      : `  Code mode is active for: ${sourceDirArray.join(", ")}.

  Next steps:
    1. npx codevis build full   # Parse the current source tree
    2. npx codevis dashboard    # 3D graph + Kanban in the browser
    3. Restart Claude Code or Codex # Load the project MCP configuration
    4. npx codevis kanban       # Task board in the terminal`;
    console.log(`
  Setup complete! The graph DB is embedded — nothing else to install or start.
  The graph lives in ./.codevis/ — one per project, so several projects can run side by side.

${nextSteps}

  Restart an already running dashboard after configuration changes.
  Other AI clients: rerun init with --clients ${CLIENTS.join(",")}.${clients.includes("codex") ? `
  Codex loads .codex/config.toml only for trusted projects. Trust this project
  in Codex, then restart the client. Verify with 'codex mcp get codevis_graph'.
  The generated Codex entry uses local absolute paths; rerun init on each machine.
  Existing Codex entries are preserved; remove only codevis_graph to regenerate it.` : ""}
`);

    // Offer to build first, THEN to open the dashboard.
    //
    // The order matters more than it looks: `init` only writes configuration, it
    // parses nothing. Answering yes to the dashboard right after setup used to
    // open it on an empty database — which reads as "the tool is broken" rather
    // than "there is nothing in there yet". Building first is what almost
    // everybody wants, so it is the default; declining it is still possible and
    // then the dashboard prompt says what you will be looking at.
    let built = false;
    if (isInteractive && workMode === "code") {
      const rl2 = createInterface({ input: process.stdin, output: process.stdout });
      const doBuild = await new Promise((resolve) => {
        rl2.question("  Build the code graph now? This parses your sources and takes a few minutes. (Y/n): ",
          (a) => { rl2.close(); resolve(a.trim().toLowerCase()); });
      });
      if (doBuild !== "n" && doBuild !== "no") {
        try {
          const { default: build } = await import("./build.mjs");
          await build(["full"]);
          built = true;
        } catch (e) {
          // A failed build must not take the whole setup down with it — the
          // config, hooks and MCP wiring are already in place and usable.
          console.error(`\n  Build failed: ${e.message}`);
          console.error("  Setup itself is complete — fix the cause and run 'npx codevis build full'.\n");
        }
      }
    }

    // Offer to start the dashboard right away
    if (isInteractive) {
      const rl3 = createInterface({ input: process.stdin, output: process.stdout });
      const question = workMode === "planning"
        ? "  Start the planning dashboard now? (y/N): "
        : built
          ? "  Start the dashboard now? (y/N): "
          : "  Start the dashboard now? The graph is still empty, so the view will be too. (y/N): ";
      const start = await new Promise((resolve) => {
        rl3.question(question, (a) => { rl3.close(); resolve(a.trim().toLowerCase()); });
      });
      if (start === "y" || start === "yes") {
        const { default: dashboard } = await import("./dashboard.mjs");
        await dashboard([]);
      }
    }
}

/**
 * Does this project look like ROS 2?
 *
 * Two signals, both cheap and both hard to produce by accident: a `package.xml`
 * (every ROS package has one, almost nothing else in a JS/Python project does)
 * or a source file importing rclpy/rclcpp. Scanning is capped — `init` runs
 * before anything is indexed, so it must stay fast on a large tree and must
 * never fail the setup just because a directory could not be read.
 */
function detectRos(root, sourceDirArray) {
  const MAX_FILES = 400;
  const MARKERS = /\b(rclpy|rclcpp|rclcpp_action|sensor_msgs|geometry_msgs)\b/;
  let seen = 0;

  const walk = (dir, depth) => {
    if (seen >= MAX_FILES || depth > 4) return false;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const entry of entries) {
      if (seen >= MAX_FILES) return false;
      if (entry.name === "node_modules" || entry.name === ".git" || entry.name === "build") continue;
      const full = resolve(dir, entry.name);
      if (entry.isDirectory()) {
        if (walk(full, depth + 1)) return true;
        continue;
      }
      if (entry.name === "package.xml") return true;
      if (!/\.(py|cpp|hpp|cc|h)$/.test(entry.name)) continue;
      seen++;
      try {
        if (MARKERS.test(readFileSync(full, "utf8"))) return true;
      } catch {
        /* unreadable file — not a reason to fail setup */
      }
    }
    return false;
  };

  for (const dir of sourceDirArray) {
    const full = resolve(root, dir);
    if (existsSync(full) && walk(full, 0)) return true;
  }
  return false;
}
