'use strict';

const { normalizeWorkspaceName, publicWorkspaceName } = require('../lib/workspace-names.cjs');

const RESULT_LIMIT = 50;

function parseSearchQuery(value) {
    if (typeof value !== 'string' || !value.trim() || value.length > 200) {
        const error = new Error('Enter a name or file path between 1 and 200 characters.');
        error.status = 400;
        throw error;
    }
    return value.trim().replace(/\\/g, '/').toLowerCase();
}

async function searchNodes(session, value) {
    const query = parseSearchQuery(value);
    // Query the database, never the renderer's budgeted graph. All user text
    // stays in parameters; labels, ordering and the result bound are fixed.
    const result = await session.run(`
        MATCH (n)
        WHERE n:File OR n:Function OR n:Class OR n:Component OR n:Module
           OR n:Endpoint OR n:Task OR n:Epic OR n:Knowledge
        WITH n, coalesce(n.title, n.name, n.path, n.file, n.taskId, '') AS name,
             coalesce(n.path, n.file, n.sourcePath, '') AS file
        WHERE lower(name) CONTAINS $query OR lower(file) CONTAINS $query
        WITH n, name, file, CASE WHEN lower(name) = $query THEN 0
            WHEN lower(name) STARTS WITH $query THEN 1 ELSE 2 END AS rank
        RETURN elementId(n) AS id, labels(n) AS labels, name, file, n.startLine AS startLine
        ORDER BY rank, name, file, id LIMIT ${RESULT_LIMIT + 1}
    `, { query });
    const items = result.records.map(record => ({
        id: String(record.get('id')),
        labels: record.get('labels') || [],
        name: record.get('name'),
        file: record.get('file'),
        startLine: record.get('startLine')?.toNumber?.() ?? record.get('startLine') ?? null,
    }));
    return { items: items.slice(0, RESULT_LIMIT), hasMore: items.length > RESULT_LIMIT, limit: RESULT_LIMIT };
}

function registerNodeSearch(app, { getDriver, getActiveDb }) {
    app.get('/api/nodes/search', async (req, res) => {
        let session;
        try {
            parseSearchQuery(req.query.q);
            let db;
            try { db = normalizeWorkspaceName(req.query.db, getActiveDb()); }
            catch (error) { error.status = 400; throw error; }
            session = getDriver(db).session();
            res.json({ db: publicWorkspaceName(db), ...await searchNodes(session, req.query.q) });
        } catch (error) {
            res.status(error.status || (error.code === 'INVALID_WORKSPACE' ? 400 : 500)).json({ error: error.message });
        } finally {
            await session?.close();
        }
    });
}

module.exports = { searchNodes, parseSearchQuery, registerNodeSearch };
