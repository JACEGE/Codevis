'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');

/** WSL has no Linux browser and usually no xdg-open; the Windows one is reachable. */
function isWsl(env = process.env) {
    if (env.WSL_DISTRO_NAME || env.WSL_INTEROP) return true;
    try { return /microsoft/i.test(fs.readFileSync('/proc/version', 'utf8')); } catch { return false; }
}

function browserCommand(url, platform, wsl) {
    if (platform === 'darwin') return { command: 'open', args: [url] };
    if (platform === 'win32') return { command: process.env.ComSpec || 'cmd.exe', args: ['/d', '/c', 'start', '', url] };
    // cwd on a Windows drive: cmd.exe refuses a \\wsl.localhost\ working directory.
    if (wsl) return { command: 'cmd.exe', args: ['/d', '/c', 'start', '', url], cwd: '/mnt/c' };
    return { command: 'xdg-open', args: [url] };
}

/**
 * Best effort. A missing opener (no xdg-open on a server or in WSL) is an
 * asynchronous 'error' event on the child; unhandled, it killed the dashboard
 * that had just started. It now prints where to open the page instead.
 */
function openBrowser(url, { platform = process.platform, spawnImpl = spawn, wsl = platform === 'linux' && isWsl(), log = console.log } = {}) {
    try {
        const { command, args, cwd } = browserCommand(url, platform, wsl);
        const child = spawnImpl(command, args, { detached: true, stdio: 'ignore', windowsHide: true, ...(cwd ? { cwd } : {}) });
        child.on?.('error', () => log(`  Could not open a browser (${command} unavailable). Open ${url} yourself.`));
        child.unref?.();
        return true;
    } catch (_) {
        return false;
    }
}

module.exports = { openBrowser, isWsl };
