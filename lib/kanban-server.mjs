#!/usr/bin/env node
/**
 * CodeVis Web Kanban — lightweight Express server with drag-and-drop + detail view.
 */

import { createRequire } from "module";
import { resolve, dirname } from "path";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";

const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageRoot = resolve(__dirname, "..");

const projectDir = process.env.CODEVIS_PROJECT_DIR || process.cwd();
const { withInternalWorkspaceAliases } = require(resolve(packageRoot, "lib/workspace-names.cjs"));
const config = withInternalWorkspaceAliases(require(resolve(projectDir, "codevis.config.cjs")));
const { normalizeWorkspaceName } = require(resolve(packageRoot, "lib/workspace-names.cjs"));
const { LOOPBACK_HOST, parsePort } = require(resolve(packageRoot, "lib/network-options.cjs"));
const { isLockingEnabled } = require(resolve(packageRoot, "lib/locking-config.cjs"));
const lockingEnabled = isLockingEnabled(config);
const dbName = normalizeWorkspaceName(process.env.CODEVIS_DB || "project_db");
const ws = config.workspaces[dbName];

// Embedded Ladybug DB via the driver-compatible compat client.
// (CODEVIS_DB selects the workspace above — it is not a backend switch.)
const ladybug = require("../server/ladybug-driver.cjs");
const { TASK_STATUSES, transitionTaskLocks } = require("../tools/lib/task-rules.cjs");
const driver = ladybug.driver((ws.dbUri || ws.neo4jUri), ladybug.auth.basic(ws.auth.user, ws.auth.pass));

const express = require("express");
const app = express();
app.use(express.json());

const html = readFileSync(resolve(__dirname, "kanban-web.html"), "utf-8");
app.get("/", (req, res) => res.type("html").send(html));

function toNum(val) {
  if (val == null) return 0;
  if (typeof val.toNumber === "function") return val.toNumber();
  return val;
}

// ── Board data (tasks + locks + pending) ──────────────────────
app.get("/api/board", async (req, res) => {
  const session = driver.session();
  try {
    const taskResult = await session.run(
      `MATCH (t:Task)
       OPTIONAL MATCH (t)-[:AFFECTS]->(n)
       RETURN t.taskId AS taskId, t.title AS title, t.status AS status,
              t.priority AS priority, t.assignedTo AS assignedTo,
              t.description AS description, t.lastComment AS lastComment,
              count(DISTINCT n) AS affectedNodes
       ORDER BY CASE t.priority
         WHEN 'critical' THEN 0 WHEN 'high' THEN 1
         WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END`
    );
    const tasks = taskResult.records.map(r => ({
      taskId: r.get("taskId"), title: r.get("title"), status: r.get("status"),
      priority: r.get("priority"), assignedTo: r.get("assignedTo"),
      description: r.get("description"), lastComment: r.get("lastComment"),
      affectedNodes: toNum(r.get("affectedNodes")),
    }));

    const lockResult = await session.run(
      `MATCH (n) WHERE n.locked = true
       RETURN n.name AS name, n.file AS file, n.lockedBy AS lockedBy`
    );
    const locks = lockResult.records.map(r => ({
      name: r.get("name"), file: r.get("file"), lockedBy: r.get("lockedBy"),
    }));

    const pendingResult = await session.run(
      `MATCH (n) WHERE n.pendingRelease = true
       RETURN n.name AS name, n.file AS file, n.lockedBy AS lockedBy, n.releaseSummary AS summary`
    );
    const pendingReleases = pendingResult.records.map(r => ({
      name: r.get("name"), file: r.get("file"), lockedBy: r.get("lockedBy"), summary: r.get("summary"),
    }));

    res.json({ tasks, locks, pendingReleases });
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally {
    await session.close();
  }
});

// ── Task detail ───────────────────────────────────────────────
app.get("/api/tasks/:taskId", async (req, res) => {
  const session = driver.session();
  try {
    const result = await session.run(
      `MATCH (t:Task {taskId: $taskId})
       OPTIONAL MATCH (t)-[:AFFECTS]->(n)
       OPTIONAL MATCH (k:Knowledge)-[:APPLIES_TO]->(t)
       OPTIONAL MATCH (k2:Knowledge)-[:APPLIES_TO]->(n)
       RETURN t.taskId AS taskId, t.title AS title, t.status AS status,
              t.priority AS priority, t.assignedTo AS assignedTo,
              t.description AS description, t.workInstructions AS workInstructions,
              t.summary AS summary, t.lastComment AS lastComment,
              t.createdBy AS createdBy, t.createdAt AS createdAt, t.updatedAt AS updatedAt,
              collect(DISTINCT {name: n.name, file: n.file, type: labels(n)[0], locked: n.locked, lockedBy: n.lockedBy, pendingRelease: n.pendingRelease}) AS affectedNodes,
              collect(DISTINCT k.name) + collect(DISTINCT k2.name) AS knowledgeNames`,
      { taskId: req.params.taskId }
    );
    if (result.records.length === 0) return res.status(404).json({ error: "Task not found" });
    const r = result.records[0];
    const nodes = r.get("affectedNodes").filter(n => n.name !== null);
    const knowledgeRaw = r.get("knowledgeNames").filter(n => n !== null);
    const knowledge = [...new Set(knowledgeRaw)];
    res.json({
      taskId: r.get("taskId"), title: r.get("title"), status: r.get("status"),
      priority: r.get("priority"), assignedTo: r.get("assignedTo"),
      description: r.get("description"), workInstructions: r.get("workInstructions"),
      summary: r.get("summary"), lastComment: r.get("lastComment"),
      createdBy: r.get("createdBy"),
      createdAt: r.get("createdAt") ? new Date(toNum(r.get("createdAt"))).toISOString() : null,
      updatedAt: r.get("updatedAt") ? new Date(toNum(r.get("updatedAt"))).toISOString() : null,
      affectedNodes: nodes,
      knowledge,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally {
    await session.close();
  }
});

// ── Update task status (drag-and-drop) ────────────────────────
app.patch("/api/tasks/:taskId/status", async (req, res) => {
  const session = driver.session();
  try {
    const { status, comment } = req.body;
    const valid = [...TASK_STATUSES, "open"];
    if (!valid.includes(status)) return res.status(400).json({ error: "Invalid status" });

    const current = await session.run(
      `MATCH (t:Task {taskId: $taskId})
       RETURN t.status AS status, t.assignedTo AS assignedTo`,
      { taskId: req.params.taskId }
    );
    if (current.records.length === 0) return res.status(404).json({ error: "Task not found" });

    const row = current.records[0];
    const lockTransition = await transitionTaskLocks(
      session,
      req.params.taskId,
      row.get("status"),
      status,
      row.get("assignedTo") || "user",
        lockingEnabled,
        { comment },
    );
      if (!["OK", "NOOP", "DISABLED"].includes(lockTransition.status)) {
      return res.status(409).json({
          error: lockTransition.message || `Task transition rejected: ${lockTransition.status}`,
          code: lockTransition.status,
          action: lockTransition.action,
          conflicts: lockTransition.conflicts,
        conflictNode: lockTransition.conflictNode,
        conflictAgent: lockTransition.conflictAgent,
        conflictGroup: lockTransition.conflictGroup,
      });
    }

    res.json({ ok: true, taskId: req.params.taskId, status });
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally {
    await session.close();
  }
});

const PORT = parsePort(process.env.KANBAN_PORT || "4200", "KANBAN_PORT");
const server = await app.listen(PORT, LOOPBACK_HOST);
console.log(`CodeVis Web Kanban: http://localhost:${PORT}`);

process.on("SIGINT", () => { server.close(); driver.close(); process.exit(0); });
process.on("SIGTERM", () => { server.close(); driver.close(); process.exit(0); });
