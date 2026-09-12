const test = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const path = require('node:path');

test('Brain channel registers and replies at its configured bridge, reporting HTTP failures', { timeout: 20000 }, async (t) => {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const requests = [];
  let registered;
  const registration = new Promise(resolve => { registered = resolve; });
  const bridge = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push({ url: req.url, body: JSON.parse(Buffer.concat(chunks).toString()) });
    if (req.url === '/api/brain/register') registered();
    res.writeHead(req.url === '/api/brain/result' ? 500 : 200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'test response' }));
  });
  await new Promise(resolve => bridge.listen(0, '127.0.0.1', resolve));
  const client = new Client({ name: 'brain-channel-test', version: '1.0' }, { capabilities: {} });
  t.after(async () => {
    await client.close();
    bridge.closeAllConnections();
    await new Promise(resolve => bridge.close(resolve));
  });
  const root = path.resolve(__dirname, '..');
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [path.join(root, 'lib/tsx-launcher.cjs'), path.join(root, 'tools/channels/codevis-brain/server.ts')],
    cwd: root,
    env: { ...process.env, CODEVIS_PROJECT_DIR: root, CODEVIS_BRIDGE_PORT: String(bridge.address().port) },
  }));
  let timer;
  try {
    await Promise.race([registration, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Channel did not register at the configured bridge')), 5000);
    })]);
  } finally { clearTimeout(timer); }
  const result = await client.callTool({ name: 'reply_brain', arguments: { chat_id: 'test', summary: 'test', nodeIds: [] } });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /500/);
  assert.equal(requests.find(req => req.url === '/api/brain/result').body.chat_id, 'test');
});
