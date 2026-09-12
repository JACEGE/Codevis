const test = require('node:test');
const assert = require('node:assert/strict');
const { auditFiles } = require('../scripts/release/audit-repository.cjs');

function audit(content, filename = 'src/example.js') {
  return auditFiles([filename], { root: '.', readFile: () => content });
}

test('release audit identifies credential material without returning its value', () => {
  const value = `ghp_${'a'.repeat(32)}`;
  const findings = audit(`const auth = '${value}';`);
  assert.deepEqual(findings.map(({ file, line, kind }) => ({ file, line, kind })), [
    { file: 'src/example.js', line: 1, kind: 'GitHub token' },
  ]);
  assert.equal(JSON.stringify(findings).includes(value), false);
});

test('release audit rejects sensitive filenames and real-user paths outside tests', () => {
  assert.equal(audit('TOKEN=x', '.env.local')[0].kind, 'sensitive filename');
  assert.equal(audit('root = "C:\\Users\\alice\\project"')[0].kind, 'machine-specific absolute path');
  assert.deepEqual(audit('root = "C:\\Users\\alice\\project"', 'tests/fixture.js'), []);
});

test('release audit permits environment lookups and portable relative paths', () => {
  assert.deepEqual(audit('const token = process.env.API_TOKEN; const root = "./src";'), []);
});

test('release audit detects spaced, escaped and forward-slash user paths', () => {
  for (const userPath of [
    'C:\\Users\\Jane Doe\\project',
    'C:/Users/Jane Doe/project',
    '/Users/Jane Doe/project',
    '/home/jane doe/project',
  ]) {
    for (const content of [userPath, JSON.stringify({ root: userPath })]) {
      assert.ok(audit(content).some(finding => finding.kind === 'machine-specific absolute path'), content);
    }
  }
});
