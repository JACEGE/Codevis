const fs = require('node:fs');
const { dirname, resolve } = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const STALE_LOCK_MS = 30000;
// Keep a nonempty tombstone for each reclaimed directory identity. Competing
// stale observers must rename to the SAME destination: once one succeeds,
// another cannot rename a newly created lock over the nonempty tombstone.
// Removing tombstones while editors are running would reintroduce that race.
function takeOverStaleLock(lockPath, identity) {
    const grave = lockPath + '.stale-' + identity;
    try {
        fs.writeFileSync(resolve(lockPath, 'reclaimed'), identity, { flag: 'wx' });
    }
    catch (error) {
        if (error.code !== 'EEXIST')
            return false;
    }
    try {
        fs.renameSync(lockPath, grave);
        return true;
    }
    catch {
        return false;
    }
}
function staleLockIdentity(lockPath) {
    try {
        // Capture the directory generation before reading its owner. Birth time
        // and inode stay stable when a PID file is written or its mtime changes.
        const stat = fs.statSync(lockPath, { bigint: true });
        const pidFile = resolve(lockPath, 'pid');
        if (fs.existsSync(pidFile)) {
            const [pid, timestamp] = fs.readFileSync(pidFile, 'utf-8').split('\n');
            const lockTime = Number(timestamp);
            try {
                process.kill(Number(pid), 0);
                return null;
            }
            catch (error) {
                if (error.code !== 'ESRCH')
                    return null;
            }
            if (!Number.isFinite(lockTime) || Date.now() - lockTime <= STALE_LOCK_MS)
                return null;
        }
        else if (Date.now() - Number(stat.mtimeMs) <= STALE_LOCK_MS)
            return null;
        return createHash('sha256').update(stat.dev + ':' + stat.ino + ':' + stat.birthtimeNs).digest('hex');
    }
    catch {
        return null;
    }
}
async function acquireDirectoryLock(lockPath, maxWaitMs = 5000) {
    lockPath = resolve(lockPath);
    fs.mkdirSync(dirname(lockPath), { recursive: true });
    const startTime = Date.now();
    let delay = 10;
    const token = randomUUID();
    const candidate = lockPath + '.acquire-' + token;
    try {
        // Publish a complete directory atomically. A suspended writer must not
        // leave a visible lock without a PID that another process can reclaim.
        fs.mkdirSync(candidate);
        fs.writeFileSync(resolve(candidate, 'pid'), `${process.pid}\n${Date.now()}\n${token}`);
        while (true) {
            try {
                if (fs.existsSync(lockPath)) throw Object.assign(new Error('Lock exists'), { code: 'EEXIST' });
                fs.renameSync(candidate, lockPath);
                return () => {
                    try {
                        const held = fs.readFileSync(resolve(lockPath, 'pid'), 'utf-8').split('\n')[2];
                        if (held === token) fs.rmSync(lockPath, { recursive: true, force: true });
                    } catch { /* already released or no longer owned */ }
                };
            } catch (error) {
                // Windows and POSIX report different errors for a directory
                // rename whose destination is already owned by another writer.
                if (!['EEXIST', 'ENOTEMPTY', 'EPERM', 'EACCES'].includes(error.code)) throw error;
                const staleIdentity = staleLockIdentity(lockPath);
                if (staleIdentity && takeOverStaleLock(lockPath, staleIdentity)) continue;
                // The competing owner may release between rename and this
                // check; Windows can also briefly deny reusing a renamed path.
                // Retry within the same deadline even when no owner remains.
                if (Date.now() - startTime > maxWaitMs) {
                    if (!fs.existsSync(lockPath)) throw error;
                    throw new Error(`File lock timeout after ${maxWaitMs}ms for ${lockPath}`);
                }
                await new Promise(r => setTimeout(r, delay));
                delay = Math.min(delay * 2, 500);
            }
        }
    } finally {
        try { fs.rmSync(candidate, { recursive: true, force: true }); } catch { /* uncommitted candidate only */ }
    }
}
module.exports = { acquireDirectoryLock, STALE_LOCK_MS };
