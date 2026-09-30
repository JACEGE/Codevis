const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const DAEMON = path.resolve(__dirname, '../server/ladybug-daemon.cjs');

// A stale marker (its PID reused by an unrelated, younger process) used to let
// several simultaneously started daemons each delete the others' fresh marker
// and all claim the same data directory: 2–4 writers on one database.
test('only one of several simultaneously started daemons claims a stale instance marker', async t => {
    for (let round = 0; round < 2; round++) {
        const project = fs.mkdtempSync(path.join(os.tmpdir(), 'codevis-instance-race-'));
        const kids = [];
        t.after(() => {
            for (const kid of kids) { try { kid.kill('SIGKILL'); } catch { /* already gone */ } }
            fs.rmSync(project, { recursive: true, force: true });
        });
        fs.writeFileSync(path.join(project, 'codevis.config.cjs'), "module.exports={workspaces:{project_db:{sourceDir:['src']}}};");
        const marker = path.join(project, 'daemon.instance');
        fs.writeFileSync(marker, JSON.stringify({ pid: 1, startedAt: '2000-01-01T00:00:00.000Z' }));
        const base = 20000 + Math.floor(Math.random() * 20000);
        for (let i = 0; i < 4; i++) {
            kids.push(spawn(process.execPath, [DAEMON], {
                env: { ...process.env, CODEVIS_PROJECT_DIR: project, LADYBUG_INSTANCEFILE: marker, LADYBUG_DAEMON_PORT: String(base + i) },
                stdio: 'ignore',
            }));
        }
        await new Promise(resolve => setTimeout(resolve, 4000));
        const alive = kids.filter(kid => kid.exitCode === null && kid.signalCode === null);
        assert.equal(alive.length, 1, `round ${round}: ${alive.length} daemons own one data directory`);
        assert.equal(JSON.parse(fs.readFileSync(marker, 'utf8')).pid, alive[0].pid);
    }
});
