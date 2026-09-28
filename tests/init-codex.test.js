const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { parse } = require('smol-toml');

function project(t, source) {
  const root = fs.mkdtempSync(join(tmpdir(), 'codevis codex-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = join(root, '.codex/config.toml');
  if (source !== undefined) {
    fs.mkdirSync(join(root, '.codex'));
    fs.writeFileSync(file, source);
  }
  return { root, file };
}

test('Codex setup pins the local launcher, workspace and Lead role, and is idempotent', async t => {
  const { configureCodex } = await import('../lib/init-codex.mjs');
  const { root, file } = project(t);
  const launcher = 'C:\\work space\\quoted"name\\bin\\codevis.mjs';
  assert.equal(configureCodex(root, launcher).created, true);
  const source = fs.readFileSync(file, 'utf8');
  const server = parse(source).mcp_servers.codevis_graph;
  assert.equal(server.command, process.execPath);
  assert.deepEqual(server.args, [launcher, 'start']);
  assert.equal(server.cwd, root);
  assert.deepEqual({ ...server.env }, { CODEVIS_PROJECT_DIR: root, CODEVIS_ROLE: 'lead' });
  assert.equal(server.enabled, true);
  assert.equal(server.startup_timeout_sec, 60);
  assert.equal(server.tool_timeout_sec, 300);
  assert.equal(configureCodex(root, launcher).created, false);
  assert.equal(fs.readFileSync(file, 'utf8'), source);
});

test('Codex setup preserves comments, CRLF, unrelated servers and multiline strings', async t => {
  const { configureCodex } = await import('../lib/init-codex.mjs');
  const original = `# User preferences\r\nmodel = "chosen-model"\r\nnotes = '''\r\n[mcp_servers.codevis_graph]\r\nnot a real table\r\n'''\r\n[mcp_servers]\r\n[mcp_servers.other]\r\ncommand = "custom" # keep this\r\n[features]\r\nexample = true`;
  const { root, file } = project(t, original);
  configureCodex(root, '/local/bin/codevis.mjs');
  const source = fs.readFileSync(file, 'utf8');
  assert.ok(source.startsWith(original + '\r\n'));
  assert.equal(parse(source).model, 'chosen-model');
  assert.equal(parse(source).mcp_servers.other.command, 'custom');
  assert.equal(parse(source).features.example, true);
  assert.ok(parse(source).mcp_servers.codevis_graph);
});

test('existing quoted or inline CodeVis entries retain restrictions and disabled state', async t => {
  const { configureCodex } = await import('../lib/init-codex.mjs');
  for (const original of [
    `[mcp_servers."codevis_graph"]\ncommand = 'custom'\nenabled = false\nenabled_tools = ['flow_read']\n`,
    `mcp_servers = { codevis_graph = { command = 'custom', enabled = false } }\n`,
  ]) {
    const { root, file } = project(t, original);
    assert.equal(configureCodex(root, '/other/launcher').created, false);
    assert.equal(fs.readFileSync(file, 'utf8'), original);
  }
});

test('invalid or non-extensible TOML fails without modifying or leaking user contents', async t => {
  const { configureCodex } = await import('../lib/init-codex.mjs');
  for (const original of ['model = "private-value', 'mcp_servers = { other = { command = "custom" } }', 'mcp_servers = 42']) {
    const { root, file } = project(t, original);
    assert.throws(() => configureCodex(root, '/launcher'), error => {
      assert.match(error.message, /\.codex\/config.toml/);
      assert.match(error.message, /not changed/);
      assert.doesNotMatch(error.message, /private-value/);
      return true;
    });
    assert.equal(fs.readFileSync(file, 'utf8'), original);
  }
});
