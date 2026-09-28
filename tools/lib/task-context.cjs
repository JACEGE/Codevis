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

const countOf = (result) => result.records[0]?.get("count")?.toNumber?.()
  ?? Number(result.records[0]?.get("count") || 0);

/**
 * TOUCHED for a raw edit given as line ranges: the File, plus every
 * Function/Class/Component whose current span overlaps a changed line.
 * Line numbers must come from the graph's current parse of the file.
 */
/**
 * `at`/`agentId` are the journal entry's: when and by whom the edit was made,
 * not when it was replayed. `since` is the task's first journaled edit; a node
 * the graph first saw after it was written for this task ('created'),
 * otherwise it existed and was changed ('modified'). The first replay decides
 * and later ones keep it: a full rebuild resets createdAt and would otherwise
 * turn every node into 'created'.
 */
async function recordTouchedRanges(session, { taskId, kind, file, ranges, at = Date.now(), agentId = null, since = null }) {
  if (!taskId || !file || !ranges?.length) return 0;
  let touched = 0;
  const stamp = `SET r.kind = $kind, r.agentId = coalesce($agentId, r.agentId),
      r.firstAt = CASE WHEN r.firstAt IS NULL OR r.firstAt > $at THEN $at ELSE r.firstAt END,
      r.at = CASE WHEN r.at IS NULL OR r.at < $at THEN $at ELSE r.at END,
      r.change = coalesce(r.change, CASE WHEN $since IS NOT NULL AND n.createdAt >= $since THEN 'created' ELSE 'modified' END)`;
  const params = { taskId, file, at, kind, agentId, since };
  const fileResult = await session.run(
    `MATCH (t:Task {taskId: $taskId}), (n:File {path: $file})
    MERGE (t)-[r:TOUCHED]->(n)
    ${stamp}
    RETURN count(n) AS count`,
    params,
  );
  touched += countOf(fileResult);
  for (const { start, end } of ranges) {
    const result = await session.run(
      `MATCH (t:Task {taskId: $taskId}), (n {file: $file})
      WHERE (n:Function OR n:Class OR n:Component)
       AND n.startLine IS NOT NULL AND n.startLine <= $lastLine AND n.endLine >= $firstLine
      MERGE (t)-[r:TOUCHED]->(n)
      ${stamp}
      RETURN count(n) AS count`,
      { ...params, firstLine: start, lastLine: end },
    );
    touched += countOf(result);
  }
  return touched;
}

async function getTouchedNodes(session, taskId) {
  const result = await session.run(
    `MATCH (t:Task {taskId: $taskId})-[r:TOUCHED]->(n)
     RETURN n.name AS name, n.path AS path, n.file AS file, n.ipv6 AS ipv6,
            labels(n) AS labels, r.at AS at, r.kind AS kind,
            r.firstAt AS firstAt, r.agentId AS agentId, r.change AS change`,
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
    firstAt: record.get("firstAt"),
    agentId: record.get("agentId"),
    change: record.get("change"),
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

module.exports = { getAgentTaskGroup, recordTouchedNodes, recordTouchedRanges, getTouchedNodes, getSyncFiles };
