const { createHash, randomUUID } = require('node:crypto');
const { basename, resolve, relative } = require('node:path');
const { resolvePhysicalPath } = require('../../lib/file-publication.cjs');
const { canonicalize } = require('../../server/codevis-paths.cjs');

function backupOwner(agentId) {
    return 'v2-' + createHash('sha256').update(String(agentId || '')).digest('hex').slice(0, 24);
}

function backupFileIdentity(file, projectRoot, legacy = false) {
    const absolute = resolvePhysicalPath(resolve(projectRoot, file));
    const canonical = legacy ? absolute : canonicalize(absolute);
    return createHash('sha256').update(process.platform === 'win32' ? canonical.toLowerCase() : canonical).digest('hex');
}

function createBackupToken(file, agentId, projectRoot = process.cwd()) {
    const label = basename(file).replace(/[^a-zA-Z0-9.-]/g, '-').slice(-48);
    return `${Date.now()}_${backupOwner(agentId)}_${randomUUID()}_f-${backupFileIdentity(file, projectRoot)}_${label}`;
}

function backupFileMatches(token, file, projectRoot) {
    const identity = /^\d+_v2-[a-f0-9]{24}_[a-f0-9-]{36}_f-([a-f0-9]{64})_/.exec(token)?.[1];
    if (!identity) return null;
    if (identity === backupFileIdentity(file, projectRoot)) return true;
    if (process.platform !== 'win32') return false;
    // Keep pre-canonicalization backups usable after upgrading a registration
    // that still supplies an 8.3 root. Only try aliases of this same project,
    // never another environment-selected workspace with an identical basename.
    const roots = [projectRoot, process.env.CODEVIS_PROJECT_DIR].filter(Boolean);
    const expectedRoot = canonicalize(projectRoot).toLowerCase();
    const legacyFile = relative(canonicalize(projectRoot), canonicalize(resolve(projectRoot, file)));
    return roots.some(root => canonicalize(root).toLowerCase() === expectedRoot
        && identity === backupFileIdentity(legacyFile, root, true));
}

// Backups of the same file taken AFTER `token` — by any agent. Every MCP edit
// backs up the file it is about to change, so a newer backup means the file
// was edited again after the edit `token` belongs to.
function newerBackupsFor(entries, token, file, projectRoot) {
    const since = Number(String(token).split('_')[0]);
    if (!Number.isFinite(since)) return [];
    return entries
        .filter(name => name.endsWith('.bak') && name !== `${token}.bak`)
        .filter(name => Number(name.split('_')[0]) > since)
        .filter(name => backupFileMatches(name.slice(0, -'.bak'.length), file, projectRoot) === true);
}


// Backups of `file` written by `agentId`, newest first. Only tokens whose file
// identity verifies are returned; legacy tokens cannot be attributed safely.
function latestBackupsFor(entries, file, agentId, projectRoot) {
    const owner = `_${backupOwner(agentId)}_`;
    return entries
        .filter(name => name.endsWith('.bak') && name.includes(owner))
        .filter(name => backupFileMatches(name.slice(0, -'.bak'.length), file, projectRoot) === true)
        .sort((a, b) => Number(b.split('_')[0]) - Number(a.split('_')[0]));
}

module.exports = { backupOwner, createBackupToken, backupFileMatches, newerBackupsFor, latestBackupsFor };
