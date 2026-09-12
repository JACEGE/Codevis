'use strict';

const fs = require('fs');
const path = require('path');

const slash = (value) => value.replace(/\\/g, '/');
const list = (value) => Array.isArray(value) ? value : value == null ? [] : [value];

function scalar(raw) {
    const value = raw.trim();
    if (value.startsWith('[') && value.endsWith(']')) {
        return value.slice(1, -1).split(',').map((x) => x.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
    }
    return value.replace(/^['"]|['"]$/g, '');
}

function parseFrontmatter(text, sourcePath = '') {
    const normalized = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
    if (!normalized.startsWith('---\n')) return { data: {}, body: normalized, sourcePath };
    const closing = /\n---(?:\n|$)/g;
    closing.lastIndex = 4;
    const match = closing.exec(normalized);
    if (!match) throw new Error(`${sourcePath}: unclosed YAML frontmatter`);
    const end = match.index;
    const data = {};
    let activeList = null;
    for (const line of normalized.slice(4, end).split('\n')) {
        const item = /^\s*-\s+(.+)$/.exec(line);
        if (item && activeList) { data[activeList].push(scalar(item[1])); continue; }
        const field = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(line);
        if (!field) continue;
        const [, key, raw] = field;
        if (!raw.trim()) { data[key] = []; activeList = key; }
        else { data[key] = scalar(raw); activeList = null; }
    }
    return { data, body: normalized.slice(closing.lastIndex), sourcePath };
}

function markdownFiles(root) {
    if (fs.statSync(root).isFile()) return root.toLowerCase().endsWith('.md') ? [root] : [];
    const out = [];
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (entry.name.startsWith('.')) continue;
        const absolute = path.join(root, entry.name);
        if (entry.isDirectory()) out.push(...markdownFiles(absolute));
        else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) out.push(absolute);
    }
    return out;
}

function loadKnowledgeDocs(projectRoot, configuredPaths) {
    const docs = [];
    const seen = new Set();
    for (const configured of list(configuredPaths)) {
        const root = path.resolve(projectRoot, configured);
        for (const absolute of markdownFiles(root)) {
            const real = fs.realpathSync(absolute);
            const identity = process.platform === 'win32' ? real.toLowerCase() : real;
            if (seen.has(identity)) continue;
            seen.add(identity);
            const sourcePath = slash(path.relative(projectRoot, absolute));
            const parsed = parseFrontmatter(fs.readFileSync(absolute, 'utf8'), sourcePath);
            const id = String(parsed.data.id || '').trim();
            if (!id) throw new Error(`${sourcePath}: Knowledge Markdown needs a stable frontmatter "id"`);
            const heading = /^#\s+(.+)$/m.exec(parsed.body)?.[1]?.trim();
            docs.push({
                id, uid: `knowledge-doc:${id}`,
                title: String(parsed.data.title || heading || id),
                category: String(parsed.data.category || 'general'),
                tags: list(parsed.data.tags).map(String),
                appliesTo: list(parsed.data.appliesTo).map(String),
                tasks: list(parsed.data.tasks).map(String),
                references: [...list(parsed.data.references).map(String), ...[...parsed.body.matchAll(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g)].map((m) => m[1].trim())],
                content: parsed.body.trim(), sourcePath,
            });
        }
    }
    const duplicate = docs.find((doc, i) => docs.findIndex((x) => x.id === doc.id) !== i);
    if (duplicate) throw new Error(`Duplicate Knowledge Markdown id '${duplicate.id}' (${duplicate.sourcePath})`);
    return docs;
}

async function syncKnowledgeMarkdown(session, projectRoot, config, { log = console.log, warn = console.warn } = {}) {
    const configured = config.knowledge?.paths || [];
    if (!configured.length) return { documents: 0, links: 0, unresolved: [] };
    const docs = loadKnowledgeDocs(projectRoot, configured);
    const result = typeof session.syncKnowledgeAtomic === 'function'
        ? await session.syncKnowledgeAtomic(docs)
        : await syncKnowledgeDocuments(session, docs);
    log(`[knowledge] synchronized ${result.documents} Markdown document(s), ${result.links} link(s).`);
    for (const item of result.unresolved) warn(`[knowledge] unresolved: ${item}`);
    return result;
}

async function syncKnowledgeDocuments(session, documents) {
    if (!Array.isArray(documents)) throw new Error('Knowledge documents must be an array');
    const seen = new Set();
    const docs = documents.map(doc => {
        if (!doc || typeof doc.id !== 'string' || !doc.id.trim() || seen.has(doc.id)
            || ['title', 'category', 'content', 'sourcePath'].some(key => typeof doc[key] !== 'string')
            || ['tags', 'appliesTo', 'tasks', 'references'].some(key => !Array.isArray(doc[key]) || doc[key].some(value => typeof value !== 'string'))) {
            throw new Error('Invalid or duplicate Knowledge document');
        }
        seen.add(doc.id);
        return { ...doc, uid: `knowledge-doc:${doc.id}` };
    });
    if (typeof session.withTransaction !== 'function') throw new Error('Markdown synchronization requires an atomic database session');
    return session.withTransaction(tx => replaceKnowledgeDocuments(tx, docs));
}

async function replaceKnowledgeDocuments(session, docs) {
    const old = await session.run(`MATCH (k:Knowledge) WHERE k.kind = 'markdown' RETURN elementId(k) AS uid, k.docId AS docId`);
    // Older CREATE translation replaced the explicit uid with a sequence ID.
    // Primary keys are immutable. Keep the existing node via its document ID,
    // so incoming authored links survive and its elementId stays stable too.
    for (const doc of docs) {
        const matches = old.records.filter(row => row.get('docId') === doc.id);
        if (matches.length > 1) throw new Error(`Duplicate stored Knowledge Markdown id '${doc.id}'`);
        if (matches.length) doc.uid = matches[0].get('uid');
    }
    const ids = new Set(docs.map((d) => d.uid));
    for (const row of old.records) {
        const uid = row.get('uid');
        if (!ids.has(uid)) await session.run(`MATCH (k {uid:$uid}) DETACH DELETE k`, { uid });
    }

    for (const doc of docs) {
        const found = await session.run(`MATCH (k {uid:$uid}) RETURN k.uid AS uid`, { uid: doc.uid });
        if (!found.records.length) {
            await session.run(`MERGE (k:Knowledge {uid:$uid}) ON CREATE SET k.name=$name, k.content=$content, k.category=$category, k.kind='markdown', k.docId=$docId, k.sourcePath=$sourcePath, k.tags=$tags, k.createdAt=timestamp(), k.updatedAt=timestamp()`, { ...doc, name: doc.title, docId: doc.id });
        } else {
            await session.run(`MATCH (k {uid:$uid}) SET k.label='Knowledge', k.name=$name, k.content=$content, k.category=$category, k.kind='markdown', k.docId=$docId, k.sourcePath=$sourcePath, k.tags=$tags, k.updatedAt=timestamp()`, { ...doc, name: doc.title, docId: doc.id });
        }
        // Markdown is authoritative for its outgoing links.
        await session.run(`MATCH (k {uid:$uid})-[r:APPLIES_TO]->() DELETE r`, { uid: doc.uid });
        await session.run(`MATCH (k {uid:$uid})-[r:REFERENCES]->() DELETE r`, { uid: doc.uid });
    }

    const byId = new Map(docs.map(doc => [doc.id, doc]));
    const byTitle = new Map();
    for (const doc of docs) {
        byTitle.set(doc.title, byTitle.has(doc.title) ? null : doc);
    }
    let links = 0;
    const unresolved = [];
    const count = (result) => result.records[0]?.get('c')?.toNumber?.() || Number(result.records[0]?.get('c') || 0);
    for (const doc of docs) {
        for (const target of doc.appliesTo) {
            const [file, symbol] = slash(target).split('#');
            const result = symbol
                ? await session.run(`MATCH (k {uid:$uid}), (n {file:$file, name:$symbol}) WHERE n:Function OR n:Class OR n:Component MERGE (k)-[:APPLIES_TO]->(n) RETURN count(n) AS c`, { uid: doc.uid, file, symbol })
                : await session.run(`MATCH (k {uid:$uid}), (n:File {path:$file}) MERGE (k)-[:APPLIES_TO]->(n) RETURN count(n) AS c`, { uid: doc.uid, file });
            const n = count(result); links += n; if (!n) unresolved.push(`${doc.sourcePath}: appliesTo '${target}'`);
        }
        for (const taskId of doc.tasks) {
            const result = await session.run(`MATCH (k {uid:$uid}), (t:Task {taskId:$taskId}) MERGE (k)-[:APPLIES_TO]->(t) RETURN count(t) AS c`, { uid: doc.uid, taskId });
            const n = count(result); links += n; if (!n) unresolved.push(`${doc.sourcePath}: task '${taskId}'`);
        }
        for (const ref of new Set(doc.references)) {
            // Exact document IDs win over titles; repeated titles are ambiguous.
            const target = byId.get(ref) || byTitle.get(ref);
            if (!target) { unresolved.push(`${doc.sourcePath}: reference '[[${ref}]]'`); continue; }
            await session.run(`MATCH (a {uid:$from}), (b {uid:$to}) MERGE (a)-[:REFERENCES]->(b)`, { from: doc.uid, to: target.uid });
            links++;
        }
    }
    return { documents: docs.length, links, unresolved };
}

module.exports = { parseFrontmatter, loadKnowledgeDocs, syncKnowledgeMarkdown, syncKnowledgeDocuments };
