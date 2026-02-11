import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(url, { timeoutMs = 5000 } = {}) {
  const start = Date.now();
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const r = await fetch(url);
      if (r.ok) return true;
    } catch {
      // ignore
    }
    if (Date.now() - start > timeoutMs) return false;
    await sleep(120);
  }
}

async function jsonOrText(r) {
  const txt = await r.text();
  try {
    return txt ? JSON.parse(txt) : null;
  } catch {
    return txt;
  }
}

async function main() {
  const CANVAS_MCP_ID = 'mcp_EF881B855521';

  const tmp = fs.mkdtempSync('/tmp/pb-canvas-mcp-');
  const xdg = path.join(tmp, 'xdg');
  fs.mkdirSync(xdg, { recursive: true });

  const port = 8798;
  const base = `http://127.0.0.1:${port}`;

  const env = {
    ...process.env,
    XDG_DATA_HOME: xdg,
    PROWORKBENCH_PORT: String(port),
  };

  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const repoRoot = path.resolve(__dirname, '..', '..');

  const child = spawn(process.execPath, ['server/src/index.js'], {
    cwd: repoRoot,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  try {
    const ok = await waitFor(`${base}/admin/meta`, { timeoutMs: 8000 });
    assert(ok, 'server did not start');

    const boot = await fetch(`${base}/admin/setup/bootstrap`, { method: 'POST' });
    const bootJson = await jsonOrText(boot);
    assert(boot.ok, `bootstrap failed: ${JSON.stringify(bootJson)}`);
    const token = String(bootJson?.token || '');
    assert(token, 'no token returned');

    // Insert a Canvas MCP server into DB (simulates existing installs).
    const dbPath = path.join(xdg, 'proworkbench', 'proworkbench.db');
    const db = new Database(dbPath);
    db.prepare(`
      INSERT OR REPLACE INTO mcp_servers
      (id, template_id, name, risk, status, approved_for_use, config_json, security_json, last_error, last_test_at, last_test_status, last_test_message, created_at, updated_at)
      VALUES
      (?, 'notes_inbox', 'Canvas MCP', 'high', 'stopped', 0, '{}', '{}', NULL, NULL, 'never', NULL, datetime('now'), datetime('now'))
    `).run(CANVAS_MCP_ID);

    // Default list must hide it.
    const list = await fetch(`${base}/admin/mcp/servers`, { headers: { Authorization: `Bearer ${token}` } });
    const listJson = await jsonOrText(list);
    assert(list.ok, 'list servers failed');
    assert(!Array.isArray(listJson) || listJson.every((s) => String(s.id) !== CANVAS_MCP_ID), 'Canvas MCP must be hidden from list');

    // include_hidden=1 must include it (for debugging), but it remains non-modifiable.
    const list2 = await fetch(`${base}/admin/mcp/servers?include_hidden=1`, { headers: { Authorization: `Bearer ${token}` } });
    const list2Json = await jsonOrText(list2);
    assert(list2.ok, 'list servers (include_hidden) failed');
    assert(Array.isArray(list2Json) && list2Json.some((s) => String(s.id) === CANVAS_MCP_ID), 'Canvas MCP should be present when include_hidden=1');

    const del = await fetch(`${base}/admin/mcp/servers/${encodeURIComponent(CANVAS_MCP_ID)}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    assert(del.status === 403 || del.status === 404, 'delete must be rejected for Canvas MCP');

    const stop = await fetch(`${base}/admin/mcp/servers/${encodeURIComponent(CANVAS_MCP_ID)}/stop`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert(stop.status === 403 || stop.status === 404, 'stop must be rejected for Canvas MCP');

    console.log('[OK] Canvas MCP is hidden by default and cannot be modified.');
    console.log({ tmp, dbPath });
  } finally {
    child.kill('SIGTERM');
  }
}

main().catch((e) => {
  console.error('[FAIL]', e?.stack || e);
  process.exit(1);
});

