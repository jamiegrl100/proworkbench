import express from 'express';
import { requireAuth } from './middleware.js';
import { assertWebchatOnly } from './channel.js';
import { createItem as createCanvasItem } from '../canvas/service.js';

function safeInt(v, def) {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

function hasTable(db, name) {
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
  return Boolean(row);
}

function mapFilterToKinds(filter) {
  const f = String(filter || 'all').toLowerCase();
  if (f === 'tools') return ['tool_result'];
  if (f === 'mcp') return ['mcp_result'];
  if (f === 'doctor') return ['doctor_report'];
  if (f === 'reports') return ['report'];
  if (f === 'helpers' || f === 'agents') return ['agent_result'];
  if (f === 'notes') return ['note'];
  if (f === 'all' || !f) return null;
  // allow passing exact kind
  return [f];
}

export function createCanvasRouter({ db }) {
  const r = express.Router();
  r.use(requireAuth(db));

  r.get('/items', (req, res) => {
    if (!assertWebchatOnly(req, res)) return;
    if (!hasTable(db, 'canvas_items')) return res.json({ ok: true, total: 0, items: [] });
    const filter = req.query.filter;
    const q = String(req.query.q || '').trim();
    const pinnedRaw = req.query.pinned;
    const pinned = pinnedRaw === undefined ? null : (String(pinnedRaw) === '1' || String(pinnedRaw).toLowerCase() === 'true' ? 1 : 0);
    const limit = Math.max(1, Math.min(safeInt(req.query.limit, 50), 200));
    const offset = Math.max(0, safeInt(req.query.offset, 0));

    const where = ['1=1'];
    const args = [];
    const kinds = mapFilterToKinds(filter);
    if (kinds && kinds.length > 0) {
      where.push(`kind IN (${kinds.map(() => '?').join(',')})`);
      args.push(...kinds);
    }
    if (pinned !== null) {
      where.push('pinned = ?');
      args.push(pinned);
    }
    if (q) {
      where.push('(title LIKE ? OR summary LIKE ? OR content_text LIKE ?)');
      const pat = `%${q}%`;
      args.push(pat, pat, pat);
    }

    const whereSql = where.join(' AND ');
    const total = Number(db.prepare(`SELECT COUNT(1) AS c FROM canvas_items WHERE ${whereSql}`).get(...args)?.c || 0);
    const rows = db.prepare(
      `SELECT id, created_at, updated_at, status, kind, title, summary, content_type, content_text, raw_text, pinned, source_ref_type, source_ref_id, truncated
       FROM canvas_items
       WHERE ${whereSql}
       ORDER BY datetime(created_at) DESC
       LIMIT ? OFFSET ?`
    ).all(...args, limit, offset);
    res.json({ ok: true, total, items: rows });
  });

  r.post('/items', (req, res) => {
    if (!assertWebchatOnly(req, res)) return;
    try {
      if (!hasTable(db, 'canvas_items')) return res.status(500).json({ ok: false, error: 'canvas_items table missing' });
      const body = req.body || {};
      const item = createCanvasItem(db, {
        status: body.status,
        kind: body.kind,
        title: body.title,
        summary: body.summary,
        content_type: body.content_type,
        content: body.content,
        raw: body.raw,
        pinned: body.pinned,
        source_ref_type: body.source_ref_type,
        source_ref_id: body.source_ref_id,
      });
      res.json({ ok: true, item });
    } catch (e) {
      res.status(400).json({ ok: false, error: String(e?.message || e) });
    }
  });

  r.patch('/items/:id', (req, res) => {
    if (!assertWebchatOnly(req, res)) return;
    try {
      const id = String(req.params.id || '').trim();
      if (!id) return res.status(400).json({ ok: false, error: 'id required' });
      const row = db.prepare('SELECT * FROM canvas_items WHERE id = ?').get(id);
      if (!row) return res.status(404).json({ ok: false, error: 'Not found' });
      const body = req.body || {};
      const title = body.title !== undefined ? String(body.title || '').slice(0, 200) : row.title;
      const summary = body.summary !== undefined ? String(body.summary || '').slice(0, 500) : row.summary;
      const pinned = body.pinned === undefined ? row.pinned : (body.pinned ? 1 : 0);
      db.prepare(
        'UPDATE canvas_items SET title = ?, summary = ?, pinned = ?, updated_at = ? WHERE id = ?'
      ).run(title, summary, pinned, new Date().toISOString(), id);
      const out = db.prepare('SELECT * FROM canvas_items WHERE id = ?').get(id);
      res.json({ ok: true, item: out });
    } catch (e) {
      res.status(400).json({ ok: false, error: String(e?.message || e) });
    }
  });

  r.delete('/items/:id', (req, res) => {
    if (!assertWebchatOnly(req, res)) return;
    const id = String(req.params.id || '').trim();
    if (!id) return res.status(400).json({ ok: false, error: 'id required' });
    const row = db.prepare('SELECT id, pinned FROM canvas_items WHERE id = ?').get(id);
    if (!row) return res.status(404).json({ ok: false, error: 'Not found' });
    db.prepare('DELETE FROM canvas_items WHERE id = ?').run(id);
    res.json({ ok: true });
  });

  return r;
}
