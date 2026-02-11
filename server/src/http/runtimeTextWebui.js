import express from 'express';
import { requireAuth } from './middleware.js';
import { getTextWebUIConfig, probeTextWebUI, setTextWebUIConfig } from '../runtime/textwebui.js';
import { recordEvent } from '../util/events.js';

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

  function isLocal127(urlString) {
    try {
      const u = new URL(String(urlString || ''));
      const port = Number(u.port || '');
      const portOk = Number.isFinite(port) && port >= 5000 && port <= 5010;
      return u.protocol === 'http:' && u.hostname === '127.0.0.1' && portOk;
    } catch {
      return false;
    }
  }

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

  // Keepalive ping for Text WebUI (manual-only, UI-driven). Never starts processes.
  // Safety: only ever pings 127.0.0.1, and only scans 5000..5010 on failure.
  r.post('/keepalive', async (_req, res) => {
    const providerId = String(getKv(db, 'llm.providerId', 'textwebui') || 'textwebui');
    if (providerId !== 'textwebui') {
      return res.json({ ok: true, skipped: true, reason: 'provider_not_textwebui' });
    }

    const cfg = getTextWebUIConfig(db);
    const baseUrl = cfg.baseUrl;
    if (!isLocal127(baseUrl)) {
      return res.json({ ok: true, skipped: true, reason: 'baseUrl_not_127_0_0_1', baseUrl });
    }

    const out = await probeTextWebUI({ baseUrl, timeoutMs: 2000 });
    if (out.running) {
      // If WebUI is reachable but models are empty, treat as a successful ping.
      return res.json({
        ok: true,
        baseUrl,
        running: true,
        ready: out.ready,
        modelsCount: Array.isArray(out.models) ? out.models.length : 0,
        recovered: false,
      });
    }

    // Ping failed: log and attempt a single local port recovery scan.
    recordEvent(db, 'keepalive ping failed', {
      baseUrl,
      error: out.error || 'unreachable',
    });

    let recovered = null;
    for (let port = 5000; port <= 5010; port += 1) {
      const candidate = `http://127.0.0.1:${port}`;
      const p = await probeTextWebUI({ baseUrl: candidate, timeoutMs: 900 });
      if (p.running) {
        recovered = { baseUrl: candidate, port, modelsCount: p.models.length, ready: p.ready };
        break;
      }
    }

    if (recovered) {
      setTextWebUIConfig(db, { host: '127.0.0.1', port: recovered.port });
      setKv(db, 'llm.providerId', 'textwebui');
      setKv(db, 'llm.providerName', 'Text WebUI');
      setKv(db, 'llm.providerGroup', 'Local');
      setKv(db, 'llm.baseUrl', recovered.baseUrl);
      recordEvent(db, 'keepalive recovered', { from: baseUrl, to: recovered.baseUrl });
      return res.json({
        ok: true,
        baseUrl: recovered.baseUrl,
        running: true,
        ready: recovered.ready,
        modelsCount: recovered.modelsCount,
        recovered: true,
        recoveredFrom: baseUrl,
      });
    }

    return res.status(502).json({
      ok: false,
      code: 'KEEPALIVE_FAILED',
      error: out.error || 'Text WebUI unreachable',
      baseUrl,
      recovered: false,
    });
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
