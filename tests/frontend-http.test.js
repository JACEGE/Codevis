const test = require('node:test');
const assert = require('node:assert/strict');

async function http() {
  return import('../frontend/src/api/http.js');
}

test('requestJson returns JSON and supports empty success responses', async () => {
  const { requestJson } = await http();
  const json = await requestJson('/ok', {}, async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
  assert.deepEqual(json, { ok: true });
  const empty = await requestJson('/empty', {}, async () => new Response(null, { status: 204 }));
  assert.equal(empty, null);
});

test('requestJson rejects HTTP errors with server detail', async () => {
  const { requestJson, HttpError } = await http();
  await assert.rejects(
    requestJson('/conflict', {}, async () => new Response(JSON.stringify({ error: 'task is locked' }), { status: 409 })),
    (error) => error instanceof HttpError && error.status === 409 && error.message === 'task is locked'
  );
});

test('requestJson preserves non-JSON error responses', async () => {
  const { requestJson } = await http();
  await assert.rejects(
    requestJson('/broken', {}, async () => new Response('proxy failed', { status: 502 })),
    (error) => error.status === 502 && error.body === 'proxy failed'
  );
});
