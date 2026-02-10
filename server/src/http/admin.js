import express from 'express';
import { requireAuth } from './middleware.js';
import { readEnvFile, writeEnvFile } from '../util/envStore.js';
import { llmChatOnce } from '../llm/llmClient.js';

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

function parseApprovalId(value) {
  const raw = String(value || '');
  const i = raw.indexOf(':');
  if (i <= 0) return null;
  return { source: raw.slice(0, i), id: raw.slice(i + 1) };
}

export function createAdminRouter({ db, telegram, slack, dataDir }) {
  const r = express.Router();
  r.use(requireAuth(db));

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

  // Simple approvals API. If dedicated approvals tables do not exist, use channel pending/allowed/blocked.
  r.get('/approvals/pending', (_req, res) => {
    const tgPending = db.prepare('SELECT chat_id AS id, username, first_seen_at, last_seen_at, count FROM telegram_pending ORDER BY last_seen_at DESC').all();
    const slPending = db.prepare('SELECT user_id AS id, username, first_seen_at, last_seen_at, count FROM slack_pending ORDER BY last_seen_at DESC').all();
    const rows = [
      ...tgPending.map((r) => ({ id: `telegram:${r.id}`, source: 'telegram', title: r.username || r.id, summary: `pending x${r.count || 1}`, created_at: r.first_seen_at, last_seen_at: r.last_seen_at })),
      ...slPending.map((r) => ({ id: `slack:${r.id}`, source: 'slack', title: r.username || r.id, summary: `pending x${r.count || 1}`, created_at: r.first_seen_at, last_seen_at: r.last_seen_at })),
    ];
    res.json(rows);
  });

  r.get('/approvals/active', (_req, res) => {
    const tgAllowed = db.prepare('SELECT chat_id AS id, label, added_at, last_seen_at FROM telegram_allowed ORDER BY added_at DESC').all();
    const slAllowed = db.prepare('SELECT user_id AS id, label, added_at, last_seen_at FROM slack_allowed ORDER BY added_at DESC').all();
    const rows = [
      ...tgAllowed.map((r) => ({ id: `telegram:${r.id}`, source: 'telegram', title: r.label || r.id, summary: 'allowed', created_at: r.added_at, ts: r.last_seen_at })),
      ...slAllowed.map((r) => ({ id: `slack:${r.id}`, source: 'slack', title: r.label || r.id, summary: 'allowed', created_at: r.added_at, ts: r.last_seen_at })),
    ];
    res.json(rows);
  });

  r.get('/approvals/history', (_req, res) => {
    const tgBlocked = db.prepare('SELECT chat_id AS id, reason, blocked_at FROM telegram_blocked ORDER BY blocked_at DESC').all();
    const slBlocked = db.prepare('SELECT user_id AS id, reason, blocked_at FROM slack_blocked ORDER BY blocked_at DESC').all();
    const rows = [
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
    return res.status(400).json({ ok: false, error: 'Unknown approval source.' });
  });

  // Minimal tools endpoints backed by app_kv when dedicated tables are unavailable.
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
    const status = String(req.query.status || 'draft');
    if (hasTable(db, 'tool_proposals')) {
      const rows = db.prepare('SELECT * FROM tool_proposals WHERE status = ? ORDER BY created_at DESC LIMIT 200').all(status);
      return res.json(rows);
    }
    return res.json([]);
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
    else rows.push({ tool_id: toolId, status: 'enabled', created_at: new Date().toISOString() });
    kvSet(db, 'tools.installed', rows);
    res.json({ ok: true });
  });

  r.post('/tools/:toolId/disable', (req, res) => {
    const toolId = String(req.params.toolId);
    const installed = kvGet(db, 'tools.installed', []);
    const rows = Array.isArray(installed) ? installed : [];
    const idx = rows.findIndex((r) => String(r.tool_id || r.id) === toolId);
    if (idx >= 0) rows[idx] = { ...rows[idx], status: 'disabled' };
    else rows.push({ tool_id: toolId, status: 'disabled', created_at: new Date().toISOString() });
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

  // Minimal webchat endpoint that uses server-selected provider/model pipeline.
  r.post('/webchat/send', async (req, res) => {
    const message = String(req.body?.message || '').trim();
    if (!message) return res.status(400).json({ ok: false, error: 'message required' });
    const out = await llmChatOnce({ db, messageText: message, timeoutMs: 90_000 });
    if (!out.ok) return res.status(502).json({ ok: false, error: out.error || 'WebChat failed' });
    return res.json({ ok: true, reply: out.text, model: out.model || null, provider: out.profile || null });
  });

  r.get('/webchat/status', (_req, res) => {
    res.json({
      providerId: kvGet(db, 'llm.providerId', 'textwebui'),
      providerName: kvGet(db, 'llm.providerName', 'Text WebUI'),
      selectedModel: kvGet(db, 'llm.selectedModel', null),
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
