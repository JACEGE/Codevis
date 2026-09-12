const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
require('../lib/tsx-userinfo-preload.cjs');
require('tsx/cjs/api').register();
const { sanitizeParams } = require('../tools/lib/logger.ts');

test('log redaction follows nested arrays without changing handler arguments', () => {
    const args = { items: [{ password: 'dummy', config: [{ apiKey: 'dummy' }] }], plain: 'okay' };
    const sanitized = sanitizeParams(args);
    assert.ok(!JSON.stringify(sanitized).includes('dummy'));
    assert.equal(sanitized.plain, 'okay');
    assert.equal(args.items[0].password, 'dummy');
});

test('log rotation works in the actual ESM MCP runtime', t => {
    const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'codevis-log-rotation-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const dir = path.join(root, '.claude', 'logs');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, new Date().toISOString().slice(0, 10) + '.jsonl');
    const fd = fs.openSync(file, 'w');
    try { fs.ftruncateSync(fd, 100 * 1024 * 1024); } finally { fs.closeSync(fd); }
    const moduleUrl = pathToFileURL(path.resolve(__dirname, '../tools/lib/logger.ts')).href;
    require('node:child_process').execFileSync(process.execPath, [
        '--require', path.resolve(__dirname, '../lib/tsx-userinfo-preload.cjs'),
        '--import', pathToFileURL(require.resolve('tsx')).href, '--input-type=module', '-e',
        `import { logger } from ${JSON.stringify(moduleUrl)}; logger.info('rotation-test');`,
    ], { env: { ...process.env, CODEVIS_PROJECT_DIR: root }, timeout: 10000, stdio: 'pipe' });
    assert.equal(fs.existsSync(file + '.old'), true);
    assert.ok(fs.statSync(file).size < 1000);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).message, 'rotation-test');
});
