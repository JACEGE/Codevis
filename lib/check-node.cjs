'use strict';

function supportedNode(version) {
    const [major, minor] = version.split('.').map(Number);
    return major > 22 || (major === 22 && minor >= 12);
}

if (require.main === module && !supportedNode(process.versions.node)) {
    console.error(`CodeVis needs Node >=22.12.0 (found ${process.version}). Upgrade Node and retry.`);
    process.exitCode = 1;
}

module.exports = { supportedNode };
