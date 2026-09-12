const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const {
  codeTargetPredicate,
  mergeTaskSpec,
  taskSpecProblems,
  transitionTaskLocks,
} = require('../tools/lib/task-rules.cjs');

const validSpec = {
  title: 'Repair task validation',
  description: 'Describe the broken behaviour, the desired result, and the constraints with enough detail for another worker to act safely.',
  workInstructions: 'Change the shared rule, add regression coverage, and run the focused plus full test suites.',
};

describe('shared task specification rules', () => {
  it('rejects every underspecified field through one shared validator', () => {
    const problems = taskSpecProblems({ title: 'x', description: 'y', workInstructions: 'z' });
    assert.equal(problems.length, 3);
    assert.match(problems[0], /title is too short/);
    assert.match(problems[1], /description is too short/);
    assert.match(problems[2], /workInstructions is too short/);
  });

  it('validates the complete stored task after a partial edit', () => {
    assert.deepEqual(taskSpecProblems(validSpec), []);
    const edited = mergeTaskSpec(validSpec, { title: 'tiny' });
    assert.match(taskSpecProblems(edited)[0], /title is too short/);
    assert.equal(edited.description, validSpec.description);
  });
});

describe('shared code target rule', () => {
  it('allows only supported code labels and uses file paths', () => {
    const predicate = codeTargetPredicate('node', '$target');
    assert.match(predicate, /node:Function OR node:Class OR node:Component/);
    assert.match(predicate, /node\.name = \$target/);
    assert.match(predicate, /node:File AND node\.path = \$target/);
  });

  it('rejects dynamic Cypher fragments', () => {
    assert.throws(() => codeTargetPredicate('n) MATCH (secret', '$target'), TypeError);
  });
});

describe('shared task lock transitions', () => {
  it('does not touch the graph when project locking is disabled', async () => {
    const session = { run: async () => { throw new Error('must not query'); } };
    const result = await transitionTaskLocks(session, 'task-a', 'todo', 'in_progress', 'worker', false);
    assert.deepEqual(result, { status: 'DISABLED', activatedCount: 0, releasedCount: 0 });
  });

  it('releases planned as well as active locks when a task becomes done', async () => {
    let query = '';
    const session = {
      run: async (cypher) => {
        query = cypher;
        return { records: [{ get: () => ({ toNumber: () => 2 }) }] };
      },
    };
    const result = await transitionTaskLocks(session, 'task-a', 'review', 'done', 'user');
    assert.equal(result.releasedCount, 2);
    assert.match(query, /n\.lockGroup = \$taskId/);
    assert.match(query, /n\.lockStatus = null/);
    assert.doesNotMatch(query, /n\.locked = true/);
  });

  it('treats the legacy open column as a non-blocking planned state', async () => {
    let query = '';
    const session = {
      run: async (cypher) => {
        query = cypher;
        return { records: [] };
      },
    };
    const result = await transitionTaskLocks(session, 'task-a', 'in_progress', 'open', 'user');
    assert.equal(result.status, 'OK');
    assert.match(query, /n\.lockStatus = 'planned'/);
  });
});

describe('REST and MCP use the shared task rules', () => {
  const root = path.resolve(__dirname, '..');
  const bridge = fs.readFileSync(path.join(root, 'server/bridge.js'), 'utf8');
  const mcp = fs.readFileSync(path.join(root, 'tools/handlers/task-tools.ts'), 'utf8');
  const legacyKanban = fs.readFileSync(path.join(root, 'lib/kanban-server.mjs'), 'utf8');
  const claims = fs.readFileSync(path.join(root, 'server/task-claims.cjs'), 'utf8');

  it('routes both creation paths through taskSpecProblems', () => {
    assert.match(bridge, /taskSpecProblems\(\{ title, description, workInstructions \}/);
    assert.match(mcp, /taskSpecProblems\(args, \{ subject: "task" \}\)/);
  });

  it('routes REST and MCP target linking through codeTargetPredicate', () => {
    assert.match(bridge, /codeTargetPredicate\('n', 'name'\)/);
    assert.match(claims, /codeTargetPredicate\('n', '\$name'\)/);
  });

  it('validates the merged stored task on REST edits', () => {
    assert.match(bridge, /const candidate = mergeTaskSpec\(/);
    assert.match(bridge, /taskSpecProblems\(candidate, \{ subject: 'task' \}\)/);
  });

  it('delegates REST status and ownership changes to the atomic operation', () => {
    const route = bridge.slice(
      bridge.indexOf("app.patch('/api/tasks/:taskId/status'"),
      bridge.indexOf("app.patch('/api/tasks/:taskId'", bridge.indexOf("app.patch('/api/tasks/:taskId/status'") + 1),
    );
    assert.match(route, /transitionTaskLocks\(/);
    assert.doesNotMatch(route, /SET t\.status/);
    assert.match(route, /includes\(lockTransition\.status\)/);
    const legacyRoute = legacyKanban.slice(
      legacyKanban.indexOf('app.patch("/api/tasks/:taskId/status"'),
      legacyKanban.indexOf('const PORT =', legacyKanban.indexOf('app.patch("/api/tasks/:taskId/status"')),
    );
    assert.match(legacyRoute, /transitionTaskLocks\(/);
    assert.doesNotMatch(legacyRoute, /WHERE n\.locked = true/);
  });

  it('returns 404 when a REST comment delete did not remove anything', () => {
    assert.match(bridge, /await deleteTaskComment\(session, taskId, commentId\)/);
    // The helper's actual 404 behaviour is covered against Ladybug in task-comments.test.js.
  });
});
