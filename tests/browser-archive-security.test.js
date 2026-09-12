const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

// Minimal stored ZIP fixture: no archive dependency or network needed.
function zipEntry(name, content, mode) {
    const filename = Buffer.from(name), body = Buffer.from(content);
    let crc = 0xffffffff;
    for (const byte of body) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    crc = (crc ^ 0xffffffff) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(body.length, 22); local.writeUInt16LE(filename.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50); central.writeUInt16LE(0x0314, 4);
    central.writeUInt16LE(20, 6); central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20); central.writeUInt32LE(body.length, 24);
    central.writeUInt16LE(filename.length, 28); central.writeUInt32LE((mode << 16) >>> 0, 38);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
    end.writeUInt32LE(central.length + filename.length, 12);
    end.writeUInt32LE(local.length + filename.length + body.length, 16);
    return Buffer.concat([local, filename, body, central, filename, end]);
}

test('browser installer ZIP fallback rejects an escaping symlink but extracts normal files', async () => {
    // Test the installed implementation, not a copied security predicate.
    const entry = require.resolve('@puppeteer/browsers');
    const { extractZipWithYauzl } = await import(pathToFileURL(path.join(path.dirname(entry), 'fileUtil.js')).href);
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codevis-zip-security-'));
    try {
        const output = path.join(root, 'extracted');
        await fs.mkdir(output);
        const sentinel = path.join(root, 'outside.txt');
        await fs.writeFile(sentinel, 'unchanged');
        const archive = path.join(root, 'fixture.zip');
        await fs.writeFile(archive, zipEntry('escape', '../outside.txt', 0o120777));
        await assert.rejects(extractZipWithYauzl(archive, output), error => {
            assert.match(error.cause?.message || '', /outside of the target directory/);
            return true;
        });
        assert.equal(await fs.readFile(sentinel, 'utf8'), 'unchanged');
        await assert.rejects(fs.lstat(path.join(output, 'escape')), { code: 'ENOENT' });
        await fs.writeFile(archive, zipEntry('safe.txt', 'safe content', 0o100644));
        await extractZipWithYauzl(archive, output);
        assert.equal(await fs.readFile(path.join(output, 'safe.txt'), 'utf8'), 'safe content');
    } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('release dependency audit includes the development browser installer', () => {
    const manifest = require('../package.json');
    assert.match(manifest.scripts['audit:dependencies'], /^npm audit &&/);
});
