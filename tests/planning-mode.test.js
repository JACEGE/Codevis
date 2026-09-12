const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, mkdirSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { spawnSync } = require('node:child_process');

const repositoryRoot = resolve(__dirname, '..');
const cli = join(repositoryRoot, 'bin', 'codevis.mjs');

function runInPlanningProject(command) {
  const project = mkdtempSync(join(tmpdir(), 'codevis-planning-'));
  try {
    writeFileSync(join(project, 'codevis.config.cjs'), `module.exports = {
  workMode: "planning",
  autoUpdate: { enabled: true },
  workspaces: { project_db: { sourceDir: [] } },
};\n`);
    mkdirSync(join(project, 'src'));
    return spawnSync(process.execPath, [cli, command], {
      cwd: join(project, 'src'),
      env: { ...process.env, CODEVIS_PROJECT_DIR: '' },
      encoding: 'utf8',
    });
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
}

test('planning mode skips an explicit code graph build', () => {
  const result = runInPlanningProject('build');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Planning mode does not build a code graph/);
  assert.match(result.stdout, /codevis init code/);
});

test('planning mode does not start the file watcher', () => {
  const result = runInPlanningProject('watch');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Planning mode does not watch or build a code graph/);
});

test('MCP graph updates honor planning mode before spawning the builder', () => {
  const source = require('node:fs').readFileSync(join(repositoryRoot, 'tools/handlers/bridge-tools.ts'), 'utf8');
  assert.match(source, /projectConfig\.workMode === "planning"/);
  assert.match(source, /Skipped: this project is in planning mode/);
});
