function nowIso() {
  return new Date().toISOString();
}

export function recordEvent(db, type, payload) {
  const ts = nowIso();
  db.prepare('INSERT INTO security_events (ts, type, payload_json) VALUES (?, ?, ?)')
    .run(ts, String(type), JSON.stringify(payload ?? {}));
  // Keep bounded (last 500)
  db.exec(`
    DELETE FROM security_events
    WHERE id NOT IN (SELECT id FROM security_events ORDER BY id DESC LIMIT 500);
  `);
}
