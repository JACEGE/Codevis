'use strict';

const { spawn } = require('node:child_process');

function openBrowser(url, { platform = process.platform, spawnImpl = spawn } = {}) {
    try {
        let command;
        let args;
        if (platform === 'darwin') {
            command = 'open';
            args = [url];
        } else if (platform === 'win32') {
            command = process.env.ComSpec || 'cmd.exe';
            args = ['/d', '/c', 'start', '', url];
        } else {
            command = 'xdg-open';
            args = [url];
        }
        const child = spawnImpl(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
        child.unref?.();
        return true;
    } catch (_) {
        return false;
    }
}

module.exports = { openBrowser };
