const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');

const ROOT = path.resolve(__dirname, '..');
const SERVER = path.join(ROOT, 'tools', 'mcp_server.ts');
const TSX_LAUNCHER = path.join(ROOT, 'lib', 'tsx-launcher.cjs');
const EDIT_TOOLS = [
  'edit_function', 'edit_code_patch', 'insert_code', 'rewrite_function',
  'rollback_edit', 'move_function', 'rename_function', 'multi_file_edit',
  'recover_stale_edit',
];

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

async function listRoleTools(role, dataDir, daemonPort) {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [TSX_LAUNCHER, SERVER],
    cwd: ROOT,
    env: {
      ...process.env,
      CODEVIS_ROLE: role,
      CODEVIS_DATA_DIR: dataDir,
      LADYBUG_DAEMON_PORT: String(daemonPort),
      LADYBUG_PIDFILE: path.join(dataDir, 'daemon.pid'),
    },
  });
  const client = new Client({ name: `role-${role}-test`, version: '1.0.0' }, { capabilities: {} });
  await client.connect(transport);
  try {
    return new Set((await client.listTools()).tools.map((tool) => tool.name));
  } finally {
    await client.close();
  }
}

test('role-scoped MCP servers expose the edit contract used by generated agents', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codevis-role-tools-'));
  const daemonPort = await freePort();
  t.after(async () => {
    try {
      await fetch(`http://127.0.0.1:${daemonPort}/shutdown`, {
        method: 'POST', headers: { Connection: 'close' }, signal: AbortSignal.timeout(10_000),
      });
    } catch {}
    await fs.promises.rm(dataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  });

  const worker = await listRoleTools('worker', dataDir, daemonPort);
  for (const name of EDIT_TOOLS) assert.ok(worker.has(name), `worker is missing ${name}`);
  for (const name of ['get_task', 'add_task_comment', 'sync_task']) {
    assert.ok(worker.has(name), `worker is missing task workflow tool ${name}`);
  }

  const lead = await listRoleTools('lead', dataDir, daemonPort);
  for (const name of EDIT_TOOLS) assert.equal(lead.has(name), false, `lead unexpectedly exposes ${name}`);
  for (const name of ['create_task', 'plan_task_waves', 'approve_release']) {
    assert.ok(lead.has(name), `lead is missing orchestration tool ${name}`);
  }
});
