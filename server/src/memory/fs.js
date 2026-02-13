import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { MEMORY_POLICY } from './policy.js';
import {
  getArchiveDirPath,
  getDailyMetaPath,
  getDailyScratchPath,
  getDailySummaryPath,
  memoryBaseDir,
  memoryWorkspaceRoot,
} from './paths.js';
import { redactForModelContext } from './redactor.js';
import { getLocalDayKey } from './date.js';

function nowIso() {
  return new Date().toISOString();
}

export async function ensureMemoryDirs(root = memoryWorkspaceRoot()) {
  await fs.mkdir(path.join(root, '.pb'), { recursive: true });
  await fs.mkdir(memoryBaseDir(root), { recursive: true });
  await fs.mkdir(path.join(memoryBaseDir(root), 'daily'), { recursive: true });
  await fs.mkdir(getArchiveDirPath(root), { recursive: true });
}

export function normalizePathWithinWorkspace(root, targetPath) {
  const ws = path.resolve(String(root || memoryWorkspaceRoot()));
  const raw = String(targetPath || '').trim();
  const resolved = path.resolve(ws, raw);
  const rel = path.relative(ws, resolved);
  if (!rel || rel === '.') return resolved;
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    const err = new Error('Path escapes workspace');
    err.code = 'MEMORY_PATH_TRAVERSAL';
    throw err;
  }
  return resolved;
}

export function isAllowlistedMemoryReadPath(root, absPath) {
  const ws = path.resolve(String(root || memoryWorkspaceRoot()));
  const p = path.resolve(String(absPath || ''));
  const rel = path.relative(ws, p).replace(/\\/g, '/');
  if (rel === 'MEMORY.md') return true;
  if (rel.startsWith('.pb/memory/')) return true;
  if (rel.startsWith('MEMORY_ARCHIVE/')) return true;
  return false;
}

export async function readTextSafe(targetPath, { mode = 'tail', maxBytes = MEMORY_POLICY.readMaxBytesPerOp, redact = true, root = memoryWorkspaceRoot() } = {}) {
  const abs = normalizePathWithinWorkspace(root, targetPath);
  if (!isAllowlistedMemoryReadPath(root, abs)) {
    const err = new Error('Memory read blocked by allowlist');
    err.code = 'MEMORY_READ_BLOCKED';
    throw err;
  }
  const limit = Math.max(256, Math.min(Number(maxBytes || MEMORY_POLICY.readMaxBytesPerOp), 1024 * 1024));
  const content = await fs.readFile(abs, 'utf8').catch((e) => {
    if (e?.code === 'ENOENT') return '';
    throw e;
  });
  let out = String(content || '');
  if (Buffer.byteLength(out, 'utf8') > limit) {
    if (mode === 'head') {
      out = out.slice(0, limit);
    } else {
      out = out.slice(-limit);
    }
  }
  return redact ? redactForModelContext(out) : out;
}

async function readMeta(metaPath) {
  const raw = await fs.readFile(metaPath, 'utf8').catch(() => '{}');
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

async function writeMeta(metaPath, data) {
  await fs.writeFile(metaPath, JSON.stringify(data, null, 2), 'utf8');
}

export async function appendScratchSafe(text, { day, root = memoryWorkspaceRoot() } = {}) {
  const payload = String(text || '');
  const bytes = Buffer.byteLength(payload, 'utf8');
  if (bytes <= 0) {
    const err = new Error('scratch append requires text');
    err.code = 'MEMORY_SCRATCH_EMPTY';
    throw err;
  }
  if (bytes > MEMORY_POLICY.scratchAppendMaxBytes) {
    const err = new Error(`scratch append too large (${bytes} > ${MEMORY_POLICY.scratchAppendMaxBytes})`);
    err.code = 'MEMORY_SCRATCH_APPEND_TOO_LARGE';
    throw err;
  }
  await ensureMemoryDirs(root);
  const d = String(day || getLocalDayKey());
  const file = getDailyScratchPath(d, root);
  const metaPath = getDailyMetaPath(d, root);
  const meta = await readMeta(metaPath);
  const now = Date.now();
  const minuteAgo = now - 60_000;
  const writes = Array.isArray(meta.writes) ? meta.writes.filter((t) => Number(t) >= minuteAgo) : [];
  if (writes.length >= MEMORY_POLICY.scratchWritesPerMinute) {
    const err = new Error('scratch write rate limit exceeded');
    err.code = 'MEMORY_SCRATCH_RATE_LIMIT';
    throw err;
  }
  const stat = await fs.stat(file).catch(() => null);
  const curBytes = Number(stat?.size || 0);
  if ((curBytes + bytes) > MEMORY_POLICY.scratchMaxDayBytes) {
    const err = new Error('scratch daily size limit exceeded');
    err.code = 'MEMORY_SCRATCH_DAY_LIMIT';
    throw err;
  }
  await fs.appendFile(file, payload, 'utf8');
  writes.push(now);
  await writeMeta(metaPath, {
    ...meta,
    bytes: curBytes + bytes,
    writes,
    updated_at: nowIso(),
  });
  return { path: file, day: d, bytes_appended: bytes, bytes_total: curBytes + bytes };
}

export async function writeSummarySafe(text, { day, root = memoryWorkspaceRoot() } = {}) {
  const payload = String(text || '');
  const bytes = Buffer.byteLength(payload, 'utf8');
  if (bytes > MEMORY_POLICY.summaryMaxBytes) {
    const err = new Error(`summary too large (${bytes} > ${MEMORY_POLICY.summaryMaxBytes})`);
    err.code = 'MEMORY_SUMMARY_TOO_LARGE';
    throw err;
  }
  await ensureMemoryDirs(root);
  const d = String(day || getLocalDayKey());
  const file = getDailySummaryPath(d, root);
  await fs.writeFile(file, payload, 'utf8');
  return { path: file, day: d, bytes };
}

export function sha256Text(text) {
  return crypto.createHash('sha256').update(String(text || ''), 'utf8').digest('hex');
}

export function computeUnifiedDiff(oldText, newText, filePath = 'MEMORY.md') {
  const before = String(oldText || '');
  const after = String(newText || '');
  if (before === after) return '';
  const oldLines = before.split('\n');
  const newLines = after.split('\n');
  const removed = oldLines.map((l) => `-${l}`).join('\n');
  const added = newLines.map((l) => `+${l}`).join('\n');
  return `--- ${filePath}\n+++ ${filePath}\n@@\n${removed}\n${added}\n`;
}
