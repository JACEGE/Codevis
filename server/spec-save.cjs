'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { acquireDirectoryLock } = require('../lib/directory-lock.cjs');

// The database import is atomic, but it cannot transact with the filesystem.
// Publish the file first; compensate a rejected import using a durable backup.
async function saveSpecSource({ filePath, text, lockDirectory, importSpec }, filesystem = fs) {
    if (!filePath) return importSpec();
    filePath = filesystem.realpathSync(filePath);
    const identity = process.platform === 'win32' ? filePath.toLowerCase() : filePath;
    const lock = path.join(lockDirectory, createHash('sha256').update(identity).digest('hex') + '.lock');
    const release = await acquireDirectoryLock(lock);
    const temporary = `${filePath}.spec-save-${randomUUID()}.tmp`;
    const backup = `${filePath}.spec-save-${randomUUID()}.bak`;
    let published = false;
    let keepBackup = false;
    let original;
    try {
        original = filesystem.readFileSync(filePath, 'utf8');
        filesystem.accessSync(filePath, fs.constants.W_OK);
        const mode = filesystem.statSync(filePath).mode;
        filesystem.writeFileSync(backup, original, { encoding: 'utf8', flag: 'wx', mode });
        filesystem.writeFileSync(temporary, text, { encoding: 'utf8', flag: 'wx', mode });
        filesystem.renameSync(temporary, filePath);
        published = true;
        return await importSpec();
    } catch (error) {
        if (published) {
            try {
                if (filesystem.readFileSync(filePath, 'utf8') !== text) {
                    throw new Error('A newer file edit prevents automatic restoration.');
                }
                filesystem.renameSync(backup, filePath);
                error.fileRestored = true;
            } catch (rollbackError) {
                keepBackup = true;
                error.recoveryPath = backup;
                error.message += ` File restoration failed: ${rollbackError.message} Original saved at ${backup}`;
            }
        }
        throw error;
    } finally {
        try { filesystem.rmSync(temporary, { force: true }); } catch { /* cleanup must not mask the save result */ }
        if (!keepBackup) {
            try { filesystem.rmSync(backup, { force: true }); } catch { /* a redundant backup is safe to retain */ }
        }
        release();
    }
}

module.exports = { saveSpecSource };
