import express from 'express';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { requireAuth } from './middleware.js';
import { getWorkspaceRoot } from '../util/workspace.js';
import { ensureWorkspaceBootstrap } from '../util/workspaceBootstrap.js';
import { isExtensionInstalledVerified } from '../extensions/installer.js';

const DEFAULT_ENABLED = ['writing-lab'];
const BUILTIN_IDS = new Set(['writing-lab']);

function enabledFilePath() {
  return path.join(path.resolve(getWorkspaceRoot()), '.pb', 'plugins', 'enabled.json');
}

async function readEnabled() {
  await ensureWorkspaceBootstrap();
  const file = enabledFilePath();
  let requested = DEFAULT_ENABLED.slice();
  try {
    const raw = await fsp.readFile(file, 'utf8');
    const parsed = JSON.parse(raw);
    requested = Array.isArray(parsed?.enabled) ? parsed.enabled.map((x) => String(x || '')).filter((x) => BUILTIN_IDS.has(x)) : DEFAULT_ENABLED.slice();
  } catch {
    requested = DEFAULT_ENABLED.slice();
  }
  const enabled = [];
  for (const id of requested) {
    // Only verified+installed plugins can be enabled.
    if (await isExtensionInstalledVerified(id)) enabled.push(id);
  }
  return { version: 1, enabled };
}

async function writeEnabled(enabledIds) {
  await ensureWorkspaceBootstrap();
  const file = enabledFilePath();
  const dir = path.dirname(file);
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
  const requested = Array.isArray(enabledIds)
    ? Array.from(new Set(enabledIds.map((x) => String(x || '')))).filter((x) => BUILTIN_IDS.has(x))
    : DEFAULT_ENABLED.slice();
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
  r.use(requireAuth(db));

  r.get('/enabled', async (_req, res) => {
    try {
      const out = await readEnabled();
      res.json({ ok: true, ...out });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  r.post('/enabled', async (req, res) => {
    try {
      const ids = Array.isArray(req.body?.enabled) ? req.body.enabled : null;
      if (!ids) return res.status(400).json({ ok: false, error: 'enabled array required' });
      const unknown = ids.map((x) => String(x || '')).filter((x) => !BUILTIN_IDS.has(x));
      if (unknown.length) return res.status(400).json({ ok: false, error: `Unknown plugin ids: ${unknown.join(', ')}` });
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
