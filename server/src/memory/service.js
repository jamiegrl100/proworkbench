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

function safeParse(text, fallback) {
  try {
    return JSON.parse(String(text || ''));
  } catch {
    return fallback;
  }
}

function tableExists(db, tableName) {
  try {
    const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(String(tableName));
    return Boolean(row?.name);
  } catch {
    return false;
  }
}

function normalizeTags(tags) {
  if (!Array.isArray(tags)) return [];
  return tags
    .map((x) => String(x || '').trim())
    .filter(Boolean)
    .slice(0, 32);
}

export function createMemoryDraft(db, {
  content,
  kind = 'note',
  title = null,
  tags = [],
  sourceSessionId = null,
  userId = null,
  workspaceId = null,
  agentId = null,
  meta = null,
}) {
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
    .prepare(`INSERT INTO memory_entries
      (ts, day, kind, content, meta_json, state, committed_at, title, tags_json, source_session_id, user_id, workspace_id, agent_id)
      VALUES (?, ?, ?, ?, ?, 'draft', NULL, ?, ?, ?, ?, ?, ?)`)
    .run(
      ts,
      day,
      k,
      text,
      metaJson,
      title ? String(title).slice(0, 200) : null,
      JSON.stringify(normalizeTags(tags)),
      sourceSessionId ? String(sourceSessionId).slice(0, 120) : null,
      userId ? String(userId).slice(0, 120) : null,
      workspaceId ? String(workspaceId).slice(0, 120) : null,
      agentId ? String(agentId).slice(0, 120) : null,
    );
  return db.prepare('SELECT * FROM memory_entries WHERE id = ?').get(Number(info.lastInsertRowid));
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
    .prepare('INSERT INTO memory_entries (ts, day, kind, content, meta_json, state, committed_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(ts, day, k, text, metaJson, 'committed', ts);
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

export function listMemoryDrafts(db, { limit = 200 } = {}) {
  const max = Math.max(1, Math.min(Number(limit || 200) || 200, 500));
  const rows = db.prepare(`
    SELECT id, ts, day, kind, content, title, tags_json, source_session_id, user_id, workspace_id, agent_id, meta_json
    FROM memory_entries
    WHERE state = 'draft'
    ORDER BY ts DESC, id DESC
    LIMIT ?
  `).all(max);
  return rows.map((row) => ({
    id: Number(row.id),
    ts: row.ts,
    day: row.day,
    kind: row.kind,
    content: row.content,
    title: row.title,
    tags: safeParse(row.tags_json, []),
    source_session_id: row.source_session_id,
    user_id: row.user_id,
    workspace_id: row.workspace_id,
    agent_id: row.agent_id,
    meta: row.meta_json ? safeParse(row.meta_json, null) : null,
  }));
}

export function commitMemoryDrafts(db, { ids = null } = {}) {
  const ts = nowIso();
  const hasArchive = tableExists(db, 'memory_archive');
  const draftRows = Array.isArray(ids) && ids.length > 0
    ? (() => {
        const intIds = ids.map((x) => Number(x)).filter((x) => Number.isFinite(x) && x > 0);
        if (!intIds.length) return [];
        const placeholders = intIds.map(() => '?').join(',');
        return db.prepare(`
          SELECT id, ts, day, kind, content, meta_json, title, tags_json, source_session_id, user_id, workspace_id, agent_id
          FROM memory_entries
          WHERE state = 'draft' AND id IN (${placeholders})
          ORDER BY id ASC
        `).all(...intIds);
      })()
    : db.prepare(`
        SELECT id, ts, day, kind, content, meta_json, title, tags_json, source_session_id, user_id, workspace_id, agent_id
        FROM memory_entries
        WHERE state = 'draft'
        ORDER BY id ASC
      `).all();

  if (!draftRows.length) return { committed: 0, ids: [], archived: 0 };

  if (hasArchive) {
    const insertArchive = db.prepare(`
      INSERT OR IGNORE INTO memory_archive
        (memory_entry_id, ts, day, kind, content, title, tags_json, source_session_id, user_id, workspace_id, agent_id, meta_json, committed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const tx = db.transaction(() => {
      for (const row of draftRows) {
        const rowTs = String(row.ts || ts);
        insertArchive.run(
          Number(row.id),
          rowTs,
          String(row.day || isoToLocalDay(rowTs)),
          String(row.kind || 'note'),
          String(row.content || ''),
          row.title || null,
          row.tags_json || '[]',
          row.source_session_id || null,
          row.user_id || null,
          row.workspace_id || null,
          row.agent_id || null,
          row.meta_json || null,
          ts,
        );
      }
    });
    tx();
  }

  if (Array.isArray(ids) && ids.length > 0) {
    const intIds = ids.map((x) => Number(x)).filter((x) => Number.isFinite(x) && x > 0);
    if (!intIds.length) return { committed: 0, ids: [], archived: 0 };
    const placeholders = intIds.map(() => '?').join(',');
    db.prepare(`UPDATE memory_entries SET state='committed', committed_at=?, ts=COALESCE(ts, ?)
      WHERE state='draft' AND id IN (${placeholders})`).run(ts, ts, ...intIds);
    const rows = db.prepare(`SELECT id FROM memory_entries WHERE id IN (${placeholders}) AND state='committed'`).all(...intIds);
    return { committed: rows.length, ids: rows.map((r) => Number(r.id)), archived: hasArchive ? rows.length : 0 };
  }
  const info = db.prepare(`UPDATE memory_entries SET state='committed', committed_at=?, ts=COALESCE(ts, ?) WHERE state='draft'`).run(ts, ts);
  return { committed: Number(info.changes || 0), ids: [], archived: hasArchive ? Number(info.changes || 0) : 0 };
}

export function discardMemoryDrafts(db, { ids = null } = {}) {
  if (Array.isArray(ids) && ids.length > 0) {
    const intIds = ids.map((x) => Number(x)).filter((x) => Number.isFinite(x) && x > 0);
    if (!intIds.length) return { discarded: 0 };
    const placeholders = intIds.map(() => '?').join(',');
    const info = db.prepare(`DELETE FROM memory_entries WHERE state='draft' AND id IN (${placeholders})`).run(...intIds);
    return { discarded: Number(info.changes || 0) };
  }
  const info = db.prepare(`DELETE FROM memory_entries WHERE state='draft'`).run();
  return { discarded: Number(info.changes || 0) };
}

export function getMemoryCounts(db) {
  const hasArchive = tableExists(db, 'memory_archive');
  const row = db.prepare(`
    SELECT
      SUM(CASE WHEN state='draft' THEN 1 ELSE 0 END) AS drafts,
      SUM(CASE WHEN state='committed' OR state IS NULL OR TRIM(state)='' THEN 1 ELSE 0 END) AS committed
    FROM memory_entries
  `).get() || {};
  const archive = hasArchive
    ? Number(db.prepare('SELECT COUNT(1) AS c FROM memory_archive').get()?.c || 0)
    : Number(row.committed || 0);
  const lastCommitAt = hasArchive
    ? (db.prepare('SELECT MAX(committed_at) AS ts FROM memory_archive').get()?.ts || null)
    : (db.prepare("SELECT MAX(committed_at) AS ts FROM memory_entries WHERE state = 'committed'").get()?.ts || null);
  return {
    drafts: Number(row.drafts || 0),
    committed: Number(row.committed || 0),
    archive,
    last_commit_at: lastCommitAt,
  };
}

export function listMemoryArchive(db, { limit = 200 } = {}) {
  const max = Math.max(1, Math.min(Number(limit || 200) || 200, 1000));
  const hasArchive = tableExists(db, 'memory_archive');
  if (hasArchive) {
    const rows = db.prepare(`
      SELECT id, memory_entry_id, ts, day, kind, content, title, tags_json, source_session_id, user_id, workspace_id, agent_id, meta_json, committed_at
      FROM memory_archive
      ORDER BY committed_at DESC, id DESC
      LIMIT ?
    `).all(max);
    return rows.map((row) => ({
      id: Number(row.id),
      memory_entry_id: Number(row.memory_entry_id || 0) || null,
      ts: row.ts,
      day: row.day,
      kind: row.kind,
      content: row.content,
      title: row.title || null,
      tags: safeParse(row.tags_json, []),
      source_session_id: row.source_session_id || null,
      user_id: row.user_id || null,
      workspace_id: row.workspace_id || null,
      agent_id: row.agent_id || null,
      committed_at: row.committed_at || null,
      meta: row.meta_json ? safeParse(row.meta_json, null) : null,
    }));
  }

  // Backward-compatible fallback when archive table is unavailable.
  const rows = db.prepare(`
    SELECT id, ts, day, kind, content, title, tags_json, source_session_id, user_id, workspace_id, agent_id, meta_json, committed_at
    FROM memory_entries
    WHERE state = 'committed' OR state IS NULL OR TRIM(state) = ''
    ORDER BY committed_at DESC, ts DESC, id DESC
    LIMIT ?
  `).all(max);
  return rows.map((row) => ({
    id: Number(row.id),
    memory_entry_id: Number(row.id),
    ts: row.ts,
    day: row.day,
    kind: row.kind,
    content: row.content,
    title: row.title || null,
    tags: safeParse(row.tags_json, []),
    source_session_id: row.source_session_id || null,
    user_id: row.user_id || null,
    workspace_id: row.workspace_id || null,
    agent_id: row.agent_id || null,
    committed_at: row.committed_at || null,
    meta: row.meta_json ? safeParse(row.meta_json, null) : null,
  }));
}

export function getRecentCommittedMemoryForContext(db, { limit = 80 } = {}) {
  const max = Math.max(1, Math.min(Number(limit || 80) || 80, 300));
  const hasArchive = tableExists(db, 'memory_archive');
  if (hasArchive) {
    return db.prepare(`
      SELECT day, ts, content
      FROM (
        SELECT day, ts, content, committed_at, id
        FROM memory_archive
        UNION ALL
        SELECT e.day, e.ts, e.content, COALESCE(e.committed_at, e.ts) AS committed_at, e.id
        FROM memory_entries e
        WHERE (e.state = 'committed' OR e.state IS NULL OR TRIM(e.state) = '')
          AND NOT EXISTS (
            SELECT 1 FROM memory_archive a WHERE a.memory_entry_id = e.id
          )
      )
      ORDER BY committed_at DESC, id DESC
      LIMIT ?
    `).all(max);
  }
  return db.prepare(`
    SELECT day, ts, content
    FROM memory_entries
    WHERE state = 'committed' OR state IS NULL OR TRIM(state) = ''
    ORDER BY committed_at DESC, ts DESC, id DESC
    LIMIT ?
  `).all(max);
}

export function searchMemoryEntries(db, { q = '', startDay = '', endDay = '', limit = 100, state = 'committed' }) {
  const max = Math.max(1, Math.min(Number(limit || 100) || 100, 500));
  const where = ['1=1'];
  const args = [];
  const query = String(q || '').trim();
  const targetState = String(state || 'committed').trim() || 'committed';

  if (targetState === 'committed') {
    where.push("(state = 'committed' OR state IS NULL OR TRIM(state) = '')");
  } else if (targetState === 'draft') {
    where.push("state = 'draft'");
  }

  if (query) {
    where.push('(content LIKE ? OR meta_json LIKE ? OR title LIKE ?)');
    const pat = `%${query}%`;
    args.push(pat, pat, pat);
  }
  if (startDay && isValidDay(startDay)) {
    where.push('day >= ?');
    args.push(startDay);
  }
  if (endDay && isValidDay(endDay)) {
    where.push('day <= ?');
    args.push(endDay);
  }

  const hasArchive = tableExists(db, 'memory_archive');
  let rows = [];
  if (targetState === 'committed' && hasArchive) {
    const whereArchive = ['1=1'];
    const argsArchive = [];
    if (query) {
      whereArchive.push('(content LIKE ? OR meta_json LIKE ? OR title LIKE ?)');
      const pat = `%${query}%`;
      argsArchive.push(pat, pat, pat);
    }
    if (startDay && isValidDay(startDay)) {
      whereArchive.push('day >= ?');
      argsArchive.push(startDay);
    }
    if (endDay && isValidDay(endDay)) {
      whereArchive.push('day <= ?');
      argsArchive.push(endDay);
    }
    rows = db.prepare(`
      SELECT id, ts, day, kind, content, meta_json, title, tags_json, state, committed_at, source_session_id
      FROM (
        SELECT id, ts, day, kind, content, meta_json, title, tags_json, 'committed' AS state, committed_at, source_session_id
        FROM memory_archive
        WHERE ${whereArchive.join(' AND ')}
        UNION ALL
        SELECT e.id, e.ts, e.day, e.kind, e.content, e.meta_json, e.title, e.tags_json, 'committed' AS state, COALESCE(e.committed_at, e.ts) AS committed_at, e.source_session_id
        FROM memory_entries e
        WHERE (e.state = 'committed' OR e.state IS NULL OR TRIM(e.state) = '')
          AND NOT EXISTS (
            SELECT 1 FROM memory_archive a WHERE a.memory_entry_id = e.id
          )
          ${query ? 'AND (e.content LIKE ? OR e.meta_json LIKE ? OR e.title LIKE ?)' : ''}
          ${startDay && isValidDay(startDay) ? 'AND e.day >= ?' : ''}
          ${endDay && isValidDay(endDay) ? 'AND e.day <= ?' : ''}
      )
      ORDER BY committed_at DESC, id DESC
      LIMIT ?
    `).all(...argsArchive, ...argsArchive, max);
  } else {
    rows = db
      .prepare(
        `SELECT id, ts, day, kind, content, meta_json, title, tags_json, state, committed_at, source_session_id
         FROM memory_entries
         WHERE ${where.join(' AND ')}
         ORDER BY ts DESC, id DESC
         LIMIT ?`
      )
      .all(...args, max);
  }

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
      title: row.title || null,
      snippet: snippet(row.content, query),
      state: row.state || 'committed',
      committed_at: row.committed_at || null,
      source_session_id: row.source_session_id || null,
      tags: safeParse(row.tags_json, []),
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
  const info = db.prepare("DELETE FROM memory_entries WHERE day < ? AND (state = 'committed' OR state IS NULL OR TRIM(state) = '')").run(cutoff);
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
