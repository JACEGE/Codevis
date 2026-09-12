/**
 * Tests for the `codevis info` diagnosis rules (scripts/diag/doctor.cjs).
 *
 * Every rule here exists because the situation actually occurred and looked
 * identical from the outside — "daemon did not become healthy". The tests pin
 * the distinctions so the command keeps telling them apart.
 */

const test = require('node:test');
const assert = require('node:assert');
const { diagnose, render, sameDir, distributionBar, shouldUseColor } = require('../scripts/diag/doctor.cjs');

const DATA_DIR = 'C:\\Users\\j\\proj\\data';

function facts(overrides = {}) {
    return {
        projectRoot: 'C:\\Users\\j\\proj',
        workMode: 'code',
        dataDir: DATA_DIR,
        usingLegacyDataDir: false,
        configPath: 'C:\\Users\\j\\proj\\codevis.config.cjs',
        preferredPort: 7680,
        pidfile: null,
        pidAlive: false,
        platform: 'win32',
        daemons: [],
        bridge: { port: 4018, reachable: true },
        databases: [{ name: 'codevis_db', exists: true, sizeBytes: 1e6, mtime: '2026-07-25 17:00:00' }],
        quarantinedWals: [],
        build: null,
        ...overrides,
    };
}

const titles = (f) => diagnose(f).map((x) => x.title);

test('sameDir — Windows drive-letter case is the same directory', () => {
    assert.ok(sameDir('c:\\Users\\j\\proj\\data', 'C:\\Users\\j\\proj\\data', 'win32'));
    assert.ok(sameDir('C:/Users/j/proj/data/', 'C:\\Users\\j\\proj\\data', 'win32'));
    // On POSIX case is significant and must stay so.
    assert.ok(!sameDir('/home/J/data', '/home/j/data', 'linux'));
});

test('several daemons on one data dir are an error, not a warning', () => {
    const found = diagnose(facts({
        daemons: [
            { port: 7681, ok: true, pid: 1, dataDir: DATA_DIR, canQuery: true },
            { port: 7682, ok: true, pid: 2, dataDir: DATA_DIR, canQuery: false },
        ],
    }));

    const multi = found.find((f) => f.title.includes('share this data directory'));
    assert.ok(multi, 'the split-brain case must be reported');
    assert.strictEqual(multi.level, 'error');
    assert.ok(found.some((f) => f.title.includes('without the database lock')));
});

test('a lone daemon that holds the lock produces no daemon findings', () => {
    const found = titles(facts({
        daemons: [{ port: 7681, ok: true, pid: 1, dataDir: DATA_DIR, canQuery: true }],
    }));

    assert.ok(!found.some((t) => t.includes('daemons share')));
    assert.ok(!found.some((t) => t.includes('No daemon')));
});

test('a pidfile pointing at a dead process is called stale', () => {
    const found = titles(facts({
        pidfile: { pid: 999, port: 7681, dataDir: DATA_DIR },
        pidAlive: false,
        daemons: [{ port: 7681, ok: true, pid: 1, dataDir: DATA_DIR, canQuery: true }],
    }));

    assert.ok(found.includes('Stale pidfile'));
});

test('a live pidfile pointing at a lockless daemon is an error', () => {
    const found = diagnose(facts({
        pidfile: { pid: 2, port: 7682, dataDir: DATA_DIR },
        pidAlive: true,
        daemons: [
            { port: 7681, ok: true, pid: 1, dataDir: DATA_DIR, canQuery: true },
            { port: 7682, ok: true, pid: 2, dataDir: DATA_DIR, canQuery: false },
        ],
    }));

    const f = found.find((x) => x.title.includes('cannot read the database'));
    assert.ok(f, 'clients trust the pidfile — pointing it at a lockless daemon breaks every query');
    assert.strictEqual(f.level, 'error');
});

test("another project's daemon nearby is not a problem", () => {
    const found = diagnose(facts({
        daemons: [
            { port: 7681, ok: true, pid: 1, dataDir: DATA_DIR, canQuery: true },
            { port: 7683, ok: true, pid: 9, dataDir: 'D:\\other\\data', canQuery: null },
        ],
    }));

    const f = found.find((x) => x.title.includes("Another project's daemon"));
    assert.ok(f);
    assert.strictEqual(f.level, 'ok');
    assert.ok(!found.some((x) => x.title.includes('share this data directory')));
});

test('a differently spelled but identical path is only a warning', () => {
    const found = diagnose(facts({
        daemons: [{ port: 7681, ok: true, pid: 1, dataDir: 'c:\\Users\\j\\proj\\data', canQuery: true }],
    }));

    const f = found.find((x) => x.title.includes('differently spelled'));
    assert.ok(f, 'this exact mismatch made a project refuse its own daemon');
    assert.strictEqual(f.level, 'warn');
    assert.ok(!found.some((x) => x.title.includes("Another project's daemon")));
});

test('a running build is reported as context, a dead one as a warning', () => {
    const running = diagnose(facts({
        build: { pid: 5, workspace: 'meta', mode: 'full', startedAt: '2026-07-25T17:10:00Z', alive: true },
        daemons: [{ port: 7681, ok: true, pid: 1, dataDir: DATA_DIR, canQuery: true }],
    }));
    const runningFinding = running.find((f) => f.title.includes('build is running'));
    assert.ok(runningFinding);
    assert.strictEqual(runningFinding.level, 'ok');

    const dead = diagnose(facts({
        build: { pid: 5, workspace: 'meta', mode: 'full', startedAt: '2026-07-25T17:10:00Z', alive: false },
        daemons: [{ port: 7681, ok: true, pid: 1, dataDir: DATA_DIR, canQuery: true }],
    }));
    const deadFinding = dead.find((f) => f.title.includes('did not finish'));
    assert.ok(deadFinding);
    assert.strictEqual(deadFinding.level, 'warn');
});

test('quarantined WAL files are named, not just counted', () => {
    const found = diagnose(facts({
        quarantinedWals: ['ladybug-meta.wal.corrupt-1781473419174'],
        daemons: [{ port: 7681, ok: true, pid: 1, dataDir: DATA_DIR, canQuery: true }],
    }));

    const f = found.find((x) => x.title.includes('quarantined WAL'));
    assert.ok(f);
    assert.match(f.detail, /ladybug-meta\.wal\.corrupt-1781473419174/);
    assert.doesNotMatch(f.detail, /Everything written|A daemon was killed/);
});

test('recovery diagnostics include checkpoint and shadow artifacts without claiming known data loss', () => {
    const names = ['ladybug-meta.wal.corrupt-123', 'ladybug-meta.wal.checkpoint.corrupt-123', 'ladybug-meta.shadow.corrupt-123'];
    const found = diagnose(facts({ quarantinedRecoveryFiles: names, quarantinedWals: [names[0]] }));
    const warning = found.find((f) => /quarantined recovery/.test(f.title));
    assert.ok(warning);
    assert.match(warning.title, /^3 /);
    for (const name of names) assert.ok(warning.detail.includes(name));
    assert.match(warning.detail, /cannot determine/i);
});

test('an explicitly selected data directory does not suggest setting the same override again', () => {
    const found = diagnose(facts({ usingLegacyDataDir: true, explicitDataDir: true }));
    assert.ok(!found.some((f) => f.title === 'Legacy data directory in use'));
});

test('a healthy fallback port published in the pidfile is informational', () => {
    const found = diagnose(facts({
        preferredPortBlockedBy: 'port 7680 is occupied (ECONNRESET)',
        pidfile: { pid: 1, port: 7681, dataDir: DATA_DIR }, pidAlive: true,
        daemons: [{ port: 7681, ok: true, pid: 1, dataDir: DATA_DIR, canQuery: true }],
    }));
    assert.equal(found.find((f) => /Preferred port/.test(f.title)).level, 'ok');
    assert.match(found.find((f) => /Preferred port/.test(f.title)).detail, /7681/);
});

test('an unavailable preferred port still warns without a working published fallback', () => {
    const found = diagnose(facts({ preferredPortBlockedBy: 'timeout' }));
    assert.equal(found.find((f) => /Preferred port/.test(f.title)).level, 'warn');
});

test('an unverified graph with no configured sources does not prescribe a blind rebuild', () => {
    const found = diagnose(facts({ databases: [{ name: 'project_db', exists: true,
        identity: { recorded: null, expected: { sourceDirs: [] } },
    }] }));
    const warning = found.find((f) => /identity is unverified/.test(f.title));
    assert.match(warning.detail, /No source directories are configured/);
    assert.doesNotMatch(warning.detail, /Run its normal build/);
});

test('legacy storage and database identity problems are explicit', () => {
    const found = diagnose(facts({
        usingLegacyDataDir: true,
        databases: [{
            name: 'project_db', exists: true, sizeBytes: 1, mtime: 'now',
            identity: {
                mismatch: true,
                expected: { sourceDirs: ['C:/new/src'] },
                recorded: { sourceDirs: ['C:/old/src'] },
            },
        }],
    }));
    assert.ok(found.some((item) => item.title === 'Legacy data directory in use'));
    assert.ok(found.some((item) => item.level === 'error' && /different source directories/.test(item.title)));
});

test('an existing database without a marker is reported as unverified', () => {
    const found = diagnose(facts({
        databases: [{ name: 'project_db', exists: true, sizeBytes: 1, mtime: 'now', identity: { mismatch: false, recorded: null } }],
    }));
    assert.ok(found.some((item) => item.title === 'project_db identity is unverified'));
});

test('planning mode does not tell a new project to build a missing code graph', () => {
    const f = facts({
        workMode: 'planning',
        databases: [{ name: 'project_db', exists: false, sizeBytes: 0, mtime: null }],
    });
    const found = diagnose(f);
    assert.ok(found.some((item) => item.title === 'Planning mode — no code graph required'));
    assert.ok(!found.some((item) => /Run 'codevis build' to create it/.test(item.detail)));
    assert.match(render(f, found), /work mode\s+PLANNING \(code builds disabled\)/);
});

test('render — a healthy setup states the ports and says nothing is wrong', () => {
    const f = facts({ daemons: [{ port: 7681, ok: true, pid: 1, dataDir: DATA_DIR, canQuery: true }] });
    const text = render(f, diagnose(f));

    assert.match(text, /daemon :7681\s+\[ONLINE\] pid 1, holds DB lock/);
    assert.match(text, /bridge\s+\[ONLINE\] port 4018/);
    assert.match(text, /No problems found\./);
});

test('render — database labels are shown as a proportional chart', () => {
    const f = facts({
        databases: [{
            name: 'project_db', exists: true, sizeBytes: 1e6, mtime: 'now',
            counts: { Function: 100, File: 50, Class: 25 },
        }],
    });
    const text = render(f, diagnose(f), { color: false });

    assert.match(text, /Function\s+█{18}\s+100/);
    assert.match(text, /File\s+█{9}░{9}\s+50/);
    assert.doesNotMatch(text, /\u001b\[/);
});

test('colour obeys terminal conventions and never changes report content', () => {
    assert.strictEqual(shouldUseColor({ isTTY: true }, { NO_COLOR: '' }), false);
    assert.strictEqual(shouldUseColor({ isTTY: false }, { FORCE_COLOR: '1' }), true);
    assert.strictEqual(distributionBar(1, 2, 4), '██░░');

    const f = facts();
    assert.match(render(f, diagnose(f), { color: true }), /\u001b\[36m/);
});

test('render — a running build is visible without reading the findings', () => {
    const f = facts({
        build: { pid: 5, workspace: 'meta', mode: 'full', startedAt: '2026-07-25T17:10:00Z', alive: true },
        daemons: [{ port: 7681, ok: true, pid: 1, dataDir: DATA_DIR, canQuery: true }],
    });

    assert.match(render(f, diagnose(f)), /build\s+RUNNING — full build of 'meta'/);
});

test('a reachable bridge for another project is a hard workspace mismatch', () => {
    const f = facts({
        bridge: {
            port: 4018,
            reachable: true,
            projectRoot: 'C:\\Users\\j\\other',
            dataDir: 'C:\\Users\\j\\other\\.codevis',
        },
    });
    const findings = diagnose(f);
    assert.ok(findings.some((x) => x.level === 'error' && /another project/i.test(x.title)));
});
