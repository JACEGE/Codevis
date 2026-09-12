const fs = require('node:fs');
const { resolve, dirname, basename } = require('node:path');

function resolvePhysicalPath(file, filesystem = fs) {
    let existing = resolve(file);
    const suffix = [];
    while (true) {
        try { return resolve(filesystem.realpathSync(existing), ...suffix); }
        catch (error) {
            if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error;
            let link = false;
            try { link = filesystem.lstatSync(existing).isSymbolicLink(); }
            catch (statError) { if (!['ENOENT', 'ENOTDIR'].includes(statError.code)) throw statError; }
            if (link) throw Object.assign(new Error(`Cannot edit through a dangling symbolic link: ${existing}`), { code: 'DANGLING_SYMLINK' });
            const parent = dirname(existing);
            if (parent === existing) throw error;
            suffix.unshift(basename(existing));
            existing = parent;
        }
    }
}

// Callers capture a physical destination before locking, reading and staging.
function publishStagedFile(temporary, destination, filesystem = fs) {
    const normalize = path => process.platform === 'win32' ? path.toLowerCase() : path;
    if (normalize(resolvePhysicalPath(destination, filesystem)) !== normalize(resolve(destination))) {
        throw Object.assign(new Error(`File path changed before publication: ${destination}`), { status: 'CONFLICT' });
    }
    let mode;
    try { mode = filesystem.statSync(destination).mode & 0o777; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (mode !== undefined) filesystem.chmodSync(temporary, mode);
    filesystem.renameSync(temporary, destination);
}

module.exports = { resolvePhysicalPath, publishStagedFile };
