import express from 'express';
import { requireAuth } from './middleware.js';
import { getTextWebUIConfig, probeTextWebUI } from '../runtime/textwebui.js';

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

  r.get('/models', async (_req, res) => {
    const { baseUrl } = getTextWebUIConfig(db);
    const out = await probeTextWebUI({ baseUrl, timeoutMs: 2000 });
    if (!out.running) return res.status(502).json({ ok: false, error: out.error || 'Text WebUI unreachable', models: [] });
    res.json({ ok: true, models: out.models, ready: out.ready, baseUrl });
  });

  return r;
}
