import fs from 'node:fs/promises';
import path from 'node:path';
import { getWorkspaceRoot } from '../util/workspace.js';
import { getWatchtowerDir, getWatchtowerMdPath } from './paths.js';

export const WATCHTOWER_MD_MAX_BYTES = 32 * 1024;

function normalizeInsideWorkspace(workspaceRoot, targetPath) {
  const ws = path.resolve(String(workspaceRoot || getWorkspaceRoot()));
  const abs = path.resolve(String(targetPath || ''));
  const rel = path.relative(ws, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    const err = new Error('Path escapes workspace');
    err.code = 'WATCHTOWER_PATH_BLOCKED';
    throw err;
  }
  return abs;
}

export function allowReadWatchtowerMd(targetPath, workspaceRoot = getWorkspaceRoot()) {
  const abs = normalizeInsideWorkspace(workspaceRoot, targetPath);
  return abs === path.resolve(getWatchtowerMdPath(workspaceRoot));
}

export function allowWriteWatchtowerMd(targetPath, workspaceRoot = getWorkspaceRoot()) {
  const abs = normalizeInsideWorkspace(workspaceRoot, targetPath);
  return abs === path.resolve(getWatchtowerMdPath(workspaceRoot));
}

export async function ensureWatchtowerDir(workspaceRoot = getWorkspaceRoot()) {
  await fs.mkdir(getWatchtowerDir(workspaceRoot), { recursive: true });
}

export async function writeWatchtowerChecklist(text, workspaceRoot = getWorkspaceRoot()) {
  const payload = String(text || '');
  const bytes = Buffer.byteLength(payload, 'utf8');
  if (bytes > WATCHTOWER_MD_MAX_BYTES) {
    const err = new Error(`WATCHTOWER.md too large (${bytes} > ${WATCHTOWER_MD_MAX_BYTES})`);
    err.code = 'WATCHTOWER_FILE_TOO_LARGE';
    throw err;
  }
  const p = getWatchtowerMdPath(workspaceRoot);
  if (!allowWriteWatchtowerMd(p, workspaceRoot)) {
    const err = new Error('Watchtower write blocked by policy.');
    err.code = 'WATCHTOWER_WRITE_BLOCKED';
    throw err;
  }
  await ensureWatchtowerDir(workspaceRoot);
  await fs.writeFile(p, payload, 'utf8');
  return { path: p, bytes };
}

export async function readWatchtowerChecklist(workspaceRoot = getWorkspaceRoot()) {
  const p = getWatchtowerMdPath(workspaceRoot);
  if (!allowReadWatchtowerMd(p, workspaceRoot)) {
    const err = new Error('Watchtower read blocked by policy.');
    err.code = 'WATCHTOWER_READ_BLOCKED';
    throw err;
  }
  const text = await fs.readFile(p, 'utf8').catch((e) => {
    if (e?.code === 'ENOENT') return null;
    throw e;
  });
  if (text == null) return { exists: false, text: '' };
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > WATCHTOWER_MD_MAX_BYTES) {
    return { exists: true, text: text.slice(0, WATCHTOWER_MD_MAX_BYTES), truncated: true };
  }
  return { exists: true, text, truncated: false };
}
