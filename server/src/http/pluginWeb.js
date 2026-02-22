import express from 'express';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { getWorkspaceRoot } from '../util/workspace.js';
import { ensureWorkspaceBootstrap } from '../util/workspaceBootstrap.js';
import { isExtensionInstalledVerified, listInstalledExtensions, getInstalledExtensionVersionDir, readInstalledExtensionManifest } from '../extensions/installer.js';

async function readEnabledIds() {
  await ensureWorkspaceBootstrap();
  const file = path.join(path.resolve(getWorkspaceRoot()), '.pb', 'plugins', 'enabled.json');
  try {
    const raw = await fsp.readFile(file, 'utf8');
    const parsed = JSON.parse(raw);
    return new Set(Array.isArray(parsed?.enabled) ? parsed.enabled.map((x) => String(x || '')).filter(Boolean) : []);
  } catch {
    return new Set();
  }
}

export function createPluginWebRouter() {
  const r = express.Router();

  r.get('/:id/*', async (req, res) => {
    try {
      const id = String(req.params.id || '').trim();
      if (!id) return res.status(404).send('Not found');
      const enabled = await readEnabledIds();
      if (!enabled.has(id)) return res.status(404).send('Not enabled');

      if (!(await isExtensionInstalledVerified(id))) return res.status(404).send('Not installed');
      const installed = await listInstalledExtensions();
      const row = installed.find((x) => String(x.id) === id);
      if (!row) return res.status(404).send('Not installed');
      const versionDir = getInstalledExtensionVersionDir(row.id, row.version);
      if (!versionDir) return res.status(404).send('Not installed');

      const manifest = (await readInstalledExtensionManifest(id)) || { webRoot: 'web' };
      const webRootRel = String(manifest.webRoot || manifest.web_root || 'web').replace(/^\/+|\/+$/g, '');
      const webRootAbs = path.join(versionDir, webRootRel);
      const webStat = await fsp.stat(webRootAbs).catch(() => null);
      if (!webStat?.isDirectory()) return res.status(404).send('No web UI');

      const reqPath = String(req.params[0] || '').replace(/^\/+/, '');
      const candidate = path.join(webRootAbs, reqPath);
      const resolved = path.resolve(candidate);
      if (!resolved.startsWith(path.resolve(webRootAbs) + path.sep) && resolved !== path.resolve(webRootAbs)) {
        return res.status(400).send('Bad path');
      }

      let filePath = resolved;
      const st = await fsp.stat(filePath).catch(() => null);
      if (!st) {
        // SPA fallback
        filePath = path.join(webRootAbs, 'index.html');
      } else if (st.isDirectory()) {
        filePath = path.join(filePath, 'index.html');
      }

      return res.sendFile(filePath);
    } catch (e) {
      res.status(500).send(String(e?.message || e));
    }
  });

  return r;
}
