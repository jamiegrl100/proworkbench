import express from 'express';
import fetch from 'node-fetch';
import { requireAuth } from './middleware.js';
import {
  exportProvidersSafe,
  getActiveProvider,
  getActiveProviderId,
  getProviderSecret,
  listProviders,
  removeProvider,
  saveProviders,
  setActiveProviderId,
  setProviderSecret,
  upsertProvider,
  PROVIDER_TYPES,
} from '../llm/providerConfig.js';

function nowIso() {
  return new Date().toISOString();
}

const REQUIRED_DEFAULT_MODEL = 'models/quen/qwen2.5-coder-7b-instruct-q6_k.gguf';

function normalizeBaseUrl(u) {
  return String(u || '').trim().replace(/\/+$/g, '').replace(/\/v1$/g, '');
}

function getKv(db, key, fallback) {
  const row = db.prepare('SELECT value_json FROM app_kv WHERE key = ?').get(key);
  if (!row) return fallback;
  try { return JSON.parse(row.value_json); } catch { return fallback; }
}

function setKv(db, key, value) {
  db.prepare('INSERT INTO app_kv (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json')
    .run(key, JSON.stringify(value));
}

function saveTrace(db, entries, profile, ok) {
  const stmt = db.prepare('INSERT INTO llm_request_trace (ts, method, path, status, duration_ms, profile, ok) VALUES (?, ?, ?, ?, ?, ?, ?)');
  for (const t of entries.slice(-20)) {
    stmt.run(nowIso(), t.method, t.path, t.status ?? null, t.duration_ms ?? null, profile ?? null, ok ? 1 : 0);
  }
  db.exec('DELETE FROM llm_request_trace WHERE id NOT IN (SELECT id FROM llm_request_trace ORDER BY id DESC LIMIT 40)');
}

async function fetchJson(url, { method, headers, body }, trace, pathForTrace) {
  const start = Date.now();
  try {
    const res = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    const duration_ms = Date.now() - start;
    const txt = await res.text();
    let json = null;
    try { json = txt ? JSON.parse(txt) : null; } catch { json = null; }
    trace.push({ method, path: pathForTrace, status: res.status, duration_ms });
    return { ok: res.ok, status: res.status, json, text: txt };
  } catch (e) {
    trace.push({ method, path: pathForTrace, status: null, duration_ms: Date.now() - start });
    return { ok: false, status: null, json: null, text: String(e?.message || e) };
  }
}

function parseOpenAiModels(json) {
  const arr = json?.data || json?.models || [];
  return Array.isArray(arr)
    ? arr.map((m) => String(m?.id ?? m?.name ?? m?.model ?? '')).filter(Boolean)
    : [];
}

function parseGeminiModels(json) {
  const arr = json?.models || [];
  return Array.isArray(arr)
    ? arr.map((m) => String(m?.name || '')).filter(Boolean).map((n) => n.replace(/^models\//, ''))
    : [];
}

function sanitizeManualModels(input) {
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

function requireHttpScheme(baseUrl) {
  const url = String(baseUrl || '').trim();
  if (!/^https?:\/\//i.test(url)) {
    throw new Error('baseUrl must start with http:// or https://');
  }
  return normalizeBaseUrl(url);
}

function ensureDefaultModel(db, provider) {
  const selected = String(getKv(db, 'llm.selectedModel', '') || '').trim();
  const models = sanitizeManualModels(provider?.models || []);
  if (selected && (models.includes(selected) || selected)) return selected;
  if (models.includes(REQUIRED_DEFAULT_MODEL)) {
    setKv(db, 'llm.selectedModel', REQUIRED_DEFAULT_MODEL);
    return REQUIRED_DEFAULT_MODEL;
  }
  if (models.length) {
    setKv(db, 'llm.selectedModel', models[0]);
    return models[0];
  }
  return selected || null;
}

function syncLegacyProviderKeys(db) {
  const active = getActiveProvider(db);
  if (!active) return;
  setKv(db, 'llm.providerId', active.id);
  setKv(db, 'llm.providerName', active.displayName || active.name || active.id);
  setKv(db, 'llm.providerGroup', 'API');
  setKv(db, 'llm.baseUrl', normalizeBaseUrl(active.baseUrl || ''));
  setKv(db, 'llm.mode', active.providerType || PROVIDER_TYPES.OPENAI_COMPATIBLE);
  setKv(db, 'llm.activeProfile', active.providerType || PROVIDER_TYPES.OPENAI_COMPATIBLE);
}

function providerStatusPayload(db) {
  const providers = exportProvidersSafe(db);
  const activeProviderId = getActiveProviderId(db);
  const active = providers.find((p) => p.id === activeProviderId) || providers[0] || null;
  return {
    providerId: active?.id || null,
    providerName: active?.displayName || active?.id || null,
    providerType: active?.providerType || PROVIDER_TYPES.OPENAI_COMPATIBLE,
    providerGroup: 'API',
    baseUrl: active?.baseUrl || '',
    defaultProviderId: activeProviderId,
    defaultModelId: String(getKv(db, 'llm.selectedModel', null) || ''),
    selectedModel: String(getKv(db, 'llm.selectedModel', null) || ''),
    lastRefreshedAt: getKv(db, 'llm.lastRefreshedAt', null),
    providers,
    activeProviderId,
    hasOpenAiKey: Boolean(active?.hasApiKey),
    hasAnthropicKey: Boolean(active?.hasApiKey),
  };
}

async function testProvider(db, provider) {
  const trace = [];
  const providerType = provider?.providerType || PROVIDER_TYPES.OPENAI_COMPATIBLE;
  const baseUrl = requireHttpScheme(provider?.baseUrl || '');
  const apiKey = getProviderSecret(db, provider.id);

  if (providerType === PROVIDER_TYPES.ANTHROPIC) {
    if (!apiKey) return { ok: false, error: 'Missing API key for Anthropic', trace };
    const model = sanitizeManualModels(provider.models || [])[0] || 'claude-3-5-haiku-20241022';
    const out = await fetchJson(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: { model, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] },
    }, trace, '/v1/messages');
    saveTrace(db, trace, provider.id, out.ok);
    return out.ok ? { ok: true, models: sanitizeManualModels(provider.models || []) } : { ok: false, error: out.text || `HTTP ${out.status}` };
  }

  if (providerType === PROVIDER_TYPES.GEMINI) {
    if (!apiKey) return { ok: false, error: 'Missing API key for Gemini', trace };
    const out = await fetchJson(`${baseUrl}/v1beta/models?key=${encodeURIComponent(apiKey)}`, {
      method: 'GET',
      headers: { 'content-type': 'application/json' },
    }, trace, '/v1beta/models');
    saveTrace(db, trace, provider.id, out.ok);
    if (!out.ok) return { ok: false, error: out.text || `HTTP ${out.status}` };
    return { ok: true, models: parseGeminiModels(out.json) };
  }

  const headers = { 'content-type': 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const out = await fetchJson(`${baseUrl}/v1/models`, { method: 'GET', headers }, trace, '/v1/models');
  saveTrace(db, trace, provider.id, out.ok);
  if (!out.ok) return { ok: false, error: out.text || `HTTP ${out.status}` };
  return { ok: true, models: parseOpenAiModels(out.json) };
}

async function refreshProviderModels(db, provider) {
  const out = await testProvider(db, provider);
  if (!out.ok) return out;

  const merged = Array.from(new Set([
    ...sanitizeManualModels(provider.models || []),
    ...sanitizeManualModels(out.models || []),
  ]));
  upsertProvider(db, { ...provider, models: merged });
  const now = nowIso();
  setKv(db, 'llm.lastRefreshedAt', now);

  db.prepare('DELETE FROM llm_models_cache WHERE source = ?').run(provider.id);
  const ins = db.prepare('INSERT OR REPLACE INTO llm_models_cache (id, raw_json, source, discovered_at) VALUES (?, ?, ?, ?)');
  for (const id of merged) ins.run(id, JSON.stringify({ id, providerId: provider.id }), provider.id, now);

  ensureDefaultModel(db, { ...provider, models: merged });
  return { ok: true, modelCount: merged.length, models: merged, lastRefreshedAt: now };
}

function safeProviderPayload(raw) {
  const providerType = String(raw?.providerType || raw?.kind || PROVIDER_TYPES.OPENAI_COMPATIBLE);
  const id = String(raw?.id || '').trim() || String(raw?.displayName || raw?.name || '').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-');
  const displayName = String(raw?.displayName || raw?.name || id).trim();
  const baseUrl = requireHttpScheme(String(raw?.baseUrl || '').trim());
  const models = sanitizeManualModels(raw?.models || []);
  const preset = String(raw?.preset || '').trim();
  return { id, displayName, providerType, baseUrl, models, preset };
}

export function createLlmRouter({ db }) {
  const r = express.Router();
  r.use(requireAuth(db));

  r.get('/status', (_req, res) => {
    syncLegacyProviderKeys(db);
    res.json(providerStatusPayload(db));
  });

  r.get('/providers', (_req, res) => {
    const providers = exportProvidersSafe(db);
    const activeProviderId = getActiveProviderId(db);
    res.json({ ok: true, providers, activeProviderId });
  });

  r.post('/providers', (req, res) => {
    try {
      const payload = safeProviderPayload(req.body?.provider || {});
      if (!payload.id) return res.status(400).json({ ok: false, error: 'provider id required' });
      const saved = upsertProvider(db, payload, {
        apiKey: req.body?.apiKey !== undefined ? String(req.body.apiKey || '') : undefined,
      });
      if (Boolean(req.body?.setActive)) setActiveProviderId(db, saved.id);
      syncLegacyProviderKeys(db);
      return res.json({
        ok: true,
        provider: { ...saved, hasApiKey: Boolean(getProviderSecret(db, saved.id)) },
        activeProviderId: getActiveProviderId(db),
      });
    } catch (e) {
      return res.status(400).json({ ok: false, error: String(e?.message || e) });
    }
  });

  r.delete('/providers/:id', (req, res) => {
    const id = String(req.params.id || '').trim();
    if (!id) return res.status(400).json({ ok: false, error: 'provider id required' });
    const providers = removeProvider(db, id);
    syncLegacyProviderKeys(db);
    return res.json({
      ok: true,
      providers: providers.map((p) => ({ ...p, hasApiKey: Boolean(getProviderSecret(db, p.id)) })),
      activeProviderId: getActiveProviderId(db),
    });
  });

  r.post('/providers/:id/activate', (req, res) => {
    const id = String(req.params.id || '').trim();
    const activeProviderId = setActiveProviderId(db, id);
    syncLegacyProviderKeys(db);
    res.json({ ok: true, activeProviderId });
  });

  r.post('/providers/:id/test', async (req, res) => {
    const id = String(req.params.id || '').trim();
    const provider = listProviders(db).find((p) => p.id === id);
    if (!provider) return res.status(404).json({ ok: false, error: 'provider_not_found' });
    const out = await testProvider(db, provider);
    if (!out.ok) return res.status(502).json({ ok: false, error: out.error });
    res.json({ ok: true, modelCount: Array.isArray(out.models) ? out.models.length : 0, models: out.models || [] });
  });

  r.post('/providers/:id/refresh-models', async (req, res) => {
    const id = String(req.params.id || '').trim();
    const provider = listProviders(db).find((p) => p.id === id);
    if (!provider) return res.status(404).json({ ok: false, error: 'provider_not_found' });
    const out = await refreshProviderModels(db, provider);
    if (!out.ok) return res.status(502).json({ ok: false, error: out.error });
    res.json(out);
  });

  r.get('/providers/export', (_req, res) => {
    res.json({ ok: true, providers: exportProvidersSafe(db), activeProviderId: getActiveProviderId(db) });
  });

  r.post('/providers/import', (req, res) => {
    try {
      const incoming = Array.isArray(req.body?.providers) ? req.body.providers : [];
      const sanitized = incoming.map((raw) => safeProviderPayload(raw));
      const providers = saveProviders(db, sanitized);
      const activeProviderId = setActiveProviderId(db, String(req.body?.activeProviderId || providers[0]?.id || ''));
      syncLegacyProviderKeys(db);
      res.json({ ok: true, providers: providers.map((p) => ({ ...p, hasApiKey: Boolean(getProviderSecret(db, p.id)) })), activeProviderId });
    } catch (e) {
      res.status(400).json({ ok: false, error: String(e?.message || e) });
    }
  });

  // Legacy compatibility endpoints
  r.post('/config', (req, res) => {
    const active = getActiveProvider(db);
    const base = active || listProviders(db)[0];
    const provider = {
      id: String(req.body?.providerId || base?.id || '').trim(),
      displayName: String(req.body?.providerName || base?.displayName || base?.id || '').trim(),
      providerType: String(req.body?.providerType || base?.providerType || PROVIDER_TYPES.OPENAI_COMPATIBLE),
      baseUrl: String(req.body?.baseUrl || base?.baseUrl || ''),
      models: Array.isArray(base?.models) ? base.models : [],
      preset: String(base?.preset || ''),
    };
    const saved = upsertProvider(db, safeProviderPayload(provider));
    setActiveProviderId(db, saved.id);
    syncLegacyProviderKeys(db);
    res.json({ ok: true });
  });

  r.post('/set-api-keys', (req, res) => {
    const active = getActiveProvider(db);
    if (!active) return res.status(400).json({ ok: false, error: 'no provider configured' });
    if (req.body?.apiKey !== undefined) setProviderSecret(db, active.id, String(req.body.apiKey || ''));
    if (req.body?.openaiApiKey !== undefined) setProviderSecret(db, active.id, String(req.body.openaiApiKey || ''));
    if (req.body?.anthropicApiKey !== undefined) setProviderSecret(db, active.id, String(req.body.anthropicApiKey || ''));
    if (req.body?.geminiApiKey !== undefined) setProviderSecret(db, active.id, String(req.body.geminiApiKey || ''));
    res.json({ ok: true });
  });

  r.post('/test', async (_req, res) => {
    const active = getActiveProvider(db);
    if (!active) return res.status(400).json({ ok: false, error: 'no provider configured' });
    const out = await testProvider(db, active);
    if (!out.ok) return res.status(502).json({ ok: false, error: out.error });
    setKv(db, 'llm.activeProfile', active.providerType);
    res.json({ ok: true, activeProfile: active.providerType });
  });

  r.post('/refresh-models', async (_req, res) => {
    const active = getActiveProvider(db);
    if (!active) return res.status(400).json({ ok: false, error: 'no provider configured' });
    const out = await refreshProviderModels(db, active);
    if (!out.ok) return res.status(502).json({ ok: false, error: out.error });
    res.json({ ok: true, modelCount: out.modelCount, lastRefreshedAt: out.lastRefreshedAt });
  });

  r.get('/models', (_req, res) => {
    const active = getActiveProvider(db);
    const selectedModel = String(getKv(db, 'llm.selectedModel', '') || '');
    const models = sanitizeManualModels(active?.models || []).map((id) => ({ id, source: active?.id || 'provider', discovered_at: nowIso() }));
    res.json({ models, selectedModel });
  });

  r.post('/select-model', (req, res) => {
    const modelId = String(req.body?.modelId || '').trim();
    if (!modelId) return res.status(400).json({ ok: false, error: 'modelId required' });
    setKv(db, 'llm.selectedModel', modelId);
    res.json({ ok: true });
  });

  r.post('/add-custom-model', (req, res) => {
    const modelId = String(req.body?.modelId || '').trim();
    if (!modelId) return res.status(400).json({ ok: false, error: 'modelId required' });
    const active = getActiveProvider(db);
    if (!active) return res.status(400).json({ ok: false, error: 'no provider configured' });
    const nextModels = Array.from(new Set([...sanitizeManualModels(active.models || []), modelId]));
    upsertProvider(db, { ...active, models: nextModels });
    setKv(db, 'llm.selectedModel', modelId);
    syncLegacyProviderKeys(db);
    res.json({ ok: true });
  });

  r.get('/trace', (_req, res) => {
    const rows = db.prepare('SELECT ts, method, path, status, duration_ms, profile, ok FROM llm_request_trace ORDER BY id DESC LIMIT 40').all();
    res.json({ trace: rows.reverse() });
  });

  return r;
}
