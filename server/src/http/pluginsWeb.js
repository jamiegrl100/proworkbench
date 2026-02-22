import express from 'express';
import path from 'node:path';
import fs from 'node:fs/promises';

import { getWorkspaceRoot } from '../util/workspace.js';
import { buildAvailablePlugins, readEnabledPluginsConfig } from '../plugins/catalog.js';

function safeJoin(baseDir, relPath) {
  const base = path.resolve(String(baseDir));
  const target = path.resolve(base, String(relPath || ''));
  if (target === base) return target;
  if (!target.startsWith(base + path.sep)) {
    throw Object.assign(new Error('Path escapes plugin root.'), { code: 'PATH_ESCAPE' });
  }
  return target;
}

function setPluginFrameHeaders(res) {
  res.removeHeader('X-Frame-Options');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob:; frame-ancestors 'self' http://127.0.0.1:5173 http://localhost:5173 http://127.0.0.1:5174 http://localhost:5174"
  );
}

async function resolvePluginWebRoot(pluginId) {
  const available = await buildAvailablePlugins();
  const plugin = available.find((p) => String(p.id) === String(pluginId));
  if (!plugin || !plugin.indexHtmlPresent) {
    throw Object.assign(new Error('Plugin web root not found.'), { code: 'NO_WEB_ROOT' });
  }

  // catalog already verified index.html exists; compute absolute from workspace.
  const root = path.resolve(getWorkspaceRoot());
  const versionDir = path.join(root, '.pb', 'extensions', 'installed', plugin.id, 'versions', plugin.version);
  const legacyDir = path.join(root, '.pb', 'extensions', 'installed', plugin.id);
  const webRootRel = String(plugin.webRoot || 'web').trim();
  const versionWebRoot = path.resolve(versionDir, webRootRel);
  const legacyWebRoot = path.resolve(legacyDir, webRootRel);

  const hasVersionIndex = await fs.stat(path.join(versionWebRoot, 'index.html')).then((st) => st.isFile()).catch(() => false);
  const webRoot = hasVersionIndex ? versionWebRoot : legacyWebRoot;
  return { plugin, webRoot };
}

/**
 * Public router for serving plugin web UIs.
 *
 * Security:
 * - only serves if plugin is enabled
 * - path is constrained to plugin's declared webRoot
 * - SPA fallback to index.html
 */
export function createPluginsWebRouter() {
  const r = express.Router();

  r.get('/:id/*', async (req, res) => {
    try {
      const pluginId = String(req.params.id || '').trim();
      if (!pluginId) return res.status(404).send('Not found');

      const enabled = await readEnabledPluginsConfig();
      if (!enabled.enabled.includes(pluginId)) return res.status(404).send('Not found');

      const { webRoot } = await resolvePluginWebRoot(pluginId);

      const rel = String(req.params[0] || '').replace(/^\/+/, '');
      const candidate = rel ? safeJoin(webRoot, rel) : path.join(webRoot, 'index.html');

      let p = candidate;
      try {
        const st = await fs.stat(p);
        if (st.isDirectory()) p = path.join(p, 'index.html');
      } catch {
        // SPA fallback
        p = path.join(webRoot, 'index.html');
      }

      setPluginFrameHeaders(res);
      return res.sendFile(p);
    } catch (e) {
      const code = String(e?.code || '');
      if (code === 'PATH_ESCAPE') return res.status(400).send('Bad request');
      return res.status(404).send('Not found');
    }
  });

  // convenience: /plugins/<id>/ (no trailing path)
  r.get('/:id', (req, res) => res.redirect(302, `/plugins/${encodeURIComponent(req.params.id)}/`));

  return r;
}
