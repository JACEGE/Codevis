const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const frontendPkg = JSON.parse(fs.readFileSync(path.join(root, 'frontend', 'package.json'), 'utf8'));

test('public release remains a beta published under the beta dist-tag', () => {
  assert.match(pkg.version, /-beta\.\d+$/);
  assert.equal(pkg.publishConfig?.access, 'public');
  assert.equal(pkg.publishConfig?.tag, 'beta');
});

test('every reset command references a file included in the package', () => {
  for (const command of ['reset:project', 'reset:codevis', 'reset:project-force', 'reset:codevis-force', 'reset-component:project', 'reset-component:codevis']) {
    const scriptPath = pkg.scripts[command].match(/node\s+([^\s]+)/)?.[1];
    assert.ok(scriptPath, `${command} must invoke a script`);
    assert.ok(fs.existsSync(path.join(root, scriptPath)), `${scriptPath} must exist`);
    assert.ok(pkg.files.includes(scriptPath), `${scriptPath} must be published`);
  }
});

test('published package omits repository-only source and test trees', () => {
  assert.equal(pkg.files.includes('frontend/src/'), false);
  assert.equal(pkg.files.includes('tests/'), false);
  assert.equal(pkg.files.includes('scripts/run-tests.mjs'), false);
});

test('release notes are explicitly included in the package allowlist', () => {
  assert.ok(pkg.files.includes('CHANGELOG.md'));
});

test('dashboard assets and the published package use the same release version', () => {
  assert.equal(frontendPkg.version, pkg.version);
});

test('active public guides ship without internal instructions or dated review archives', () => {
  assert.equal(pkg.files.includes('AGENTS.md'), false);
  assert.ok(pkg.files.includes('docs/*.md'));
  assert.equal(pkg.files.includes('docs/reviews/'), false);
  assert.equal(pkg.files.includes('docs/benchmarks/'), false);
});

test('documentation screenshots ship with the dashboard that renders them', () => {
  assert.ok(pkg.files.includes('docs/screenshots/'));
  assert.ok(fs.existsSync(path.join(root, 'docs', 'screenshots', 'overview.png')));
});

test('removed repository-only web crawler is not exposed as an npm command', () => {
  assert.equal(pkg.scripts['explore:web'], undefined);
  assert.equal(pkg.scripts['explore:web:replay'], undefined);
  assert.equal(fs.existsSync(path.join(root, 'tools', 'webexplorer', 'run.cjs')), false);
});

test('release gate audits root development tooling and production dependencies in both package trees', () => {
  assert.match(pkg.scripts['audit:dependencies'], /^npm audit &&/);
  assert.match(pkg.scripts['audit:dependencies'], /npm --prefix frontend audit --omit=dev/);
  assert.match(pkg.scripts['release:check'], /npm run audit:dependencies/);
});

test('committed self-analysis config uses the real portable config path', () => {
  const config = fs.readFileSync(path.join(root, 'codevis.config.cjs'), 'utf8');
  assert.match(config, /\.\/codevis\.config\.cjs/);
  assert.doesNotMatch(config, /[A-Za-z]:\\Users\\|\/Users\/[^/]+\/|\/home\/[^/]+\//);
});

test('edit tools use public database names internally and at their schema boundary', () => {
  const edits = fs.readFileSync(path.join(root, 'tools', 'handlers', 'edit-tools.ts'), 'utf8');
  const server = fs.readFileSync(path.join(root, 'tools', 'mcp_server.ts'), 'utf8');
  assert.match(edits, /pickDbDriver/);
  assert.doesNotMatch(edits, /enum:\s*\["meta",\s*"tool"\]/);
  assert.doesNotMatch(edits, /args\.db\s*===\s*"tool"/);
  assert.match(server, /args\.db = publicWorkspaceName\(normalizeWorkspaceName/);
});
