import crypto from 'node:crypto';
import { encryptSecret, hasMcpSecretKey, isEncryptedSecret } from '../mcp/secrets.js';

const PROVIDERS_KEY = 'llm.providers';
const ACTIVE_PROVIDER_KEY = 'llm.activeProviderId';
const SELECTED_MODEL_KEY = 'llm.selectedModel';

export const PROVIDER_TYPES = {
  OPENAI: 'openai',
  ANTHROPIC: 'anthropic',
  GEMINI: 'gemini',
  OPENAI_COMPATIBLE: 'openai_compatible',
};

const DEFAULT_PROVIDER_ID = 'openai-compatible-default';

function nowIso() {
  return new Date().toISOString();
}

function kvGet(db, key, fallback) {
  const row = db.prepare('SELECT value_json FROM app_kv WHERE key = ?').get(key);
  if (!row) return fallback;
  try { return JSON.parse(row.value_json); } catch { return fallback; }
}

function kvSet(db, key, value) {
  db.prepare('INSERT INTO app_kv (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json')
    .run(key, JSON.stringify(value));
}

function normalizeBaseUrl(raw) {
  return String(raw || '').trim().replace(/\/+$/g, '');
}

function sanitizeModelList(input) {
  if (!Array.isArray(input)) return [];
  const out = [];
  const seen = new Set();
  for (const id0 of input) {
    const id = String(id0 || '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function normalizeProviderType(raw, fallback = PROVIDER_TYPES.OPENAI_COMPATIBLE) {
  const v = String(raw || '').trim().toLowerCase();
  if (v === 'openai') return PROVIDER_TYPES.OPENAI;
  if (v === 'anthropic') return PROVIDER_TYPES.ANTHROPIC;
  if (v === 'gemini' || v === 'google' || v === 'google_gemini') return PROVIDER_TYPES.GEMINI;
  if (v === 'openai_compatible' || v === 'openai-compatible' || v === 'compatible') return PROVIDER_TYPES.OPENAI_COMPATIBLE;
  return fallback;
}

function defaultBaseUrlForType(providerType) {
  if (providerType === PROVIDER_TYPES.OPENAI) return 'https://api.openai.com';
  if (providerType === PROVIDER_TYPES.ANTHROPIC) return 'https://api.anthropic.com';
  if (providerType === PROVIDER_TYPES.GEMINI) return 'https://generativelanguage.googleapis.com';
  return 'http://127.0.0.1:5000';
}

function normalizeProvider(raw) {
  const providerType = normalizeProviderType(raw?.providerType || raw?.kind, PROVIDER_TYPES.OPENAI_COMPATIBLE);
  const id = String(raw?.id || '').trim();
  const name = String(raw?.displayName || raw?.name || id || '').trim();
  const baseUrl = normalizeBaseUrl(raw?.baseUrl || defaultBaseUrlForType(providerType));
  const models = sanitizeModelList(raw?.models);
  const createdAt = String(raw?.createdAt || nowIso());
  const updatedAt = String(raw?.updatedAt || nowIso());
  const preset = String(raw?.preset || '').trim();
  return {
    id,
    displayName: name,
    name,
    providerType,
    kind: providerType,
    baseUrl,
    models,
    createdAt,
    updatedAt,
    preset,
  };
}

function decryptSecret(value) {
  if (!isEncryptedSecret(value)) return String(value || '');
  if (!hasMcpSecretKey()) return '';
  const key = crypto.createHash('sha256').update(String(process.env.PB_MCP_SECRET_KEY || ''), 'utf8').digest();
  const parts = String(value).split(':');
  if (parts.length !== 5) return '';
  const iv = Buffer.from(parts[2], 'base64');
  const tag = Buffer.from(parts[3], 'base64');
  const data = Buffer.from(parts[4], 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(data), decipher.final()]);
  return dec.toString('utf8');
}

function secretKey(providerId) {
  return `llm.providerSecrets::${providerId}`;
}

function defaultProviders() {
  const ts = nowIso();
  return [
    {
      id: DEFAULT_PROVIDER_ID,
      displayName: 'OpenAI-Compatible',
      name: 'OpenAI-Compatible',
      providerType: PROVIDER_TYPES.OPENAI_COMPATIBLE,
      kind: PROVIDER_TYPES.OPENAI_COMPATIBLE,
      baseUrl: 'http://127.0.0.1:5000',
      models: [],
      preset: '',
      createdAt: ts,
      updatedAt: ts,
    },
    {
      id: 'openai',
      displayName: 'OpenAI',
      name: 'OpenAI',
      providerType: PROVIDER_TYPES.OPENAI,
      kind: PROVIDER_TYPES.OPENAI,
      baseUrl: 'https://api.openai.com',
      models: [],
      preset: 'openai',
      createdAt: ts,
      updatedAt: ts,
    },
    {
      id: 'anthropic',
      displayName: 'Anthropic',
      name: 'Anthropic',
      providerType: PROVIDER_TYPES.ANTHROPIC,
      kind: PROVIDER_TYPES.ANTHROPIC,
      baseUrl: 'https://api.anthropic.com',
      models: [],
      preset: 'anthropic',
      createdAt: ts,
      updatedAt: ts,
    },
    {
      id: 'gemini',
      displayName: 'Google Gemini',
      name: 'Google Gemini',
      providerType: PROVIDER_TYPES.GEMINI,
      kind: PROVIDER_TYPES.GEMINI,
      baseUrl: 'https://generativelanguage.googleapis.com',
      models: [],
      preset: 'gemini',
      createdAt: ts,
      updatedAt: ts,
    },
  ];
}

export function getProviderSecret(db, providerId) {
  const row = kvGet(db, secretKey(providerId), {});
  const value = row && typeof row === 'object' ? String(row.apiKey || '') : '';
  if (!value) return '';
  return decryptSecret(value);
}

export function setProviderSecret(db, providerId, apiKey) {
  const plain = String(apiKey || '').trim();
  if (!plain) {
    kvSet(db, secretKey(providerId), {});
    return;
  }
  const payload = hasMcpSecretKey() ? encryptSecret(plain) : plain;
  kvSet(db, secretKey(providerId), { apiKey: payload, encrypted: hasMcpSecretKey() });
}

export function listProviders(db) {
  let arr = kvGet(db, PROVIDERS_KEY, null);
  let changed = false;
  if (!Array.isArray(arr) || arr.length === 0) {
    arr = defaultProviders();
    changed = true;
  }

  const out = [];
  const seen = new Set();
  for (const raw of arr) {
    const p = normalizeProvider(raw);
    if (!p.id || seen.has(p.id)) continue;
    seen.add(p.id);
    out.push(p);
  }

  // Ship core paid-provider presets by default even for older installs.
  const required = defaultProviders();
  for (const built of required) {
    if (seen.has(built.id)) continue;
    seen.add(built.id);
    out.push(built);
    changed = true;
  }

  if (changed) kvSet(db, PROVIDERS_KEY, out);
  if (!kvGet(db, ACTIVE_PROVIDER_KEY, null)) kvSet(db, ACTIVE_PROVIDER_KEY, out[0].id);
  return out;
}

export function saveProviders(db, providers) {
  const now = nowIso();
  const out = [];
  const seen = new Set();
  for (const raw of (Array.isArray(providers) ? providers : [])) {
    const p = normalizeProvider(raw);
    if (!p.id || seen.has(p.id)) continue;
    seen.add(p.id);
    if (!p.createdAt) p.createdAt = now;
    p.updatedAt = now;
    out.push(p);
  }
  if (!out.length) out.push(...defaultProviders());
  kvSet(db, PROVIDERS_KEY, out);

  const active = String(kvGet(db, ACTIVE_PROVIDER_KEY, '') || '');
  if (!out.some((p) => p.id === active)) kvSet(db, ACTIVE_PROVIDER_KEY, out[0].id);

  const selectedModel = String(kvGet(db, SELECTED_MODEL_KEY, '') || '').trim();
  if (selectedModel) {
    const activeProvider = out.find((p) => p.id === String(kvGet(db, ACTIVE_PROVIDER_KEY, out[0].id)));
    if (activeProvider && !activeProvider.models.includes(selectedModel)) {
      // keep selected model as manual override; do not delete
    }
  }
  return out;
}

export function getActiveProviderId(db) {
  const providers = listProviders(db);
  const id = String(kvGet(db, ACTIVE_PROVIDER_KEY, providers[0]?.id || DEFAULT_PROVIDER_ID) || '');
  return providers.some((p) => p.id === id) ? id : providers[0]?.id || DEFAULT_PROVIDER_ID;
}

export function setActiveProviderId(db, providerId) {
  const providers = listProviders(db);
  const next = providers.some((p) => p.id === providerId) ? providerId : (providers[0]?.id || DEFAULT_PROVIDER_ID);
  kvSet(db, ACTIVE_PROVIDER_KEY, next);
  return next;
}

export function getActiveProvider(db) {
  const providers = listProviders(db);
  const activeId = getActiveProviderId(db);
  return providers.find((p) => p.id === activeId) || providers[0] || null;
}

export function upsertProvider(db, providerInput, { apiKey } = {}) {
  const providers = listProviders(db);
  const next = normalizeProvider(providerInput || {});
  if (!next.id) throw new Error('provider id required');

  const idx = providers.findIndex((p) => p.id === next.id);
  const merged = idx >= 0
    ? { ...providers[idx], ...next, updatedAt: nowIso() }
    : { ...next, createdAt: nowIso(), updatedAt: nowIso() };

  if (idx >= 0) providers[idx] = merged;
  else providers.push(merged);

  const saved = saveProviders(db, providers);
  if (apiKey !== undefined) setProviderSecret(db, next.id, apiKey);
  return saved.find((p) => p.id === next.id) || merged;
}

export function removeProvider(db, providerId) {
  const cur = listProviders(db);
  const next = cur.filter((p) => p.id !== providerId);
  const saved = saveProviders(db, next);
  kvSet(db, secretKey(providerId), {});
  return saved;
}

export function exportProvidersSafe(db) {
  return listProviders(db).map((p) => ({
    id: p.id,
    displayName: p.displayName,
    providerType: p.providerType,
    baseUrl: p.baseUrl,
    models: Array.isArray(p.models) ? p.models : [],
    preset: p.preset || '',
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    hasApiKey: Boolean(getProviderSecret(db, p.id)),
  }));
}
