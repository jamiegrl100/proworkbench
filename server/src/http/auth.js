import express from 'express';
import argon2 from 'argon2';
import crypto from 'node:crypto';

function nowIso() {
  return new Date().toISOString();
}

function randomId() {
  return crypto.randomBytes(16).toString('hex');
}

export function createAuthRouter({ db, csrfProtection }) {
  const r = express.Router();

  r.get('/state', (req, res) => {
    const auth = db.prepare('SELECT password_hash FROM admin_auth WHERE id = 1').get();
    const hasPassword = Boolean(auth?.password_hash);
    res.json({ hasPassword, authenticated: Boolean(req.cookies?.pb_sid) });
  });

  r.get('/csrf', csrfProtection, (req, res) => {
    res.json({ csrfToken: req.csrfToken() });
  });

  r.post('/setup', csrfProtection, async (req, res) => {
    const { password } = req.body || {};
    if (!password || String(password).length < 10) {
      return res.status(400).json({ error: 'Password must be at least 10 characters.' });
    }
    const auth = db.prepare('SELECT password_hash FROM admin_auth WHERE id = 1').get();
    if (auth?.password_hash) {
      return res.status(409).json({ error: 'Password already set.' });
    }
    const hash = await argon2.hash(password, { type: argon2.argon2id });
    db.prepare('UPDATE admin_auth SET password_hash = ?, created_at = ? WHERE id = 1').run(hash, nowIso());
    res.json({ ok: true });
  });

  r.post('/login', csrfProtection, async (req, res) => {
    const { password } = req.body || {};
    const auth = db.prepare('SELECT password_hash FROM admin_auth WHERE id = 1').get();
    if (!auth?.password_hash) return res.status(409).json({ error: 'Password not set.' });
    const ok = await argon2.verify(auth.password_hash, password || '');
    if (!ok) return res.status(401).json({ error: 'Invalid credentials.' });

    const sid = randomId();
    const expires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    db.prepare('INSERT INTO sessions (sid, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
      .run(sid, 'admin', nowIso(), expires);

    res.cookie('pb_sid', sid, { httpOnly: true, sameSite: 'strict' });
    res.json({ ok: true });
  });

  r.post('/logout', csrfProtection, (req, res) => {
    const sid = req.cookies?.pb_sid;
    if (sid) db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
    res.clearCookie('pb_sid');
    res.json({ ok: true });
  });

  return r;
}
