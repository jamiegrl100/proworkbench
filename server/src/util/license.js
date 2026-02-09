/**
 * Offline license verification (no network calls).
 *
 * Key format: base64url(payloadJSON) + "." + base64url(signature)
 * Signature: Ed25519 over the raw payload bytes.
 *
 * Public key sources (first found wins):
 *  1) PROWORKBENCH_LICENSE_PUBLIC_KEY_PEM (env; PEM text)
 *  2) PROWORKBENCH_LICENSE_PUBLIC_KEY_PATH (env; default: data/keys/license_public.pem)
 *  3) Embedded PUBLIC_KEY_PEM (for vendor builds)
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const EMBEDDED_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
REPLACE_WITH_YOUR_ED25519_PUBLIC_KEY_PEM
-----END PUBLIC KEY-----`;

function b64urlToBuf(s) {
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  const b64 = (s + pad).replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(b64, 'base64');
}

function safeJsonParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function nowUnix() {
  return Math.floor(Date.now() / 1000);
}

function normalizePem(pem) {
  const t = String(pem || '').trim();
  if (!t) return '';
  // If multiple PEM blocks are pasted, keep the first PUBLIC KEY block.
  const m = t.match(/-----BEGIN PUBLIC KEY-----[\s\S]*?-----END PUBLIC KEY-----/);
  if (m) return m[0].trim();
  return t;
}

export function publicKeyFingerprint(pem) {
  const clean = normalizePem(pem);
  if (!clean) return null;
  return crypto.createHash('sha256').update(clean).digest('hex').slice(0, 12);
}

export function loadPublicKeyPem() {
  const fromEnvPem = normalizePem(process.env.PROWORKBENCH_LICENSE_PUBLIC_KEY_PEM || '');
  if (fromEnvPem) return { pem: fromEnvPem, source: 'env_pem' };

  const dataDir = process.env.PROWORKBENCH_DATA_DIR || path.resolve(process.cwd(), 'data');
  const defaultPath = path.join(dataDir, 'keys', 'license_public.pem');
  const keyPath = process.env.PROWORKBENCH_LICENSE_PUBLIC_KEY_PATH || defaultPath;

  try {
    if (fs.existsSync(keyPath)) {
      const pem = normalizePem(fs.readFileSync(keyPath, 'utf8'));
      if (pem) return { pem, source: `file:${keyPath}` };
    }
  } catch {
    // ignore
  }

  const embedded = normalizePem(EMBEDDED_PUBLIC_KEY_PEM);
  return { pem: embedded, source: 'embedded' };
}

export function verifyLicenseKey(key, { publicKeyPem } = {}) {
  if (!key || typeof key !== 'string') return { valid: false, reason: 'missing' };
  const parts = key.trim().split('.');
  if (parts.length !== 2) return { valid: false, reason: 'bad_format' };

  const [payloadB64, sigB64] = parts;
  const payloadBuf = b64urlToBuf(payloadB64);
  const sigBuf = b64urlToBuf(sigB64);

  const payloadJson = payloadBuf.toString('utf8');
  const payload = safeJsonParse(payloadJson);
  if (!payload) return { valid: false, reason: 'bad_payload_json' };

  const pub = normalizePem(publicKeyPem);
  if (!pub || pub.includes('REPLACE_WITH_YOUR_ED25519_PUBLIC_KEY_PEM')) {
    return { valid: false, reason: 'public_key_missing', payload };
  }

  let okSig = false;
  try {
    okSig = crypto.verify(null, payloadBuf, pub, sigBuf);
  } catch (e) {
    return { valid: false, reason: 'bad_public_key', error: String(e?.message || e), payload };
  }
  if (!okSig) return { valid: false, reason: 'bad_signature', payload };

  const iss = String(payload.iss || '');
  if (iss.toLowerCase() !== 'proworkbench') return { valid: false, reason: 'bad_issuer', payload };

  const exp = Number(payload.exp || 0);
  if (!Number.isFinite(exp) || exp <= 0) return { valid: false, reason: 'missing_exp', payload };
  if (nowUnix() > exp) return { valid: false, reason: 'expired', payload };

  const tier = String(payload.tier || '');
  const features = Array.isArray(payload.features) ? payload.features.map(String) : [];

  return { valid: true, payload: { ...payload, tier, features } };
}
