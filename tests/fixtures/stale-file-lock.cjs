const fs = require('node:fs');
require('../../lib/tsx-userinfo-preload.cjs');
require('tsx/cjs/api').register();
const rename = fs.renameSync;
let paused = false;
fs.renameSync = (from, to) => {
    if (!paused && String(to).includes('.stale-')) {
        paused = true;
        process.send({ state: 'paused' });
        const deadline = Date.now() + 10000;
        while (!fs.existsSync(process.argv[3])) {
            if (Date.now() > deadline) throw new Error('Parent did not resume stale takeover');
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
        }
    }
    return rename(from, to);
};
const { acquireFileLock } = require('../../tools/lib/file-ops.ts');
(async () => {
    try {
        const release = await acquireFileLock(process.argv[2], 1000);
        release();
        process.send({ state: 'finished', acquired: true });
    } catch (error) {
        process.send({ state: 'finished', acquired: false, error: error.message });
    } finally { process.disconnect(); }
})();
