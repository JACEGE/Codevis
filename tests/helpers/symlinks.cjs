'use strict';
/**
 * Tests that create FILE symlinks cannot run on Windows without Developer Mode
 * or admin rights: fs.symlinkSync fails with EPERM. They failed on every run,
 * so a real regression hid among 18 permanent failures. Probe once and skip
 * them with the reason instead. Directory junctions need no privilege and are
 * not affected.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function fileSymlinksSupported() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codevis-symlink-probe-'));
    try {
        fs.writeFileSync(path.join(dir, 'target'), '');
        fs.symlinkSync(path.join(dir, 'target'), path.join(dir, 'link'), 'file');
        return true;
    } catch (error) {
        if (error.code === 'EPERM') return false;
        throw error;
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

/** `{ skip: SKIP_WITHOUT_FILE_SYMLINKS }` — false where file symlinks work, else the reason. */
const SKIP_WITHOUT_FILE_SYMLINKS = fileSymlinksSupported()
    ? false
    : 'file symlinks need Windows Developer Mode or admin rights (EPERM)';

module.exports = { SKIP_WITHOUT_FILE_SYMLINKS };
