function nowIso() {
  return new Date().toISOString();
}

export function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

export function incDaily(db, dateKey, patch) {
  const row = db.prepare('SELECT date_key FROM security_daily WHERE date_key = ?').get(dateKey);
  if (!row) db.prepare('INSERT INTO security_daily (date_key) VALUES (?)').run(dateKey);

  const cols = Object.keys(patch || {}).filter((k) => patch[k] !== undefined);
  if (cols.length === 0) return;

  const sets = cols.map((k) => `${k} = ${k} + ?`).join(', ');
  const vals = cols.map((k) => Number(patch[k] || 0));
  db.prepare(`UPDATE security_daily SET ${sets} WHERE date_key = ?`).run(...vals, dateKey);
}

export function markOverflowDrop(db, chatId) {
  const dateKey = todayKey();
  const now = nowIso();

  const row = db.prepare('SELECT date_key, pending_overflow_drop_count, pending_overflow_unique_count FROM security_daily WHERE date_key = ?').get(dateKey);
  if (!row) {
    db.prepare('INSERT INTO security_daily (date_key, pending_overflow_drop_count, pending_overflow_unique_count, first_drop_ts, last_drop_ts) VALUES (?, 1, 1, ?, ?)')
      .run(dateKey, now, now);
  } else {
    db.prepare('UPDATE security_daily SET pending_overflow_drop_count = pending_overflow_drop_count + 1, pending_overflow_unique_count = pending_overflow_unique_count + 1, last_drop_ts = ? WHERE date_key = ?')
      .run(now, dateKey);
  }
}
