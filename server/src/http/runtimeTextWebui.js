import express from 'express';
import { requireAuth } from './middleware.js';
import { getTextWebUIConfig, probeTextWebUI, setTextWebUIConfig } from '../runtime/textwebui.js';

function getKv(db, key, fallback) {
  const row = db.prepare('SELECT value_json FROM app_kv WHERE key = ?').get(key);
  return row ? JSON.parse(row.value_json) : fallback;
}

function setKv(db, key, value) {
  db.prepare('INSERT INTO app_kv (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json')
    .run(key, JSON.stringify(value));
}

export function createRuntimeTextWebuiRouter({ db }) {
  const r = express.Router();
  r.use(requireAuth(db));

  r.get('/status', async (_req, res) => {
    const { baseUrl } = getTextWebUIConfig(db);
    const out = await probeTextWebUI({ baseUrl, timeoutMs: 2000 });
    res.json({
      running: out.running,
      ready: out.ready,
      baseUrl,
      models: out.models,
      error: out.error || undefined,
    });
  });

  r.get('/config', (_req, res) => {
    const cfg = getTextWebUIConfig(db);
    res.json({
      host: cfg.host,
      port: cfg.port,
      baseUrl: cfg.baseUrl,
      selectedModel: getKv(db, 'llm.selectedModel', null),
    });
  });

  r.post('/config', (req, res) => {
    const host = String(req.body?.host || '').trim() || undefined;
    const portRaw = req.body?.port;
    const port = Number(portRaw);
    if (portRaw !== undefined && (!Number.isFinite(port) || port <= 0 || port > 65535)) {
      return res.status(400).json({ ok: false, error: 'port must be a valid TCP port' });
    }
    setTextWebUIConfig(db, { host, port: portRaw === undefined ? undefined : port });
    const cfg = getTextWebUIConfig(db);
    res.json({ ok: true, host: cfg.host, port: cfg.port, baseUrl: cfg.baseUrl });
  });

  r.post('/test', async (_req, res) => {
    const { baseUrl } = getTextWebUIConfig(db);
    const out = await probeTextWebUI({ baseUrl, timeoutMs: 2000 });
    res.json({
      ok: out.running,
      running: out.running,
      ready: out.ready,
      models: out.models,
      baseUrl,
      error: out.error || null,
    });
  });

  r.get('/models', async (_req, res) => {
    const { baseUrl } = getTextWebUIConfig(db);
    const out = await probeTextWebUI({ baseUrl, timeoutMs: 2000 });
    if (!out.running) return res.status(502).json({ ok: false, error: out.error || 'Text WebUI unreachable', models: [] });
    res.json({ ok: true, models: out.models, ready: out.ready, baseUrl });
  });

  r.post('/select-model', async (req, res) => {
    const modelId = String(req.body?.modelId || '').trim();
    if (!modelId) return res.status(400).json({ ok: false, error: 'modelId required' });
    const { baseUrl } = getTextWebUIConfig(db);
    const out = await probeTextWebUI({ baseUrl, timeoutMs: 2500 });
    if (!out.running) return res.status(503).json({ ok: false, error: 'Text WebUI is not running' });
    if (!out.models.includes(modelId)) {
      return res.status(400).json({ ok: false, error: 'Model is not currently available in Text WebUI' });
    }
    setKv(db, 'llm.providerId', 'textwebui');
    setKv(db, 'llm.providerName', 'Text WebUI');
    setKv(db, 'llm.providerGroup', 'Local');
    setKv(db, 'llm.baseUrl', baseUrl);
    setKv(db, 'llm.selectedModel', modelId);
    res.json({ ok: true, modelId });
  });

  return r;
}
