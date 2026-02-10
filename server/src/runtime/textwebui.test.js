import test from 'node:test';
import assert from 'node:assert/strict';
import { probeTextWebUI } from './textwebui.js';

test('probeTextWebUI reports ready when models returned', async () => {
  const fakeFetch = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ data: [{ id: 'm1' }, { id: 'm2' }] }),
  });
  const out = await probeTextWebUI({ baseUrl: 'http://127.0.0.1:5000', fetchFn: fakeFetch, timeoutMs: 50 });
  assert.equal(out.running, true);
  assert.equal(out.ready, true);
  assert.equal(out.models.length, 2);
});

test('probeTextWebUI reports not running on connection error', async () => {
  const fakeFetch = async () => {
    throw new Error('connect ECONNREFUSED 127.0.0.1:5000');
  };
  const out = await probeTextWebUI({ baseUrl: 'http://127.0.0.1:5000', fetchFn: fakeFetch, timeoutMs: 50 });
  assert.equal(out.running, false);
  assert.equal(out.ready, false);
  assert.equal(out.models.length, 0);
  assert.ok(out.error);
});
