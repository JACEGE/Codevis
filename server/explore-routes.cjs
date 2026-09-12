'use strict';

function recordsToRows(records) {
    return records.map((record) => {
        const row = {};
        for (const key of record.keys) {
            const value = record.get(key);
            row[key] = value !== null && typeof value === 'object' && typeof value.toNumber === 'function'
                ? value.toNumber()
                : value;
        }
        return row;
    });
}

async function executeExploreQuery(driver, query) {
    const session = driver.session();
    try {
        const result = await session.runReadOnly(query);
        const rows = recordsToRows(result.records);
        return { rows, rowCount: rows.length, truncated: false, limit: null };
    } finally {
        await session.close();
    }
}

module.exports = { executeExploreQuery, recordsToRows };
