const test = require('node:test');
const assert = require('node:assert/strict');
const {
  listLogDates, readLogEntries, requestedDate, requestedLimit,
} = require('../server/log-routes.cjs');

test('log query inputs are bounded and invalid dates fall back to today', () => {
  assert.equal(requestedDate('2026-08-17'), '2026-08-17');
  assert.equal(requestedDate('../secret', new Date('2025-02-03T12:00:00Z')), '2025-02-03');
  assert.equal(requestedLimit('99999'), 5000);
  assert.equal(requestedLimit('-1'), 200);
});

test('log entries ignore malformed lines, filter, count, and return newest first', () => {
  const fileSystem = {
    existsSync: () => true,
    readFileSync: () => [
      JSON.stringify({ id: 1, agent: 'a', taskId: 't', operation: 'read' }),
      'not json',
      JSON.stringify({ id: 2, agent: 'b', taskId: 't', operation: 'write' }),
      JSON.stringify({ id: 3, agent: 'a', taskId: 't', operation: 'read' }),
    ].join('\n'),
  };
  const result = readLogEntries('logs', {
    date: '2026-08-17', agent: 'a', taskId: 't', op: 'read', limit: '1',
  }, fileSystem);
  assert.equal(result.total, 2);
  assert.deepEqual(result.entries.map((entry) => entry.id), [3]);
});

test('log dates include only JSONL date files in newest-first order', () => {
  const fileSystem = {
    existsSync: () => true,
    readdirSync: () => ['notes.txt', '2025-01-02.jsonl', '2026-08-17.jsonl'],
  };
  assert.deepEqual(listLogDates('logs', fileSystem), ['2026-08-17', '2025-01-02']);
});
