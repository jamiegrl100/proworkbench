import { getLocalDayKey, localDayKeyDaysAgo } from './date.js';
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export function nowIso() {
  return new Date().toISOString();
}

export function isoToLocalDay(tsIso) {
  return getLocalDayKey(tsIso ? new Date(tsIso) : new Date());
}

export function isValidDay(day) {
  return DAY_RE.test(String(day || ''));
}

export function appendMemoryEntry(db, { kind = 'note', content, meta = null }) {
  const text = String(content || '').trim();
  if (!text) {
    const err = new Error('content required');
    err.code = 'MEMORY_CONTENT_REQUIRED';
    throw err;
  }
  const ts = nowIso();
  const day = isoToLocalDay(ts);
  const k = String(kind || 'note').slice(0, 64) || 'note';
  const metaJson = meta == null ? null : JSON.stringify(meta);
  const info = db
    .prepare('INSERT INTO memory_entries (ts, day, kind, content, meta_json) VALUES (?, ?, ?, ?, ?)')
    .run(ts, day, k, text, metaJson);
  return db.prepare('SELECT * FROM memory_entries WHERE id = ?').get(Number(info.lastInsertRowid));
}

function snippet(content, q) {
  const s = String(content || '');
  if (!q) return s.length > 200 ? `${s.slice(0, 200)}...` : s;
  const i = s.toLowerCase().indexOf(String(q).toLowerCase());
  if (i < 0) return s.length > 200 ? `${s.slice(0, 200)}...` : s;
  const start = Math.max(0, i - 60);
  const end = Math.min(s.length, i + String(q).length + 120);
  const slice = s.slice(start, end);
  return `${start > 0 ? '...' : ''}${slice}${end < s.length ? '...' : ''}`;
}

export function searchMemoryEntries(db, { q = '', startDay = '', endDay = '', limit = 100 }) {
  const max = Math.max(1, Math.min(Number(limit || 100) || 100, 500));
  const where = ['1=1'];
  const args = [];
  const query = String(q || '').trim();

  if (query) {
    where.push('(content LIKE ? OR meta_json LIKE ?)');
    const pat = `%${query}%`;
    args.push(pat, pat);
  }
  if (startDay && isValidDay(startDay)) {
    where.push('day >= ?');
    args.push(startDay);
  }
  if (endDay && isValidDay(endDay)) {
    where.push('day <= ?');
    args.push(endDay);
  }

  const rows = db
    .prepare(
      `SELECT id, ts, day, kind, content, meta_json
       FROM memory_entries
       WHERE ${where.join(' AND ')}
       ORDER BY ts DESC, id DESC
       LIMIT ?`
    )
    .all(...args, max);

  const grouped = {};
  for (const row of rows) {
    const d = String(row.day || '');
    if (!grouped[d]) grouped[d] = { day: d, count: 0, entries: [] };
    grouped[d].count += 1;
    grouped[d].entries.push({
      id: row.id,
      ts: row.ts,
      day: d,
      kind: row.kind,
      content: row.content,
      snippet: snippet(row.content, query),
      meta: row.meta_json ? safeParse(row.meta_json, null) : null,
    });
  }
  return {
    total: rows.length,
    groups: Object.values(grouped).sort((a, b) => String(b.day).localeCompare(String(a.day))),
  };
}

export function deleteMemoryDay(db, { day }) {
  const d = String(day || '').trim();
  if (!isValidDay(d)) {
    const err = new Error('invalid day');
    err.code = 'MEMORY_INVALID_DAY';
    throw err;
  }
  const count = Number(db.prepare('SELECT COUNT(1) AS c FROM memory_entries WHERE day = ?').get(d)?.c || 0);
  const info = db.prepare('DELETE FROM memory_entries WHERE day = ?').run(d);
  return { day: d, deleted: Number(info.changes || 0), matched: count };
}

export function pruneMemoryOlderThanDays(db, days) {
  const keep = Math.max(1, Math.min(Number(days || 30) || 30, 3650));
  const cutoff = localDayKeyDaysAgo(keep);
  const info = db.prepare('DELETE FROM memory_entries WHERE day < ?').run(cutoff);
  return { keep_days: keep, cutoff_day: cutoff, deleted: Number(info.changes || 0) };
}

export function getMemoryRetentionDays(db) {
  try {
    const row = db.prepare('SELECT value_json FROM app_kv WHERE key = ?').get('memory.retention_days');
    if (row?.value_json != null) {
      const raw = JSON.parse(row.value_json);
      const n = Math.max(1, Math.min(Number(raw || 30) || 30, 3650));
      return n;
    }
  } catch {
    // ignore
  }
  return Math.max(1, Math.min(Number(process.env.PB_MEMORY_RETENTION_DAYS || 30) || 30, 3650));
}

function safeParse(text, fallback) {
  try {
    return JSON.parse(String(text || ''));
  } catch {
    return fallback;
  }
}
