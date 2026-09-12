const { test } = require("node:test");
const assert = require("node:assert/strict");

const { generateTaskId, reserveUniqueTaskId } = require("../tools/lib/task-id.cjs");

function sessionWithIds(ids) {
  return {
    async run(_query, { taskId }) {
      return {
        records: [{ get: () => ({ toNumber: () => ids.has(taskId) ? 1 : 0 }) }],
      };
    },
  };
}

test("two tasks generated in the same millisecond receive different IDs", () => {
  const originalNow = Date.now;
  Date.now = () => 1775318400000;
  try {
    const first = generateTaskId();
    const second = generateTaskId();
    assert.match(first, /^task-1775318400000-/);
    assert.match(second, /^task-1775318400000-/);
    assert.notEqual(first, second);
  } finally {
    Date.now = originalNow;
  }
});

test("uniqueness guard recognizes legacy task-<millis> IDs and retries", async () => {
  const legacyId = "task-1700000000000";
  const replacement = "task-1700000000000-new";
  const candidates = [legacyId, replacement];
  const allocated = await reserveUniqueTaskId(
    sessionWithIds(new Set([legacyId])),
    () => candidates.shift(),
  );
  assert.equal(allocated, replacement);
});
