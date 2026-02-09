function nowIso() {
  return new Date().toISOString();
}

function localDateKey(d) {
  // YYYY-MM-DD in local time
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function getKv(db, key, fallback) {
  const row = db.prepare('SELECT value_json FROM app_kv WHERE key = ?').get(key);
  return row ? JSON.parse(row.value_json) : fallback;
}

function setKv(db, key, value) {
  db.prepare('INSERT INTO app_kv (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json')
    .run(key, JSON.stringify(value));
}

function hasAnySecurityData(today) {
  return (
    Number(today?.unknown_msg_count || 0) +
      Number(today?.blocked_msg_count || 0) +
      Number(today?.rate_limited_count || 0) +
      Number(today?.pending_overflow_drop_count || 0) >
    0
  );
}

function buildDailyPayload(db, dateKey) {
  const today = db.prepare('SELECT * FROM security_daily WHERE date_key = ?').get(dateKey) || null;
  if (!today) return null;
  const hasData = hasAnySecurityData(today);
  if (!hasData) return null;

  const pendingOverflowActive = Boolean(getKv(db, 'telegram.pendingOverflowActive', false));
  return {
    dateKey,
    unknown_msg_count: Number(today.unknown_msg_count || 0),
    blocked_msg_count: Number(today.blocked_msg_count || 0),
    rate_limited_count: Number(today.rate_limited_count || 0),
    pending_overflow_drop_count: Number(today.pending_overflow_drop_count || 0),
    pending_overflow_unique_count: Number(today.pending_overflow_unique_count || 0),
    first_drop_ts: today.first_drop_ts || null,
    last_drop_ts: today.last_drop_ts || null,
    pendingOverflowActive,
  };
}

export function computeNextRunLocal005(now = new Date()) {
  const next = new Date(now);
  next.setSeconds(0, 0);
  next.setHours(0, 5, 0, 0);
  if (now.getTime() >= next.getTime()) {
    next.setDate(next.getDate() + 1);
  }
  return next;
}

export function startSecurityDailyScheduler({ db, recordEvent }) {
  function scheduleNext() {
    const next = computeNextRunLocal005(new Date());
    setKv(db, 'security.nextScheduledReportTs', next.toISOString());

    const delay = Math.max(1000, next.getTime() - Date.now());
    setTimeout(async () => {
      try {
        await runScheduledDaily(db, recordEvent);
      } finally {
        scheduleNext();
      }
    }, delay);
  }

  scheduleNext();
}

export async function runScheduledDaily(db, recordEvent) {
  const now = new Date();
  const dateKey = localDateKey(now);

  const today = db.prepare('SELECT * FROM security_daily WHERE date_key = ?').get(dateKey) || null;
  if (!today) return { ok: true, skipped: true, reason: 'no-data-row' };
  if (!hasAnySecurityData(today)) return { ok: true, skipped: true, reason: 'no-data' };
  if (Number(today.report_emitted || 0) === 1) return { ok: true, skipped: true, reason: 'already-emitted-today' };

  const payload = buildDailyPayload(db, dateKey);
  if (!payload) return { ok: true, skipped: true, reason: 'no-data' };

  const ts = nowIso();
  db.prepare('INSERT INTO security_reports (ts, kind, payload_json) VALUES (?, ?, ?)')
    .run(ts, 'daily', JSON.stringify(payload));
  db.prepare('UPDATE security_daily SET report_emitted = 1, report_emitted_ts = ? WHERE date_key = ?').run(ts, dateKey);

  recordEvent(db, 'security.report.emitted', { kind: 'daily', date_key: dateKey, scheduled: true });
  setKv(db, 'security.lastReportTs', ts);

  return { ok: true, kind: 'daily', ts, scheduled: true };
}
