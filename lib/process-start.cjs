'use strict';

/**
 * Best-effort wall-clock start time for a process.
 *
 * A PID alone is not an identity: after a daemon exits, Windows (and Unix)
 * eventually reuses its number. If the old instance marker survives a crash,
 * processExists() then mistakes an unrelated process for the daemon forever.
 * Comparing start times distinguishes the reused PID without weakening the
 * single-writer guard. Unknown/unqueryable processes deliberately return null
 * so callers can fail closed and keep treating the marker as owned.
 */
function processStartedAt(pid) {
    try {
        let raw;
        if (process.platform === 'win32') {
            raw = require('node:child_process').execFileSync(
                'powershell.exe',
                [
                    '-NoProfile',
                    '-NonInteractive',
                    '-Command',
                    `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')`,
                ],
                // A cold PowerShell start on a GitHub Windows runner can take
                // more than two seconds. Timing out here makes a decades-old
                // marker look current and prevents the daemon from starting.
                { encoding: 'utf8', timeout: 10000, windowsHide: true },
            ).trim();
        } else {
            raw = require('node:child_process').execFileSync(
                'ps',
                ['-o', 'lstart=', '-p', String(pid)],
                { encoding: 'utf8', timeout: 2000 },
            ).trim();
        }
        const timestamp = Date.parse(raw);
        return Number.isFinite(timestamp) ? timestamp : null;
    } catch (_) {
        return null;
    }
}

module.exports = { processStartedAt };
