import express from 'express';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { requireAuth } from './middleware.js';
import { recordEvent } from '../util/events.js';
import { getWorkspaceRoot } from '../util/workspace.js';
import {
  installExtensionFromUpload,
  listInstalledExtensions,
  uninstallExtension,
} from '../extensions/installer.js';

function enabledFilePath() {
  return path.join(path.resolve(getWorkspaceRoot()), '.pb', 'plugins', 'enabled.json');
}

async function disablePluginId(id) {
  const file = enabledFilePath();
  try {
    const raw = await fsp.readFile(file, 'utf8');
    const parsed = JSON.parse(raw);
    const current = Array.isArray(parsed?.enabled) ? parsed.enabled.map((x) => String(x || '')) : [];
    const next = current.filter((x) => x !== id);
    const body = { version: 1, enabled: next };
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
    await fsp.writeFile(tmp, JSON.stringify(body, null, 2), 'utf8');
    await fsp.rename(tmp, file);
  } catch {
    // ignore if file missing or unreadable
  }
}

export function createExtensionsRouter({ db }) {
  const r = express.Router();
  r.use(requireAuth(db));

  r.get('/installed', async (_req, res) => {
    try {
      const installed = await listInstalledExtensions();
      res.json({ ok: true, installed });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  r.post('/upload', async (req, res) => {
    try {
      const out = await installExtensionFromUpload(req);
      recordEvent(db, 'extensions.install', {
        id: out.id,
        version: out.installedVersion,
        reportPath: out.reportPath,
      });
      res.json(out);
    } catch (e) {
      const code = String(e?.code || 'INSTALL_FAILED');
      const message = String(e?.message || e || 'Install failed');
      recordEvent(db, 'extensions.install_failed', { code, message });
      const status = code === 'CLAMAV_REQUIRED' || code === 'SIGNATURE_INVALID' || code === 'SIGNATURE_REQUIRED' ? 400 : 500;
      res.status(status).json({ ok: false, error: message, code });
    }
  });

  r.post('/uninstall', async (req, res) => {
    try {
      const id = String(req.body?.id || '').trim();
      if (!id) return res.status(400).json({ ok: false, error: 'id required' });
      await disablePluginId(id);
      const out = await uninstallExtension(id);
      recordEvent(db, 'extensions.uninstall', { id });
      res.json(out);
    } catch (e) {
      const code = String(e?.code || 'UNINSTALL_FAILED');
      const message = String(e?.message || e || 'Uninstall failed');
      recordEvent(db, 'extensions.uninstall_failed', { code, message });
      res.status(400).json({ ok: false, error: message, code });
    }
  });

  return r;
}
