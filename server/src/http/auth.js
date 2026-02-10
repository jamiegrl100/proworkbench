import express from 'express';
import argon2 from 'argon2';
import { countAdminTokens, createAdminToken, revokeAdminToken, verifyAdminToken } from '../auth/adminToken.js';
import { extractToken } from './middleware.js';

function nowIso() {
  return new Date().toISOString();
}

export function createAuthRouter({ db }) {
  const r = express.Router();

  r.get('/state', (req, res) => {
    const token = extractToken(req);
    const loggedIn = verifyAdminToken(db, token);
    const tokenCount = countAdminTokens(db);
    res.json({ loggedIn, tokenCount, setupComplete: tokenCount > 0 });
  });

  r.post('/bootstrap', (req, res) => {
    const tokenCount = countAdminTokens(db);
    if (tokenCount > 0) {
      return res.status(409).json({ error: 'Bootstrap already completed.' });
    }
    const token = createAdminToken(db);
    res.json({ ok: true, token });
  });

  r.post('/setup', async (req, res) => {
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
    const token = createAdminToken(db);
    res.json({ ok: true, token });
  });

  r.post('/login', async (req, res) => {
    const { password } = req.body || {};
    const auth = db.prepare('SELECT password_hash FROM admin_auth WHERE id = 1').get();
    if (!auth?.password_hash) return res.status(409).json({ error: 'Password not set.' });
    const ok = await argon2.verify(auth.password_hash, password || '');
    if (!ok) return res.status(401).json({ error: 'Invalid credentials.' });

    const token = createAdminToken(db);
    res.json({ ok: true, token });
  });

  r.post('/logout', (req, res) => {
    const token = extractToken(req);
    revokeAdminToken(db, token);
    res.json({ ok: true });
  });

  return r;
}
