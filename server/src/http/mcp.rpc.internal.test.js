import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openDb, migrate } from '../db/db.js';
import { seedMcpTemplates } from '../mcp/seedTemplates.js';
import { executeMcpRpc } from './mcp.js';

function mkTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pb-mcp-rpc-'));
}

function addServer(db, { id, templateId, config = {}, status = 'stopped' }) {
  const ts = new Date().toISOString();
  db.prepare(`
    INSERT INTO mcp_servers (id, template_id, name, version, risk, status, approved_for_use, install_path, entry_cmd, health_url, config_json, security_json, last_error, created_at, updated_at)
    VALUES (?, ?, ?, '0.1.0', 'low', ?, 1, '', '', '', ?, '{}', NULL, ?, ?)
  `).run(id, templateId, id, status, JSON.stringify(config), ts, ts);
}

test('json utils fallback supports format and invalid validate', async () => {
  const workdir = mkTempDir();
  const dataDir = mkTempDir();
  process.env.PB_WORKDIR = workdir;

  const db = openDb(dataDir);
  migrate(db);
  seedMcpTemplates(db);

  addServer(db, { id: 's_json', templateId: 'json_utils' });

  const fmt = await executeMcpRpc({ db, serverId: 's_json', capability: 'json.format', args: { text: '{"b":2,"a":1}' } });
  assert.equal(typeof fmt.formatted, 'string');
  assert.doesNotThrow(() => JSON.parse(fmt.formatted));

  const val = await executeMcpRpc({ db, serverId: 's_json', capability: 'json.validate', args: { text: '{bad' } });
  assert.equal(val.valid, false);

  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(workdir, { recursive: true, force: true });
});

test('sqlite fallback can exec and query within PB_WORKDIR', async () => {
  const workdir = mkTempDir();
  const dataDir = mkTempDir();
  process.env.PB_WORKDIR = workdir;

  const db = openDb(dataDir);
  migrate(db);
  seedMcpTemplates(db);

  addServer(db, { id: 's_sqlite', templateId: 'sqlite_local', config: { dbPath: 'audit/test.db' } });

  await executeMcpRpc({ db, serverId: 's_sqlite', capability: 'sqlite.exec', args: { sql: 'CREATE TABLE IF NOT EXISTS t (v TEXT)' } });
  await executeMcpRpc({ db, serverId: 's_sqlite', capability: 'sqlite.exec', args: { sql: "INSERT INTO t (v) VALUES ('ok')" } });
  const out = await executeMcpRpc({ db, serverId: 's_sqlite', capability: 'sqlite.query', args: { sql: 'SELECT v FROM t' } });

  assert.equal(Array.isArray(out.rows), true);
  assert.equal(String(out.rows[0].v), 'ok');

  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(workdir, { recursive: true, force: true });
});

test('export reports writes files inside PB_WORKDIR', async () => {
  const workdir = mkTempDir();
  const dataDir = mkTempDir();
  process.env.PB_WORKDIR = workdir;

  const db = openDb(dataDir);
  migrate(db);
  seedMcpTemplates(db);

  addServer(db, { id: 's_export', templateId: 'export_reports', config: { outputPath: 'exports' } });

  const md = await executeMcpRpc({ db, serverId: 's_export', capability: 'export.write_markdown', args: { path: 'a.md', content: '# Hi' } });
  assert.equal(fs.existsSync(String(md.path || '')), true);

  const csv = await executeMcpRpc({ db, serverId: 's_export', capability: 'export.write_csv', args: { path: 'a.csv', content: 'a,b\n1,2\n' } });
  assert.equal(fs.existsSync(String(csv.path || '')), true);

  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(workdir, { recursive: true, force: true });
});

test('sqlite blocks path traversal outside PB_WORKDIR', async () => {
  const workdir = mkTempDir();
  const dataDir = mkTempDir();
  process.env.PB_WORKDIR = workdir;

  const db = openDb(dataDir);
  migrate(db);
  seedMcpTemplates(db);

  addServer(db, { id: 's_sqlite2', templateId: 'sqlite_local' });

  await assert.rejects(
    executeMcpRpc({ db, serverId: 's_sqlite2', capability: 'sqlite.exec', args: { db_path: '../../etc/passwd', sql: 'SELECT 1' } }),
    /Path escapes PB_WORKDIR/
  );

  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(workdir, { recursive: true, force: true });
});
