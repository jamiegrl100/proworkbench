import express from 'express';
import { requireAuth } from './middleware.js';

export function createAdminRouter({ db, csrfProtection, telegram, slack, dataDir }) {
  const r = express.Router();
  r.use(requireAuth(db));

  r.get('/telegram/users', (req, res) => {
    const allowed = db.prepare('SELECT * FROM telegram_allowed ORDER BY added_at DESC').all();
    const pending = db.prepare('SELECT * FROM telegram_pending ORDER BY last_seen_at DESC').all();
    const blocked = db.prepare('SELECT * FROM telegram_blocked ORDER BY blocked_at DESC').all();
    const overflowRow = db.prepare('SELECT value_json FROM app_kv WHERE key = ?').get('telegram.pendingOverflowActive');
    const pendingOverflowActive = overflowRow ? JSON.parse(overflowRow.value_json) : false;
    res.json({ allowed, pending, blocked, pendingCount: pending.length, pendingCap: 500, pendingOverflowActive });
  });

  r.post('/telegram/:chatId/approve', csrfProtection, (req, res) => {
    const chatId = req.params.chatId;
    telegram.approve(chatId);
    res.json({ ok: true });
  });

  r.post('/telegram/:chatId/block', csrfProtection, (req, res) => {
    const chatId = req.params.chatId;
    const reason = req.body?.reason || 'manual';
    telegram.block(chatId, reason);
    res.json({ ok: true });
  });

  r.post('/telegram/:chatId/restore', csrfProtection, (req, res) => {
    const chatId = req.params.chatId;
    telegram.restore(chatId);
    res.json({ ok: true });
  });

r.get('/telegram/worker/status', (req, res) => {
  res.json({ running: Boolean(telegram.state?.running), startedAt: telegram.state?.startedAt || null, lastError: telegram.state?.lastError || null });
});

r.post('/telegram/worker/start', csrfProtection, async (req, res) => {
  try {
    await telegram.startIfReady();
    res.json({ ok: true, running: Boolean(telegram.state?.running) });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

r.post('/telegram/worker/restart', csrfProtection, async (req, res) => {
  try {
    telegram.stopNow();
    await telegram.startIfReady();
    res.json({ ok: true, running: Boolean(telegram.state?.running) });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

r.post('/telegram/worker/stop', csrfProtection, (req, res) => {
  try {
    telegram.stopNow();
    res.json({ ok: true, running: Boolean(telegram.state?.running) });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});


// Slack (Socket Mode, DM-only) access control
r.get('/slack/users', (req, res) => {
  const allowed = db.prepare('SELECT * FROM slack_allowed ORDER BY added_at DESC').all();
  const pending = db.prepare('SELECT * FROM slack_pending ORDER BY last_seen_at DESC').all();
  const blocked = db.prepare('SELECT * FROM slack_blocked ORDER BY blocked_at DESC').all();
  res.json({ allowed, pending, blocked, pendingCount: pending.length, pendingCap: 500 });
});

r.post('/slack/:userId/approve', csrfProtection, (req, res) => {
  slack.approve(req.params.userId);
  res.json({ ok: true });
});

r.post('/slack/:userId/block', csrfProtection, (req, res) => {
  slack.block(req.params.userId, req.body?.reason || 'manual');
  res.json({ ok: true });
});

r.post('/slack/:userId/restore', csrfProtection, (req, res) => {
  slack.restore(req.params.userId);
  res.json({ ok: true });
});

r.get('/slack/worker/status', (_req, res) => res.json(slack.meta()));
r.post('/slack/worker/start', csrfProtection, async (_req, res) => {
  try { await slack.startIfReady(); res.json({ ok: true, ...slack.meta() }); }
  catch (e) { res.status(500).json({ ok: false, error: String(e?.message || e) }); }
});
r.post('/slack/worker/restart', csrfProtection, async (_req, res) => {
  try { await slack.restart(); res.json({ ok: true, ...slack.meta() }); }
  catch (e) { res.status(500).json({ ok: false, error: String(e?.message || e) }); }
});
r.post('/slack/worker/stop', csrfProtection, (_req, res) => {
  try { slack.stopNow(); res.json({ ok: true, ...slack.meta() }); }
  catch (e) { res.status(500).json({ ok: false, error: String(e?.message || e) }); }
});


r.post('/settings/advanced', csrfProtection, (req, res) => {
  try {
    const { unknown_autoblock_violations, unknown_autoblock_window_minutes, rate_limit_per_minute } = req.body || {};

    const data = readEnvFile(dataDir);
    data.PROWORKBENCH_UNKNOWN_AUTOBLOCK_VIOLATIONS = String(Math.max(1, Number(unknown_autoblock_violations || 3)));
    data.PROWORKBENCH_UNKNOWN_AUTOBLOCK_WINDOW_MINUTES = String(Math.max(1, Number(unknown_autoblock_window_minutes || 10)));
    data.PROWORKBENCH_RATE_LIMIT_PER_MINUTE = String(Math.max(1, Number(rate_limit_per_minute || 20)));
    writeEnvFile(dataDir, data);

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

  return r;
}
