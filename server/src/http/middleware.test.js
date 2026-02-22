import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { migrate } from '../db/db.js';
import { createAdminToken } from '../auth/adminToken.js';
import { requireAuth, requireAuthOrBootstrap } from './middleware.js';

function createDb() {
  const db = new Database(':memory:');
  migrate(db);
  return db;
}

function runMiddleware(mw, req = {}) {
  return new Promise((resolve) => {
    const state = { nextCalled: false, statusCode: null, body: null, adminToken: null };
    const res = {
      status(code) {
        state.statusCode = code;
        return this;
      },
      json(payload) {
        state.body = payload;
        resolve(state);
        return this;
      },
    };
    const request = {
      headers: {},
      originalUrl: '/admin/test',
      baseUrl: '/admin',
      path: '/test',
      ...req,
    };
    mw(request, res, () => {
      state.nextCalled = true;
      state.adminToken = request.adminToken || null;
      resolve(state);
    });
  });
}

test('requireAuth blocks missing token even if dev env vars are set', async () => {
  const db = createDb();
  process.env.SECURITY_DISABLED = 'true';
  process.env.DEV_AUTH_DISABLED = 'true';
  const out = await runMiddleware(requireAuth(db), { originalUrl: '/admin/tools' });
  assert.equal(out.nextCalled, false);
  assert.equal(out.statusCode, 401);
  assert.equal(out.body?.error, 'UNAUTHORIZED');
  assert.match(String(out.body?.hint || ''), /admin token/i);
  delete process.env.SECURITY_DISABLED;
  delete process.env.DEV_AUTH_DISABLED;
});

test('requireAuthOrBootstrap allows setup route when token count is zero', async () => {
  const db = createDb();
  const out = await runMiddleware(
    requireAuthOrBootstrap(db, { allowedPrefixes: ['/admin/setup/'] }),
    { originalUrl: '/admin/setup/bootstrap' }
  );
  assert.equal(out.nextCalled, true);
});

test('requireAuthOrBootstrap blocks non-setup route when token count is zero', async () => {
  const db = createDb();
  const out = await runMiddleware(
    requireAuthOrBootstrap(db, { allowedPrefixes: ['/admin/setup/'] }),
    { originalUrl: '/admin/tools' }
  );
  assert.equal(out.nextCalled, false);
  assert.equal(out.statusCode, 401);
  assert.equal(out.body?.error, 'UNAUTHORIZED');
  assert.equal(Number(out.body?.bootstrap?.tokenCount), 0);
});

test('requireAuthOrBootstrap requires auth once token exists', async () => {
  const db = createDb();
  const token = createAdminToken(db);

  const denied = await runMiddleware(
    requireAuthOrBootstrap(db, { allowedPrefixes: ['/admin/setup/'] }),
    { originalUrl: '/admin/setup/state', headers: {} }
  );
  assert.equal(denied.nextCalled, false);
  assert.equal(denied.statusCode, 401);

  const allowed = await runMiddleware(
    requireAuthOrBootstrap(db, { allowedPrefixes: ['/admin/setup/'] }),
    { originalUrl: '/admin/setup/state', headers: { authorization: `Bearer ${token}` } }
  );
  assert.equal(allowed.nextCalled, true);
  assert.equal(allowed.adminToken, token);
});
