import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { requireAuth } from './middleware.js';
import { readEnvFile, writeEnvFile } from '../util/envStore.js';
import { llmChatOnce } from '../llm/llmClient.js';
import { recordEvent } from '../util/events.js';

function nowIso() {
  return new Date().toISOString();
}

function newId(prefix = '') {
  const id = crypto.randomBytes(12).toString('hex');
  return prefix ? `${prefix}_${id}` : id;
}

function hashJson(v) {
  return crypto.createHash('sha256').update(JSON.stringify(v ?? {})).digest('hex');
}

function tokenFingerprint(token) {
  const t = String(token || '').trim();
  if (!t) return 'unknown';
  if (t.length <= 12) return t;
  return `${t.slice(0, 6)}...${t.slice(-4)}`;
}

function hasTable(db, name) {
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
  return Boolean(row);
}

function kvGet(db, key, fallback) {
  const row = db.prepare('SELECT value_json FROM app_kv WHERE key = ?').get(key);
  return row ? JSON.parse(row.value_json) : fallback;
}

function kvSet(db, key, value) {
  db.prepare('INSERT INTO app_kv (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json')
    .run(key, JSON.stringify(value));
}

function pruneWebToolTables(db) {
  db.exec(`
    DELETE FROM web_tool_proposals
    WHERE id NOT IN (SELECT id FROM web_tool_proposals ORDER BY created_at DESC LIMIT 500);
    DELETE FROM web_tool_runs
    WHERE id NOT IN (SELECT id FROM web_tool_runs ORDER BY started_at DESC LIMIT 500);
    DELETE FROM web_tool_approvals
    WHERE id NOT IN (SELECT id FROM web_tool_approvals ORDER BY created_at DESC LIMIT 500);
    DELETE FROM web_tool_audit
    WHERE id NOT IN (SELECT id FROM web_tool_audit ORDER BY id DESC LIMIT 800);
  `);
}

function parseApprovalId(value) {
  const raw = String(value || '').trim();
  if (/^\d+$/.test(raw)) return { source: 'tool', id: raw };
  const i = raw.indexOf(':');
  if (i <= 0) return null;
  return { source: raw.slice(0, i), id: raw.slice(i + 1) };
}

function safeJsonParse(text, fallback) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function firstJsonObject(text) {
  const s = String(text || '');
  const start = s.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < s.length; i += 1) {
    const ch = s[i];
    if (ch === '{') depth += 1;
    if (ch === '}') depth -= 1;
    if (depth === 0) return s.slice(start, i + 1);
  }
  return null;
}

function normalizeArgs(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  return raw;
}

function parseToolCommand(message) {
  const m = String(message || '').trim().match(/^\/tool\s+([a-zA-Z0-9._-]+)(?:\s+([\s\S]+))?$/);
  if (!m) return null;
  const toolName = String(m[1] || '').trim();
  const argsRaw = String(m[2] || '').trim();
  if (!toolName) return null;
  let args = {};
  if (argsRaw) {
    args = argsRaw.startsWith('{') ? normalizeArgs(safeJsonParse(argsRaw, {})) : { input: argsRaw };
  }
  return { toolName, args };
}

function parseToolProposalFromReply(replyText) {
  const objText = firstJsonObject(replyText);
  if (!objText) return null;
  const obj = safeJsonParse(objText, null);
  if (!obj || typeof obj !== 'object') return null;
  const toolName = String(
    obj.tool_name || obj.toolId || obj.tool || obj.suggested_tool_id || ''
  ).trim();
  if (!toolName) return null;
  const args = normalizeArgs(obj.args || obj.args_json || obj.input || {});
  return { toolName, args };
}

function getWorkdir() {
  const root = String(process.env.PB_WORKDIR || path.join(os.homedir(), '.proworkbench')).trim();
  fs.mkdirSync(root, { recursive: true });
  return root;
}

function resolveWorkspacePath(workdir, targetPath) {
  const raw = String(targetPath || '.').trim() || '.';
  const resolved = path.resolve(workdir, raw);
  const rel = path.relative(workdir, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    const err = new Error('Path escapes workspace');
    err.code = 'WORKSPACE_ESCAPE';
    throw err;
  }
  return resolved;
}

const TOOL_REGISTRY = {
  'system.echo': {
    id: 'system.echo',
    label: 'Echo',
    risk: 'low',
    requiresApproval: false,
    description: 'Returns text back to the user.',
  },
  'workspace.list': {
    id: 'workspace.list',
    label: 'List Workspace Directory',
    risk: 'low',
    requiresApproval: false,
    description: 'Lists files under PB_WORKDIR.',
  },
  'workspace.read_file': {
    id: 'workspace.read_file',
    label: 'Read Workspace File',
    risk: 'medium',
    requiresApproval: false,
    description: 'Reads a file from PB_WORKDIR.',
  },
  'workspace.write_file': {
    id: 'workspace.write_file',
    label: 'Write Workspace File',
    risk: 'high',
    requiresApproval: true,
    description: 'Writes a file under PB_WORKDIR.',
  },
};

function isToolAllowedByPolicy(db, toolId) {
  const denyList = Array.isArray(kvGet(db, 'tools.deny_list_json', []))
    ? kvGet(db, 'tools.deny_list_json', [])
    : [];
  const allowList = Array.isArray(kvGet(db, 'tools.allow_list_json', []))
    ? kvGet(db, 'tools.allow_list_json', [])
    : [];
  if (denyList.includes('*') || denyList.includes(toolId)) {
    return { allowed: false, reason: 'Tool is denied by policy.' };
  }
  if (allowList.length > 0 && !allowList.includes(toolId)) {
    return { allowed: false, reason: 'Tool is not in allow-list policy.' };
  }
  return { allowed: true, reason: 'allowed' };
}

async function executeRegisteredTool({ toolName, args, workdir }) {
  if (toolName === 'system.echo') {
    return {
      stdout: String(args?.text || args?.input || ''),
      stderr: '',
      result: { echoed: String(args?.text || args?.input || '') },
      artifacts: [],
    };
  }

  if (toolName === 'workspace.list') {
    const dir = resolveWorkspacePath(workdir, args?.path || '.');
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    const items = entries.slice(0, 500).map((e) => ({ name: e.name, type: e.isDirectory() ? 'dir' : 'file' }));
    return {
      stdout: `Listed ${items.length} entries`,
      stderr: '',
      result: { path: path.relative(workdir, dir) || '.', items },
      artifacts: [],
    };
  }

  if (toolName === 'workspace.read_file') {
    const file = resolveWorkspacePath(workdir, args?.path);
    const maxBytes = Math.max(1024, Math.min(Number(args?.maxBytes || 65536), 1024 * 1024));
    const text = await fsp.readFile(file, 'utf8');
    const sliced = text.length > maxBytes ? `${text.slice(0, maxBytes)}\n...[truncated]` : text;
    return {
      stdout: `Read ${Math.min(text.length, maxBytes)} bytes`,
      stderr: '',
      result: { path: path.relative(workdir, file), content: sliced, truncated: text.length > maxBytes },
      artifacts: [],
    };
  }

  if (toolName === 'workspace.write_file') {
    const file = resolveWorkspacePath(workdir, args?.path);
    const content = String(args?.content ?? '');
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, content, 'utf8');
    return {
      stdout: `Wrote ${Buffer.byteLength(content, 'utf8')} bytes`,
      stderr: '',
      result: { path: path.relative(workdir, file), bytes: Buffer.byteLength(content, 'utf8') },
      artifacts: [{ type: 'file', path: path.relative(workdir, file) }],
    };
  }

  const err = new Error('Unknown tool');
  err.code = 'TOOL_UNKNOWN';
  throw err;
}

function insertWebToolAudit(db, action, adminToken, extra = {}) {
  db.prepare(`
    INSERT INTO web_tool_audit (ts, action, proposal_id, run_id, approval_id, admin_token_fingerprint, notes_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    nowIso(),
    String(action),
    extra.proposal_id || null,
    extra.run_id || null,
    extra.approval_id || null,
    tokenFingerprint(adminToken),
    JSON.stringify(extra.notes || {})
  );
}

function toProposalResponse(db, row) {
  if (!row) return null;
  const approval = row.approval_id
    ? db.prepare('SELECT id, status, reason, created_at, resolved_at FROM web_tool_approvals WHERE id = ?').get(row.approval_id)
    : null;
  return {
    id: row.id,
    session_id: row.session_id,
    message_id: row.message_id,
    tool_name: row.tool_name,
    args_json: safeJsonParse(row.args_json, {}),
    risk_level: row.risk_level,
    summary: row.summary || '',
    status: row.status,
    requires_approval: Boolean(row.requires_approval),
    approval_id: row.approval_id || null,
    approval_status: approval?.status || null,
    executed_run_id: row.executed_run_id || null,
    created_at: row.created_at,
  };
}

function toRunResponse(row) {
  if (!row) return null;
  return {
    id: row.id,
    proposal_id: row.proposal_id,
    status: row.status,
    started_at: row.started_at,
    finished_at: row.finished_at || null,
    stdout: row.stdout || '',
    stderr: row.stderr || '',
    result_json: safeJsonParse(row.result_json, null),
    artifacts_json: safeJsonParse(row.artifacts_json, []),
    error_json: safeJsonParse(row.error_json, null),
    correlation_id: row.correlation_id,
    approval_id: row.approval_id || null,
  };
}

function createProposal(db, { sessionId, messageId, toolName, args, summary }) {
  const def = TOOL_REGISTRY[toolName];
  if (!def) return null;
  const proposalId = newId('prop');
  const createdAt = nowIso();
  const requiresApproval = def.requiresApproval ? 1 : 0;
  const riskLevel = def.risk;

  db.prepare(`
    INSERT INTO web_tool_proposals
      (id, session_id, message_id, tool_name, args_json, risk_level, summary, status, requires_approval, approval_id, created_at, executed_run_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
  `).run(
    proposalId,
    sessionId || null,
    messageId || null,
    toolName,
    JSON.stringify(args || {}),
    riskLevel,
    summary || '',
    requiresApproval ? 'awaiting_approval' : 'ready',
    requiresApproval,
    null,
    createdAt
  );

  let approvalId = null;
  if (requiresApproval) {
    const info = db.prepare(`
      INSERT INTO web_tool_approvals
        (proposal_id, tool_name, args_json, risk_level, status, reason, created_at, resolved_at, resolved_by_token_fingerprint)
      VALUES (?, ?, ?, ?, 'pending', NULL, ?, NULL, NULL)
    `).run(proposalId, toolName, JSON.stringify(args || {}), riskLevel, createdAt);
    approvalId = Number(info.lastInsertRowid);
    db.prepare('UPDATE web_tool_proposals SET approval_id = ? WHERE id = ?').run(approvalId, proposalId);
  }

  pruneWebToolTables(db);
  const row = db.prepare('SELECT * FROM web_tool_proposals WHERE id = ?').get(proposalId);
  return toProposalResponse(db, row);
}

export function createAdminRouter({ db, telegram, slack, dataDir }) {
  const r = express.Router();
  r.use(requireAuth(db));

  r.get('/me', (req, res) => {
    res.json({ ok: true, token_fingerprint: tokenFingerprint(req.adminToken) });
  });

  r.get('/health/auth', (_req, res) => {
    res.json({ ok: true });
  });

  r.get('/telegram/users', (_req, res) => {
    const allowed = db.prepare('SELECT * FROM telegram_allowed ORDER BY added_at DESC').all();
    const pending = db.prepare('SELECT * FROM telegram_pending ORDER BY last_seen_at DESC').all();
    const blocked = db.prepare('SELECT * FROM telegram_blocked ORDER BY blocked_at DESC').all();
    const overflowRow = db.prepare('SELECT value_json FROM app_kv WHERE key = ?').get('telegram.pendingOverflowActive');
    const pendingOverflowActive = overflowRow ? JSON.parse(overflowRow.value_json) : false;
    res.json({ allowed, pending, blocked, pendingCount: pending.length, pendingCap: 500, pendingOverflowActive });
  });

  r.post('/telegram/:chatId/approve', (req, res) => {
    telegram.approve(req.params.chatId);
    res.json({ ok: true });
  });

  r.post('/telegram/:chatId/block', (req, res) => {
    telegram.block(req.params.chatId, req.body?.reason || 'manual');
    res.json({ ok: true });
  });

  r.post('/telegram/:chatId/restore', (req, res) => {
    telegram.restore(req.params.chatId);
    res.json({ ok: true });
  });

  r.get('/telegram/worker/status', (_req, res) => {
    res.json({
      running: Boolean(telegram.state?.running),
      startedAt: telegram.state?.startedAt || null,
      lastError: telegram.state?.lastError || null,
    });
  });

  r.post('/telegram/worker/start', async (_req, res) => {
    try {
      await telegram.startIfReady();
      res.json({ ok: true, running: Boolean(telegram.state?.running) });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  r.post('/telegram/worker/restart', async (_req, res) => {
    try {
      telegram.stopNow();
      await telegram.startIfReady();
      res.json({ ok: true, running: Boolean(telegram.state?.running) });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  r.post('/telegram/worker/stop', (_req, res) => {
    try {
      telegram.stopNow();
      res.json({ ok: true, running: Boolean(telegram.state?.running) });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  r.get('/slack/users', (_req, res) => {
    const allowed = db.prepare('SELECT * FROM slack_allowed ORDER BY added_at DESC').all();
    const pending = db.prepare('SELECT * FROM slack_pending ORDER BY last_seen_at DESC').all();
    const blocked = db.prepare('SELECT * FROM slack_blocked ORDER BY blocked_at DESC').all();
    res.json({ allowed, pending, blocked, pendingCount: pending.length, pendingCap: 500 });
  });

  r.post('/slack/:userId/approve', (req, res) => {
    slack.approve(req.params.userId);
    res.json({ ok: true });
  });

  r.post('/slack/:userId/block', (req, res) => {
    slack.block(req.params.userId, req.body?.reason || 'manual');
    res.json({ ok: true });
  });

  r.post('/slack/:userId/restore', (req, res) => {
    slack.restore(req.params.userId);
    res.json({ ok: true });
  });

  r.get('/slack/worker/status', (_req, res) => res.json(slack.meta()));

  r.post('/slack/worker/start', async (_req, res) => {
    try {
      await slack.startIfReady();
      res.json({ ok: true, ...slack.meta() });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  r.post('/slack/worker/restart', async (_req, res) => {
    try {
      await slack.restart();
      res.json({ ok: true, ...slack.meta() });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  r.post('/slack/worker/stop', (_req, res) => {
    try {
      slack.stopNow();
      res.json({ ok: true, ...slack.meta() });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  r.get('/approvals', (req, res) => {
    const status = String(req.query.status || 'pending');
    const rows = status === 'all'
      ? db.prepare(`
          SELECT a.*, p.session_id, p.message_id, p.summary
          FROM web_tool_approvals a
          LEFT JOIN web_tool_proposals p ON p.id = a.proposal_id
          ORDER BY a.created_at DESC
          LIMIT 500
        `).all()
      : db.prepare(`
          SELECT a.*, p.session_id, p.message_id, p.summary
          FROM web_tool_approvals a
          LEFT JOIN web_tool_proposals p ON p.id = a.proposal_id
          WHERE a.status = ?
          ORDER BY a.created_at DESC
          LIMIT 500
        `).all(status);
    res.json(rows.map((r) => ({
      id: `tool:${r.id}`,
      approval_id: r.id,
      source: 'tool',
      proposal_id: r.proposal_id,
      tool_name: r.tool_name,
      risk_level: r.risk_level,
      status: r.status,
      reason: r.reason || null,
      args_json: safeJsonParse(r.args_json, {}),
      summary: r.summary || '',
      created_at: r.created_at,
      resolved_at: r.resolved_at || null,
      session_id: r.session_id || null,
      message_id: r.message_id || null,
    })));
  });

  r.get('/approvals/:id', (req, res) => {
    const parsed = parseApprovalId(req.params.id);
    if (!parsed) return res.status(400).json({ ok: false, error: 'Invalid approval id.' });
    if (parsed.source !== 'tool') return res.status(404).json({ ok: false, error: 'Only tool approval detail is supported.' });
    const row = db.prepare(`
      SELECT a.*, p.session_id, p.message_id, p.summary
      FROM web_tool_approvals a
      LEFT JOIN web_tool_proposals p ON p.id = a.proposal_id
      WHERE a.id = ?
    `).get(Number(parsed.id));
    if (!row) return res.status(404).json({ ok: false, error: 'Approval not found.' });
    res.json({
      id: `tool:${row.id}`,
      approval_id: row.id,
      source: 'tool',
      proposal_id: row.proposal_id,
      tool_name: row.tool_name,
      risk_level: row.risk_level,
      status: row.status,
      reason: row.reason || null,
      args_json: safeJsonParse(row.args_json, {}),
      summary: row.summary || '',
      created_at: row.created_at,
      resolved_at: row.resolved_at || null,
      session_id: row.session_id || null,
      message_id: row.message_id || null,
    });
  });

  r.get('/approvals/pending', (_req, res) => {
    const tgPending = db.prepare('SELECT chat_id AS id, username, first_seen_at, last_seen_at, count FROM telegram_pending ORDER BY last_seen_at DESC').all();
    const slPending = db.prepare('SELECT user_id AS id, username, first_seen_at, last_seen_at, count FROM slack_pending ORDER BY last_seen_at DESC').all();
    const toolPending = db.prepare('SELECT id, tool_name, created_at, risk_level FROM web_tool_approvals WHERE status = ? ORDER BY created_at DESC').all('pending');
    const rows = [
      ...toolPending.map((r) => ({
        id: `tool:${r.id}`,
        source: 'tool',
        title: r.tool_name,
        summary: `approval required (${r.risk_level})`,
        created_at: r.created_at,
        ts: r.created_at,
      })),
      ...tgPending.map((r) => ({ id: `telegram:${r.id}`, source: 'telegram', title: r.username || r.id, summary: `pending x${r.count || 1}`, created_at: r.first_seen_at, last_seen_at: r.last_seen_at })),
      ...slPending.map((r) => ({ id: `slack:${r.id}`, source: 'slack', title: r.username || r.id, summary: `pending x${r.count || 1}`, created_at: r.first_seen_at, last_seen_at: r.last_seen_at })),
    ];
    res.json(rows);
  });

  r.get('/approvals/active', (_req, res) => {
    const tgAllowed = db.prepare('SELECT chat_id AS id, label, added_at, last_seen_at FROM telegram_allowed ORDER BY added_at DESC').all();
    const slAllowed = db.prepare('SELECT user_id AS id, label, added_at, last_seen_at FROM slack_allowed ORDER BY added_at DESC').all();
    const toolApproved = db.prepare('SELECT id, tool_name, created_at, resolved_at FROM web_tool_approvals WHERE status = ? ORDER BY created_at DESC').all('approved');
    const rows = [
      ...toolApproved.map((r) => ({
        id: `tool:${r.id}`,
        source: 'tool',
        title: r.tool_name,
        summary: 'approved',
        created_at: r.created_at,
        ts: r.resolved_at || r.created_at,
      })),
      ...tgAllowed.map((r) => ({ id: `telegram:${r.id}`, source: 'telegram', title: r.label || r.id, summary: 'allowed', created_at: r.added_at, ts: r.last_seen_at })),
      ...slAllowed.map((r) => ({ id: `slack:${r.id}`, source: 'slack', title: r.label || r.id, summary: 'allowed', created_at: r.added_at, ts: r.last_seen_at })),
    ];
    res.json(rows);
  });

  r.get('/approvals/history', (_req, res) => {
    const tgBlocked = db.prepare('SELECT chat_id AS id, reason, blocked_at FROM telegram_blocked ORDER BY blocked_at DESC').all();
    const slBlocked = db.prepare('SELECT user_id AS id, reason, blocked_at FROM slack_blocked ORDER BY blocked_at DESC').all();
    const toolHistory = db.prepare(`
      SELECT a.id, a.tool_name, a.status, a.reason, a.created_at, a.resolved_at
      FROM web_tool_approvals a
      WHERE a.status IN ('denied', 'approved')
      ORDER BY a.created_at DESC
      LIMIT 200
    `).all();
    const rows = [
      ...toolHistory.map((r) => ({
        id: `tool:${r.id}`,
        source: 'tool',
        title: r.tool_name,
        summary: r.status + (r.reason ? ` (${r.reason})` : ''),
        ts: r.resolved_at || r.created_at,
      })),
      ...tgBlocked.map((r) => ({ id: `telegram:${r.id}`, source: 'telegram', title: r.id, summary: r.reason || 'blocked', ts: r.blocked_at })),
      ...slBlocked.map((r) => ({ id: `slack:${r.id}`, source: 'slack', title: r.id, summary: r.reason || 'blocked', ts: r.blocked_at })),
    ];
    res.json(rows);
  });

  r.post('/approvals/:id/approve', (req, res) => {
    const parsed = parseApprovalId(req.params.id);
    if (!parsed) return res.status(400).json({ ok: false, error: 'Invalid approval id.' });
    if (parsed.source === 'telegram') {
      telegram.approve(parsed.id);
      return res.json({ ok: true });
    }
    if (parsed.source === 'slack') {
      slack.approve(parsed.id);
      return res.json({ ok: true });
    }
    if (parsed.source === 'tool') {
      const row = db.prepare('SELECT id, status FROM web_tool_approvals WHERE id = ?').get(Number(parsed.id));
      if (!row) return res.status(404).json({ ok: false, error: 'Approval not found.' });
      db.prepare(`
        UPDATE web_tool_approvals
        SET status = 'approved', resolved_at = ?, resolved_by_token_fingerprint = ?, reason = NULL
        WHERE id = ?
      `).run(nowIso(), tokenFingerprint(req.adminToken), Number(parsed.id));
      db.prepare(`
        UPDATE web_tool_proposals
        SET status = 'ready'
        WHERE approval_id = ?
      `).run(Number(parsed.id));
      insertWebToolAudit(db, 'APPROVAL_APPROVE', req.adminToken, { approval_id: Number(parsed.id) });
      recordEvent(db, 'tool.approval.approved', { approval_id: Number(parsed.id) });
      return res.json({ ok: true });
    }
    return res.status(400).json({ ok: false, error: 'Unknown approval source.' });
  });

  r.post('/approvals/:id/reject', (req, res) => {
    const parsed = parseApprovalId(req.params.id);
    if (!parsed) return res.status(400).json({ ok: false, error: 'Invalid approval id.' });
    if (parsed.source === 'telegram') {
      telegram.block(parsed.id, req.body?.reason || 'manual');
      return res.json({ ok: true });
    }
    if (parsed.source === 'slack') {
      slack.block(parsed.id, req.body?.reason || 'manual');
      return res.json({ ok: true });
    }
    if (parsed.source === 'tool') {
      const reason = String(req.body?.reason || 'denied').slice(0, 200);
      const row = db.prepare('SELECT id FROM web_tool_approvals WHERE id = ?').get(Number(parsed.id));
      if (!row) return res.status(404).json({ ok: false, error: 'Approval not found.' });
      db.prepare(`
        UPDATE web_tool_approvals
        SET status = 'denied', reason = ?, resolved_at = ?, resolved_by_token_fingerprint = ?
        WHERE id = ?
      `).run(reason, nowIso(), tokenFingerprint(req.adminToken), Number(parsed.id));
      db.prepare(`
        UPDATE web_tool_proposals
        SET status = 'rejected'
        WHERE approval_id = ?
      `).run(Number(parsed.id));
      insertWebToolAudit(db, 'APPROVAL_DENY', req.adminToken, { approval_id: Number(parsed.id), notes: { reason } });
      recordEvent(db, 'tool.approval.denied', { approval_id: Number(parsed.id) });
      return res.json({ ok: true });
    }
    return res.status(400).json({ ok: false, error: 'Unknown approval source.' });
  });

  r.post('/approvals/:id/deny', (req, res) => {
    req.url = `/approvals/${req.params.id}/reject`;
    return r.handle(req, res);
  });

  r.get('/tools/registry', (_req, res) => {
    const rows = Object.values(TOOL_REGISTRY).map((t) => {
      const policy = isToolAllowedByPolicy(db, t.id);
      return {
        id: t.id,
        label: t.label,
        risk: t.risk,
        requiresApproval: t.requiresApproval,
        description: t.description,
        policyAllowed: policy.allowed,
        policyReason: policy.reason,
      };
    });
    res.json(rows);
  });

  r.get('/tools/policy', (_req, res) => {
    res.json({
      allow_list_json: kvGet(db, 'tools.allow_list_json', []),
      deny_list_json: kvGet(db, 'tools.deny_list_json', []),
      per_provider_overrides_json: kvGet(db, 'tools.per_provider_overrides_json', {}),
    });
  });

  r.post('/tools/policy', (req, res) => {
    const allowList = Array.isArray(req.body?.allow_list_json) ? req.body.allow_list_json.map((v) => String(v)) : [];
    const denyList = Array.isArray(req.body?.deny_list_json) ? req.body.deny_list_json.map((v) => String(v)) : [];
    const overrides = req.body?.per_provider_overrides_json && typeof req.body.per_provider_overrides_json === 'object'
      ? req.body.per_provider_overrides_json
      : {};
    kvSet(db, 'tools.allow_list_json', allowList);
    kvSet(db, 'tools.deny_list_json', denyList);
    kvSet(db, 'tools.per_provider_overrides_json', overrides);
    res.json({ ok: true });
  });

  r.get('/tools/proposals', (req, res) => {
    const status = String(req.query.status || 'all');
    const rows = status === 'all'
      ? db.prepare('SELECT * FROM web_tool_proposals ORDER BY created_at DESC LIMIT 300').all()
      : db.prepare('SELECT * FROM web_tool_proposals WHERE status = ? ORDER BY created_at DESC LIMIT 300').all(status);
    res.json(rows.map((row) => toProposalResponse(db, row)));
  });

  r.get('/tools/runs', (req, res) => {
    const limit = Math.max(1, Math.min(Number(req.query.limit || 100) || 100, 500));
    const rows = db.prepare('SELECT * FROM web_tool_runs ORDER BY started_at DESC LIMIT ?').all(limit);
    res.json(rows.map((row) => toRunResponse(row)));
  });

  r.get('/tools/runs/:runId', (req, res) => {
    const row = db.prepare('SELECT * FROM web_tool_runs WHERE id = ?').get(String(req.params.runId));
    if (!row) return res.status(404).json({ ok: false, error: 'Run not found.' });
    res.json({ ok: true, run: toRunResponse(row) });
  });

  r.post('/tools/execute', async (req, res) => {
    const proposalId = String(req.body?.proposal_id || '').trim();
    if (!proposalId) return res.status(400).json({ ok: false, error: 'proposal_id required' });
    const proposalRow = db.prepare('SELECT * FROM web_tool_proposals WHERE id = ?').get(proposalId);
    if (!proposalRow) return res.status(404).json({ ok: false, error: 'Proposal not found.' });
    const proposal = toProposalResponse(db, proposalRow);
    const correlationId = newId('corr');

    if (proposal.executed_run_id) {
      const existing = db.prepare('SELECT * FROM web_tool_runs WHERE id = ?').get(proposal.executed_run_id);
      return res.json({ ok: true, idempotent: true, run_id: proposal.executed_run_id, run: toRunResponse(existing) });
    }

    const policy = isToolAllowedByPolicy(db, proposal.tool_name);
    if (!policy.allowed) {
      return res.status(403).json({
        ok: false,
        code: 'TOOL_DENIED',
        error: policy.reason,
        correlation_id: correlationId,
      });
    }

    if (proposal.requires_approval) {
      const appr = proposal.approval_id
        ? db.prepare('SELECT id, status FROM web_tool_approvals WHERE id = ?').get(Number(proposal.approval_id))
        : null;
      if (!appr) {
        return res.status(403).json({
          ok: false,
          code: 'APPROVAL_REQUIRED',
          error: 'This tool run requires approval in Web Admin.',
          approval_id: proposal.approval_id || null,
          correlation_id: correlationId,
        });
      }
      if (appr.status === 'denied') {
        return res.status(403).json({
          ok: false,
          code: 'APPROVAL_DENIED',
          error: 'This tool run was denied in Approvals.',
          approval_id: proposal.approval_id || null,
          correlation_id: correlationId,
        });
      }
      if (appr.status !== 'approved') {
        return res.status(403).json({
          ok: false,
          code: 'APPROVAL_REQUIRED',
          error: 'This tool run requires approval in Web Admin.',
          approval_id: proposal.approval_id || null,
          correlation_id: correlationId,
        });
      }
    }

    const runId = newId('run');
    const startedAt = nowIso();
    db.prepare(`
      INSERT INTO web_tool_runs
      (id, proposal_id, status, started_at, finished_at, stdout, stderr, result_json, artifacts_json, error_json, correlation_id, args_hash, admin_token_fingerprint, approval_id)
      VALUES (?, ?, 'running', ?, NULL, '', '', NULL, NULL, NULL, ?, ?, ?, ?)
    `).run(
      runId,
      proposal.id,
      startedAt,
      correlationId,
      hashJson(proposal.args_json),
      tokenFingerprint(req.adminToken),
      proposal.approval_id || null
    );
    insertWebToolAudit(db, 'TOOL_RUN_START', req.adminToken, { proposal_id: proposal.id, run_id: runId, approval_id: proposal.approval_id || null });
    recordEvent(db, 'TOOL_RUN_START', {
      run_id: runId,
      proposal_id: proposal.id,
      tool_name: proposal.tool_name,
      risk_level: proposal.risk_level,
    });

    try {
      const workdir = getWorkdir();
      const result = await executeRegisteredTool({
        toolName: proposal.tool_name,
        args: proposal.args_json,
        workdir,
      });
      const finishedAt = nowIso();
      db.prepare(`
        UPDATE web_tool_runs
        SET status = 'succeeded', finished_at = ?, stdout = ?, stderr = ?, result_json = ?, artifacts_json = ?, error_json = NULL
        WHERE id = ?
      `).run(
        finishedAt,
        String(result.stdout || ''),
        String(result.stderr || ''),
        JSON.stringify(result.result ?? {}),
        JSON.stringify(result.artifacts ?? []),
        runId
      );
      db.prepare('UPDATE web_tool_proposals SET status = ?, executed_run_id = ? WHERE id = ?')
        .run('executed', runId, proposal.id);
      insertWebToolAudit(db, 'TOOL_RUN_END', req.adminToken, { proposal_id: proposal.id, run_id: runId, notes: { status: 'succeeded' } });
      recordEvent(db, 'TOOL_RUN_END', {
        run_id: runId,
        proposal_id: proposal.id,
        status: 'succeeded',
      });
      pruneWebToolTables(db);
      const run = db.prepare('SELECT * FROM web_tool_runs WHERE id = ?').get(runId);
      return res.json({ ok: true, run_id: runId, run: toRunResponse(run) });
    } catch (e) {
      const finishedAt = nowIso();
      const errorPayload = {
        message: String(e?.message || e),
        code: e?.code || 'EXEC_FAIL',
        correlation_id: correlationId,
      };
      db.prepare(`
        UPDATE web_tool_runs
        SET status = 'failed', finished_at = ?, error_json = ?, stderr = ?
        WHERE id = ?
      `).run(finishedAt, JSON.stringify(errorPayload), String(e?.stack || e?.message || e), runId);
      db.prepare('UPDATE web_tool_proposals SET status = ?, executed_run_id = ? WHERE id = ?')
        .run('failed', runId, proposal.id);
      insertWebToolAudit(db, 'TOOL_RUN_END', req.adminToken, { proposal_id: proposal.id, run_id: runId, notes: { status: 'failed', error: errorPayload.message } });
      recordEvent(db, 'TOOL_RUN_END', {
        run_id: runId,
        proposal_id: proposal.id,
        status: 'failed',
      });
      const run = db.prepare('SELECT * FROM web_tool_runs WHERE id = ?').get(runId);
      return res.status(500).json({
        ok: false,
        error: errorPayload.message,
        correlation_id: correlationId,
        run_id: runId,
        run: toRunResponse(run),
      });
    }
  });

  r.post('/tools/run', (req, res) => {
    req.url = '/tools/execute';
    return r.handle(req, res);
  });

  r.get('/tools/installed', (_req, res) => {
    if (hasTable(db, 'tool_versions')) {
      const rows = db.prepare('SELECT tool_id, version, status, created_at FROM tool_versions ORDER BY created_at DESC LIMIT 200').all();
      return res.json(rows);
    }
    return res.json(kvGet(db, 'tools.installed', []));
  });

  r.post('/tools/:toolId/enable', (req, res) => {
    const toolId = String(req.params.toolId);
    const installed = kvGet(db, 'tools.installed', []);
    const rows = Array.isArray(installed) ? installed : [];
    const idx = rows.findIndex((r) => String(r.tool_id || r.id) === toolId);
    if (idx >= 0) rows[idx] = { ...rows[idx], status: 'enabled' };
    else rows.push({ tool_id: toolId, status: 'enabled', created_at: nowIso() });
    kvSet(db, 'tools.installed', rows);
    res.json({ ok: true });
  });

  r.post('/tools/:toolId/disable', (req, res) => {
    const toolId = String(req.params.toolId);
    const installed = kvGet(db, 'tools.installed', []);
    const rows = Array.isArray(installed) ? installed : [];
    const idx = rows.findIndex((r) => String(r.tool_id || r.id) === toolId);
    if (idx >= 0) rows[idx] = { ...rows[idx], status: 'disabled' };
    else rows.push({ tool_id: toolId, status: 'disabled', created_at: nowIso() });
    kvSet(db, 'tools.installed', rows);
    res.json({ ok: true });
  });

  r.post('/tools/:toolId/delete', (req, res) => {
    const toolId = String(req.params.toolId);
    const installed = kvGet(db, 'tools.installed', []);
    const rows = (Array.isArray(installed) ? installed : []).filter((r) => String(r.tool_id || r.id) !== toolId);
    kvSet(db, 'tools.installed', rows);
    res.json({ ok: true });
  });

  const handleWebchatSend = async (req, res) => {
    const message = String(req.body?.message || '').trim();
    const sessionId = String(req.body?.session_id || 'webchat-default');
    const messageId = String(req.body?.message_id || newId('msg'));
    if (!message) return res.status(400).json({ ok: false, error: 'message required' });

    let reply = '';
    let model = null;
    let provider = null;
    let candidate = parseToolCommand(message);

    if (!candidate) {
      const out = await llmChatOnce({ db, messageText: message, timeoutMs: 90_000 });
      if (!out.ok) return res.status(502).json({ ok: false, error: out.error || 'WebChat failed' });
      reply = String(out.text || '').trim();
      model = out.model || null;
      provider = out.profile || null;
      candidate = parseToolProposalFromReply(reply);
    } else {
      reply = `Drafted tool proposal for \`${candidate.toolName}\`. Review the card below and click Invoke tool to run it on server.`;
    }

    let proposal = null;
    if (candidate && TOOL_REGISTRY[candidate.toolName]) {
      const def = TOOL_REGISTRY[candidate.toolName];
      proposal = createProposal(db, {
        sessionId,
        messageId,
        toolName: candidate.toolName,
        args: candidate.args,
        summary: def.description,
      });
      insertWebToolAudit(db, 'PROPOSAL_CREATE', req.adminToken, { proposal_id: proposal.id, notes: { tool_name: candidate.toolName } });
      recordEvent(db, 'tool.proposal.created', {
        proposal_id: proposal.id,
        tool_name: candidate.toolName,
        risk_level: proposal.risk_level,
      });
    }

    return res.json({
      ok: true,
      session_id: sessionId,
      message_id: messageId,
      reply,
      model,
      provider,
      proposal,
    });
  };

  r.post('/webchat/send', handleWebchatSend);
  r.post('/chat/send', handleWebchatSend);
  r.post('/webchat/message', handleWebchatSend);

  r.get('/webchat/status', (_req, res) => {
    res.json({
      providerId: kvGet(db, 'llm.providerId', 'textwebui'),
      providerName: kvGet(db, 'llm.providerName', 'Text WebUI'),
      selectedModel: kvGet(db, 'llm.selectedModel', null),
      workdir: getWorkdir(),
    });
  });

  r.post('/settings/advanced', (req, res) => {
    try {
      const { unknown_autoblock_violations, unknown_autoblock_window_minutes, rate_limit_per_minute } = req.body || {};
      const data = readEnvFile(dataDir);
      data.env = data.env || {};
      data.env.PROWORKBENCH_UNKNOWN_AUTOBLOCK_VIOLATIONS = String(Math.max(1, Number(unknown_autoblock_violations || 3)));
      data.env.PROWORKBENCH_UNKNOWN_AUTOBLOCK_WINDOW_MINUTES = String(Math.max(1, Number(unknown_autoblock_window_minutes || 10)));
      data.env.PROWORKBENCH_RATE_LIMIT_PER_MINUTE = String(Math.max(1, Number(rate_limit_per_minute || 20)));
      writeEnvFile(dataDir, data.env);
      process.env.PROWORKBENCH_UNKNOWN_AUTOBLOCK_VIOLATIONS = data.env.PROWORKBENCH_UNKNOWN_AUTOBLOCK_VIOLATIONS;
      process.env.PROWORKBENCH_UNKNOWN_AUTOBLOCK_WINDOW_MINUTES = data.env.PROWORKBENCH_UNKNOWN_AUTOBLOCK_WINDOW_MINUTES;
      process.env.PROWORKBENCH_RATE_LIMIT_PER_MINUTE = data.env.PROWORKBENCH_RATE_LIMIT_PER_MINUTE;
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  return r;
}
