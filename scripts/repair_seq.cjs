/**
 * Repairs `seq` collisions — globally unique, one per node.
 *
 *   node scripts/repair_seq.cjs [project_db|codevis_db] [--dry]
 *   CODEVIS_PROJECT_DIR=/path/to/project node scripts/repair_seq.cjs project_db
 *
 * Wozu: `seq` ist die Zahl, auf die Ladybug `id(n)` abbildet, und der Builder
 * schreibt AST-Knoten in UNWIND-Blöcken zu je 500. `uid` kommt dabei pro Zeile
 * aus den Daten, `seq` aus dem $__seq-Sentinel — und den löst der Daemon einmal
 * pro QUERY auf. Dadurch können alle Knoten eines Blocks denselben Wert erhalten.
 *
 * Warum das reicht und kein Rebuild nötig ist: `uid` ist der Primärschlüssel
 * und war nie betroffen. Über ihn lässt sich jeder Knoten einzeln adressieren,
 * also kann `seq` nachträglich vergeben werden, ohne eine Zeile Quelltext neu
 * zu parsen. Der Wert wird zeilenweise aus den Daten gesetzt (row.seq), nicht
 * aus dem Sentinel — genau der Unterschied, der den Fehler ausmacht.
 *
 * Die Reihenfolge ist die uid-Sortierung: stabil, wiederholbar, und zwei Läufe
 * auf demselben Graphen ergeben dieselben Nummern.
 */

const path = require('path');
const ladybug = require('../server/ladybug-driver.cjs');

const BATCH = 500;

/**
 * Repairs `seq` through an open session. The builder calls this at the end of
 * every run so correctness does not depend on a separate maintenance command.
 * Existing unique values remain stable; only duplicate/null entries are moved
 * above the current maximum. Returns the number of changed nodes (0 = healthy).
 */
async function repairSeq(session, { log = console.log, intValue = ladybug.int } = {}) {
    const before = await session.run(
        `MATCH (n) RETURN count(n) AS knoten, count(DISTINCT n.seq) AS seqs`);
    const num = (v) => Number(v?.toNumber?.() ?? v);
    const knoten = num(before.records[0].get('knoten'));
    const seqs = num(before.records[0].get('seqs'));
    if (knoten === 0 || seqs === knoten) return 0;

    log(`[seq] ${seqs} distinct values for ${knoten} nodes — repairing collisions`);
    const duplicateGroups = await session.run(`
        MATCH (n)
        WITH n.seq AS seq, collect(elementId(n)) AS uids
        WHERE seq IS NULL OR size(uids) > 1
        RETURN seq, uids
    `);
    const maxResult = await session.run(`MATCH (n) RETURN max(n.seq) AS maxSeq`);
    const rawMax = maxResult.records[0]?.get('maxSeq');
    let nextSeq = num(rawMax) + 1;
    let repaired = 0;
    let pending = [];

    const flush = async () => {
        if (pending.length === 0) return;
        await session.run(
            `UNWIND $rows AS row
             MATCH (n) WHERE elementId(n) = row.uid
             SET n.seq = row.seq`,
            { rows: pending }
        );
        repaired += pending.length;
        pending = [];
    };

    for (const record of duplicateGroups.records) {
        const rawSeq = record.get('seq');
        const seq = rawSeq === null || rawSeq === undefined ? null : num(rawSeq);
        const uids = [...(record.get('uids') || [])].map(String).sort();
        // One node may keep a real duplicated value. A NULL value contributes
        // nothing to count(DISTINCT), so every NULL entry needs a number.
        const start = seq === null ? 0 : 1;
        for (let i = start; i < uids.length; i++) {
            pending.push({ uid: uids[i], seq: intValue(nextSeq++) });
            if (pending.length >= BATCH) await flush();
        }
    }
    await flush();

    const after = await session.run(`MATCH (n) RETURN count(DISTINCT n.seq) AS seqs`);
    const s2 = num(after.records[0].get('seqs'));
    if (s2 !== knoten) {
        log(`[seq] WARNING: still only ${s2} distinct values for ${knoten} nodes`);
    } else {
        log(`[seq] repaired ${repaired} collision(s); ${knoten} nodes now have ${s2} unique seq values`);
    }
    return repaired;
}

const args = process.argv.slice(2);
const workspace = args.find((a) => !a.startsWith('--')) || 'target';
const dryRun = args.includes('--dry');

async function main() {
    // Erst hier laden, nicht beim Import: der Builder zieht dieses Modul für
    // repairSeq() herein und darf nicht daran scheitern, dass in einem anderen
    // Arbeitsverzeichnis keine Config liegt.
    const projectDir = process.env.CODEVIS_PROJECT_DIR || path.resolve(__dirname, '..');
    const { withInternalWorkspaceAliases } = require('../lib/workspace-names.cjs');
    const config = withInternalWorkspaceAliases(require(path.resolve(projectDir, 'codevis.config.cjs')));
    const ws = config.workspaces?.[workspace];
    if (!ws) {
        console.error(`Kein Workspace '${workspace}' in ${projectDir}/codevis.config.cjs`);
        process.exit(1);
    }
    const dbUri = ws.dbUri || ws.neo4jUri;
    if (!dbUri) {
        console.error(`Workspace '${workspace}' hat keine dbUri in ${projectDir}/codevis.config.cjs`);
        process.exit(1);
    }
    if (!ws.auth || typeof ws.auth.user !== 'string' || typeof ws.auth.pass !== 'string') {
        console.error(`Workspace '${workspace}' hat keine vollständige auth-Konfiguration in ${projectDir}/codevis.config.cjs`);
        process.exit(1);
    }
    const auth = ws.auth;
    const driver = ladybug.driver(dbUri, ladybug.auth.basic(auth.user, auth.pass));
    const session = driver.session();

    try {
        const before = await session.run(
            `MATCH (n) RETURN count(n) AS knoten, count(DISTINCT n.seq) AS seqs`);
        const knoten = Number(before.records[0].get('knoten')?.toNumber?.() ?? before.records[0].get('knoten'));
        const seqs = Number(before.records[0].get('seqs')?.toNumber?.() ?? before.records[0].get('seqs'));
        console.log(`before: ${knoten} nodes, ${seqs} distinct seq values `
            + `(${(100 * seqs / Math.max(knoten, 1)).toFixed(1)} %)`);

        if (seqs === knoten) {
            console.log('nothing to do — seq is already unique.');
            return;
        }
        if (dryRun) {
            console.log(`--dry: would inspect ${knoten} nodes and repair only colliding seq values.`);
            return;
        }

        const changed = await repairSeq(session);
        console.log(`${changed} node(s) renumbered.`);
    } finally {
        await session.close();
        await driver.close?.();
    }
}

module.exports = { repairSeq };

if (require.main === module) {
    main().catch((err) => {
        console.error('repair_seq:', err.message);
        process.exit(1);
    });
}
