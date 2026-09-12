'use strict';

function isAllowedBrowserOrigin(origin) {
    if (origin === undefined) return true; // Native CLI/MCP clients omit Origin.
    if (typeof origin !== 'string' || !origin) return false;
    try {
        const url = new URL(origin);
        return (url.protocol === 'http:' || url.protocol === 'https:')
            && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
            && !url.username && !url.password && url.origin === origin;
    } catch (_) { return false; }
}

function requireLocalOrigin(req, res, next) {
    if (!isAllowedBrowserOrigin(req.headers.origin)) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Browser origin is not allowed.' }));
        return;
    }
    next();
}

function allowLocalSocketRequest(req, callback) {
    callback(null, isAllowedBrowserOrigin(req.headers.origin));
}

module.exports = { isAllowedBrowserOrigin, requireLocalOrigin, allowLocalSocketRequest };
