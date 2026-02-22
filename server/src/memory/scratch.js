import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { getWorkspaceRoot } from '../util/workspace.js';

function safeSegment(v, fallback) {
  const s = String(v || '').trim().toLowerCase().replace(/[^a-z0-9._-]/g, '_').slice(0, 80);
  return s || fallback;
}

function safeKey(v) {
  const s = String(v || '').trim().replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120);
  if (!s) {
    const err = new Error('scratch key required');
    err.code = 'SCRATCH_KEY_REQUIRED';
    throw err;
  }
  return s;
}

function scratchRoot() {
  const root = path.join(getWorkspaceRoot(), 'scratch');
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  return root;
}

function scratchDir({ agentId = 'alex', projectId = 'default', persist = false, sessionId = 'default' } = {}) {
  const root = scratchRoot();
  const agent = safeSegment(agentId, 'alex');
  const project = safeSegment(projectId, 'default');
  if (persist) {
    const d = path.join(root, agent, project, 'persistent');
    fs.mkdirSync(d, { recursive: true, mode: 0o700 });
    return d;
  }
  const sid = safeSegment(sessionId, 'default');
  const d = path.join(root, agent, project, 'ephemeral', sid);
  fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  return d;
}

function keyPath(dir, key) {
  return path.join(dir, `${safeKey(key)}.txt`);
}

export async function scratchWrite({ key, content, agentId = 'alex', projectId = 'default', persist = false, sessionId = 'default' }) {
  const dir = scratchDir({ agentId, projectId, persist, sessionId });
  const fp = keyPath(dir, key);
  const text = String(content || '');
  await fsp.writeFile(fp, text, 'utf8');
  return { ok: true, key: safeKey(key), bytes: Buffer.byteLength(text, 'utf8'), path: fp, updated_at: new Date().toISOString(), persist: Boolean(persist) };
}

export async function scratchRead({ key, agentId = 'alex', projectId = 'default', sessionId = 'default' }) {
  const k = safeKey(key);
  const persistentDir = scratchDir({ agentId, projectId, persist: true, sessionId });
  const ephemeralDir = scratchDir({ agentId, projectId, persist: false, sessionId });
  const p1 = keyPath(ephemeralDir, k);
  const p2 = keyPath(persistentDir, k);
  const preferred = await fsp.readFile(p1, 'utf8').then((content) => ({ content, path: p1, persist: false })).catch(() => null);
  if (preferred) return { ok: true, key: k, ...preferred };
  const fallback = await fsp.readFile(p2, 'utf8').then((content) => ({ content, path: p2, persist: true })).catch(() => null);
  if (fallback) return { ok: true, key: k, ...fallback };
  const err = new Error(`scratch key not found: ${k}`);
  err.code = 'SCRATCH_NOT_FOUND';
  throw err;
}

async function listDirEntries(baseDir, persistFlag) {
  const entries = await fsp.readdir(baseDir, { withFileTypes: true }).catch(() => []);
  const out = [];
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith('.txt')) continue;
    const abs = path.join(baseDir, e.name);
    const st = await fsp.stat(abs).catch(() => null);
    out.push({
      key: e.name.slice(0, -4),
      persist: persistFlag,
      updated_at: st?.mtime ? new Date(st.mtime).toISOString() : null,
      bytes: Number(st?.size || 0),
      path: abs,
    });
  }
  return out;
}

export async function scratchList({ agentId = 'alex', projectId = 'default', sessionId = 'default' }) {
  const persistentDir = scratchDir({ agentId, projectId, persist: true, sessionId });
  const ephemeralDir = scratchDir({ agentId, projectId, persist: false, sessionId });
  const [p, e] = await Promise.all([
    listDirEntries(persistentDir, true),
    listDirEntries(ephemeralDir, false),
  ]);
  const merged = [...e, ...p].sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')));
  return { ok: true, items: merged };
}

export async function scratchClear({ agentId = 'alex', projectId = 'default', sessionId = 'default', includePersistent = false }) {
  const dirs = [scratchDir({ agentId, projectId, persist: false, sessionId })];
  if (includePersistent) dirs.push(scratchDir({ agentId, projectId, persist: true, sessionId }));
  let removed = 0;
  for (const dir of dirs) {
    const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith('.txt')) continue;
      await fsp.unlink(path.join(dir, e.name)).catch(() => {});
      removed += 1;
    }
  }
  return { ok: true, removed };
}

