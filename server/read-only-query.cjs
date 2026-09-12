'use strict';

const { assertReadOnlyQuery } = require('./query-security.cjs');

// The caller must hold the connection's mutex for this entire operation.
// Consume rows before closing the transaction; QueryResults can be lazy.
async function runReadOnlyQuery(conn, query, params = {}) {
    assertReadOnlyQuery(query);
    await conn.query('BEGIN TRANSACTION READ ONLY');
    try {
        let result;
        if (Object.keys(params).length) {
            const prepared = await conn.prepare(query);
            if (!prepared.isSuccess()) throw new Error(prepared.getErrorMessage());
            result = await conn.execute(prepared, params);
        } else {
            result = await conn.query(query);
        }
        const columnNames = await result.getColumnNames();
        const columnTypes = await result.getColumnDataTypes();
        const rows = await result.getAll();
        await conn.query('COMMIT');
        return { rows, columnNames, columnTypes };
    } catch (error) {
        // Ladybug may already have rolled back a failed statement.
        try { await conn.query('ROLLBACK'); } catch (_) { /* transaction already ended */ }
        throw error;
    }
}

module.exports = { runReadOnlyQuery };
