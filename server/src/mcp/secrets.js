import crypto from 'node:crypto';

function keyBytesFromEnv() {
  const raw = String(process.env.PB_MCP_SECRET_KEY || '').trim();
  if (!raw) return null;
  // Derive 32 bytes deterministically. This is not a KDF, but it's sufficient for
  // turning an env secret into a fixed-length key for AES-256-GCM.
  return crypto.createHash('sha256').update(raw, 'utf8').digest();
}

export function hasMcpSecretKey() {
  return Boolean(keyBytesFromEnv());
}

export function encryptSecret(plaintext) {
  const key = keyBytesFromEnv();
  if (!key) throw new Error('PB_MCP_SECRET_KEY is not set.');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(String(plaintext || ''), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `enc:v1:${iv.toString('base64')}:${tag.toString('base64')}:${enc.toString('base64')}`;
}

export function isEncryptedSecret(value) {
  return typeof value === 'string' && value.startsWith('enc:v1:');
}

