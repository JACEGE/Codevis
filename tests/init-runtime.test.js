const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { join, resolve } = require('node:path');
const { tmpdir } = require('node:os');
const { pathToFileURL } = require('node:url');
const { spawnSync } = require('node:child_process');
const repo = resolve(__dirname, '..');

function project(t) {
  const dir = fs.mkdtempSync(join(tmpdir(), 'codevis-init-runtime-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(join(dir, 'src'));
  return dir;
}

// Stub only the external installer; exercise the real wizard, files and CLI errors.
function init(dir, args, failInstall = false) {
  const script = `require('node:child_process').execSync = (command) => {
    if (!/^npm install --save-dev --save-exact "codevis@/.test(command)) throw new Error('Unexpected installer: ' + command);
    console.log('INSTALLER ' + command);
    ${failInstall ? "throw new Error('installer failed');" : "return '';"}
  }; import(${JSON.stringify(pathToFileURL(join(repo, 'lib/commands/init.mjs')).href)})
    .then(m => m.default(${JSON.stringify(args)})).catch(e => { console.error(e.message); process.exitCode = 1; });`;
  return spawnSync(process.execPath, ['-e', script], { cwd: dir, encoding: 'utf8', timeout: 10000 });
}

function load(dir) {
  const file = join(dir, 'codevis.config.cjs');
  delete require.cache[require.resolve(file)];
  return require(file);
}

test('init safely serializes Windows paths, quotes, knowledge paths and exclusions', t => {
  const dir = project(t);
  const source = 'C:\\temp\\new\\src';
  const knowledge = './docs/"quoted"';
  const excluded = '**\\test\\*';
  const result = init(dir, ['code', '--source', source, '--exclude', excluded, '--knowledge', knowledge, '-y']);
  assert.equal(result.status, 0, result.stderr);
  const config = load(dir);
  for (const workspace of Object.values(config.workspaces)) {
    assert.equal(workspace.dbUri, undefined);
    assert.equal(workspace.neo4jUri, undefined);
    assert.equal(workspace.auth, undefined);
  }
  assert.deepEqual(config.workspaces.project_db.sourceDir, [source]);
  assert.deepEqual(config.workspaces.project_db.exclude, [excluded]);
  assert.deepEqual(config.knowledge.paths, [knowledge]);
});

test('mode switches preserve custom and executable configuration across repeated adjustments', t => {
  const dir = project(t);
  const original = `// user comment\nmodule.exports = {
    workMode: 'planning', custom: () => 'retained',
    autoUpdate: { enabled: false, debounceMs: 750 }, locking: { enabled: false, ttlMs: 12345 },
    workspaces: { target: { sourceDir: [], auth: { pass: process.env.CODEVIS_TEST_TOKEN || 'fallback' }, custom: true } }
  };\n`;
  fs.writeFileSync(join(dir, 'codevis.config.cjs'), original);
  for (const args of [['code', '--source', './src'], ['--watch'], ['--no-locking']]) {
    const configPath = join(dir, 'codevis.config.cjs');
    fs.writeFileSync(configPath, fs.readFileSync(configPath, 'utf8').replace(/\r?\n/g, '\r\n'));
    const result = init(dir, [...args, '-y']);
    assert.equal(result.status, 0, result.stderr);
    const config = load(dir);
    assert.equal(config.custom(), 'retained');
    assert.equal(config.autoUpdate.debounceMs, 750);
    assert.equal(config.locking.ttlMs, 12345);
    assert.equal(config.workspaces.project_db.custom, true);
    assert.equal(config.workspaces.project_db.auth.pass, 'fallback');
    assert.equal(config.workMode, 'code');
  }
  const source = fs.readFileSync(join(dir, 'codevis.config.cjs'), 'utf8');
  assert.ok(source.startsWith(original.trimEnd()));
  assert.equal(source.match(/BEGIN CODEVIS SETUP OVERRIDES/g).length, 1);
  assert.equal(load(dir).autoUpdate.enabled, true);
  assert.equal(init(dir, ['code', '--source', './src', '--recreate', '-y']).status, 0);
  assert.equal(load(dir).custom, undefined);
});

test('init from a git checkout links the checkout instead of the older registry release', t => {
  const dir = project(t);
  const result = init(dir, ['new', '-y']);
  assert.equal(result.status, 0, result.stderr);
  const checkout = repo.replace(/\\/g, '/');
  assert.match(result.stdout, new RegExp(`INSTALLER npm install --save-dev --save-exact "codevis@file:${checkout.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`));
});

test('--clients configures only the chosen AI clients, and re-init keeps that choice', t => {
  const dir = project(t);
  assert.equal(init(dir, ['new', '--clients', 'codex']).status, 0);
  assert.equal(fs.existsSync(join(dir, '.codex/config.toml')), true);
  assert.equal(fs.existsSync(join(dir, '.mcp.json')), false);
  assert.equal(fs.existsSync(join(dir, '.claude/settings.local.json')), false);
  const again = init(dir, ['-y']);
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /AI clients: codex/);
  assert.equal(fs.existsSync(join(dir, '.mcp.json')), false);
  assert.match(init(dir, ['--clients', 'cursorx']).stderr, /Unknown AI client: cursorx/);
});

test('dependency failures fail init and never report setup complete', t => {
  const dir = project(t);
  const result = init(dir, ['new', '-y'], true);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Dependency installation failed/);
  assert.doesNotMatch(result.stdout, /Setup complete/);
  assert.equal(fs.existsSync(join(dir, '.mcp.json')), false);
  assert.equal(fs.existsSync(join(dir, '.codex/config.toml')), false);
});

test('re-init migrates hook registrations without duplicating or replacing unrelated hooks', t => {
  const dir = project(t);
  fs.mkdirSync(join(dir, '.claude'));
  const file = join(dir, '.claude/settings.local.json');
  fs.writeFileSync(file, JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Edit|Write', hooks: [
    { type: 'command', command: `node "${dir.replace(/\\/g, '/')}/.claude/hooks/lock-guard.js"` },
    { type: 'command', command: 'my-custom-hook' },
  ] }] } }));
  for (let i = 0; i < 2; i++) assert.equal(init(dir, ['new', '-y']).status, 0);
  const hooks = JSON.parse(fs.readFileSync(file)).hooks.PreToolUse.flatMap(entry => entry.hooks);
  assert.equal(hooks.filter(h => h.command.includes('lock-guard')).length, 1);
  assert.ok(hooks.some(h => h.command.endsWith('lock-guard.cjs"')));
  assert.ok(hooks.some(h => h.command === 'my-custom-hook'));
  const postHooks = JSON.parse(fs.readFileSync(file)).hooks.PostToolUse;
  // One touch-recorder entry per matcher, however often init runs: edits,
  // and the task claims that tell a subagent's edits which task they belong to.
  assert.deepEqual(postHooks.filter(entry => entry.hooks.some(h => h.command.endsWith('touch-recorder.cjs"'))).map(entry => entry.matcher),
    ['Edit|Write|MultiEdit', 'mcp__codevis_.*__(claim_task|get_next_task|complete_task)']);
  const server = JSON.parse(fs.readFileSync(join(dir, '.mcp.json'))).mcpServers.codevis_graph;
  assert.equal(server.command, 'node');
  // The child resolves cwd through macOS's /var -> /private/var alias.
  assert.equal(server.args[0], join(fs.realpathSync(dir), 'node_modules/codevis/bin/codevis.mjs'));
  assert.equal(server.args[1], 'start');
});

test('invalid existing configuration and MCP JSON are not silently overwritten', t => {
  const dir = project(t);
  const config = join(dir, 'codevis.config.cjs');
  fs.writeFileSync(config, 'broken config');
  assert.equal(init(dir, ['code', '--source', './src', '-y']).status, 1);
  assert.equal(fs.readFileSync(config, 'utf8'), 'broken config');
  fs.writeFileSync(config, 'module.exports = {};');
  fs.writeFileSync(join(dir, '.mcp.json'), 'broken json');
  assert.equal(init(dir, ['new', '-y']).status, 1);
  assert.equal(fs.readFileSync(join(dir, '.mcp.json'), 'utf8'), 'broken json');
});

test('loadConfig sees mode changes within the same process', t => {
  const dir = project(t);
  const file = join(dir, 'codevis.config.cjs');
  fs.writeFileSync(file, 'module.exports = {workMode:"planning"};');
  const script = `const paths = require(${JSON.stringify(join(repo, 'server/codevis-paths.cjs'))});
    const first = paths.loadConfig().workMode;
    require('fs').writeFileSync(${JSON.stringify(file)}, 'module.exports = {workMode:"code"};');
    console.log(first, paths.loadConfig().workMode);`;
  const result = spawnSync(process.execPath, ['-e', script], { cwd: dir, env: { ...process.env, CODEVIS_PROJECT_DIR: dir }, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'planning code');
});

test('runtime version gate agrees with supported Node minimum', () => {
  const { supportedNode } = require('../lib/check-node.cjs');
  for (const version of ['18.20.8', '20.19.0', '22.11.0']) assert.equal(supportedNode(version), false);
  for (const version of ['22.12.0', '22.20.0', '24.0.0']) assert.equal(supportedNode(version), true);
});


test('init registers Codex automatically in both modes and preserves it on re-init', t => {
  const { parse } = require('smol-toml');
  for (const mode of ['new', 'code']) {
    const dir = project(t);
    const result = init(dir, [mode, '-y']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Codex MCP/);
    assert.match(result.stdout, /trusted projects/);
    const file = join(dir, '.codex/config.toml');
    const original = fs.readFileSync(file, 'utf8');
    const server = parse(original).mcp_servers.codevis_graph;
    assert.equal(server.cwd, fs.realpathSync(dir));
    assert.equal(server.command, process.execPath);
    assert.deepEqual(server.args, [join(fs.realpathSync(dir), 'node_modules/codevis/bin/codevis.mjs'), 'start']);
    assert.equal(server.env.CODEVIS_PROJECT_DIR, fs.realpathSync(dir));
    assert.equal(server.env.CODEVIS_ROLE, 'lead');
    assert.equal(init(dir, ['-y']).status, 0);
    assert.equal(fs.readFileSync(file, 'utf8'), original);
  }
});

test('invalid Codex config fails init without a false setup-complete message', t => {
  const dir = project(t);
  fs.mkdirSync(join(dir, '.codex'));
  const file = join(dir, '.codex/config.toml');
  fs.writeFileSync(file, 'invalid = [');
  const result = init(dir, ['new', '-y']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Invalid .codex/);
  assert.doesNotMatch(result.stdout, /Setup complete/);
  assert.equal(fs.readFileSync(file, 'utf8'), 'invalid = [');
});
