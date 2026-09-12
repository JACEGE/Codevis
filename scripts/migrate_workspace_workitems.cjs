#!/usr/bin/env node
'use strict';

/**
 * Copy database-local work items between CodeVis workspaces.
 *
 * Copy-first by design: source rows are never updated or deleted. A complete
 * logical JSON backup is written before the first target write. Relationships
 * are copied only when both endpoints are part of the copied work-item set;
 * code bindings must be rebuilt against code nodes in the destination graph.
 *
 * Usage:
 *   node scripts/migrate_workspace_workitems.cjs --project X --from meta --to target
 *   node scripts/migrate_workspace_workitems.cjs --project X --from meta --to target --apply
 */

const fs = require('fs');
const path = require('path');

function arg(name, fallback = null) {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 ? process.argv[i + 1] : fallback;
}

const projectRoot = path.resolve(arg('project') || process.cwd());
const from = arg('from', 'meta');
const to = arg('to', 'target');
const restorePath = arg('restore');
const apply = process.argv.includes('--apply');
const deleteSource = process.argv.includes('--delete-source');

if (!['meta', 'target'].includes(to) || (!restorePath && (!['meta', 'target'].includes(from) || from === to))) {
    throw new Error("--from and --to must be different legacy physical workspace keys: meta or target");
}

process.env.CODEVIS_PROJECT_DIR = projectRoot;

const packageRoot = path.resolve(__dirname, '..');
const ladybug = require(path.join(packageRoot, 'server/ladybug-driver.cjs'));
const { REL_TABLES } = require(path.join(packageRoot, 'scripts/ladybug_schema.cjs'));

const { withInternalWorkspaceAliases } = require('../lib/workspace-names.cjs');
const config = withInternalWorkspaceAliases(require(path.join(projectRoot, 'codevis.config.cjs')));
const workspace = (key) => {
    const publicKey = key === 'target' ? 'project' : 'codevis';
    const ws = config.workspaces?.[key] || config.workspaces?.[publicKey];
    if (!ws) throw new Error(`Workspace '${key}' is not configured in ${projectRoot}`);
    return ws;
};
const makeDriver = (key) => {
    const ws = workspace(key);
    return ladybug.driver(ws.dbUri || ws.neo4jUri, ladybug.auth.basic(ws.auth?.user || '', ws.auth?.pass || ''));
};

const WORK_LABELS = new Set(['Task', 'Epic', 'Idea', 'Knowledge']);
const relTypes = REL_TABLES.map((ddl) => /CREATE REL TABLE\s+(\w+)/i.exec(ddl)?.[1]).filter(Boolean);

function plain(value) {
    if (value == null) return value;
    if (typeof value.toNumber === 'function') return value.toNumber();
    if (Array.isArray(value)) return value.map(plain);
    if (typeof value === 'object') {
        const out = {};
        for (const [k, v] of Object.entries(value)) {
            if (!k.startsWith('_')) out[k] = plain(v);
        }
        return out;
    }
    return value;
}

function safeKeys(obj) {
    return Object.keys(obj).filter((key) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && !key.startsWith('_'));
}

async function readNodes(session) {
    const result = await session.run(`MATCH (n:CodeNode) RETURN n`);
    return result.records.map((r) => plain(r.get('n'))).filter((n) => WORK_LABELS.has(n.label));
}

async function readRelationships(session, uids) {
    const uidSet = new Set(uids);
    const edges = [];
    for (const type of relTypes) {
        try {
            const result = await session.run(
                `MATCH (a:CodeNode)-[r:${type}]->(b:CodeNode) RETURN a.uid AS source, b.uid AS target, r`
            );
            for (const row of result.records) {
                const source = row.get('source');
                const target = row.get('target');
                if (!uidSet.has(source) || !uidSet.has(target)) continue;
                edges.push({ type, source, target, properties: plain(row.get('r')) || {} });
            }
        } catch (error) {
            // Old databases may predate newer additive relationship tables.
            if (!/does not exist|not found/i.test(error.message || '')) throw error;
        }
    }
    return edges;
}

async function existingUids(session, uids) {
    if (!uids.length) return [];
    const result = await session.run(`MATCH (n:CodeNode) WHERE n.uid IN $uids RETURN n.uid AS uid`, { uids });
    return result.records.map((r) => r.get('uid'));
}

async function createNode(session, node) {
    const props = plain(node);
    const keys = safeKeys(props);
    const fields = keys.map((key) => `\`${key}\`: $${key}`).join(', ');
    await session.run(`CREATE (n:CodeNode {${fields}})`, props);
}

async function createEdge(session, edge) {
    const allProps = plain(edge.properties || {});
    // Ladybug returns the full relationship-property union, mostly null. Copy
    // only meaningful values; this also avoids reserved words such as `order`
    // entering the query unless that relationship genuinely carries one.
    const props = Object.fromEntries(Object.entries(allProps).filter(([, value]) => value != null));
    const keys = safeKeys(props);
    const fields = keys.length ? ` {${keys.map((key) => `\`${key}\`: $p_${key}`).join(', ')}}` : '';
    const params = { source: edge.source, target: edge.target };
    for (const key of keys) params[`p_${key}`] = props[key];
    await session.run(
        `MATCH (a:CodeNode {uid:$source}), (b:CodeNode {uid:$target}) MERGE (a)-[r:${edge.type}${fields}]->(b)`,
        params
    );
}

async function main() {
    if (restorePath) {
        if (!apply) throw new Error('--restore requires --apply');
        const absolute = path.resolve(restorePath);
        const backup = JSON.parse(fs.readFileSync(absolute, 'utf8'));
        const nodes = Array.isArray(backup.nodes) ? backup.nodes.filter((n) => WORK_LABELS.has(n.label)) : [];
        const relationships = Array.isArray(backup.relationships) ? backup.relationships : [];
        if (!nodes.length) throw new Error(`Backup contains no supported work items: ${absolute}`);

        const targetDriver = makeDriver(to);
        const target = targetDriver.session();
        try {
            const uids = nodes.map((n) => n.uid);
            const collisions = new Set(await existingUids(target, uids));
            for (const node of nodes) if (!collisions.has(node.uid)) await createNode(target, node);
            for (const edge of relationships) await createEdge(target, edge);

            const copied = await existingUids(target, uids);
            const copiedEdges = await readRelationships(target, uids);
            if (copied.length !== uids.length || copiedEdges.length !== relationships.length) {
                throw new Error(`Restore verification failed: nodes ${copied.length}/${uids.length}, edges ${copiedEdges.length}/${relationships.length}`);
            }
            console.log(JSON.stringify({
                status: 'RESTORED_AND_VERIFIED', backupPath: absolute, workspace: to,
                nodeCount: copied.length, edgeCount: copiedEdges.length, existingNodes: collisions.size,
            }, null, 2));
        } finally {
            await target.close();
            await targetDriver.close();
        }
        return;
    }

    const sourceDriver = makeDriver(from);
    const targetDriver = makeDriver(to);
    const source = sourceDriver.session();
    const target = targetDriver.session();
    try {
        const nodes = await readNodes(source);
        const uids = nodes.map((n) => n.uid);
        const relationships = await readRelationships(source, uids);
        const collisions = await existingUids(target, uids);
        const summary = {
            projectRoot, from, to, apply, deleteSource,
            nodes: Object.fromEntries([...WORK_LABELS].map((label) => [label, nodes.filter((n) => n.label === label).length])),
            relationships: relationships.reduce((out, edge) => ((out[edge.type] = (out[edge.type] || 0) + 1), out), {}),
            collisions,
        };
        console.log(JSON.stringify(summary, null, 2));
        const collisionSet = new Set(collisions);
        if (collisions.length && collisions.length !== nodes.length) {
            throw new Error(`Target contains only ${collisions.length}/${nodes.length} source uid(s); refusing an ambiguous partial resume.`);
        }
        if (!apply) {
            console.log('DRY RUN only. Re-run with --apply to write the backup and copy.');
            return;
        }

        const backupDir = path.join(projectRoot, '.codevis', 'migration-backups');
        fs.mkdirSync(backupDir, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const backupPath = path.join(backupDir, `${from}-to-${to}-${stamp}.json`);
        fs.writeFileSync(backupPath, JSON.stringify({ summary, nodes, relationships }, null, 2));
        console.log(`Backup: ${backupPath}`);

        for (const node of nodes) {
            if (!collisionSet.has(node.uid)) await createNode(target, node);
        }
        for (const edge of relationships) await createEdge(target, edge);

        const copiedNodes = await readNodes(target);
        const copiedUidSet = new Set(copiedNodes.map((n) => n.uid));
        const missing = uids.filter((uid) => !copiedUidSet.has(uid));
        const copiedEdges = await readRelationships(target, uids);
        if (missing.length || copiedEdges.length !== relationships.length) {
            throw new Error(`Verification failed: missing nodes=${missing.length}, expected edges=${relationships.length}, copied edges=${copiedEdges.length}`);
        }
        console.log(JSON.stringify({ status: 'COPIED_AND_VERIFIED', backupPath, nodeCount: nodes.length, edgeCount: relationships.length }, null, 2));
        if (deleteSource) {
            // Destructive phase is deliberately last: target and backup have
            // both been verified. The label allowlist prevents code nodes or
            // runtime data from being caught by a broad database cleanup.
            await source.run(
                `MATCH (n:CodeNode) WHERE n.label IN $labels DETACH DELETE n`,
                { labels: [...WORK_LABELS] }
            );
            const remaining = await readNodes(source);
            if (remaining.length) throw new Error(`Source cleanup verification failed: ${remaining.length} work item(s) remain.`);
            console.log(JSON.stringify({ status: 'SOURCE_CLEANED', workspace: from, deletedNodes: nodes.length }, null, 2));
        } else {
            console.log(`Source '${from}' was NOT modified.`);
        }
    } finally {
        await source.close();
        await target.close();
        await sourceDriver.close();
        await targetDriver.close();
    }
}

main().catch((error) => {
    console.error(error.stack || error.message || error);
    process.exitCode = 1;
});
