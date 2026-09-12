const assert = require("node:assert/strict");
const { after, describe, it } = require("node:test");
require("../lib/tsx-userinfo-preload.cjs");
const { register } = require("tsx/cjs/api");

// `register()` aus tsx/cjs/api hängt sich an require(), NICHT an den
// ESM-Loader. Ein `await import("…​.ts")` geht deshalb an ihm vorbei und
// scheitert unter Node 20 mit "Unknown file extension .ts" -- unter Node 22
// läuft es zufällig durch, weshalb der Fehler lokal unsichtbar war und erst in
// CI auffiel.
const unregister = register();
after(() => unregister());

describe("lock lifecycle", () => {
    const {
        DEFAULT_LOCK_TTL_MS,
        expireStaleLocks,
        lockTtlMs,
        releaseTaskLocks,
    } = require("../tools/lib/locks.ts");
    const { normalizeDepth } = require("../tools/lib/lock-depth.cjs");

    it("uses a five-minute lease and supports a short test override", () => {
        assert.equal(DEFAULT_LOCK_TTL_MS, 300_000);
        assert.equal(lockTtlMs(), 300_000);
        assert.equal(lockTtlMs(25), 25);
        assert.equal(lockTtlMs(3_600_000), 300_000);
    });

    it("expires past active and planned locks without a manual step", async () => {
        let query = "";
        const session = {
            run: async (cypher) => {
                query = cypher;
                return { records: [{ get: () => ({ toNumber: () => 2 }) }] };
            },
        };

        assert.equal(await expireStaleLocks(session), 2);
        assert.match(query, /n\.lockExpires <= timestamp\(\)/);
        assert.match(query, /n\.locked = true OR n\.lockStatus = 'planned'/);
        assert.match(query, /n\.lockGroup = null/);
    });

    it("releases every lock in the completing task group", async () => {
        const locks = [
            { lockGroup: "task-a", locked: true },
            { lockGroup: "task-a", lockStatus: "planned" },
            { lockGroup: "task-b", locked: true },
        ];
        const session = {
            run: async (_cypher, { taskId }) => {
                let released = 0;
                for (const lock of locks) {
                    if (lock.lockGroup !== taskId) continue;
                    released++;
                    for (const key of Object.keys(lock)) lock[key] = null;
                }
                return { records: [{ get: () => ({ toNumber: () => released }) }] };
            },
        };

        assert.equal(await releaseTaskLocks(session, "task-a"), 2);
        assert.equal(locks.filter((lock) => lock.lockGroup === "task-a").length, 0);
        assert.equal(locks[2].lockGroup, "task-b");
    });

    // lock_subgraph passes 0 as the fallback; this pins that a missing depth
    // means "the origin node only", not the old two-hop neighborhood.
    it("defaults neighborhood depth to zero", () => {
        assert.equal(normalizeDepth(undefined, 0), 0);
        assert.equal(normalizeDepth(0, 0), 0);
        assert.equal(normalizeDepth(1, 0), 1);
        assert.equal(normalizeDepth("nonsense", 0), 0);
    });
});
