import crypto from 'node:crypto';

function nowIso() {
  return new Date().toISOString();
}

function randomToken() {
  return crypto.randomBytes(32).toString('hex');
}

export function countAdminTokens(db) {
  const now = nowIso();
  db.prepare('DELETE FROM admin_tokens WHERE datetime(expires_at) <= datetime(?)').run(now);
  const row = db.prepare('SELECT COUNT(1) AS c FROM admin_tokens WHERE datetime(expires_at) > datetime(?)').get(now);
  return row?.c || 0;
}

export function createAdminToken(db, { ttlDays = 365 } = {}) {
  const token = randomToken();
  const createdAt = nowIso();
  const expiresAt = new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000).toISOString();
  db.prepare(
    'INSERT INTO admin_tokens (token, created_at, last_used_at, expires_at) VALUES (?, ?, ?, ?)'
  ).run(token, createdAt, createdAt, expiresAt);
  return token;
}

export function verifyAdminToken(db, token) {
  if (!token) return false;
  const row = db.prepare('SELECT token, expires_at FROM admin_tokens WHERE token = ?').get(token);
  if (!row) return false;
  if (new Date(row.expires_at).getTime() < Date.now()) {
    db.prepare('DELETE FROM admin_tokens WHERE token = ?').run(token);
    return false;
  }
  db.prepare('UPDATE admin_tokens SET last_used_at = ? WHERE token = ?').run(nowIso(), token);
  return true;
}

export function revokeAdminToken(db, token) {
  if (!token) return;
  db.prepare('DELETE FROM admin_tokens WHERE token = ?').run(token);
}
