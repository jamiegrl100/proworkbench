import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';

import { openDb, migrate } from '../db/db.js';
import { seedMcpTemplates } from '../mcp/seedTemplates.js';
import { createMcpRouter } from './mcp.js';
import { createAdminRouter } from './admin.js';

function mkTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pb-mcp-test-'));
}

function makeToken() {
  return 'a'.repeat(64);
}

function authHeaders(token) {
  return {
    'content-type': 'application/json',
    authorization: `Bearer ${token}`,
    'x-pb-admin-token': token,
  };
}

async function startApp(db, dataDir) {
  const app = express();
  app.use(express.json());
  app.use('/api/mcp', createMcpRouter({ db }));
  app.use('/admin', createAdminRouter({ db, telegram: {}, slack: {}, dataDir }));
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = Number(server.address().port);
  return { server, base: `http://127.0.0.1:${port}` };
}

async function reqJson(base, method, url, token, body) {
  const rr = await fetch(`${base}${url}`, {
    method,
    headers: authHeaders(token),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const txt = await rr.text();
  let json = {};
  try { json = txt ? JSON.parse(txt) : {}; } catch { json = { raw: txt }; }
  return { status: rr.status, json };
}

test('search_browser and code1 exist; search_browser can be enabled in debug', async () => {
  const dataDir = mkTempDir();
  const db = openDb(dataDir);
  migrate(db);
  seedMcpTemplates(db);
  const token = makeToken();
  const now = new Date().toISOString();
  db.prepare('INSERT INTO admin_tokens (token, created_at, last_used_at, expires_at) VALUES (?, ?, ?, ?)')
    .run(token, now, now, new Date(Date.now() + 86400000).toISOString());

  const { server, base } = await startApp(db, dataDir);
  try {
    const tpl = await reqJson(base, 'GET', '/api/mcp/templates', token);
    assert.equal(tpl.status, 200);
    assert.equal(Array.isArray(tpl.json), true);
    const search = tpl.json.find((x) => x.id === 'search_browser');
    assert.ok(search, 'search_browser missing from templates endpoint');
    const code1 = tpl.json.find((x) => x.id === 'code1');
    assert.ok(code1, 'code1 missing from templates endpoint');

    const dis = await reqJson(base, 'POST', '/api/mcp/templates/search_browser/enable', token, { enabled: false });
    assert.equal(dis.status, 200);
    assert.equal(dis.json.ok, true);

    const dbg1 = await reqJson(base, 'GET', '/api/mcp/debug', token);
    assert.equal(dbg1.status, 200);
    assert.equal(Array.isArray(dbg1.json.enabled_templates), true);
    assert.equal(dbg1.json.enabled_templates.includes('search_browser'), false);

    const en = await reqJson(base, 'POST', '/api/mcp/templates/search_browser/enable', token, { enabled: true });
    assert.equal(en.status, 200);
    const dbg2 = await reqJson(base, 'GET', '/api/mcp/debug', token);
    assert.equal(dbg2.status, 200);
    assert.equal(dbg2.json.enabled_templates.includes('search_browser'), true);
  } finally {
    await new Promise((r) => server.close(r));
    db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('delete non-built-in template works; built-in returns 409', async () => {
  const dataDir = mkTempDir();
  const db = openDb(dataDir);
  migrate(db);
  seedMcpTemplates(db);
  const token = makeToken();
  const now = new Date().toISOString();
  db.prepare('INSERT INTO admin_tokens (token, created_at, last_used_at, expires_at) VALUES (?, ?, ?, ?)')
    .run(token, now, now, new Date(Date.now() + 86400000).toISOString());

  db.prepare(`INSERT INTO mcp_templates
    (id, schema_version, name, description, template_path, default_capabilities_json, risk, allowed_channels_json, requires_approval_by_default, fields_json, security_defaults_json, created_at, updated_at)
    VALUES (?, 1, ?, ?, ?, '[]', 'low', '["webchat"]', 0, '[]', '{}', ?, ?)`)
    .run('custom_tmp', 'Custom TMP', 'tmp', '/tmp/custom-template.json', now, now);

  const { server, base } = await startApp(db, dataDir);
  try {
    const d1 = await reqJson(base, 'DELETE', '/api/mcp/templates/custom_tmp', token);
    assert.equal(d1.status, 200);
    assert.equal(d1.json.ok, true);

    const row = db.prepare('SELECT id FROM mcp_templates WHERE id = ?').get('custom_tmp');
    assert.equal(Boolean(row), false);

    const d2 = await reqJson(base, 'DELETE', '/api/mcp/templates/search_browser', token);
    assert.equal(d2.status, 409);
    assert.equal(d2.json.error, 'MCP_TEMPLATE_BUILTIN');
  } finally {
    await new Promise((r) => server.close(r));
    db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('webchat send returns MCP_TEMPLATE_DISABLED when template disabled', async () => {
  const dataDir = mkTempDir();
  const db = openDb(dataDir);
  migrate(db);
  seedMcpTemplates(db);
  const token = makeToken();
  const now = new Date().toISOString();
  db.prepare('INSERT INTO admin_tokens (token, created_at, last_used_at, expires_at) VALUES (?, ?, ?, ?)')
    .run(token, now, now, new Date(Date.now() + 86400000).toISOString());

  const { server, base } = await startApp(db, dataDir);
  try {
    const dis = await reqJson(base, 'POST', '/api/mcp/templates/search_browser/enable', token, { enabled: false });
    assert.equal(dis.status, 200);

    const send = await reqJson(base, 'POST', '/admin/webchat/send', token, {
      session_id: 'webchat-main',
      agent_id: 'alex',
      mcp_template_id: 'search_browser',
      message: 'search for proworkbench',
    });

    assert.equal(send.status, 400);
    assert.equal(send.json.error, 'MCP_TEMPLATE_DISABLED');
  } finally {
    await new Promise((r) => server.close(r));
    db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('legacy context7 IDs migrate to code1 on startup', async () => {
  const dataDir = mkTempDir();
  const db = openDb(dataDir);
  migrate(db);
  seedMcpTemplates(db);
  const token = makeToken();
  const now = new Date().toISOString();
  db.prepare('INSERT INTO admin_tokens (token, created_at, last_used_at, expires_at) VALUES (?, ?, ?, ?)')
    .run(token, now, now, new Date(Date.now() + 86400000).toISOString());

  db.prepare('INSERT INTO app_kv (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json')
    .run('mcp.webchat.enabled', JSON.stringify({ templates: { context7_docs_default: true, context7: true }, servers: {} }));
  db.prepare('INSERT INTO app_kv (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json')
    .run('webchat.session_meta.webchat-main', JSON.stringify({ session_id: 'webchat-main', assistant_name: 'Alex', mcp_template_id: 'context7_docs_default', updated_at: now }));

  const { server, base } = await startApp(db, dataDir);
  try {
    const dbg = await reqJson(base, 'GET', '/api/mcp/debug', token);
    assert.equal(dbg.status, 200);
    const enabled = dbg.json.enabled_templates || [];
    assert.equal(enabled.includes('code1_docs_default') || enabled.includes('code1'), true);

    const kv = db.prepare('SELECT value_json FROM app_kv WHERE key = ?').get('mcp.webchat.enabled');
    const parsed = JSON.parse(String(kv?.value_json || '{}'));
    assert.equal(Boolean(parsed?.templates?.code1_docs_default || parsed?.templates?.code1), true);
    assert.equal(Boolean(parsed?.templates?.context7), false);
    assert.equal(Boolean(parsed?.templates?.context7_docs_default), false);

    const meta = db.prepare('SELECT value_json FROM app_kv WHERE key = ?').get('webchat.session_meta.webchat-main');
    const m = JSON.parse(String(meta?.value_json || '{}'));
    assert.equal(m.mcp_template_id, 'code1_docs_default');
  } finally {
    await new Promise((r) => server.close(r));
    db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
