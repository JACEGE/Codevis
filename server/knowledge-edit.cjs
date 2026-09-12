'use strict';

function fail(status, message) {
    throw Object.assign(new Error(message), { status });
}

// Names are a compatibility lookup, never a write identity.
async function resolveEditableKnowledge(session, { nodeId, name }) {
    if (nodeId != null && (typeof nodeId !== 'string' || !nodeId)) fail(400, 'nodeId must be a non-empty string');
    if ((typeof nodeId !== 'string' || !nodeId) && (typeof name !== 'string' || !name)) {
        fail(400, 'nodeId and content are required');
    }
    const found = await session.run(
        `MATCH (k:Knowledge) WHERE ${nodeId ? 'elementId(k) = $identity' : 'k.name = $identity'}
         RETURN elementId(k) AS id, k.name AS name, k.kind AS kind, k.sourcePath AS sourcePath`,
        { identity: nodeId || name },
    );
    if (!found.records.length) fail(404, 'Knowledge node not found');
    if (found.records.length !== 1) fail(409, 'Knowledge name is ambiguous; supply the exact nodeId');
    const row = found.records[0];
    if (row.get('kind') === 'markdown') {
        fail(409, `This Knowledge is managed by Markdown. Edit ${row.get('sourcePath') || 'the source file'} and synchronize the graph.`);
    }
    return { nodeId: row.get('id'), name: row.get('name') };
}

async function updateKnowledge(session, { nodeId, name, content, category }) {
    if (typeof content !== 'string') fail(400, 'content must be a string');
    const node = await resolveEditableKnowledge(session, { nodeId, name });
    const result = await session.run(
        `MATCH (k:Knowledge) WHERE elementId(k) = $nodeId AND (k.kind IS NULL OR k.kind <> 'markdown')
         SET k.content = $content, k.category = COALESCE($category, k.category), k.updatedAt = timestamp()
         RETURN elementId(k) AS nodeId, k.name AS name, k.content AS content, k.category AS category`,
        { nodeId: node.nodeId, content, category: category || null },
    );
    if (!result.records.length) fail(409, 'Knowledge changed while saving; reload it before editing');
    const saved = result.records[0];
    return Object.fromEntries(['nodeId', 'name', 'content', 'category'].map(key => [key, saved.get(key)]));
}

module.exports = { updateKnowledge, resolveEditableKnowledge };
