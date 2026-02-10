import express from 'express';
import { requireAuth } from './middleware.js';
import { todayKey } from '../util/securityDaily.js';
import { recordEvent } from '../util/events.js';

function nowIso() {
  return new Date().toISOString();
}

function getKv(db, key, fallback) {
  const row = db.prepare('SELECT value_json FROM app_kv WHERE key = ?').get(key);
  return row ? JSON.parse(row.value_json) : fallback;
}

function setKv(db, key, value) {
  db.prepare('INSERT INTO app_kv (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json')
    .run(key, JSON.stringify(value));
}

export function createSecurityRouter({ db }) {
  const r = express.Router();
  r.use(requireAuth(db));

  r.get('/summary', (req, res) => {
  try {
    const dateKey = todayKey();

    const hasTable = (name) => {
      try {
        return Boolean(
          db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?").get(name)
        );
      } catch {
        return false;
      }
    };

    const today = hasTable('security_daily')
      ? (db.prepare('SELECT * FROM security_daily WHERE date_key = ?').get(dateKey) || { date_key: dateKey })
      : { date_key: dateKey };

    const pendingOverflowActive = Boolean(getKv(db, 'telegram.pendingOverflowActive', false));

    const last = hasTable('security_reports')
      ? (db.prepare('SELECT ts, kind FROM security_reports ORDER BY id DESC LIMIT 1').get() || null)
      : null;

    const lastReportTs = last?.ts || null;
    const nextScheduledReportTs = getKv(db, 'security.nextScheduledReportTs', null);

    const todayAutoBlocks = hasTable('security_events')
      ? Number(
          db
            .prepare(
              "SELECT COUNT(1) AS c FROM security_events WHERE ts LIKE ? AND type IN ('telegram.auto_block_unknown_spam','telegram.auto_block_rate_limit')"
            )
            .get(`${dateKey}%`)?.c || 0
        )
      : 0;

    const unknownAutoBlock = {
      violations: Math.max(1, Number(process.env.PROWORKBENCH_UNKNOWN_AUTOBLOCK_VIOLATIONS || 3)),
      window_minutes: Math.max(1, Number(process.env.PROWORKBENCH_UNKNOWN_AUTOBLOCK_WINDOW_MINUTES || 10)),
    };

    const rateLimit = {
      per_minute: Math.max(1, Number(process.env.PROWORKBENCH_RATE_LIMIT_PER_MINUTE || 20)),
    };

    const defaultEventTypes = [
      'telegram.unknown_message',
      'telegram.blocked_message',
      'telegram.rate_limited',
      'telegram.auto_block_unknown_spam',
      'telegram.auto_block_rate_limit',
      'telegram.pending_overflow',
      'security.report.emitted',
    ];

    // top unknown chat ids today (aggregated)
    const topUnknownToday = (() => {
      if (!hasTable('security_events')) return [];
      const rows = db
        .prepare("SELECT payload_json FROM security_events WHERE ts LIKE ? AND type = 'telegram.unknown_message'")
        .all(`${dateKey}%`);
      const counts = new Map();
      for (const r of rows) {
        try {
          const p = JSON.parse(r.payload_json || '{}');
          const id = String(p.chat_id || '');
          if (!id) continue;
          counts.set(id, (counts.get(id) || 0) + 1);
        } catch {
          // ignore bad payload_json
        }
      }
      return Array.from(counts.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([chat_id, count]) => ({ chat_id, count }));
    })();

    res.json({
      ok: true,
      dateKey,
      today,
      todayAutoBlocks,
      unknownAutoBlock,
      rateLimit,
      defaultEventTypes,
      pendingOverflowActive,
      lastReportTs,
      nextScheduledReportTs,
      topUnknownToday,
      reportCadence: 'daily',
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

  r.get('/reports', (req, res) => {
  try {
    const hasTable = (name) => {
      try {
        return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?").get(name));
      } catch {
        return false;
      }
    };

    if (!hasTable('security_reports')) return res.json({ ok: true, reports: [] });

    const rows = db
      .prepare('SELECT id, ts, kind, payload_json FROM security_reports ORDER BY id DESC LIMIT 10')
      .all();

    const reports = rows
      .map((r) => {
        let payload = null;
        try {
          payload = JSON.parse(r.payload_json || 'null');
        } catch {
          payload = null;
        }
        return { id: r.id, ts: r.ts, kind: r.kind, payload };
      })
      .reverse();

    res.json({ ok: true, reports });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

  r.post('/report/run', (req, res) => {
    const { critical } = req.body || {};
    const isCritical = Boolean(critical);

    const dateKey = todayKey();
    const today = db.prepare('SELECT * FROM security_daily WHERE date_key = ?').get(dateKey) || null;
    if (!today) return res.status(200).json({ ok: true, skipped: true, reason: 'no-data-row' });

    const hasData =
      Number(today.unknown_msg_count || 0) +
        Number(today.blocked_msg_count || 0) +
        Number(today.rate_limited_count || 0) +
        Number(today.pending_overflow_drop_count || 0) >
      0;

    if (!hasData) return res.status(200).json({ ok: true, skipped: true, reason: 'no-data' });

    if (!isCritical && Number(today.report_emitted || 0) === 1) {
      return res.status(200).json({ ok: true, skipped: true, reason: 'already-emitted-today' });
    }

    const payload = {
      dateKey,
      unknown_msg_count: Number(today.unknown_msg_count || 0),
      blocked_msg_count: Number(today.blocked_msg_count || 0),
      rate_limited_count: Number(today.rate_limited_count || 0),
      pending_overflow_drop_count: Number(today.pending_overflow_drop_count || 0),
      pending_overflow_unique_count: Number(today.pending_overflow_unique_count || 0),
      first_drop_ts: today.first_drop_ts || null,
      last_drop_ts: today.last_drop_ts || null,
      pendingOverflowActive: Boolean(getKv(db, 'telegram.pendingOverflowActive', false)),
    };

    const ts = nowIso();
    db.prepare('INSERT INTO security_reports (ts, kind, payload_json) VALUES (?, ?, ?)')
      .run(ts, isCritical ? 'critical' : 'daily', JSON.stringify(payload));

    if (!isCritical) {
      db.prepare('UPDATE security_daily SET report_emitted = 1, report_emitted_ts = ? WHERE date_key = ?').run(ts, dateKey);
    }

    recordEvent(db, 'security.report.emitted', { kind: isCritical ? 'critical' : 'daily', date_key: dateKey });
    setKv(db, 'security.lastReportTs', ts);

const autoBlocks = db.prepare(
  "SELECT COUNT(1) AS c FROM security_events WHERE ts LIKE ? AND type IN ('telegram.auto_block_unknown_spam','telegram.auto_block_rate_limit')"
).get(`${dateKey}%`);
const todayAutoBlocks = Number(autoBlocks?.c || 0);

const unknownAutoBlock = {
  violations: Math.max(1, Number(process.env.PROWORKBENCH_UNKNOWN_AUTOBLOCK_VIOLATIONS || 3)),
  window_minutes: Math.max(1, Number(process.env.PROWORKBENCH_UNKNOWN_AUTOBLOCK_WINDOW_MINUTES || 10)),
};
const rateLimit = {
  per_minute: Math.max(1, Number(process.env.PROWORKBENCH_RATE_LIMIT_PER_MINUTE || 20)),
};
const defaultEventTypes = [
  'telegram.unknown_message',
  'telegram.blocked_message',
  'telegram.rate_limited',
  'telegram.auto_block_unknown_spam',
  'telegram.auto_block_rate_limit',
  'telegram.pending_overflow',
  'security.report.emitted',
];

    // top unknown chat ids today (aggregated)
    const unknownRows = db.prepare("SELECT ts, payload_json FROM security_events WHERE ts LIKE ? AND type = 'telegram.unknown_message'").all(`${dateKey}%`);
    const counts = new Map();
    for (const r of unknownRows) {
      try {
        const p = JSON.parse(r.payload_json || '{}');
        const id = String(p.chat_id || '');
        if (!id) continue;
        counts.set(id, (counts.get(id) || 0) + 1);
      } catch {
        // ignore
      }
    }
    const topUnknownToday = Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([chat_id, count]) => ({ chat_id, count }));

    res.json({
 ok: true, kind: isCritical ? 'critical' : 'daily', ts });
  });

  return r;
}
