#!/usr/bin/env node
/**
 * codevis stop — stop this project's dashboard and database daemon cleanly.
 *
 * The dashboard goes FIRST, and the order is the whole point. This used to stop
 * only the daemon, which reads as "everything is down" and is not: a running
 * bridge brings the daemon straight back up, so `codevis stop` was reliably
 * followed by a daemon whose start time was later than the stop. The dashboard
 * also kept the port, so the `codevis dashboard` that came next died on "port
 * already in use" — while still opening a browser onto the OLD dashboard, which
 * looks like the --db flag being ignored rather than a command that never ran.
 *
 * Why this exists at all: the daemon checkpoints its write-ahead log when it
 * closes, and only then. It handles SIGTERM/SIGINT, which is enough on Unix —
 * but Windows cannot deliver those to a detached process, so `taskkill`,
 * Stop-Process and closing the terminal are all hard kills. The WAL is left
 * un-checkpointed, the next open quarantines it as `*.wal.corrupt-*`, and
 * everything written since the previous checkpoint is gone from the graph.
 * `codevis info` counts those files; several of them mean the daemon is being
 * killed rather than stopped.
 *
 * So this asks the daemon over loopback HTTP to shut itself down, and waits
 * until it is actually gone rather than assuming.
 *
 * --force kills the process afterwards if it did not go away on its own. That
 * is the un-clean path and says so.
 */

import { resolve, dirname, join } from "path";
import { fileURLToPath } from "url";
import { existsSync, readFileSync } from "fs";
import { createRequire } from "module";
import { dashboardMatches } from '../dashboard-session.mjs';
import ui from "../terminal-ui.cjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageRoot = resolve(__dirname, "../..");
const require = createRequire(import.meta.url);

export default async function stop(args = []) {
  const unknown = args.filter((arg) => arg !== "--force");
  if (unknown.length) throw new Error(`Unknown option: ${unknown[0]}`);
  const force = args.includes("--force");
  console.log(`${ui.title("CodeVis", "shutdown")}\n${ui.section("Services")}`);

  // Let the shared resolver honor an explicit project or find the nearest
  // ancestor config, including when stop is invoked from a source directory.

  let ladybug, paths;
  try {
    ladybug = require(join(packageRoot, "server/ladybug-driver.cjs"));
    paths = require(join(packageRoot, "server/codevis-paths.cjs"));
  } catch (e) {
    console.error(`Could not load the CodeVis runtime: ${e.message}`);
    process.exit(1);
  }

  // ── 1. The dashboard ──────────────────────────────────────────────
  // Before the daemon, always: anything still attached re-opens the database
  // the moment the daemon closes it.
  await stopDashboard(paths.BRIDGE_PORT, { projectRoot: paths.PROJECT_ROOT, dataDir: paths.DATA_DIR });

  // ── 2. The daemon ─────────────────────────────────────────────────
  // Read the pidfile before stopping — afterwards it is gone, and it is the only
  // place that records which process we were talking to.
  let pid = null;
  try {
    const raw = readFileSync(paths.PIDFILE, "utf8").trim();
    try { pid = JSON.parse(raw).pid; } catch { pid = parseInt(raw, 10); }
  } catch { /* no pidfile — stopDaemon reports it below */ }

  const { stopped, reason, replacedBy, stoppedPid, targetPid } = await ladybug.stopDaemon();

  if (stopped) {
    const which = stoppedPid || pid;
    console.log(`  ${ui.badge("STOPPED", "green")} daemon${which ? ` (pid ${which})` : ""}; databases checkpointed and closed`);
    if (replacedBy) {
      // Not a failure, but the database is not released either, and someone
      // stopping the daemon to move or delete the data dir needs to know that.
      console.log("");
      console.log(`A client immediately started a replacement (pid ${replacedBy}).`);
      console.log("Anything attached to this project — the MCP server in your editor, a running");
      console.log("bridge or 'codevis dashboard' — brings the daemon back up as soon as it needs");
      console.log("it. Stop those first if you want the database left closed.");
    }
    return;
  }

  if (reason === "no daemon is serving this project") {
    console.log(`  ${ui.badge("IDLE", "yellow")} no daemon is running for this project`);
    return;
  }

  console.error(`Daemon did not stop: ${reason}`);

  if (!force) {
    console.error("");
    console.error("Re-run with --force to terminate it anyway. Be aware that a hard kill");
    console.error("abandons the write-ahead log: everything written since the last");
    console.error("checkpoint is quarantined on the next open, not recovered.");
    process.exit(1);
  }

  if (!Number.isInteger(targetPid) || targetPid <= 0) {
    console.error("Cannot force-stop an unverified daemon. No process was terminated.");
    process.exit(1);
  }

  try {
    process.kill(targetPid, "SIGKILL");
    console.error(`Sent SIGKILL to pid ${targetPid}. The write-ahead log was NOT checkpointed —`);
    console.error("run 'codevis info' afterwards to see whether it had to be quarantined.");
  } catch (e) {
    console.error(`Could not kill pid ${targetPid}: ${e.message}`);
    process.exit(1);
  }
}

/**
 * Ask the dashboard on this project's port to shut itself down.
 *
 * Never throws and never exits: a dashboard that is not running is the normal
 * case, and a stop that fails here must still go on to stop the daemon.
 *
 * The identity check is not paperwork. The port is derived from the project
 * path, so it is a plausible port for something else to be using — and this
 * function's whole job is to shut down whatever answers. It shuts down nothing
 * that does not identify itself as a CodeVis bridge.
 */
async function stopDashboard(port, expectedIdentity) {
  const base = `http://127.0.0.1:${port}`;

  let status;
  try {
    const res = await fetch(`${base}/api/status`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    status = await res.json();
  } catch {
    console.log(`  ${ui.badge("IDLE", "yellow")} no dashboard is running on port ${port}`);
    return;
  }

  if (!status || typeof status.activeDb !== "string" || !dashboardMatches(status, expectedIdentity)) {
    console.log(`Port ${port} does not identify as this project's CodeVis dashboard.`);
    console.log("Leaving it alone — stop it yourself if it is in the way.");
    return;
  }

  let stoppedPid = null;
  try {
    const res = await fetch(`${base}/api/shutdown`, { method: "POST", signal: AbortSignal.timeout(5000) });
    if (res.status === 404) {
      // A dashboard started before this route existed. Saying so beats a generic
      // failure: the fix is to restart it once, not to debug the stop command.
      console.log(`The dashboard on port ${port} is too old to be stopped this way.`);
      console.log("Stop it in its own terminal (Ctrl+C) once; newer ones stop from here.");
      return;
    }
    if (res.ok) stoppedPid = (await res.json())?.pid ?? null;
  } catch {
    // The connection dropping mid-request is not proof of failure — the port
    // check below is. Fall through to it.
  }

  // Wait for the port to actually go quiet rather than assume it did, for the
  // same reason stopDaemon waits: the next command binds this port.
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      await fetch(`${base}/api/status`, { signal: AbortSignal.timeout(500) });
    } catch {
      console.log(`  ${ui.badge("STOPPED", "green")} dashboard${stoppedPid ? ` (pid ${stoppedPid})` : ""}; port ${port} is free`);
      return;
    }
    await new Promise((r) => setTimeout(r, 150));
  }

  console.error(`The dashboard on port ${port} did not stop within 5s — the port is still in use.`);
  console.error("'codevis dashboard' will refuse to start until it is gone.");
}
