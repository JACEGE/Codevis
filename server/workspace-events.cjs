'use strict';

const { publicWorkspaceName } = require('../lib/workspace-names.cjs');
const PREFIX = 'codevis:work:';

function subscribeWorkspace(socket, db) {
    const workspace = publicWorkspaceName(db);
    const room = PREFIX + workspace;
    for (const existing of socket.rooms) {
        if (existing.startsWith(PREFIX) && existing !== room) socket.leave(existing);
    }
    socket.join(room);
    return workspace;
}

function emitWorkspace(io, db, event, payload) {
    const workspace = publicWorkspaceName(db);
    io.to(PREFIX + workspace).emit(event, { ...payload, db: workspace });
}

module.exports = { subscribeWorkspace, emitWorkspace };
