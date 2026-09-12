const fs = require('node:fs');
const publication = require('../../lib/file-publication.cjs');

module.exports = context => {
    const filesystem = { ...fs, ...context };
    return {
        ...context,
        resolvePhysicalPath: file => publication.resolvePhysicalPath(file, filesystem),
        publishStagedFile: (temporary, destination) => publication.publishStagedFile(temporary, destination, filesystem),
    };
};
