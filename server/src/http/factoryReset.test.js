import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
import Database from 'better-sqlite3';

import { openDb, migrate } from '../db/db.js';
import { seedMcpTemplates } from '../mcp/seedTemplates.js';
import { createAdminRouter } from './admin.js';
import { createAuthRouter } from './auth.js';
import { AtlasStore } from '../memory/atlas/store.js';

function mkTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
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
  app.use('/admin', createAdminRouter({
    db,
    telegram: {},
    slack: {},
    dataDir,
    scheduleFactoryResetRestart: null,
  }));
  app.use('/auth', createAuthRouter({ db }));
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

function insertAdminToken(db, token) {
  const now = new Date().toISOString();
  db.prepare('INSERT INTO admin_tokens (token, created_at, last_used_at, expires_at) VALUES (?, ?, ?, ?)')
    .run(token, now, now, new Date(Date.now() + 86400000).toISOString());
}

async function ensureFile(filePath, content = 'x') {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, content, 'utf8');
}

test('factory reset clears user state but preserves MCP, tools, provider config, and memory capability', async () => {
  const pbHome = mkTempDir('pb-home-');
  const workdir = path.join(pbHome, 'workspaces', 'alex');
  const dataDir = path.join(pbHome, 'data');
  fs.mkdirSync(workdir, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });

  const prevWorkspaceRoot = process.env.WORKSPACE_ROOT;
  const prevPbRoot = process.env.PB_ROOT;
  process.env.WORKSPACE_ROOT = workdir;
  process.env.PB_ROOT = pbHome;

  const db = openDb(dataDir);
  migrate(db);
  seedMcpTemplates(db);
  const now = new Date().toISOString();
  const token = 'b'.repeat(64);
  insertAdminToken(db, token);
  db.prepare('UPDATE admin_auth SET password_hash = ?, created_at = ? WHERE id = 1').run('argon2id$fakehash', now);

  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      ts TEXT NOT NULL,
      meta_json TEXT
    );
  `);

  db.prepare('INSERT INTO app_kv (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json')
    .run('llm.providers', JSON.stringify([{ id: 'provider-1', providerType: 'openai', baseUrl: 'http://127.0.0.1:5000' }]));
  db.prepare('INSERT INTO app_kv (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json')
    .run('webchat.session_meta.webchat-main', JSON.stringify({ assistant_name: 'Alex', mcp_template_id: 'search_browser' }));
  db.prepare('INSERT INTO app_kv (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json')
    .run('memory.patch.test', JSON.stringify({ patch: 'abc' }));
  db.prepare('INSERT INTO app_kv (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json')
    .run('agent.preamble', JSON.stringify('keep me'));

  db.prepare(`INSERT INTO mcp_servers
    (id, template_id, name, risk, status, approved_for_use, config_json, security_json, created_at, updated_at)
    VALUES (?, ?, ?, 'low', 'running', 1, '{}', '{}', ?, ?)`)
    .run('mcp_test_server', 'search_browser', 'Test MCP', now, now);
  db.prepare(`INSERT INTO messages (session_id, role, content, ts, meta_json) VALUES (?, ?, ?, ?, '{}')`)
    .run('webchat-main', 'user', 'remember this', now);
  db.prepare(`INSERT INTO memory_entries (ts, day, kind, content, meta_json, state, committed_at, tags_json, source_session_id, workspace_id, agent_id)
    VALUES (?, ?, 'note', ?, '{}', 'committed', ?, '[]', ?, ?, ?)`)
    .run(now, now.slice(0, 10), 'memory content', now, 'webchat-main', workdir, 'alex');
  db.prepare(`INSERT INTO memories (agent_id, chat_id, kind, content, updated_at) VALUES (?, ?, ?, ?, ?)`)
    .run('alex', 'webchat-main', 'summary', 'summary text', now);
  db.prepare(`INSERT INTO webchat_uploads (id, session_id, filename, mime_type, size_bytes, rel_path, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'attached', ?, ?)`)
    .run('upl1', 'webchat-main', 'note.txt', 'text/plain', 4, 'data/uploads/webchat-main/note.txt', now, now);

  const atlas = new AtlasStore({ dbPath: path.join(dataDir, 'atlas.db') });
  atlas.ingestMessage({ sessionId: 'webchat-main', role: 'user', content: 'atlas memory' });
  atlas.close();

  await ensureFile(path.join(workdir, '.pb', 'memory', 'daily', '2026-03-27.scratch.md'), 'scratch');
  await ensureFile(path.join(workdir, 'MEMORY.md'), 'durable memory');
  await ensureFile(path.join(workdir, 'MEMORY_ARCHIVE', '2026-03.md'), 'archive');
  await ensureFile(path.join(workdir, 'scratch', 'alex', 'default', 'notes.txt'), 'scratch cache');
  await ensureFile(path.join(workdir, 'data', 'uploads', 'webchat-main', 'note.txt'), 'upload');
  await ensureFile(path.join(workdir, 'mcp_servers', 'staging', 'temp', 'manifest.json'), '{}');
  await ensureFile(path.join(workdir, 'mcp_servers', 'installed', 'kept', 'manifest.json'), '{}');
  await ensureFile(path.join(workdir, '.pb', 'plugins', 'enabled.json'), '{"enabled":["csv_to_json_converter"]}');
  await ensureFile(path.join(workdir, '.pb', 'extensions', 'installed', 'index.json'), '{"items":["research-lab"]}');
  await ensureFile(path.join(workdir, 'ALEX_SKILLS', 'skills.json'), '[]');

  const { server, base } = await startApp(db, dataDir);
  try {
    const beforeMessages = Number(db.prepare('SELECT COUNT(1) AS c FROM messages').get()?.c || 0);
    const beforeMemory = Number(db.prepare('SELECT COUNT(1) AS c FROM memory_entries').get()?.c || 0);
    const beforeMcp = Number(db.prepare('SELECT COUNT(1) AS c FROM mcp_servers').get()?.c || 0);
    assert.equal(beforeMessages > 0, true);
    assert.equal(beforeMemory > 0, true);
    assert.equal(beforeMcp > 0, true);

    const out = await reqJson(base, 'POST', '/admin/settings/factory-reset', token, { confirm: 'RESET' });
    assert.equal(out.status, 200);
    assert.equal(out.json.ok, true);
    assert.equal(out.json.requires_restart, false);

    assert.equal(Number(db.prepare('SELECT COUNT(1) AS c FROM messages').get()?.c || 0), 0);
    assert.equal(Number(db.prepare('SELECT COUNT(1) AS c FROM memory_entries').get()?.c || 0), 0);
    assert.equal(Number(db.prepare('SELECT COUNT(1) AS c FROM memories').get()?.c || 0), 0);
    assert.equal(Number(db.prepare('SELECT COUNT(1) AS c FROM webchat_uploads').get()?.c || 0), 0);
    assert.equal(Number(db.prepare('SELECT COUNT(1) AS c FROM mcp_servers').get()?.c || 0), 1);
    assert.equal(Number(db.prepare('SELECT COUNT(1) AS c FROM mcp_templates').get()?.c || 0) > 0, true);
    assert.equal(Boolean(db.prepare('SELECT value_json FROM app_kv WHERE key = ?').get('llm.providers')), true);
    assert.equal(Boolean(db.prepare('SELECT value_json FROM app_kv WHERE key = ?').get('agent.preamble')), true);
    assert.equal(Boolean(db.prepare('SELECT value_json FROM app_kv WHERE key = ?').get('webchat.session_meta.webchat-main')), false);
    assert.equal(Boolean(db.prepare('SELECT value_json FROM app_kv WHERE key = ?').get('memory.patch.test')), false);
    assert.equal(Number(db.prepare('SELECT COUNT(1) AS c FROM admin_tokens').get()?.c || 0), 0);
    const authRow = db.prepare('SELECT password_hash, created_at FROM admin_auth WHERE id = 1').get();
    assert.equal(authRow?.password_hash ?? null, null);
    assert.equal(authRow?.created_at ?? null, null);

    const authState = await reqJson(base, 'GET', '/auth/state', token);
    assert.equal(authState.status, 200);
    assert.equal(Boolean(authState.json?.passwordSet), false);
    assert.equal(Boolean(authState.json?.setupComplete), false);

    const atlasDb = new Database(path.join(dataDir, 'atlas.db'));
    try {
      assert.equal(Number(atlasDb.prepare('SELECT COUNT(1) AS c FROM messages').get()?.c || 0), 0);
      assert.equal(Number(atlasDb.prepare('SELECT COUNT(1) AS c FROM conversations').get()?.c || 0), 0);
    } finally {
      atlasDb.close();
    }

    assert.equal(fs.existsSync(path.join(workdir, '.pb', 'memory')), false);
    assert.equal(fs.existsSync(path.join(workdir, 'MEMORY.md')), false);
    assert.equal(fs.existsSync(path.join(workdir, 'MEMORY_ARCHIVE')), false);
    assert.equal(fs.existsSync(path.join(workdir, 'scratch')), false);
    assert.equal(fs.existsSync(path.join(workdir, 'data', 'uploads')), false);
    assert.equal(fs.existsSync(path.join(workdir, 'mcp_servers', 'staging')), false);
    assert.equal(fs.existsSync(path.join(workdir, 'mcp_servers', 'installed', 'kept', 'manifest.json')), true);
    assert.equal(fs.existsSync(path.join(workdir, '.pb', 'plugins', 'enabled.json')), true);
    assert.equal(fs.existsSync(path.join(workdir, '.pb', 'extensions', 'installed', 'index.json')), true);
    assert.equal(fs.existsSync(path.join(workdir, 'ALEX_SKILLS', 'skills.json')), true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    db.close();
    process.env.WORKSPACE_ROOT = prevWorkspaceRoot;
    process.env.PB_ROOT = prevPbRoot;
    fs.rmSync(pbHome, { recursive: true, force: true });
  }
});
