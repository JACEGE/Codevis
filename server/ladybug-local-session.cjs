'use strict';
const { translate } = require('./ladybug-translate.cjs');

// ladybug.int() wrappers become INT64 (BigInt), also inside UNWIND rows. Over
// HTTP the driver already sends them as {__int64}; called in-process (tests,
// daemon-local operations) the wrapper reached the engine as a STRUCT.
function plainValue(value) {
    if (value === null || typeof value !== 'object') return value;
    if (typeof value.toBigInt === 'function') return value.toBigInt();
    if (Array.isArray(value)) return value.map(plainValue);
    if (Object.getPrototypeOf(value) !== Object.prototype) return value;
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, plainValue(entry)]));
}

// Used only while the daemon owns the connection mutex. A complete operation,
// including its reads, runs in one native transaction, never across HTTP calls.
class LocalSession {
    constructor(conn, nextSeq) { this.conn = conn; this.nextSeq = nextSeq; }
    async run(cypher, params = {}) {
        const { cypher: query, injectNow, creates } = translate(cypher);
        const values = plainValue({ ...params });
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
module.exports = { LocalSession, plainValue };
