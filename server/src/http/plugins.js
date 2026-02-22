import express from 'express';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { requireAuth } from './middleware.js';
import { isExtensionInstalledVerified } from '../extensions/installer.js';
import { getWorkspaceRoot } from '../util/workspace.js';
import { ensureWorkspaceBootstrap } from '../util/workspaceBootstrap.js';
import { buildAvailablePlugins, readEnabledPluginsConfig } from '../plugins/catalog.js';

// Keep Writing Lab enabled by default (it's builtin-installed/verified in installer index).
const DEFAULT_ENABLED = ['writing-lab'];

function enabledFilePath() {
  return path.join(path.resolve(getWorkspaceRoot()), '.pb', 'plugins', 'enabled.json');
}

function normalizeIds(ids) {
  return Array.from(new Set((ids || []).map((x) => String(x || '').trim()).filter(Boolean)));
}

async function readEnabled() {
  const config = await readEnabledPluginsConfig();
  const enabled = [];
  for (const id of config.enabled) {
    // Fail-closed: only installed + verified extensions are considered enabled.
    if (await isExtensionInstalledVerified(id)) enabled.push(id);
  }
  return { version: 1, enabled };
}

async function writeEnabled(enabledIds) {
  await ensureWorkspaceBootstrap();
  const file = enabledFilePath();
  const dir = path.dirname(file);

  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });

  const requested = normalizeIds(Array.isArray(enabledIds) ? enabledIds : DEFAULT_ENABLED);

  const enabled = [];
  for (const id of requested) {
    if (!(await isExtensionInstalledVerified(id))) {
      throw Object.assign(new Error(`Plugin is not installed and verified: ${id}`), { code: 'PLUGIN_NOT_VERIFIED' });
    }
    enabled.push(id);
  }

  const body = { version: 1, enabled };
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await fsp.writeFile(tmp, JSON.stringify(body, null, 2), 'utf8');
  await fsp.rename(tmp, file);
  return body;
}

export function createPluginsRouter({ db }) {
  const r = express.Router();

  r.get('/enabled', async (_req, res) => {
    try {
      const out = await readEnabled();
      res.json({ ok: true, ...out });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  r.get('/available', async (_req, res) => {
    try {
      const plugins = await buildAvailablePlugins();
      res.json({ ok: true, plugins });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  r.post('/enabled', requireAuth(db), async (req, res) => {
    try {
      const ids = Array.isArray(req.body?.enabled) ? req.body.enabled : null;
      if (!ids) return res.status(400).json({ ok: false, error: 'enabled array required' });

      // NOTE: We do NOT block “unknown IDs” here — we fail-closed by requiring
      // installed+verified in writeEnabled(). This enables third-party extensions safely.
      const out = await writeEnabled(ids);
      res.json({ ok: true, ...out });
    } catch (e) {
      const code = String(e?.code || 'WRITE_FAILED');
      const status = code === 'PLUGIN_NOT_VERIFIED' ? 400 : 500;
      res.status(status).json({ ok: false, error: String(e?.message || e), code });
    }
  });

  return r;
}
