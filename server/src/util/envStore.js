import fs from 'node:fs';
import path from 'node:path';

function parseEnv(text) {
  const out = {};
  for (const line of String(text || '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    const val = trimmed.slice(idx + 1).trim();
    out[key] = val;
  }
  return out;
}

function serializeEnv(env) {
  const keys = Object.keys(env).sort();
  const lines = ['# Proworkbench secrets (generated)', ''];
  for (const k of keys) lines.push(`${k}=${env[k] ?? ''}`);
  lines.push('');
  return lines.join('\n');
}

export function readEnvFile(dataDir) {
  const p = path.join(dataDir, '.env');
  if (!fs.existsSync(p)) return { path: p, env: {} };
  return { path: p, env: parseEnv(fs.readFileSync(p, 'utf8')) };
}

export function writeEnvFile(dataDir, updates) {
  const { path: p, env } = readEnvFile(dataDir);
  const next = { ...env, ...updates };
  fs.writeFileSync(p, serializeEnv(next), { mode: 0o600 });
  try { fs.chmodSync(p, 0o600); } catch {}
  return { path: p, env: next };
}

export function envConfigured(env) {
  const required = ['BOT_API_TOKEN', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_ALLOWED_CHAT_IDS'];
  return required.every(k => Boolean(env[k] && String(env[k]).trim().length > 0));
}

export function normalizeAllowedChatIds(raw) {
  const parts = String(raw || '').split(/[,\s]+/).map(s => s.trim()).filter(Boolean);
  const set = new Set();
  for (const p of parts) if (/^-?\d+$/.test(p)) set.add(p);
  return Array.from(set).join(',');
}
