'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const kinds = ['locks', 'affects', 'touched', 'knowledge', 'annotations'];
function readJournal(filename) {
    if (!fs.existsSync(filename)) return null;
    const journal = JSON.parse(fs.readFileSync(filename, 'utf8'));
    if (journal.version !== 1 || !journal.backup || kinds.some(k => !Array.isArray(journal.backup[k]))) {
        throw new Error(`Invalid rebuild recovery journal: ${filename}. Preserve it before retrying.`);
    }
    return journal;
}
function writeJournal(filename, identity, backup) {
    const previous = readJournal(filename);
    if (previous && previous.identity !== identity) throw new Error('Rebuild recovery journal belongs to different sources. Restore the previous configuration.');
    const merged = {};
    for (const kind of kinds) {
        const entries = new Map();
        for (const entry of [...(previous?.backup[kind] || []), ...(backup[kind] || [])]) {
            const key = JSON.stringify([entry.uid, entry.taskId, entry.knowledgeUid, entry.annotationId]);
            entries.set(key, entry);
        }
        merged[kind] = [...entries.values()];
    }
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    const temporary = `${filename}.${randomUUID()}.tmp`;
    const fd = fs.openSync(temporary, 'wx');
    try {
        fs.writeFileSync(fd, JSON.stringify({ version: 1, identity, backup: merged }, (_, value) =>
            value?.toNumber ? value.toNumber() : value));
        fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    fs.renameSync(temporary, filename);
    return readJournal(filename).backup;
}
module.exports = { readJournal, writeJournal };
