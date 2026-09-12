async function getAgentTaskGroup(session, agentId) {
  if (!agentId) return null;
  const res = await session.run(
    `MATCH (t:Task {assignedTo: $agentId, status: 'in_progress'})
     RETURN t.taskId AS taskId LIMIT 2`,
    { agentId },
  );
  // A reusable agent name may own several active tasks. Only infer a unique
  // task; otherwise callers must supply taskId to avoid inventing history.
  if (res.records.length !== 1) return null;
  const taskId = res.records[0].get("taskId");
  return { taskId, lockGroup: taskId };
}

async function recordTouchedNodes(session, { taskId, agentId, kind, targets }) {
  const active = taskId ? { taskId } : await getAgentTaskGroup(session, agentId);
  if (!active?.taskId) return { taskId: null, touched: 0 };

  let touched = 0;
  const at = Date.now();
  for (const target of targets || []) {
    const byPath = target.path != null;
    const allInFile = target.allInFile === true;
    const result = await session.run(
      allInFile
        ? `MATCH (t:Task {taskId: $taskId}), (n {file: $file})
           WHERE n:Function OR n:Class OR n:Component
           MERGE (t)-[r:TOUCHED]->(n)
           SET r.at = $at, r.kind = $kind
           RETURN count(n) AS count`
        : byPath
        ? `MATCH (t:Task {taskId: $taskId}), (n:File {path: $path})
           MERGE (t)-[r:TOUCHED]->(n)
           SET r.at = $at, r.kind = $kind
           RETURN count(n) AS count`
        : `MATCH (t:Task {taskId: $taskId}), (n {name: $name, file: $file})
           WHERE n:Function OR n:Class OR n:Component
           MERGE (t)-[r:TOUCHED]->(n)
           SET r.at = $at, r.kind = $kind
           RETURN count(n) AS count`,
      { taskId: active.taskId, name: target.name, file: target.file, path: target.path, at, kind },
    );
    touched += result.records[0]?.get("count")?.toNumber?.()
      ?? Number(result.records[0]?.get("count") || 0);
  }
  return { taskId: active.taskId, touched };
}

async function getTouchedNodes(session, taskId) {
  const result = await session.run(
    `MATCH (t:Task {taskId: $taskId})-[r:TOUCHED]->(n)
     RETURN n.name AS name, n.path AS path, n.file AS file, n.ipv6 AS ipv6,
            labels(n) AS labels, r.at AS at, r.kind AS kind`,
    { taskId },
  );
  return result.records.map((record) => ({
    name: record.get("name"),
    path: record.get("path"),
    file: record.get("file"),
    ipv6: record.get("ipv6"),
    labels: record.get("labels"),
    at: record.get("at"),
    kind: record.get("kind"),
  }));
}

async function getSyncFiles(session, { taskId, waveId }) {
  const result = await session.run(
    `MATCH (t:Task) WHERE ${taskId != null ? 't.taskId = $taskId' : "t.wave = $waveId AND t.status IN ['done', 'review']"}
     MATCH (t)-[:AFFECTS|:RESERVES|:TOUCHED]->(n)
     WHERE coalesce(n.file, n.path) IS NOT NULL
     RETURN DISTINCT coalesce(n.file, n.path) AS file, t.taskId AS taskId`,
    taskId != null ? { taskId } : { waveId },
  );
  return result.records.map(r => ({ file: r.get('file'), taskId: r.get('taskId') }));
}

module.exports = { getAgentTaskGroup, recordTouchedNodes, getTouchedNodes, getSyncFiles };
