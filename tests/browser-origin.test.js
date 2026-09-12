const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { createServer } = require('node:http');
const { Server } = require('socket.io');
const WebSocket = require('ws');
const { isAllowedBrowserOrigin, requireLocalOrigin, allowLocalSocketRequest } = require('../server/browser-origin.cjs');

test('origin policy handles native clients, loopback IPv6, opaque and deceptive origins', () => {
    for (const origin of [undefined, 'http://localhost:5173', 'http://127.0.0.1:4362', 'http://[::1]:5173']) {
        assert.equal(isAllowedBrowserOrigin(origin), true, origin);
    }
    for (const origin of ['', 'null', 'https://untrusted.example', 'http://localhost.evil', 'file://localhost', 'http://evil@localhost']) {
        assert.equal(isAllowedBrowserOrigin(origin), false, origin);
    }
});

test('HTTP handlers and actual Socket.IO upgrades reject disallowed origins', async () => {
    const app = express();
    app.use(requireLocalOrigin);
    let calls = 0;
    app.post('/probe', (_req, res) => { calls++; res.json({ ok: true }); });
    const server = createServer(app);
    const io = new Server(server, { allowRequest: allowLocalSocketRequest });
    let connections = 0;
    io.on('connection', socket => { connections++; socket.emit('probe', 'accepted'); });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const connect = origin => new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/socket.io/?EIO=4&transport=websocket`, { origin });
        const timer = setTimeout(() => { ws.terminate(); reject(new Error('handshake timed out')); }, 3000);
        ws.on('error', error => { clearTimeout(timer); reject(error); });
        ws.on('unexpected-response', (_req, res) => { res.resume(); clearTimeout(timer); ws.terminate(); resolve(res.statusCode); });
        ws.on('message', message => {
            const value = String(message);
            if (value.startsWith('0')) ws.send('40');
            if (value.startsWith('42')) { clearTimeout(timer); ws.close(); resolve(101); }
        });
    });
    try {
        const denied = await fetch(`http://127.0.0.1:${port}/probe`, {
            method: 'POST', headers: { Origin: 'https://untrusted.example', 'Content-Type': 'text/plain' }, body: '',
        });
        assert.equal(denied.status, 403);
        assert.equal(calls, 0);
        assert.ok([400, 403].includes(await connect('https://untrusted.example')));
        assert.equal(connections, 0);
        assert.equal(await connect('http://localhost:5173'), 101);
        assert.equal(connections, 1);
        assert.equal((await fetch(`http://127.0.0.1:${port}/probe`, { method: 'POST' })).status, 200);
        assert.equal(calls, 1);
    } finally { await new Promise(resolve => io.close(resolve)); }
});
