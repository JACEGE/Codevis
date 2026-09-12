// File-lock identity, stale recovery, and cleanup against the production runtime.
// The cross-process test pauses a stale observer before rename to expose the race.

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { mkdirSync, writeFileSync, rmSync, existsSync } = require("node:fs");
const { resolve } = require("node:path");
require("../lib/tsx-userinfo-preload.cjs");
const { register } = require("tsx/cjs/api");

const unregister = register();
after(() => unregister());

describe("file lock", () => {
    const { acquireFileLock, getFileLockPath, withFileLocks, STALE_LOCK_MS } =
        require("../tools/lib/file-ops.ts");

    const TARGET = "src/file-lock-test-target.js";
    const lockPath = getFileLockPath(TARGET);
    const clean = () => {
        rmSync(lockPath, { recursive: true, force: true });
        const fs = require('node:fs'), path = require('node:path');
        const directory = path.dirname(lockPath);
        if (!existsSync(directory)) return;
        // These belong only to this test target, after its contenders exit.
        for (const entry of fs.readdirSync(directory)) {
            if (entry.startsWith(path.basename(lockPath) + '.stale-')) rmSync(path.join(directory, entry), { recursive: true, force: true });
        }
    };

    before(clean);
    after(clean);

    it('uses distinct locks for paths that differ only by separators and underscores', async () => {
        const a = 'src/file_lock/a.js', b = 'src/file/lock_a.js';
        assert.notEqual(getFileLockPath(a), getFileLockPath(b));
        await withFileLocks([a, b], async () => {});
    });

    it('can lock deeply nested paths without exceeding the lock filename limit', async () => {
        const file = `${'nested-directory/'.repeat(24)}file.js`;
        const release = await acquireFileLock(file);
        release();
    });

    it('deduplicates directory aliases for both existing and planned files', async t => {
        const fs = require('node:fs'), path = require('node:path');
        const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'codevis-lock-alias-'));
        t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
        fs.mkdirSync(path.join(dir, 'real'));
        fs.symlinkSync(path.join(dir, 'real'), path.join(dir, 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
        for (const name of ['present.js', 'future.js']) {
            const real = path.join(dir, 'real', name), alias = path.join(dir, 'alias', name);
            if (name === 'present.js') fs.writeFileSync(real, 'content');
            assert.equal(getFileLockPath(real), getFileLockPath(alias));
            await withFileLocks([real, alias], async () => {
                await assert.rejects(acquireFileLock(alias, 20), /timeout/);
            });
        }
    });

    it('times out instead of spinning forever when a stale lock cannot be renamed', async t => {
        const fs = require('node:fs');
        mkdirSync(lockPath, { recursive: true });
        writeFileSync(resolve(lockPath, 'pid'), `999999\n${Date.now() - STALE_LOCK_MS - 60000}\nstale-token`);
        t.mock.method(fs, 'renameSync', () => { throw Object.assign(new Error('denied'), { code: 'EPERM' }); });
        try { await assert.rejects(acquireFileLock(TARGET, 20), /timeout/); }
        finally { clean(); }
    });

    it('publishes a lock only after its owner information has been written', async t => {
        const fs = require('node:fs'), path = require('node:path');
        const write = fs.writeFileSync;
        let observed = false;
        t.mock.method(fs, 'writeFileSync', (file, ...args) => {
            if (path.basename(file) === 'pid') {
                observed = true;
                assert.equal(existsSync(lockPath), false, 'a visible ownerless lock can be mistaken for a dead writer');
            }
            return write(file, ...args);
        });
        const release = await acquireFileLock(TARGET);
        release();
        assert.equal(observed, true);
    });

    for (const code of ['EPERM', 'EACCES', 'EEXIST', 'ENOTEMPTY']) {
        it(`retries ${code} when the competing lock has already disappeared`, async t => {
            const fs = require('node:fs');
            const rename = fs.renameSync;
            let attempts = 0;
            t.mock.method(fs, 'renameSync', (...args) => {
                if (++attempts === 1) throw Object.assign(new Error('temporary rename failure'), { code });
                return rename(...args);
            });
            const release = await acquireFileLock(TARGET, 200);
            try {
                assert.equal(attempts, 2);
                await assert.rejects(acquireFileLock(TARGET, 20), /timeout/);
            } finally { release(); }
        });
    }

    it('stops retrying a permanent permission failure and preserves its cause', async t => {
        const fs = require('node:fs');
        const denied = Object.assign(new Error('permanently denied'), { code: 'EACCES' });
        let attempts = 0;
        t.mock.method(fs, 'renameSync', () => { attempts++; throw denied; });
        await assert.rejects(acquireFileLock(TARGET, 20), error => error === denied);
        assert.ok(attempts >= 2);
        assert.equal(existsSync(lockPath), false);
        assert.equal(fs.readdirSync(require('node:path').dirname(lockPath)).some(name =>
            name.startsWith(require('node:path').basename(lockPath) + '.acquire-')), false);
    });

    it('the ESM MCP shutdown handler removes its own held file locks', () => {
        const path = require('node:path');
        const { pathToFileURL } = require('node:url');
        const moduleUrl = pathToFileURL(path.resolve(__dirname, '../tools/lib/file-ops.ts')).href;
        require('node:child_process').execFileSync(process.execPath, [
            '--require', path.resolve(__dirname, '../lib/tsx-userinfo-preload.cjs'), '--import', pathToFileURL(require.resolve('tsx')).href,
            '--input-type=module', '-e',
            `import { acquireFileLock, registerCleanupHandlers } from ${JSON.stringify(moduleUrl)}; registerCleanupHandlers(); await acquireFileLock(${JSON.stringify(TARGET)}); process.exit(0);`,
        ], { env: { ...process.env, CODEVIS_PROJECT_DIR: path.resolve(__dirname, '..') }, timeout: 10000 });
        assert.equal(existsSync(lockPath), false);
    });

    it('a delayed stale-lock taker cannot rename a fresh live lock', { timeout: 15000 }, async t => {
        const fs = require('node:fs');
        const path = require('node:path');
        const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'codevis-lock-race-'));
        const signal = path.join(dir, 'continue');
        mkdirSync(lockPath, { recursive: true });
        writeFileSync(resolve(lockPath, 'pid'), `999999\n${Date.now() - STALE_LOCK_MS - 60000}\nstale-token`);
        const child = require('node:child_process').fork(path.join(__dirname, 'fixtures/stale-file-lock.cjs'), [TARGET, signal], {
            env: { ...process.env, CODEVIS_PROJECT_DIR: path.resolve(__dirname, '..') }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
        });
        t.after(() => { child.kill(); clean(); fs.rmSync(dir, { recursive: true, force: true }); });
        const result = new Promise((resolveResult, reject) => {
            child.on('message', message => { if (message.state === 'finished') resolveResult(message); });
            child.on('error', reject);
            child.on('exit', code => { if (code) reject(new Error(`Child exited ${code}`)); });
        });
        await new Promise((ready, reject) => {
            child.on('message', message => { if (message.state === 'paused') ready(); });
            child.on('error', reject);
        });
        const release = await acquireFileLock(TARGET);
        try {
            writeFileSync(signal, 'go');
            const contender = await result;
            assert.equal(contender.acquired, false, 'the stale observer acquired a lock still held by this process');
            assert.match(contender.error, /timeout/);
        } finally { release(); }
    });

    it('deduplicates equivalent paths while holding every file in the set', async () => {
        await withFileLocks([TARGET, resolve(TARGET)], async () => {
            await assert.rejects(() => acquireFileLock(TARGET, 20), /timeout/);
        });
        assert.equal(existsSync(lockPath), false);
    });

    it('does not steal an old lock while its owning process is still alive', async () => {
        const release = await acquireFileLock(TARGET);
        const pidFile = resolve(lockPath, 'pid');
        const token = require('node:fs').readFileSync(pidFile, 'utf8').split('\n')[2];
        writeFileSync(pidFile, `${process.pid}\n${Date.now() - STALE_LOCK_MS - 1000}\n${token}`);
        try { await assert.rejects(() => acquireFileLock(TARGET, 20), /timeout/); }
        finally { release(); }
    });

    it("gibt nur die eigene Sperre frei, nicht die des Nachfolgers", async () => {
        const releaseA = await acquireFileLock(TARGET, 3000);

        // Was ein Übernehmer tut, der A für abgelaufen hielt: Verzeichnis
        // neu, eigener Token. Vorher löschte As Freigabe genau diese Sperre
        // mit -- ab dem Moment hielten zwei Prozesse dieselbe Datei.
        rmSync(lockPath, { recursive: true, force: true });
        mkdirSync(lockPath, { recursive: true });
        writeFileSync(resolve(lockPath, "pid"), `424242\n${Date.now()}\nfremder-token`);

        releaseA();

        assert.ok(existsSync(lockPath), "die Sperre des Nachfolgers wurde mitgeloescht");
        clean();
    });

    it("uebernimmt eine abgelaufene Sperre und haelt sie dann exklusiv", async () => {
        clean();
        mkdirSync(lockPath, { recursive: true });
        writeFileSync(
            resolve(lockPath, "pid"),
            `999999\n${Date.now() - STALE_LOCK_MS - 60_000}\nfremd`
        );

        const release = await acquireFileLock(TARGET, 3000);

        // Übernommen heißt: ab jetzt frisch. Ein zweiter Zugriff darf nicht
        // durchkommen, auch wenn die Sperre vorher abgelaufen WAR.
        await assert.rejects(
            () => acquireFileLock(TARGET, 250),
            /File lock timeout/,
            "nach der Uebernahme kam ein zweiter Halter durch"
        );

        release();
        clean();
    });

    it("eine Leiche ohne pid-Datei blockiert nicht bis zum Timeout", async () => {
        clean();
        // Ein Halter, der zwischen mkdir und dem Schreiben der pid-Datei
        // gestorben ist. Ohne Altersprüfung am Verzeichnis selbst galt das nie
        // als abgelaufen -- jeder weitere Zugriff lief in den Timeout, und zwar
        // jedes Mal aufs Neue.
        mkdirSync(lockPath, { recursive: true });
        const old = Date.now() / 1000 - (STALE_LOCK_MS / 1000) - 60;
        require("node:fs").utimesSync(lockPath, old, old);

        const release = await acquireFileLock(TARGET, 2000);
        release();
        clean();
    });
});
