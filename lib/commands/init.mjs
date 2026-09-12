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
  statSync,
} from "fs";
import { createInterface } from "readline";
import { createRequire } from "module";
import { execSync } from "child_process";
import { updateConfigSource } from "../init-config.mjs";

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
    else if (arg === "--antigravity") flags.antigravity = true;
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
  const isInteractive = !flags.yes && !hasConfigFlags && process.stdin.isTTY;

  // The embedded Ladybug DB is the only backend — no DB questions, nothing to
  // start. The URIs below are not connection strings to a server; their port is
  // just how CodeVis tells the two graphs apart.
  const targetUri = "bolt://localhost:7687";
  const dbPass = "codevis_target";

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
      rl.close();
    } catch (err) {
      rl.close();
      throw err;
    }
    if (!keepExistingConfig) workMode = sourceDirArray.length ? "code" : "planning";
  } else {
    sourceDirArray = flags.source !== undefined ? normalizeSourceDirs(flags.source) : (previous?.sourceDirs || ["./src"]);
    if (flags.exclude !== undefined) excludeArray = normalizeSourceDirs(flags.exclude);
    if (flags.knowledge !== undefined) knowledgePaths = normalizeSourceDirs(flags.knowledge);
    if (flags.watch !== undefined) autoUpdate = flags.watch;
    if (flags.locking !== undefined) locking = flags.locking;
    if (flags.ros !== undefined) rosDefault = flags.ros;
    if (flags.recreate) {
      sourceDirArray = flags.source !== undefined ? sourceDirArray : ["./src"];
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
// Both graphs live in the embedded Ladybug DB under ./.codevis by default. The
// dbUri/auth are not connection strings to a server: with the embedded DB the
// URI's port only distinguishes project_db (7687) from codevis_db (7688);
// credentials are unused by the embedded database.
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
      dbUri: process.env.CODEVIS_PROJECT_DB_URI || process.env.CODEVIS_TARGET_URI || "${targetUri}",
      auth: { user: "codevis", pass: process.env.CODEVIS_PROJECT_DB_PASS || process.env.CODEVIS_TARGET_PASS || "${dbPass}" }
    },
    // CodeVis source plus tasks, knowledge and specs. Installed sources are
    // discovered automatically; CODEVIS_SELF_SRC can point at a dev checkout.
    codevis_db: {
      sourceDir: codevisSourceDirs(),
      dbUri: process.env.CODEVIS_CODEVIS_DB_URI || process.env.CODEVIS_META_URI || "bolt://localhost:7688",
      auth: { user: "codevis", pass: process.env.CODEVIS_CODEVIS_DB_PASS || process.env.CODEVIS_META_PASS || "${dbPass}" }
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

    // ── 4. Copy hooks ───────────────────────────────────────────
    const hooksDir = resolve(projectRoot, ".claude/hooks");
    const hooksSrc = resolve(packageRoot, "templates/hooks");
    if (existsSync(hooksSrc)) {
      copyDirRecursive(hooksSrc, hooksDir);
      console.log("  \u2713 Installed hooks to .claude/hooks/");
    }

    // ── 5. Copy agent definitions ───────────────────────────────
    const agentsDir = resolve(projectRoot, ".claude/agents");
    const agentsSrc = resolve(packageRoot, "templates/agents");
    if (existsSync(agentsSrc)) {
      copyDirRecursive(agentsSrc, agentsDir);
      console.log("  \u2713 Installed agent definitions to .claude/agents/");
    }

    // ── 6. Merge settings.local.json ────────────────────────────
    const settingsPath = resolve(projectRoot, ".claude/settings.local.json");
    let settings = {};
    if (existsSync(settingsPath)) {
      settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
    }

    // tsx is already CodeVis' runtime dependency. npx's cache is temporary;
    // install this exact version locally so generated MCP commands stay usable.
    if (!existsSync(resolve(projectRoot, "node_modules/codevis/tools/mcp_server.ts")) && projectRoot !== packageRoot) {
      const { version } = require(resolve(packageRoot, "package.json"));
      console.log(`  Installing codevis@${version} locally...`);
      try {
        execSync(`npm install --save-dev --save-exact codevis@${version}`, { cwd: projectRoot, stdio: "pipe", windowsHide: true });
      } catch (error) {
        throw new Error(`Dependency installation failed. Run 'npm install -D codevis@${version}', then rerun init.\n${error.stderr?.toString() || error.message}`);
      }
    }

    // ── 6b. Write .mcp.json (MCP server config) ──────────────
    const mcpJsonPath = resolve(projectRoot, ".mcp.json");
    let mcpConfig = {};
    if (existsSync(mcpJsonPath)) {
      mcpConfig = JSON.parse(readFileSync(mcpJsonPath, "utf-8"));
    }
    if (!mcpConfig.mcpServers) mcpConfig.mcpServers = {};

    const mcpServerPath = resolve(projectRoot, projectRoot === packageRoot ? "bin/codevis.mjs" : "node_modules/codevis/bin/codevis.mjs");
    const mcpEnv = { CODEVIS_PROJECT_DIR: projectRoot };
    mcpConfig.mcpServers.codevis_graph = {
      command: "node",
      args: [mcpServerPath, "start"],
      env: { ...mcpEnv },
    };
    mcpConfig.mcpServers.codevis_worker = {
      command: "node",
      args: [mcpServerPath, "start"],
      env: { ...mcpEnv, CODEVIS_ROLE: "worker" },
    };

    writeFileSync(mcpJsonPath, JSON.stringify(mcpConfig, null, 2) + "\n");
    console.log("  \u2713 Created .mcp.json (local MCP servers)");

    // Ensure hooks (new format: matcher + hooks array)
    if (!settings.hooks) settings.hooks = {};
    if (!settings.hooks.PreToolUse) settings.hooks.PreToolUse = [];

    // Quote the path: an unquoted "C:\work\my project\..." splits on the space
    // and the hook never launches — enforcement then fails open, silently.
    // Forward slashes so the quoted string needs no escaping on Windows.
    const hookCommand = (name) =>
      `node "${resolve(projectRoot, `.claude/hooks/${name}`).replace(/\\/g, "/")}"`;

    const lockGuardEntry = {
      matcher: "Edit|Write",
      hooks: [{ type: "command", command: hookCommand("lock-guard.cjs") }],
    };
    const bashGuardEntry = {
      matcher: "Bash",
      hooks: [{ type: "command", command: hookCommand("bash-guard.cjs") }],
    };

    // Migrate our previously registered .js commands, including projects that
    // became ESM since their original init. Preserve unrelated hook entries.
    for (const entry of settings.hooks.PreToolUse) {
      for (const hook of entry.hooks || []) {
        for (const name of ["lock-guard", "bash-guard"]) {
          if (hook.command?.includes(`.claude/hooks/${name}.js`) || hook.command?.includes(`.claude/hooks/${name}.cjs`)) hook.command = hookCommand(`${name}.cjs`);
        }
      }
    }
    // Add hooks if not already present
    const hasLockGuard = settings.hooks.PreToolUse.some((h) =>
      h.hooks?.some((hook) => hook.command?.includes("lock-guard")));
    const hasBashGuard = settings.hooks.PreToolUse.some((h) =>
      h.hooks?.some((hook) => hook.command?.includes("bash-guard")));
    if (!hasLockGuard) settings.hooks.PreToolUse.push(lockGuardEntry);
    if (!hasBashGuard) settings.hooks.PreToolUse.push(bashGuardEntry);

    // Auto-allow all CodeVis MCP tools (both server instances)
    if (!settings.permissions) settings.permissions = {};
    if (!settings.permissions.allow) settings.permissions.allow = [];
    const mcpPatterns = ["mcp__codevis_graph__*", "mcp__codevis_worker__*"];
    for (const pattern of mcpPatterns) {
      if (!settings.permissions.allow.includes(pattern)) {
        settings.permissions.allow.push(pattern);
      }
    }

    // Enable both MCP servers
    if (!settings.enabledMcpjsonServers) settings.enabledMcpjsonServers = [];
    for (const server of ["codevis_graph", "codevis_worker"]) {
      if (!settings.enabledMcpjsonServers.includes(server)) {
        settings.enabledMcpjsonServers.push(server);
      }
    }

    mkdirSync(dirname(settingsPath), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
    console.log("  \u2713 Updated .claude/settings.local.json (hooks + MCP permissions)");

    // ── 6c. Write Antigravity MCP config (optional) ────────────
    if (flags.antigravity) {
      const geminiDir = resolve(projectRoot, ".gemini/antigravity");
      mkdirSync(geminiDir, { recursive: true });
      const geminiConfigPath = resolve(geminiDir, "mcp_config.json");
      let geminiConfig = {};
      if (existsSync(geminiConfigPath)) {
        geminiConfig = JSON.parse(readFileSync(geminiConfigPath, "utf-8"));
      }
      if (!geminiConfig.mcpServers) geminiConfig.mcpServers = {};

      geminiConfig.mcpServers.codevis_graph = {
        command: "node",
        args: [mcpServerPath, "start"],
        disabled: false,
        env: {
          CODEVIS_PROJECT_DIR: projectRoot,
          CODEVIS_AGENT_ID: "antigravity-1",
        },
      };

      writeFileSync(geminiConfigPath, JSON.stringify(geminiConfig, null, 2) + "\n");
      console.log("  \u2713 Created .gemini/antigravity/mcp_config.json (Antigravity MCP)");
    }

    // ── 7. Summary ──────────────────────────────────────────────
    const nextSteps = workMode === "planning"
      ? `  Planning mode is active. Code graph builds and watchers are disabled.

  Next steps:
    1. npx codevis dashboard    # Plan with Kanban, Knowledge and Specs
    2. Restart Claude Code      # MCP server auto-connects
    3. npx codevis init code    # Switch after source code exists`
      : `  Code mode is active for: ${sourceDirArray.join(", ")}.

  Next steps:
    1. npx codevis build full   # Parse the current source tree
    2. npx codevis dashboard    # 3D graph + Kanban in the browser
    3. Restart Claude Code      # MCP server auto-connects
    4. npx codevis kanban       # Task board in the terminal`;
    console.log(`
  Setup complete! The graph DB is embedded — nothing else to install or start.
  The graph lives in ./.codevis/ — one per project, so several projects can run side by side.

${nextSteps}

  Restart an already running dashboard after configuration changes.
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
