#!/usr/bin/env node

import { watch as fsWatch, existsSync, readFileSync, writeFileSync, unlinkSync, statSync } from "fs";
import { resolve, join, relative, extname, dirname, isAbsolute } from "path";
import { spawn } from "child_process";
import { createRequire } from "module";
import { fileURLToPath } from "url";
import ui from "../terminal-ui.cjs";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const require = createRequire(import.meta.url);
const SUPPORTED_EXTENSIONS = new Set(require('../source-files.cjs').SOURCE_EXTENSIONS);
const IGNORED_SEGMENTS = new Set([
  ".git", ".codevis", "node_modules", ".venv", "venv", "dist", "build",
  "outputs", "__pycache__", ".pytest_cache",
]);

function numberFlag(args, name, fallback) {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  const value = Number(args[index + 1]);
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} needs a non-negative number`);
  return value;
}

export function shouldWatchPath(projectRoot, filename, { sourceRoots = [], knowledgeRoots = [], excludeMatchers = [] } = {}) {
  if (!filename) return false;
  const rel = relative(projectRoot, resolve(filename)).replace(/\\/g, "/");
  if (!rel) return false;
  if (rel.split("/").some((part) => IGNORED_SEGMENTS.has(part))) return false;
  const inside = (roots) => roots.some((entry) => {
    const inside = relative(resolve(entry), resolve(filename)).replace(/\\/g, "/");
    return inside === "" || (!isAbsolute(inside) && inside !== ".." && !inside.startsWith("../"));
  });
  if (extname(rel).toLowerCase() === ".md") return inside(knowledgeRoots);
  if (!inside(sourceRoots.length ? sourceRoots : [projectRoot])) return false;
  if (excludeMatchers.some((matcher) => matcher.test(rel))) return false;
  return SUPPORTED_EXTENSIONS.has(extname(rel).toLowerCase());
}

function affectsWatchedDirectory(projectRoot, changed, { sourceRoots = [], knowledgeRoots = [], excludeMatchers = [] }) {
  const rel = relative(projectRoot, changed).replace(/\\/g, '/');
  if (rel.split('/').some(part => IGNORED_SEGMENTS.has(part))) return false;
  const contains = (parent, child) => {
    const diff = relative(parent, child);
    return !isAbsolute(diff) && diff !== '..' && !diff.startsWith('..' + (process.platform === 'win32' ? '\\' : '/'));
  };
  const intersects = roots => roots.some(entry => contains(resolve(entry), changed) || contains(changed, resolve(entry)));
  if (!intersects(knowledgeRoots) && (!intersects(sourceRoots.length ? sourceRoots : [projectRoot])
    || excludeMatchers.some(matcher => matcher.test(rel) || matcher.test(rel + '/')))) return false;
  try { return statSync(changed).isDirectory(); }
  catch (error) {
    // Removed paths cannot be classified anymore. A conservative incremental
    // build is needed because native watchers may emit no child-file events.
    return error.code === 'ENOENT' || error.code === 'ENOTDIR';
  }
}

export function handleWatchEvent({ filename, event, root, projectRoot, sourceRoots, knowledgeRoots, excludeMatchers, queue }) {
  if (filename == null) { queue.change("diff"); return true; }
  const changed = resolve(root, filename.toString());
  const options = { sourceRoots, knowledgeRoots, excludeMatchers };
  if (!shouldWatchPath(projectRoot, changed, options)
    && !(event === 'rename' && affectsWatchedDirectory(projectRoot, changed, options))) return false;
  queue.change("diff");
  return true;
}

export class BuildQueue {
  constructor({ debounceMs, maxWaitMs, runBuild, onError = console.error }) {
    this.debounceMs = debounceMs;
    this.maxWaitMs = maxWaitMs;
    this.runBuild = runBuild;
    this.onError = onError;
    this.pendingMode = null;
    this.running = false;
    this.debounceTimer = null;
    this.maxTimer = null;
  }
  change(mode = "diff") {
    if (mode === "full" || !this.pendingMode) this.pendingMode = mode;
    clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => this.flush(), this.debounceMs);
    if (!this.maxTimer) this.maxTimer = setTimeout(() => this.flush(), this.maxWaitMs);
  }
  async flush() {
    clearTimeout(this.debounceTimer); this.debounceTimer = null;
    clearTimeout(this.maxTimer); this.maxTimer = null;
    if (this.running || !this.pendingMode) return;
    const mode = this.pendingMode;
    this.pendingMode = null;
    this.running = true;
    try { await this.runBuild(mode); }
    catch (error) { this.onError(error); }
    finally {
      this.running = false;
      if (this.pendingMode) this.change(this.pendingMode);
    }
  }
  close() {
    clearTimeout(this.debounceTimer);
    clearTimeout(this.maxTimer);
  }
}

function isAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === "EPERM"; }
}

export async function acquireWatcher(marker, maxWaitMs = 1000) {
  const { acquireDirectoryLock } = require('../directory-lock.cjs');
  const release = await acquireDirectoryLock(marker + '.lock', maxWaitMs);
  try {
    let owner;
    try { owner = JSON.parse(readFileSync(marker, 'utf8')); } catch {}
    if (owner?.pid && isAlive(owner.pid)) throw new Error(`CodeVis watcher already running (pid ${owner.pid}).`);
    writeFileSync(marker, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  } catch (error) { release(); throw error; }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    try { const owner = JSON.parse(readFileSync(marker, 'utf8')); if (owner.pid === process.pid) unlinkSync(marker); } catch {}
    release();
  };
}

function runGraphBuild(projectRoot, mode) {
  return new Promise((resolveP, reject) => {
    console.log(`\n${ui.section("Change detected")}  updating project_db ${ui.badge(mode.toUpperCase(), "cyan")}`);
    const buildArgs = [resolve(packageRoot, "scripts/graph_builder.js"), "target"];
    if (mode !== "full") buildArgs.push("diff");
    const child = spawn(process.execPath, buildArgs, {
      cwd: projectRoot, stdio: "inherit", env: { ...process.env, CODEVIS_PROJECT_DIR: projectRoot },
    });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolveP() : reject(new Error(`Graph update exited with code ${code}`)));
  });
}

export default async function watchCommand(args = []) {
  const allowed = new Set(["--debounce", "--max-wait"]);
  for (let i = 0; i < args.length; i += 2) if (!allowed.has(args[i]) || args[i + 1] === undefined) throw new Error(`Unknown or incomplete argument: ${args[i]}`);
  const paths = require(resolve(packageRoot, "server/codevis-paths.cjs"));
  const projectRoot = paths.PROJECT_ROOT;
  const config = paths.loadConfig();
  if (config.workMode === "planning") {
    console.log(`${ui.title("CodeVis", "file watcher")}\n${ui.section("Inactive")}`);
    console.log("  Planning mode does not watch or build a code graph.");
    console.log("  Switch after code exists: codevis init code [--source <paths>]\n");
    return;
  }
  const auto = config.autoUpdate || {};
  const debounceMs = numberFlag(args, "--debounce", Number(auto.debounceMs) || 2000);
  const maxWaitMs = numberFlag(args, "--max-wait", Number(auto.maxWaitMs) || 15000);
  const workspace = config.workspaces.target;
  const sourceDirs = (Array.isArray(workspace.sourceDir) ? workspace.sourceDir : [workspace.sourceDir]).filter(Boolean);
  if (!sourceDirs.length) throw new Error("project_db has no sourceDir to watch.");

  const marker = join(paths.DATA_DIR, ".watcher.pid");
  const releaseWatcher = await acquireWatcher(marker);
  const watchers = [];
  const sourceRoots = sourceDirs.map((entry) => resolve(projectRoot, entry));
  const knowledgeDirs = Array.isArray(config.knowledge?.paths) ? config.knowledge.paths : [];
  const knowledgeRoots = knowledgeDirs.map((entry) => resolve(projectRoot, entry));
  const { compileExcludeMatchers } = require(resolve(packageRoot, "lib/source-files.cjs"));
  const excludeMatchers = compileExcludeMatchers(workspace.exclude || []);
  const queue = new BuildQueue({
    debounceMs,
    maxWaitMs,
    runBuild: (mode) => runGraphBuild(projectRoot, mode),
    onError: (e) => console.error(
      `\n[watch] ERROR: Automatic graph update failed. The dashboard is still showing the previous, stale graph.\n` +
      `[watch] ${e.message}\n` +
      `[watch] Run "codevis info" in ${projectRoot} before retrying.\n`,
    ),
  });
  const cleanup = () => {
    queue.close();
    for (const watcher of watchers) watcher.close();
    releaseWatcher();
  };
  process.once("exit", cleanup);
  for (const sig of ["SIGINT", "SIGTERM"]) process.once(sig, () => { cleanup(); process.exit(0); });

  for (const entry of [...sourceDirs, ...knowledgeDirs]) {
    const absolute = resolve(projectRoot, entry);
    if (!existsSync(absolute)) { console.warn(`[watch] Missing sourceDir: ${absolute}`); continue; }
    const root = require("fs").statSync(absolute).isDirectory() ? absolute : dirname(absolute);
    watchers.push(fsWatch(root, { recursive: true }, (event, filename) => {
      handleWatchEvent({ filename, event, root, projectRoot, sourceRoots, knowledgeRoots, excludeMatchers, queue });
    }));
  }
  if (!watchers.length) { cleanup(); throw new Error("No existing sourceDir could be watched."); }
  console.log(`${ui.title("CodeVis", "file watcher")}\n${ui.section("Watching")}`);
  console.log(`  ${ui.badge("ACTIVE", "green")} ${sourceDirs.length} source path(s), ${knowledgeDirs.length} Knowledge path(s)`);
  console.log(`  debounce         ${debounceMs} ms`);
  console.log(`  maximum wait     ${maxWaitMs} ms`);
  await new Promise(() => {});
}
