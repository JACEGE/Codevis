/**
 * Invariant audit for a running bridge.
 *
 *   node scripts/audit_graph_invariants.mjs [--port <bridge-port>] [--db project_db]
 *
 * Every check names a number the system SHOULD produce and compares it to what
 * it does produce. That is the entire point: the bugs this project has actually
 * had did not throw, crash, or fail a build. They returned an answer that was
 * smaller than the truth, and nothing on screen said so.
 *
 * Exit code 1 if any invariant is violated, so it can gate a build.
 */

const args = process.argv.slice(2);
const { createRequire } = await import('node:module');
const require = createRequire(import.meta.url);
const { BRIDGE_PORT } = require('../server/codevis-paths.cjs');
const argOf = (name, fallback) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const PORT = argOf('port', String(BRIDGE_PORT));
const DB = argOf('db', 'project_db');
const BASE = `http://localhost:${PORT}`;

let failures = 0;
const ok = (msg) => console.log(`  ok    ${msg}`);
const fail = (msg) => { failures++; console.log(`  FAIL  ${msg}`); };
const info = (msg) => console.log(`        ${msg}`);

async function q(query) {
    const r = await fetch(`${BASE}/api/graph/query`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, db: DB }),
    });
    const b = await r.json();
    if (!r.ok) throw new Error(b.error);
    return b.rows || [];
}

console.log(`\nGraph-Invarianten · ${BASE} · db=${DB}\n`);

// ── 1. Node identity ────────────────────────────────────────────────────
console.log('Knotenidentität');
const idRow = (await q(`MATCH (n) RETURN count(n) AS nodes,
    count(DISTINCT n.seq) AS bySeq, count(DISTINCT n.uid) AS byUid`))[0];
if (idRow.byUid === idRow.nodes) ok(`uid ist eindeutig (${idRow.byUid}/${idRow.nodes})`);
else fail(`uid NICHT eindeutig: ${idRow.byUid} Werte für ${idRow.nodes} Knoten`);

if (idRow.bySeq < idRow.nodes) {
    fail(`seq kollidiert: ${idRow.bySeq} Werte für ${idRow.nodes} Knoten `
        + `(${(100 * idRow.bySeq / idRow.nodes).toFixed(1)} %)`);
    info(`Der Builder schreibt AST-Knoten in UNWIND-Blöcken, deren $__seq-Sentinel `
        + `einmal pro Query aufgelöst wird. Reparieren mit:`);
    info(`  node scripts/repair_seq.cjs ${DB}`);
} else {
    ok(`seq ist eindeutig (${idRow.bySeq}/${idRow.nodes}) — id() adressiert jeden Knoten einzeln`);
}

// ── 2. Nothing in the bridge may key on id() ────────────────────────────
console.log('\nQuellcode');
const fs = await import('node:fs');
const bridgeSrc = fs.readFileSync(new URL('../server/bridge.js', import.meta.url), 'utf8');
const idUses = bridgeSrc.split('\n')
    .map((line, i) => ({ line: line.trim(), n: i + 1 }))
    .filter(({ line }) => /\bid\((?:n|a|b|node|child|parent|start)\)/.test(line))
    .filter(({ line }) => !line.startsWith('//') && !line.startsWith('*') && !line.includes('elementId'));
if (idUses.length === 0) ok('server/bridge.js adressiert nirgends über id()');
else {
    fail(`${idUses.length} id()-Verwendung(en) in server/bridge.js`);
    for (const u of idUses.slice(0, 8)) info(`Zeile ${u.n}: ${u.line.slice(0, 90)}`);
}

// ── 3. Every node type must be addressable ──────────────────────────────
console.log('\nErreichbarkeit über die API');
const sample = await q(`MATCH (n) WHERE n.file IS NOT NULL OR n.path IS NOT NULL
    RETURN elementId(n) AS uid, labels(n)[0] AS type, n.name AS name LIMIT 40`);
const perType = new Map();
for (const s of sample) if (!perType.has(s.type)) perType.set(s.type, s);
let resolved = 0;
for (const [type, s] of perType) {
    const r = await fetch(`${BASE}/api/node/detail?nodeId=${encodeURIComponent(s.uid)}&db=${DB}`);
    const d = await r.json().catch(() => ({}));
    const got = d.node || d;
    if (r.ok && String(got.id) === s.uid) resolved++;
    else fail(`${type}: /api/node/detail liefert nicht den angefragten Knoten (HTTP ${r.status})`);
}
if (resolved === perType.size) ok(`/api/node/detail löst alle ${resolved} geprüften Typen exakt auf`);

// ── 4. A query result must arrive complete ──────────────────────────────
console.log('\nQuery → Subgraph');
const dirRow = (await q(`MATCH (n) WHERE n.file IS NOT NULL
    RETURN n.file AS file LIMIT 1`))[0];
const dir = String(dirRow?.file || '').split('/')[0];
if (dir) {
    const rows = await q(`MATCH (n) WHERE n.file STARTS WITH '${dir}/' OR n.path STARTS WITH '${dir}/'
        RETURN elementId(n) AS uid`);
    const uids = [...new Set(rows.map((r) => r.uid))];
    const sg = await (await fetch(`${BASE}/api/graph/subgraph`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ipv6s: [], uids, db: DB, expand: 0 }),
    })).json();
    if (sg.nodes.length === uids.length) ok(`${dir}/: ${uids.length} Treffer → ${sg.nodes.length} Knoten, vollständig`);
    else fail(`${dir}/: ${uids.length} Treffer → nur ${sg.nodes.length} Knoten (${uids.length - sg.nodes.length} fehlen)`);

    const drawn = new Set(sg.nodes.map((n) => n.id));
    const dangling = sg.links.filter((l) => !drawn.has(l.source) || !drawn.has(l.target)).length;
    if (dangling === 0) ok(`${sg.links.length} Kanten, keine mit unbekanntem Endpunkt`);
    else fail(`${dangling} Kanten zeigen auf Knoten, die nicht geliefert wurden`);

    const foreign = sg.nodes.filter((n) => {
        const f = n.file || n.path;
        return f && !String(f).startsWith(`${dir}/`);
    }).length;
    if (foreign === 0) ok('keine Fremdknoten im Ergebnis');
    else fail(`${foreign} Knoten stammen aus anderen Verzeichnissen als angefragt`);
}

// ── 5. Silent caps ──────────────────────────────────────────────────────
console.log('\nStille Deckel');
const bigRow = (await q(`MATCH (p)-[:CONTAINS_AST|DECLARES|CONTAINS_FLOW|CONTAINS_STMT]->(c)
    WITH p, count(c) AS kids ORDER BY kids DESC LIMIT 1
    RETURN elementId(p) AS uid, kids`))[0];
if (bigRow) {
    const e = await (await fetch(
        `${BASE}/api/expand-ast?nodeId=${encodeURIComponent(bigRow.uid)}&includeAst=1&db=${DB}`)).json();
    const got = e.nodes?.length ?? 0;
    if (got >= bigRow.kids) ok(`expand-ast liefert alle ${got} Kinder des größten Knotens`);
    else fail(`expand-ast: ${bigRow.kids} Kinder in der DB, ${got} geliefert — stiller Deckel`);
}

console.log(`\n${failures === 0 ? 'Alle Invarianten halten.' : `${failures} verletzte Invariante(n).`}\n`);
process.exit(failures === 0 ? 0 : 1);
