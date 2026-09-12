const { randomUUID } = require("node:crypto");

function generateTaskId() {
  return generateWorkItemId('task');
}

function generateWorkItemId(kind) {
  return `${kind}-${Date.now()}-${randomUUID()}`;
}

async function reserveUniqueTaskId(session, idFactory = generateTaskId) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const taskId = idFactory();
    const existing = await session.run(
      `MATCH (t:Task {taskId: $taskId}) RETURN count(t) AS count`,
      { taskId },
    );
    const count = existing.records[0]?.get("count")?.toNumber?.()
      ?? Number(existing.records[0]?.get("count") || 0);
    if (count === 0) return taskId;
  }
  throw new Error("Could not allocate a unique taskId after 8 attempts.");
}

module.exports = { generateWorkItemId, generateTaskId, reserveUniqueTaskId };
