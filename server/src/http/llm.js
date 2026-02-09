import express from 'express';
import fetch from 'node-fetch';
import { requireAuth } from './middleware.js';
import { writeEnvFile } from '../util/envStore.js';

function nowIso() {
  return new Date().toISOString();
}

function normalizeBaseUrl(u) {
  const s = String(u || '').trim().replace(/\/+$/g, '');
  return s.replace(/\/v1$/g, '');
}

function getKv(db, key, fallback) {
  const row = db.prepare('SELECT value_json FROM app_kv WHERE key = ?').get(key);
  return row ? JSON.parse(row.value_json) : fallback;
}

function setKv(db, key, value) {
  db.prepare('INSERT INTO app_kv (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json')
    .run(key, JSON.stringify(value));
}

function saveTrace(db, entries, profile, ok) {
  const stmt = db.prepare(
    'INSERT INTO llm_request_trace (ts, method, path, status, duration_ms, profile, ok) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  for (const t of entries.slice(-10)) {
    stmt.run(nowIso(), t.method, t.path, t.status ?? null, t.duration_ms ?? null, profile ?? null, ok ? 1 : 0);
  }
  db.exec(`
    DELETE FROM llm_request_trace
    WHERE id NOT IN (SELECT id FROM llm_request_trace ORDER BY id DESC LIMIT 10);
  `);
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
    try {
      json = txt ? JSON.parse(txt) : null;
    } catch {
      json = null;
    }
    trace.push({ method, path: pathForTrace, status: res.status, duration_ms });
    return { ok: res.ok, status: res.status, json, text: txt };
  } catch (e) {
    trace.push({ method, path: pathForTrace, status: null, duration_ms: Date.now() - start });
    return { ok: false, status: null, json: null, text: String(e?.message || e) };
  }
}

function getProviderId(db) {
  return getKv(db, 'llm.providerId', 'lmstudio'); // lmstudio | openai | anthropic
}

function getProviderName(db) {
  const id = getProviderId(db);
  return getKv(db, 'llm.providerName', id === 'openai' ? 'OpenAI' : (id === 'anthropic' ? 'Anthropic' : 'LM Studio'));
}

function getProviderGroup(db) {
  const id = getProviderId(db);
  return getKv(db, 'llm.providerGroup', id === 'lmstudio' ? 'Local' : 'API');
}

function getBaseUrl(db) {
  const raw = getKv(db, 'llm.baseUrl', null);
  if (raw) return raw;
  const providerId = getProviderId(db);
  if (providerId === 'openai') return 'https://api.openai.com';
  if (providerId === 'anthropic') return 'https://api.anthropic.com';
  return process.env.PROWORKBENCH_LLM_BASE_URL || 'http://127.0.0.1:1234';
}

function getMode(db) {
  return getKv(db, 'llm.mode', 'auto'); // auto | force_openai | force_gateway
}

function parseModelsFromOpenAi(json) {
  const arr = json?.data || [];
  return Array.isArray(arr) ? arr.map((m) => ({ id: String(m.id), raw: m })) : [];
}

function parseModelsFromGateway(json) {
  const arr = json?.data || json?.models || [];
  return Array.isArray(arr) ? arr.map((m) => ({ id: String(m.id ?? m.name ?? m.model), raw: m })) : [];
}

function autoSelectDefaultModel(db, candidateIds) {
  const current = getKv(db, 'llm.selectedModel', null);
  const has = (id) => candidateIds.includes(id);
  if (current && has(current)) return current;

  const isEmbedding = (id) => /(^|[-_/])(embed|embedding|embeddings)([-_/]|$)/i.test(id) || /nomic-embed/i.test(id);
  const preferred = candidateIds.find((id) => !isEmbedding(id)) || candidateIds[0] || null;
  if (preferred) setKv(db, 'llm.selectedModel', preferred);
  return preferred;
}

export function createLlmRouter({ db, csrfProtection, dataDir }) {
  const r = express.Router();
  r.use(requireAuth(db));

  r.get('/status', (req, res) => {
    const providerId = getProviderId(db);
    const providerName = getProviderName(db);
    const providerGroup = getProviderGroup(db);

    const baseUrl = normalizeBaseUrl(getBaseUrl(db));
    const mode = getMode(db);

    const activeProfile = getKv(db, 'llm.activeProfile', null);
    const lastRefreshedAt = getKv(db, 'llm.lastRefreshedAt', null);
    const selectedModel = getKv(db, 'llm.selectedModel', null);

    const hasOpenAiKey = Boolean(String(process.env.OPENAI_API_KEY || '').trim());
    const hasAnthropicKey = Boolean(String(process.env.ANTHROPIC_API_KEY || '').trim());

    res.json({
      providerId,
      providerName,
      providerGroup,
      baseUrl,
      mode,
      activeProfile,
      lastRefreshedAt,
      selectedModel,
      hasOpenAiKey,
      hasAnthropicKey,
    });
  });

  r.post('/config', csrfProtection, (req, res) => {
    const { providerId, providerName, providerGroup, baseUrl, mode } = req.body || {};

    if (providerId) setKv(db, 'llm.providerId', String(providerId));
    if (providerName) setKv(db, 'llm.providerName', String(providerName));
    if (providerGroup) setKv(db, 'llm.providerGroup', String(providerGroup));

    if (baseUrl) setKv(db, 'llm.baseUrl', normalizeBaseUrl(baseUrl));
    if (mode) setKv(db, 'llm.mode', mode);

    // Provider implies active profile for API providers.
    if (String(providerId) === 'openai') setKv(db, 'llm.activeProfile', 'openai');
    if (String(providerId) === 'anthropic') setKv(db, 'llm.activeProfile', 'anthropic');

    res.json({ ok: true });
  });

  r.post('/set-api-keys', csrfProtection, (req, res) => {
    const { openaiApiKey, anthropicApiKey } = req.body || {};
    const updates = {};

    if (openaiApiKey !== undefined) updates.OPENAI_API_KEY = String(openaiApiKey || '').trim();
    if (anthropicApiKey !== undefined) updates.ANTHROPIC_API_KEY = String(anthropicApiKey || '').trim();

    writeEnvFile(dataDir, updates);

    if (updates.OPENAI_API_KEY !== undefined) process.env.OPENAI_API_KEY = updates.OPENAI_API_KEY;
    if (updates.ANTHROPIC_API_KEY !== undefined) process.env.ANTHROPIC_API_KEY = updates.ANTHROPIC_API_KEY;

    res.json({ ok: true });
  });

  r.post('/test', csrfProtection, async (req, res) => {
    const providerId = getProviderId(db);
    const baseUrl = normalizeBaseUrl(getBaseUrl(db));
    const mode = getMode(db);
    const trace = [];
    let activeProfile = null;

    try {
      if (providerId === 'openai') {
        const key = String(process.env.OPENAI_API_KEY || '').trim();
        if (!key) return res.status(400).json({ ok: false, error: 'OPENAI_API_KEY missing' });

        const out = await fetchJson(baseUrl + '/v1/models', {
          method: 'GET',
          headers: { Authorization: `Bearer ${key}` },
        }, trace, '/v1/models');

        saveTrace(db, trace, 'openai', out.ok);
        if (!out.ok) return res.status(502).json({ ok: false, error: out.text || 'OpenAI test failed' });

        activeProfile = 'openai';
      } else if (providerId === 'anthropic') {
        const key = String(process.env.ANTHROPIC_API_KEY || '').trim();
        const model = getKv(db, 'llm.selectedModel', null);
        if (!key) return res.status(400).json({ ok: false, error: 'ANTHROPIC_API_KEY missing' });
        if (!model) return res.status(400).json({ ok: false, error: 'No model selected. Add a custom model id first.' });

        const out = await fetchJson(baseUrl + '/v1/messages', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
          body: { model, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] },
        }, trace, '/v1/messages');

        saveTrace(db, trace, 'anthropic', out.ok);
        if (!out.ok) return res.status(502).json({ ok: false, error: out.text || 'Anthropic test failed' });

        activeProfile = 'anthropic';
      } else {
        // LM Studio local: autodetect
        if (mode === 'force_openai') {
          const out = await fetchJson(baseUrl + '/v1/models', { method: 'GET', headers: {} }, trace, '/v1/models');
          saveTrace(db, trace, 'openai', out.ok);
          if (!out.ok) return res.status(502).json({ ok: false, error: 'OpenAI-compatible /v1/models failed' });
          activeProfile = 'openai';
        } else if (mode === 'force_gateway') {
          const out = await fetchJson(baseUrl + '/api/v1/models', { method: 'GET', headers: {} }, trace, '/api/v1/models');
          saveTrace(db, trace, 'gateway', out.ok);
          if (!out.ok) return res.status(502).json({ ok: false, error: 'Gateway /api/v1/models failed' });
          activeProfile = 'gateway';
        } else {
          const out1 = await fetchJson(baseUrl + '/v1/models', { method: 'GET', headers: {} }, trace, '/v1/models');
          if (out1.ok) {
            saveTrace(db, trace, 'openai', true);
            activeProfile = 'openai';
          } else {
            const out2 = await fetchJson(baseUrl + '/api/v1/models', { method: 'GET', headers: {} }, trace, '/api/v1/models');
            saveTrace(db, trace, 'gateway', out2.ok);
            if (!out2.ok) return res.status(502).json({ ok: false, error: 'No working models endpoint found' });
            activeProfile = 'gateway';
          }
        }
      }

      setKv(db, 'llm.activeProfile', activeProfile);
      res.json({ ok: true, activeProfile });
    } catch (e) {
      saveTrace(db, trace, providerId, false);
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  r.post('/refresh-models', csrfProtection, async (req, res) => {
    const providerId = getProviderId(db);
    const baseUrl = normalizeBaseUrl(getBaseUrl(db));
    const activeProfile = getKv(db, 'llm.activeProfile', null);
    const trace = [];

    try {
      if (providerId === 'anthropic') {
        // manual/custom only
        const count = db.prepare('SELECT COUNT(1) AS c FROM llm_models_cache').get().c;
        const now = nowIso();
const candidateIds = models.map((m) => m.id).filter(Boolean);
const selected = autoSelectDefaultModel(db, candidateIds);
        setKv(db, 'llm.lastRefreshedAt', now);
        saveTrace(db, trace, 'anthropic', true);
        return res.json({ ok: true, modelCount: count, lastRefreshedAt: now });
      }

      let models = [];
      if (providerId === 'openai') {
        const key = String(process.env.OPENAI_API_KEY || '').trim();
        if (!key) return res.status(400).json({ ok: false, error: 'OPENAI_API_KEY missing' });

        const out = await fetchJson(baseUrl + '/v1/models', {
          method: 'GET',
          headers: { Authorization: `Bearer ${key}` },
        }, trace, '/v1/models');

        saveTrace(db, trace, 'openai', out.ok);
        if (!out.ok) return res.status(502).json({ ok: false, error: out.text || 'Failed to fetch models' });

        models = parseModelsFromOpenAi(out.json);
      } else {
        // LM Studio local: use detected profile
        const path = activeProfile === 'gateway' ? '/api/v1/models' : '/v1/models';
        const out = await fetchJson(baseUrl + path, { method: 'GET', headers: {} }, trace, path);
        saveTrace(db, trace, activeProfile || 'openai', out.ok);
        if (!out.ok) return res.status(502).json({ ok: false, error: out.text || 'Failed to fetch models' });

        models = parseModelsFromGateway(out.json);
      }

      if (models.length === 0) return res.status(502).json({ ok: false, error: '0 models returned (treated as error).' });

      const now = nowIso();
      const ins = db.prepare('INSERT OR REPLACE INTO llm_models_cache (id, raw_json, source, discovered_at) VALUES (?, ?, ?, ?)');
      db.prepare('DELETE FROM llm_models_cache').run();

      for (const m of models) {
        if (!m.id) continue;
        ins.run(m.id, JSON.stringify(m.raw), providerId === 'openai' ? 'openai' : (activeProfile || 'openai'), now);
      }

      setKv(db, 'llm.lastRefreshedAt', now);
      res.json({ ok: true, modelCount: models.length, lastRefreshedAt: now });
    } catch (e) {
      saveTrace(db, trace, providerId, false);
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  r.get('/models', (req, res) => {
    const rows = db.prepare('SELECT id, source, discovered_at FROM llm_models_cache ORDER BY id ASC').all();
    const selectedModel = getKv(db, 'llm.selectedModel', null);
    res.json({ models: rows, selectedModel });
  });

  r.post('/select-model', csrfProtection, (req, res) => {
    const { modelId } = req.body || {};
    if (!modelId || !String(modelId).trim()) return res.status(400).json({ ok: false, error: 'modelId required' });
    setKv(db, 'llm.selectedModel', String(modelId).trim());
    res.json({ ok: true });
  });

  r.post('/add-custom-model', csrfProtection, (req, res) => {
    const { modelId } = req.body || {};
    if (!modelId || !String(modelId).trim()) return res.status(400).json({ ok: false, error: 'modelId required' });

    const providerId = getProviderId(db);
    const now = nowIso();

    db.prepare('INSERT OR REPLACE INTO llm_models_cache (id, raw_json, source, discovered_at) VALUES (?, ?, ?, ?)')
      .run(String(modelId).trim(), JSON.stringify({ id: String(modelId).trim(), custom: true }), providerId, now);

    setKv(db, 'llm.selectedModel', String(modelId).trim());
    res.json({ ok: true });
  });

  r.get('/trace', (req, res) => {
    const rows = db.prepare('SELECT ts, method, path, status, duration_ms, profile, ok FROM llm_request_trace ORDER BY id DESC LIMIT 10').all();
    res.json({ trace: rows.reverse() });
  });

  return r;
}
