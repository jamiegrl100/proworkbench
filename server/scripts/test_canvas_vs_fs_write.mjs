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

function nowIso() {
  return new Date().toISOString();
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
  const tmp = fs.mkdtempSync('/tmp/pb-canvas-fs-');
  const xdg = path.join(tmp, 'xdg');
  const workdir = path.join(tmp, 'workdir');
  fs.mkdirSync(xdg, { recursive: true });
  fs.mkdirSync(workdir, { recursive: true });

  const port = 8799;
  const base = `http://127.0.0.1:${port}`;

  const env = {
    ...process.env,
    XDG_DATA_HOME: xdg,
    PB_WORKDIR: workdir,
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

  let out = '';
  child.stdout.on('data', (d) => { out += String(d); });
  child.stderr.on('data', (d) => { out += String(d); });

  try {
    const ok = await waitFor(`${base}/admin/meta`, { timeoutMs: 8000 });
    assert(ok, 'server did not start');

    const boot = await fetch(`${base}/admin/setup/bootstrap`, { method: 'POST' });
    const bootJson = await jsonOrText(boot);
    assert(boot.ok, `bootstrap failed: ${JSON.stringify(bootJson)}`);
    const token = String(bootJson?.token || '');
    assert(token, 'no token returned');

    // Ensure policy allows filesystem writes only with approval (so we can test approval gating).
    const policyRes = await fetch(`${base}/admin/tools/policy`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        policy: {
          version: 2,
          global_default: 'blocked',
          per_risk: { low: 'blocked', medium: 'blocked', high: 'blocked', critical: 'blocked' },
          per_tool: { 'workspace.write_file': 'allowed_with_approval' },
          provider_overrides: {},
        },
      }),
    });
    const policyJson = await jsonOrText(policyRes);
    assert(policyRes.ok, `policy set failed: ${JSON.stringify(policyJson)}`);

    const dbPath = path.join(xdg, 'proworkbench', 'proworkbench.db');
    const db = new Database(dbPath);

    // Insert a legacy canvas-write proposal that is approval-gated (this is the bug).
    const propCanvas = 'prop_canvas_1';
    const apprCanvas = db.prepare(`
      INSERT INTO approvals (kind, status, risk_level, tool_name, proposal_id, server_id, payload_json, session_id, message_id, reason, created_at)
      VALUES ('tool_run', 'pending', 'high', 'workspace.write', ?, NULL, ?, 's1', 'm1', NULL, ?)
    `).run(propCanvas, JSON.stringify({ title: 'Hello', content_type: 'text', content: 'Hi' }), nowIso());

    db.prepare(`
      INSERT INTO web_tool_proposals
        (id, session_id, message_id, tool_name, mcp_server_id, args_json, risk_level, summary, status, requires_approval, approval_id, created_at, executed_run_id)
      VALUES
        (?, 's1', 'm1', 'workspace.write', NULL, ?, 'high', 'canvas write', 'awaiting_approval', 1, ?, ?, NULL)
    `).run(propCanvas, JSON.stringify({ title: 'Hello', content_type: 'text', content: 'Hi' }), Number(apprCanvas.lastInsertRowid), nowIso());

    const r1 = await fetch(`${base}/admin/tools/execute`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ proposal_id: propCanvas }),
    });
    const j1 = await jsonOrText(r1);
    assert(r1.ok, `canvas proposal should execute without approval: ${JSON.stringify(j1)}`);
    assert(j1?.internal === 'canvas.write', 'expected internal canvas write path');
    assert(j1?.canvas_item_id, 'expected canvas_item_id');

    const pendingCanvasAfter = Number(db.prepare("SELECT COUNT(1) AS c FROM approvals WHERE proposal_id = ? AND status = 'pending'").get(propCanvas)?.c || 0);
    assert(pendingCanvasAfter === 0, 'canvas write should not leave pending approvals behind');

    // Insert a filesystem write proposal that requires approval.
    const propFs = 'prop_fs_1';
    const apprFs = db.prepare(`
      INSERT INTO approvals (kind, status, risk_level, tool_name, proposal_id, server_id, payload_json, session_id, message_id, reason, created_at)
      VALUES ('tool_run', 'pending', 'high', 'workspace.write_file', ?, NULL, ?, 's1', 'm2', NULL, ?)
    `).run(propFs, JSON.stringify({ path: 'x.txt', content: 'ok' }), nowIso());
    const approvalIdFs = Number(apprFs.lastInsertRowid);

    db.prepare(`
      INSERT INTO web_tool_proposals
        (id, session_id, message_id, tool_name, mcp_server_id, args_json, risk_level, summary, status, requires_approval, approval_id, created_at, executed_run_id)
      VALUES
        (?, 's1', 'm2', 'workspace.write_file', NULL, ?, 'high', 'fs write', 'awaiting_approval', 1, ?, ?, NULL)
    `).run(propFs, JSON.stringify({ path: 'x.txt', content: 'ok' }), approvalIdFs, nowIso());

    const r2 = await fetch(`${base}/admin/tools/execute`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ proposal_id: propFs }),
    });
    const j2 = await jsonOrText(r2);
    assert(r2.status === 403 && j2?.code === 'APPROVAL_REQUIRED', `expected approval required for fs write: ${JSON.stringify(j2)}`);

    const rAppr = await fetch(`${base}/admin/approvals/apr:${approvalIdFs}/approve`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const jAppr = await jsonOrText(rAppr);
    assert(rAppr.ok, `approve failed: ${JSON.stringify(jAppr)}`);

    const r3 = await fetch(`${base}/admin/tools/execute`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ proposal_id: propFs }),
    });
    const j3 = await jsonOrText(r3);
    assert(r3.ok, `fs proposal should execute after approval: ${JSON.stringify(j3)}`);
    assert(fs.existsSync(path.join(workdir, 'x.txt')), 'expected file written under PB_WORKDIR');

    // Escape attempt should fail (no outside writes).
    const propEscape = 'prop_fs_escape';
    const apprEsc = db.prepare(`
      INSERT INTO approvals (kind, status, risk_level, tool_name, proposal_id, server_id, payload_json, session_id, message_id, reason, created_at)
      VALUES ('tool_run', 'approved', 'high', 'workspace.write_file', ?, NULL, ?, 's1', 'm3', NULL, ?)
    `).run(propEscape, JSON.stringify({ path: '../escape.txt', content: 'nope' }), nowIso());
    db.prepare(`
      INSERT INTO web_tool_proposals
        (id, session_id, message_id, tool_name, mcp_server_id, args_json, risk_level, summary, status, requires_approval, approval_id, created_at, executed_run_id)
      VALUES
        (?, 's1', 'm3', 'workspace.write_file', NULL, ?, 'high', 'escape', 'ready', 1, ?, ?, NULL)
    `).run(propEscape, JSON.stringify({ path: '../escape.txt', content: 'nope' }), Number(apprEsc.lastInsertRowid), nowIso());

    const r4 = await fetch(`${base}/admin/tools/execute`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ proposal_id: propEscape }),
    });
    const j4 = await jsonOrText(r4);
    assert(!r4.ok, 'escape attempt should fail');
    assert(!fs.existsSync(path.join(tmp, 'escape.txt')), 'escape file must not be written outside workdir');

    console.log('[OK] Canvas write bypasses approvals; filesystem write requires approval and stays within PB_WORKDIR.');
    console.log({ tmp, workdir, dbPath });
  } finally {
    child.kill('SIGTERM');
  }
}

main().catch((e) => {
  console.error('[FAIL]', e?.stack || e);
  process.exit(1);
});
