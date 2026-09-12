const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('route and annotation tools are available to worker agents', () => {
  const server = fs.readFileSync(path.resolve(__dirname, '../tools/mcp_server.ts'), 'utf8');
  assert.match(server, /annotationTools/);
  assert.match(server, /workerToolNames[\s\S]*"find_path"/);
  assert.match(server, /workerToolNames[\s\S]*"propose_annotation"/);
  assert.match(server, /workerToolNames[\s\S]*"list_annotations"/);
});
