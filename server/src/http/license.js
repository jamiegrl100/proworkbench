import express from 'express';
import { requireAuth } from './middleware.js';
import { verifyLicenseKey, loadPublicKeyPem, publicKeyFingerprint } from '../util/license.js';

function kvGet(db, key, fallback) {
  const row = db.prepare('SELECT value_json FROM app_kv WHERE key = ?').get(key);
  if (!row) return fallback;
  try {
    return JSON.parse(row.value_json);
  } catch {
    return fallback;
  }
}

function kvSet(db, key, value) {
  db.prepare(
    'INSERT INTO app_kv (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json'
  ).run(key, JSON.stringify(value));
}

function kvDel(db, key) {
  db.prepare('DELETE FROM app_kv WHERE key = ?').run(key);
}

export function createLicenseRouter({ db, csrfProtection }) {
  const r = express.Router();
  r.use(requireAuth(db));

  r.get('/status', (req, res) => {
    const saved = kvGet(db, 'license.key', null);
    const key = typeof saved === 'string' ? saved : null;
        const { pem, source } = loadPublicKeyPem();
    const status = key ? verifyLicenseKey(key, { publicKeyPem: pem }) : { valid: false, reason: 'missing' };
        res.json({ ok: true, keyPresent: Boolean(key), status, publicKey: { source, fingerprint: publicKeyFingerprint(pem), missing: status.reason === 'public_key_missing' } });
  });

  r.post('/activate', csrfProtection, (req, res) => {
    const { key } = req.body || {};
        const { pem } = loadPublicKeyPem();
    const status = verifyLicenseKey(String(key || ''), { publicKeyPem: pem });
    if (!status.valid) return res.status(400).json({ ok: false, status });
    kvSet(db, 'license.key', String(key).trim());
    res.json({ ok: true, status });
  });

  r.post('/clear', csrfProtection, (req, res) => {
    kvDel(db, 'license.key');
    res.json({ ok: true });
  });

  return r;
}
