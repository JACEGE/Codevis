'use strict';

// Scan once: quotes inside comments and comment markers inside strings belong
// to their enclosing token. Successive regex replacements cannot preserve that.
function structuralTokens(query) {
    const tokens = [];
    for (let i = 0; i < query.length;) {
        const c = query[i];
        if (/\s/.test(c)) { i++; continue; }
        if (query.startsWith('//', i)) {
            while (i < query.length && !/[\r\n]/.test(query[i])) i++;
        } else if (query.startsWith('/*', i)) {
            const end = query.indexOf('*/', i + 2);
            if (end < 0) throw new Error('Unterminated comment');
            i = end + 2;
        } else if (c === "'" || c === '"' || c === '`') {
            const quote = c;
            let closed = false;
            for (i++; i < query.length; i++) {
                if (query[i] === '\\' && quote !== '`') { i++; continue; }
                if (query[i] !== quote) continue;
                if (query[i + 1] === quote) { i++; continue; }
                i++; closed = true; break;
            }
            if (!closed) throw new Error('Unterminated quoted token');
            tokens.push(quote === '`' ? '<identifier>' : '<literal>');
        } else if (/[A-Za-z_]/.test(c)) {
            const start = i++;
            while (i < query.length && /[A-Za-z0-9_]/.test(query[i])) i++;
            tokens.push(query.slice(start, i).toUpperCase());
        } else {
            tokens.push(c); i++;
        }
    }
    return tokens;
}

const MUTATIONS = new Set(('CREATE MERGE SET DELETE DETACH REMOVE DROP ALTER RENAME ' +
    'COPY IMPORT EXPORT LOAD INSTALL UNINSTALL ATTACH USE BEGIN COMMIT ROLLBACK CHECKPOINT').split(' '));
const READ_PROCEDURES = new Set([
    'DB.LABELS', 'DB.RELATIONSHIPTYPES', 'DB.PROPERTYKEYS',
    'SHOW_TABLES', 'TABLE_INFO', 'SHOW_CONNECTION', 'SHOW_FUNCTIONS', 'CURRENT_SETTING',
]);

function isWriteQuery(cypher) {
    if (typeof cypher !== 'string') return true;
    let tokens;
    try { tokens = structuralTokens(cypher); } catch (_) { return true; }
    if (tokens.at(-1) === ';') tokens.pop();
    if (!tokens.length || tokens.includes(';')) return true;
    if (!['MATCH', 'OPTIONAL', 'WITH', 'RETURN', 'UNWIND', 'CALL', 'EXPLAIN', 'PROFILE'].includes(tokens[0])) return true;
    for (let i = 0; i < tokens.length; i++) {
        if (MUTATIONS.has(tokens[i])) return true;
        if (tokens[i] === 'CALL') {
            let end = i + 1;
            while (end < tokens.length && tokens[end] !== '(') end++;
            if (!READ_PROCEDURES.has(tokens.slice(i + 1, end).join(''))) return true;
        }
    }
    return false;
}

function assertReadOnlyQuery(query) {
    if (isWriteQuery(query)) throw new Error('Only a single read-only query with approved read procedures is allowed.');
}

module.exports = { isWriteQuery, assertReadOnlyQuery };
