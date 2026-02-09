import express from 'express';
import { requireAuth } from './middleware.js';

export function createEventsRouter({ db, csrfProtection }) {
  const r = express.Router();
  r.use(requireAuth(db));

  r.get('/', (req, res) => {
    const limit = Math.min(Number(req.query.limit || 200) || 200, 500);
    const type = req.query.type ? String(req.query.type) : null;

    const rows = type
      ? db.prepare('SELECT id, ts, type, payload_json FROM security_events WHERE type = ? ORDER BY id DESC LIMIT ?').all(type, limit)
      : db.prepare('SELECT id, ts, type, payload_json FROM security_events ORDER BY id DESC LIMIT ?').all(limit);

    const events = rows.reverse().map((r) => ({
      id: r.id,
      ts: r.ts,
      type: r.type,
      payload: (() => { try { return JSON.parse(r.payload_json); } catch { return {}; } })(),
    }));

    const types = db.prepare('SELECT type, COUNT(1) AS c FROM security_events GROUP BY type ORDER BY c DESC').all();

    res.json({ events, types });
  });

  r.post('/clear', csrfProtection, (req, res) => {
    db.prepare('DELETE FROM security_events').run();
    res.json({ ok: true });
  });

  return r;
}
