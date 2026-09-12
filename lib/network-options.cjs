'use strict';

const LOOPBACK_HOST = '127.0.0.1';

function parsePort(value, name = 'port') {
    const text = String(value ?? '').trim();
    if (!/^\d+$/.test(text)) {
        throw new Error(`${name} must be an integer between 1 and 65535.`);
    }
    const port = Number(text);
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
        throw new Error(`${name} must be an integer between 1 and 65535.`);
    }
    return port;
}

module.exports = { LOOPBACK_HOST, parsePort };
