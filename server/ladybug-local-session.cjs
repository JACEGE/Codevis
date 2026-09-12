'use strict';
const { translate } = require('./ladybug-translate.cjs');

// Used only while the daemon owns the connection mutex. A complete operation,
// including its reads, runs in one native transaction, never across HTTP calls.
class LocalSession {
    constructor(conn, nextSeq) { this.conn = conn; this.nextSeq = nextSeq; }
    async run(cypher, params = {}) {
        const { cypher: query, injectNow, creates } = translate(cypher);
        const values = { ...params };
        if (injectNow && !('__now' in values)) values.__now = Date.now();
        for (const create of creates || []) {
            const seq = await this.nextSeq();
            if (create.seqParam) values[create.seqParam] = seq;
            if (create.uidParam) values[create.uidParam] = create.prefix + seq;
        }
        const prepared = await this.conn.prepare(query);
        if (!prepared.isSuccess()) throw new Error(prepared.getErrorMessage());
        const result = await this.conn.execute(prepared, values);
        const rows = await result.getAll();
        return { records: rows.map(row => ({ get: key => row[key], keys: Object.keys(row) })) };
    }
    async withTransaction(operation) {
        await this.conn.query('BEGIN TRANSACTION');
        try {
            const result = await operation(this);
            await this.conn.query('COMMIT');
            return result;
        } catch (error) {
            try { await this.conn.query('ROLLBACK'); } catch { /* engine already rolled back */ }
            throw error;
        }
    }
}
module.exports = { LocalSession };
