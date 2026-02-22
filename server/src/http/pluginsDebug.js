import express from 'express';
import path from 'node:path';
import fs from 'node:fs/promises';

import { requireAuth } from './middleware.js';
import { getWorkspaceRoot } from '../util/workspace.js';
import { buildAvailablePlugins, readEnabledPluginsConfig } from '../plugins/catalog.js';

export function createPluginsDebugRouter({ db }) {
  const r = express.Router();
  r.use(requireAuth(db));

  r.get('/debug', async (_req, res) => {
    try {
      const workspaceRoot = path.resolve(getWorkspaceRoot());
      const enabledConfig = await readEnabledPluginsConfig();
      const available = await buildAvailablePlugins();
      const installed = available.map((p) => ({
        id: p.id,
        name: p.name,
        version: p.version,
        verified: p.verified,
        source: p.source,
      }));

      const mountChecks = await Promise.all(
        enabledConfig.enabled.map(async (id) => {
          const plugin = available.find((p) => p.id === id) || null;
          const mountUrl = `/plugins/${encodeURIComponent(id)}/`;
          const versionWebRoot = plugin?.webRoot
            ? path.join(workspaceRoot, '.pb', 'extensions', 'installed', id, 'versions', String(plugin.version || ''), plugin.webRoot)
            : null;
          const legacyWebRoot = plugin?.webRoot
            ? path.join(workspaceRoot, '.pb', 'extensions', 'installed', id, plugin.webRoot)
            : null;
          const versionExists = versionWebRoot ? await fs.stat(versionWebRoot).then(() => true).catch(() => false) : false;
          const rootPath = versionExists ? versionWebRoot : legacyWebRoot;
          const exists = rootPath ? await fs.stat(rootPath).then(() => true).catch(() => false) : false;
          const indexHtmlPresent = rootPath
            ? await fs.stat(path.join(rootPath, 'index.html')).then((st) => st.isFile()).catch(() => false)
            : false;

          return {
            id,
            exists,
            webRoot: rootPath,
            indexHtmlPresent,
            mountUrl,
          };
        })
      );

      res.json({
        ok: true,
        workspaceRoot,
        enabled: enabledConfig.enabled,
        installed,
        available,
        mountChecks,
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  return r;
}
