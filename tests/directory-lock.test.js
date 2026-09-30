const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { acquireDirectoryLock } = require('../lib/directory-lock.cjs');

function lockOwnedBy(dir, pid, since) {
    const lock = path.join(dir, 'edit.lock');
    fs.mkdirSync(lock);
    fs.writeFileSync(path.join(lock, 'pid'), `${pid}\n${since}\nold-token`);
    return lock;
}

// After a crash the owner's PID can be reused by an unrelated, younger process.
// A live PID used to count as "still held" forever, so every later acquire
// timed out.
test('a lock whose PID now belongs to a younger process is reclaimed', async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codevis-dirlock-'));
    const younger = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { stdio: 'ignore' });
    t.after(() => { younger.kill('SIGKILL'); fs.rmSync(dir, { recursive: true, force: true }); });
    await new Promise(resolve => setTimeout(resolve, 200));
    const lock = lockOwnedBy(dir, younger.pid, Date.now() - 3600000);
    const release = await acquireDirectoryLock(lock, 3000);
    assert.equal(typeof release, 'function');
    release();
});

test('a lock held by a live process that is older than the lock is respected', async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codevis-dirlock-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const lock = lockOwnedBy(dir, process.pid, Date.now());
    await assert.rejects(acquireDirectoryLock(lock, 500));
});
