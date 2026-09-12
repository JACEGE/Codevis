const { createHash, randomUUID } = require('node:crypto');
const { basename, resolve } = require('node:path');
const { resolvePhysicalPath } = require('../../lib/file-publication.cjs');

function backupOwner(agentId) {
    return 'v2-' + createHash('sha256').update(String(agentId || '')).digest('hex').slice(0, 24);
}

function backupFileIdentity(file, projectRoot) {
    const absolute = resolvePhysicalPath(resolve(projectRoot, file));
    return createHash('sha256').update(process.platform === 'win32' ? absolute.toLowerCase() : absolute).digest('hex');
}

function createBackupToken(file, agentId, projectRoot = process.cwd()) {
    const label = basename(file).replace(/[^a-zA-Z0-9.-]/g, '-').slice(-48);
    return `${Date.now()}_${backupOwner(agentId)}_${randomUUID()}_f-${backupFileIdentity(file, projectRoot)}_${label}`;
}

function backupFileMatches(token, file, projectRoot) {
    const identity = /^\d+_v2-[a-f0-9]{24}_[a-f0-9-]{36}_f-([a-f0-9]{64})_/.exec(token)?.[1];
    return identity ? identity === backupFileIdentity(file, projectRoot) : null;
}

module.exports = { backupOwner, createBackupToken, backupFileMatches };
